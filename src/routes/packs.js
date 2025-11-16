// service-assets/src/routes/packs.js
import { Router } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';
import Joi from 'joi';
import { generateAISVG } from '../services/aiSvgGenerator.js';
import { generatePhotoSpriteSVG } from '../services/photoSpriteGenerator.js';
import { sanitizePrompt } from '../lib/sanitizePrompt.js';
import { renderChessPieceSVG, renderCoverSVG } from '../tri/svgTemplates.js';
import {
  registerClient,
  emitProgress,
  closeChannel,
  attachAbortController,
} from '../services/progressHub.js';

const router = Router();
const log = (...msg) => console.log(new Date().toISOString(), '[packs]', ...msg);

const pendingJobs = new Map(); // gameId -> { controller, progressChannel, packId, startedAt }
const jobStates = new Map(); // gameId -> { packId, renderStyle, baseUrl, manifestUrl, progressChannel, active, pieces, updatedAt }
const jobAdvanceGates = new Map(); // progressChannel -> { pending, awaiting, resolve, timer, cancelled }
const ADVANCE_TIMEOUT_MS = Math.max(1000, Number(process.env.ASSETS_ADVANCE_TIMEOUT_MS || 15000));

function trackPendingJob(gameId, job) {
  if (!gameId) return;
  pendingJobs.set(String(gameId), {
    ...job,
    startedAt: job?.startedAt || Date.now(),
  });
}

function clearPendingJob(gameId, controller) {
  if (!gameId) return;
  const key = String(gameId);
  const job = pendingJobs.get(key);
  if (job && (!controller || job.controller === controller)) {
    pendingJobs.delete(key);
  }
}

function seedJobState(gameId, seed) {
  if (!gameId) return;
  jobStates.set(String(gameId), {
    ...seed,
    active: seed?.active ?? true,
    updatedAt: Date.now(),
  });
}

function updateJobPieceState(gameId, role, variant, patch = {}) {
  if (!gameId) return;
  const state = jobStates.get(String(gameId));
  if (!state) return;
  if (!state.pieces) state.pieces = {};
  const pieceKey = `${role}-${variant}`;
  const existing = state.pieces?.[pieceKey] || { role, variant };
  state.pieces[pieceKey] = {
    ...existing,
    ...patch,
    role,
    variant,
  };
  state.updatedAt = Date.now();
}

function markJobState(gameId, patch = {}) {
  if (!gameId) return;
  const state = jobStates.get(String(gameId));
  if (!state) return;
  Object.assign(state, patch);
  state.updatedAt = Date.now();
}

function markJobStateCancelled(gameId) {
  if (!gameId) return;
  const state = jobStates.get(String(gameId));
  if (!state?.pieces) return;
  Object.values(state.pieces).forEach((piece) => {
    if (!piece) return;
    if (piece.status === 'ready' || piece.status === 'fallback') return;
    piece.status = 'cancelled';
  });
  state.active = false;
  state.updatedAt = Date.now();
}

function serializeJobState(state) {
  if (!state) return null;
  return {
    packId: state.packId || null,
    renderStyle: state.renderStyle || null,
    baseUrl: state.baseUrl || null,
    manifestUrl: state.manifestUrl || null,
    progressChannel: state.progressChannel || null,
    resumePackId: state.resumePackId || null,
    active: Boolean(state.active),
    updatedAt: state.updatedAt || Date.now(),
    pieces: state.pieces || {},
    prompts: collectJobPrompts(state),
  };
}

function initAdvanceGate(channel) {
  if (!channel) return null;
  const key = String(channel);
  if (!jobAdvanceGates.has(key)) {
    jobAdvanceGates.set(key, {
      pending: 0,
      awaiting: false,
      resolve: null,
      timer: null,
      cancelled: false,
    });
  }
  return jobAdvanceGates.get(key);
}

function cleanupAdvanceGate(channel) {
  if (!channel) return;
  const gate = jobAdvanceGates.get(String(channel));
  if (!gate) return;
  gate.cancelled = true;
  if (gate.timer) {
    clearTimeout(gate.timer);
    gate.timer = null;
  }
  if (gate.resolve) {
    gate.resolve({ type: 'cancelled' });
    gate.resolve = null;
  }
  jobAdvanceGates.delete(String(channel));
}

function signalAdvanceGate(channel) {
  if (!channel) return false;
  const gate = jobAdvanceGates.get(String(channel));
  if (!gate) return false;
  if (gate.awaiting && typeof gate.resolve === 'function') {
    gate.resolve({ type: 'advance' });
  } else {
    gate.pending += 1;
  }
  return true;
}

async function waitForAdvanceGate(channel) {
  if (!channel) return { type: 'auto' };
  const gate = initAdvanceGate(channel);
  if (!gate || gate.cancelled) return { type: 'auto' };
  if (gate.pending > 0) {
    gate.pending -= 1;
    return { type: 'queued' };
  }
  gate.awaiting = true;
  return new Promise((resolve) => {
    gate.resolve = resolve;
    gate.timer = setTimeout(() => {
      gate.awaiting = false;
      gate.resolve = null;
      gate.timer = null;
      resolve({ type: 'timeout' });
    }, ADVANCE_TIMEOUT_MS);
  }).finally(() => {
    gate.awaiting = false;
    if (gate.timer) {
      clearTimeout(gate.timer);
      gate.timer = null;
    }
    gate.resolve = null;
  });
}

function collectJobPrompts(state) {
  const prompts = {};
  if (!state?.pieces) return prompts;
  Object.values(state.pieces).forEach((piece) => {
    if (!piece || !piece.prompt) return;
    const key = `${piece.role}-${piece.variant}`;
    prompts[key] = piece.prompt;
  });
  return prompts;
}

function buildPiecesState(piecesList = []) {
  const entries = {};
  if (!Array.isArray(piecesList)) return entries;
  piecesList.forEach((piece) => {
    const role = String(piece?.role || 'token').toLowerCase();
    const isCover = role === 'cover';
    const variants = Array.isArray(piece?.variants) && piece.variants.length
      ? piece.variants
      : [isCover ? 'main' : 'p1'];
    variants.forEach((variantRaw) => {
      const variant = String(variantRaw || (isCover ? 'main' : 'p1')).toLowerCase();
      const key = `${role}-${variant}`;
      entries[key] = {
        role,
        variant,
        status: 'pending',
        url: null,
        prompt: piece?.variantPrompts?.[variant] || piece?.prompt || null,
      };
    });
  });
  return entries;
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
      variantPrompts: Joi.object()
        .pattern(/^[a-z0-9_-]+$/i, Joi.string().allow('', null))
        .optional(),
    })
  ).min(1).default([{ role: 'token', variants: ['p1','p2'] }]),
  size: Joi.number().integer().min(64).max(1024).default(512), // SVG viewBox (square)
  resumePackId: Joi.string().allow('', null),
  reuseExistingPack: Joi.boolean().default(false),
  awaitClientAdvance: Joi.boolean().default(false),
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

function sortFilesMap(files = {}) {
  const sorted = {};
  Object.keys(files)
    .sort((a, b) => a.localeCompare(b))
    .forEach((role) => {
      const variants = files[role] || {};
      const sortedVariants = {};
      Object.keys(variants)
        .sort((a, b) => a.localeCompare(b))
        .forEach((variant) => {
          sortedVariants[variant] = variants[variant];
        });
      sorted[role] = sortedVariants;
    });
  return sorted;
}

async function pathExists(targetPath) {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function resolveVariantPrompt(variantPrompts, variant) {
  if (!variantPrompts || typeof variantPrompts !== 'object') return null;
  const candidates = [
    variant,
    typeof variant === 'string' ? variant.toLowerCase() : null,
    typeof variant === 'string' ? variant.toUpperCase() : null,
  ].filter(Boolean);
  for (const key of candidates) {
    const raw = variantPrompts[key];
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim();
    }
  }
  return null;
}

async function writeManifestSnapshot(baseDir, mirrorDir, packId, manifest) {
  if (!manifest) return;
  const payload = JSON.stringify(manifest, null, 2);
  const manifestPath = path.join(baseDir, 'manifest.json');
  try {
    await fs.writeFile(manifestPath, payload, 'utf8');
  } catch (err) {
    log('manifest write failed', { packId, error: err?.message || err });
  }
  await mirrorWrite(mirrorDir, path.join(packId, 'manifest.json'), payload);
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
  markJobStateCancelled(key);
  const { progressChannel, controller, packId } = job;
  log('cancel job request', { gameId: key, progressChannel, packId });
  if (progressChannel) {
    cleanupAdvanceGate(progressChannel);
  }
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

router.post('/jobs/advance', (req, res) => {
  const { progressChannel } = req.body || {};
  if (!progressChannel) {
    res.status(400).json({ ok: false, error: 'progressChannel required' });
    return;
  }
  const gate = jobAdvanceGates.get(String(progressChannel));
  if (!gate) {
    res.json({ ok: false, error: 'no job waiting on this channel' });
    return;
  }
  const advanced = signalAdvanceGate(progressChannel);
  res.json({
    ok: true,
    advanced: advanced ? true : false,
  });
});

router.get('/jobs/status/:gameId', (req, res) => {
  const { gameId } = req.params || {};
  if (!gameId) {
    res.status(400).json({ ok: false, error: 'gameId required' });
    return;
  }
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    ETag: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  });
  const key = String(gameId);
  const job = pendingJobs.get(key);
  if (!job) {
    res.json({ ok: true, active: false, gameId: key });
    return;
  }
  const { progressChannel = null, packId = null, startedAt = null } = job || {};
  res.json({
    ok: true,
    active: true,
    gameId: key,
    progressChannel,
    packId,
    startedAt,
  });
});

router.get('/state/:gameId', (req, res) => {
  const { gameId } = req.params || {};
  if (!gameId) {
    res.status(400).json({ ok: false, error: 'gameId required' });
    return;
  }
  const key = String(gameId);
  const state = jobStates.get(key);
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    ETag: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  });
  res.json({
    ok: true,
    state: serializeJobState(state),
  });
});

router.get('/jobs/state/:gameId', (req, res) => {
  // Back-compat alias: older clients still call /jobs/state
  const { gameId } = req.params || {};
  if (!gameId) {
    res.status(400).json({ ok: false, error: 'gameId required' });
    return;
  }
  const key = String(gameId);
  const state = jobStates.get(key);
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    ETag: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  });
  res.json({
    ok: true,
    state: serializeJobState(state),
  });
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

router.post('/', async (req, res) => {
  const { value, error } = createSchema.validate(req.body || {}, { stripUnknown: true });
  if (error) return res.status(400).json({ ok: false, error: error.message });

  const {
    gameId = null,
    gameName = null,
    stylePrompt = '',
    progressChannel = null,
    renderStyle = 'vector',
    theme,
    pieces,
    size,
    resumePackId = null,
    reuseExistingPack = false,
    awaitClientAdvance = false,
  } = value;
  const packsDir = req.app.get('packsDir');
  const mirrorDir = req.app.get('packsMirrorDir');
  const mergedPrompt = [gameName, stylePrompt].map((s) => (s || '').trim()).filter(Boolean).join(' — ');
  const pendingKey = gameId ? String(gameId) : null;
  const resumePackIdClean = resumePackId && typeof resumePackId === 'string'
    ? resumePackId.trim()
    : null;

  let resumeSourceDir = null;
  if (resumePackIdClean) {
    const candidate = path.join(packsDir, resumePackIdClean);
    if (await pathExists(candidate)) {
      resumeSourceDir = candidate;
    } else {
      log('resume pack requested but missing', { resumePackId: resumePackIdClean });
    }
  }
  const allowReuseExisting = Boolean(reuseExistingPack && resumeSourceDir);

  if (pendingKey && pendingJobs.has(pendingKey)) {
    log('rejecting concurrent pack request', { gameId: pendingKey });
    emitProgress(progressChannel, 'rejected', {
      gameId: pendingKey,
      reason: 'job_in_progress',
    });
    closeChannel(progressChannel);
    res.status(409).json({
      ok: false,
      error: 'An asset generation job is already running for this game. Please wait for it to finish or cancel it first.',
    });
    return;
  }

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
    resumePackId: resumePackIdClean || '<none>',
    reuseExisting: allowReuseExisting,
  });

  emitProgress(progressChannel, 'start', {
    packId,
    gameId,
    size,
    roles: pieces?.map((p) => p.role) || [],
    renderStyle,
    resumePackId: resumePackIdClean,
    reuseExisting: allowReuseExisting,
  });

  let gateChannel = null;
  if (awaitClientAdvance) {
    if (progressChannel) {
      gateChannel = progressChannel;
      initAdvanceGate(progressChannel);
    } else {
      log('awaitClientAdvance requested but missing progressChannel; ignoring flag', { gameId });
    }
  }

  let upstreamAbortController = null;

  try {
    upstreamAbortController = new AbortController();

    await fs.mkdir(baseDir, { recursive: true });
    await fs.mkdir(piecesDir, { recursive: true });

    const files = {};
    const manifestCreatedAt = new Date().toISOString();
    const buildManifest = (complete = false) => ({
      packId,
      gameId,
      createdAt: manifestCreatedAt,
      updatedAt: new Date().toISOString(),
      theme,
      size,
      files: sortFilesMap(files),
      renderStyle,
      complete,
    });
    const writeManifestPartial = async (complete = false) => {
      await writeManifestSnapshot(baseDir, mirrorDir, packId, buildManifest(complete));
    };
    let cancelled = false;
    const markCancelled = (reason = 'requested') => {
      if (cancelled) return;
      cancelled = true;
      log('pack generation marked cancelled', { packId, gameId, reason });
    };
    if (progressChannel) {
      attachAbortController(progressChannel, upstreamAbortController);
    }
    const onControllerAbort = () => {
      markCancelled('abort-signal');
    };
    upstreamAbortController.signal.addEventListener('abort', onControllerAbort);
    const abortHandler = () => {
      if (cancelled) return;
      markCancelled('client-abort');
      upstreamAbortController.abort();
      emitProgress(progressChannel, 'cancelled', { packId });
      closeChannel(progressChannel);
      clearPendingJob(gameId, upstreamAbortController);
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

    await writeManifestPartial(false);

    const orderedPieces = Array.isArray(pieces)
      ? [...pieces].sort((a, b) => {
          const roleA = String(a?.role || '').toLowerCase();
          const roleB = String(b?.role || '').toLowerCase();
          if (roleA === 'cover' && roleB !== 'cover') return -1;
          if (roleB === 'cover' && roleA !== 'cover') return 1;
          return 0;
        })
      : pieces;

    if (gameId) {
      seedJobState(gameId, {
        packId,
        renderStyle,
        baseUrl: `/skins/${packId}`,
        manifestUrl: `/skins/${packId}/manifest.json`,
        progressChannel,
        resumePackId: resumePackIdClean,
        pieces: buildPiecesState(orderedPieces),
        active: true,
      });
    }

    const totalPieceCount = Array.isArray(orderedPieces)
      ? orderedPieces.reduce(
          (sum, piece) =>
            sum +
            (Array.isArray(piece?.variants) && piece.variants.length
              ? piece.variants.length
              : 0),
          0,
        )
      : 0;
    let remainingPieces = totalPieceCount;

    const awaitAdvanceIfNeeded = async () => {
      if (!gateChannel || cancelled) return true;
      if (remainingPieces <= 0) return true;
      const waitResult = await waitForAdvanceGate(gateChannel);
      if (waitResult?.type === 'timeout') {
        log('client advance timeout', { packId, gameId });
        markCancelled('client-advance-timeout');
        emitProgress(progressChannel, 'cancelled', {
          packId,
          gameId,
          reason: 'client-timeout',
        });
        return false;
      }
      if (waitResult?.type === 'cancelled') {
        markCancelled('client-advance-cancelled');
        return false;
      }
      return true;
    };

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
        const filename = `${variant}.svg`;
        const filePath = path.join(roleDir, filename);
        const reuseSourcePath = allowReuseExisting && resumeSourceDir
          ? path.join(resumeSourceDir, 'pieces', p.role, filename)
          : null;
        let svg = null;
        const variantPromptOverride = resolveVariantPrompt(p.variantPrompts, variant);
        const promptSegments = (variantPromptOverride
          ? [variantPromptOverride]
          : [mergedPrompt, p.prompt]
        ).map((s) => (s || '').trim());
        const piecePrompt = promptSegments.filter(Boolean).join(' — ');
        const promptForAI = piecePrompt || mergedPrompt || variantPromptOverride || '';
        const { prompt: safePrompt, replacements } = sanitizePrompt(promptForAI);
        const promptForModel = safePrompt || promptForAI;
        const wantsPhotoreal = renderStyle === 'photoreal';

        if (gameId) {
          updateJobPieceState(gameId, normalizedRole, variant, { status: 'loading', prompt: promptForModel });
        }

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

        if (reuseSourcePath) {
          try {
            const existingSvg = await fs.readFile(reuseSourcePath, 'utf8');
            await fs.writeFile(filePath, existingSvg, 'utf8');
            await mirrorWrite(mirrorDir, path.join(packId, 'pieces', p.role, filename), existingSvg);

            files[p.role] ||= {};
            files[p.role][variant] = `/skins/${packId}/pieces/${p.role}/${filename}`;

            emitProgress(progressChannel, 'piece', {
              packId,
              role: p.role,
              variant,
              url: files[p.role][variant],
              status: finalStatus,
              reused: true,
              resumePackId: resumePackIdClean,
              prompt: promptForModel,
            });
            if (gameId) {
              updateJobPieceState(gameId, normalizedRole, variant, {
                status: finalStatus,
                url: files[p.role][variant],
                reused: true,
                prompt: promptForModel,
              });
            }
            await writeManifestPartial(false);
            log('reused existing asset', {
              packId,
              role: p.role,
              variant,
              resumePackId: resumePackIdClean,
            });
            remainingPieces -= 1;
            const continueAfterReuse = await awaitAdvanceIfNeeded();
            if (!continueAfterReuse) {
              break;
            }
            continue;
          } catch (reuseErr) {
            if (reuseErr?.code !== 'ENOENT') {
              log('reuse existing asset failed', {
                packId,
                role: p.role,
                variant,
                resumePackId: resumePackIdClean,
                error: reuseErr?.message || reuseErr,
              });
            }
          }
        }

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
            if (cancelled) {
              log('photo sprite result discarded due to cancellation', {
                packId,
                role: p.role,
                variant,
              });
              break;
            }
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
            if (gameId) {
              updateJobPieceState(gameId, normalizedRole, variant, { status: 'error' });
            }
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
            if (cancelled) {
              log('vector svg result discarded due to cancellation', {
                packId,
                role: p.role,
                variant,
              });
              break;
            }
            if (svg) {
              log('vector ai success', {
                packId,
                role: p.role,
                variant,
                length: svg.length,
              });
            }
          }
          if (upstreamAbortController.signal.aborted) {
            cancelled = true;
          }
          if (cancelled) break;

          if (!svg) {
            if (cancelled) break;
            const fallbackSvg = (() => {
              if (normalizedRole === 'cover') {
                const coverSeed = `${gameId || ''}-${packId}-${Date.now()}`;
                log('cover render fallback', {
                  packId,
                  gameId,
                  seed: coverSeed,
                  prompt: promptForModel,
                });
                return renderCoverSVG({
                  size: pieceSize,
                  theme,
                  title: gameName || stylePrompt || 'Custom Game',
                  seed: coverSeed,
                });
              }
              try {
                const fillColor =
                  variant === 'p1'
                    ? theme?.p1Color || '#1e90ff'
                    : variant === 'p2'
                    ? theme?.p2Color || '#ff3b30'
                    : color;
                return renderChessPieceSVG({
                  role: normalizedRole,
                  size: pieceSize,
                  fill: fillColor,
                  accent: theme?.accent || '#ffd60a',
                  outline: theme?.outline || '#202020',
                });
              } catch (err) {
                log('vector fallback render failed', {
                  packId,
                  role: p.role,
                  variant,
                  error: err?.message || err,
                });
                return null;
              }
            })();
            if (fallbackSvg) {
              svg = fallbackSvg;
              finalStatus = 'fallback';
              log('vector generation fallback used', {
                packId,
                role: p.role,
                variant,
              });
            } else {
              finalStatus = 'missing';
              log('vector generation returned empty', {
                packId,
                role: p.role,
                variant,
                reason: promptForAI ? 'AI returned empty' : 'No prompt provided',
              });
            }
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
            if (gameId) {
              updateJobPieceState(gameId, normalizedRole, variant, { status: 'error' });
            }
            throw new Error(`Photoreal generation failed for ${p.role}/${variant}`);
          }

        emitProgress(progressChannel, 'piece', {
          packId,
          role: p.role,
          variant,
          status: 'missing',
        });
        if (gameId) {
          updateJobPieceState(gameId, normalizedRole, variant, { status: 'missing' });
        }
        remainingPieces -= 1;
        const continueAfterMissing = await awaitAdvanceIfNeeded();
        if (!continueAfterMissing) {
          break;
        }
        continue;
      }
        if (cancelled) {
          log('skip writing piece due to cancellation', { packId, role: p.role, variant });
          break;
        }
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
          prompt: promptForModel,
        });

        if (gameId) {
          updateJobPieceState(gameId, normalizedRole, variant, {
            status: finalStatus,
            url: files[p.role][variant],
            prompt: promptForModel,
          });
        }

        await writeManifestPartial(false);
        remainingPieces -= 1;
        const shouldContinue = await awaitAdvanceIfNeeded();
        if (!shouldContinue) {
          break;
        }
      }
    }

    if (typeof req.off === 'function') {
      req.off('aborted', abortHandler);
      req.off('close', abortHandler);
    } else {
      req.removeListener('aborted', abortHandler);
      req.removeListener('close', abortHandler);
    }
    upstreamAbortController.signal.removeEventListener('abort', onControllerAbort);

    if (cancelled) {
      if (gameId) {
        markJobStateCancelled(gameId);
      }
      clearPendingJob(gameId, upstreamAbortController);
      try {
        await writeManifestPartial(false);
      } catch (manifestErr) {
        log('failed to persist cancelled manifest', { packId, error: manifestErr?.message || manifestErr });
      }
      log('pack generation cancelled (partial assets preserved)', { packId, baseDir });
      res.status(499).json({
        ok: false,
        cancelled: true,
        error: 'cancelled',
        packId,
        baseUrl: `/skins/${packId}/`,
        manifestUrl: `/skins/${packId}/manifest.json`,
        files,
        renderStyle,
      });
      return;
    }

    const finalManifest = buildManifest(true);
    await writeManifestSnapshot(baseDir, mirrorDir, packId, finalManifest);
    log('pack ready', { packId, pieces: Object.keys(files).length, manifest: `/skins/${packId}/manifest.json` });
    const stateSnapshot = gameId ? jobStates.get(String(gameId)) : null;
    const promptSnapshot = collectJobPrompts(stateSnapshot);
    emitProgress(progressChannel, 'complete', {
      packId,
      manifestUrl: `/skins/${packId}/manifest.json`,
      files,
      renderStyle,
      prompts: promptSnapshot,
    });
    closeChannel(progressChannel);
    if (gameId && upstreamAbortController) {
      clearPendingJob(gameId, upstreamAbortController);
    }
    if (gameId) {
      markJobState(gameId, { active: false });
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
    if (gameId) {
      markJobState(gameId, { active: false });
    }
    emitProgress(progressChannel, 'error', {
      packId,
      error: err?.message || err,
    });
    closeChannel(progressChannel);
    if (gameId && upstreamAbortController) {
      clearPendingJob(gameId, upstreamAbortController);
    }
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (gateChannel) {
      cleanupAdvanceGate(gateChannel);
    }
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
