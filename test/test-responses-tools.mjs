import assert from 'node:assert/strict';
import test from 'node:test';

import { responsesToChat, chatToResponses } from '../src/routes/responses-route.js';

test('Responses additional_tools are converted to Chat Completions tools', () => {
    const chat = responsesToChat({
        model: 'gpt-5.6-sol',
        input: [
            {
                type: 'additional_tools',
                role: 'developer',
                tools: [
                    {
                        type: 'custom',
                        name: 'exec',
                        description: 'Run a shell command',
                        parameters: {
                            type: 'object',
                            properties: { command: { type: 'string' } },
                            required: ['command']
                        }
                    }
                ]
            },
            { role: 'user', content: [{ type: 'input_text', text: 'run git status' }] }
        ]
    });

    assert.deepEqual(chat.tools, [
        {
            type: 'function',
            function: {
                name: 'exec',
                description: 'Run a shell command',
                parameters: {
                    type: 'object',
                    properties: { command: { type: 'string' } },
                    required: ['command']
                }
            }
        }
    ]);
    assert.equal(chat.messages.length, 1);
    assert.equal(chat.messages[0].role, 'user');
});


test('custom Responses tools round-trip through Chat Completions fallback', () => {
    const chat = responsesToChat({
        model: 'gpt-5.6-terra',
        input: [
            {
                type: 'additional_tools',
                role: 'developer',
                tools: [
                    {
                        type: 'custom',
                        name: 'exec',
                        description: 'Run raw JavaScript code'
                    }
                ]
            },
            { role: 'user', content: [{ type: 'input_text', text: 'list files' }] }
        ]
    });

    assert.deepEqual(chat.tools[0].function.parameters, {
        type: 'object',
        properties: {
            input: {
                type: 'string',
                description: 'Raw input for the custom tool.'
            }
        },
        required: ['input'],
        additionalProperties: false
    });

    const response = chatToResponses({
        choices: [
            {
                message: {
                    tool_calls: [
                        {
                            id: 'call_exec_1',
                            type: 'function',
                            function: {
                                name: 'exec',
                                arguments: JSON.stringify({ input: "await tools.shell_command({ command: 'git status' })" })
                            }
                        }
                    ]
                },
                finish_reason: 'tool_calls'
            }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }, 'gpt-5.6-terra', chat);

    assert.equal(response.output[0].type, 'custom_tool_call');
    assert.equal(response.output[0].call_id, 'call_exec_1');
    assert.equal(response.output[0].name, 'exec');
    assert.equal(response.output[0].input, "await tools.shell_command({ command: 'git status' })");
});

test('custom tools keep raw input when Chat returns a plain string', () => {
    const chat = responsesToChat({
        model: 'gpt-5.6-terra',
        input: [{
            type: 'additional_tools',
            role: 'developer',
            tools: [{ type: 'custom', name: 'exec', description: 'Run raw JavaScript code' }]
        }]
    });

    const response = chatToResponses({
        choices: [{
            message: {
                tool_calls: [{
                    id: 'call_exec_2',
                    type: 'function',
                    function: { name: 'exec', arguments: 'text("ok")' }
                }]
            },
            finish_reason: 'tool_calls'
        }]
    }, 'gpt-5.6-terra', chat);

    assert.equal(response.output[0].type, 'custom_tool_call');
    assert.equal(response.output[0].input, 'text("ok")');
});

test('custom tool call history converts back to Chat tool messages', () => {
    const chat = responsesToChat({
        model: 'gpt-5.6-terra',
        input: [
            {
                type: 'custom_tool_call',
                call_id: 'call_exec_3',
                name: 'exec',
                input: 'text("ok")'
            },
            {
                type: 'custom_tool_call_output',
                call_id: 'call_exec_3',
                output: 'ok'
            }
        ]
    });

    assert.deepEqual(chat.messages, [
        {
            role: 'assistant',
            content: null,
            tool_calls: [{
                id: 'call_exec_3',
                type: 'function',
                function: { name: 'exec', arguments: JSON.stringify({ input: 'text("ok")' }) }
            }]
        },
        { role: 'tool', tool_call_id: 'call_exec_3', content: 'ok' }
    ]);
});