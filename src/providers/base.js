/**
 * Base Provider
 * Common state + helpers for all upstream API provider implementations.
 *
 * The provider holds:
 *   - identity (id, name, type)
 *   - credentials (apiKey, baseUrl)
 *   - selected models (subset of discovered models the user opted in)
 *   - rolling stats (totalRequests / totalTokens / totalCost / errors)
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
        const stats = config.stats || {};
        this.totalRequests = stats.totalRequests || 0;
        this.totalTokens = stats.totalTokens || 0;
        this.totalCost = stats.totalCost || 0;
        this.errors = stats.errors || 0;
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

    markUsed(tokens, cost) {
        this.lastUsed = new Date().toISOString();
        this.totalRequests++;
        this.totalTokens += tokens || 0;
        this.totalCost += cost || 0;
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
            stats: {
                totalRequests: this.totalRequests,
                totalTokens: this.totalTokens,
                totalCost: this.totalCost,
                errors: this.errors
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
