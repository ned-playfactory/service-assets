// service-assets/src/server.js
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import packsRouter from './routes/packs.js';
import { setProgressSocketServer } from './services/progressHub.js';
import { registerProgressSocket } from './services/progressSocket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 7012;

// definitive env var (ignore SKINS_DIR)
const PACKS_DIR =
  process.env.ASSETS_PACKS_DIR ||
  path.join(__dirname, 'assets', 'packs');
const AVATAR_DIR =
  process.env.ASSETS_AVATAR_DIR ||
  path.join(__dirname, 'assets', 'avatars');

// make sure it exists
try {
  fs.mkdirSync(PACKS_DIR, { recursive: true });
} catch (e) {
  // eslint-disable-next-line no-console
  console.error('[assets] failed to create packs dir:', PACKS_DIR, e);
  process.exit(1);
}

try {
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
} catch (e) {
  // eslint-disable-next-line no-console
  console.error('[assets] failed to create avatar dir:', AVATAR_DIR, e);
}

app.set('packsDir', PACKS_DIR);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));
const HTTP_LOG_MODE = (process.env.ASSETS_HTTP_LOG_MODE || 'reduced').toLowerCase();
app.use(
  morgan('dev', {
    skip: (req) => {
      if (HTTP_LOG_MODE === 'full') return false;
      const url = String(req?.originalUrl || req?.url || '');
      if (!url) return false;
      // Avoid noisy polling + static asset fetches (enable with ASSETS_HTTP_LOG_MODE=full)
      if (url === '/health' || url === '/api/skins/health') return true;
      if (url.startsWith('/api/skins/packs/state/')) return true;
      if (url.startsWith('/api/skins/packs/jobs/status/')) return true;
      if (url.startsWith('/api/skins/packs/progress/')) return true;
      const method = String(req?.method || '').toUpperCase();
      if ((method === 'GET' || method === 'HEAD') && (url.startsWith('/skins/') || url.startsWith('/avatars/'))) {
        return true;
      }
      return false;
    },
  }),
);

// Serve generated packs as /skins/<packId>/...
app.use('/skins', express.static(PACKS_DIR, { fallthrough: true }));
app.use('/avatars', express.static(AVATAR_DIR, { fallthrough: true }));

// Health
const health = (_req, res) => res.json({ ok: true, service: 'assets', packsDir: PACKS_DIR, uptime: process.uptime() });
app.get('/health', health);
app.get('/api/skins/health', health);

// API root
app.get('/api/skins', (_req, res) => res.json({ ok: true, msg: 'skins API root', packsDir: PACKS_DIR }));

// Packs API
app.use('/api/skins/packs', packsRouter);

// Avatar upload (simple base64 -> file)
app.post('/api/avatars', express.json({ limit: '6mb' }), (req, res) => {
  try {
    const rawBase64 = req.body?.avatar;
    const userIdRaw = req.body?.userId;
    const username = String(req.body?.username || 'user').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'user';
    const safeUserId = userIdRaw ? String(userIdRaw).replace(/[^a-zA-Z0-9_-]/g, '') : '';
    if (!rawBase64 || typeof rawBase64 !== 'string' || !rawBase64.startsWith('data:image/')) {
      res.status(400).json({ ok: false, error: 'Invalid avatar payload' });
      return;
    }
    const mimeMatch = rawBase64.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
    const ext = mimeMatch ? (mimeMatch[1].split('/')[1] || 'png') : 'png';
    const safeExt = ext.toLowerCase().includes('jpeg') ? 'jpg' : ext.toLowerCase();
    const baseName = safeUserId || username || (randomUUID?.() || Date.now());
    const filename = `${baseName}.${safeExt}`;
    const outputPath = path.join(AVATAR_DIR, filename);
    const base64Data = rawBase64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
    fs.writeFileSync(outputPath, base64Data, 'base64');
    const publicPath = `/avatars/${filename}`;
    res.status(201).json({ ok: true, url: publicPath, filename });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[avatars] upload failed', err?.message || err);
    res.status(500).json({ ok: false, error: 'Avatar upload failed' });
  }
});

// 404
app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not Found' }));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' },
  path: '/socket.io-assets',
  pingInterval: 5000,
  pingTimeout: 5000,
});
setProgressSocketServer(io);
registerProgressSocket(io);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[assets] listening on :${PORT}, packs dir: ${PACKS_DIR}`);
});
