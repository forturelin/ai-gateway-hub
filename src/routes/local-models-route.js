/**
 * GET /v1/models
 *
 * Returns the list of input models exposed by the mapping bound to the sk
 * provided in the request. Both OpenAI and Anthropic native clients call this
 * to discover available models, so we accept any sk and respond in the same
 * shape both clients can parse:
 *
 *   { object: 'list', data: [{ id, object: 'model', owned_by: 'gateway' }, ...] }
 *
 * (OpenAI's standard format. Anthropic's `/v1/models` returns
 *  { data: [{ id, display_name }] }; OpenAI shape with extra fields is also
 *  tolerated by Claude SDKs in practice.)
 */

import { authenticateAndResolve } from '../sk-auth.js';
import { listInputModels } from '../gateway-router.js';

export function handleListModels(req, res) {
    const mapping = authenticateAndResolve(req, res, null);
    if (!mapping) return;

    const ids = listInputModels(mapping);
    const data = ids.map(id => ({
        id,
        object: 'model',
        owned_by: 'gateway',
        display_name: id,
        created: Math.floor(Date.now() / 1000)
    }));

    res.json({ object: 'list', data });
}

export default { handleListModels };
