/**
 * SSE Helpers
 * Shared utilities for Server-Sent Events streaming and error responses.
 */

import { formatSSEEvent } from '../response-streamer.js';
import { logger } from '../utils/logger.js';

// Chunks per tick before yielding to event loop (prevents UI starvation
// during long streaming responses on Node's single-threaded event loop).
const TICK_YIELD_INTERVAL = 16;

/**
 * Sets the standard SSE response headers and flushes them.
 * @param {import('express').Response} res
 */
export function initSSEResponse(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

/**
 * Streams an async generator of Anthropic-format SSE events to the response.
 * Writes [DONE] and ends the response when the generator is exhausted.
 *
 * Returns the last observed `message_delta.usage` (if any) so callers can
 * record accurate token counts for streaming responses.
 *
 * @param {import('express').Response} res
 * @param {AsyncIterable<object>} eventStream
 * @returns {Promise<{inputTokens:number,outputTokens:number,cacheReadTokens:number,cacheCreationTokens:number}>}
 */
export async function pipeSSEStream(res, eventStream) {
  const tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  let written = 0;
  for await (const event of eventStream) {
    if (res.writableEnded || res.destroyed) break;
    // Observe usage in message_start / message_delta without modifying the stream
    const data = event?.data;
    if (data?.type === 'message_start' && data.message?.usage) {
      const u = data.message.usage;
      if (u.input_tokens) tokens.inputTokens = u.input_tokens;
      if (u.cache_read_input_tokens) tokens.cacheReadTokens = u.cache_read_input_tokens;
      if (u.cache_creation_input_tokens) tokens.cacheCreationTokens = u.cache_creation_input_tokens;
    } else if (data?.type === 'message_delta' && data.usage) {
      const u = data.usage;
      if (u.input_tokens) tokens.inputTokens = u.input_tokens;
      if (u.output_tokens) tokens.outputTokens = u.output_tokens;
      if (u.cache_read_input_tokens) tokens.cacheReadTokens = u.cache_read_input_tokens;
      if (u.cache_creation_input_tokens) tokens.cacheCreationTokens = u.cache_creation_input_tokens;
    }
    const ok = res.write(formatSSEEvent(event));
    if (!ok) await new Promise(r => res.once('drain', r));
    if (++written % TICK_YIELD_INTERVAL === 0) await new Promise(r => setImmediate(r));
  }
  if (!res.writableEnded && !res.destroyed) {
    try {
      res.write('data: [DONE]\n\n');
      res.end();
    } catch { /* client disconnected */ }
  }
  return tokens;
}

/**
 * Pipe a fetch-style Web ReadableStream response body straight to the Express
 * response with back-pressure handling and periodic event-loop yielding.
 * Use for upstream SSE that should pass through unmodified.
 *
 * @param {import('express').Response} res
 * @param {Response} response - fetch Response with .body (ReadableStream)
 */
export async function pipeWithBackpressure(res, response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    if (!res.writableEnded) { try { res.end(); } catch { /* ignore */ } }
    return;
  }
  let written = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.writableEnded || res.destroyed) break;
      const ok = res.write(value);
      if (!ok) await new Promise(r => res.once('drain', r));
      if (++written % TICK_YIELD_INTERVAL === 0) await new Promise(r => setImmediate(r));
    }
  } finally {
    if (!res.writableEnded) { try { res.end(); } catch { /* ignore */ } }
  }
}

/**
 * Same as pipeWithBackpressure but additionally observes Anthropic SSE
 * `message_start` / `message_delta` events to extract usage tokens.
 * The byte stream is forwarded to the client byte-for-byte (no modification).
 *
 * @param {import('express').Response} res
 * @param {Response} response - fetch Response carrying Anthropic SSE
 * @returns {Promise<{inputTokens:number,outputTokens:number,cacheReadTokens:number,cacheCreationTokens:number}>}
 */
export async function tapAnthropicSSE(res, response) {
  const tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const reader = response.body?.getReader?.();
  if (!reader) {
    if (!res.writableEnded) { try { res.end(); } catch { /* ignore */ } }
    return tokens;
  }
  const decoder = new TextDecoder();
  let lineBuf = '';
  let written = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.writableEnded || res.destroyed) break;

      // Forward bytes immediately (do not buffer the stream)
      const ok = res.write(value);
      if (!ok) await new Promise(r => res.once('drain', r));

      // Parse out usage on a side buffer (best-effort, never blocks forwarding)
      lineBuf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          if (obj?.type === 'message_start' && obj.message?.usage) {
            const u = obj.message.usage;
            if (u.input_tokens) tokens.inputTokens = u.input_tokens;
            if (u.cache_read_input_tokens) tokens.cacheReadTokens = u.cache_read_input_tokens;
            if (u.cache_creation_input_tokens) tokens.cacheCreationTokens = u.cache_creation_input_tokens;
          } else if (obj?.type === 'message_delta' && obj.usage) {
            const u = obj.usage;
            if (u.input_tokens) tokens.inputTokens = u.input_tokens;
            if (u.output_tokens) tokens.outputTokens = u.output_tokens;
            if (u.cache_read_input_tokens) tokens.cacheReadTokens = u.cache_read_input_tokens;
            if (u.cache_creation_input_tokens) tokens.cacheCreationTokens = u.cache_creation_input_tokens;
          }
        } catch { /* ignore parse errors on partial chunks */ }
      }

      if (++written % TICK_YIELD_INTERVAL === 0) await new Promise(r => setImmediate(r));
    }
  } finally {
    if (!res.writableEnded) { try { res.end(); } catch { /* ignore */ } }
  }
  return tokens;
}

/**
 * Sends a structured Anthropic-style error JSON response.
 * If headers have already been sent (mid-stream), writes an SSE error event instead.
 *
 * @param {import('express').Response} res
 * @param {Error} error
 * @param {string} model
 * @param {number} startTime
 */
export function handleStreamError(res, error, model, startTime) {
  const duration = Date.now() - startTime;
  logger.response(500, { model, error: error.message, duration });

  // Response already fully closed — nothing we can do, just log and bail
  if (res.writableEnded || res.destroyed) {
    return;
  }

  if (res.headersSent) {
    try {
      res.write(
        `event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: error.message }
        })}\n\n`
      );
    } catch { /* ignore write errors on closing streams */ }
    try { res.end(); } catch { /* ignore */ }
    return;
  }

  if (error.message.includes('AUTH_EXPIRED')) {
    return res.status(401).json({
      type: 'error',
      error: { type: 'authentication_error', message: 'Token expired. Please refresh or re-authenticate.' }
    });
  }

  if (error.message.startsWith('RATE_LIMITED:')) {
    const parts = error.message.split(':');
    const resetMs = parseInt(parts[1], 10);
    const errorText = parts.slice(2).join(':') || error.message;

    return res.status(429).json({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: errorText,
        resetMs: resetMs,
        resetSeconds: Math.round(resetMs / 1000)
      }
    });
  }

  if (error.message.includes('RESOURCE_EXHAUSTED') || error.message.includes('MODEL_QUOTA_EXHAUSTED')) {
    return res.status(429).json({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Model usage quota exhausted. Try a different model or wait for quota to reset.' }
    });
  }

  res.status(500).json({
    type: 'error',
    error: { type: 'api_error', message: error.message }
  });
}

/**
 * Tap an OpenAI Chat Completions SSE stream while forwarding bytes to the client.
 * OpenAI sends the final `usage` object only when the request includes
 * `stream_options: { include_usage: true }`.
 *
 * @param {import('express').Response} res
 * @param {Response} response - fetch Response carrying OpenAI SSE
 * @returns {Promise<{inputTokens:number,outputTokens:number,cacheReadTokens:number,cacheCreateTokens:number}>}
 */
export async function tapOpenAISSE(res, response) {
  const tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
  const reader = response.body?.getReader?.();
  if (!reader) {
    if (!res.writableEnded) { try { res.end(); } catch { /* ignore */ } }
    return tokens;
  }
  const decoder = new TextDecoder();
  let lineBuf = '';
  let written = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.writableEnded || res.destroyed) break;

      const ok = res.write(value);
      if (!ok) await new Promise(r => res.once('drain', r));

      lineBuf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          // The usage chunk is the final delta-less frame when include_usage=true.
          // Some providers also emit usage on every chunk — last write wins.
          if (obj.usage) {
            const u = obj.usage;
            if (typeof u.prompt_tokens === 'number') tokens.inputTokens = u.prompt_tokens;
            if (typeof u.completion_tokens === 'number') tokens.outputTokens = u.completion_tokens;
            const cached = u.prompt_tokens_details?.cached_tokens;
            if (typeof cached === 'number') tokens.cacheReadTokens = cached;
          }
        } catch { /* ignore parse errors on partial chunks */ }
      }

      if (++written % TICK_YIELD_INTERVAL === 0) await new Promise(r => setImmediate(r));
    }
  } finally {
    if (!res.writableEnded) { try { res.end(); } catch { /* ignore */ } }
  }
  return tokens;
}

export default { initSSEResponse, pipeSSEStream, pipeWithBackpressure, tapAnthropicSSE, tapOpenAISSE, handleStreamError };
