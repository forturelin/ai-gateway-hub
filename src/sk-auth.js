/**
 * sk-auth middleware
 *
 * Extracts the local sk from an inbound request and resolves it to a route
 * mapping. If unauthorized, ends the response with 401 and returns null.
 * On success, attaches `req.aghMapping` and returns the mapping.
 *
 * Auth header conventions accepted:
 *   - Authorization: Bearer sk-xxx       (OpenAI style)
 *   - x-api-key: sk-xxx                  (Anthropic style)
 */

import { getMappingBySk } from './route-mappings.js';

function extractSk(req) {
    const auth = req.headers['authorization'] || '';
    if (auth.toLowerCase().startsWith('bearer ')) {
        return auth.slice(7).trim();
    }
    const xApiKey = req.headers['x-api-key'];
    if (xApiKey) return String(xApiKey).trim();
    return null;
}

/**
 * Returns the mapping object on success, or null on failure (after sending the
 * 401 response). Caller should `return` immediately if the result is null.
 *
 * Optionally enforces an expected protocol type — pass 'openai' on
 * /v1/chat/completions and 'anthropic' on /v1/messages. If the mapping's type
 * does not match, responds with 400 and returns null.
 */
export function authenticateAndResolve(req, res, expectedType = null) {
    const sk = extractSk(req);
    if (!sk) {
        res.status(401).json({
            error: {
                type: 'authentication_error',
                message: 'Missing API key. Provide it via Authorization: Bearer <sk> or x-api-key header.'
            }
        });
        return null;
    }

    const mapping = getMappingBySk(sk);
    if (!mapping) {
        res.status(401).json({
            error: {
                type: 'authentication_error',
                message: 'Invalid API key. The provided sk does not match any enabled route mapping.'
            }
        });
        return null;
    }

    if (expectedType && mapping.type !== expectedType) {
        res.status(400).json({
            error: {
                type: 'invalid_request_error',
                message: `This sk is bound to a "${mapping.type}" mapping; the requested endpoint requires "${expectedType}" type.`
            }
        });
        return null;
    }

    req.aghMapping = mapping;
    req.aghSk = sk;
    return mapping;
}

export default { authenticateAndResolve };
