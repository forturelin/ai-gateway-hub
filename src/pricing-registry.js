/**
 * Pricing Registry
 *
 * Stores per-(provider, model) pricing for cost estimation. Each entry has
 * 4 fields: input / output / cacheRead / cacheCreate (all in $ per 1M tokens).
 *
 * Storage:
 *   ~/.ai-gateway-hub/pricing.json
 *
 * Schema:
 *   {
 *     "version": 1,
 *     "models": {
 *       "openai:gpt-4o":              { input: 2.50, output: 10.00, cacheRead: 1.25, cacheCreate: 0 },
 *       "anthropic:claude-opus-4-6":  { input: 3.00, output: 15.00, cacheRead: 0.30, cacheCreate: 3.75 }
 *     }
 *   }
 *
 * Lookup order:
 *   1. models[`${provider}:${model}`]
 *   2. BUILT_IN_DEFAULTS[`${provider}:${model}`]
 *   3. zero (return 0 cost; UI shows "未知" warning)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './config.js';

const PRICING_FILE = join(CONFIG_DIR, 'pricing.json');

// Built-in defaults — official list price from vendor docs as of 2026-05-13.
// User customizations override these. Values are USD per 1M tokens.
const BUILT_IN_DEFAULTS = {
    // ─── OpenAI (GPT-5 family, official openai.com pricing) ────────────
    'openai:gpt-5.4':                { input: 2.50,  output: 15.00, cacheRead: 0.25,  cacheCreate: 0 },
    'openai:gpt-5.4-mini':           { input: 0.75,  output: 4.50,  cacheRead: 0.75,  cacheCreate: 0 },
    'openai:gpt-5.5':                { input: 5.00,  output: 30.00, cacheRead: 0.50,  cacheCreate: 0 },
    'openai:gpt-5.6-sol':            { input: 5.00,  output: 30.00, cacheRead: 0.50,  cacheCreate: 0 },
    'openai:gpt-5.6-terra':          { input: 2.50,  output: 15.00, cacheRead: 0.25,  cacheCreate: 0 },
    'openai:gpt-5.6-luna':           { input: 1.00,  output: 6.00,  cacheRead: 0.10,  cacheCreate: 0 },

    // ─── Other vendors served via OpenAI-compatible relays ─────────────
    // Values are USD per 1M tokens: input / output / cache read / cache create.
    'openai:minimax-m2.7':           { input: 0.299, output: 1.20, cacheRead: 0.06,   cacheCreate: 0 },
    'openai:glm-5.1':                { input: 1.20,  output: 4.00, cacheRead: 0.30,   cacheCreate: 0 },
    'openai:glm-5.2':                { input: 1.20,  output: 4.00, cacheRead: 0.30,   cacheCreate: 0 },
    'openai:qwen-3.7-max':           { input: 1.65,  output: 5.00, cacheRead: 0.33,   cacheCreate: 2.00 },
    'openai:qwen-3.7-plus':          { input: 0.80,  output: 3.30, cacheRead: 0.16,   cacheCreate: 1.00 },
    'openai:deepseek-v4-flash':      { input: 0.14,  output: 0.28, cacheRead: 0.0028, cacheCreate: 0 },
    'openai:deepseek-v4-pro':        { input: 0.435, output: 0.88, cacheRead: 0.0036, cacheCreate: 0 },
    'openai:mimo-v2.5-pro':          { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheCreate: 0 },
    'openai:mimo-v2.5':              { input: 0.14,  output: 0.28, cacheRead: 0.0028, cacheCreate: 0 },
    'openai:minimax-m3':             { input: 1.20,  output: 4.80, cacheRead: 0.24,   cacheCreate: 0 },
    'openai:gemini-3.5-flash':       { input: 1.50,  output: 9.00, cacheRead: 0.15,   cacheCreate: 0 },
    'openai:gemini-3.1-flash-lite':  { input: 0.25,  output: 1.50, cacheRead: 0.025,  cacheCreate: 0 },
    'openai:gemini-3.1-pro':         { input: 4.00,  output: 18.00, cacheRead: 0.40,  cacheCreate: 0 },

    // ─── Anthropic-compatible Claude models ────────────────────────────
    'anthropic:claude-opus-4-7':     { input: 5.00,  output: 25.00, cacheRead: 0.50, cacheCreate: 0 },
    'anthropic:claude-opus-4-8':     { input: 5.00,  output: 25.00, cacheRead: 0.50, cacheCreate: 0 },
    'anthropic:claude-fable-5':      { input: 10.00, output: 50.00, cacheRead: 1.00, cacheCreate: 0 },
    'anthropic:claude-mythos-5':     { input: 10.00, output: 50.00, cacheRead: 1.00, cacheCreate: 0 },
};

let cache = null;

function ensureConfigDir() {
    if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
}

function loadFromDisk() {
    if (cache !== null) return cache;
    if (!existsSync(PRICING_FILE)) {
        cache = { version: 1, models: {} };
        return cache;
    }
    try {
        const raw = JSON.parse(readFileSync(PRICING_FILE, 'utf8'));
        cache = {
            version: 1,
            models: (raw && typeof raw.models === 'object') ? raw.models : {}
        };
    } catch {
        cache = { version: 1, models: {} };
    }
    return cache;
}

function saveToDisk() {
    if (cache === null) return;
    ensureConfigDir();
    try {
        writeFileSync(PRICING_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
    } catch (err) {
        console.error('[Pricing] Failed to save:', err.message);
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Look up the active price for (provider, model).
 * Returns the user override if present, otherwise the built-in default,
 * otherwise zero pricing (with a `source: 'unknown'` marker).
 */
export function getPrice(provider, model) {
    const key = `${provider}:${model}`;
    const data = loadFromDisk();

    // 1. Exact match
    if (data.models[key]) return { ...data.models[key], source: 'custom' };
    if (BUILT_IN_DEFAULTS[key]) return { ...BUILT_IN_DEFAULTS[key], source: 'default' };

    const allCustom = Object.keys(data.models);
    const allBuiltin = Object.keys(BUILT_IN_DEFAULTS);

    // 2. Cross-provider exact model match (e.g. "anthropic" + "gpt-5.4" → find "openai:gpt-5.4")
    for (const k of allCustom) { const cm = k.split(':')[1]; if (cm === model) return { ...data.models[k], source: 'custom' }; }
    for (const k of allBuiltin) { const cm = k.split(':')[1]; if (cm === model) return { ...BUILT_IN_DEFAULTS[k], source: 'default' }; }

    // 3. Suffix match (e.g. "wangsu-gpt-5.4" → match "gpt-5.4")
    for (const k of allCustom) { const cm = k.split(':')[1]; if (cm && model.length > cm.length && model.endsWith(cm)) return { ...data.models[k], source: 'custom' }; }
    for (const k of allBuiltin) { const cm = k.split(':')[1]; if (cm && model.length > cm.length && model.endsWith(cm)) return { ...BUILT_IN_DEFAULTS[k], source: 'default' }; }

    return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, source: 'unknown' };
}

export function getDefaultPrice(provider, model) {
    const key = `${provider}:${model}`;
    return BUILT_IN_DEFAULTS[key]
        ? { ...BUILT_IN_DEFAULTS[key] }
        : { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}

function billableInputTokens(provider, inputTokens, cacheReadTokens) {
    if (provider === 'openai') {
        return Math.max(0, (inputTokens || 0) - (cacheReadTokens || 0));
    }
    return inputTokens || 0;
}

/**
 * Estimate cost in USD for a request.
 *
 * @param {string} provider - 'openai' | 'anthropic' | ...
 * @param {string} model - Model id (e.g. 'gpt-4o')
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {number} [cacheReadTokens=0]
 * @param {number} [cacheCreateTokens=0]
 * @returns {number} cost in USD
 */
export function estimateCost(provider, model, inputTokens, outputTokens, cacheReadTokens = 0, cacheCreateTokens = 0) {
    const p = getPrice(provider, model);
    const fullPriceInputTokens = billableInputTokens(provider, inputTokens, cacheReadTokens);
    const cost =
        (fullPriceInputTokens / 1_000_000) * p.input +
        (outputTokens / 1_000_000) * p.output +
        (cacheReadTokens / 1_000_000) * p.cacheRead +
        (cacheCreateTokens / 1_000_000) * p.cacheCreate;
    return cost;
}

/**
 * Compute cost AND return the price snapshot used. Persist the snapshot
 * alongside the entry so future price-table edits don't invalidate the audit
 * trail.
 */
export function estimateCostWithSnapshot(provider, model, inputTokens, outputTokens, cacheReadTokens = 0, cacheCreateTokens = 0) {
    const p = getPrice(provider, model);
    const fullPriceInputTokens = billableInputTokens(provider, inputTokens, cacheReadTokens);
    const cost =
        (fullPriceInputTokens / 1_000_000) * p.input +
        (outputTokens / 1_000_000) * p.output +
        (cacheReadTokens / 1_000_000) * p.cacheRead +
        (cacheCreateTokens / 1_000_000) * p.cacheCreate;
    return {
        cost,
        priceSnapshot: {
            input: p.input,
            output: p.output,
            cacheRead: p.cacheRead,
            cacheCreate: p.cacheCreate,
            source: p.source || 'default'
        }
    };
}

// Back-compat alias for older code that imports estimateCostWithRegistry.
export function estimateCostWithRegistry(provider, model, inputTokens, outputTokens) {
    return estimateCost(provider, model, inputTokens, outputTokens);
}

export function getDefaultPricing(provider) {
    // Returns a flat object: { 'gpt-4o': { input, output, ... }, ... }
    const out = {};
    const prefix = `${provider}:`;
    for (const [k, v] of Object.entries(BUILT_IN_DEFAULTS)) {
        if (k.startsWith(prefix)) {
            out[k.slice(prefix.length)] = { ...v };
        }
    }
    return out;
}

/**
 * List all known (provider, model) entries combining built-ins and overrides.
 */
export function listAll() {
    const data = loadFromDisk();
    const merged = {};
    for (const [k, v] of Object.entries(BUILT_IN_DEFAULTS)) {
        merged[k] = { ...v, source: 'default' };
    }
    for (const [k, v] of Object.entries(data.models)) {
        merged[k] = { ...v, source: 'custom' };
    }
    const result = [];
    for (const [k, v] of Object.entries(merged)) {
        const sep = k.indexOf(':');
        if (sep < 0) continue;
        const provider = k.slice(0, sep);
        const model = k.slice(sep + 1);
        result.push({
            key: k,
            provider,
            model,
            input: v.input || 0,
            output: v.output || 0,
            cacheRead: v.cacheRead || 0,
            cacheCreate: v.cacheCreate || 0,
            source: v.source,
            // Always expose the default for "reset" UI
            defaultInput: BUILT_IN_DEFAULTS[k]?.input || 0,
            defaultOutput: BUILT_IN_DEFAULTS[k]?.output || 0,
            defaultCacheRead: BUILT_IN_DEFAULTS[k]?.cacheRead || 0,
            defaultCacheCreate: BUILT_IN_DEFAULTS[k]?.cacheCreate || 0
        });
    }
    return result;
}

export function setPrice(provider, model, { input = 0, output = 0, cacheRead = 0, cacheCreate = 0 }) {
    const key = `${provider}:${model}`;
    const data = loadFromDisk();
    data.models[key] = {
        input: Number(input) || 0,
        output: Number(output) || 0,
        cacheRead: Number(cacheRead) || 0,
        cacheCreate: Number(cacheCreate) || 0
    };
    saveToDisk();
    return getPrice(provider, model);
}

export function resetPrice(provider, model) {
    const key = `${provider}:${model}`;
    const data = loadFromDisk();
    if (data.models[key]) {
        delete data.models[key];
        saveToDisk();
    }
    return getPrice(provider, model);
}

export function deletePrice(provider, model) {
    return resetPrice(provider, model);
}

export { PRICING_FILE };

export default {
    getPrice,
    getDefaultPrice,
    estimateCost,
    estimateCostWithRegistry,
    listAll,
    setPrice,
    resetPrice,
    getDefaultPricing,
    PRICING_FILE
};
