/**
 * Request Logs Route
 * Provides API for querying request/response logs from the dashboard.
 *
 * GET /api/request-logs           — Legacy single-day query
 * GET /api/request-logs/search    — New: cross-day search with rich filters
 * GET /api/request-logs/summary   — Aggregate statistics for current filter
 * GET /api/request-logs/export    — Stream-export matching entries (json|csv)
 * GET /api/request-logs/dates     — List available log dates
 * GET /api/request-logs/providers — List known providers (for UI dropdown)
 * GET /api/request-logs/settings  — Get logging settings
 * PUT /api/request-logs/settings  — Update logging settings
 */

import {
    queryLogs,
    searchLogs,
    summarizeLogs,
    iterateLogsForExport,
    getLogDates,
    getKnownProviders,
    setRequestLoggingEnabled,
    isRequestLoggingEnabled,
    cleanupOldLogs
} from '../request-logger.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from '../config.js';

// Adapter: keep this file's existing getServerSettings / setServerSettings calls
// working against the new {logging:{enabled,retentionDays}} schema.
const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json');
function _loadSettings() {
    if (!existsSync(SETTINGS_FILE)) return { logging: { enabled: true, retentionDays: 365 } };
    try { return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); }
    catch { return { logging: { enabled: true, retentionDays: 365 } }; }
}
function _saveSettings(data) {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    try { writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 }); }
    catch (err) { console.error('[settings] save failed:', err.message); }
}
function getServerSettings() {
    const s = _loadSettings();
    return {
        enableRequestLogging: s.logging?.enabled !== false,
        requestLogRetentionDays: s.logging?.retentionDays || 365
    };
}
function setServerSettings(patch) {
    const cur = _loadSettings();
    const logging = { ...(cur.logging || {}) };
    if (patch.enableRequestLogging !== undefined) logging.enabled = !!patch.enableRequestLogging;
    if (patch.requestLogRetentionDays !== undefined) logging.retentionDays = patch.requestLogRetentionDays;
    const next = { ...cur, version: 1, logging };
    _saveSettings(next);
    return {
        enableRequestLogging: next.logging.enabled !== false,
        requestLogRetentionDays: next.logging.retentionDays || 365
    };
}

const MAX_RETENTION_DAYS = 3650;
const DEFAULT_RETENTION_DAYS = 365;

// ─── Legacy single-day query ─────────────────────────────────────────────────

export function handleGetRequestLogs(req, res) {
    res.set('Cache-Control', 'no-store');
    const { date, limit, offset, provider, model, errorsOnly } = req.query;
    const result = queryLogs({
        date,
        limit: limit ? parseInt(limit, 10) : 50,
        offset: offset ? parseInt(offset, 10) : 0,
        provider,
        model,
        errorsOnly: errorsOnly === 'true',
    });
    res.json(result);
}

// ─── New: cross-day search ───────────────────────────────────────────────────

function parseSearchQuery(q) {
    // Express collects repeated `?provider=a&provider=b` as an array; single
    // value stays a string. Normalize both forms.
    const provider = q.provider !== undefined
        ? (Array.isArray(q.provider) ? q.provider : [q.provider])
        : undefined;

    const parseNum = (v) => (v === undefined || v === '' ? undefined : Number(v));
    const parseBool = (v) => {
        if (v === undefined || v === '' || v === 'any') return undefined;
        if (v === 'true' || v === '1') return true;
        if (v === 'false' || v === '0') return false;
        return undefined;
    };

    return {
        dateFrom: q.dateFrom || undefined,
        dateTo: q.dateTo || undefined,
        provider,
        model: q.model || undefined,
        keyId: q.keyId || undefined,
        success: parseBool(q.success),
        minInputTokens: parseNum(q.minInputTokens),
        minOutputTokens: parseNum(q.minOutputTokens),
        minCost: parseNum(q.minCost),
        maxCost: parseNum(q.maxCost),
        q: q.q || undefined,
        sort: q.sort || undefined,
        limit: q.limit ? parseInt(q.limit, 10) : 100,
        offset: q.offset ? parseInt(q.offset, 10) : 0
    };
}

export function handleSearchRequestLogs(req, res) {
    res.set('Cache-Control', 'no-store');
    const opts = parseSearchQuery(req.query);
    const result = searchLogs(opts);
    if (result.error) {
        return res.status(400).json(result);
    }
    res.json(result);
}

export function handleSummaryRequestLogs(req, res) {
    res.set('Cache-Control', 'no-store');
    const opts = parseSearchQuery(req.query);
    const result = summarizeLogs(opts);
    if (result.error) {
        return res.status(400).json(result);
    }
    res.json(result);
}

// ─── Export: stream JSON or CSV ──────────────────────────────────────────────

const CSV_COLUMNS = [
    'id', 'timestamp', 'route', 'method', 'provider', 'keyId',
    'model', 'mappedModel', 'inputTokens', 'outputTokens',
    'cacheReadTokens', 'cacheCreateTokens', 'cost',
    'durationMs', 'status', 'success', 'error', 'requestBody', 'responseBody'
];

function escapeCsv(value) {
    if (value === null || value === undefined) return '';
    let str = typeof value === 'string' ? value : (typeof value === 'object' ? JSON.stringify(value) : String(value));
    if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
        str = '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

export async function handleExportRequestLogs(req, res) {
    res.set('Cache-Control', 'no-store');
    const format = (req.query.format || 'json').toLowerCase();
    const opts = parseSearchQuery(req.query);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');

    try {
        if (format === 'csv') {
            res.set('Content-Type', 'text/csv; charset=utf-8');
            res.set('Content-Disposition', `attachment; filename="request-logs-${ts}.csv"`);
            res.write('﻿'); // BOM for Excel UTF-8
            res.write(CSV_COLUMNS.join(',') + '\n');
            let yielded = 0;
            for await (const entry of iterateLogsForExport(opts)) {
                if (res.writableEnded || res.destroyed) break;
                const row = CSV_COLUMNS.map(col => escapeCsv(entry[col]));
                const ok = res.write(row.join(',') + '\n');
                if (!ok) await new Promise(r => res.once('drain', r));
                if (++yielded % 100 === 0) await new Promise(r => setImmediate(r));
            }
            res.end();
            return;
        }

        // Default: JSON array
        res.set('Content-Type', 'application/json; charset=utf-8');
        res.set('Content-Disposition', `attachment; filename="request-logs-${ts}.json"`);
        res.write('[');
        let first = true;
        let yielded = 0;
        for await (const entry of iterateLogsForExport(opts)) {
            if (res.writableEnded || res.destroyed) break;
            const prefix = first ? '' : ',';
            first = false;
            const ok = res.write(prefix + JSON.stringify(entry));
            if (!ok) await new Promise(r => res.once('drain', r));
            if (++yielded % 100 === 0) await new Promise(r => setImmediate(r));
        }
        res.write(']');
        res.end();
    } catch (err) {
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        } else if (!res.writableEnded) {
            try { res.end(); } catch { /* ignore */ }
        }
    }
}

// ─── Auxiliary ───────────────────────────────────────────────────────────────

export function handleGetLogDates(req, res) {
    res.set('Cache-Control', 'no-store');
    res.json({ dates: getLogDates() });
}

export function handleGetLogProviders(req, res) {
    res.set('Cache-Control', 'no-store');
    res.json({ providers: getKnownProviders() });
}

export function handleGetLogSettings(req, res) {
    res.set('Cache-Control', 'no-store');
    const settings = getServerSettings();
    res.json({
        enabled: settings.enableRequestLogging !== false,
        retentionDays: settings.requestLogRetentionDays || DEFAULT_RETENTION_DAYS,
    });
}

export function handleUpdateLogSettings(req, res) {
    const { enabled, retentionDays } = req.body;
    const patch = {};

    if (enabled !== undefined) {
        patch.enableRequestLogging = !!enabled;
        setRequestLoggingEnabled(!!enabled);
    }
    if (retentionDays !== undefined) {
        const n = parseInt(retentionDays, 10);
        patch.requestLogRetentionDays = isFinite(n)
            ? Math.max(1, Math.min(MAX_RETENTION_DAYS, n))
            : DEFAULT_RETENTION_DAYS;
    }

    const updated = setServerSettings(patch);

    if (patch.requestLogRetentionDays) {
        cleanupOldLogs(patch.requestLogRetentionDays);
    }

    res.json({
        enabled: updated.enableRequestLogging !== false,
        retentionDays: updated.requestLogRetentionDays || DEFAULT_RETENTION_DAYS,
    });
}

export default {
    handleGetRequestLogs,
    handleSearchRequestLogs,
    handleSummaryRequestLogs,
    handleExportRequestLogs,
    handleGetLogDates,
    handleGetLogProviders,
    handleGetLogSettings,
    handleUpdateLogSettings
};
