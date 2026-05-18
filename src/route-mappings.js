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
        contextLimit: 600000,
        compressThreshold: 500000,
        strategy: 'fixed',
        timeWindowMinutes: 60,
        pinnedRuleIndex: null,
        pinnedUntil: null,
        rules: []
    };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function listMappings() {
    return load().mappings.map(m => ({ ...m }));
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

/**
 * Pick the next rule for a given input model on a mapping. Returns the rule
 * (or null if none available) and the index into mapping.rules.
 *
 * Each call advances the per-mapping cursor for sequential strategy.
 */
export function pickRule(mappingId, inputModel) {
    const mapping = getMapping(mappingId);
    if (!mapping) return null;

    // Filter rules: enabled, matching inputModel
    const candidates = [];
    for (let i = 0; i < (mapping.rules || []).length; i++) {
        const r = mapping.rules[i];
        if (!r || r.enabled === false) continue;
        if (r.inputModel !== inputModel) continue;
        candidates.push({ rule: r, index: i });
    }

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const strategy = mapping.strategy || 'fixed';
    if (strategy === 'random') {
        return candidates[Math.floor(Math.random() * candidates.length)];
    }
    if (strategy === 'fixed') {
        return candidates[0];
    }
    if (strategy === 'time-window') {
        if (mapping.pinnedRuleIndex != null) {
            if (mapping.pinnedUntil && Date.now() >= mapping.pinnedUntil) {
                mapping.pinnedRuleIndex = null;
                mapping.pinnedUntil = null;
                save();
            } else {
                const pinned = candidates.find(c => c.index === mapping.pinnedRuleIndex);
                if (pinned) return pinned;
            }
        }
        const windowMs = (mapping.timeWindowMinutes || 60) * 60 * 1000;
        const idx = Math.floor(Date.now() / windowMs) % candidates.length;
        return candidates[idx];
    }
    // sequential / least-used (V1 falls back to sequential for least-used)
    const cur = cursors.get(mappingId) || 0;
    const pick = candidates[cur % candidates.length];
    cursors.set(mappingId, (cur + 1) % candidates.length);
    return pick;
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
    pickRule,
    resetCursor,
    reload,
    MAPPINGS_FILE
};
