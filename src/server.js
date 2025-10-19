// service-assets/src/server.js
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import packsRouter from './routes/packs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 7012;

// where generated files live (compose volume points here)
const PACKS_DIR = process.env.ASSETS_PACKS_DIR || path.join(__dirname, 'assets', 'packs');

app.set('packsDir', PACKS_DIR);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

// Static generated assets: served under /skins/<packId>/...
app.use('/skins', express.static(PACKS_DIR, { fallthrough: true }));

// Health on both root and proxied path
const health = (req, res) => res.json({ ok: true, service: 'assets', uptime: process.uptime() });
app.get('/health', health);
app.get('/api/skins/health', health);

// Minimal root
app.get('/api/skins', (req, res) => res.json({ ok: true, msg: 'skins API root' }));

// Packs API
app.use('/api/skins/packs', packsRouter);

// 404
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not Found' }));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[assets] listening on :${PORT}, packs dir: ${PACKS_DIR}`);
});
