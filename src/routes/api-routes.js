/**
 * Wires all REST endpoints to the Express app.
 */

import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { handleMessages } from './messages-route.js';
import { handleResponses } from './responses-route.js';
import { handleChatCompletion } from './chat-route.js';
import { handleListModels } from './local-models-route.js';

import * as providers from './api-providers-route.js';
import * as mappings from './route-mappings-route.js';
import * as pricing from './pricing-route.js';
import * as usage from './usage-route.js';
import * as settings from './settings-route.js';
import { handleGetLogs, handleStreamLogs } from './logs-route.js';
import {
    handleGetRequestLogs,
    handleSearchRequestLogs,
    handleSummaryRequestLogs,
    handleExportRequestLogs,
    handleGetLogDates,
    handleGetLogProviders,
    handleGetLogSettings,
    handleUpdateLogSettings
} from './request-logs-route.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function registerApiRoutes(app) {
    // ─── Static Web UI ─────────────────────────────────────────────────────
    const publicDir = join(__dirname, '..', '..', 'public');
    app.use(express.static(publicDir));

    // ─── Health ────────────────────────────────────────────────────────────
    app.get('/health', (req, res) => res.json({ status: 'ok' }));

    // ─── Outbound endpoints (authenticated by sk → mapping) ────────────────
    app.post('/v1/messages', handleMessages);
    app.post('/v1/responses', handleResponses);
    app.post('/v1/chat/completions', handleChatCompletion);
    app.get('/v1/models', handleListModels);

    // ─── Settings ──────────────────────────────────────────────────────────
    app.get('/api/settings', settings.handleGet);
    app.put('/api/settings', settings.handleUpdate);
    app.get('/api/settings/network', settings.handleNetwork);
    app.get('/api/backup', settings.handleBackup);
    app.post('/api/import', settings.handleImport);

    // ─── Input API providers ──────────────────────────────────────────────
    app.get('/api/providers', providers.handleList);
    app.post('/api/providers', providers.handleCreate);
    app.get('/api/providers/:id', providers.handleGet);
    app.put('/api/providers/:id', providers.handleUpdate);
    app.delete('/api/providers/:id', providers.handleDelete);
    app.post('/api/providers/:id/discover', providers.handleDiscover);
    app.post('/api/providers/:id/validate', providers.handleValidate);

    // ─── Route mappings ────────────────────────────────────────────────────
    app.get('/api/mappings', mappings.handleList);
    app.post('/api/mappings', mappings.handleCreate);
    app.get('/api/mappings/:id', mappings.handleGet);
    app.put('/api/mappings/:id', mappings.handleUpdate);
    app.delete('/api/mappings/:id', mappings.handleDelete);

    // ─── Pricing ───────────────────────────────────────────────────────────
    app.get('/api/pricing', pricing.handleList);
    app.get('/api/pricing/:provider/:model', pricing.handleGet);
    app.put('/api/pricing/:provider/:model', pricing.handleSet);
    app.post('/api/pricing/:provider/:model/reset', pricing.handleReset);

    // ─── Usage analytics ───────────────────────────────────────────────────
    app.get('/api/usage/overview', usage.handleOverview);
    app.get('/api/usage/daily', usage.handleDaily);
    app.get('/api/usage/monthly', usage.handleMonthly);
    app.get('/api/usage/providers', usage.handleProviders);
    app.get('/api/usage/models', usage.handleModels);
    app.get('/api/usage/history', usage.handleHistory);
    app.get('/api/usage/buckets', usage.handleBuckets);
    app.get('/api/usage/range', usage.handleRange);

    // ─── Request logs (full search + export, retained from CliGate) ────────
    app.get('/api/request-logs', handleGetRequestLogs);
    app.get('/api/request-logs/search', handleSearchRequestLogs);
    app.get('/api/request-logs/summary', handleSummaryRequestLogs);
    app.get('/api/request-logs/export', handleExportRequestLogs);
    app.get('/api/request-logs/dates', handleGetLogDates);
    app.get('/api/request-logs/providers', handleGetLogProviders);
    app.get('/api/request-logs/settings', handleGetLogSettings);
    app.put('/api/request-logs/settings', handleUpdateLogSettings);

    // ─── System logs SSE ───────────────────────────────────────────────────
    app.get('/api/logs', handleGetLogs);
    app.get('/api/logs/stream', handleStreamLogs);
}

export default { registerApiRoutes };
