/**
 * API Providers Manager
 *
 * Stores and manages user-defined upstream API providers.
 * Each provider is a credential to a remote service (OpenAI / Anthropic).
 *
 * Storage: ~/.ai-gateway-hub/api-providers.json
 *
 * Schema:
 * {
 *   "version": 1,
 *   "providers": [
 *     {
 *       "id": "p_abc123",
 *       "type": "openai" | "anthropic",
 *       "name": "GEEK-GPT",
 *       "baseUrl": "https://geekspace.cloud/v1",
 *       "apiKey": "sk-xxx",
 *       "enabled": true,
 *       "selectedModels": ["gpt-5.4"],
 *       "discoveredModels": ["gpt-5.4", "gpt-4o"],
 *       "lastDiscoveredAt": "2026-05-12T...",
 *       "stats": { totalRequests, totalTokens, totalCost, errors,
 *                  totalCacheReadTokens, totalCacheCreateTokens },
 *       "rateLimitedUntil": null,
 *       "addedAt": "...",
 *       "lastUsed": "..."
 *     }
 *   ]
 * }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './config.js';
import { OpenAIProvider } from './providers/openai.js';
import { AnthropicProvider } from './providers/anthropic.js';

const PROVIDERS_FILE = join(CONFIG_DIR, 'api-providers.json');

const PROVIDER_CLASSES = {
    openai: OpenAIProvider,
    anthropic: AnthropicProvider
};

let cache = null;
const instances = new Map();   // id → BaseProvider instance

function ensureConfigDir() {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

function load() {
    if (cache !== null) return cache;
    if (!existsSync(PROVIDERS_FILE)) {
        cache = { version: 1, providers: [] };
        return cache;
    }
    try {
        const raw = JSON.parse(readFileSync(PROVIDERS_FILE, 'utf8'));
        cache = {
            version: 1,
            providers: Array.isArray(raw.providers) ? raw.providers : []
        };
    } catch {
        cache = { version: 1, providers: [] };
    }
    return cache;
}

function save() {
    if (cache === null) return;
    ensureConfigDir();
    // Pull fresh state from live instances first (they hold rolling stats etc.)
    const data = {
        version: 1,
        providers: cache.providers.map(p => {
            const inst = instances.get(p.id);
            return inst ? inst.toJSON() : p;
        })
    };
    cache = data;
    try {
        writeFileSync(PROVIDERS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch (err) {
        console.error('[api-providers] Save failed:', err.message);
    }
}

function instantiate(config) {
    const Cls = PROVIDER_CLASSES[config.type];
    if (!Cls) return null;
    const inst = new Cls(config);
    instances.set(config.id, inst);
    return inst;
}

function getInstance(id) {
    if (instances.has(id)) return instances.get(id);
    const data = load();
    const config = data.providers.find(p => p.id === id);
    if (!config) return null;
    return instantiate(config);
}

function generateId() {
    return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function listProviders() {
    const data = load();
    return data.providers.map(p => {
        const inst = getInstance(p.id);
        return inst ? inst.toSafeJSON() : { ...p, apiKey: '****' };
    });
}

export function listProvidersByType(type) {
    return listProviders().filter(p => p.type === type);
}

export function getProvider(id) {
    return getInstance(id);
}

export function addProvider({ type, name, baseUrl, apiKey, enabled = true, selectedModels = [], supportsNativeResponses = false }) {
    if (!PROVIDER_CLASSES[type]) {
        return { ok: false, error: `Unknown provider type: ${type}. Allowed: openai, anthropic` };
    }
    if (!name) return { ok: false, error: 'name is required' };
    if (!apiKey) return { ok: false, error: 'apiKey is required' };

    const data = load();
    const config = {
        id: generateId(),
        type,
        name,
        baseUrl: baseUrl || '',
        apiKey,
        enabled,
        selectedModels: Array.isArray(selectedModels) ? selectedModels : [],
        discoveredModels: [],
        lastDiscoveredAt: null,
        supportsNativeResponses: !!supportsNativeResponses,
        addedAt: new Date().toISOString(),
        lastUsed: null,
        stats: { totalRequests: 0, totalTokens: 0, totalCost: 0, errors: 0, totalCacheReadTokens: 0, totalCacheCreateTokens: 0 }
    };
    data.providers.push(config);
    instantiate(config);
    save();
    return { ok: true, provider: getInstance(config.id).toSafeJSON() };
}

export function updateProvider(id, patch = {}) {
    const data = load();
    const idx = data.providers.findIndex(p => p.id === id);
    if (idx < 0) return { ok: false, error: 'Not found' };

    const config = data.providers[idx];
    if (patch.name !== undefined) config.name = patch.name;
    if (patch.baseUrl !== undefined) config.baseUrl = patch.baseUrl;
    if (patch.apiKey !== undefined && patch.apiKey !== '' && !patch.apiKey.includes('***')) {
        config.apiKey = patch.apiKey;
    }
    if (patch.enabled !== undefined) config.enabled = !!patch.enabled;
    if (Array.isArray(patch.selectedModels)) config.selectedModels = patch.selectedModels;
    if (patch.type !== undefined && PROVIDER_CLASSES[patch.type]) config.type = patch.type;
    if (patch.supportsNativeResponses !== undefined) config.supportsNativeResponses = !!patch.supportsNativeResponses;

    // Rebuild the live instance so type / baseUrl / key changes take effect
    instances.delete(id);
    instantiate(config);
    save();
    return { ok: true, provider: getInstance(id).toSafeJSON() };
}

export function removeProvider(id) {
    const data = load();
    const idx = data.providers.findIndex(p => p.id === id);
    if (idx < 0) return { ok: false, error: 'Not found' };
    data.providers.splice(idx, 1);
    instances.delete(id);
    save();
    return { ok: true };
}

export async function discoverModels(id) {
    const inst = getInstance(id);
    if (!inst) return { ok: false, error: 'Not found' };
    try {
        const models = await inst.listModels();
        const ids = models.map(m => m.id).filter(Boolean);
        // Persist discovered list to config
        const data = load();
        const cfg = data.providers.find(p => p.id === id);
        if (cfg) {
            cfg.discoveredModels = ids;
            cfg.lastDiscoveredAt = new Date().toISOString();
            save();
        }
        return { ok: true, models: ids, lastDiscoveredAt: cfg?.lastDiscoveredAt };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

export async function validateProvider(id) {
    const inst = getInstance(id);
    if (!inst) return { ok: false, error: 'Not found' };
    try {
        const valid = await inst.validateKey();
        return { ok: true, valid };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

export function recordUsage(id, { inputTokens = 0, outputTokens = 0, cost = 0, cacheReadTokens = 0, cacheCreateTokens = 0 } = {}) {
    const inst = getInstance(id);
    if (!inst) return;
    inst.markUsed(inputTokens + outputTokens, cost, cacheReadTokens, cacheCreateTokens);
    save();
}

export function recordError(id) {
    const inst = getInstance(id);
    if (!inst) return;
    inst.markError();
    save();
}

export function recordRateLimit(id, durationMs = 60000) {
    const inst = getInstance(id);
    if (!inst) return;
    inst.markRateLimited(durationMs);
    save();
}

/**
 * Force-reload from disk (used after manual file edits or migration).
 */
export function reload() {
    cache = null;
    instances.clear();
    load();
}

export { PROVIDERS_FILE };

export default {
    listProviders,
    listProvidersByType,
    getProvider,
    addProvider,
    updateProvider,
    removeProvider,
    discoverModels,
    validateProvider,
    recordUsage,
    recordError,
    recordRateLimit,
    reload,
    PROVIDERS_FILE
};
