// service-assets/src/services/progressSocket.js
import { jobStates, pendingJobs, sanitizeUserId, serializeJobState } from '../routes/packs.js';
import { registerProgressChannel } from './progressHub.js';

const log = (...msg) => console.log(new Date().toISOString(), '[progress-socket]', ...msg);

function resolveJob(gameId) {
  if (!gameId) return { state: null, pending: null };
  const key = String(gameId);
  return {
    state: jobStates.get(key) || null,
    pending: pendingJobs.get(key) || null,
  };
}

function resolveChannel(state, pending) {
  const channelRaw = state?.progressChannel || pending?.progressChannel || null;
  return channelRaw ? String(channelRaw) : null;
}

function resolveOwner(state, pending) {
  return sanitizeUserId(state?.ownerUserId || pending?.ownerUserId);
}

export function registerProgressSocket(io) {
  if (!io) return;
  io.on('connection', (socket) => {
    log('connect', { id: socket.id });

    socket.on('asset-progress-join', (payload = {}) => {
      const gameId = payload?.gameId ? String(payload.gameId) : null;
      const userId = sanitizeUserId(payload?.userId);
      const channelId = payload?.channelId ? String(payload.channelId) : null;

      if (!gameId && !channelId) {
        socket.emit('asset-progress', { event: 'error', data: { error: 'gameId or channelId required' } });
        return;
      }

      if (gameId) {
        const { state, pending } = resolveJob(gameId);
        const owner = resolveOwner(state, pending);
        if (owner && userId !== owner) {
          socket.emit('asset-progress', { event: 'forbidden', data: { gameId } });
          return;
        }
        const channel = resolveChannel(state, pending);
        socket.join(`asset-progress:game:${gameId}`);
        if (!channel) {
          socket.emit('asset-progress', { event: 'waiting', data: { gameId } });
        } else {
          socket.join(`asset-progress:${channel}`);
          registerProgressChannel(channel, gameId);
        }
        socket.emit('asset-progress', {
          event: 'joined',
          data: { gameId, channel },
        });
        socket.emit('asset-progress', {
          event: 'state',
          data: serializeJobState(state),
        });
        return;
      }

      if (channelId) {
        socket.join(`asset-progress:${channelId}`);
        socket.emit('asset-progress', { event: 'connected', data: { channelId } });
      }
    });

    socket.on('disconnect', (reason) => {
      log('disconnect', { id: socket.id, reason });
    });
  });
}
