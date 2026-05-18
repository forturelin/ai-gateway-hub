/**
 * Logs Route
 * Handles log retrieval and live streaming:
 *   GET /api/logs
 *   GET /api/logs/stream
 */

import { logger } from '../utils/logger.js';

/**
 * GET /api/logs
 * Returns the in-memory log history as JSON.
 */
export function handleGetLogs(req, res) {
  res.json({ status: 'ok', logs: logger.getHistory() });
}

/**
 * GET /api/logs/stream
 * Streams live log events as Server-Sent Events.
 * Pass ?history=true to replay existing log history before streaming live events.
 *
 * Throttled to FLUSH_MS / MAX_BATCH to avoid UI thrash under heavy logging
 * (e.g. during long streaming model responses).
 */
export function handleStreamLogs(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const FLUSH_MS = 200;          // ~5 batches/sec
  const MAX_BATCH = 50;          // cap per flush to avoid frame stalls

  let buf = [];
  let flushTimer = null;

  const flush = () => {
    flushTimer = null;
    if (buf.length === 0) return;
    const batch = buf.length > MAX_BATCH ? buf.slice(-MAX_BATCH) : buf;
    buf = [];
    for (const log of batch) {
      try { res.write(`data: ${JSON.stringify(log)}\n\n`); } catch { /* client gone */ return; }
    }
  };

  const sendLog = (log) => {
    buf.push(log);
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  };

  if (req.query.history === 'true') {
    for (const log of logger.getHistory()) {
      try { res.write(`data: ${JSON.stringify(log)}\n\n`); } catch { return; }
    }
  }

  logger.on('log', sendLog);

  req.on('close', () => {
    logger.off('log', sendLog);
    if (flushTimer) clearTimeout(flushTimer);
  });
}

export default { handleGetLogs, handleStreamLogs };
