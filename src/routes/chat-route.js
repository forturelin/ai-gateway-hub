/**
 * /v1/chat/completions — OpenAI Chat Completions endpoint
 *
 * Inbound request is in OpenAI Chat Completions format.
 * Routing:
 *   1. Authenticate sk → resolve mapping (any type)
 *   2. Pick rules for body.model, iterate by strategy
 *   3. For each candidate provider:
 *        - provider.type === 'openai': passthrough (supports streaming)
 *        - provider.type === 'anthropic': translate OpenAI → Anthropic,
 *          forward, translate response back
 *   4. On exhaustion: 503
 */

import { authenticateAndResolve } from '../sk-auth.js';
import { buildCandidates } from '../gateway-router.js';
import { recordUsage, recordError, recordRateLimit } from '../api-providers.js';
import { recordRequest } from '../usage-tracker.js';
import { logRequest } from '../request-logger.js';
import { pipeWithBackpressure, tapOpenAISSE } from '../middleware/sse.js';
import { openAIToAnthropicRequest, anthropicToOpenAIResponse } from '../providers/format-bridge.js';
import { logger } from '../utils/logger.js';

export async function handleChatCompletion(req, res) {
    const startTime = Date.now();
    const mapping = authenticateAndResolve(req, res);
    if (!mapping) return;

    const body = req.body || {};
    const requestedModel = body.model || '';
    const isStreaming = body.stream === true;

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
            logger.info(`[Gateway] /v1/chat/completions | ${mapping.name} | ${provider.name} (${provider.type}) | ${requestedModel} → ${rule.mappedModel}`);

            if (provider.type === 'anthropic') {
                const anthropicBody = openAIToAnthropicRequest(upstreamBody);
                anthropicBody.stream = false;
                const upstream = await provider.sendRequest(anthropicBody);
                if (!upstream.ok) {
                    await _handleNonOk(upstream, provider);
                    lastErr = new Error(`Provider returned ${upstream.status}`);
                    continue;
                }
                const anthropicData = await upstream.json();
                const openaiData = anthropicToOpenAIResponse(anthropicData, rule.mappedModel);
                const inputTokens = anthropicData.usage?.input_tokens || 0;
                const outputTokens = anthropicData.usage?.output_tokens || 0;
                const cacheReadTokens = anthropicData.usage?.cache_read_input_tokens || 0;
                const cacheCreateTokens = anthropicData.usage?.cache_creation_input_tokens || 0;
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
                    route: '/v1/chat/completions', method: 'POST', provider: provider.type,
                    providerName: provider.name, keyId: provider.id, mappingId: mapping.id,
                    model: requestedModel, mappedModel: rule.mappedModel,
                    requestBody: body, responseBody: openaiData,
                    inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens,
                    cost, priceSnapshot, durationMs, status: 200, success: true
                });
                logger.success(`[Gateway] OK ${provider.name} | ${requestedModel}→${rule.mappedModel} | ${inputTokens}+${outputTokens} | $${cost.toFixed(4)} | ${durationMs}ms`);

                if (isStreaming) {
                    _wrapOpenAIJsonAsSSE(res, openaiData);
                } else {
                    res.json(openaiData);
                }
                return;
            }

            // provider.type === 'openai' — native passthrough
            if (isStreaming) {
                upstreamBody.stream_options = { ...(body.stream_options || {}), include_usage: true };
            }

            const upstream = await provider.sendRequest(upstreamBody);
            if (!upstream.ok) {
                await _handleNonOk(upstream, provider);
                lastErr = new Error(`Provider returned ${upstream.status}`);
                continue;
            }

            const ct = upstream.headers?.get?.('content-type') || '';
            if (isStreaming && ct.includes('text/event-stream')) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders();
                const usage = await tapOpenAISSE(res, upstream);

                const durationMs = Date.now() - startTime;
                const { cost, priceSnapshot } = provider.estimateCostWithSnapshot(rule.mappedModel, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreateTokens);
                recordUsage(provider.id, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cost });
                recordRequest({
                    provider: provider.type, keyId: provider.id, mappingId: mapping.id,
                    model: requestedModel, mappedModel: rule.mappedModel,
                    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
                    cacheReadTokens: usage.cacheReadTokens, cacheCreateTokens: usage.cacheCreateTokens,
                    cost, priceSnapshot, durationMs, success: true
                });
                logRequest({
                    route: '/v1/chat/completions', method: 'POST', provider: provider.type,
                    providerName: provider.name, keyId: provider.id, mappingId: mapping.id,
                    model: requestedModel, mappedModel: rule.mappedModel,
                    requestBody: body,
                    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
                    cacheReadTokens: usage.cacheReadTokens, cacheCreateTokens: usage.cacheCreateTokens,
                    cost, priceSnapshot, durationMs, status: 200, success: true
                });
                logger.success(`[Gateway] OK (stream) ${provider.name} | ${requestedModel}→${rule.mappedModel} | ${usage.inputTokens}+${usage.outputTokens} | $${cost.toFixed(4)} | ${durationMs}ms`);
                return;
            }

            // JSON response
            const responseBody = await upstream.text();
            let parsed = null;
            let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0;
            try {
                parsed = JSON.parse(responseBody);
                inputTokens = parsed.usage?.prompt_tokens || 0;
                outputTokens = parsed.usage?.completion_tokens || 0;
                cacheReadTokens = parsed.usage?.prompt_tokens_details?.cached_tokens || 0;
            } catch { /* keep raw */ }

            const { cost, priceSnapshot } = provider.estimateCostWithSnapshot(rule.mappedModel, inputTokens, outputTokens, cacheReadTokens, 0);
            recordUsage(provider.id, { inputTokens, outputTokens, cost });
            const durationMs = Date.now() - startTime;
            recordRequest({
                provider: provider.type, keyId: provider.id, mappingId: mapping.id,
                model: requestedModel, mappedModel: rule.mappedModel,
                inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens: 0,
                cost, priceSnapshot, durationMs, success: true
            });
            logRequest({
                route: '/v1/chat/completions', method: 'POST', provider: provider.type,
                providerName: provider.name, keyId: provider.id, mappingId: mapping.id,
                model: requestedModel, mappedModel: rule.mappedModel,
                requestBody: body, responseBody,
                inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens: 0,
                cost, priceSnapshot, durationMs, status: 200, success: true
            });
            logger.success(`[Gateway] OK ${provider.name} | ${requestedModel}→${rule.mappedModel} | ${inputTokens}+${outputTokens} | $${cost.toFixed(4)} | ${durationMs}ms`);

            res.status(200).type('json').send(responseBody);
            return;
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

async function _handleNonOk(upstream, provider) {
    const status = upstream.status;
    if (status === 429) {
        const retryAfter = upstream.headers?.get?.('retry-after');
        recordRateLimit(provider.id, retryAfter ? parseInt(retryAfter) * 1000 : 60000);
    } else {
        recordError(provider.id);
    }
    try {
        const text = await upstream.text();
        logger.warn(`[Gateway] ${provider.name} HTTP ${status}: ${text.slice(0, 200)}`);
    } catch { /* ignore */ }
}

function _wrapOpenAIJsonAsSSE(res, data) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const choice = data.choices?.[0];
    const msg = choice?.message || {};

    if (msg.content) {
        res.write(`data: ${JSON.stringify({
            id: data.id, object: 'chat.completion.chunk', created: data.created, model: data.model,
            choices: [{ index: 0, delta: { role: 'assistant', content: msg.content }, finish_reason: null }],
        })}\n\n`);
    }

    if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
            res.write(`data: ${JSON.stringify({
                id: data.id, object: 'chat.completion.chunk', created: data.created, model: data.model,
                choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: null }],
            })}\n\n`);
        }
    }

    res.write(`data: ${JSON.stringify({
        id: data.id, object: 'chat.completion.chunk', created: data.created, model: data.model,
        choices: [{ index: 0, delta: {}, finish_reason: choice?.finish_reason || 'stop' }],
        usage: data.usage,
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
}

export default { handleChatCompletion };
