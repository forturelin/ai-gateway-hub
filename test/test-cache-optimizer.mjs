import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { anthropicToOpenAI, openAIToAnthropicRequest } from '../src/providers/format-bridge.js';
import { estimateCost } from '../src/pricing-registry.js';
import {
    deriveAnthropicPromptCacheWarmupKey,
    deriveOpenAIPromptCacheKey,
    optimizeAnthropicPromptCaching,
    withOpenAIPromptCacheKey,
    withPromptCacheWarmup
} from '../src/prompt-cache-utils.js';
import { describeStablePrefix } from '../src/request-optimizer.js';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function markerPaths(body) {
    const markers = [];

    if (Array.isArray(body.system)) {
        body.system.forEach((block, index) => {
            if (block?.cache_control) markers.push(`system[${index}]`);
        });
    }

    (body.messages || []).forEach((message, messageIndex) => {
        if (!Array.isArray(message.content)) return;
        message.content.forEach((block, contentIndex) => {
            if (block?.cache_control) {
                markers.push(`messages[${messageIndex}].content[${contentIndex}]`);
            }
        });
    });

    return markers;
}

test('OpenAI chat to Anthropic marks only closed reusable turns', () => {
    const converted = openAIToAnthropicRequest({
        model: 'claude-opus-4-7',
        messages: [
            { role: 'system', content: 'Stable project instructions and tool policy.' },
            { role: 'user', content: 'List files' },
            { role: 'assistant', content: 'I found src/index.js.' },
            { role: 'user', content: 'Read src/index.js' },
            { role: 'assistant', content: 'Here is the file summary.' },
            { role: 'user', content: 'Now fix the cache behavior.' }
        ],
        max_tokens: 1000
    });

    assert.deepEqual(markerPaths(converted), [
        'system[0]',
        'messages[0].content[0]',
        'messages[2].content[0]'
    ]);
});

test('native Anthropic requests get cache breakpoints without mutating the caller body', () => {
    const original = {
        model: 'claude-opus-4-7',
        system: 'Stable system prompt.',
        messages: [
            { role: 'user', content: 'First turn' },
            { role: 'assistant', content: 'First answer' },
            { role: 'user', content: 'Second turn' }
        ]
    };

    const optimized = optimizeAnthropicPromptCaching(original);

    assert.equal(original.system, 'Stable system prompt.');
    assert.deepEqual(markerPaths(optimized.body), [
        'system[0]',
        'messages[0].content[0]'
    ]);
    assert.equal(optimized.injected, true);
});

test('existing client cache_control is preserved while missing history breakpoints are added', () => {
    const optimized = optimizeAnthropicPromptCaching({
        model: 'claude-opus-4-7',
        system: [{ type: 'text', text: 'Client managed.', cache_control: { type: 'ephemeral' } }],
        messages: [
            { role: 'user', content: 'First turn' },
            { role: 'assistant', content: 'First answer' },
            { role: 'user', content: 'Second turn' }
        ]
    });

    assert.deepEqual(markerPaths(optimized.body), [
        'system[0]',
        'messages[0].content[0]'
    ]);
    assert.equal(optimized.injected, true);
});

test('Anthropic tools are sorted and schemas are canonicalized for stable prefixes', () => {
    const optimized = optimizeAnthropicPromptCaching({
        model: 'claude-opus-4-7',
        system: 'Stable system prompt.',
        tools: [
            {
                name: 'zeta',
                input_schema: {
                    type: 'object',
                    required: ['b', 'a'],
                    properties: {
                        b: { type: 'string' },
                        a: { type: 'string' }
                    }
                }
            },
            {
                name: 'alpha',
                input_schema: {
                    type: 'object',
                    properties: {
                        z: { type: 'string' },
                        a: { type: 'string' }
                    }
                }
            }
        ],
        messages: [{ role: 'user', content: 'Use a tool' }]
    });

    assert.deepEqual(optimized.body.tools.map((tool) => tool.name), ['alpha', 'zeta']);
    assert.deepEqual(Object.keys(optimized.body.tools[0].input_schema.properties), ['a', 'z']);
    assert.deepEqual(optimized.body.tools[1].input_schema.required, ['a', 'b']);
});

test('Anthropic cache warmup keys are derived from optimized cache breakpoints', () => {
    const base = optimizeAnthropicPromptCaching({
        model: 'claude-opus-4-7',
        system: 'Stable system prompt. '.repeat(80),
        messages: [
            { role: 'user', content: 'First turn' },
            { role: 'assistant', content: 'First answer' },
            { role: 'user', content: 'Second turn' }
        ]
    }).body;
    const same = optimizeAnthropicPromptCaching({
        ...base,
        max_tokens: 1000
    }).body;
    const changed = optimizeAnthropicPromptCaching({
        ...base,
        system: 'Different system prompt. '.repeat(80)
    }).body;

    assert.match(deriveAnthropicPromptCacheWarmupKey(base), /^agh_anth_[a-f0-9]{32}$/);
    assert.equal(deriveAnthropicPromptCacheWarmupKey(base), deriveAnthropicPromptCacheWarmupKey(same));
    assert.notEqual(deriveAnthropicPromptCacheWarmupKey(base), deriveAnthropicPromptCacheWarmupKey(changed));
});

test('OpenAI prompt cache keys are stable for the shared prefix only', () => {
    const base = {
        model: 'gpt-5.5',
        instructions: 'Stable Codex instructions. '.repeat(80),
        input: 'Question A',
        tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }]
    };

    const a = withOpenAIPromptCacheKey(base, { mappedModel: 'gpt-5.5' });
    const b = withOpenAIPromptCacheKey({ ...base, input: 'Question B' }, { mappedModel: 'gpt-5.5' });
    const c = withOpenAIPromptCacheKey({ ...base, instructions: 'Different instructions. '.repeat(80) }, { mappedModel: 'gpt-5.5' });
    const client = withOpenAIPromptCacheKey({ ...base, prompt_cache_key: 'client-key' }, { mappedModel: 'gpt-5.5' });
    const retained = withOpenAIPromptCacheKey(base, {
        mappedModel: 'gpt-5.5',
        promptCacheRetention: '24h'
    });

    assert.match(a.body.prompt_cache_key, /^agh_[a-f0-9]{32}$/);
    assert.equal(a.body.prompt_cache_key, b.body.prompt_cache_key);
    assert.notEqual(a.body.prompt_cache_key, c.body.prompt_cache_key);
    assert.equal(client.body.prompt_cache_key, 'client-key');
    assert.equal(client.added, false);
    assert.equal(retained.body.prompt_cache_retention, '24h');
});

function longMessage(label) {
    return `${label} `.repeat(120);
}

test('Claude Code attribution header is stripped from Anthropic to OpenAI conversion', () => {
    const converted = anthropicToOpenAI({
        model: 'gpt-5.5',
        system: 'x-anthropic-billing-header: cc_version=2.1.143.f09; cc_entrypoint=cli; cch=0f646;\n\nYou are Claude Code.',
        messages: [{ role: 'user', content: 'Hello' }]
    });

    assert.equal(converted.messages[0].content, 'You are Claude Code.');
});

test('Claude Code attribution header is ignored for cache keys and diagnostics', () => {
    const base = {
        model: 'gpt-5.5',
        messages: [
            { role: 'system', content: 'You are Claude Code, Anthropic official CLI. '.repeat(30) },
            { role: 'user', content: longMessage('first-user') },
            { role: 'assistant', content: longMessage('first-assistant') },
            { role: 'user', content: 'Current question' }
        ]
    };
    const withAttribution = {
        ...base,
        messages: [{
            role: 'system',
            content: 'x-anthropic-billing-header: cc_version=2.1.143.f09; cc_entrypoint=cli; cch=0f646;\n\n' + base.messages[0].content
        }, ...base.messages.slice(1)]
    };
    const withDifferentAttribution = {
        ...base,
        messages: [{
            role: 'system',
            content: 'x-anthropic-billing-header: cc_version=2.1.143.f09; cc_entrypoint=cli; cch=58eca;\n\n' + base.messages[0].content
        }, ...base.messages.slice(1)]
    };

    assert.equal(deriveOpenAIPromptCacheKey(withAttribution), deriveOpenAIPromptCacheKey(base));
    assert.equal(deriveOpenAIPromptCacheKey(withDifferentAttribution), deriveOpenAIPromptCacheKey(base));
    assert.equal(describeStablePrefix(withAttribution).prefixHash, describeStablePrefix(withDifferentAttribution).prefixHash);
});

test('OpenAI chat prompt cache keys include closed conversation history', () => {
    const base = {
        model: 'gpt-5.5',
        messages: [
            { role: 'system', content: 'Stable project instructions. '.repeat(30) },
            { role: 'user', content: longMessage('first-user') },
            { role: 'assistant', content: longMessage('first-assistant') },
            { role: 'user', content: longMessage('second-user') },
            { role: 'assistant', content: longMessage('second-assistant') },
            { role: 'user', content: 'Current question A' }
        ]
    };

    const a = withOpenAIPromptCacheKey(base, { mappedModel: 'gpt-5.5' });
    const b = withOpenAIPromptCacheKey({
        ...base,
        messages: [...base.messages.slice(0, -1), { role: 'user', content: 'Current question B' }]
    }, { mappedModel: 'gpt-5.5' });
    const c = withOpenAIPromptCacheKey({
        ...base,
        messages: [
            base.messages[0],
            { role: 'user', content: longMessage('changed-first-user') },
            ...base.messages.slice(2)
        ]
    }, { mappedModel: 'gpt-5.5' });

    assert.match(a.body.prompt_cache_key, /^agh_[a-f0-9]{32}$/);
    assert.equal(a.body.prompt_cache_key, b.body.prompt_cache_key);
    assert.notEqual(a.body.prompt_cache_key, c.body.prompt_cache_key);
});

test('OpenAI prompt cache keys ignore volatile suffixes in very long instructions', () => {
    const stablePrefix = 'Stable Codex instruction prefix. '.repeat(2000);
    const a = withOpenAIPromptCacheKey({
        model: 'gpt-5.5',
        instructions: stablePrefix + 'Turn A volatile context.',
        input: 'Question A'
    }, { mappedModel: 'gpt-5.5' });
    const b = withOpenAIPromptCacheKey({
        model: 'gpt-5.5',
        instructions: stablePrefix + 'Turn B volatile context.',
        input: 'Question B'
    }, { mappedModel: 'gpt-5.5' });

    assert.equal(a.body.prompt_cache_key, b.body.prompt_cache_key);
});

test('OpenAI cost treats cached tokens as part of prompt_tokens, not extra tokens', () => {
    const openaiCost = estimateCost('openai', 'gpt-5.4', 1000, 100, 400, 0);
    const expectedOpenAI = (600 / 1_000_000) * 2.5
        + (100 / 1_000_000) * 15
        + (400 / 1_000_000) * 0.25;

    const anthropicCost = estimateCost('anthropic', 'claude-opus-4-7', 600, 100, 400, 100);
    const expectedAnthropic = (600 / 1_000_000) * 5
        + (100 / 1_000_000) * 25
        + (400 / 1_000_000) * 0.5
        + (100 / 1_000_000) * 6.25;

    assert.equal(openaiCost, expectedOpenAI);
    assert.equal(anthropicCost, expectedAnthropic);
});

test('prompt cache warmup blocks same-key followers until leader has a hold window', async () => {
    const leaderRelease = deferred();
    const events = [];

    const first = withPromptCacheWarmup('same-key', async () => {
        events.push('leader-start');
        await leaderRelease.promise;
        events.push('leader-end');
        return 'leader';
    }, { holdMs: 25 });

    await sleep(0);
    let followerDone = false;
    const second = withPromptCacheWarmup('same-key', async () => {
        events.push('follower-start');
        return 'follower';
    }, { holdMs: 25 }).then((value) => {
        followerDone = true;
        return value;
    });

    await sleep(10);
    assert.deepEqual(events, ['leader-start']);
    assert.equal(followerDone, false);

    leaderRelease.resolve();
    assert.equal(await first, 'leader');

    await sleep(10);
    assert.equal(followerDone, false);

    assert.equal(await second, 'follower');
    assert.deepEqual(events, ['leader-start', 'leader-end', 'follower-start']);
});

test('prompt cache warmup does not block unrelated cache keys', async () => {
    const leaderRelease = deferred();
    const first = withPromptCacheWarmup('key-a', async () => {
        await leaderRelease.promise;
        return 'a';
    }, { holdMs: 25 });

    await sleep(0);
    assert.equal(await withPromptCacheWarmup('key-b', async () => 'b', { holdMs: 25 }), 'b');
    leaderRelease.resolve();
    assert.equal(await first, 'a');
});

test('prompt cache warmup keeps followers waiting until a response body is consumed', async () => {
    const streamClose = deferred();
    const response = new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('chunk'));
            streamClose.promise.then(() => controller.close());
        }
    }), { status: 200 });

    const upstream = await withPromptCacheWarmup('stream-key', async () => response, { holdMs: 25 });

    let followerDone = false;
    const follower = withPromptCacheWarmup('stream-key', async () => 'follower', { holdMs: 25 })
        .then((value) => {
            followerDone = true;
            return value;
        });

    await sleep(40);
    assert.equal(followerDone, false);

    const text = upstream.text();
    streamClose.resolve();
    assert.equal(await text, 'chunk');

    await sleep(10);
    assert.equal(followerDone, false);
    assert.equal(await follower, 'follower');
});

test('OpenAI native routes gate same-key prompt cache warmups before upstream calls', () => {
    const responsesRoute = readFileSync(new URL('../src/routes/responses-route.js', import.meta.url), 'utf8');
    const chatRoute = readFileSync(new URL('../src/routes/chat-route.js', import.meta.url), 'utf8');
    const messagesRoute = readFileSync(new URL('../src/routes/messages-route.js', import.meta.url), 'utf8');
    const openAIProvider = readFileSync(new URL('../src/providers/openai.js', import.meta.url), 'utf8');

    assert.match(responsesRoute, /withPromptCacheWarmup/);
    assert.match(responsesRoute, /withPromptCacheWarmup\(\s*prepared\.promptCacheKey,/);
    assert.match(responsesRoute, /provider\.sendResponsesRequest\(prepared\.body\)/);
    assert.match(chatRoute, /withPromptCacheWarmup/);
    assert.match(chatRoute, /withPromptCacheWarmup\(\s*prepared\.promptCacheKey,/);
    assert.match(chatRoute, /provider\.sendRequest\(prepared\.body\)/);
    assert.match(chatRoute, /withAnthropicPromptCacheWarmup/);
    assert.match(responsesRoute, /withAnthropicPromptCacheWarmup/);
    assert.match(messagesRoute, /withAnthropicPromptCacheWarmup/);
    assert.match(openAIProvider, /withOpenAIPromptCacheKey/);
    assert.match(openAIProvider, /withPromptCacheWarmup/);
});

test('OpenAI prompt cache retention defaults to 1h on all OpenAI upstream paths', () => {
    const responsesRoute = readFileSync(new URL('../src/routes/responses-route.js', import.meta.url), 'utf8');
    const chatRoute = readFileSync(new URL('../src/routes/chat-route.js', import.meta.url), 'utf8');
    const openAIProvider = readFileSync(new URL('../src/providers/openai.js', import.meta.url), 'utf8');
    const combined = [responsesRoute, chatRoute, openAIProvider].join('\n');

    assert.match(combined, /promptCacheRetention:\s*cacheTtl/);
    assert.doesNotMatch(combined, /promptCacheRetention:\s*'24h'/);
});
