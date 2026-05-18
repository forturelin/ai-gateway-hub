/**
 * /v1/messages — Anthropic Messages API endpoint
 *
 * Inbound request is in Anthropic Messages format.
 * Routing:
 *   1. Authenticate sk → resolve mapping (any type)
 *   2. Find matching rules for body.model, iterate by strategy
 *   3. For each candidate provider:
 *        - If provider.type === 'anthropic': passthrough
 *        - If provider.type === 'openai': translate Anthropic → OpenAI Chat,
 *          forward, translate response back
 *   4. On fatal failure, return 503 with "all providers exhausted"
 */

import { authenticateAndResolve } from '../sk-auth.js';
import { buildCandidates } from '../gateway-router.js';
import { recordUsage, recordError, recordRateLimit } from '../api-providers.js';
import { recordRequest } from '../usage-tracker.js';
import { logRequest } from '../request-logger.js';
import { tapAnthropicSSE } from '../middleware/sse.js';
import { logger } from '../utils/logger.js';

export async function handleMessages(req, res) {
    const startTime = Date.now();
    const mapping = authenticateAndResolve(req, res);
    if (!mapping) return;   // 401/400 already sent

    const body = req.body || {};
    const requestedModel = body.model || '';
    const isStreaming = body.stream !== false;

    const candidates = buildCandidates(mapping, requestedModel, 3);
    if (candidates.length === 0) {
        return res.status(404).json({
            error: {
                type: 'invalid_request_error',
                message: `No enabled rule matches model "${requestedModel}" in mapping "${mapping.name}".`
            }
        });
    }

    let lastErr = null;
    for (const { rule, provider } of candidates) {
        try {
            const upstreamBody = { ...body, model: rule.mappedModel };
            logger.info(`[Gateway] /v1/messages | ${mapping.name} | ${provider.name} (${provider.type}) | ${requestedModel} → ${rule.mappedModel}`);

            if (provider.type === 'anthropic') {
                // Native passthrough — provider returns the Anthropic-format response (or stream)
                const upstream = await provider.sendRequest(upstreamBody);
                const ok = await _handleAnthropicNativeResponse(req, res, upstream, {
                    mapping, provider, rule, requestedModel, startTime, isStreaming
                });
                if (ok) return;
                lastErr = new Error(`Provider returned ${upstream.status}`);
                continue;
            }

            if (provider.type === 'openai') {
                // Need to convert. provider.sendAnthropicRequest does that and returns
                // an Anthropic-shaped JSON response (stream not supported on this path).
                if (isStreaming) {
                    // Force stream off for upstream; we wrap into SSE on client side after
                    upstreamBody.stream = false;
                }
                const upstream = await provider.sendAnthropicRequest(upstreamBody);
                if (!upstream.ok) {
                    await _handleNonOk(upstream, provider);
                    lastErr = new Error(`Provider returned ${upstream.status}`);
                    continue;
                }
                const data = await upstream.json();
                const inputTokens = data.usage?.input_tokens || 0;
                const outputTokens = data.usage?.output_tokens || 0;
                const { cost, priceSnapshot } = provider.estimateCostWithSnapshot(rule.mappedModel, inputTokens, outputTokens);
                recordUsage(provider.id, { inputTokens, outputTokens, cost });
                const durationMs = Date.now() - startTime;
                recordRequest({
                    provider: provider.type, keyId: provider.id, mappingId: mapping.id,
                    model: requestedModel, mappedModel: rule.mappedModel,
                    inputTokens, outputTokens, cost, priceSnapshot, durationMs, success: true
                });
                logRequest({
                    route: '/v1/messages', method: 'POST', provider: provider.type,
                    providerName: provider.name, keyId: provider.id, mappingId: mapping.id,
                    model: requestedModel, mappedModel: rule.mappedModel,
                    requestBody: body, responseBody: data,
                    inputTokens, outputTokens, cost, priceSnapshot, durationMs, status: 200, success: true
                });
                logger.success(`[Gateway] OK ${provider.name} | ${requestedModel}→${rule.mappedModel} | ${inputTokens}+${outputTokens} | $${cost.toFixed(4)} | ${durationMs}ms`);

                if (isStreaming) {
                    _wrapAnthropicJsonAsSSE(res, data);
                } else {
                    res.json(data);
                }
                return;
            }

            // Unknown type — skip
            logger.warn(`[Gateway] Unknown provider type: ${provider.type}`);
            continue;
        } catch (err) {
            recordError(provider.id);
            logger.error(`[Gateway] ${provider.name} failed: ${err.message}`);
            lastErr = err;
            continue;
        }
    }

    return res.status(503).json({
        error: {
            type: 'service_unavailable',
            message: `All providers exhausted for model "${requestedModel}". Last: ${lastErr?.message || 'unknown'}`
        }
    });
}

async function _handleAnthropicNativeResponse(req, res, upstream, ctx) {
    const { mapping, provider, rule, requestedModel, startTime, isStreaming } = ctx;
    if (!upstream.ok) {
        await _handleNonOk(upstream, provider);
        return false;
    }

    const ct = upstream.headers?.get?.('content-type') || '';
    if (ct.includes('text/event-stream')) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        const usage = await tapAnthropicSSE(res, upstream);
        const durationMs = Date.now() - startTime;
        const { cost, priceSnapshot } = provider.estimateCostWithSnapshot(rule.mappedModel, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens);
        recordUsage(provider.id, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cost });
        recordRequest({
            provider: provider.type, keyId: provider.id, mappingId: mapping.id,
            model: requestedModel, mappedModel: rule.mappedModel,
            inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens, cacheCreateTokens: usage.cacheCreationTokens,
            cost, priceSnapshot, durationMs, success: true
        });
        logRequest({
            route: '/v1/messages', method: 'POST', provider: provider.type,
            providerName: provider.name, keyId: provider.id, mappingId: mapping.id,
            model: requestedModel, mappedModel: rule.mappedModel,
            requestBody: req.body,
            inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens, cacheCreateTokens: usage.cacheCreationTokens,
            cost, priceSnapshot, durationMs, status: 200, success: true
        });
        logger.success(`[Gateway] OK (stream) ${provider.name} | ${requestedModel}→${rule.mappedModel} | ${usage.inputTokens}+${usage.outputTokens} | $${cost.toFixed(4)} | ${durationMs}ms`);
        return true;
    }

    // JSON response
    const responseBody = await upstream.text();
    let parsed = null;
    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreateTokens = 0;
    try {
        parsed = JSON.parse(responseBody);
        inputTokens = parsed.usage?.input_tokens || 0;
        outputTokens = parsed.usage?.output_tokens || 0;
        cacheReadTokens = parsed.usage?.cache_read_input_tokens || 0;
        cacheCreateTokens = parsed.usage?.cache_creation_input_tokens || 0;
    } catch { /* keep raw */ }
    const { cost, priceSnapshot } = provider.estimateCostWithSnapshot(rule.mappedModel, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens);
    recordUsage(provider.id, { inputTokens, outputTokens, cost });
    const durationMs = Date.now() - startTime;
    recordRequest({
        provider: provider.type, keyId: provider.id, mappingId: mapping.id,
        model: requestedModel, mappedModel: rule.mappedModel,
        inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens,
        cost, priceSnapshot, durationMs, success: true
    });
    logRequest({
        route: '/v1/messages', method: 'POST', provider: provider.type,
        providerName: provider.name, keyId: provider.id, mappingId: mapping.id,
        model: requestedModel, mappedModel: rule.mappedModel,
        requestBody: req.body, responseBody,
        inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens,
        cost, priceSnapshot, durationMs, status: 200, success: true
    });
    logger.success(`[Gateway] OK ${provider.name} | ${requestedModel}→${rule.mappedModel} | ${inputTokens}+${outputTokens} | $${cost.toFixed(4)} | ${durationMs}ms`);

    if (isStreaming && parsed) {
        _wrapAnthropicJsonAsSSE(res, parsed);
    } else {
        res.status(200).type('json').send(responseBody);
    }
    return true;
}

async function _handleNonOk(upstream, provider) {
    const status = upstream.status;
    if (status === 429) {
        const retryAfter = upstream.headers?.get?.('retry-after');
        recordRateLimit(provider.id, retryAfter ? parseInt(retryAfter) * 1000 : 60000);
    } else if (status === 401 || status === 403) {
        recordError(provider.id);
    } else {
        recordError(provider.id);
    }
    try {
        const text = await upstream.text();
        logger.warn(`[Gateway] ${provider.name} HTTP ${status}: ${text.slice(0, 200)}`);
    } catch { /* ignore */ }
}

function _wrapAnthropicJsonAsSSE(res, msg) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    sse('message_start', {
        type: 'message_start',
        message: {
            id: msg.id || `msg_proxy_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model: msg.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: msg.usage?.input_tokens || 0, output_tokens: 0 }
        }
    });

    const content = msg.content || [];
    for (let i = 0; i < content.length; i++) {
        const block = content[i];
        if (!block?.type) continue;
        if (block.type === 'text') {
            sse('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
            if (block.text) sse('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } });
            sse('content_block_stop', { type: 'content_block_stop', index: i });
        } else if (block.type === 'tool_use') {
            sse('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
            sse('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) } });
            sse('content_block_stop', { type: 'content_block_stop', index: i });
        }
    }

    sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: msg.stop_reason || 'end_turn', stop_sequence: null },
        usage: { output_tokens: msg.usage?.output_tokens || 0 }
    });
    sse('message_stop', { type: 'message_stop' });
    res.end();
}

export default { handleMessages };
