// service-assets/src/services/progressHub.js
// Simple in-memory hub to manage Server-Sent Events (SSE) progress streams.

const channels = new Map(); // channelId -> { clients:Set, buffer:Array, abort?:AbortController }
const HEARTBEAT_INTERVAL_MS = 25_000;
const BUFFER_LIMIT = 200;

function ensureChannel(channelId) {
  if (!channels.has(channelId)) {
    channels.set(channelId, {
      clients: new Set(),
      buffer: [],
    });
  }
  return channels.get(channelId);
}

export function registerClient(channelId, res) {
  const entry = ensureChannel(channelId);
  entry.clients.add(res);

  // Replay buffered events so late subscribers catch up.
  if (Array.isArray(entry.buffer)) {
    entry.buffer.forEach(({ event, data }) => {
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        // ignore write errors during replay
      }
    });
  }

  const heartbeat = setInterval(() => {
    try {
      res.write(`event: heartbeat\ndata: {}\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, HEARTBEAT_INTERVAL_MS);

  res.on('close', () => {
    clearInterval(heartbeat);
    const updated = channels.get(channelId);
    if (!updated) return;
    updated.clients.delete(res);
    if (updated.clients.size === 0) {
      channels.delete(channelId);
    }
  });
}

export function attachAbortController(channelId, controller) {
  if (!channelId || !controller) return;
  const entry = ensureChannel(channelId);
  entry.abort = controller;
}

export function emitProgress(channelId, event, data) {
  if (!channelId) return;
  const entry = ensureChannel(channelId);
  if (event === 'cancelled' && entry.abort) {
    try {
      entry.abort.abort();
    } catch {}
  }
  entry.buffer.push({ event, data });
  if (entry.buffer.length > BUFFER_LIMIT) entry.buffer.shift();

  const serialized = JSON.stringify(data);
  for (const res of entry.clients) {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${serialized}\n\n`);
    } catch {
      entry.clients.delete(res);
    }
  }

  if (entry.clients.size === 0) {
    channels.delete(channelId);
  }
}

export function closeChannel(channelId) {
  if (!channelId) return;
  const entry = channels.get(channelId);
  if (!entry) return;
  for (const res of entry.clients) {
    try {
      res.end();
    } catch {
      // ignore
    }
  }
  channels.delete(channelId);
}
