/**
 * Gateway Router
 *
 * Given an authenticated mapping + an input model, this module:
 *   1. Picks a rule (provider + mappedModel) by the mapping's strategy
 *   2. Forwards the request to the provider, doing protocol conversion if
 *      the mapping's type differs from the provider's type
 *   3. On non-fatal failure, the caller can call again to try the next rule
 *
 * V1 design choice: this module exposes high-level helpers; the actual
 * forward + conversion lives in route handlers (messages-route.js,
 * chat-route.js) because they own the response stream.
 */

import { isMappingPinActive, pickRule } from './route-mappings.js';
import { getProvider } from './api-providers.js';
import { logger } from './utils/logger.js';

/**
 * Returns an array of (rule, provider) candidates for a given mapping +
 * inputModel, ordered by rotation strategy. The caller iterates the array
 * and falls through on per-attempt failure.
 *
 * Returns at most `maxAttempts` candidates (default 3). Useful when many
 * rules exist but we don't want to thrash on widespread upstream outages.
 */
export function buildCandidates(mapping, inputModel, maxAttempts = 3) {
    if (!mapping) return [];

    // Collect ALL enabled+matching rules; we pick one each time and rotate
    // the cursor via pickRule.
    const all = (mapping.rules || []).filter(r =>
        r && r.enabled !== false && r.inputModel === inputModel
    );
    if (all.length === 0) return [];

    // Fixed and manually pinned strategies use one primary rule, then fallbacks.
    if (mapping.strategy === 'fixed' || isMappingPinActive(mapping)) {
        const picked = pickRule(mapping.id, inputModel);
        const primaryIdx = picked?.index ?? -1;
        const ordered = [
            ...(picked ? [picked] : []),
            ...all
                .map(r => ({ rule: r, index: (mapping.rules || []).indexOf(r) }))
                .filter(c => c.index !== primaryIdx)
        ];
        const results = [];
        for (const candidate of ordered) {
            if (results.length >= Math.min(maxAttempts, all.length)) break;
            const rule = candidate.rule;
            const provider = getProvider(rule.providerId);
            if (!provider) {
                logger.warn(`[Gateway] Rule references missing provider: ${rule.providerId}`);
                continue;
            }
            if (!provider.isAvailable) {
                logger.debug?.(`[Gateway] Skip ${provider.name} (unavailable)`);
                continue;
            }
            results.push({ rule, ruleIndex: candidate.index, provider });
        }
        return results;
    }

    // Other strategies use pickRule cursor rotation

    if (mapping.strategy === 'time-window') {
        const picked = pickRule(mapping.id, inputModel);
        if (!picked) return [];
        const results = [];
        const primaryIdx = picked.index;

        // Primary candidate first, then remaining rules in order as fallbacks
        const ordered = [picked, ...all
            .map((r, i) => ({ rule: r, index: (mapping.rules || []).indexOf(r) }))
            .filter(c => c.index !== primaryIdx)
        ];

        for (const c of ordered) {
            if (results.length >= maxAttempts) break;
            const provider = getProvider(c.rule.providerId);
            if (!provider) {
                logger.warn(`[Gateway] Rule references missing provider: ${c.rule.providerId}`);
                continue;
            }
            if (!provider.isAvailable) {
                logger.debug?.(`[Gateway] Skip ${provider.name} (unavailable)`);
                continue;
            }
            results.push({ rule: c.rule, ruleIndex: c.index, provider });
        }
        return results;
    }

    const results = [];
    const seen = new Set();
    const limit = Math.min(maxAttempts, all.length);
    for (let i = 0; i < limit; i++) {
        const picked = pickRule(mapping.id, inputModel);
        if (!picked) break;
        // Avoid duplicates within a single request even if rules were configured weirdly
        const key = `${picked.rule.providerId}::${picked.rule.mappedModel}::${picked.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const provider = getProvider(picked.rule.providerId);
        if (!provider) {
            logger.warn(`[Gateway] Rule references missing provider: ${picked.rule.providerId}`);
            continue;
        }
        if (!provider.isAvailable) {
            logger.debug?.(`[Gateway] Skip ${provider.name} (unavailable)`);
            continue;
        }
        results.push({ rule: picked.rule, ruleIndex: picked.index, provider });
    }
    return results;
}

/**
 * Convenience: list available input models for a mapping (deduplicated, only
 * rules that are enabled). Used by the local /v1/models endpoint.
 */
export function listInputModels(mapping) {
    if (!mapping) return [];
    const seen = new Set();
    const out = [];
    for (const r of (mapping.rules || [])) {
        if (!r || r.enabled === false) continue;
        if (!r.inputModel) continue;
        if (seen.has(r.inputModel)) continue;
        seen.add(r.inputModel);
        out.push(r.inputModel);
    }
    return out;
}

export default { buildCandidates, listInputModels };
