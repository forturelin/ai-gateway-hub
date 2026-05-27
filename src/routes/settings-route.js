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
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { platform } from 'os';
import { CONFIG_DIR, PORT, HOST, PROJECT_ROOT } from '../config.js';
import { setRequestLoggingEnabled, cleanupOldLogs } from '../request-logger.js';
import { reload as reloadProviders } from '../api-providers.js';
import { reload as reloadMappings } from '../route-mappings.js';

const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json');
const PROJECT_CONFIG_FILE = process.env.AGH_CONFIG || join(PROJECT_ROOT, 'config.json');
const IS_WIN = platform() === 'win32';
const FW_SCRIPT = IS_WIN
    ? join(PROJECT_ROOT, 'bin', 'setup-firewall.bat')
    : join(PROJECT_ROOT, 'bin', 'setup-firewall.sh');

const DEFAULTS = {
    version: 1,
    logging: { enabled: true, retentionDays: 365 },
    theme: 'auto',
    bedrockOptimizer: { enabled: true, thinking: true, cacheInjection: true, cacheTtl: '1h' }
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
            theme: raw.theme || DEFAULTS.theme,
            bedrockOptimizer: { ...DEFAULTS.bedrockOptimizer, ...(raw.bedrockOptimizer || {}) }
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
        theme: patch.theme || cur.theme,
        bedrockOptimizer: { ...cur.bedrockOptimizer, ...(patch.bedrockOptimizer || {}) }
    };
    if (next.logging.retentionDays != null) {
        const n = parseInt(next.logging.retentionDays, 10);
        next.logging.retentionDays = isFinite(n) ? Math.max(1, Math.min(3650, n)) : 365;
    }
    next.bedrockOptimizer.enabled = next.bedrockOptimizer.enabled !== false;
    next.bedrockOptimizer.thinking = next.bedrockOptimizer.thinking !== false;
    next.bedrockOptimizer.cacheInjection = next.bedrockOptimizer.cacheInjection !== false;
    next.bedrockOptimizer.cacheTtl = next.bedrockOptimizer.cacheTtl === '5m' ? '5m' : '1h';
    save(next);

    setRequestLoggingEnabled(next.logging.enabled !== false);
    if (next.logging.retentionDays !== cur.logging.retentionDays) {
        cleanupOldLogs(next.logging.retentionDays);
    }

    // Optional: update host in project config.json (takes effect after restart).
    let hostUpdated = false;
    if (typeof patch.host === 'string' && (patch.host === '127.0.0.1' || patch.host === '0.0.0.0')) {
        try {
            let projCfg = {};
            if (existsSync(PROJECT_CONFIG_FILE)) {
                projCfg = JSON.parse(readFileSync(PROJECT_CONFIG_FILE, 'utf8'));
            }
            if (projCfg.host !== patch.host) {
                projCfg.host = patch.host;
                writeFileSync(PROJECT_CONFIG_FILE, JSON.stringify(projCfg, null, 2));
                hostUpdated = true;
            }
        } catch (err) {
            console.error('[settings] host write failed:', err.message);
        }
    }

    res.json({
        ...next,
        port: PORT,
        host: hostUpdated ? patch.host : HOST,
        configDir: CONFIG_DIR,
        hostUpdated,
        needsRestart: hostUpdated
    });
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

// ─── Network status (firewall probe) ────────────────────────────────────
//
// GET /api/settings/network
//   → { host, port, firewall: { state, raw, scriptPath, platform, command } }
// state ∈ "present" | "missing" | "unknown" | "no-script"
// Never modifies system state — pure status read.

// Async exec helper — never blocks event loop. Caps stdout at 4 KB.
function execProbe(cmd, args, timeoutMs = 8000) {
    return new Promise((resolve) => {
        let buf = '';
        let done = false;
        let timer = null;
        const finalize = (state, err) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            try { child.kill(); } catch { /* ignore */ }
            resolve({ raw: buf.slice(0, 4096), state, err });
        };
        let child;
        try {
            child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            return resolve({ raw: '', state: 'spawn-failed', err: err.message });
        }
        child.stdout.on('data', d => { buf += d.toString(); });
        child.stderr.on('data', d => { buf += d.toString(); });
        child.on('error', err => finalize('spawn-failed', err.message));
        child.on('close', () => finalize('done'));
        timer = setTimeout(() => finalize('timeout'), timeoutMs);
    });
}

export async function handleNetwork(req, res) {
    res.set('Cache-Control', 'no-store');
    const out = {
        host: HOST,
        port: PORT,
        platform: IS_WIN ? 'win32' : 'linux',
        firewall: {
            state: 'unknown',
            raw: '',
            scriptPath: FW_SCRIPT,
            command: IS_WIN
                ? `"${FW_SCRIPT}" add`
                : `bash "${FW_SCRIPT}" add`,
            removeCommand: IS_WIN
                ? `"${FW_SCRIPT}" remove`
                : `bash "${FW_SCRIPT}" remove`
        }
    };

    if (HOST !== '0.0.0.0') {
        out.firewall.state = 'not-applicable';
        return res.json(out);
    }
    if (!existsSync(FW_SCRIPT)) {
        out.firewall.state = 'no-script';
        return res.json(out);
    }

    const probe = IS_WIN
        ? await execProbe('cmd.exe', ['/c', FW_SCRIPT, 'status'])
        : await execProbe('bash', [FW_SCRIPT, 'status']);

    const raw = probe.raw.trim();
    out.firewall.raw = raw.slice(0, 500);
    if (raw.startsWith('PRESENT')) out.firewall.state = 'present';
    else if (raw.startsWith('MISSING')) out.firewall.state = 'missing';
    else if (probe.state === 'timeout') out.firewall.state = 'unknown';
    else out.firewall.state = 'unknown';

    res.json(out);
}

export default { handleGet, handleUpdate, getCurrentSettings, handleBackup, handleImport, handleNetwork, SETTINGS_FILE };
