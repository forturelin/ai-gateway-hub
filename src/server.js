/**
 * Express app factory + bootstrap.
 */

import express from 'express';
import cors from 'cors';

import { registerApiRoutes } from './routes/api-routes.js';
import { setRequestLoggingEnabled } from './request-logger.js';
import { getCurrentSettings } from './routes/settings-route.js';
import { logger } from './utils/logger.js';
import { PORT, HOST } from './config.js';

export function createServer() {
    // Apply persisted logging preference
    const settings = getCurrentSettings();
    setRequestLoggingEnabled(settings.logging?.enabled !== false);

    const app = express();
    app.disable('x-powered-by');

    // High-level access log
    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            const duration = Date.now() - start;
            const msg = `[${req.method}] ${req.originalUrl} ${res.statusCode} (${duration}ms)`;
            if (res.statusCode >= 400) {
                console.log(`\x1b[31m${msg}\x1b[0m`);
            } else if (req.originalUrl !== '/health') {
                console.log(`\x1b[36m${msg}\x1b[0m`);
            }
        });
        next();
    });

    app.use(cors({
        origin: [
            `http://localhost:${PORT}`,
            `http://127.0.0.1:${PORT}`,
            'http://localhost',
            'http://127.0.0.1'
        ],
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta'],
        credentials: false
    }));

    app.use(express.json({
        limit: '10mb',
        verify: (req, _res, buf) => {
            if (buf?.length) req.rawBody = Buffer.from(buf);
        }
    }));

    registerApiRoutes(app);

    // Global error handler
    app.use((err, req, res, _next) => {
        logger.error(`[Server] Unhandled error on ${req.method} ${req.originalUrl}: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({
                error: { type: 'internal_server_error', message: err.message }
            });
        }
    });

    return app;
}

export function startServer() {
    const app = createServer();

    const banner = [
        '',
        '╔══════════════════════════════════════════════════════════════╗',
        '║                  AI-Gateway-Hub v1.3.0                       ║',
        '╠══════════════════════════════════════════════════════════════╣',
        `║  Server:   http://${HOST}:${PORT}                          ║`,
        `║  WebUI:    http://${HOST}:${PORT}                          ║`,
        `║  Health:   http://${HOST}:${PORT}/health                   ║`,
        '╠══════════════════════════════════════════════════════════════╣',
        '║  Endpoints:                                                  ║',
        '║    POST /v1/responses         (OpenAI Responses API)            ║',
        '║    POST /v1/messages          (Anthropic Messages API)           ║',
        '║    GET  /v1/models            (per-sk dynamic list)          ║',
        '╚══════════════════════════════════════════════════════════════╝',
        ''
    ].join('\n');

    const primary = app.listen(PORT, HOST, () => {
        console.log(banner);
        logger.info(`AI-Gateway-Hub listening on ${HOST}:${PORT}`);
    });

    // Dual-bind for 0.0.0.0 — also grab 127.0.0.1:PORT explicitly so that
    // Windows TCP "more specific match wins" loopback routing can't be
    // hijacked by another process (e.g. VSCode Remote-SSH port forwarding,
    // dev tunnels, other gateways) silently binding 127.0.0.1:PORT first.
    // If something already owns 127.0.0.1:PORT we just warn — primary
    // 0.0.0.0 binding still serves external traffic.
    let loopback = null;
    if (HOST === '0.0.0.0') {
        loopback = app.listen(PORT, '127.0.0.1', () => {
            logger.info(`Dual-bind: also listening on 127.0.0.1:${PORT} (loopback hijack guard)`);
        });
        loopback.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.warn(`\x1b[33m⚠ 127.0.0.1:${PORT} is already bound by another process — loopback traffic may be hijacked. Run \`netstat -ano | findstr :${PORT}\` to identify it.\x1b[0m`);
                logger.warn(`Dual-bind 127.0.0.1:${PORT} failed: EADDRINUSE (loopback hijack possible)`);
            } else {
                logger.warn(`Dual-bind 127.0.0.1:${PORT} failed: ${err.code || err.message}`);
            }
        });
    }

    // Make Ctrl+C / SIGTERM close both servers cleanly.
    const closeAll = () => {
        try { primary.close(); } catch { /* ignore */ }
        try { loopback?.close(); } catch { /* ignore */ }
    };
    process.once('SIGINT', closeAll);
    process.once('SIGTERM', closeAll);

    return primary;
}

export default { createServer, startServer };
