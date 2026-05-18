/**
 * Anthropic Provider
 *
 * Sends requests to any Anthropic-compatible endpoint (api.anthropic.com,
 * third-party relays exposing Anthropic Messages API, etc.). Supports:
 *   - native Anthropic Messages input → Anthropic output (passthrough)
 *   - OpenAI Chat input → translated to Anthropic Messages → response
 *     translated back to OpenAI Chat (TODO: future helper if needed)
 */

import { BaseProvider } from './base.js';
import { estimateCost, estimateCostWithSnapshot } from '../pricing-registry.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

export class AnthropicProvider extends BaseProvider {
    constructor(config) {
        super({
            ...config,
            type: 'anthropic',
            baseUrl: config.baseUrl || DEFAULT_BASE_URL
        });
    }

    /**
     * Send an Anthropic Messages request to the upstream.
     * Returns the raw fetch Response (caller decides streaming vs JSON).
     */
    async sendRequest(body, { extraHeaders = {}, signal } = {}) {
        const url = `${this.baseUrl}/v1/messages`;
        return fetch(url, {
            method: 'POST',
            headers: {
                'x-api-key': this.apiKey,
                'anthropic-version': API_VERSION,
                'Content-Type': 'application/json',
                ...extraHeaders
            },
            body: JSON.stringify(body),
            signal
        });
    }

    async listModels() {
        try {
            const response = await fetch(`${this.baseUrl}/v1/models`, {
                headers: {
                    'x-api-key': this.apiKey,
                    'anthropic-version': API_VERSION
                }
            });
            if (!response.ok) return [];
            const data = await response.json();
            return (data.data || []).map(m => ({
                id: m.id,
                name: m.display_name || m.id
            }));
        } catch {
            return [];
        }
    }

    async validateKey() {
        // Try /v1/models first — auth-only endpoint, no model name required.
        // Falls back to a tiny /v1/messages probe if /models isn't supported.
        try {
            const modelsRes = await fetch(`${this.baseUrl}/v1/models`, {
                headers: {
                    'x-api-key': this.apiKey,
                    'anthropic-version': API_VERSION
                }
            });
            if (modelsRes.status === 401 || modelsRes.status === 403) return false;
            if (modelsRes.ok) return true;
            // Some proxies don't support /v1/models — fall through to messages probe
        } catch { /* network error: fall through */ }

        try {
            const response = await fetch(`${this.baseUrl}/v1/messages`, {
                method: 'POST',
                headers: {
                    'x-api-key': this.apiKey,
                    'anthropic-version': API_VERSION,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'claude-haiku-4-5',
                    max_tokens: 1,
                    messages: [{ role: 'user', content: 'hi' }]
                })
            });
            // 401/403 = bad key. Anything else (200, 400 bad model, 404, 429, 500) = key worked.
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

export default AnthropicProvider;
