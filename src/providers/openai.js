/**
 * OpenAI Provider
 *
 * Sends requests to any OpenAI-compatible endpoint (OpenAI proper, third-party
 * relays, local Ollama with /v1 shim, etc.). Supports both:
 *   - native OpenAI Chat Completions input → OpenAI Chat output
 *   - Anthropic Messages input → translated to OpenAI Chat → response
 *     translated back to Anthropic Messages
 */

import { BaseProvider } from './base.js';
import { anthropicToOpenAI, openAIToAnthropic } from './format-bridge.js';
import { estimateCost, estimateCostWithSnapshot } from '../pricing-registry.js';
import { withOpenAIPromptCacheKey, withPromptCacheWarmup } from '../prompt-cache-utils.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class OpenAIProvider extends BaseProvider {
    constructor(config) {
        super({
            ...config,
            type: 'openai',
            baseUrl: config.baseUrl || DEFAULT_BASE_URL
        });
    }

    /**
     * Send an OpenAI Chat Completions request to the upstream.
     * Returns the raw fetch Response (caller decides how to consume).
     */
    async sendRequest(body, { extraHeaders = {}, signal } = {}) {
        const url = `${this.baseUrl}/chat/completions`;
        return fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
                ...extraHeaders
            },
            body: JSON.stringify(body),
            signal
        });
    }

    /**
     * Send a native OpenAI Responses API request. Used by the /v1/responses
     * route when this provider has `supportsNativeResponses` enabled — this
     * preserves `previous_response_id`, `store`, `reasoning`, etc., which
     * would be silently dropped by the Chat Completions transform path and
     * which the upstream needs for server-side prompt caching (~40-80% hit
     * rate improvement on long agentic conversations vs flattened context).
     */
    async sendResponsesRequest(body, { extraHeaders = {}, signal } = {}) {
        const url = `${this.baseUrl}/responses`;
        return fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
                ...extraHeaders
            },
            body: JSON.stringify(body),
            signal
        });
    }

    /**
     * Accept an Anthropic Messages body, translate to OpenAI Chat Completions,
     * forward, then translate the response back to Anthropic Messages.
     * Streaming is NOT supported on this path (caller should set stream: false
     * or handle non-stream response).
     */
    async sendAnthropicRequest(body, { signal, promptCacheRetention, onPreparedBody } = {}) {
        const openaiBody = anthropicToOpenAI(body);
        openaiBody.stream = true;
        openaiBody.stream_options = { include_usage: true };
        const upstream = await _sendOpenAIChatWithCacheHints(this, openaiBody, {
            mappedModel: body.model,
            promptCacheRetention,
            signal,
            onPreparedBody
        });
        if (!upstream.ok) return upstream;

        const ct = upstream.headers?.get?.('content-type') || '';
        let data;
        if (ct.includes('text/event-stream')) {
            data = await _collectOpenAISSE(upstream);
        } else {
            data = await upstream.json();
        }
        const anthropicResponse = openAIToAnthropic(data, body.model);
        return new Response(JSON.stringify(anthropicResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async listModels() {
        try {
            const response = await fetch(`${this.baseUrl}/models`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` }
            });
            if (!response.ok) return [];
            const data = await response.json();
            return (data.data || []).map(m => ({
                id: m.id,
                name: m.id
            }));
        } catch {
            return [];
        }
    }

    async validateKey() {
        try {
            const response = await fetch(`${this.baseUrl}/models`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` }
            });
            // 401/403 = bad key. Anything else (2xx, 404 if proxy lacks /models, etc.) = key worked.
            return response.status !== 401 && response.status !== 403;
        } catch {
            return false;
        }
    }

    estimateCost(model, inputTokens, outputTokens, cacheReadTokens = 0, cacheCreateTokens = 0) {
        return estimateCost(this.type, model, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens);
    }

    estimateCostWithSnapshot(model, inputTokens, outputTokens, cacheReadTokens = 0, cacheCreateTokens = 0) {
        return estimateCostWithSnapshot(this.type, model, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens);
    }
}

export default OpenAIProvider;

function _responseFromText(upstream, text) {
    return new Response(text, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: {
            'Content-Type': upstream.headers?.get?.('content-type') || 'text/plain'
        }
    });
}

function _isUnsupportedCacheHintError(text) {
    return /prompt_cache_key|prompt_cache_retention|unknown parameter|unsupported|unrecognized/i.test(text || '');
}

async function _sendOpenAIChatWithCacheHints(provider, body, context = {}) {
    const prepared = withOpenAIPromptCacheKey(body, context);
    context.onPreparedBody?.(prepared.body, prepared);
    return withPromptCacheWarmup(
        prepared.promptCacheKey,
        () => _sendOpenAIChatPrepared(provider, prepared, context.signal)
    );
}

async function _sendOpenAIChatPrepared(provider, prepared, signal) {
    const upstream = await provider.sendRequest(prepared.body, { signal });
    if (upstream.ok || (!prepared.added && !prepared.addedRetention) || upstream.status !== 400) {
        return upstream;
    }

    const text = await upstream.text();
    if (!_isUnsupportedCacheHintError(text)) {
        return _responseFromText(upstream, text);
    }

    if (prepared.body.prompt_cache_retention && /prompt_cache_retention/i.test(text)) {
        const retryWithoutRetention = { ...prepared.body };
        delete retryWithoutRetention.prompt_cache_retention;
        const retry = await provider.sendRequest(retryWithoutRetention, { signal });
        if (retry.ok || retry.status !== 400) return retry;

        const retryText = await retry.text();
        if (!_isUnsupportedCacheHintError(retryText)) {
            return _responseFromText(retry, retryText);
        }
    }

    const retryWithoutCacheKey = { ...prepared.body };
    delete retryWithoutCacheKey.prompt_cache_key;
    delete retryWithoutCacheKey.prompt_cache_retention;
    return provider.sendRequest(retryWithoutCacheKey, { signal });
}

async function _collectOpenAISSE(upstream) {
    const text = await upstream.text();
    let content = '';
    let role = 'assistant';
    let finishReason = 'stop';
    const toolCalls = new Map();
    let usage = null;
    let id = '';
    let model = '';

    for (const line of text.split('\n')) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(line.slice(6)); } catch { continue; }
        if (!id && chunk.id) id = chunk.id;
        if (!model && chunk.model) model = chunk.model;
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.role) role = delta.role;
        if (delta.content) content += delta.content;
        if (chunk.choices[0].finish_reason) finishReason = chunk.choices[0].finish_reason;
        if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
                const idx = tc.index ?? toolCalls.size;
                if (!toolCalls.has(idx)) toolCalls.set(idx, { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } });
                const entry = toolCalls.get(idx);
                if (tc.id) entry.id = tc.id;
                if (tc.function?.name) entry.function.name += tc.function.name;
                if (tc.function?.arguments) entry.function.arguments += tc.function.arguments;
            }
        }
    }

    const message = { role, content: content || null };
    if (toolCalls.size) message.tool_calls = [...toolCalls.values()];

    return {
        id: id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
}
