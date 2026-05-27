/**
 * /v1/responses — OpenAI Responses API endpoint
 *
 * Converts Responses API format ↔ Chat Completions internally.
 * Supports streaming (real-time SSE conversion) and non-streaming.
 */

import { authenticateAndResolve } from '../sk-auth.js';
import { buildCandidates } from '../gateway-router.js';
import { recordUsage, recordError, recordRateLimit } from '../api-providers.js';
import { recordRequest } from '../usage-tracker.js';
import { logRequest } from '../request-logger.js';
import { openAIToAnthropicRequest, anthropicToOpenAIResponse } from '../providers/format-bridge.js';
import { cachedTokensFromUsage } from '../middleware/sse.js';
import { withAnthropicPromptCacheWarmup, withOpenAIPromptCacheKey, withPromptCacheWarmup } from '../prompt-cache-utils.js';
import { getCurrentSettings } from './settings-route.js';
import { applyAnthropicThinkingOptimization, applyOpenAIReasoningOptimization, describeOptimizerState, isCacheTtlOneHour, isOptimizerEnabled, mergeAnthropicBeta } from '../request-optimizer.js';
import { logger } from '../utils/logger.js';

function _uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ─── Request: Responses API → Chat Completions ───────────────────────────

function responsesToChat(body) {
    const messages = [];
    if (body.instructions) messages.push({ role: 'system', content: body.instructions });

    const input = body.input;
    if (typeof input === 'string') {
        messages.push({ role: 'user', content: input });
    } else if (Array.isArray(input)) {
        for (const item of input) {
            if (typeof item === 'string') { messages.push({ role: 'user', content: item }); continue; }
            if (item.type === 'function_call_output') {
                messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output || '' });
                continue;
            }
            if (item.type === 'function_call') {
                messages.push({
                    role: 'assistant', content: null,
                    tool_calls: [{ id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } }]
                });
                continue;
            }
            const role = item.role || 'user';
            if (role === 'system') { messages.push({ role: 'system', content: _text(item.content) }); continue; }
            if (role === 'tool') { messages.push({ role: 'tool', tool_call_id: item.tool_call_id, content: item.output || item.content || '' }); continue; }
            if (role === 'assistant' && item.content) {
                const text = _text(item.content);
                messages.push({ role: 'assistant', content: text || null });
                continue;
            }
            messages.push({ role, content: _text(item.content) });
        }
    }

    const out = { model: body.model, messages };
    if (body.max_output_tokens != null) out.max_tokens = body.max_output_tokens;
    if (body.temperature != null) out.temperature = body.temperature;
    if (body.top_p != null) out.top_p = body.top_p;
    if (body.stream != null) out.stream = body.stream;
    if (body.tools?.length) {
        out.tools = body.tools.filter(t => t.type === 'function').map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description || '', parameters: t.parameters || {}, ...(t.strict != null ? { strict: t.strict } : {}) }
        }));
    }
    if (body.tool_choice) {
        if (typeof body.tool_choice === 'string') out.tool_choice = body.tool_choice;
        else if (body.tool_choice.name) out.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
    }
    return out;
}

function _text(c) {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(p => p.text || '').join('');
    return '';
}

// ─── Response: Chat Completions → Responses API ──────────────────────────

function chatToResponses(data, model) {
    const choice = data.choices?.[0];
    const msg = choice?.message || {};
    const output = [];

    if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
            output.push({
                type: 'function_call', id: 'fc_' + _uid(), call_id: tc.id || 'call_' + _uid(),
                name: tc.function?.name || '', arguments: tc.function?.arguments || '{}', status: 'completed'
            });
        }
    }
    output.push({
        type: 'message', id: 'msg_' + _uid(), status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: msg.content || '' }]
    });

    const cachedTokens = cachedTokensFromUsage(data.usage);
    return {
        id: 'resp_' + _uid(), object: 'response',
        created_at: data.created || Math.floor(Date.now() / 1000),
        model: model || data.model, output,
        status: choice?.finish_reason === 'length' ? 'incomplete' : 'completed',
        usage: {
            input_tokens: data.usage?.prompt_tokens || 0,
            output_tokens: data.usage?.completion_tokens || 0,
            total_tokens: data.usage?.total_tokens || 0,
            input_tokens_details: { cached_tokens: cachedTokens },
        }
    };
}

// ─── Streaming: tap Chat Completions SSE → emit Responses API SSE ────────

async function tapChatToResponsesSSE(clientRes, upstream, model) {
    clientRes.setHeader('Content-Type', 'text/event-stream');
    clientRes.setHeader('Cache-Control', 'no-cache');
    clientRes.setHeader('Connection', 'keep-alive');
    clientRes.setHeader('X-Accel-Buffering', 'no');
    clientRes.flushHeaders();

    const sse = (ev, d) => clientRes.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
    const respId = 'resp_' + _uid();
    const msgId = 'msg_' + _uid();
    let started = false;
    let fullText = '';
    let inputTokens = 0, outputTokens = 0, cacheRead = 0;
    const tcs = new Map();
    let tcStarted = new Set();
    let finishReason = 'stop';
    let createdAt = Math.floor(Date.now() / 1000);

    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';

            for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith('data: ') || t === 'data: [DONE]') continue;
                let chunk;
                try { chunk = JSON.parse(t.slice(6)); } catch { continue; }

                if (chunk.created) createdAt = chunk.created;
                if (chunk.usage) {
                    inputTokens = chunk.usage.prompt_tokens || inputTokens;
                    outputTokens = chunk.usage.completion_tokens || outputTokens;
                    cacheRead = chunk.usage.prompt_tokens_details?.cached_tokens || cacheRead;
                }

                const choice = chunk.choices?.[0];
                const delta = choice?.delta;
                if (!delta && !choice?.finish_reason) continue;

                if (!started) {
                    started = true;
                    sse('response.created', {
                        type: 'response.created',
                        response: { id: respId, object: 'response', status: 'in_progress', model, output: [], created_at: createdAt }
                    });
                    sse('response.output_item.added', {
                        type: 'response.output_item.added', output_index: 0,
                        item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress', content: [] }
                    });
                    sse('response.content_part.added', {
                        type: 'response.content_part.added', output_index: 0, content_index: 0,
                        part: { type: 'output_text', text: '' }
                    });
                }

                if (delta?.content) {
                    fullText += delta.content;
                    sse('response.output_text.delta', {
                        type: 'response.output_text.delta', output_index: 0, content_index: 0,
                        delta: delta.content
                    });
                }

                if (delta?.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index ?? tcs.size;
                        if (!tcs.has(idx)) tcs.set(idx, { id: tc.id || '', name: '', arguments: '' });
                        const e = tcs.get(idx);
                        if (tc.id) e.id = tc.id;
                        if (tc.function?.name) e.name += tc.function.name;
                        if (tc.function?.arguments) {
                            e.arguments += tc.function.arguments;
                            if (!tcStarted.has(idx)) {
                                tcStarted.add(idx);
                                sse('response.output_item.added', {
                                    type: 'response.output_item.added', output_index: idx + 1,
                                    item: { type: 'function_call', id: 'fc_' + e.id, call_id: e.id, name: e.name, arguments: '', status: 'in_progress' }
                                });
                            }
                            sse('response.function_call_arguments.delta', {
                                type: 'response.function_call_arguments.delta', output_index: idx + 1,
                                delta: tc.function.arguments
                            });
                        }
                    }
                }

                if (choice?.finish_reason) finishReason = choice.finish_reason;
            }
        }
    } catch { /* stream error */ }

    if (!started) {
        const empty = { id: respId, object: 'response', status: 'completed', model, output: [], created_at: createdAt, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } } };
        sse('response.created', { type: 'response.created', response: empty });
        sse('response.completed', { type: 'response.completed', response: empty });
        clientRes.end();
        return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
    }

    sse('response.output_text.done', { type: 'response.output_text.done', output_index: 0, content_index: 0, text: fullText });
    sse('response.content_part.done', { type: 'response.content_part.done', output_index: 0, content_index: 0, part: { type: 'output_text', text: fullText } });
    const msgItem = { type: 'message', id: msgId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: fullText }] };
    sse('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: msgItem });

    const output = [msgItem];
    for (const [idx, tc] of tcs) {
        const item = { type: 'function_call', id: 'fc_' + tc.id, call_id: tc.id, name: tc.name, arguments: tc.arguments, status: 'completed' };
        sse('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: idx + 1, arguments: tc.arguments });
        sse('response.output_item.done', { type: 'response.output_item.done', output_index: idx + 1, item });
        output.push(item);
    }

    const status = finishReason === 'length' ? 'incomplete' : 'completed';
    const finalResp = {
        id: respId, object: 'response', status, model, output, created_at: createdAt,
        usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
            input_tokens_details: { cached_tokens: cacheRead },
        }
    };
    sse('response.completed', { type: 'response.completed', response: finalResp });
    clientRes.end();
    return { inputTokens, outputTokens, cacheReadTokens: cacheRead, cacheCreateTokens: 0 };
}

// ─── Wrap non-stream JSON as Responses SSE ───────────────────────────────

function emitResponsesSSE(res, respData) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sse = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
    sse('response.created', { type: 'response.created', response: { ...respData, status: 'in_progress', output: [] } });

    let oi = 0;
    for (const item of respData.output) {
        if (item.type === 'function_call') {
            sse('response.output_item.added', { type: 'response.output_item.added', output_index: oi, item: { ...item, status: 'in_progress', arguments: '' } });
            sse('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: oi, delta: item.arguments });
            sse('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: oi, arguments: item.arguments });
            sse('response.output_item.done', { type: 'response.output_item.done', output_index: oi, item });
        } else if (item.type === 'message') {
            sse('response.output_item.added', { type: 'response.output_item.added', output_index: oi, item: { ...item, status: 'in_progress', content: [] } });
            let ci = 0;
            for (const part of item.content || []) {
                sse('response.content_part.added', { type: 'response.content_part.added', output_index: oi, content_index: ci, part: { type: 'output_text', text: '' } });
                if (part.text) sse('response.output_text.delta', { type: 'response.output_text.delta', output_index: oi, content_index: ci, delta: part.text });
                sse('response.output_text.done', { type: 'response.output_text.done', output_index: oi, content_index: ci, text: part.text || '' });
                sse('response.content_part.done', { type: 'response.content_part.done', output_index: oi, content_index: ci, part });
                ci++;
            }
            sse('response.output_item.done', { type: 'response.output_item.done', output_index: oi, item });
        }
        oi++;
    }
    sse('response.completed', { type: 'response.completed', response: respData });
    res.end();
}

// ─── Streaming: native OpenAI Responses SSE passthrough ──────────────────
//
// When `supportsNativeResponses` is enabled on the provider, the upstream
// emits Responses-API-formatted SSE directly. We just pipe it byte-for-byte
// to the client while tapping `response.completed` (and `response.in_progress`
// usage events) to capture token + cache stats for cost recording.

async function tapOpenAIResponsesSSE(clientRes, upstream) {
    clientRes.setHeader('Content-Type', 'text/event-stream');
    clientRes.setHeader('Cache-Control', 'no-cache');
    clientRes.setHeader('Connection', 'keep-alive');
    clientRes.setHeader('X-Accel-Buffering', 'no');
    clientRes.flushHeaders();

    let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreate = 0;
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            // Forward raw bytes immediately — preserve upstream's exact framing
            clientRes.write(value);
            // Tap a copy for usage extraction
            buf += dec.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                const t = line.trim();
                if (!t.startsWith('data: ') || t === 'data: [DONE]') continue;
                let chunk;
                try { chunk = JSON.parse(t.slice(6)); } catch { continue; }
                // The upstream emits `response.completed` (and sometimes `response.in_progress`)
                // events whose payload includes the full response object with usage.
                const resp = chunk.response || chunk;
                const u = resp?.usage;
                if (u) {
                    if (u.input_tokens != null) inputTokens = u.input_tokens;
                    if (u.prompt_tokens != null) inputTokens = u.prompt_tokens;
                    if (u.output_tokens != null) outputTokens = u.output_tokens;
                    if (u.completion_tokens != null) outputTokens = u.completion_tokens;
                    cacheRead = cachedTokensFromUsage(u);
                    // Some upstreams may surface cache-create separately; tolerate missing field
                    if (u.cache_creation_input_tokens != null) cacheCreate = u.cache_creation_input_tokens;
                }
            }
        }
    } catch { /* stream error — upstream closed, we already forwarded what we got */ }
    clientRes.end();
    return { inputTokens, outputTokens, cacheReadTokens: cacheRead, cacheCreateTokens: cacheCreate };
}

// ─── Route handler ───────────────────────────────────────────────────────

function responseFromText(upstream, text) {
    return new Response(text, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: {
            'Content-Type': upstream.headers?.get?.('content-type') || 'text/plain'
        }
    });
}

function isUnsupportedCacheHintError(text) {
    return /prompt_cache_key|prompt_cache_retention|unknown parameter|unsupported|unrecognized/i.test(text || '');
}

async function _sendNativeResponsesWithCacheHints(provider, body, context) {
    const prepared = withOpenAIPromptCacheKey(body, context);
    return withPromptCacheWarmup(
        prepared.promptCacheKey,
        () => _sendNativeResponsesPrepared(provider, prepared)
    );
}

async function _sendNativeResponsesPrepared(provider, prepared) {
    const upstream = await provider.sendResponsesRequest(prepared.body);
    if (upstream.ok || (!prepared.added && !prepared.addedRetention) || upstream.status !== 400) {
        return upstream;
    }

    const text = await upstream.text();
    if (!isUnsupportedCacheHintError(text)) {
        return responseFromText(upstream, text);
    }

    if (prepared.body.prompt_cache_retention && /prompt_cache_retention/i.test(text)) {
        const retryWithoutRetention = { ...prepared.body };
        delete retryWithoutRetention.prompt_cache_retention;
        const retry = await provider.sendResponsesRequest(retryWithoutRetention);
        if (retry.ok || retry.status !== 400) return retry;

        const retryText = await retry.text();
        if (!isUnsupportedCacheHintError(retryText)) {
            return responseFromText(retry, retryText);
        }
    }

    const retryWithoutCacheKey = { ...prepared.body };
    delete retryWithoutCacheKey.prompt_cache_key;
    delete retryWithoutCacheKey.prompt_cache_retention;
    return provider.sendResponsesRequest(retryWithoutCacheKey);
}

async function _sendOpenAIChatWithCacheHints(provider, body, context) {
    const prepared = withOpenAIPromptCacheKey(body, context);
    return withPromptCacheWarmup(
        prepared.promptCacheKey,
        () => _sendOpenAIChatPrepared(provider, prepared)
    );
}

async function _sendOpenAIChatPrepared(provider, prepared) {
    const upstream = await provider.sendRequest(prepared.body);
    if (upstream.ok || (!prepared.added && !prepared.addedRetention) || upstream.status !== 400) {
        return upstream;
    }

    const text = await upstream.text();
    if (!isUnsupportedCacheHintError(text)) {
        return responseFromText(upstream, text);
    }

    if (prepared.body.prompt_cache_retention && /prompt_cache_retention/i.test(text)) {
        const retryWithoutRetention = { ...prepared.body };
        delete retryWithoutRetention.prompt_cache_retention;
        const retry = await provider.sendRequest(retryWithoutRetention);
        if (retry.ok || retry.status !== 400) return retry;

        const retryText = await retry.text();
        if (!isUnsupportedCacheHintError(retryText)) {
            return responseFromText(retry, retryText);
        }
    }

    const retryWithoutCacheKey = { ...prepared.body };
    delete retryWithoutCacheKey.prompt_cache_key;
    delete retryWithoutCacheKey.prompt_cache_retention;
    return provider.sendRequest(retryWithoutCacheKey);
}

export async function handleResponses(req, res) {
    const startTime = Date.now();
    const mapping = authenticateAndResolve(req, res);
    if (!mapping) return;

    const body = req.body || {};
    const requestedModel = body.model || '';
    const isStreaming = body.stream !== false;
    const settings = getCurrentSettings();
    const cacheTtl = isOptimizerEnabled(settings) && settings.bedrockOptimizer?.cacheInjection && isCacheTtlOneHour(settings) ? '1h' : undefined;
    const chatBody = responsesToChat(body);

    const candidates = buildCandidates(mapping, requestedModel, 3);
    if (candidates.length === 0) {
        return res.status(404).json({ error: { type: 'invalid_request_error', message: `No enabled rule matches model "${requestedModel}" in mapping "${mapping.name}".` } });
    }

    let lastErr = null;
    // 透传 client 的 anthropic-beta header(例:1h TTL = extended-cache-ttl-2025-04-11)
    // 仅对 anthropic 上游有效;openai 上游不识别此 header,直接忽略
    const anthropicBeta = mergeAnthropicBeta(req.headers['anthropic-beta'], settings);
    const extraHeaders = anthropicBeta ? { 'anthropic-beta': anthropicBeta } : {};
    for (const { rule, provider } of candidates) {
        try {
            const upstreamBody = { ...chatBody, model: rule.mappedModel };
            logger.info(`[Gateway] /v1/responses | ${mapping.name} | ${provider.name} (${provider.type}) | ${requestedModel} → ${rule.mappedModel}`);

            if (provider.type === 'anthropic') {
                const anthropicBody = openAIToAnthropicRequest(upstreamBody, { settings, cacheTtl });
                anthropicBody.stream = false;
                const upstream = await withAnthropicPromptCacheWarmup(
                    anthropicBody,
                    { mappedModel: rule.mappedModel },
                    () => provider.sendRequest(anthropicBody, { extraHeaders })
                );
                if (!upstream.ok) { await _handleNonOk(upstream, provider); lastErr = new Error(`Provider returned ${upstream.status}`); continue; }
                const anthropicData = await upstream.json();
                const chatData = anthropicToOpenAIResponse(anthropicData, rule.mappedModel);
                const respData = chatToResponses(chatData, rule.mappedModel);
                const inputTokens = anthropicData.usage?.input_tokens || 0;
                const outputTokens = anthropicData.usage?.output_tokens || 0;
                const cacheReadTokens = anthropicData.usage?.cache_read_input_tokens || 0;
                const cacheCreateTokens = anthropicData.usage?.cache_creation_input_tokens || 0;
                const { cost, priceSnapshot } = provider.estimateCostWithSnapshot(rule.mappedModel, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens);
                _record(provider, mapping, rule, requestedModel, body, respData, { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, cost, priceSnapshot }, startTime, anthropicBody);
                if (isStreaming) { emitResponsesSSE(res, respData); } else { res.json(respData); }
                return;
            }

            // OpenAI provider
            //
            // ── Native Responses passthrough (fast path) ─────────────────
            // When the provider has `supportsNativeResponses` enabled, we
            // skip the Responses→Chat→Responses transform entirely and
            // forward the client's original Responses API body straight to
            // the upstream's /responses endpoint. This preserves:
            //   - `previous_response_id` (server-side conversation chaining)
            //   - `store: true` semantics (upstream keeps response on disk)
            //   - `reasoning` blocks and tool-call IDs
            //   - any other fields Chat Completions silently drops
            // The upstream can then do server-side prompt caching against
            // its persisted state — typically a 40-80% cache-hit improvement
            // on long agentic conversations (Codex CLI being the main user).
            if (provider.supportsNativeResponses) {
                const nativeBody = provider.supportsNativeResponses === 'reasoning'
                    ? applyOpenAIReasoningOptimization({ ...body, model: rule.mappedModel }, settings)
                    : { ...body, model: rule.mappedModel };
                const upstream = await _sendNativeResponsesWithCacheHints(provider, nativeBody, {
                    mappedModel: rule.mappedModel,
                    promptCacheRetention: cacheTtl
                });
                if (!upstream.ok) { await _handleNonOk(upstream, provider); lastErr = new Error(`Provider returned ${upstream.status}`); continue; }
                const ct = upstream.headers?.get?.('content-type') || '';
                if (isStreaming && ct.includes('text/event-stream')) {
                    const usage = await tapOpenAIResponsesSSE(res, upstream);
                    const { cost, priceSnapshot } = provider.estimateCostWithSnapshot(rule.mappedModel, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreateTokens);
                    _record(provider, mapping, rule, requestedModel, body, null, { ...usage, cost, priceSnapshot }, startTime, nativeBody);
                    return;
                }
                // Non-stream (or upstream returned JSON): pass response object through
                const respData = await upstream.json();
                const it = respData.usage?.input_tokens || 0;
                const ot = respData.usage?.output_tokens || 0;
                const cr = cachedTokensFromUsage(respData.usage);
                const { cost, priceSnapshot } = provider.estimateCostWithSnapshot(rule.mappedModel, it, ot, cr, 0);
                _record(provider, mapping, rule, requestedModel, body, respData, { inputTokens: it, outputTokens: ot, cacheReadTokens: cr, cacheCreateTokens: 0, cost, priceSnapshot }, startTime, nativeBody);
                if (isStreaming) { emitResponsesSSE(res, respData); } else { res.json(respData); }
                return;
            }

            // Chat Completions transform path (default — works for any OpenAI-compat upstream)
            if (isStreaming) {
                upstreamBody.stream = true;
                upstreamBody.stream_options = { ...(chatBody.stream_options || {}), include_usage: true };
                const upstream = await _sendOpenAIChatWithCacheHints(provider, upstreamBody, {
                    mappedModel: rule.mappedModel,
                    promptCacheRetention: cacheTtl
                });
                if (!upstream.ok) { await _handleNonOk(upstream, provider); lastErr = new Error(`Provider returned ${upstream.status}`); continue; }
                const ct = upstream.headers?.get?.('content-type') || '';
                if (ct.includes('text/event-stream')) {
                    const usage = await tapChatToResponsesSSE(res, upstream, rule.mappedModel);
                    const { cost, priceSnapshot } = provider.estimateCostWithSnapshot(rule.mappedModel, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreateTokens);
                    _record(provider, mapping, rule, requestedModel, body, null, { ...usage, cost, priceSnapshot }, startTime, upstreamBody);
                    return;
                }
                const chatData = await upstream.json();
                const respData = chatToResponses(chatData, rule.mappedModel);
                const it = chatData.usage?.prompt_tokens || chatData.usage?.input_tokens || 0, ot = chatData.usage?.completion_tokens || chatData.usage?.output_tokens || 0;
                const cr = cachedTokensFromUsage(chatData.usage);
                const { cost, priceSnapshot } = provider.estimateCostWithSnapshot(rule.mappedModel, it, ot, cr, 0);
                _record(provider, mapping, rule, requestedModel, body, respData, { inputTokens: it, outputTokens: ot, cacheReadTokens: cr, cacheCreateTokens: 0, cost, priceSnapshot }, startTime, upstreamBody);
                emitResponsesSSE(res, respData);
                return;
            }

            // Non-streaming (transform path)
            upstreamBody.stream = false;
            const upstream = await _sendOpenAIChatWithCacheHints(provider, upstreamBody, {
                mappedModel: rule.mappedModel,
                promptCacheRetention: cacheTtl
            });
            if (!upstream.ok) { await _handleNonOk(upstream, provider); lastErr = new Error(`Provider returned ${upstream.status}`); continue; }
            const ct = upstream.headers?.get?.('content-type') || '';
            let chatData;
            if (ct.includes('text/event-stream')) {
                chatData = await _collectSSE(upstream);
            } else {
                chatData = await upstream.json();
            }
            const respData = chatToResponses(chatData, rule.mappedModel);
            const it = chatData.usage?.prompt_tokens || chatData.usage?.input_tokens || 0, ot = chatData.usage?.completion_tokens || chatData.usage?.output_tokens || 0;
            const cr = cachedTokensFromUsage(chatData.usage);
            const { cost, priceSnapshot } = provider.estimateCostWithSnapshot(rule.mappedModel, it, ot, cr, 0);
            _record(provider, mapping, rule, requestedModel, body, respData, { inputTokens: it, outputTokens: ot, cacheReadTokens: cr, cacheCreateTokens: 0, cost, priceSnapshot }, startTime, upstreamBody);
            res.json(respData);
            return;
        } catch (err) {
            recordError(provider.id);
            logger.error(`[Gateway] ${provider.name} failed: ${err.message}`);
            lastErr = err;
            continue;
        }
    }

    return res.status(503).json({ error: { type: 'service_unavailable', message: `All providers exhausted for model "${requestedModel}". Last: ${lastErr?.message || 'unknown'}` } });
}

function _record(provider, mapping, rule, requestedModel, reqBody, respBody, u, startTime, upstreamBody = null) {
    const durationMs = Date.now() - startTime;
    recordUsage(provider.id, { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cost: u.cost, cacheReadTokens: u.cacheReadTokens, cacheCreateTokens: u.cacheCreateTokens });
    recordRequest({
        provider: provider.type, keyId: provider.id, mappingId: mapping.id,
        model: requestedModel, mappedModel: rule.mappedModel,
        inputTokens: u.inputTokens, outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens, cacheCreateTokens: u.cacheCreateTokens,
        cost: u.cost, priceSnapshot: u.priceSnapshot, durationMs, success: true
    });
    logRequest({
        route: '/v1/responses', method: 'POST', provider: provider.type,
        providerName: provider.name, keyId: provider.id, mappingId: mapping.id,
        model: requestedModel, mappedModel: rule.mappedModel,
        requestBody: reqBody, responseBody: respBody,
        inputTokens: u.inputTokens, outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens, cacheCreateTokens: u.cacheCreateTokens,
        cost: u.cost, priceSnapshot: u.priceSnapshot, durationMs, status: 200, success: true,
        ...describeOptimizerState(reqBody, upstreamBody)
    });
    logger.success(`[Gateway] OK ${provider.name} | ${requestedModel}→${rule.mappedModel} | ${u.inputTokens}+${u.outputTokens} | $${u.cost.toFixed(4)} | ${durationMs}ms`);
}

async function _handleNonOk(upstream, provider) {
    const status = upstream.status;
    if (status === 429) {
        const ra = upstream.headers?.get?.('retry-after');
        recordRateLimit(provider.id, ra ? parseInt(ra) * 1000 : 60000);
    } else { recordError(provider.id); }
    try { const t = await upstream.text(); logger.warn(`[Gateway] ${provider.name} HTTP ${status}: ${t.slice(0, 200)}`); } catch {}
}

async function _collectSSE(upstream) {
    const text = await upstream.text();
    let content = '', role = 'assistant', fr = 'stop', usage = null, id = '', model = '';
    const tcs = new Map();
    for (const line of text.split('\n')) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        let c; try { c = JSON.parse(line.slice(6)); } catch { continue; }
        if (!id && c.id) id = c.id;
        if (!model && c.model) model = c.model;
        if (c.usage) usage = c.usage;
        const d = c.choices?.[0]?.delta;
        if (d?.content) content += d.content;
        if (c.choices?.[0]?.finish_reason) fr = c.choices[0].finish_reason;
        if (d?.tool_calls) {
            for (const tc of d.tool_calls) {
                const idx = tc.index ?? tcs.size;
                if (!tcs.has(idx)) tcs.set(idx, { id: '', type: 'function', function: { name: '', arguments: '' } });
                const e = tcs.get(idx);
                if (tc.id) e.id = tc.id;
                if (tc.function?.name) e.function.name += tc.function.name;
                if (tc.function?.arguments) e.function.arguments += tc.function.arguments;
            }
        }
    }
    const message = { role, content: content || null };
    if (tcs.size) message.tool_calls = [...tcs.values()];
    return {
        id: id || `chatcmpl-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message, finish_reason: fr }],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
}

export default { handleResponses };
