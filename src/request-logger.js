/**
 * Request Logger
 * Asynchronously logs full request/response content for debugging and auditing.
 *
 * Design:
 *   - Zero latency impact: logging happens via setImmediate after response is sent
 *   - JSONL format: one JSON object per line, append-only (no need to parse whole file)
 *   - Daily rotation: ~/.proxypool-hub/request-logs/YYYY-MM-DD.jsonl
 *   - Auto-cleanup: deletes files older than configured retention days
 *   - Content truncation: request/response bodies capped at MAX_BODY_SIZE
 *   - Debounced flush: batches writes every 3 seconds to reduce I/O
 *   - Daily index: ~/.proxypool-hub/request-logs/.index.json maintains per-day
 *     aggregates (count, byProvider, byModel, byStatus, totals) for O(1) summary
 *     queries across 365 days without scanning JSONL files. Auto-rebuilt on
 *     startup if missing/corrupt, incrementally updated on each log.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, readFileSync, writeFileSync, createReadStream } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './config.js';

const LOGS_DIR = join(CONFIG_DIR, 'request-logs');
const INDEX_FILE = join(LOGS_DIR, '.index.json');
const MAX_BODY_SIZE = 4096;       // Max chars per request/response body stored
const FLUSH_INTERVAL_MS = 3000;
const INDEX_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_RETENTION_DAYS = 365;
const MAX_QUERY_RESULTS = 500;
const MAX_SEARCH_DAYS = 90;       // Single search may not span more than 90 days

let buffer = [];
let flushTimer = null;
let enabled = true;

// In-memory index (mirror of .index.json)
let indexData = null;
let indexDirty = false;
let indexFlushTimer = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureLogsDir() {
    if (!existsSync(LOGS_DIR)) {
        mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
    }
}

function todayFile() {
    return join(LOGS_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
}

function truncate(value, maxLen = MAX_BODY_SIZE) {
    if (value === undefined || value === null) return null;
    let str = typeof value === 'string' ? value : JSON.stringify(value);
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + `...(truncated, total ${str.length} chars)`;
}

/**
 * Extract a "reasoning effort" indicator from a request body.
 *   - Anthropic: body.thinking with budget_tokens or type==='enabled' → e.g. "16k"
 *   - OpenAI o-series: body.reasoning_effort or body.reasoning.effort → "low"/"medium"/"high"
 *   - Otherwise: '' (no reasoning)
 *
 * Accepts either a parsed object OR a JSON string. Falls back to regex when
 * the string is truncated and JSON.parse fails (common for stored requestBody
 * which is capped at 4096 chars — `thinking` often sits past the cutoff).
 */
export function extractReasoningEffort(body) {
    if (!body) return '';
    if (typeof body === 'string') {
        try {
            return extractReasoningEffort(JSON.parse(body));
        } catch {
            return extractReasoningEffortFromString(body);
        }
    }
    if (typeof body !== 'object') return '';

    // Cherry Studio (and similar wrappers) use a non-standard `output_config.effort`
    // ("low" / "medium" / "high") alongside `thinking`. Prefer this when present
    // because it carries the explicit intensity level.
    if (body.output_config && typeof body.output_config === 'object' && typeof body.output_config.effort === 'string') {
        return body.output_config.effort;
    }

    if (body.thinking && typeof body.thinking === 'object') {
        const t = body.thinking;
        if (t.type === 'disabled') return '';
        const hasBudget = typeof t.budget_tokens === 'number' && t.budget_tokens > 0;
        const isOn = t.type === 'enabled' || t.type === 'adaptive' || hasBudget;
        if (isOn) {
            if (hasBudget) {
                const b = t.budget_tokens;
                return b >= 1000 ? `${Math.round(b / 1000)}k` : String(b);
            }
            return t.type || 'on';
        }
    }
    if (typeof body.reasoning_effort === 'string') return body.reasoning_effort;
    if (body.reasoning && typeof body.reasoning === 'object' && typeof body.reasoning.effort === 'string') {
        return body.reasoning.effort;
    }
    if (typeof body.effort === 'string') return body.effort;

    for (const key of ['extra_body', 'extraBody', 'model_kwargs', 'modelKwargs', 'metadata', 'openai', 'anthropic']) {
        const nested = extractReasoningEffort(body[key]);
        if (nested) return nested;
    }
    return '';
}

/**
 * Best-effort regex extraction for truncated/malformed JSON bodies.
 */
function extractReasoningEffortFromString(s) {
    // Cherry Studio etc.: "output_config":{"effort":"high"}
    const oc = s.match(/"output_config"\s*:\s*\{[^{}]*?"effort"\s*:\s*"([^"]+)"/);
    if (oc) return oc[1];
    // Anthropic: "thinking":{ ... "budget_tokens": NUMBER ... }
    const thinkBlock = s.match(/"thinking"\s*:\s*\{[^{}]*?"budget_tokens"\s*:\s*(\d+)/);
    if (thinkBlock) {
        const b = Number(thinkBlock[1]);
        if (b > 0) return b >= 1000 ? `${Math.round(b / 1000)}k` : String(b);
    }
    // Anthropic: thinking.type='enabled'/'adaptive'
    const tType = s.match(/"thinking"\s*:\s*\{[^{}]*?"type"\s*:\s*"(enabled|adaptive)"/);
    if (tType) return tType[1];
    // OpenAI Chat Completions o-series
    const re = s.match(/"reasoning_effort"\s*:\s*"([^"]+)"/);
    if (re) return re[1];
    // OpenAI Responses API
    const ro = s.match(/"reasoning"\s*:\s*\{[^{}]*?"effort"\s*:\s*"([^"]+)"/);
    if (ro) return ro[1];
    const generic = s.match(/"effort"\s*:\s*"([^"]+)"/);
    if (generic) return generic[1];
    return '';
}

function generateId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return `req_${ts}_${rand}`;
}

function emptyDayEntry() {
    return {
        count: 0,
        byProvider: {},
        byModel: {},
        byStatus: { success: 0, error: 0 },
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreateTokens: 0,
        totalCost: 0,
        totalDurationMs: 0
    };
}

// ─── Index: load / save / build ──────────────────────────────────────────────

const INDEX_VERSION = 2;   // bumped when day-entry shape changes (adds cache totals)

function loadIndex() {
    if (indexData !== null) return indexData;
    ensureLogsDir();
    if (!existsSync(INDEX_FILE)) {
        indexData = { version: INDEX_VERSION, dates: {} };
        buildIndexFromScratch();
        return indexData;
    }
    try {
        const raw = JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
        if (raw && typeof raw === 'object' && raw.version === INDEX_VERSION && raw.dates) {
            indexData = raw;
        } else {
            // Older index (or unknown shape) — discard and rebuild from JSONL.
            indexData = { version: INDEX_VERSION, dates: {} };
            buildIndexFromScratch();
        }
    } catch {
        indexData = { version: INDEX_VERSION, dates: {} };
        buildIndexFromScratch();
    }
    return indexData;
}

function buildIndexFromScratch() {
    // Lazy / best-effort: scan existing .jsonl files and rebuild aggregates.
    // Called on startup if index file is missing or corrupt.
    try {
        if (!existsSync(LOGS_DIR)) return;
        for (const file of readdirSync(LOGS_DIR)) {
            if (!file.endsWith('.jsonl')) continue;
            const dateKey = file.replace('.jsonl', '');
            const filePath = join(LOGS_DIR, file);
            const entry = emptyDayEntry();
            try {
                const text = readFileSync(filePath, 'utf8');
                const lines = text.split('\n').filter(Boolean);
                for (const line of lines) {
                    try {
                        const e = JSON.parse(line);
                        applyEntryToDay(entry, e);
                    } catch { /* skip malformed */ }
                }
                indexData.dates[dateKey] = entry;
            } catch { /* skip unreadable */ }
        }
        indexDirty = true;
        scheduleIndexFlush();
    } catch { /* ignore */ }
}

function applyEntryToDay(day, entry) {
    day.count++;
    const provider = entry.provider || 'unknown';
    const model = entry.model || 'unknown';
    day.byProvider[provider] = (day.byProvider[provider] || 0) + 1;
    day.byModel[model] = (day.byModel[model] || 0) + 1;
    if (entry.success === false) day.byStatus.error++;
    else day.byStatus.success++;
    day.totalInputTokens = (day.totalInputTokens || 0) + (entry.inputTokens || 0);
    day.totalOutputTokens = (day.totalOutputTokens || 0) + (entry.outputTokens || 0);
    day.totalCacheReadTokens = (day.totalCacheReadTokens || 0) + (entry.cacheReadTokens || 0);
    day.totalCacheCreateTokens = (day.totalCacheCreateTokens || 0) + (entry.cacheCreateTokens || 0);
    day.totalCost = (day.totalCost || 0) + (entry.cost || 0);
    day.totalDurationMs = (day.totalDurationMs || 0) + (entry.durationMs || 0);
}

function scheduleIndexFlush() {
    if (indexFlushTimer) return;
    indexFlushTimer = setTimeout(flushIndex, INDEX_FLUSH_INTERVAL_MS);
}

function flushIndex() {
    indexFlushTimer = null;
    if (!indexDirty || !indexData) return;
    try {
        ensureLogsDir();
        writeFileSync(INDEX_FILE, JSON.stringify(indexData), { mode: 0o600 });
        indexDirty = false;
    } catch { /* ignore write errors */ }
}

function updateIndexForEntry(entry) {
    const idx = loadIndex();
    const dateKey = entry.timestamp.slice(0, 10);
    if (!idx.dates[dateKey]) idx.dates[dateKey] = emptyDayEntry();
    applyEntryToDay(idx.dates[dateKey], entry);
    indexDirty = true;
    scheduleIndexFlush();
}

// ─── Flush logs to disk ──────────────────────────────────────────────────────

function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
}

function flush() {
    flushTimer = null;
    if (buffer.length === 0) return;

    const entries = buffer;
    buffer = [];

    ensureLogsDir();
    // Group by date in case buffer spans midnight
    const byDate = {};
    for (const entry of entries) {
        const dateKey = entry.timestamp.slice(0, 10);
        if (!byDate[dateKey]) byDate[dateKey] = [];
        byDate[dateKey].push(entry);
    }

    for (const [dateKey, dateEntries] of Object.entries(byDate)) {
        const filePath = join(LOGS_DIR, `${dateKey}.jsonl`);
        const lines = dateEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
        try {
            appendFileSync(filePath, lines, { mode: 0o600 });
        } catch { /* ignore write errors */ }
    }
}

// Flush on process exit
process.on('exit', () => { flush(); flushIndex(); });
process.on('SIGINT', () => { flush(); flushIndex(); process.exit(0); });
process.on('SIGTERM', () => { flush(); flushIndex(); process.exit(0); });

// ─── Auto-cleanup ────────────────────────────────────────────────────────────

export function cleanupOldLogs(retentionDays = DEFAULT_RETENTION_DAYS) {
    if (!existsSync(LOGS_DIR)) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffKey = cutoff.toISOString().slice(0, 10);

    try {
        for (const file of readdirSync(LOGS_DIR)) {
            if (!file.endsWith('.jsonl')) continue;
            const dateKey = file.replace('.jsonl', '');
            if (dateKey < cutoffKey) {
                unlinkSync(join(LOGS_DIR, file));
                // Sync index
                const idx = loadIndex();
                if (idx.dates[dateKey]) {
                    delete idx.dates[dateKey];
                    indexDirty = true;
                }
            }
        }
        if (indexDirty) scheduleIndexFlush();
    } catch { /* ignore */ }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Enable or disable request logging at runtime.
 */
export function setRequestLoggingEnabled(value) {
    enabled = !!value;
}

export function isRequestLoggingEnabled() {
    return enabled;
}

/**
 * Log a request/response asynchronously.
 * Call this AFTER the response has been sent to the client.
 */
export function logRequest(opts) {
    if (!enabled) return;

    // Defer off the critical path
    setImmediate(() => {
        const entry = {
            id: generateId(),
            timestamp: new Date().toISOString(),
            route: opts.route || '',
            method: opts.method || 'POST',
            provider: opts.provider || '',
            providerName: opts.providerName || '',
            keyId: opts.keyId || '',
            model: opts.model || '',
            mappedModel: opts.mappedModel || opts.model || '',
            requestBody: truncate(opts.requestBody),
            responseBody: truncate(opts.responseBody),
            inputTokens: opts.inputTokens || 0,
            outputTokens: opts.outputTokens || 0,
            cacheReadTokens: opts.cacheReadTokens || 0,
            cacheCreateTokens: opts.cacheCreateTokens || 0,
            cost: opts.cost || 0,
            priceSnapshot: opts.priceSnapshot || null,
            durationMs: opts.durationMs || 0,
            status: opts.status || 0,
            success: opts.success !== false,
            reasoningEffort: opts.reasoningEffort != null ? opts.reasoningEffort : extractReasoningEffort(opts.requestBody),
            requestedReasoningEffort: opts.requestedReasoningEffort || extractReasoningEffort(opts.requestBody),
            upstreamReasoningEffort: opts.upstreamReasoningEffort || '',
            reasoningStatus: opts.reasoningStatus || '',
            cachePrefixDiagnostics: opts.cachePrefixDiagnostics || null,
            openaiCacheHint: opts.openaiCacheHint || null,
            error: opts.error || null,
        };

        buffer.push(entry);
        updateIndexForEntry(entry);
        scheduleFlush();
    });
}

// ─── Query API (for Dashboard) ──────────────────────────────────────────────

/**
 * Legacy single-day query (kept for backward compat). Prefer searchLogs.
 */
export function queryLogs({ date, limit = 50, offset = 0, provider, model, errorsOnly } = {}) {
    flush();

    const dateKey = date || new Date().toISOString().slice(0, 10);
    const filePath = join(LOGS_DIR, `${dateKey}.jsonl`);

    if (!existsSync(filePath)) {
        return { entries: [], total: 0, date: dateKey };
    }

    let lines;
    try {
        lines = readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    } catch {
        return { entries: [], total: 0, date: dateKey };
    }

    let entries = [];
    for (const line of lines) {
        try {
            const entry = JSON.parse(line);
            if (provider && entry.provider !== provider) continue;
            if (model && !entry.model?.includes(model) && !entry.mappedModel?.includes(model)) continue;
            if (errorsOnly && entry.success) continue;
            entries.push(entry);
        } catch { /* skip malformed lines */ }
    }

    entries.reverse();
    const total = entries.length;
    const clampedLimit = Math.min(limit, MAX_QUERY_RESULTS);
    entries = entries.slice(offset, offset + clampedLimit);

    return { entries, total, date: dateKey };
}

// ─── New: full search across date range ──────────────────────────────────────

function normalizeProviderList(provider) {
    if (!provider) return null;
    if (Array.isArray(provider)) return provider.filter(Boolean);
    if (typeof provider === 'string' && provider) return [provider];
    return null;
}

function listJsonlDatesInRange(dateFrom, dateTo) {
    // Use the index for fast date enumeration (skips empty days). Fallback
    // to filesystem scan if index is empty.
    const idx = loadIndex();
    const dates = Object.keys(idx.dates).filter(d => {
        if (dateFrom && d < dateFrom) return false;
        if (dateTo && d > dateTo) return false;
        return true;
    });
    if (dates.length > 0) return dates.sort();

    if (!existsSync(LOGS_DIR)) return [];
    try {
        return readdirSync(LOGS_DIR)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => f.replace('.jsonl', ''))
            .filter(d => (!dateFrom || d >= dateFrom) && (!dateTo || d <= dateTo))
            .sort();
    } catch {
        return [];
    }
}

function dayDiff(dateFrom, dateTo) {
    if (!dateFrom || !dateTo) return 0;
    const a = new Date(dateFrom + 'T00:00:00Z').getTime();
    const b = new Date(dateTo + 'T00:00:00Z').getTime();
    return Math.round((b - a) / 86400000);
}

function todayKey() {
    return new Date().toISOString().slice(0, 10);
}

function defaultDateRange() {
    const to = todayKey();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 6); // last 7 days inclusive
    return { dateFrom: fromDate.toISOString().slice(0, 10), dateTo: to };
}

function matchEntry(entry, filters) {
    const { providers, model, keyId, success, minInputTokens, minOutputTokens, minCost, maxCost, q } = filters;
    if (providers && providers.length > 0 && !providers.includes(entry.provider)) return false;
    if (model && !(entry.model?.includes(model) || entry.mappedModel?.includes(model))) return false;
    if (keyId && !(entry.keyId || '').includes(keyId)) return false;
    if (success === true && !entry.success) return false;
    if (success === false && entry.success) return false;
    if (minInputTokens != null && (entry.inputTokens || 0) < minInputTokens) return false;
    if (minOutputTokens != null && (entry.outputTokens || 0) < minOutputTokens) return false;
    if (minCost != null && (entry.cost || 0) < minCost) return false;
    if (maxCost != null && (entry.cost || 0) > maxCost) return false;
    if (q) {
        const hay = [
            entry.route, entry.provider, entry.keyId, entry.model, entry.mappedModel,
            entry.error, entry.requestBody, entry.responseBody
        ].filter(Boolean).join(' \n ').toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
}

function compareEntries(a, b, sort) {
    switch (sort) {
        case 'timestamp_asc': return a.timestamp.localeCompare(b.timestamp);
        case 'duration_desc': return (b.durationMs || 0) - (a.durationMs || 0);
        case 'tokens_desc': return ((b.inputTokens || 0) + (b.outputTokens || 0)) - ((a.inputTokens || 0) + (a.outputTokens || 0));
        case 'cost_desc': return (b.cost || 0) - (a.cost || 0);
        case 'timestamp_desc':
        default: return b.timestamp.localeCompare(a.timestamp);
    }
}

function normalizeSearchOpts(opts = {}) {
    const range = defaultDateRange();
    const dateFrom = opts.dateFrom || range.dateFrom;
    const dateTo = opts.dateTo || range.dateTo;
    const span = dayDiff(dateFrom, dateTo);
    if (span < 0) {
        return { error: 'dateFrom must be <= dateTo', dateFrom, dateTo };
    }
    if (span > MAX_SEARCH_DAYS) {
        return { error: `Date range exceeds ${MAX_SEARCH_DAYS} days. Narrow your search or export instead.`, dateFrom, dateTo };
    }
    return {
        dateFrom,
        dateTo,
        providers: normalizeProviderList(opts.provider),
        model: opts.model || null,
        keyId: opts.keyId || null,
        success: typeof opts.success === 'boolean' ? opts.success : null,
        minInputTokens: opts.minInputTokens != null ? Number(opts.minInputTokens) : null,
        minOutputTokens: opts.minOutputTokens != null ? Number(opts.minOutputTokens) : null,
        minCost: opts.minCost != null ? Number(opts.minCost) : null,
        maxCost: opts.maxCost != null ? Number(opts.maxCost) : null,
        q: opts.q || null,
        sort: opts.sort || 'timestamp_desc',
        limit: Math.min(Number(opts.limit || 100), MAX_QUERY_RESULTS),
        offset: Number(opts.offset || 0)
    };
}

/**
 * Search logged requests across a date range with rich filters.
 *
 * @param {object} opts
 * @param {string} opts.dateFrom - YYYY-MM-DD (inclusive). Default: 7 days ago.
 * @param {string} opts.dateTo - YYYY-MM-DD (inclusive). Default: today.
 * @param {string|string[]} opts.provider - Provider filter (single or list)
 * @param {string} opts.model - Substring match on model/mappedModel
 * @param {string} opts.keyId - Substring match on keyId
 * @param {boolean} opts.success - true=success only, false=errors only, null=any
 * @param {number} opts.minInputTokens
 * @param {number} opts.minOutputTokens
 * @param {number} opts.minCost
 * @param {number} opts.maxCost
 * @param {string} opts.q - Full-text substring search across route/provider/keyId/model/error/bodies
 * @param {string} opts.sort - timestamp_desc | timestamp_asc | duration_desc | tokens_desc | cost_desc
 * @param {number} opts.limit - Max results (capped at MAX_QUERY_RESULTS=500)
 * @param {number} opts.offset - Skip entries
 * @returns {object} { entries, total, dateFrom, dateTo, error? }
 */
export function searchLogs(opts = {}) {
    flush();
    const norm = normalizeSearchOpts(opts);
    if (norm.error) {
        return { entries: [], total: 0, dateFrom: norm.dateFrom, dateTo: norm.dateTo, error: norm.error };
    }

    const dates = listJsonlDatesInRange(norm.dateFrom, norm.dateTo);
    // Optionally pre-filter dates using the index: skip days where byProvider
    // doesn't intersect the requested providers (saves opening files).
    let candidateDates = dates;
    if (norm.providers && norm.providers.length > 0) {
        const idx = loadIndex();
        candidateDates = dates.filter(d => {
            const day = idx.dates[d];
            if (!day) return true; // unknown — keep
            return norm.providers.some(p => day.byProvider[p] > 0);
        });
    }

    const matched = [];
    for (const d of candidateDates) {
        const filePath = join(LOGS_DIR, `${d}.jsonl`);
        if (!existsSync(filePath)) continue;
        let lines;
        try {
            lines = readFileSync(filePath, 'utf8').split('\n');
        } catch { continue; }
        for (const line of lines) {
            if (!line) continue;
            try {
                const entry = JSON.parse(line);
                // Backfill: old entries don't have reasoningEffort. Try to
                // extract from the stored requestBody (a JSON string) on read.
                if (entry.reasoningEffort === undefined) {
                    entry.reasoningEffort = extractReasoningEffort(entry.requestBody);
                }
                if (matchEntry(entry, norm)) matched.push(entry);
            } catch { /* skip malformed */ }
        }
    }

    matched.sort((a, b) => compareEntries(a, b, norm.sort));
    const total = matched.length;
    const slice = matched.slice(norm.offset, norm.offset + norm.limit);
    return { entries: slice, total, dateFrom: norm.dateFrom, dateTo: norm.dateTo };
}

/**
 * Summarize logs in a date range using the index (fast).
 * For provider/model filters that need to be honored, falls back to scanning
 * the matched files (slower but accurate).
 */
export function summarizeLogs(opts = {}) {
    flush();
    const norm = normalizeSearchOpts(opts);
    if (norm.error) {
        return { error: norm.error, dateFrom: norm.dateFrom, dateTo: norm.dateTo };
    }

    // Fast path: no entry-level filter, just date range — sum from index
    const hasEntryFilter = norm.providers || norm.model || norm.keyId
        || norm.success != null || norm.minInputTokens != null
        || norm.minOutputTokens != null || norm.minCost != null
        || norm.maxCost != null || norm.q;

    if (!hasEntryFilter) {
        const idx = loadIndex();
        const summary = {
            count: 0,
            successCount: 0,
            errorCount: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheReadTokens: 0,
            totalCacheCreateTokens: 0,
            totalCost: 0,
            avgDurationMs: 0,
            byProvider: {},
            byModel: {},
            byDay: {}
        };
        let durSum = 0;
        for (const d of Object.keys(idx.dates)) {
            if (d < norm.dateFrom || d > norm.dateTo) continue;
            const day = idx.dates[d];
            summary.count += day.count;
            summary.successCount += day.byStatus?.success || 0;
            summary.errorCount += day.byStatus?.error || 0;
            summary.totalInputTokens += day.totalInputTokens || 0;
            summary.totalOutputTokens += day.totalOutputTokens || 0;
            summary.totalCacheReadTokens += day.totalCacheReadTokens || 0;
            summary.totalCacheCreateTokens += day.totalCacheCreateTokens || 0;
            summary.totalCost += day.totalCost || 0;
            durSum += day.totalDurationMs || 0;
            for (const [p, c] of Object.entries(day.byProvider || {})) {
                summary.byProvider[p] = (summary.byProvider[p] || 0) + c;
            }
            for (const [m, c] of Object.entries(day.byModel || {})) {
                summary.byModel[m] = (summary.byModel[m] || 0) + c;
            }
            summary.byDay[d] = { count: day.count, totalCost: day.totalCost, totalInputTokens: day.totalInputTokens, totalOutputTokens: day.totalOutputTokens };
        }
        summary.avgDurationMs = summary.count > 0 ? Math.round(durSum / summary.count) : 0;
        summary.errorRate = summary.count > 0 ? summary.errorCount / summary.count : 0;
        return { ...summary, dateFrom: norm.dateFrom, dateTo: norm.dateTo, fast: true };
    }

    // Slow path: scan matched entries
    const result = searchLogs({ ...opts, limit: MAX_QUERY_RESULTS, offset: 0 });
    const summary = {
        count: result.total,
        successCount: 0,
        errorCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreateTokens: 0,
        totalCost: 0,
        avgDurationMs: 0,
        byProvider: {},
        byModel: {},
        byDay: {}
    };
    let durSum = 0;
    for (const e of result.entries) {
        if (e.success) summary.successCount++; else summary.errorCount++;
        summary.totalInputTokens += e.inputTokens || 0;
        summary.totalOutputTokens += e.outputTokens || 0;
        summary.totalCacheReadTokens += e.cacheReadTokens || 0;
        summary.totalCacheCreateTokens += e.cacheCreateTokens || 0;
        summary.totalCost += e.cost || 0;
        durSum += e.durationMs || 0;
        const p = e.provider || 'unknown';
        const m = e.model || 'unknown';
        const d = e.timestamp.slice(0, 10);
        summary.byProvider[p] = (summary.byProvider[p] || 0) + 1;
        summary.byModel[m] = (summary.byModel[m] || 0) + 1;
        if (!summary.byDay[d]) summary.byDay[d] = { count: 0, totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0 };
        summary.byDay[d].count++;
        summary.byDay[d].totalCost += e.cost || 0;
        summary.byDay[d].totalInputTokens += e.inputTokens || 0;
        summary.byDay[d].totalOutputTokens += e.outputTokens || 0;
    }
    summary.avgDurationMs = summary.count > 0 ? Math.round(durSum / summary.count) : 0;
    summary.errorRate = summary.count > 0 ? summary.errorCount / summary.count : 0;
    if (result.total > MAX_QUERY_RESULTS) {
        summary.partial = true;
        summary.note = `Summary computed from first ${MAX_QUERY_RESULTS} of ${result.total} matched entries (capped). Narrow filters for exact totals.`;
    }
    return { ...summary, dateFrom: norm.dateFrom, dateTo: norm.dateTo, fast: false };
}

/**
 * Stream-friendly export of matching entries (no limit cap).
 * Returns an async iterator yielding entries one at a time so the route
 * handler can pipe to the HTTP response without buffering everything.
 *
 * @param {object} opts - Same filters as searchLogs, but limit/offset ignored.
 * @returns {AsyncGenerator<object>}
 */
export async function* iterateLogsForExport(opts = {}) {
    flush();
    const norm = normalizeSearchOpts({ ...opts, limit: MAX_QUERY_RESULTS, offset: 0 });
    if (norm.error) {
        return;
    }
    const dates = listJsonlDatesInRange(norm.dateFrom, norm.dateTo);
    // For export we sort within each day's entries and emit them in
    // global timestamp order via a simple merge approach: load each file
    // sorted (memory cost: one file at a time).
    const buckets = [];
    for (const d of dates) {
        const filePath = join(LOGS_DIR, `${d}.jsonl`);
        if (!existsSync(filePath)) continue;
        let lines;
        try { lines = readFileSync(filePath, 'utf8').split('\n'); } catch { continue; }
        const dayEntries = [];
        for (const line of lines) {
            if (!line) continue;
            try {
                const entry = JSON.parse(line);
                if (matchEntry(entry, norm)) dayEntries.push(entry);
            } catch { /* skip */ }
        }
        dayEntries.sort((a, b) => compareEntries(a, b, norm.sort));
        buckets.push(...dayEntries);
        // Yield to event loop between files to avoid stalling under big exports
        await new Promise(r => setImmediate(r));
    }
    // Final global sort (small overhead vs. yielding raw)
    buckets.sort((a, b) => compareEntries(a, b, norm.sort));
    for (const entry of buckets) yield entry;
}

/**
 * Get available log dates (newest first).
 */
export function getLogDates() {
    flush();
    const idx = loadIndex();
    const dates = Object.keys(idx.dates).sort().reverse();
    if (dates.length > 0) return dates;
    if (!existsSync(LOGS_DIR)) return [];
    try {
        return readdirSync(LOGS_DIR)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => f.replace('.jsonl', ''))
            .sort()
            .reverse();
    } catch {
        return [];
    }
}

/**
 * List the distinct providers seen in the index (for UI filter dropdown).
 */
export function getKnownProviders() {
    const idx = loadIndex();
    const set = new Set();
    for (const day of Object.values(idx.dates)) {
        for (const p of Object.keys(day.byProvider || {})) set.add(p);
    }
    return [...set].sort();
}

// Run cleanup on module load (uses default; route layer may re-run with
// the user-configured retention from settings.json).
cleanupOldLogs();
// Build index on demand
loadIndex();
