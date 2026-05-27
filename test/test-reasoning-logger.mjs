import assert from 'node:assert/strict';
import test from 'node:test';

import { extractReasoningEffort } from '../src/request-logger.js';
import { applyAnthropicThinkingOptimization, applyOpenAIReasoningOptimization, mergeAnthropicBeta } from '../src/request-optimizer.js';
import { openAIToAnthropicRequest } from '../src/providers/format-bridge.js';

const optimizerSettings = { bedrockOptimizer: { enabled: true, thinking: true, cacheInjection: true, cacheTtl: '1h' } };

test('extracts OpenAI reasoning effort from top-level Responses body', () => {
    assert.equal(extractReasoningEffort({ reasoning: { effort: 'high' } }), 'high');
});

test('extracts reasoning effort from nested wrapper payloads', () => {
    assert.equal(extractReasoningEffort({ output_config: { effort: 'medium' } }), 'medium');
    assert.equal(extractReasoningEffort({ extra_body: { reasoning: { effort: 'low' } } }), 'low');
});

test('extracts Anthropic thinking budget from nested wrapper payloads', () => {
    assert.equal(extractReasoningEffort({ extra_body: { thinking: { type: 'enabled', budget_tokens: 16000 } } }), '16k');
});

test('extracts generic effort from truncated JSON strings', () => {
    const body = '{"messages":[{"content":"long prefix"}],"extra_body":{"reasoning":{"effort":"high"}}';
    assert.equal(extractReasoningEffort(body), 'high');
});

test('extracts generic effort from parsed wrapper metadata', () => {
    assert.equal(extractReasoningEffort({ metadata: { effort: 'medium' } }), 'medium');
});

test('maps OpenAI high reasoning to Anthropic thinking budget', () => {
    const converted = openAIToAnthropicRequest({
        model: 'claude-opus-4-7',
        reasoning: { effort: 'high' },
        messages: [{ role: 'user', content: 'hello' }]
    }, { settings: optimizerSettings, cacheTtl: '1h' });

    assert.deepEqual(converted.thinking, { type: 'enabled', budget_tokens: 16000 });
});

test('maps Anthropic thinking budget to OpenAI reasoning effort', () => {
    const optimized = applyOpenAIReasoningOptimization({
        model: 'gpt-5.5',
        thinking: { type: 'enabled', budget_tokens: 16000 },
        messages: [{ role: 'user', content: 'hello' }]
    }, optimizerSettings);

    assert.equal(optimized.reasoning_effort, 'high');
});

test('injects one hour Anthropic cache beta without dropping client betas', () => {
    assert.equal(mergeAnthropicBeta('client-feature', optimizerSettings), 'client-feature, extended-cache-ttl-2025-04-11');
});
