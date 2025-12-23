// service-assets/src/services/progressHub.js
// Socket-driven progress hub (SSE removed).

const channelToGame = new Map(); // channelId -> gameId
const abortControllers = new Map(); // channelId -> AbortController
let ioRef = null;

export function setProgressSocketServer(io) {
  ioRef = io;
}

function channelRoom(channelId) {
  return channelId ? `asset-progress:${channelId}` : null;
}

function gameRoom(gameId) {
  return gameId ? `asset-progress:game:${gameId}` : null;
}

export function registerProgressChannel(channelId, gameId) {
  if (!channelId || !gameId) return;
  channelToGame.set(String(channelId), String(gameId));
}

export function attachAbortController(channelId, controller) {
  if (!channelId || !controller) return;
  abortControllers.set(String(channelId), controller);
}

export function emitProgress(channelId, event, data) {
  if (!channelId || !ioRef) return;
  const room = channelRoom(String(channelId));
  if (!room) return;
  const gameId = data?.gameId ? String(data.gameId) : channelToGame.get(String(channelId)) || null;
  const gameRoomKey = gameRoom(gameId);
  if (event === 'cancelled') {
    const controller = abortControllers.get(String(channelId));
    if (controller) {
      try {
        controller.abort();
      } catch {}
    }
  }
  ioRef.to(room).emit('asset-progress', { event, data });
  if (gameRoomKey) {
    ioRef.to(gameRoomKey).emit('asset-progress', { event, data });
  }
}

export function getClientCount(channelId, gameId = null) {
  if (!ioRef) return 0;
  const channel = channelId ? String(channelId) : null;
  const gid = gameId ? String(gameId) : channelToGame.get(channel || '') || null;
  const channelKey = channel ? channelRoom(channel) : null;
  const gameKey = gameRoom(gid);
  const channelSize = channelKey ? ioRef.sockets?.adapter?.rooms?.get(channelKey)?.size : 0;
  const gameSize = gameKey ? ioRef.sockets?.adapter?.rooms?.get(gameKey)?.size : 0;
  return (channelSize || 0) + (gameSize || 0);
}

export function closeChannel(channelId) {
  if (!channelId || !ioRef) return;
  const room = channelRoom(String(channelId));
  if (!room) return;
  ioRef.to(room).emit('asset-progress', { event: 'close', data: { channelId } });
  abortControllers.delete(String(channelId));
}
