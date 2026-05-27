import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { selectRuleForMapping } from '../src/route-mappings.js';

function mapping(strategy, patch = {}) {
    return {
        id: `m_${strategy}`,
        strategy,
        rules: [
            { enabled: true, providerId: 'p_a', inputModel: 'gpt-x', mappedModel: 'model-a' },
            { enabled: true, providerId: 'p_b', inputModel: 'gpt-x', mappedModel: 'model-b' },
            { enabled: true, providerId: 'p_c', inputModel: 'other', mappedModel: 'model-c' }
        ],
        ...patch
    };
}

test('pinned rules become primary for every routing strategy', () => {
    for (const strategy of ['fixed', 'sequential', 'least-used', 'time-window', 'random']) {
        const selected = selectRuleForMapping(mapping(strategy, { pinnedRuleIndex: 1 }), 'gpt-x', {
            advanceCursor: false,
            random: () => 0
        });
        assert.equal(selected?.index, 1, strategy);
        assert.equal(selected?.rule.providerId, 'p_b', strategy);
    }
});

test('expired pins fall back to the strategy winner', () => {
    const selected = selectRuleForMapping(mapping('fixed', {
        pinnedRuleIndex: 1,
        pinnedUntil: Date.now() - 1000
    }), 'gpt-x', { advanceCursor: false });

    assert.equal(selected?.index, 0);
});

test('time-window selection honors an explicit zero timestamp', () => {
    const selected = selectRuleForMapping({
        ...mapping('time-window'),
        rules: [
            { enabled: true, providerId: 'p_a', inputModel: 'gpt-x', mappedModel: 'model-a' },
            { enabled: true, providerId: 'p_b', inputModel: 'gpt-x', mappedModel: 'model-b' },
            { enabled: true, providerId: 'p_c', inputModel: 'gpt-x', mappedModel: 'model-c' }
        ]
    }, 'gpt-x', { now: 0, advanceCursor: false });

    assert.equal(selected?.index, 0);
});

test('mapping UI exposes active status and fixed activation for all strategies', () => {
    const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

    assert.match(app, /isRuleActive\(m,\s*ruleIndex\)/);
    assert.match(app, /ruleHasPeers\(m,\s*ruleIndex\)/);
    assert.match(app, /async pinRule\(m,\s*ruleIndex\)/);
    assert.match(app, /\{\s*pinnedRuleIndex:\s*ruleIndex,\s*pinnedUntil:\s*null\s*\}/);
    assert.match(html, /isRuleActive\(m,\s*ri\)/);
    assert.doesNotMatch(html, /m\.strategy === 'time-window' && rule\.enabled !== false && rule\.inputModel/);
    assert.match(html, /@click="pinRule\(m,\s*ri\)"/);
});

test('request log UI surfaces cache hit rate next to cache tokens', () => {
    const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

    assert.match(app, /cacheHitRatePct\(/);
    assert.match(app, /provider\s*===\s*'openai'/);
    assert.match(html, /缓存命中/);
    assert.match(html, /cacheHitRatePct\(e\)/);
    assert.match(html, /cacheHitRatePct\(rlSummary/);
});
