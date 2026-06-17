import test from 'node:test';
import assert from 'node:assert/strict';

import { handleCountTokens } from '../src/routes/messages-route.js';

function createMockResponse() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        }
    };
}

test('count_tokens returns an Anthropic-compatible estimate locally', async () => {
    const req = {
        headers: { authorization: 'Bearer sk-local-TuoUANfgvENdaHF-UfJj9rMJrojf27Ag-h3qBCmsLM0' },
        body: {
            model: 'claude-opus-4-7',
            system: [{ type: 'text', text: 'You are concise.' }],
            messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello Claude Code.' }] }]
        }
    };
    const res = createMockResponse();

    await handleCountTokens(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(typeof res.body.input_tokens, 'number');
    assert.ok(res.body.input_tokens > 0);
});
