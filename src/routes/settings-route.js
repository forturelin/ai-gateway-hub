/**
 * Server settings (system-wide, not per-mapping).
 *
 *   GET    /api/settings    → return current settings
 *   PUT    /api/settings    → patch settings (merged + persisted)
 *
 * Storage: ~/.ai-gateway-hub/settings.json
 *
 * Schema (V1):
 *   {
 *     "version": 1,
 *     "logging": {
 *       "enabled": true,
 *       "retentionDays": 365
 *     },
 *     "theme": "auto" | "light" | "dark"
 *   }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR, PORT, HOST } from '../config.js';
import { setRequestLoggingEnabled, cleanupOldLogs } from '../request-logger.js';
import { reload as reloadProviders } from '../api-providers.js';
import { reload as reloadMappings } from '../route-mappings.js';

const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json');

const DEFAULTS = {
    version: 1,
    logging: { enabled: true, retentionDays: 365 },
    theme: 'auto'
};

function ensureConfigDir() {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

function load() {
    if (!existsSync(SETTINGS_FILE)) return { ...DEFAULTS };
    try {
        const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
        return {
            version: 1,
            logging: { ...DEFAULTS.logging, ...(raw.logging || {}) },
            theme: raw.theme || DEFAULTS.theme
        };
    } catch {
        return { ...DEFAULTS };
    }
}

function save(data) {
    ensureConfigDir();
    try {
        writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch (err) {
        console.error('[settings] Save failed:', err.message);
    }
}

export function handleGet(req, res) {
    res.set('Cache-Control', 'no-store');
    const s = load();
    res.json({
        ...s,
        port: PORT,
        host: HOST,
        configDir: CONFIG_DIR
    });
}

export function handleUpdate(req, res) {
    const cur = load();
    const patch = req.body || {};
    const next = {
        version: 1,
        logging: { ...cur.logging, ...(patch.logging || {}) },
        theme: patch.theme || cur.theme
    };
    if (next.logging.retentionDays != null) {
        const n = parseInt(next.logging.retentionDays, 10);
        next.logging.retentionDays = isFinite(n) ? Math.max(1, Math.min(3650, n)) : 365;
    }
    save(next);

    setRequestLoggingEnabled(next.logging.enabled !== false);
    if (next.logging.retentionDays !== cur.logging.retentionDays) {
        cleanupOldLogs(next.logging.retentionDays);
    }
    res.json({ ...next, port: PORT, host: HOST, configDir: CONFIG_DIR });
}

export function getCurrentSettings() {
    return load();
}

// ─── Backup / Import ─────────────────────────────────────────────────────

const BACKUP_FILES = ['api-providers.json', 'route-mappings.json', 'pricing.json', 'settings.json'];

export function handleBackup(req, res) {
    const data = { _backup: true, version: '1.0.0', createdAt: new Date().toISOString() };
    for (const name of BACKUP_FILES) {
        const fp = join(CONFIG_DIR, name);
        try {
            if (existsSync(fp)) data[name] = JSON.parse(readFileSync(fp, 'utf8'));
        } catch { /* skip corrupted */ }
    }
    const now = new Date();
    const ts = now.toISOString().slice(0, 19).replace(/[T:]/g, '-');
    res.setHeader('Content-Disposition', `attachment; filename="ai-gateway-hub-backup-${ts}.json"`);
    res.json(data);
}

export function handleImport(req, res) {
    const data = req.body;
    if (!data || !data._backup) {
        return res.status(400).json({ error: 'Invalid backup file: missing _backup flag' });
    }
    ensureConfigDir();
    const restored = [];
    for (const name of BACKUP_FILES) {
        if (data[name]) {
            try {
                writeFileSync(join(CONFIG_DIR, name), JSON.stringify(data[name], null, 2), { mode: 0o600 });
                restored.push(name);
            } catch { /* skip */ }
        }
    }
    // Reload modules that cache config — without this, the in-memory cache
    // for providers/mappings still holds the OLD data and the import looks
    // partial until next restart.
    reloadProviders();
    reloadMappings();
    const s = load();
    setRequestLoggingEnabled(s.logging?.enabled !== false);
    res.json({ ok: true, restored });
}

export { SETTINGS_FILE };

export default { handleGet, handleUpdate, getCurrentSettings, handleBackup, handleImport, SETTINGS_FILE };
