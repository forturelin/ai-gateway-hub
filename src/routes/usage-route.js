/**
 * /api/usage/* — read-only aggregates from usage-tracker + history.
 *
 * Endpoints:
 *   GET /api/usage/overview               → today, allTime, byProvider, byModel
 *   GET /api/usage/daily?days=7           → last N days
 *   GET /api/usage/monthly?months=6       → last N months
 *   GET /api/usage/providers              → byProvider summary
 *   GET /api/usage/models                 → byModel summary
 *   GET /api/usage/history?limit=50       → recent history
 *   GET /api/usage/buckets?granularity=hour&hours=24    → time-bucketed counts
 *   GET /api/usage/buckets?granularity=minute&minutes=60
 *   GET /api/usage/range?range=1d|3d|7d|30d|12m         → totals + trend + byProvider + byModel
 */

import {
    getTodayStats,
    getAllTimeStats,
    getStatsByProvider,
    getStatsByModel,
    getDailyStats,
    getMonthlyStats,
    getRecentHistory
} from '../usage-tracker.js';
import { getLogDates, searchLogs, summarizeLogs } from '../request-logger.js';

function toUsageStats(summary = {}) {
    return {
        requests: summary.count || 0,
        inputTokens: summary.totalInputTokens || 0,
        outputTokens: summary.totalOutputTokens || 0,
        cacheReadTokens: summary.totalCacheReadTokens || 0,
        cacheCreateTokens: summary.totalCacheCreateTokens || 0,
        cost: summary.totalCost || 0,
        errors: summary.errorCount || 0
    };
}

function todayKey() {
    return new Date().toISOString().slice(0, 10);
}

function monthKey(date = new Date()) {
    return date.toISOString().slice(0, 7);
}

function monthStartKey(month) {
    return `${month}-01`;
}

function addMonths(date, months) {
    const next = new Date(date);
    next.setMonth(next.getMonth() + months);
    return next;
}

function dateKey(date) {
    return date.toISOString().slice(0, 10);
}

function logMonthKeys(limit = 120) {
    const dates = getLogDates();
    if (!dates.length) return [];
    const from = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
    const to = new Date(`${dates[0]}T00:00:00Z`);
    from.setDate(1);
    to.setDate(1);
    const months = [];
    for (let d = from; d <= to && months.length < limit; d = addMonths(d, 1)) {
        months.push(monthKey(d));
    }
    return months;
}

function statsAreEmpty(stats) {
    return !stats || (stats.requests || 0) === 0;
}

function addEntryStat(target, entry) {
    target.requests += 1;
    target.inputTokens += entry.inputTokens || 0;
    target.outputTokens += entry.outputTokens || 0;
    target.cacheReadTokens += entry.cacheReadTokens || 0;
    target.cacheCreateTokens += entry.cacheCreateTokens || 0;
    target.cost += entry.cost || 0;
    if (entry.success === false) target.errors += 1;
}

function emptyEntryStats() {
    return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0, errors: 0 };
}

function entriesFromLogs(opts = {}) {
    const result = searchLogs({ limit: 500, ...opts });
    return result.entries || [];
}

function mergeStats(target, stats) {
    target.requests += stats.requests || 0;
    target.inputTokens += stats.inputTokens || 0;
    target.outputTokens += stats.outputTokens || 0;
    target.cacheReadTokens += stats.cacheReadTokens || 0;
    target.cacheCreateTokens += stats.cacheCreateTokens || 0;
    target.cost += stats.cost || 0;
    target.errors += stats.errors || 0;
    return target;
}

function summarizeLogRange(dateFrom, dateTo) {
    return toUsageStats(summarizeLogs({ dateFrom, dateTo }));
}

function summarizeLogMonths(months) {
    const totals = emptyEntryStats();
    const byProvider = {};
    const byModel = {};
    const monthly = [];
    for (const month of months) {
        const next = addMonths(new Date(monthStartKey(month)), 1);
        const end = dateKey(new Date(next.getTime() - 86400000));
        const dateTo = end > todayKey() ? todayKey() : end;
        const summary = summarizeLogs({ dateFrom: monthStartKey(month), dateTo });
        const stats = toUsageStats(summary);
        mergeStats(totals, stats);
        monthly.push({ month, ...stats });
        for (const [key, count] of Object.entries(summary.byProvider || {})) {
            if (!byProvider[key]) byProvider[key] = emptyEntryStats();
            byProvider[key].requests += count || 0;
        }
        for (const [key, count] of Object.entries(summary.byModel || {})) {
            if (!byModel[key]) byModel[key] = emptyEntryStats();
            byModel[key].requests += count || 0;
        }
    }
    return { totals, byProvider, byModel, monthly };
}

function summarizeEntriesBy(entries, keyFn) {
    const out = {};
    for (const entry of entries) {
        const key = keyFn(entry) || 'unknown';
        if (!out[key]) out[key] = emptyEntryStats();
        addEntryStat(out[key], entry);
    }
    return out;
}

export function handleOverview(req, res) {
    res.set('Cache-Control', 'no-store');
    const today = getTodayStats();
    if (!statsAreEmpty(today)) {
        return res.json({
            today,
            allTime: getAllTimeStats(),
            byProvider: getStatsByProvider(),
            byModel: getStatsByModel()
        });
    }

    const summary = summarizeLogs({ dateFrom: todayKey(), dateTo: todayKey() });
    const months = logMonthKeys();
    const historical = summarizeLogMonths(months);
    res.json({
        today: toUsageStats(summary),
        allTime: historical.totals,
        byProvider: historical.byProvider,
        byModel: historical.byModel
    });
}

export function handleDaily(req, res) {
    const days = parseInt(req.query.days, 10) || 7;
    res.set('Cache-Control', 'no-store');
    const data = getDailyStats(days);
    if (data.some(d => !statsAreEmpty(d))) return res.json({ days, data });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const date = d.toISOString().slice(0, 10);
        out.push({ date, ...toUsageStats(summarizeLogs({ dateFrom: date, dateTo: date })) });
    }
    res.json({ days, data: out });
}

export function handleMonthly(req, res) {
    const months = parseInt(req.query.months, 10) || 6;
    res.set('Cache-Control', 'no-store');
    const data = getMonthlyStats(months);
    const current = data[data.length - 1];
    if (current && !statsAreEmpty(current)) return res.json({ months, data });

    const availableMonths = logMonthKeys();
    const selectedMonths = availableMonths.slice(-months);
    res.json({ months, data: summarizeLogMonths(selectedMonths).monthly });
}

export function handleProviders(req, res) {
    res.set('Cache-Control', 'no-store');
    const byProvider = getStatsByProvider();
    if (Object.values(byProvider).some(v => !statsAreEmpty(v))) return res.json({ byProvider });

    res.json({ byProvider: summarizeLogMonths(logMonthKeys()).byProvider });
}

export function handleModels(req, res) {
    res.set('Cache-Control', 'no-store');
    const byModel = getStatsByModel();
    if (Object.values(byModel).some(v => !statsAreEmpty(v))) return res.json({ byModel });

    res.json({ byModel: summarizeLogMonths(logMonthKeys()).byModel });
}

export function handleHistory(req, res) {
    const limit = parseInt(req.query.limit, 10) || 50;
    res.set('Cache-Control', 'no-store');
    const entries = getRecentHistory(Math.min(limit, 500));
    if (entries.length) return res.json({ entries });
    const dates = getLogDates();
    const dateTo = dates[0] || todayKey();
    const from = new Date(`${dateTo}T00:00:00Z`);
    from.setDate(from.getDate() - 89);
    res.json(searchLogs({ dateFrom: dateKey(from), dateTo, limit: Math.min(limit, 500) }));
}

/**
 * Bucket recent history into time slots for mini-chart rendering.
 *
 *   ?granularity=hour&hours=24
 *   ?granularity=minute&minutes=60
 */
export function handleBuckets(req, res) {
    res.set('Cache-Control', 'no-store');
    const granularity = (req.query.granularity || 'hour').toLowerCase();
    const count = parseInt(req.query.hours || req.query.minutes || '24', 10);
    if (!['hour', 'minute'].includes(granularity)) {
        return res.status(400).json({ error: 'granularity must be "hour" or "minute"' });
    }

    const now = Date.now();
    const slotMs = granularity === 'hour' ? 60 * 60 * 1000 : 60 * 1000;
    const earliest = now - count * slotMs;
    const buckets = new Array(count).fill(0).map((_, i) => ({
        key: '',
        startMs: earliest + i * slotMs,
        endMs: earliest + (i + 1) * slotMs,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        errors: 0
    }));
    // Format key labels
    for (const b of buckets) {
        const d = new Date(b.startMs);
        if (granularity === 'hour') {
            b.key = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}`;
        } else {
            b.key = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        }
    }

    // History returns newest-first; iterate and place each entry into the slot
    let history = getRecentHistory(0);
    if (!history.length) history = entriesFromLogs({ dateFrom: new Date(earliest).toISOString().slice(0, 10), dateTo: todayKey() });
    for (const entry of history) {
        const ts = Date.parse(entry.timestamp);
        if (!isFinite(ts)) continue;
        if (ts < earliest || ts >= now) continue;
        const idx = Math.floor((ts - earliest) / slotMs);
        if (idx < 0 || idx >= buckets.length) continue;
        const b = buckets[idx];
        b.requests++;
        b.inputTokens += entry.inputTokens || 0;
        b.outputTokens += entry.outputTokens || 0;
        b.cost += entry.cost || 0;
        if (entry.success === false) b.errors++;
    }

    res.json({ granularity, count, buckets });
}

/**
 * Range-based aggregation for the analytics page.
 *   ?range=1d|3d|7d|30d|12m
 *
 * Returns:
 *   {
 *     range, granularity, totals, trend: [{key, requests, inputTokens, outputTokens, cost, errors}, ...],
 *     byProvider: { name: {...} },
 *     byModel:    { name: {...} }
 *   }
 *
 * Aggregation source: full history (capped at 20000 entries — for 12m this may
 * be partial under heavy traffic; that's an acceptable trade-off, the trend
 * line stays correct because it comes from the daily/monthly aggregates).
 */
export function handleRange(req, res) {
    res.set('Cache-Control', 'no-store');
    const range = (req.query.range || '7d').toLowerCase();
    const ranges = {
        '1d':  { ms: 24 * 60 * 60 * 1000,            granularity: 'hour' },
        '3d':  { ms: 3 * 24 * 60 * 60 * 1000,        granularity: 'hour' },
        '7d':  { ms: 7 * 24 * 60 * 60 * 1000,        granularity: 'day' },
        '30d': { ms: 30 * 24 * 60 * 60 * 1000,       granularity: 'day' },
        '12m': { ms: 365 * 24 * 60 * 60 * 1000,      granularity: 'month' }
    };
    const cfg = ranges[range];
    if (!cfg) return res.status(400).json({ error: 'range must be one of 1d/3d/7d/30d/12m' });

    const now = Date.now();
    const earliest = now - cfg.ms;

    // ─── Build trend ─────────────────────────────────────
    let trend = [];
    if (cfg.granularity === 'hour') {
        const hours = Math.round(cfg.ms / (60 * 60 * 1000));
        const slotMs = 60 * 60 * 1000;
        trend = new Array(hours).fill(0).map((_, i) => {
            const startMs = earliest + i * slotMs;
            const d = new Date(startMs);
            return {
                key: `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}`,
                startMs,
                endMs: startMs + slotMs,
                requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0, errors: 0
            };
        });
    } else if (cfg.granularity === 'day') {
        const days = Math.round(cfg.ms / (24 * 60 * 60 * 1000));
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - (days - 1));
        for (let i = 0; i < days; i++) {
            const d = new Date(cutoff); d.setDate(d.getDate() + i);
            trend.push({
                key: d.toISOString().slice(0, 10),
                startMs: d.getTime(),
                endMs: d.getTime() + 24 * 60 * 60 * 1000,
                requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0, errors: 0
            });
        }
    } else { // month
        const months = 12;
        const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
        start.setMonth(start.getMonth() - (months - 1));
        for (let i = 0; i < months; i++) {
            const d = new Date(start); d.setMonth(d.getMonth() + i);
            const end = new Date(d); end.setMonth(end.getMonth() + 1);
            trend.push({
                key: d.toISOString().slice(0, 7),
                startMs: d.getTime(),
                endMs: end.getTime(),
                requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0, errors: 0
            });
        }
    }

    const totals = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0, errors: 0 };
    const byProvider = {};
    const byModel = {};

    if (cfg.granularity === 'month') {
        const historical = summarizeLogMonths(trend.map(b => b.key));
        for (const [i, stats] of historical.monthly.entries()) {
            Object.assign(trend[i], stats);
        }
        return res.json({ range, granularity: cfg.granularity, totals: historical.totals, trend, byProvider: historical.byProvider, byModel: historical.byModel });
    }

    for (const bucket of trend) {
        const dateFrom = dateKey(new Date(bucket.startMs));
        const dateTo = dateKey(new Date(bucket.endMs - 1));
        const stats = summarizeLogRange(dateFrom, dateTo);
        Object.assign(bucket, stats);
        mergeStats(totals, stats);
    }

    const history = entriesFromLogs({ dateFrom: dateKey(new Date(trend[0]?.startMs || earliest)), dateTo: todayKey() });
    for (const e of history) {
        const pKey = e.provider || 'unknown';
        if (!byProvider[pKey]) byProvider[pKey] = emptyEntryStats();
        addEntryStat(byProvider[pKey], e);

        const mKey = e.model || 'unknown';
        if (!byModel[mKey]) byModel[mKey] = emptyEntryStats();
        addEntryStat(byModel[mKey], e);
    }

    res.json({ range, granularity: cfg.granularity, totals, trend, byProvider, byModel });
}

export default {
    handleOverview, handleDaily, handleMonthly,
    handleProviders, handleModels, handleHistory, handleBuckets, handleRange
};
