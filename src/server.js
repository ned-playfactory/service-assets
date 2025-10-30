// service-assets/src/server.js
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import packsRouter from './routes/packs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 7012;

// definitive env var (ignore SKINS_DIR)
const PACKS_DIR =
  process.env.ASSETS_PACKS_DIR ||
  path.join(__dirname, 'assets', 'packs');
const MIRROR_DIR = process.env.ASSETS_MIRROR_DIR || '';

// make sure it exists
try {
  fs.mkdirSync(PACKS_DIR, { recursive: true });
} catch (e) {
  // eslint-disable-next-line no-console
  console.error('[assets] failed to create packs dir:', PACKS_DIR, e);
  process.exit(1);
}

app.set('packsDir', PACKS_DIR);
if (MIRROR_DIR) {
  try {
    fs.mkdirSync(MIRROR_DIR, { recursive: true });
    app.set('packsMirrorDir', MIRROR_DIR);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[assets] failed to init mirror dir', MIRROR_DIR, err?.message || err);
    app.set('packsMirrorDir', null);
  }
} else {
  app.set('packsMirrorDir', null);
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

// Serve generated packs as /skins/<packId>/...
app.use('/skins', express.static(PACKS_DIR, { fallthrough: true }));

// Health
const health = (_req, res) => res.json({ ok: true, service: 'assets', packsDir: PACKS_DIR, uptime: process.uptime() });
app.get('/health', health);
app.get('/api/skins/health', health);

// API root
app.get('/api/skins', (_req, res) => res.json({ ok: true, msg: 'skins API root', packsDir: PACKS_DIR }));

// Packs API
app.use('/api/skins/packs', packsRouter);

// 404
app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not Found' }));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[assets] listening on :${PORT}, packs dir: ${PACKS_DIR}`);
});
