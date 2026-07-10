/**
 * Route Mappings Manager
 *
 * A "mapping" is a user-defined gateway endpoint:
 *   - typed (openai | anthropic) — determines which local protocol it serves
 *   - secured by a local sk (Authorization: Bearer <localSk>)
 *   - holds a list of "rules" mapping (input model name) → (provider + mapped model name)
 *   - rules use a per-mapping rotation strategy (sequential | random | least-used)
 *
 * Storage: ~/.ai-gateway-hub/route-mappings.json
 *
 * Schema:
 * {
 *   "version": 1,
 *   "mappings": [
 *     {
 *       "id": "m_xyz",
 *       "name": "映射关系 1",
 *       "type": "openai" | "anthropic",
 *       "enabled": true,
 *       "localSk": "sk-userDefined123",
 *       "contextLimit": 600000,        // reserved, V1 not enforced
 *       "compressThreshold": 500000,   // reserved, V1 not implemented
 *       "strategy": "sequential" | "random" | "least-used",
 *       "rules": [
 *         {
 *           "enabled": true,
 *           "providerId": "p_abc",
 *           "inputModel": "gpt-5.4",
 *           "mappedModel": "gpt-5.4",
 *           "note": ""
 *         }
 *       ],
 *       "_cursor": 0  // sequential cursor (transient, not persisted)
 *     }
 *   ]
 * }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './config.js';

const MAPPINGS_FILE = join(CONFIG_DIR, 'route-mappings.json');

let cache = null;
const cursors = new Map();   // id → next index for sequential rotation

function ensureConfigDir() {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

function load() {
    if (cache !== null) return cache;
    if (!existsSync(MAPPINGS_FILE)) {
        cache = { version: 1, mappings: [] };
        return cache;
    }
    try {
        const raw = JSON.parse(readFileSync(MAPPINGS_FILE, 'utf8'));
        cache = {
            version: 1,
            mappings: Array.isArray(raw.mappings) ? raw.mappings : []
        };
    } catch {
        cache = { version: 1, mappings: [] };
    }
    return cache;
}

function save() {
    if (cache === null) return;
    ensureConfigDir();
    try {
        writeFileSync(MAPPINGS_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
    } catch (err) {
        console.error('[route-mappings] Save failed:', err.message);
    }
}

function generateId() {
    return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function defaultMapping() {
    return {
        id: generateId(),
        name: '新映射',
        type: 'openai',
        enabled: true,
        localSk: 'sk-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
        contextLimit: 1000000,
        compressThreshold: 500000,
        strategy: 'fixed',
        timeWindowMinutes: 60,
        pinnedRuleIndex: null,
        pinnedUntil: null,
        allowedEndpoints: ['chat', 'responses'],  // 新增：控制允许的端点
        rules: []
    };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function listMappings() {
    return load().mappings.map(m => ({
        ...m,
        activeRuleIndexes: activeRuleIndexesForMapping(m)
    }));
}

export function getMapping(id) {
    return load().mappings.find(m => m.id === id) || null;
}

export function getMappingBySk(sk) {
    if (!sk) return null;
    return load().mappings.find(m => m.localSk === sk && m.enabled !== false) || null;
}

export function addMapping(patch = {}) {
    const data = load();
    const m = { ...defaultMapping(), ...patch };
    if (!['openai', 'anthropic'].includes(m.type)) m.type = 'openai';
    if (!Array.isArray(m.rules)) m.rules = [];
    if (!['fixed', 'sequential', 'random', 'least-used', 'time-window'].includes(m.strategy)) m.strategy = 'fixed';

    // 标准化 allowedEndpoints
    if (!Array.isArray(m.allowedEndpoints) || m.allowedEndpoints.length === 0) {
        m.allowedEndpoints = m.type === 'openai' ? ['chat', 'responses'] : ['messages'];
    }

    // Reject duplicate localSk (was previously only checked on update —
    // omitting it here lets two mappings end up sharing a key, which then
    // breaks the next update.)
    if (m.localSk) {
        const dup = data.mappings.find(x => x.localSk === m.localSk);
        if (dup) return { ok: false, error: `localSk already used by mapping "${dup.name}"` };
    }

    data.mappings.push(m);
    save();
    return { ok: true, mapping: { ...m } };
}

export function updateMapping(id, patch = {}) {
    const data = load();
    const idx = data.mappings.findIndex(m => m.id === id);
    if (idx < 0) return { ok: false, error: 'Not found' };
    const cur = data.mappings[idx];

    // Reject duplicate localSk on a different mapping
    if (patch.localSk && patch.localSk !== cur.localSk) {
        const dup = data.mappings.find(m => m.id !== id && m.localSk === patch.localSk);
        if (dup) return { ok: false, error: `localSk already used by mapping "${dup.name}"` };
    }

    const merged = { ...cur, ...patch };
    if (patch.rules !== undefined) merged.rules = Array.isArray(patch.rules) ? patch.rules : [];
    if (patch.timeWindowMinutes !== undefined) {
        merged.timeWindowMinutes = Math.max(30, Math.min(1440, Number(patch.timeWindowMinutes) || 60));
    }
    if (patch.pinnedRuleIndex !== undefined) {
        merged.pinnedRuleIndex = patch.pinnedRuleIndex === null ? null : Number(patch.pinnedRuleIndex);
    }
    if (patch.pinnedUntil !== undefined) {
        merged.pinnedUntil = patch.pinnedUntil === null ? null : Number(patch.pinnedUntil);
    }
    if (patch.allowedEndpoints !== undefined) {
        merged.allowedEndpoints = Array.isArray(patch.allowedEndpoints) ? patch.allowedEndpoints : (merged.type === 'openai' ? ['chat', 'responses'] : ['messages']);
    }
    if (!['openai', 'anthropic'].includes(merged.type)) merged.type = cur.type;
    if (!['fixed', 'sequential', 'random', 'least-used', 'time-window'].includes(merged.strategy)) merged.strategy = cur.strategy;

    data.mappings[idx] = merged;
    cursors.delete(id);   // reset rotation cursor on change
    save();
    return { ok: true, mapping: { ...merged } };
}

export function removeMapping(id) {
    const data = load();
    const idx = data.mappings.findIndex(m => m.id === id);
    if (idx < 0) return { ok: false, error: 'Not found' };
    data.mappings.splice(idx, 1);
    cursors.delete(id);
    save();
    return { ok: true };
}

function enabledCandidates(mapping, inputModel) {
    const candidates = [];
    for (let i = 0; i < (mapping.rules || []).length; i++) {
        const r = mapping.rules[i];
        if (!r || r.enabled === false) continue;
        if (r.inputModel !== inputModel) continue;
        candidates.push({ rule: r, index: i });
    }
    return candidates;
}

export function isMappingPinActive(mapping, now = Date.now()) {
    if (!mapping || mapping.pinnedRuleIndex == null) return false;
    return !(mapping.pinnedUntil && now >= mapping.pinnedUntil);
}

export function selectRuleForMapping(mapping, inputModel, options = {}) {
    if (!mapping) return null;
    const candidates = enabledCandidates(mapping, inputModel);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const now = options.now ?? Date.now();
    if (isMappingPinActive(mapping, now)) {
        const pinned = candidates.find(c => c.index === mapping.pinnedRuleIndex);
        if (pinned) return pinned;
    }

    const strategy = mapping.strategy || 'fixed';
    if (strategy === 'random') {
        const random = typeof options.random === 'function' ? options.random : Math.random;
        return candidates[Math.floor(random() * candidates.length)];
    }
    if (strategy === 'fixed') {
        return candidates[0];
    }
    if (strategy === 'time-window') {
        const windowMs = (mapping.timeWindowMinutes || 60) * 60 * 1000;
        const idx = Math.floor(now / windowMs) % candidates.length;
        return candidates[idx];
    }

    const cur = cursors.get(mapping.id) || 0;
    const pick = candidates[cur % candidates.length];
    if (options.advanceCursor !== false) {
        cursors.set(mapping.id, (cur + 1) % candidates.length);
    }
    return pick;
}

function activeRuleIndexesForMapping(mapping) {
    const out = {};
    const inputModels = new Set();
    for (const rule of (mapping.rules || [])) {
        if (rule && rule.enabled !== false && rule.inputModel) inputModels.add(rule.inputModel);
    }
    for (const inputModel of inputModels) {
        const selected = selectRuleForMapping(mapping, inputModel, {
            advanceCursor: false,
            random: () => 0
        });
        if (selected) out[inputModel] = selected.index;
    }
    return out;
}

/**
 * Pick the next rule for a given input model on a mapping. Returns the rule
 * (or null if none available) and the index into mapping.rules.
 *
 * Each call advances the per-mapping cursor for sequential strategy.
 */
export function pickRule(mappingId, inputModel) {
    const mapping = getMapping(mappingId);
    if (!mapping) return null;

    if (mapping.pinnedRuleIndex != null && mapping.pinnedUntil && Date.now() >= mapping.pinnedUntil) {
        mapping.pinnedRuleIndex = null;
        mapping.pinnedUntil = null;
        save();
    }

    return selectRuleForMapping(mapping, inputModel, { advanceCursor: true });
}

/**
 * Reset rotation cursors (e.g. when a mapping is toggled).
 */
export function resetCursor(mappingId) {
    if (mappingId) cursors.delete(mappingId);
    else cursors.clear();
}

export function reload() {
    cache = null;
    cursors.clear();
    load();
}

export { MAPPINGS_FILE };

export default {
    listMappings,
    getMapping,
    getMappingBySk,
    addMapping,
    updateMapping,
    removeMapping,
    selectRuleForMapping,
    isMappingPinActive,
    pickRule,
    resetCursor,
    reload,
    MAPPINGS_FILE
};
