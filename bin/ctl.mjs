#!/usr/bin/env node
/**
 * AI-Gateway-Hub control script — cross-platform start/stop/restart/status.
 *
 * Single-instance enforced two ways:
 *   1. PID file at ~/.ai-gateway-hub/server.pid
 *   2. Port-occupant probe (in case PID file is stale/missing)
 *
 * Usage:
 *   node bin/ctl.mjs start    # spawn detached, write PID file
 *   node bin/ctl.mjs stop     # kill process gracefully (SIGTERM, then SIGKILL after 5s)
 *   node bin/ctl.mjs restart  # stop + start
 *   node bin/ctl.mjs status   # report alive/dead + PID + URL
 *   node bin/ctl.mjs logs     # tail the background log file
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, unlinkSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { spawn, execSync, spawnSync } from 'child_process';
import { homedir, platform } from 'os';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRY = join(PROJECT_ROOT, 'src', 'index.js');
const HOME_DIR = process.env.AGH_CONFIG_DIR || join(homedir(), '.ai-gateway-hub');
const PID_FILE = join(HOME_DIR, 'server.pid');
const LOG_FILE = join(HOME_DIR, 'server.log');
const IS_WIN = platform() === 'win32';
const NODE_MODULES_DIR = join(PROJECT_ROOT, 'node_modules');

export function shouldInstallDependencies(answer) {
    return String(answer || '').trim().toLowerCase() === 'y';
}

async function ensureDependencies() {
    if (existsSync(NODE_MODULES_DIR)) return true;

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error('✗ Dependencies are not installed. Run npm install first.');
        return false;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => rl.question('未检测到 node_modules，是否立即执行 npm install？[y/N] ', resolve));
    rl.close();
    if (!shouldInstallDependencies(answer)) {
        console.log('已取消启动。请先运行 npm install。');
        return false;
    }

    console.log('正在安装依赖...');
    const result = spawnSync(IS_WIN ? 'npm.cmd' : 'npm', ['install'], {
        cwd: PROJECT_ROOT,
        stdio: 'inherit',
        windowsHide: true
    });
    if (result.status !== 0 || result.error || !existsSync(NODE_MODULES_DIR)) {
        console.error('✗ npm install failed.');
        return false;
    }
    console.log('✓ Dependencies installed.');
    return true;
}

// Default — overridden by reading config.json if it exists.
let HOST = '127.0.0.1';
let PORT = 44559;
try {
    const cfgPath = process.env.AGH_CONFIG || join(PROJECT_ROOT, 'config.json');
    if (existsSync(cfgPath)) {
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
        if (cfg.host) HOST = cfg.host;
        if (cfg.port) PORT = cfg.port;
    }
} catch { /* fall through to defaults */ }

// ─── helpers ─────────────────────────────────────────────────────────────

function ensureDir() {
    if (!existsSync(HOME_DIR)) mkdirSync(HOME_DIR, { recursive: true });
}

function readPid() {
    if (!existsSync(PID_FILE)) return null;
    try {
        const n = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
        return Number.isFinite(n) ? n : null;
    } catch { return null; }
}

function isAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);  // signal 0 = existence check, no actual signal sent
        return true;
    } catch (e) {
        // EPERM = process exists but we lack permission to signal it (still alive)
        return e.code === 'EPERM';
    }
}

function findPidByPort() {
    try {
        if (IS_WIN) {
            const out = execSync('netstat -ano -p TCP', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
            for (const line of out.split(/\r?\n/)) {
                if (!line.includes('LISTENING')) continue;
                if (!line.includes(`${HOST}:${PORT}`) && !line.includes(`0.0.0.0:${PORT}`)) continue;
                const parts = line.trim().split(/\s+/);
                const pid = parseInt(parts[parts.length - 1], 10);
                if (Number.isFinite(pid)) return pid;
            }
        } else {
            // Try lsof first, then fall back to ss
            try {
                const out = execSync(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
                const pid = parseInt(out.split('\n')[0], 10);
                if (Number.isFinite(pid)) return pid;
            } catch {
                const out = execSync(`ss -lntp 'sport = :${PORT}'`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
                const m = out.match(/pid=(\d+)/);
                if (m) return parseInt(m[1], 10);
            }
        }
    } catch { /* ignore */ }
    return null;
}

/** Resolve the actual running PID — prefer PID file, fall back to port scan. */
function actualPid() {
    let pid = readPid();
    if (pid && isAlive(pid)) return pid;
    pid = findPidByPort();
    if (pid && isAlive(pid)) return pid;
    return null;
}

function runPowerShellStopProcess(pid, timeoutMs = 5000) {
    const result = spawnSync('powershell', [
        '-NoProfile',
        '-Command',
        `Stop-Process -Id ${pid} -Force -ErrorAction Stop`
    ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        windowsHide: true
    });
    return result.status === 0 && !result.error;
}

function runTaskkill(pid, timeoutMs = 5000) {
    const result = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        windowsHide: true
    });
    return result.status === 0 && !result.error;
}

function killPid(pid) {
    if (IS_WIN) {
        if (!runPowerShellStopProcess(pid)) runTaskkill(pid);
    } else {
        try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
    }
}

function killPidForce(pid) {
    if (IS_WIN) {
        if (!runPowerShellStopProcess(pid, 10000)) runTaskkill(pid, 10000);
    } else {
        try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    }
}

function clearPidFile() {
    try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch { /* ignore */ }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── commands ────────────────────────────────────────────────────────────

async function cmdStart({ dependenciesReady = false } = {}) {
    if (!dependenciesReady && !await ensureDependencies()) return 1;
    ensureDir();

    const existing = actualPid();
    if (existing) {
        console.log(`✓ Already running (PID ${existing})`);
        console.log(`  URL: http://${HOST}:${PORT}`);
        return 0;
    }

    // Cleanup stale PID file from a crashed prior run
    clearPidFile();

    const out = openSync(LOG_FILE, 'a');
    const err = openSync(LOG_FILE, 'a');

    const child = spawn(process.execPath, [ENTRY], {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: ['ignore', out, err],
        windowsHide: true,
        env: { ...process.env, AGH_BACKGROUND: '1' }
    });

    if (!child.pid) {
        console.error('✗ Failed to spawn child process');
        return 1;
    }

    writeFileSync(PID_FILE, String(child.pid));
    child.unref();

    // Wait briefly to confirm the child stayed alive past initial bootstrap
    await sleep(1500);
    if (!isAlive(child.pid)) {
        console.error(`✗ Process died immediately. Last 20 lines of ${LOG_FILE}:`);
        try {
            const lines = readFileSync(LOG_FILE, 'utf8').split('\n').slice(-20);
            for (const line of lines) console.error('  ' + line);
        } catch { /* ignore */ }
        clearPidFile();
        return 1;
    }

    console.log(`✓ Started (PID ${child.pid})`);
    console.log(`  Log: ${LOG_FILE}`);
    console.log(`  URL: http://${HOST}:${PORT}`);
    return 0;
}

async function cmdStop() {
    const pid = actualPid();
    if (!pid) {
        console.log('✓ Not running');
        clearPidFile();
        return 0;
    }

    console.log(`Stopping PID ${pid} ...`);
    killPid(pid);

    // Wait up to 5 seconds for graceful shutdown
    for (let i = 0; i < 10; i++) {
        if (!isAlive(pid)) break;
        await sleep(500);
    }

    if (isAlive(pid)) {
        console.log(`PID ${pid} still alive after 5s, sending SIGKILL`);
        killPidForce(pid);
        await sleep(500);
    }

    if (isAlive(pid)) {
        console.error(`✗ Failed to stop PID ${pid}`);
        return 1;
    }

    clearPidFile();
    console.log(`✓ Stopped`);
    return 0;
}

async function cmdRestart() {
    if (!await ensureDependencies()) return 1;
    const stopCode = await cmdStop();
    if (stopCode !== 0) return stopCode;
    await sleep(500);
    return await cmdStart({ dependenciesReady: true });
}

function cmdStatus() {
    const pid = actualPid();
    if (pid) {
        let logSize = '-';
        try { logSize = (statSync(LOG_FILE).size / 1024).toFixed(1) + ' KB'; } catch { /* ignore */ }
        console.log(`✓ Running`);
        console.log(`  PID:  ${pid}`);
        console.log(`  URL:  http://${HOST}:${PORT}`);
        console.log(`  Log:  ${LOG_FILE} (${logSize})`);
    } else {
        console.log('✗ Not running');
        return 1;
    }
    return 0;
}

function cmdLogs() {
    if (!existsSync(LOG_FILE)) {
        console.log('(no log file yet)');
        return 0;
    }
    try {
        const text = readFileSync(LOG_FILE, 'utf8');
        const lines = text.split('\n');
        const tail = lines.slice(-100).join('\n');
        console.log(tail);
    } catch (err) {
        console.error('Read log failed:', err.message);
        return 1;
    }
    return 0;
}

function usage() {
    console.log(`AI-Gateway-Hub control

Usage: node bin/ctl.mjs <command>

Commands:
  start     Spawn server in background (idempotent — refuses if already running)
  stop      Stop background server (SIGTERM, then SIGKILL after 5s)
  restart   Stop then start
  status    Report whether server is running
  logs      Tail last 100 lines of the background log

Files:
  PID:  ${PID_FILE}
  Log:  ${LOG_FILE}

Endpoint: http://${HOST}:${PORT}
`);
}

// ─── interactive menu ───────────────────────────────────────────────────

function statusLine() {
    const pid = actualPid();
    if (pid) return `  状态: \x1b[32m● 运行中\x1b[0m (PID ${pid})  地址: http://${HOST}:${PORT}`;
    return '  状态: \x1b[31m○ 未运行\x1b[0m';
}

async function interactiveMenu() {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(r => rl.question(q, r));

    while (true) {
        console.log(`
\x1b[36m╔══════════════════════════════════════════╗
║        AI-Gateway-Hub 控制面板           ║
╚══════════════════════════════════════════╝\x1b[0m
${statusLine()}

  \x1b[33m1\x1b[0m  启动服务
  \x1b[33m2\x1b[0m  停止服务
  \x1b[33m3\x1b[0m  重启服务
  \x1b[33m4\x1b[0m  查看状态
  \x1b[33m5\x1b[0m  查看日志（最近 100 行）
  \x1b[33m0\x1b[0m  退出
`);
        const choice = (await ask('请选择 [0-5]: ')).trim();

        const actions = { '1': cmdStart, '2': cmdStop, '3': cmdRestart, '4': cmdStatus, '5': cmdLogs };
        if (choice === '0' || choice === 'q' || choice === 'exit') { rl.close(); return 0; }

        const action = actions[choice];
        if (action) {
            console.log('');
            await action();
            await ask('\n按回车继续...');
        } else {
            console.log('  无效选择，请输入 0-5');
        }
    }
}

// ─── dispatch ────────────────────────────────────────────────────────────
const cmd = process.argv[2];
const handlers = { start: cmdStart, stop: cmdStop, restart: cmdRestart, status: cmdStatus, logs: cmdLogs };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (!cmd) {
        interactiveMenu().then(code => process.exit(code || 0));
    } else {
        const fn = handlers[cmd];
        if (!fn) {
            if (cmd !== '--help' && cmd !== '-h') console.error(`Unknown command: ${cmd}\n`);
            usage();
            process.exit(handlers[cmd] === undefined ? 1 : 0);
        }
        Promise.resolve(fn()).then(code => process.exit(code || 0));
    }
}
