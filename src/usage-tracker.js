/**
 * Usage Tracker
 * Tracks per-request usage data for cost monitoring and analytics.
 *
 * Storage (all under ~/.proxypool-hub/):
 *   - usage-stats.json:   Aggregated stats (daily, monthly, allTime, byProvider, byModel)
 *   - usage-history.json: Recent request history (persisted, max 2000 entries)
 *
 * Writes are debounced (2s) to avoid high-frequency I/O under load.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './config.js';

if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

const STATS_FILE = join(CONFIG_DIR, 'usage-stats.json');
const HISTORY_FILE = join(CONFIG_DIR, 'usage-history.json');
const HISTORY_RETENTION_DAYS = 365;     // keep entries for 365 days, no count cap
const DEBOUNCE_MS = 2000;
const DAILY_RETENTION_DAYS = 365;
const MONTHLY_RETENTION_MONTHS = 60;

let aggregatedStats = null;
let usageHistory = null;
let savePending = false;
let saveTimer = null;

// ─── Load / Save ──────────────────────────────────────────────────────────────

function createEmptyStats() {
    return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0, errors: 0 };
}

function loadStats() {
    if (aggregatedStats !== null) return aggregatedStats;

    if (!existsSync(STATS_FILE)) {
        aggregatedStats = {
            daily: {},
            monthly: {},
            allTime: createEmptyStats(),
            byProvider: {},
            byModel: {},
            byAccount: {}
        };
        return aggregatedStats;
    }

    try {
        aggregatedStats = JSON.parse(readFileSync(STATS_FILE, 'utf8'));
        if (!aggregatedStats.daily) aggregatedStats.daily = {};
        if (!aggregatedStats.monthly) aggregatedStats.monthly = {};
        if (!aggregatedStats.allTime) aggregatedStats.allTime = createEmptyStats();
        if (!aggregatedStats.byProvider) aggregatedStats.byProvider = {};
        if (!aggregatedStats.byModel) aggregatedStats.byModel = {};
        if (!aggregatedStats.byAccount) aggregatedStats.byAccount = {};
    } catch {
        aggregatedStats = {
            daily: {},
            monthly: {},
            allTime: createEmptyStats(),
            byProvider: {},
            byModel: {},
            byAccount: {}
        };
    }
    return aggregatedStats;
}

function loadHistory() {
    if (usageHistory !== null) return usageHistory;

    if (!existsSync(HISTORY_FILE)) {
        usageHistory = [];
        return usageHistory;
    }

    try {
        const data = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
        usageHistory = Array.isArray(data) ? data : [];
    } catch {
        usageHistory = [];
    }
    return usageHistory;
}

function scheduleSave() {
    if (savePending) return;
    savePending = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushToDisk, DEBOUNCE_MS);
}

function flushToDisk() {
    savePending = false;
    saveTimer = null;
    try {
        if (aggregatedStats) {
            writeFileSync(STATS_FILE, JSON.stringify(aggregatedStats, null, 2), { mode: 0o600 });
        }
        if (usageHistory) {
            writeFileSync(HISTORY_FILE, JSON.stringify(usageHistory), { mode: 0o600 });
        }
    } catch { /* ignore write errors */ }
}

// Flush on process exit
process.on('exit', flushToDisk);
process.on('SIGINT', () => { flushToDisk(); process.exit(0); });
process.on('SIGTERM', () => { flushToDisk(); process.exit(0); });

function getDateKey() {
    return new Date().toISOString().slice(0, 10);
}

function getMonthKey() {
    return new Date().toISOString().slice(0, 7);
}

function addToTarget(target, entry) {
    target.requests++;
    target.inputTokens += entry.inputTokens;
    target.outputTokens += entry.outputTokens;
    target.cacheReadTokens = (target.cacheReadTokens || 0) + (entry.cacheReadTokens || 0);
    target.cacheCreateTokens = (target.cacheCreateTokens || 0) + (entry.cacheCreateTokens || 0);
    target.cost += entry.cost;
    if (!entry.success) target.errors++;
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function recordRequest({
    provider,
    keyId,
    model,
    inputTokens = 0,
    outputTokens = 0,
    cacheReadTokens = 0,
    cacheCreateTokens = 0,
    cost = 0,
    priceSnapshot = null,
    durationMs = 0,
    success = true,
    error = null
}) {
    const entry = {
        timestamp: new Date().toISOString(),
        provider,
        keyId,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreateTokens,
        cost,
        priceSnapshot,
        durationMs,
        success,
        error
    };

    // History (persisted) — retain by age (365 days), no entry count cap
    const history = loadHistory();
    history.unshift(entry);
    const cutoffMs = Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    // Trim only when grown notably to avoid per-write O(n) churn (every ~50 writes)
    if (history.length % 50 === 0) {
        usageHistory = history.filter(e => {
            const ts = Date.parse(e.timestamp);
            return !isFinite(ts) || ts >= cutoffMs;
        });
    }

    // Aggregated stats
    const stats = loadStats();
    const dayKey = getDateKey();
    const monthKey = getMonthKey();
    const providerKey = provider || 'unknown';
    const modelKey = model || 'unknown';
    const accountKey = keyId || 'unknown';

    if (!stats.daily[dayKey]) stats.daily[dayKey] = createEmptyStats();
    if (!stats.monthly[monthKey]) stats.monthly[monthKey] = createEmptyStats();
    if (!stats.byProvider[providerKey]) stats.byProvider[providerKey] = createEmptyStats();
    if (!stats.byModel[modelKey]) stats.byModel[modelKey] = createEmptyStats();
    if (!stats.byAccount[accountKey]) stats.byAccount[accountKey] = createEmptyStats();

    addToTarget(stats.daily[dayKey], entry);
    addToTarget(stats.monthly[monthKey], entry);
    addToTarget(stats.allTime, entry);
    addToTarget(stats.byProvider[providerKey], entry);
    addToTarget(stats.byModel[modelKey], entry);
    addToTarget(stats.byAccount[accountKey], entry);

    // Clean up old daily stats (configurable retention)
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - DAILY_RETENTION_DAYS);
    const cutoffKey = cutoff.toISOString().slice(0, 10);
    for (const key of Object.keys(stats.daily)) {
        if (key < cutoffKey) delete stats.daily[key];
    }

    // Clean up old monthly stats (configurable retention)
    const monthCutoff = new Date();
    monthCutoff.setMonth(monthCutoff.getMonth() - MONTHLY_RETENTION_MONTHS);
    const monthCutoffKey = monthCutoff.toISOString().slice(0, 7);
    for (const key of Object.keys(stats.monthly)) {
        if (key < monthCutoffKey) delete stats.monthly[key];
    }

    scheduleSave();
    return entry;
}

export function getRecentHistory(limit = 50) {
    const all = loadHistory();
    return Number.isFinite(limit) && limit > 0 ? all.slice(0, limit) : all;
}

export function getDailyStats(days = 7) {
    const stats = loadStats();
    const result = [];
    const now = new Date();

    for (let i = 0; i < days; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        result.push({
            date: key,
            ...(stats.daily[key] || createEmptyStats())
        });
    }

    return result.reverse();
}

export function getMonthlyStats(months = 6) {
    const stats = loadStats();
    const result = [];
    const now = new Date();

    for (let i = 0; i < months; i++) {
        const d = new Date(now);
        d.setMonth(d.getMonth() - i);
        const key = d.toISOString().slice(0, 7);
        result.push({
            month: key,
            ...(stats.monthly[key] || createEmptyStats())
        });
    }

    return result.reverse();
}

export function getAllTimeStats() {
    return loadStats().allTime;
}

export function getTodayStats() {
    const stats = loadStats();
    return stats.daily[getDateKey()] || createEmptyStats();
}

export function getStatsByProvider() {
    return loadStats().byProvider;
}

export function getStatsByModel() {
    return loadStats().byModel;
}

export function getStatsByAccount() {
    return loadStats().byAccount;
}
