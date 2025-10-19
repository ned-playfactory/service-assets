import { nanoid } from 'nanoid';
import path from 'path';
import { generateTokenSvg } from '../services/generator.service.js';
import { writeTextFile, skinsAbsPath } from '../services/storage.service.js';
import { cfg } from '../config/index.js';

export async function generateSkin(req, res, next) {
  try {
    const { gameId, role='token', player, label='', theme={}, size={} } = req.valid;
    const { w=90, h=90 } = size;
    const { fill, stroke, text } = theme;
    const svg = generateTokenSvg({ w, h, fill, stroke, text, label });

    const day = new Date().toISOString().slice(0,10);
    const id = nanoid(8);
    const filename = `${gameId}-${role}-p${player}-${id}.svg`;
    const relPath = `/${cfg.skinsRoot}/${gameId}/${day}/${filename}`;
    const absPath = skinsAbsPath(cfg.publicDir, relPath);
    await writeTextFile(absPath, svg);

    res.json({ ok:true, skin:{ id, relPath, url: relPath, contentType:'image/svg+xml', width:w, height:h } });
  } catch (e) { next(e); }
}
