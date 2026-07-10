import crypto from 'crypto';

const ONE_HOUR_CACHE_BETA = 'extended-cache-ttl-2025-04-11';
const DEFAULT_THINKING_BUDGET = 16000;
const DIAGNOSTIC_PREFIX_CHARS = 32768;
const CLAUDE_CODE_ATTRIBUTION_RE = /^x-anthropic-billing-header:\s*cc_version=[^\n]*\n\s*/;

export function isOptimizerEnabled(settings) {
    return settings?.bedrockOptimizer?.enabled !== false;
}

export function isCacheTtlOneHour(settings) {
    return settings?.bedrockOptimizer?.cacheTtl === '1h';
}

export function mergeAnthropicBeta(existing, settings) {
    if (!isOptimizerEnabled(settings) || !isCacheTtlOneHour(settings)) return existing || undefined;
    const parts = String(existing || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.includes(ONE_HOUR_CACHE_BETA)) parts.push(ONE_HOUR_CACHE_BETA);
    return parts.join(', ');
}

function cloneJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function cacheControlForSettings(settings) {
    const out = { type: 'ephemeral' };
    if (isOptimizerEnabled(settings) && isCacheTtlOneHour(settings)) out.ttl = '1h';
    return out;
}

export function extractReasoningIntent(body) {
    if (!body || typeof body !== 'object') return null;
    if (body.thinking && typeof body.thinking === 'object') {
        const t = body.thinking;
        if (t.type === 'disabled') return null;
        if (typeof t.budget_tokens === 'number' && t.budget_tokens > 0) return { source: 'anthropic', budgetTokens: t.budget_tokens };
        if (t.type === 'enabled' || t.type === 'adaptive') return { source: 'anthropic', effort: t.type };
    }
    if (body.reasoning && typeof body.reasoning === 'object' && typeof body.reasoning.effort === 'string') {
        return { source: 'openai', effort: body.reasoning.effort };
    }
    if (typeof body.reasoning_effort === 'string') return { source: 'openai', effort: body.reasoning_effort };
    if (body.output_config && typeof body.output_config === 'object' && typeof body.output_config.effort === 'string') {
        return { source: 'generic', effort: body.output_config.effort };
    }
    if (typeof body.effort === 'string') return { source: 'generic', effort: body.effort };
    for (const key of ['extra_body', 'extraBody', 'model_kwargs', 'modelKwargs', 'metadata', 'openai', 'anthropic']) {
        const nested = extractReasoningIntent(body[key]);
        if (nested) return nested;
    }
    return null;
}

function effortToBudget(effort) {
    if (effort === 'low') return 4096;
    if (effort === 'medium') return 8192;
    if (effort === 'high') return 16000;
    return DEFAULT_THINKING_BUDGET;
}

function budgetToEffort(budget) {
    if (budget >= 12000) return 'high';
    if (budget >= 6000) return 'medium';
    return 'low';
}

function modelSupportsThinking(model) {
    const m = String(model || '').toLowerCase();
    return m.includes('claude') && (m.includes('opus') || m.includes('sonnet'));
}

function modelSupportsOpenAIReasoning(model) {
    const m = String(model || '').toLowerCase();
    return m.startsWith('gpt-5.5') || m.startsWith('gpt-5.6-');
}

export function applyAnthropicThinkingOptimization(body, settings) {
    const out = cloneJson(body || {});
    if (!isOptimizerEnabled(settings) || !settings?.bedrockOptimizer?.thinking) return out;
    if (out.thinking?.type === 'disabled') return out;
    if (out.thinking?.type && out.thinking.type !== 'disabled') return out;

    const intent = extractReasoningIntent(body);
    const budget = intent?.budgetTokens || effortToBudget(intent?.effort);
    if (intent || modelSupportsThinking(out.model)) {
        out.thinking = { type: 'enabled', budget_tokens: budget };
    }
    return out;
}

export function applyOpenAIReasoningOptimization(body, settings) {
    const out = cloneJson(body || {});
    if (!isOptimizerEnabled(settings) || !settings?.bedrockOptimizer?.thinking) return out;
    if (out.reasoning?.effort || out.reasoning_effort) return out;

    const intent = extractReasoningIntent(body);
    if (!intent && !modelSupportsOpenAIReasoning(out.model)) return out;
    const effort = intent?.effort && ['low', 'medium', 'high'].includes(intent.effort)
        ? intent.effort
        : (intent?.budgetTokens ? budgetToEffort(intent.budgetTokens) : 'high');
    out.reasoning_effort = effort;
    return out;
}

function stripCacheControl(value) {
    if (Array.isArray(value)) return value.map(stripCacheControl);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const key of Object.keys(value)) {
        if (key === 'cache_control') continue;
        out[key] = stripCacheControl(value[key]);
    }
    return out;
}

function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function hashText(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function stripClaudeCodeAttribution(value) {
    return typeof value === 'string' ? value.replace(CLAUDE_CODE_ATTRIBUTION_RE, '') : value;
}

function textLength(value) {
    if (!value) return 0;
    if (typeof value === 'string') return stripClaudeCodeAttribution(value).length;
    return stableStringify(value).length;
}

function contentText(content) {
    if (typeof content === 'string') return stripClaudeCodeAttribution(content);
    if (!Array.isArray(content)) return '';
    return stripClaudeCodeAttribution(content.map(part => {
        if (typeof part === 'string') return part;
        if (part?.text) return part.text;
        if (part?.type === 'input_text' && part.text) return part.text;
        if (part?.content) return contentText(part.content);
        return '';
    }).join(''));
}

function messageShape(message) {
    if (!message || typeof message !== 'object') return 'unknown:0:0';
    const content = contentText(message.content);
    return `${message.role || 'unknown'}:${content.length}:${hashText(content)}`;
}

export function describeStablePrefix(body) {
    if (!body || typeof body !== 'object') return null;
    const normalized = stripCacheControl(body);
    const messages = Array.isArray(normalized.messages) ? normalized.messages : Array.isArray(normalized.input) ? normalized.input : [];
    const systemText = normalized.system || normalized.instructions || messages.filter(m => ['system', 'developer'].includes(m?.role)).map(m => contentText(m.content)).join('\n');
    const toolsText = Array.isArray(normalized.tools) ? stableStringify(normalized.tools) : '';
    const prefixSeed = stableStringify({
        model: normalized.model || '',
        system: systemText || '',
        tools: normalized.tools || [],
        firstMessages: messages.slice(0, 4).map(messageShape)
    });
    const totalText = stableStringify({ system: systemText || '', tools: normalized.tools || [], messages });
    return {
        prefixHash: hashText(prefixSeed),
        prefixChars: Math.min(totalText.length, DIAGNOSTIC_PREFIX_CHARS),
        totalChars: totalText.length,
        systemChars: textLength(systemText),
        toolsChars: toolsText.length,
        messageCount: messages.length,
        firstMessageShapes: messages.slice(0, 4).map(messageShape),
        lastMessageShapes: messages.slice(-4).map(messageShape)
    };
}

export function describeOptimizerState(requestBody, upstreamBody) {
    const requested = extractReasoningIntent(requestBody);
    const upstream = extractReasoningIntent(upstreamBody);
    return {
        requestedReasoningEffort: requested?.budgetTokens ? `${Math.round(requested.budgetTokens / 1000)}k` : (requested?.effort || ''),
        upstreamReasoningEffort: upstream?.budgetTokens ? `${Math.round(upstream.budgetTokens / 1000)}k` : (upstream?.effort || ''),
        reasoningStatus: upstream ? (requested ? 'mapped' : 'optimized') : (requested ? 'dropped' : ''),
        cachePrefixDiagnostics: describeStablePrefix(upstreamBody)
    };
}

export { ONE_HOUR_CACHE_BETA };
