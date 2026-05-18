/**
 * Config loader.
 * Reads config.json from project root (or AGH_CONFIG env var) and resolves
 * `~` in paths.
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

function expandHome(p) {
    if (typeof p !== 'string') return p;
    if (p.startsWith('~')) return join(homedir(), p.slice(1));
    return p;
}

const DEFAULTS = {
    port: 44559,
    host: '127.0.0.1',
    configDir: '~/.ai-gateway-hub',
    logging: { enabled: true, retentionDays: 365 }
};

function loadConfig() {
    const path = process.env.AGH_CONFIG || join(PROJECT_ROOT, 'config.json');
    let raw = {};
    if (existsSync(path)) {
        try {
            raw = JSON.parse(readFileSync(path, 'utf8'));
        } catch (err) {
            console.error(`[Config] Failed to parse ${path}: ${err.message}`);
            raw = {};
        }
    }
    const merged = {
        port: raw.port || DEFAULTS.port,
        host: raw.host || DEFAULTS.host,
        configDir: expandHome(raw.configDir || DEFAULTS.configDir),
        logging: { ...DEFAULTS.logging, ...(raw.logging || {}) }
    };
    return merged;
}

export const config = loadConfig();
export const CONFIG_DIR = config.configDir;
export const PORT = config.port;
export const HOST = config.host;
export { PROJECT_ROOT };
