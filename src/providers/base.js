/**
 * Base Provider
 * Common state + helpers for all upstream API provider implementations.
 *
 * The provider holds:
 *   - identity (id, name, type)
 *   - credentials (apiKey, baseUrl)
 *   - selected models (subset of discovered models the user opted in)
 *   - rolling stats (totalRequests / totalTokens / totalCost / errors /
 *                    totalCacheReadTokens / totalCacheCreateTokens)
 *   - rate limit cooldown timestamp
 */

export class BaseProvider {
    constructor(config) {
        this.id = config.id;
        this.name = config.name;
        this.type = config.type;
        this.apiKey = config.apiKey || '';
        this.baseUrl = config.baseUrl || '';
        this.enabled = config.enabled !== false;
        this.addedAt = config.addedAt || new Date().toISOString();
        this.lastUsed = config.lastUsed || null;
        this.selectedModels = Array.isArray(config.selectedModels) ? config.selectedModels : [];
        this.discoveredModels = Array.isArray(config.discoveredModels) ? config.discoveredModels : [];
        this.lastDiscoveredAt = config.lastDiscoveredAt || null;
        // When true (and type === 'openai'), the /v1/responses route will use
        // the upstream's native /responses endpoint instead of converting
        // request/response through Chat Completions. This preserves
        // `previous_response_id` / `store=true` semantics so the upstream can
        // do server-side prompt caching (40-80% hit-rate improvement seen on
        // long agentic conversations).
        this.supportsNativeResponses = !!config.supportsNativeResponses;
        const stats = config.stats || {};
        this.totalRequests = stats.totalRequests || 0;
        this.totalTokens = stats.totalTokens || 0;
        this.totalCost = stats.totalCost || 0;
        this.errors = stats.errors || 0;
        // Cache token accumulators — separate from totalTokens so the UI can
        // surface "this key saved $X via cache" without double-counting.
        // totalTokens already includes prompt+completion; cacheRead/cacheCreate
        // are sub-categories of prompt tokens that we track independently.
        this.totalCacheReadTokens = stats.totalCacheReadTokens || 0;
        this.totalCacheCreateTokens = stats.totalCacheCreateTokens || 0;
        this.rateLimitedUntil = config.rateLimitedUntil || null;
    }

    get isRateLimited() {
        if (!this.rateLimitedUntil) return false;
        return Date.now() < this.rateLimitedUntil;
    }

    get isAvailable() {
        return this.enabled && !this.isRateLimited;
    }

    get maskedKey() {
        if (!this.apiKey) return '';
        if (this.apiKey.length <= 8) return '****';
        return this.apiKey.slice(0, 4) + '...' + this.apiKey.slice(-4);
    }

    markUsed(tokens, cost, cacheRead = 0, cacheCreate = 0) {
        this.lastUsed = new Date().toISOString();
        this.totalRequests++;
        this.totalTokens += tokens || 0;
        this.totalCost += cost || 0;
        this.totalCacheReadTokens += cacheRead || 0;
        this.totalCacheCreateTokens += cacheCreate || 0;
    }

    markError() {
        this.errors++;
    }

    markRateLimited(durationMs) {
        this.rateLimitedUntil = Date.now() + durationMs;
    }

    clearRateLimit() {
        this.rateLimitedUntil = null;
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            type: this.type,
            apiKey: this.apiKey,
            baseUrl: this.baseUrl,
            enabled: this.enabled,
            addedAt: this.addedAt,
            lastUsed: this.lastUsed,
            selectedModels: this.selectedModels,
            discoveredModels: this.discoveredModels,
            lastDiscoveredAt: this.lastDiscoveredAt,
            supportsNativeResponses: this.supportsNativeResponses,
            stats: {
                totalRequests: this.totalRequests,
                totalTokens: this.totalTokens,
                totalCost: this.totalCost,
                errors: this.errors,
                totalCacheReadTokens: this.totalCacheReadTokens,
                totalCacheCreateTokens: this.totalCacheCreateTokens
            },
            rateLimitedUntil: this.rateLimitedUntil
        };
    }

    toSafeJSON() {
        const json = this.toJSON();
        json.apiKey = this.maskedKey;
        json.isAvailable = this.isAvailable;
        json.isRateLimited = this.isRateLimited;
        return json;
    }
}

export default BaseProvider;
