/**
 * REST endpoints for managing route mappings.
 *
 *   GET    /api/mappings           → list all
 *   POST   /api/mappings           → create
 *   GET    /api/mappings/:id       → fetch one
 *   PUT    /api/mappings/:id       → update (name, type, enabled, localSk, contextLimit, compressThreshold, strategy, rules)
 *   DELETE /api/mappings/:id       → remove
 */

import {
    listMappings,
    getMapping,
    addMapping,
    updateMapping,
    removeMapping
} from '../route-mappings.js';

export function handleList(req, res) {
    res.set('Cache-Control', 'no-store');
    res.json({ mappings: listMappings() });
}

export function handleGet(req, res) {
    const m = getMapping(req.params.id);
    if (!m) return res.status(404).json({ error: 'Not found' });
    res.json({ mapping: m });
}

export function handleCreate(req, res) {
    const result = addMapping(req.body || {});
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.status(201).json(result);
}

export function handleUpdate(req, res) {
    const result = updateMapping(req.params.id, req.body || {});
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result);
}

export function handleDelete(req, res) {
    const result = removeMapping(req.params.id);
    if (!result.ok) return res.status(404).json({ error: result.error });
    res.json(result);
}

export default { handleList, handleGet, handleCreate, handleUpdate, handleDelete };
