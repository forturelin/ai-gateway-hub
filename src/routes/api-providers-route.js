/**
 * REST endpoints for managing input API providers (the upstream services
 * AI-Gateway-Hub forwards to).
 *
 *   GET    /api/providers                  → list (safe; key masked)
 *   POST   /api/providers                  → create  (body: type, name, baseUrl, apiKey, selectedModels?)
 *   GET    /api/providers/:id              → fetch one (safe)
 *   PUT    /api/providers/:id              → update fields
 *   DELETE /api/providers/:id              → remove
 *   POST   /api/providers/:id/discover     → call upstream /models, persist list
 *   POST   /api/providers/:id/validate     → ping upstream to check key validity
 *   POST   /api/providers/:id/health/:model → test model health (simple request)
 */

import {
    listProviders,
    getProvider,
    addProvider,
    updateProvider,
    removeProvider,
    discoverModels,
    validateProvider
} from '../api-providers.js';

export function handleList(req, res) {
    res.set('Cache-Control', 'no-store');
    res.json({ providers: listProviders() });
}

export function handleGet(req, res) {
    const inst = getProvider(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Not found' });
    res.json({ provider: inst.toSafeJSON() });
}

export function handleCreate(req, res) {
    const result = addProvider(req.body || {});
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.status(201).json(result);
}

export function handleUpdate(req, res) {
    const result = updateProvider(req.params.id, req.body || {});
    if (!result.ok) return res.status(404).json({ error: result.error });
    res.json(result);
}

export function handleDelete(req, res) {
    const result = removeProvider(req.params.id);
    if (!result.ok) return res.status(404).json({ error: result.error });
    res.json(result);
}

export async function handleDiscover(req, res) {
    const result = await discoverModels(req.params.id);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result);
}

export async function handleValidate(req, res) {
    const result = await validateProvider(req.params.id);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result);
}

export async function handleHealthCheck(req, res) {
    const { id, model } = req.params;
    const provider = getProvider(id);

    if (!provider) {
        return res.status(404).json({ error: 'Provider not found' });
    }

    try {
        const startTime = Date.now();
        let result;

        // 根据 provider 类型发送简单测试请求
        if (provider.type === 'anthropic') {
            result = await provider.sendRequest({
                model: model,
                messages: [{ role: 'user', content: 'hi' }],
                max_tokens: 10,
                stream: false
            });
        } else if (provider.type === 'openai') {
            result = await provider.sendRequest({
                model: model,
                messages: [{ role: 'user', content: 'hi' }],
                max_tokens: 10,
                stream: false
            });
        } else {
            return res.status(400).json({ error: 'Unsupported provider type' });
        }

        const duration = Date.now() - startTime;

        if (result.ok) {
            res.json({
                ok: true,
                model: model,
                status: 'healthy',
                responseTime: duration,
                statusCode: result.status
            });
        } else {
            const errorText = await result.text();
            res.json({
                ok: false,
                model: model,
                status: 'unhealthy',
                responseTime: duration,
                statusCode: result.status,
                error: errorText.slice(0, 200)
            });
        }
    } catch (err) {
        res.status(500).json({
            ok: false,
            model: model,
            status: 'error',
            error: err.message
        });
    }
}

export default {
    handleList, handleGet, handleCreate, handleUpdate, handleDelete,
    handleDiscover, handleValidate, handleHealthCheck
};
