import { optimizeAnthropicPromptCaching } from '../prompt-cache-utils.js';

/**
 * Format Bridge — bidirectional Anthropic <-> OpenAI protocol conversion
 *
 * Request:
 *   anthropicToOpenAI(body)          Anthropic Messages req  -> OpenAI Chat req
 *   openAIToAnthropicRequest(body)   OpenAI Chat req         -> Anthropic Messages req
 *
 * Response:
 *   openAIToAnthropic(data, model)          OpenAI Chat resp -> Anthropic Messages resp
 *   anthropicToOpenAIResponse(data, model)  Anthropic Messages resp -> OpenAI Chat resp
 */

// ─── Anthropic Request -> OpenAI Request ─────────────────────────────────────

export function anthropicToOpenAI(body) {
    const messages = [];

    if (body.system) {
        const text = typeof body.system === 'string'
            ? body.system
            : body.system.map(b => b.text || '').join('\n');
        if (text) messages.push({ role: 'system', content: text });
    }

    for (const msg of (body.messages || [])) {
        if (msg.role === 'user') {
            messages.push(..._convertAnthropicUserMsg(msg));
        } else if (msg.role === 'assistant') {
            messages.push(_convertAnthropicAssistantMsg(msg));
        }
    }

    const out = { model: body.model, messages };
    if (body.max_tokens != null) out.max_tokens = body.max_tokens;
    if (body.temperature != null) out.temperature = body.temperature;
    if (body.top_p != null) out.top_p = body.top_p;
    if (body.stop_sequences) out.stop = body.stop_sequences;
    if (body.stream != null) out.stream = body.stream;

    if (body.tools?.length) {
        out.tools = body.tools.map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description || '',
                parameters: t.input_schema || {},
            }
        }));
    }

    if (body.tool_choice) {
        if (body.tool_choice.type === 'auto') out.tool_choice = 'auto';
        else if (body.tool_choice.type === 'any') out.tool_choice = 'required';
        else if (body.tool_choice.type === 'tool') {
            out.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
        }
    }

    return out;
}

function _convertAnthropicUserMsg(msg) {
    const content = msg.content;
    if (typeof content === 'string') return [{ role: 'user', content }];

    const results = [];
    const textParts = [];

    for (const block of content) {
        if (block.type === 'tool_result') {
            if (textParts.length) {
                results.push({ role: 'user', content: textParts.join('\n') });
                textParts.length = 0;
            }
            let toolContent = '';
            if (typeof block.content === 'string') toolContent = block.content;
            else if (Array.isArray(block.content)) toolContent = block.content.map(b => b.text || '').join('\n');
            results.push({ role: 'tool', tool_call_id: block.tool_use_id, content: toolContent });
        } else if (block.type === 'text') {
            textParts.push(block.text || '');
        } else if (block.type === 'image') {
            textParts.push('[image]');
        }
    }

    if (textParts.length) results.push({ role: 'user', content: textParts.join('\n') });
    return results.length ? results : [{ role: 'user', content: '' }];
}

function _convertAnthropicAssistantMsg(msg) {
    const content = msg.content;
    if (typeof content === 'string') return { role: 'assistant', content };

    let text = '';
    const toolCalls = [];
    for (const block of content) {
        if (block.type === 'text') text += block.text || '';
        else if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id,
                type: 'function',
                function: {
                    name: block.name,
                    arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
                }
            });
        }
    }

    const out = { role: 'assistant', content: text || null };
    if (toolCalls.length) out.tool_calls = toolCalls;
    return out;
}

// ─── OpenAI Response -> Anthropic Response ───────────────────────────────────

export function openAIToAnthropic(data, model) {
    const choice = data.choices?.[0];
    if (!choice) {
        return {
            id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model,
            content: [{ type: 'text', text: '' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0 },
        };
    }

    const msg = choice.message || {};
    const content = [];
    if (msg.content) content.push({ type: 'text', text: msg.content });
    if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
            let input = {};
            try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
            content.push({
                type: 'tool_use',
                id: tc.id || `toolu_${Date.now()}`,
                name: tc.function?.name || '',
                input,
            });
        }
    }
    if (!content.length) content.push({ type: 'text', text: '' });

    let stop_reason = 'end_turn';
    if (choice.finish_reason === 'tool_calls') stop_reason = 'tool_use';
    else if (choice.finish_reason === 'length') stop_reason = 'max_tokens';

    return {
        id: data.id ? `msg_${data.id}` : `msg_${Date.now()}`,
        type: 'message', role: 'assistant', model,
        content, stop_reason, stop_sequence: null,
        usage: {
            input_tokens: data.usage?.prompt_tokens || 0,
            output_tokens: data.usage?.completion_tokens || 0,
            cache_read_input_tokens: data.usage?.prompt_tokens_details?.cached_tokens || 0,
            cache_creation_input_tokens: 0,
        },
    };
}

// ─── OpenAI Request -> Anthropic Request ─────────────────────────────────────

export function openAIToAnthropicRequest(body) {
    const anthropicMsgs = [];
    let system = '';

    for (const msg of (body.messages || [])) {
        if (msg.role === 'system') {
            system += (system ? '\n' : '') + (typeof msg.content === 'string' ? msg.content : '');
            continue;
        }
        if (msg.role === 'tool') {
            const toolBlock = {
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: msg.content || '',
            };
            const last = anthropicMsgs[anthropicMsgs.length - 1];
            if (last?.role === 'user' && Array.isArray(last.content)) {
                last.content.push(toolBlock);
            } else {
                anthropicMsgs.push({ role: 'user', content: [toolBlock] });
            }
            continue;
        }
        if (msg.role === 'assistant') {
            const blocks = [];
            if (msg.content) blocks.push({ type: 'text', text: msg.content });
            if (msg.tool_calls?.length) {
                for (const tc of msg.tool_calls) {
                    let input = {};
                    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
                    blocks.push({
                        type: 'tool_use',
                        id: tc.id || `toolu_${Date.now()}`,
                        name: tc.function?.name || '',
                        input,
                    });
                }
            }
            anthropicMsgs.push({
                role: 'assistant',
                content: blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks,
            });
            continue;
        }
        anthropicMsgs.push({ role: 'user', content: msg.content });
    }

    const out = {
        model: body.model,
        messages: anthropicMsgs,
        max_tokens: body.max_tokens || body.max_completion_tokens || 4096,
    };

    if (system) out.system = system;
    if (body.temperature != null) out.temperature = body.temperature;
    if (body.top_p != null) out.top_p = body.top_p;
    if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
    if (body.stream != null) out.stream = body.stream;

    if (body.tools?.length) {
        out.tools = body.tools.map(t => ({
            name: t.function?.name || t.name || '',
            description: t.function?.description || t.description || '',
            input_schema: t.function?.parameters || t.parameters || {},
        }));
    }

    if (body.tool_choice) {
        if (body.tool_choice === 'auto') out.tool_choice = { type: 'auto' };
        else if (body.tool_choice === 'required') out.tool_choice = { type: 'any' };
        else if (typeof body.tool_choice === 'object' && body.tool_choice.function?.name) {
            out.tool_choice = { type: 'tool', name: body.tool_choice.function.name };
        }
    }

    // ─── Strategy B: prompt-cache breakpoint 注入 ────────────────────────
    // Link 4 (OpenAI Chat 入站 → Anthropic 上游) 的 client(典型 = Roo Code)
    // 不会主动给 cache_control 字段,网关侧补上 2 个断点以激活 Anthropic 自动缓存:
    //   • system 末尾标 1 个断点 → 系统提示 + tools/codebase 上下文走缓存
    //   • 倒数第二条 user message 末尾标 1 个断点 → 多轮对话历史走缓存
    // 默认 5 min TTL(够多数 agent 场景);用户要 1h TTL 时再走 anthropic-beta header 路径
    return optimizeAnthropicPromptCaching(out, { skipIfPresent: false }).body;
}

// ─── Anthropic Response -> OpenAI Response ───────────────────────────────────

export function anthropicToOpenAIResponse(data, model) {
    const content = data.content || [];
    let text = '';
    const toolCalls = [];

    for (const block of content) {
        if (block.type === 'text') text += block.text || '';
        else if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id,
                type: 'function',
                function: {
                    name: block.name,
                    arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
                },
            });
        }
    }

    let finish_reason = 'stop';
    if (data.stop_reason === 'tool_use') finish_reason = 'tool_calls';
    else if (data.stop_reason === 'max_tokens') finish_reason = 'length';

    const message = { role: 'assistant', content: text || null };
    if (toolCalls.length) message.tool_calls = toolCalls;

    return {
        id: data.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || data.model,
        choices: [{ index: 0, message, finish_reason }],
        usage: {
            prompt_tokens: data.usage?.input_tokens || 0,
            completion_tokens: data.usage?.output_tokens || 0,
            total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
            prompt_tokens_details: {
                cached_tokens: data.usage?.cache_read_input_tokens || 0,
            },
        },
    };
}
