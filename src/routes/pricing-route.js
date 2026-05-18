/**
 * REST endpoints for the pricing registry.
 *
 *   GET    /api/pricing                 → list all (defaults + overrides merged)
 *   PUT    /api/pricing/:provider/:model → set custom price (body: input, output, cacheRead, cacheCreate)
 *   POST   /api/pricing/:provider/:model/reset → drop user override, revert to default
 */

import { listAll, setPrice, resetPrice, getPrice } from '../pricing-registry.js';

export function handleList(req, res) {
    res.set('Cache-Control', 'no-store');
    const items = listAll();
    res.json({ items });
}

export function handleSet(req, res) {
    const { provider, model } = req.params;
    if (!provider || !model) return res.status(400).json({ error: 'provider and model are required' });
    const { input = 0, output = 0, cacheRead = 0, cacheCreate = 0 } = req.body || {};
    const result = setPrice(provider, model, { input, output, cacheRead, cacheCreate });
    res.json({ ok: true, provider, model, price: result });
}

export function handleReset(req, res) {
    const { provider, model } = req.params;
    if (!provider || !model) return res.status(400).json({ error: 'provider and model are required' });
    const result = resetPrice(provider, model);
    res.json({ ok: true, provider, model, price: result });
}

export function handleGet(req, res) {
    const { provider, model } = req.params;
    if (!provider || !model) return res.status(400).json({ error: 'provider and model are required' });
    res.json({ provider, model, price: getPrice(provider, model) });
}

export default { handleList, handleSet, handleReset, handleGet };
