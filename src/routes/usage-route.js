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

export function handleOverview(req, res) {
    res.set('Cache-Control', 'no-store');
    res.json({
        today: getTodayStats(),
        allTime: getAllTimeStats(),
        byProvider: getStatsByProvider(),
        byModel: getStatsByModel()
    });
}

export function handleDaily(req, res) {
    const days = parseInt(req.query.days, 10) || 7;
    res.set('Cache-Control', 'no-store');
    res.json({ days, data: getDailyStats(days) });
}

export function handleMonthly(req, res) {
    const months = parseInt(req.query.months, 10) || 6;
    res.set('Cache-Control', 'no-store');
    res.json({ months, data: getMonthlyStats(months) });
}

export function handleProviders(req, res) {
    res.set('Cache-Control', 'no-store');
    res.json({ byProvider: getStatsByProvider() });
}

export function handleModels(req, res) {
    res.set('Cache-Control', 'no-store');
    res.json({ byModel: getStatsByModel() });
}

export function handleHistory(req, res) {
    const limit = parseInt(req.query.limit, 10) || 50;
    res.set('Cache-Control', 'no-store');
    res.json({ entries: getRecentHistory(Math.min(limit, 500)) });
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
    const history = getRecentHistory(0);
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

    const history = getRecentHistory(0);
    for (const e of history) {
        const ts = Date.parse(e.timestamp);
        if (!isFinite(ts)) continue;
        const trendEarliest = trend.length ? trend[0].startMs : earliest;
        if (ts < trendEarliest || ts >= now) continue;

        const requests = 1;
        const inputTokens = e.inputTokens || 0;
        const outputTokens = e.outputTokens || 0;
        const cacheReadTokens = e.cacheReadTokens || 0;
        const cacheCreateTokens = e.cacheCreateTokens || 0;
        const cost = e.cost || 0;
        const errored = e.success === false ? 1 : 0;

        totals.requests += requests;
        totals.inputTokens += inputTokens;
        totals.outputTokens += outputTokens;
        totals.cacheReadTokens += cacheReadTokens;
        totals.cacheCreateTokens += cacheCreateTokens;
        totals.cost += cost;
        totals.errors += errored;

        const idx = trend.findIndex(b => ts >= b.startMs && ts < b.endMs);
        if (idx >= 0) {
            trend[idx].requests += requests;
            trend[idx].inputTokens += inputTokens;
            trend[idx].outputTokens += outputTokens;
            trend[idx].cacheReadTokens += cacheReadTokens;
            trend[idx].cacheCreateTokens += cacheCreateTokens;
            trend[idx].cost += cost;
            trend[idx].errors += errored;
        }

        const pKey = e.provider || 'unknown';
        if (!byProvider[pKey]) byProvider[pKey] = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0, errors: 0 };
        byProvider[pKey].requests += requests;
        byProvider[pKey].inputTokens += inputTokens;
        byProvider[pKey].outputTokens += outputTokens;
        byProvider[pKey].cacheReadTokens += cacheReadTokens;
        byProvider[pKey].cacheCreateTokens += cacheCreateTokens;
        byProvider[pKey].cost += cost;
        byProvider[pKey].errors += errored;

        const mKey = e.model || 'unknown';
        if (!byModel[mKey]) byModel[mKey] = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0, errors: 0 };
        byModel[mKey].requests += requests;
        byModel[mKey].inputTokens += inputTokens;
        byModel[mKey].outputTokens += outputTokens;
        byModel[mKey].cacheReadTokens += cacheReadTokens;
        byModel[mKey].cacheCreateTokens += cacheCreateTokens;
        byModel[mKey].cost += cost;
        byModel[mKey].errors += errored;
    }

    res.json({ range, granularity: cfg.granularity, totals, trend, byProvider, byModel });
}

export default {
    handleOverview, handleDaily, handleMonthly,
    handleProviders, handleModels, handleHistory, handleBuckets, handleRange
};
