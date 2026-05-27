const ONE_HOUR_CACHE_BETA = 'extended-cache-ttl-2025-04-11';
const DEFAULT_THINKING_BUDGET = 16000;

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
    if (!intent) return out;
    const effort = intent.effort && ['low', 'medium', 'high'].includes(intent.effort)
        ? intent.effort
        : budgetToEffort(intent.budgetTokens || 0);
    out.reasoning_effort = effort;
    return out;
}

export function describeOptimizerState(requestBody, upstreamBody) {
    const requested = extractReasoningIntent(requestBody);
    const upstream = extractReasoningIntent(upstreamBody);
    return {
        requestedReasoningEffort: requested?.budgetTokens ? `${Math.round(requested.budgetTokens / 1000)}k` : (requested?.effort || ''),
        upstreamReasoningEffort: upstream?.budgetTokens ? `${Math.round(upstream.budgetTokens / 1000)}k` : (upstream?.effort || ''),
        reasoningStatus: upstream ? (requested ? 'mapped' : 'optimized') : (requested ? 'dropped' : '')
    };
}

export { ONE_HOUR_CACHE_BETA };
