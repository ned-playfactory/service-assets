// service-assets/src/routes/packs.js
import { Router } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';
import Joi from 'joi';
import { generateAISVG } from '../services/aiSvgGenerator.js';
import { generatePhotoSpriteSVG } from '../services/photoSpriteGenerator.js';
import { sanitizePrompt } from '../lib/sanitizePrompt.js';
import {
  registerClient,
  emitProgress,
  closeChannel,
  attachAbortController,
} from '../services/progressHub.js';

const router = Router();
const log = (...msg) => console.log(new Date().toISOString(), '[packs]', ...msg);

const pendingJobs = new Map(); // gameId -> { controller, progressChannel, packId }

function trackPendingJob(gameId, job) {
  if (!gameId) return;
  pendingJobs.set(String(gameId), job);
}

function clearPendingJob(gameId, controller) {
  if (!gameId) return;
  const key = String(gameId);
  const job = pendingJobs.get(key);
  if (job && (!controller || job.controller === controller)) {
    pendingJobs.delete(key);
  }
}

const createSchema = Joi.object({
  gameId: Joi.string().allow('', null),
  gameName: Joi.string().allow('', null),
  stylePrompt: Joi.string().allow('', null),
  renderStyle: Joi.string().valid('vector', 'photoreal').default('vector'),
  progressChannel: Joi.string().allow('', null),
  theme: Joi.object({
    p1Color: Joi.string().default('#1e90ff'),
    p2Color: Joi.string().default('#ff3b30'),
    accent:  Joi.string().default('#ffd60a'),
    outline: Joi.string().default('#202020')
  }).default(),
  pieces: Joi.array().items(
    Joi.object({
      role: Joi.string().required(),          // e.g. "token"
      variants: Joi.array().items(Joi.string()).default(['p1','p2']),
      prompt: Joi.string().allow('', null),
    })
  ).min(1).default([{ role: 'token', variants: ['p1','p2'] }]),
  size: Joi.number().integer().min(64).max(1024).default(512) // SVG viewBox (square)
});

function fileUrl(base, ...p) {
  const joined = ['','skins', ...p].join('/').replace(/\/+/g, '/');
  return base ? `${base}${joined}` : joined; // base is the apache-proxied origin
}

router.get('/progress/:channelId', (req, res) => {
  const { channelId } = req.params;
  if (!channelId) {
    res.status(400).json({ ok: false, error: 'Channel id required' });
    return;
  }
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(`event: connected\ndata: {"channel":"${channelId}"}\n\n`);
  registerClient(channelId, res);
});

async function mirrorWrite(root, relPath, contents) {
  if (!root) return;
  const dest = path.join(root, relPath);
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, contents, 'utf8');
    log('mirrored asset', { dest });
  } catch (err) {
    log('mirror write failed', { dest, error: err?.message || err });
  }
}

router.get('/', async (req, res) => {
  const packsDir = req.app.get('packsDir');
  try {
    log('GET /api/skins/packs listing packsDir=', packsDir);
    const items = await fs.readdir(packsDir, { withFileTypes: true }).catch(() => []);
    const packs = items.filter(d => d.isDirectory()).map(d => d.name);
    res.json({ ok: true, packs });
  } catch (err) {
    log('list packs failed:', err?.message || err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  const packsDir = req.app.get('packsDir');
  const packId = req.params.id;
  try {
    const manifestPath = path.join(packsDir, packId, 'manifest.json');
    log('GET pack manifest', { packId, manifestPath });
    const buf = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(buf);
    res.json({ ok: true, packId, manifest });
  } catch {
    log('pack not found', packId);
    res.status(404).json({ ok: false, error: 'Pack not found' });
  }
});

router.post('/jobs/cancel', (req, res) => {
  const { gameId, reason = 'cancelled' } = req.body || {};
  if (!gameId) {
    res.status(400).json({ ok: false, error: 'gameId required' });
    return;
  }
  const key = String(gameId);
  const job = pendingJobs.get(key);
  if (!job) {
    res.json({ ok: true, cancelled: false, message: 'no active job for gameId' });
    return;
  }
  pendingJobs.delete(key);
  const { progressChannel, controller, packId } = job;
  log('cancel job request', { gameId: key, progressChannel, packId });
  try {
    if (controller) controller.abort();
  } catch (err) {
    log('cancel job controller abort failed', err?.message || err);
  }
  if (progressChannel) {
    emitProgress(progressChannel, 'cancelled', {
      packId,
      gameId: key,
      reason,
    });
    closeChannel(progressChannel);
  }
  res.json({ ok: true, cancelled: true, gameId: key });
});

router.post('/', async (req, res) => {
  const { value, error } = createSchema.validate(req.body || {}, { stripUnknown: true });
  if (error) return res.status(400).json({ ok: false, error: error.message });

  const { gameId = null, gameName = null, stylePrompt = '', progressChannel = null, renderStyle = 'vector', theme, pieces, size } = value;
  const packsDir = req.app.get('packsDir');
  const mirrorDir = req.app.get('packsMirrorDir');
  const mergedPrompt = [gameName, stylePrompt].map((s) => (s || '').trim()).filter(Boolean).join(' — ');

  const packId = `pack_${Date.now()}_${nanoid(6)}`;
  const baseDir = path.join(packsDir, packId);
  const piecesDir = path.join(baseDir, 'pieces');
  log('POST create pack', {
    packId,
    gameId,
    size,
    roles: pieces?.map((p) => p.role).join(',') || '<none>',
    packsDir,
    stylePrompt: mergedPrompt || '<none>',
    renderStyle,
  });

  emitProgress(progressChannel, 'start', {
    packId,
    gameId,
    size,
    roles: pieces?.map((p) => p.role) || [],
    renderStyle,
  });

  let upstreamAbortController = null;

  try {
    upstreamAbortController = new AbortController();

    await fs.mkdir(baseDir, { recursive: true });
    await fs.mkdir(piecesDir, { recursive: true });

    const files = {};
    let cancelled = false;
    if (progressChannel) {
      attachAbortController(progressChannel, upstreamAbortController);
    }
    const abortHandler = () => {
      if (!cancelled) {
        cancelled = true;
        upstreamAbortController.abort();
        emitProgress(progressChannel, 'cancelled', { packId });
        closeChannel(progressChannel);
        clearPendingJob(gameId, upstreamAbortController);
      }
    };
    req.on('aborted', abortHandler);
    req.on('close', abortHandler);

    if (gameId) {
      trackPendingJob(gameId, {
        controller: upstreamAbortController,
        progressChannel,
        packId,
      });
    }

    const orderedPieces = Array.isArray(pieces)
      ? [...pieces].sort((a, b) => {
          const roleA = String(a?.role || '').toLowerCase();
          const roleB = String(b?.role || '').toLowerCase();
          if (roleA === 'cover' && roleB !== 'cover') return -1;
          if (roleB === 'cover' && roleA !== 'cover') return 1;
          return 0;
        })
      : pieces;

    for (const p of orderedPieces) {
      if (cancelled) break;
      const roleDir = path.join(piecesDir, p.role);
      await fs.mkdir(roleDir, { recursive: true });

      for (const vRaw of p.variants) {
        if (cancelled) break;
        const normalizedRole = String(p.role || '').toLowerCase();
        const isCover = normalizedRole === 'cover';
        const variant = String(vRaw || (isCover ? 'main' : 'p1')).toLowerCase();
        const color = variant === 'p1' ? theme.p1Color : (variant === 'p2' ? theme.p2Color : theme.accent);
        const pieceSize = isCover ? Math.max(size, 768) : size;
        let svg = null;
        const piecePrompt = [mergedPrompt, p.prompt]
          .map((s) => (s || '').trim())
          .filter(Boolean)
          .join(' — ');
        const promptForAI = piecePrompt || mergedPrompt;
        const { prompt: safePrompt, replacements } = sanitizePrompt(promptForAI);
        const promptForModel = safePrompt || promptForAI;
        const wantsPhotoreal = renderStyle === 'photoreal';

        if (replacements.length && Array.isArray(replacements) && replacements.length > 0) {
          log('prompt sanitized', {
            packId,
            role: p.role,
            variant,
            replacements,
          });
          emitProgress(progressChannel, 'notice', {
            packId,
            role: p.role,
            variant,
            replacements,
          });
        }

        emitProgress(progressChannel, 'piece-start', {
          packId,
          role: p.role,
          variant,
          status: 'loading',
        });

        log('generate piece', {
          packId,
          role: p.role,
          variant,
          renderStyle,
          prompt: (promptForModel || '').slice(0, 160),
        });

        let finalStatus = 'ready';

        if (wantsPhotoreal) {
          if (!promptForModel) {
            throw new Error(`Photoreal rendering requires a prompt for ${p.role}/${variant}`);
          }
          try {
            log('photo sprite request', {
              packId,
              role: p.role,
              variant,
              promptPreview: promptForModel.slice(0, 160),
              size: pieceSize,
            });
            svg = await generatePhotoSpriteSVG({
              role: p.role,
              variant,
              prompt: promptForModel,
              size: pieceSize,
              theme,
              signal: upstreamAbortController.signal,
            });
            if (svg) {
              const hasPngImage = /data:image\/png;base64,/i.test(svg);
              log('photo sprite success', {
                packId,
                role: p.role,
                variant,
                hasPngImage,
                length: svg.length,
              });
              if (!hasPngImage) {
                log('photo sprite warning', {
                  packId,
                  role: p.role,
                  variant,
                  message: 'SVG returned without embedded PNG payload.',
                });
              }
            }
          } catch (err) {
            if (cancelled || upstreamAbortController.signal.aborted || err?.message?.includes('cancelled')) {
              cancelled = true;
              break;
            }
            log('photo sprite generation failed', err?.message || err);
            emitProgress(progressChannel, 'piece-error', {
              packId,
              role: p.role,
              variant,
              error: err?.message || err,
            });
            throw new Error(
              `Photoreal generation failed for ${p.role}/${variant}: ${err?.message || err}`
            );
          }
          if (!svg) {
            log('photo sprite generation returned empty', { role: p.role, variant });
            emitProgress(progressChannel, 'piece-error', {
              packId,
              role: p.role,
              variant,
              error: `Photoreal generation failed for ${p.role}/${variant}`,
            });
            throw new Error(`Photoreal generation failed for ${p.role}/${variant}`);
          }
        } else {
          if (promptForModel) {
            log('vector ai request', {
              packId,
              role: p.role,
              variant,
              promptPreview: promptForModel.slice(0, 160),
              size: pieceSize,
            });
            svg = await generateAISVG({
              role: p.role,
              variant,
              prompt: promptForModel,
              size: pieceSize,
              theme,
              signal: upstreamAbortController.signal,
            });
            if (svg) {
              log('vector ai success', {
                packId,
                role: p.role,
                variant,
                length: svg.length,
              });
            }
          }
          if (!svg) {
            finalStatus = 'missing';
            log('vector generation returned empty', {
              packId,
              role: p.role,
              variant,
              reason: promptForAI ? 'AI returned empty' : 'No prompt provided',
            });
          } else {
            finalStatus = 'ready';
          }
        }

        if (cancelled) break;

        if (!svg) {
          if (wantsPhotoreal) {
            emitProgress(progressChannel, 'piece-error', {
              packId,
              role: p.role,
              variant,
              error: `Photoreal generation failed for ${p.role}/${variant}`,
            });
            throw new Error(`Photoreal generation failed for ${p.role}/${variant}`);
          }

          emitProgress(progressChannel, 'piece', {
            packId,
            role: p.role,
            variant,
            status: 'missing',
          });
          continue;
        }
        const filename = `${variant}.svg`;
        const filePath = path.join(roleDir, filename);
        await fs.writeFile(filePath, svg, 'utf8');
        log('   wrote asset', { packId, role: p.role, variant, filePath });
        await mirrorWrite(mirrorDir, path.join(packId, 'pieces', p.role, filename), svg);

        files[p.role] ||= {};
        files[p.role][variant] = `/skins/${packId}/pieces/${p.role}/${filename}`;

        emitProgress(progressChannel, 'piece', {
          packId,
          role: p.role,
          variant,
          url: files[p.role][variant],
          status: finalStatus,
        });
      }
    }

    if (typeof req.off === 'function') {
      req.off('aborted', abortHandler);
      req.off('close', abortHandler);
    } else {
      req.removeListener('aborted', abortHandler);
      req.removeListener('close', abortHandler);
    }

    if (cancelled) {
      clearPendingJob(gameId, upstreamAbortController);
      try {
        await fs.rm(baseDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failure
      }
      return;
    }

    const manifest = {
      packId,
      gameId,
      createdAt: new Date().toISOString(),
      theme,
      size,
      files,
      renderStyle,
    };
    await fs.writeFile(path.join(baseDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    log('pack ready', { packId, pieces: Object.keys(files).length, manifest: `/skins/${packId}/manifest.json` });
    await mirrorWrite(mirrorDir, path.join(packId, 'manifest.json'), JSON.stringify(manifest, null, 2));
    emitProgress(progressChannel, 'complete', {
      packId,
      manifestUrl: `/skins/${packId}/manifest.json`,
      files,
      renderStyle,
    });
    closeChannel(progressChannel);
    if (gameId && upstreamAbortController) {
      clearPendingJob(gameId, upstreamAbortController);
    }

    res.status(201).json({
      ok: true,
      packId,
      baseUrl: `/skins/${packId}/`,
      files,
      manifestUrl: `/skins/${packId}/manifest.json`,
      renderStyle,
    });
  } catch (err) {
    log('pack creation failed', { packId, error: err?.message || err });
    emitProgress(progressChannel, 'error', {
      packId,
      error: err?.message || err,
    });
    closeChannel(progressChannel);
    if (gameId && upstreamAbortController) {
      clearPendingJob(gameId, upstreamAbortController);
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  const packsDir = req.app.get('packsDir');
  const mirrorDir = req.app.get('packsMirrorDir');
  const packId = req.params.id;
  if (!packId) {
    return res.status(400).json({ ok: false, error: 'packId required' });
  }

  const packPath = path.join(packsDir, packId);
  const mirrorPath = mirrorDir ? path.join(mirrorDir, packId) : null;

  try {
    const stat = await fs.stat(packPath).catch(() => null);
    if (!stat) {
      return res.json({ ok: true, packId, deleted: false });
    }

    await fs.rm(packPath, { recursive: true, force: true });
    if (mirrorPath) {
      await fs.rm(mirrorPath, { recursive: true, force: true }).catch(() => {});
    }
    log('deleted pack directory', { packId });
    res.json({ ok: true, packId, deleted: true });
  } catch (err) {
    log('delete pack failed', { packId, error: err?.message || err });
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

export default router;
