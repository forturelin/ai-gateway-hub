/**
 * 回归测试: 验证 openAIToAnthropicRequest 内置的 Strategy B cache_control 注入
 *
 * v1: 用独立 withCacheControl 包装函数 dry-run(主代码未改)
 * v2: 注入逻辑已落地到主代码(format-bridge.js prompt-cache-utils),
 *     此脚本改为直接调主代码,作为回归测试
 *
 * 运行: node D:/WorkSpace/AiToolTest/ai-gateway-hub/test/test-cache-injection.mjs
 */

import { openAIToAnthropicRequest } from '../src/providers/format-bridge.js';

// 直接调主代码,不再包装
const withCacheControl = openAIToAnthropicRequest;

// ──────────────────────────────────────────────────────────────
// 测试用例
// ──────────────────────────────────────────────────────────────
const cases = [
    {
        name: 'Case 1: 单轮(无历史) — 只应标 system,不应标 user',
        input: {
            model: 'claude-sonnet-4-5',
            messages: [
                { role: 'system', content: 'You are a coding assistant. [system prompt 长稳定文本...]' },
                { role: 'user', content: 'Hello, write hello.js' }
            ],
            max_tokens: 1000
        }
    },
    {
        name: 'Case 2: 多轮代码场景 — system + 最近两条 user 都应标',
        input: {
            model: 'claude-sonnet-4-5',
            messages: [
                { role: 'system', content: '[大量 codebase 上下文,10万 tok...]' },
                { role: 'user', content: 'Read src/index.js' },
                { role: 'assistant', content: '[file content here]' },
                { role: 'user', content: 'Now fix the bug at line 42' }
            ],
            max_tokens: 2000
        }
    },
    {
        name: 'Case 3: Agent 多轮含 tool_use — tool result 在 user role 里',
        input: {
            model: 'claude-sonnet-4-5',
            messages: [
                { role: 'system', content: '[system prompt + tools 描述]' },
                { role: 'user', content: 'List files' },
                { role: 'assistant', content: null, tool_calls: [
                    { id: 't1', type: 'function', function: { name: 'list_files', arguments: '{}' } }
                ]},
                { role: 'tool', tool_call_id: 't1', content: 'foo.js bar.js baz.js' },
                { role: 'user', content: 'Read foo.js' }
            ],
            max_tokens: 2000
        }
    },
    {
        name: 'Case 4: 无 system 单轮 — 既无 system 也无足够 user,应无 cache_control',
        input: {
            model: 'claude-sonnet-4-5',
            messages: [
                { role: 'user', content: 'Just one message' }
            ],
            max_tokens: 100
        }
    },
    {
        name: 'Case 5: 极端多轮 — 标记应落在最近两条 user,不是更早',
        input: {
            model: 'claude-sonnet-4-5',
            messages: [
                { role: 'system', content: 'sys' },
                { role: 'user', content: 'turn1-user' },
                { role: 'assistant', content: 'turn1-bot' },
                { role: 'user', content: 'turn2-user' },
                { role: 'assistant', content: 'turn2-bot' },
                { role: 'user', content: 'turn3-user (应该标这条)' },
                { role: 'assistant', content: 'turn3-bot' },
                { role: 'user', content: 'turn4-user (最新,不标)' }
            ],
            max_tokens: 1000
        }
    }
];

// ──────────────────────────────────────────────────────────────
// 运行 + 校验
// ──────────────────────────────────────────────────────────────
function findCacheControlMarkers(body) {
    const markers = [];
    // system
    if (Array.isArray(body.system)) {
        body.system.forEach((b, i) => {
            if (b.cache_control) markers.push(`system[${i}] (text: "${(b.text||'').slice(0,30)}...")`);
        });
    }
    // messages
    body.messages.forEach((m, mi) => {
        if (Array.isArray(m.content)) {
            m.content.forEach((b, ci) => {
                if (b.cache_control) {
                    const preview = (b.text || b.content || '').slice(0, 40);
                    markers.push(`messages[${mi}].content[${ci}] role=${m.role} text="${preview}..."`);
                }
            });
        }
    });
    return markers;
}

console.log('═'.repeat(78));
console.log('  Dry-run: cache_control 注入 (system + 最近两条 user)');
console.log('═'.repeat(78));

for (const c of cases) {
    console.log('\n┌── ' + c.name);
    const out = withCacheControl(c.input);
    const markers = findCacheControlMarkers(out);
    console.log('│ cache_control 标记位置:');
    if (markers.length === 0) {
        console.log('│   (无)');
    } else {
        markers.forEach(m => console.log(`│   • ${m}`));
    }
    console.log('│ 转换后 body (简化显示):');
    console.log('│ ' + JSON.stringify(out, null, 2).split('\n').join('\n│ '));
}

console.log('\n' + '═'.repeat(78));
console.log('  校验小结');
console.log('═'.repeat(78));

const expectations = [
    { name: 'Case 1', expectMarkers: 1, why: '有 system, 但只有1条 user' },
    { name: 'Case 2', expectMarkers: 2, why: 'system + 最近一条已完成 user' },
    { name: 'Case 3', expectMarkers: 3, why: 'system + 最近两条 user (含 tool_result)' },
    { name: 'Case 4', expectMarkers: 0, why: '无 system + 只有1条 user' },
    { name: 'Case 5', expectMarkers: 3, why: 'system + turn2-user + turn3-user' }
];

let allPass = true;
for (let i = 0; i < cases.length; i++) {
    const out = withCacheControl(cases[i].input);
    const actual = findCacheControlMarkers(out).length;
    const expected = expectations[i].expectMarkers;
    const pass = actual === expected;
    if (!pass) allPass = false;
    console.log(`  ${pass ? '✓' : '✗'} ${expectations[i].name}: 期望 ${expected} 个标记, 实际 ${actual} 个 — ${expectations[i].why}`);
}

console.log('\n' + (allPass ? '✓ 全部通过' : '✗ 有失败用例'));
