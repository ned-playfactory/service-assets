// service-assets/src/routes/packs.js
import { Router } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';
import Joi from 'joi';
import { renderTokenSVG } from '../tri/svgTemplates.js';

const router = Router();

const createSchema = Joi.object({
  gameId: Joi.string().allow('', null),
  theme: Joi.object({
    p1Color: Joi.string().default('#1e90ff'),
    p2Color: Joi.string().default('#ff3b30'),
    accent:  Joi.string().default('#ffd60a'),
    outline: Joi.string().default('#202020')
  }).default(),
  pieces: Joi.array().items(
    Joi.object({
      role: Joi.string().required(),          // e.g. "token"
      variants: Joi.array().items(Joi.string()).default(['p1','p2'])
    })
  ).min(1).default([{ role: 'token', variants: ['p1','p2'] }]),
  size: Joi.number().integer().min(64).max(1024).default(512) // SVG viewBox (square)
});

function fileUrl(base, ...p) {
  const joined = ['','skins', ...p].join('/').replace(/\/+/g, '/');
  return base ? `${base}${joined}` : joined; // base is the apache-proxied origin
}

router.get('/', async (req, res) => {
  const packsDir = req.app.get('packsDir');
  try {
    const items = await fs.readdir(packsDir, { withFileTypes: true }).catch(() => []);
    const packs = items.filter(d => d.isDirectory()).map(d => d.name);
    res.json({ ok: true, packs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  const packsDir = req.app.get('packsDir');
  const packId = req.params.id;
  try {
    const manifestPath = path.join(packsDir, packId, 'manifest.json');
    const buf = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(buf);
    res.json({ ok: true, packId, manifest });
  } catch {
    res.status(404).json({ ok: false, error: 'Pack not found' });
  }
});

router.post('/', async (req, res) => {
  const { value, error } = createSchema.validate(req.body || {}, { stripUnknown: true });
  if (error) return res.status(400).json({ ok: false, error: error.message });

  const { gameId = null, theme, pieces, size } = value;
  const packsDir = req.app.get('packsDir');

  const packId = `pack_${Date.now()}_${nanoid(6)}`;
  const baseDir = path.join(packsDir, packId);
  const piecesDir = path.join(baseDir, 'pieces');

  try {
    await fs.mkdir(baseDir, { recursive: true });
    await fs.mkdir(piecesDir, { recursive: true });

    const files = {};
    for (const p of pieces) {
      const roleDir = path.join(piecesDir, p.role);
      await fs.mkdir(roleDir, { recursive: true });

      for (const v of p.variants) {
        const color = v === 'p1' ? theme.p1Color : (v === 'p2' ? theme.p2Color : theme.accent);
        const svg = renderTokenSVG({ size, fill: color, accent: theme.accent, outline: theme.outline });
        const filename = `${v}.svg`;
        const filePath = path.join(roleDir, filename);
        await fs.writeFile(filePath, svg, 'utf8');

        files[p.role] ||= {};
        files[p.role][v] = `/skins/${packId}/pieces/${p.role}/${filename}`;
      }
    }

    const manifest = {
      packId,
      gameId,
      createdAt: new Date().toISOString(),
      theme,
      size,
      files
    };
    await fs.writeFile(path.join(baseDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    res.status(201).json({
      ok: true,
      packId,
      baseUrl: `/skins/${packId}/`,
      files,
      manifestUrl: `/skins/${packId}/manifest.json`
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
