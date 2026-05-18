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

export default {
    handleList, handleGet, handleCreate, handleUpdate, handleDelete,
    handleDiscover, handleValidate
};
