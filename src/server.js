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
    return app.listen(PORT, HOST, () => {
        const banner = [
            '',
            '╔══════════════════════════════════════════════════════════════╗',
            '║                  AI-Gateway-Hub v1.1.0                       ║',
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
        console.log(banner);
        logger.info(`AI-Gateway-Hub listening on ${HOST}:${PORT}`);
    });
}

export default { createServer, startServer };
