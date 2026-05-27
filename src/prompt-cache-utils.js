/**
 * Prompt cache helpers.
 *
 * Anthropic caching is prefix based, so stable prompt sections need stable
 * ordering and explicit breakpoints. OpenAI prompt_cache_key is a routing hint,
 * so it should be derived from the shared prefix, not the per-turn question.
 */

import crypto from 'crypto';

const MAX_ANTHROPIC_BREAKPOINTS = 4;
const MIN_OPENAI_CACHE_KEY_PREFIX_CHARS = 512;
const OPENAI_CACHE_KEY_TEXT_PREFIX_CHARS = Number.parseInt(process.env.AGH_PROMPT_CACHE_KEY_PREFIX_CHARS || '32768', 10);
const PROMPT_CACHE_WARMUP_HOLD_MS = Number.parseInt(process.env.AGH_PROMPT_CACHE_WARMUP_HOLD_MS || '5000', 10);
const promptCacheWarmups = new Map();

function cloneJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function cacheControl(options = {}) {
    const out = { type: 'ephemeral' };
    if (options.cacheTtl) out.ttl = options.cacheTtl;
    return out;
}

export function hasCacheControl(value) {
    if (!value || typeof value !== 'object') return false;
    if (Object.prototype.hasOwnProperty.call(value, 'cache_control')) return true;
    if (Array.isArray(value)) return value.some(hasCacheControl);
    return Object.values(value).some(hasCacheControl);
}

function countCacheControl(value) {
    if (!value || typeof value !== 'object') return 0;
    let total = Object.prototype.hasOwnProperty.call(value, 'cache_control') ? 1 : 0;
    if (Array.isArray(value)) {
        for (const item of value) total += countCacheControl(item);
        return total;
    }
    for (const item of Object.values(value)) total += countCacheControl(item);
    return total;
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sortPrimitiveArray(value) {
    return [...value].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function canonicalizeJson(value, key = '') {
    if (Array.isArray(value)) {
        const normalized = value.map((item) => canonicalizeJson(item));
        if (['required', 'enum', 'type'].includes(key)
            && normalized.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))) {
            return sortPrimitiveArray(normalized);
        }
        return normalized;
    }

    if (!isPlainObject(value)) return value;

    const out = {};
    for (const childKey of Object.keys(value).sort()) {
        const child = value[childKey];
        if (child !== undefined) out[childKey] = canonicalizeJson(child, childKey);
    }
    return out;
}

function stableStringify(value) {
    return JSON.stringify(canonicalizeJson(value));
}

function stableTextPrefix(value) {
    if (!value) return '';
    const text = typeof value === 'string' ? value : stableStringify(value);
    const maxChars = Number.isFinite(OPENAI_CACHE_KEY_TEXT_PREFIX_CHARS)
        ? Math.max(MIN_OPENAI_CACHE_KEY_PREFIX_CHARS, OPENAI_CACHE_KEY_TEXT_PREFIX_CHARS)
        : 32768;
    return text.length > maxChars ? text.slice(0, maxChars) : text;
}

export function normalizeAnthropicTools(tools) {
    if (!Array.isArray(tools)) return tools;
    return tools
        .map((tool) => canonicalizeJson(tool))
        .sort((a, b) => {
            const aName = a?.name || a?.type || '';
            const bName = b?.name || b?.type || '';
            const byName = aName.localeCompare(bName);
            return byName !== 0 ? byName : stableStringify(a).localeCompare(stableStringify(b));
        });
}

function markSystem(system, options = {}) {
    if (typeof system === 'string') {
        if (!system.trim()) return { marked: false, system };
        return {
            marked: true,
            system: [{ type: 'text', text: system, cache_control: cacheControl(options) }]
        };
    }

    if (!Array.isArray(system) || system.length === 0) {
        return { marked: false, system };
    }

    if (hasCacheControl(system)) return { marked: false, system };

    for (let i = system.length - 1; i >= 0; i--) {
        const block = system[i];
        if (!block || typeof block !== 'object') continue;
        block.cache_control = cacheControl(options);
        return { marked: true, system };
    }

    return { marked: false, system };
}

function hasMarkableContent(content) {
    if (typeof content === 'string') return content.length > 0;
    if (!Array.isArray(content)) return false;
    return content.some((block) => block && typeof block === 'object');
}

function markMessageContent(message, options = {}) {
    if (!message || typeof message !== 'object') return false;
    if (hasCacheControl(message.content)) return false;

    if (typeof message.content === 'string') {
        if (!message.content.length) return false;
        message.content = [{ type: 'text', text: message.content, cache_control: cacheControl(options) }];
        return true;
    }

    if (!Array.isArray(message.content)) return false;

    for (let i = message.content.length - 1; i >= 0; i--) {
        const block = message.content[i];
        if (!block || typeof block !== 'object') continue;
        block.cache_control = cacheControl(options);
        return true;
    }

    return false;
}

function recentUserMessageIndexes(messages) {
    if (!Array.isArray(messages)) return [];
    const userIndexes = [];
    messages.forEach((message, index) => {
        if (message?.role === 'user' && hasMarkableContent(message.content)) {
            userIndexes.push(index);
        }
    });

    // Single-turn prompts usually vary in the first user message; the system
    // breakpoint handles the shared prefix without paying a write for the suffix.
    if (userIndexes.length < 2) return [];
    return userIndexes.slice(-2);
}

export function optimizeAnthropicPromptCaching(body, options = {}) {
    const out = cloneJson(body || {});
    const markerOptions = { cacheTtl: options.cacheTtl };
    if (Array.isArray(out.tools)) out.tools = normalizeAnthropicTools(out.tools);

    let added = 0;
    const existing = countCacheControl(out);

    if (existing + added < MAX_ANTHROPIC_BREAKPOINTS && out.system) {
        const result = markSystem(out.system, markerOptions);
        out.system = result.system;
        if (result.marked) added++;
    }

    for (const index of recentUserMessageIndexes(out.messages)) {
        if (existing + added >= MAX_ANTHROPIC_BREAKPOINTS) break;
        if (markMessageContent(out.messages[index], markerOptions)) added++;
    }

    return {
        body: out,
        injected: added > 0,
        breakpoints: countCacheControl(out),
        addedBreakpoints: added
    };
}

function stripCacheControl(value) {
    if (Array.isArray(value)) return value.map(stripCacheControl);
    if (!isPlainObject(value)) return value;

    const out = {};
    for (const key of Object.keys(value).sort()) {
        if (key === 'cache_control') continue;
        const child = value[key];
        if (child !== undefined) out[key] = stripCacheControl(child);
    }
    return out;
}

function messagesThroughLastCacheControl(messages) {
    if (!Array.isArray(messages)) return [];

    let lastIndex = -1;
    messages.forEach((message, index) => {
        if (hasCacheControl(message?.content)) lastIndex = index;
    });
    return lastIndex >= 0 ? messages.slice(0, lastIndex + 1) : [];
}

export function deriveAnthropicPromptCacheWarmupKey(body, context = {}) {
    if (!body || typeof body !== 'object') return null;
    const prefixMessages = messagesThroughLastCacheControl(body.messages);
    const hasSystemBreakpoint = hasCacheControl(body.system);
    if (!hasSystemBreakpoint && prefixMessages.length === 0) return null;

    const seed = {
        model: context.mappedModel || body.model || '',
        tools: Array.isArray(body.tools) ? normalizeAnthropicTools(body.tools) : [],
        system: body.system ? stripCacheControl(body.system) : null,
        messages: stripCacheControl(prefixMessages)
    };
    const serialized = stableStringify(seed);
    if (serialized.length < MIN_OPENAI_CACHE_KEY_PREFIX_CHARS) return null;

    const hash = crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 32);
    return `agh_anth_${hash}`;
}

export function withAnthropicPromptCacheWarmup(body, context, producer, options = {}) {
    return withPromptCacheWarmup(
        deriveAnthropicPromptCacheWarmupKey(body, context),
        producer,
        options
    );
}

function contentText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((part) => {
        if (typeof part === 'string') return part;
        if (part?.text) return part.text;
        if (part?.type === 'input_text' && part.text) return part.text;
        return '';
    }).join('');
}

function collectOpenAISystemInput(input) {
    if (!Array.isArray(input)) return '';
    return input
        .filter((item) => item && ['system', 'developer'].includes(item.role))
        .map((item) => contentText(item.content))
        .filter(Boolean)
        .join('\n');
}

function collectOpenAIChatSystem(messages) {
    if (!Array.isArray(messages)) return '';
    return messages
        .filter((message) => message && ['system', 'developer'].includes(message.role))
        .map((message) => contentText(message.content))
        .filter(Boolean)
        .join('\n');
}

export function deriveOpenAIPromptCacheKey(body, context = {}) {
    const rawInstructions = typeof body?.instructions === 'string'
        ? body.instructions
        : body?.instructions
            ? stableStringify(body.instructions)
            : '';
    const rawSystemInput = collectOpenAISystemInput(body?.input);
    const rawChatSystem = collectOpenAIChatSystem(body?.messages);
    const tools = Array.isArray(body?.tools) ? canonicalizeJson(body.tools) : [];
    const stablePrefixSize = rawInstructions.length
        + rawSystemInput.length
        + rawChatSystem.length
        + stableStringify(tools).length;

    if (stablePrefixSize < MIN_OPENAI_CACHE_KEY_PREFIX_CHARS) return null;

    const seed = stableStringify({
        model: context.mappedModel || body?.model || '',
        instructions: stableTextPrefix(rawInstructions),
        systemInput: stableTextPrefix(rawSystemInput),
        chatSystem: stableTextPrefix(rawChatSystem),
        tools
    });
    const hash = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
    return `agh_${hash}`;
}

export function withOpenAIPromptCacheKey(body, context = {}) {
    const out = cloneJson(body || {});
    const retention = context.promptCacheRetention;

    if (out.prompt_cache_key) {
        if (retention && !out.prompt_cache_retention) {
            out.prompt_cache_retention = retention;
        }
        return {
            body: out,
            added: false,
            addedRetention: !!(retention && !body?.prompt_cache_retention),
            promptCacheKey: out.prompt_cache_key
        };
    }

    const promptCacheKey = deriveOpenAIPromptCacheKey(out, context);
    if (!promptCacheKey) {
        return { body: out, added: false, promptCacheKey: null };
    }

    out.prompt_cache_key = promptCacheKey;
    if (retention && !out.prompt_cache_retention) {
        out.prompt_cache_retention = retention;
    }
    return {
        body: out,
        added: true,
        addedRetention: !!retention,
        promptCacheKey
    };
}

function responseWithWarmupRelease(response, releaseWarmup) {
    if (!response?.body || typeof response.body.getReader !== 'function') {
        releaseWarmup();
        return response;
    }

    let released = false;
    const releaseOnce = () => {
        if (released) return;
        released = true;
        releaseWarmup();
    };
    const reader = response.body.getReader();
    const body = new ReadableStream({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    releaseOnce();
                    controller.close();
                    return;
                }
                controller.enqueue(value);
            } catch (error) {
                releaseOnce();
                controller.error(error);
            }
        },
        async cancel(reason) {
            releaseOnce();
            return reader.cancel(reason);
        }
    });

    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
    });
}

export async function withPromptCacheWarmup(cacheKey, producer, options = {}) {
    if (!cacheKey) return producer();

    const existing = promptCacheWarmups.get(cacheKey);
    if (existing) {
        await existing;
        return producer();
    }

    const configuredHoldMs = Number.isFinite(options.holdMs)
        ? options.holdMs
        : PROMPT_CACHE_WARMUP_HOLD_MS;
    const holdMs = Math.max(0, configuredHoldMs || 0);
    let resolveWarmup;
    const warmup = new Promise((resolve) => {
        resolveWarmup = resolve;
    });
    promptCacheWarmups.set(cacheKey, warmup);

    const releaseWarmup = () => {
        const done = () => {
            if (promptCacheWarmups.get(cacheKey) === warmup) {
                promptCacheWarmups.delete(cacheKey);
            }
            resolveWarmup();
        };
        if (holdMs > 0) {
            const timer = setTimeout(done, holdMs);
            timer.unref?.();
        } else {
            done();
        }
    };

    try {
        const result = await producer();
        if (typeof Response !== 'undefined' && result instanceof Response) {
            return responseWithWarmupRelease(result, releaseWarmup);
        }
        releaseWarmup();
        return result;
    } catch (error) {
        if (promptCacheWarmups.get(cacheKey) === warmup) {
            promptCacheWarmups.delete(cacheKey);
        }
        resolveWarmup();
        throw error;
    }
}

export default {
    canonicalizeJson,
    deriveAnthropicPromptCacheWarmupKey,
    deriveOpenAIPromptCacheKey,
    hasCacheControl,
    normalizeAnthropicTools,
    optimizeAnthropicPromptCaching,
    withAnthropicPromptCacheWarmup,
    withOpenAIPromptCacheKey,
    withPromptCacheWarmup
};
