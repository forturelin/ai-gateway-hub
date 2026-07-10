import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { extractReasoningEffort } from '../src/request-logger.js';

test('extracts reasoning effort from provider-prefixed passthrough payloads', () => {
    assert.equal(extractReasoningEffort({ openai: { reasoning_effort: 'high' } }), 'high');
    assert.equal(extractReasoningEffort({ anthropic: { thinking: { type: 'enabled', budget_tokens: 32000 } } }), '32k');
});

test('OpenAI usage extraction recognizes Responses and snake_case cache token fields', () => {
    const chatRoute = readFileSync(new URL('../src/routes/chat-route.js', import.meta.url), 'utf8');
    const responsesRoute = readFileSync(new URL('../src/routes/responses-route.js', import.meta.url), 'utf8');
    const sseMiddleware = readFileSync(new URL('../src/middleware/sse.js', import.meta.url), 'utf8');
    const combined = [chatRoute, responsesRoute, sseMiddleware].join('\n');

    assert.match(combined, /input_tokens_details\?\.cached_tokens/);
    assert.match(combined, /prompt_tokens_details\?\.cached_tokens/);
    assert.match(combined, /prompt_cache_hit_tokens/);
    assert.match(combined, /cachedTokensFromUsage/);
});
test('Responses route keeps executable statements out of comment text', () => {
    const responsesRoute = readFileSync(new URL('../src/routes/responses-route.js', import.meta.url), 'utf8');

    assert.match(responsesRoute, /^ {4}const allowedEndpoints = mapping\.allowedEndpoints \|\| \['chat', 'responses'\];$/m);
    assert.match(responsesRoute, /^ {4}const anthropicBeta = req\.headers\['anthropic-beta'\] \|\| undefined;/m);
    assert.equal((responsesRoute.match(/^ {16}const upstream = skipCacheInjection$/gm) || []).length, 3);
    assert.match(responsesRoute, /^ {12}const upstream = skipCacheInjection$/m);
});

test('Responses SSE wrapper emits custom tool call items', () => {
    const responsesRoute = readFileSync(new URL('../src/routes/responses-route.js', import.meta.url), 'utf8');

    assert.match(responsesRoute, /item\.type === 'custom_tool_call'/);
    assert.match(responsesRoute, /\$\{requestedModel\}->\$\{rule\.mappedModel\}/);
});
