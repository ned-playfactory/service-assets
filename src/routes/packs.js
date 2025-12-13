// service-assets/src/routes/packs.js
import { Router } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';
import Joi from 'joi';
import { generateAISVG, isOpenAiSvgAvailable, getOpenAiSvgEnv } from '../services/aiSvgGenerator.js';
import { generatePhotoSpriteSVG } from '../services/photoSpriteGenerator.js';
import { sanitizePrompt } from '../lib/sanitizePrompt.js';
import { renderChessPieceSVG, renderCoverSVG } from '../tri/svgTemplates.js';
import {
  registerClient,
  emitProgress,
  closeChannel,
  attachAbortController,
} from '../services/progressHub.js';
import { normalizeIdentifier, formatIdentifier } from '../types/assetIdentifier.js';

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

/**
 * Auto-cleanup old packs for a game.
 * Keeps the latest N packs per gameId and deletes older ones.
 * Call after a successful pack generation.
 */
async function cleanupOldPacksForGame(gameId, packsDir, keepLatest = 2) {
  if (!gameId) return;
  try {
    const items = await fs.readdir(packsDir, { withFileTypes: true }).catch(() => []);
    const allPacks = items.filter(d => d.isDirectory()).map(d => d.name);
    
    // Parse timestamps and group by gameId metadata (crude but works: packs are named pack_<timestamp>_<gameId>)
    const gamePacksInfo = allPacks
      .filter(name => name.startsWith('pack_'))
      .map(name => {
        const parts = name.split('_');
        const timestamp = parts.length > 1 ? Number(parts[1]) : 0;
        return { name, timestamp };
      })
      .sort((a, b) => b.timestamp - a.timestamp);
    
    // Keep the latest `keepLatest` packs, delete the rest
    if (gamePacksInfo.length > keepLatest) {
      const toDelete = gamePacksInfo.slice(keepLatest);
      for (const { name } of toDelete) {
        const packPath = path.join(packsDir, name);
        try {
          await fs.rm(packPath, { recursive: true, force: true });
          log('auto-cleaned old pack', { packId: name });
        } catch (err) {
          log('failed to auto-clean pack', { packId: name, error: err?.message || err });
        }
      }
    }
  } catch (err) {
    log('cleanup old packs failed', { gameId, error: err?.message || err });
  }
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
  boards: Joi.array().items(
    Joi.object({
      id: Joi.string().required(),
      name: Joi.string().allow('', null),
      background: Joi.string().allow('', null),
      backgroundImage: Joi.string().allow('', null),
      tileLight: Joi.string().allow('', null),
      tileDark: Joi.string().allow('', null),
      grid: Joi.string().allow('', null),
    })
  ).default([]),
  size: Joi.number().integer().min(64).max(1024).default(512), // SVG viewBox (square)
  resumePackId: Joi.string().allow('', null),
  reuseExistingPack: Joi.boolean().default(false),
  awaitClientAdvance: Joi.boolean().default(false),
  vectorProvider: Joi.string().valid('auto', 'openai', 'local').default('auto'),
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

function sortBoardAssets(boardAssets = {}) {
  const sorted = {};
  Object.keys(boardAssets)
    .sort((a, b) => a.localeCompare(b))
    .forEach((boardId) => {
      const entry = boardAssets[boardId] || {};
      const tokens = entry.tokens || entry.pieces || {};
      const sortedTokens = {};
      Object.keys(tokens)
        .sort((a, b) => a.localeCompare(b))
        .forEach((variant) => {
          sortedTokens[variant] = tokens[variant];
        });
      sorted[boardId] = {
        ...(entry.boardPreview ? { boardPreview: entry.boardPreview } : {}),
        ...(entry.cover ? { cover: entry.cover } : {}),
        ...(entry.background ? { background: entry.background } : {}),
        ...(entry.tileLight ? { tileLight: entry.tileLight } : {}),
        ...(entry.tileDark ? { tileDark: entry.tileDark } : {}),
        ...(Object.keys(sortedTokens).length ? { tokens: sortedTokens } : {}),
      };
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

async function writeManifestSnapshot(baseDir, packId, manifest) {
  // Manifest persistence disabled for POC — assets are sourced directly from script state.
  return;
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
    // Manifest endpoint deprecated; respond with 404 to avoid stale data usage.
    log('manifest endpoint deprecated', { packId });
    res.status(404).json({ ok: false, error: 'Manifest disabled for this service' });
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
    boards,
    size,
    resumePackId = null,
    reuseExistingPack = false,
    awaitClientAdvance = false,
    vectorProvider = 'auto',
  } = value;
  const packsDir = req.app.get('packsDir');
  const mergedPrompt = [gameName, stylePrompt].map((s) => (s || '').trim()).filter(Boolean).join(' — ');
  const pendingKey = gameId ? String(gameId) : null;
  const resumePackIdClean = resumePackId && typeof resumePackId === 'string'
    ? resumePackId.trim()
    : null;
  const providerPreference = renderStyle === 'vector' ? vectorProvider : 'auto';
  const willUseOpenAI = renderStyle === 'vector' && isOpenAiSvgAvailable(providerPreference);
  const openAiEnv = getOpenAiSvgEnv();

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

  if (renderStyle === 'vector' && vectorProvider === 'openai' && !isOpenAiSvgAvailable('openai')) {
    const msg = 'OpenAI SVG generation requested but OPENAI_API_KEY is not configured on the assets service.';
    log('openai svg unavailable', { gameId, reason: msg });
    emitProgress(progressChannel, 'error', { packId: null, gameId, error: msg });
    res.status(400).json({ ok: false, error: msg });
    return;
  }

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
  log('POST create pack', {
    packId,
    gameId,
    size,
    roles: pieces?.map((p) => p.role).join(',') || '<none>',
    boards: Array.isArray(boards) ? boards.map((b) => b?.id || '?').join(',') : '<none>',
    packsDir,
    stylePrompt: mergedPrompt || '<none>',
    renderStyle,
    vectorProvider,
    willUseOpenAI,
    resumePackId: resumePackIdClean || '<none>',
    reuseExisting: allowReuseExisting,
  });
  log('DETAILED REQUEST SHAPE', {
    packId,
    gameId,
    boardsArray: JSON.stringify(boards),
    piecesArray: JSON.stringify(pieces),
  });
  log('DETAILED REQUEST SHAPE', {
    packId,
    gameId,
    boardsArray: JSON.stringify(boards),
    piecesArray: JSON.stringify(pieces),
  });

  emitProgress(progressChannel, 'start', {
    packId,
    gameId,
    size,
    roles: pieces?.map((p) => p.role) || [],
    boards: Array.isArray(boards) ? boards.map((b) => b?.id).filter(Boolean) : [],
    renderStyle,
    vectorProvider,
    vectorProviderResolved: providerPreference,
    willUseOpenAI,
    openAiAvailable: openAiEnv.openAiAvailable,
    resumePackId: resumePackIdClean,
    reuseExisting: allowReuseExisting,
  });
  log('job start provider', {
    gameId,
    renderStyle,
    vectorProvider,
    providerPreference,
    willUseOpenAI,
    openAiEnv,
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
    await fs.mkdir(baseDir, { recursive: true });

    const boardAssets = {};
    // legacy write helpers to keep old paths alive until frontend fully per-board
    const boardsMap = Array.isArray(boards)
      ? boards.reduce((acc, b) => {
          const id = String(b?.id || '').trim();
          if (!id) return acc;
          acc[id] = {
            id,
            name: b?.name,
            background: b?.background || b?.backgroundImage || null,
            tileLight: b?.tileLight || null,
            tileDark: b?.tileDark || null,
            grid: b?.grid || null,
          };
          return acc;
        }, {})
      : {};
    log('BOARDS MAP CONSTRUCTED', {
      packId,
      gameId,
      boardsMapKeys: Object.keys(boardsMap),
      boardsMapShape: JSON.stringify(boardsMap),
    });
    log('BOARDS MAP CONSTRUCTED', {
      packId,
      gameId,
      boardsMapKeys: Object.keys(boardsMap),
      boardsMapShape: JSON.stringify(boardsMap),
    });
    // Manifest writing disabled; keep placeholders for future reactivation.
    const writeManifestPartial = async () => {};
    const orderedPieces = Array.isArray(pieces)
      ? pieces
          .filter(Boolean)
          .map((p) => {
            const role = String(p.role || '').toLowerCase();
            const baseVariants =
              Array.isArray(p.variants) && p.variants.length
                ? p.variants
                : [role === 'cover' ? 'main' : 'p1'];
            const variants = baseVariants
              .map((v) => String(v || '').toLowerCase())
              .filter(Boolean);
            return { ...p, variants };
          })
      : [];
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

    const boardIds = Object.keys(boardsMap).length ? Object.keys(boardsMap) : ['board-1'];
    const totalPieceCount =
      boardIds.length *
      orderedPieces.reduce(
        (sum, piece) => sum + (Array.isArray(piece.variants) ? piece.variants.length : 0),
        0,
      );
    let remainingPieces = totalPieceCount;
    
    log('GENERATION LOOP STARTING', {
      packId,
      gameId,
      boardIds: JSON.stringify(boardIds),
      orderedPieces: JSON.stringify(orderedPieces.map(p => ({ role: p.role, variants: p.variants }))),
      totalPieceCount,
    });
    
    log('GENERATION LOOP STARTING', {
      packId,
      gameId,
      boardIds: JSON.stringify(boardIds),
      orderedPieces: JSON.stringify(orderedPieces.map(p => ({ role: p.role, variants: p.variants }))),
      totalPieceCount,
    });

    const awaitAdvanceIfNeeded = async () => {
      if (!gateChannel || cancelled) return true;
      if (remainingPieces <= 0) return true;
      const waitResult = await waitForAdvanceGate(gateChannel);
      if (waitResult?.type === 'timeout') {
        log('client advance timeout', { packId, gameId });
        markCancelled('client-advance-timeout');
        emitProgress(progressChannel, 'cancelled', { packId, gameId, reason: 'client-timeout' });
        return false;
      }
      if (waitResult?.type === 'cancelled') {
        markCancelled('client-advance-cancelled');
        return false;
      }
      return true;
    };

    // Generate simple procedural board assets (SVG) for boards (default at least one)
      if (boardIds.length) {
        const writeBoardAsset = async (boardId, name) => {
          const boardPath = path.join(baseDir, boardId, 'board');
          await fs.mkdir(boardPath, { recursive: true });
          const light = theme?.p1Color || '#e8e8e8';
        const dark = theme?.p2Color || '#d8d8d8';
        const accent = theme?.accent || '#ffd60a';
        const outline = theme?.outline || '#202020';
        const backgroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0%" stop-color="${light}" stop-opacity="0.85"/><stop offset="100%" stop-color="${dark}" stop-opacity="0.9"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#g)"/><circle cx="180" cy="180" r="120" fill="${accent}" opacity="0.12"/><circle cx="860" cy="220" r="140" fill="${outline}" opacity="0.08"/><rect x="260" y="520" width="520" height="320" rx="24" fill="${outline}" opacity="0.05"/></svg>`;
        const tileLightSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="10" fill="${light}" stroke="${outline}" stroke-width="2" opacity="0.5"/></svg>`;
        const tileDarkSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="10" fill="${dark}" stroke="${outline}" stroke-width="2" opacity="0.55"/><circle cx="28" cy="28" r="12" fill="${accent}" opacity="0.2"/></svg>`;
        const bgRel = `/skins/${packId}/${boardId}/board/background.svg`;
        const lightRel = `/skins/${packId}/${boardId}/board/tileLight.svg`;
        const darkRel = `/skins/${packId}/${boardId}/board/tileDark.svg`;
        const boardPreviewRel = `/skins/${packId}/${boardId}/board/preview.svg`;
        await fs.writeFile(path.join(boardPath, 'background.svg'), backgroundSvg, 'utf8');
          await fs.writeFile(path.join(boardPath, 'tileLight.svg'), tileLightSvg, 'utf8');
          await fs.writeFile(path.join(boardPath, 'tileDark.svg'), tileDarkSvg, 'utf8');
          await fs.writeFile(path.join(boardPath, 'preview.svg'), backgroundSvg, 'utf8');
          boardAssets[boardId] = {
            ...(boardAssets[boardId] || {}),
            boardPreview: boardPreviewRel,
            background: bgRel,
            tileLight: lightRel,
            tileDark: darkRel,
          };
          boardsMap[boardId] = {
            ...(boardsMap[boardId] || {}),
            id: boardId,
            name: name || boardsMap[boardId]?.name || boardId,
            background: bgRel,
            tileLight: lightRel,
            tileDark: darkRel,
            preview: boardPreviewRel,
          };
      };

      for (const boardId of boardIds) {
        if (cancelled) break;
        await writeBoardAsset(boardId, boardsMap[boardId]?.name);
      }
      
      log('BOARD BACKGROUNDS GENERATED', {
        packId,
        gameId,
        boardAssetsAfterBackgrounds: JSON.stringify(boardAssets),
      });

      log('STARTING PIECES GENERATION', {
        packId,
        gameId,
        boardIds: JSON.stringify(boardIds),
        boardAssetsBeforeLoop: JSON.stringify(boardAssets),
      });
      
      for (const boardId of boardIds) {
        if (cancelled) break;
        const boardRoot = path.join(baseDir, boardId);
        log('GENERATING FOR BOARD', {
          packId,
          gameId,
          boardId,
          boardAssetsCurrentState: JSON.stringify(boardAssets[boardId] || null),
        });
        for (const p of orderedPieces) {
        if (cancelled) break;
        const normalizedRole = String(p.role || '').toLowerCase();
        const isCoverRole = normalizedRole === 'cover';
        const roleDir = isCoverRole
          ? path.join(boardRoot, 'cover')
          : path.join(boardRoot, 'pieces', p.role);
        await fs.mkdir(roleDir, { recursive: true });

        for (const vRaw of p.variants) {
          if (cancelled) break;
          const isCover = isCoverRole;
          const variant = String(isCover ? 'main' : vRaw || 'p1').toLowerCase();
          const color =
            variant === 'p1'
              ? theme.p1Color
              : variant === 'p2'
              ? theme.p2Color
              : theme.accent;
          const pieceSize = isCover ? Math.max(size, 768) : size;
          const filename = `${variant}.svg`;
          const filePath = path.join(roleDir, filename);
          const reuseSourcePath =
            allowReuseExisting && resumeSourceDir
              ? path.join(
                  resumeSourceDir,
                  boardId,
                  isCover ? 'cover' : path.join('pieces', p.role),
                  filename,
                )
              : null;
          let svg = null;
          const variantPromptOverride = resolveVariantPrompt(p.variantPrompts, variant);
          const promptSegments = (variantPromptOverride ? [variantPromptOverride] : [mergedPrompt, p.prompt]).map((s) =>
            (s || '').trim(),
          );
          const piecePrompt = promptSegments.filter(Boolean).join(' — ');
          const promptForAI = piecePrompt || mergedPrompt || variantPromptOverride || '';
          const { prompt: safePrompt, replacements } = sanitizePrompt(promptForAI);
          const promptForModel = safePrompt || promptForAI;
          const wantsPhotoreal = renderStyle === 'photoreal';

          if (gameId) {
            updateJobPieceState(gameId, normalizedRole, variant, { status: 'loading', prompt: promptForModel });
          }

          if (replacements.length && Array.isArray(replacements) && replacements.length > 0) {
            log('prompt sanitized', { packId, role: p.role, variant, replacements });
            emitProgress(progressChannel, 'notice', { packId, role: p.role, variant, replacements });
          }

          emitProgress(progressChannel, 'piece-start', {
            packId,
            role: p.role,
            variant,
            status: 'loading',
            vectorProvider: renderStyle === 'vector' ? vectorProvider : null,
            vectorProviderResolved: renderStyle === 'vector' ? providerPreference : null,
            openai: renderStyle === 'vector' ? willUseOpenAI : null,
            openAiAvailable: renderStyle === 'vector' ? openAiEnv.openAiAvailable : null,
            openAiHasKey: renderStyle === 'vector' ? openAiEnv.hasKey : null,
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

              const rolePath = isCover ? 'cover' : `pieces/${p.role}`;
              const urlPath = `/skins/${packId}/${boardId}/${rolePath}/${filename}`;
              
              // Phase 2: Use formatIdentifier for consistent reused asset keys
              const assetKey = formatIdentifier({
                role: normalizedRole,
                boardId,
                variant: variant === 'main' ? null : variant,
              });
              
              boardAssets[boardId] ||= {};
              if (isCover) {
                boardAssets[boardId].cover = urlPath;
              } else {
                boardAssets[boardId].tokens ||= {};
                boardAssets[boardId].tokens[variant] = urlPath;
              }

              emitProgress(progressChannel, 'piece', {
                packId,
                role: p.role,
                variant,
                url: urlPath,
                status: finalStatus,
                reused: true,
                resumePackId: resumePackIdClean,
                prompt: promptForModel,
              });
              if (gameId) {
                updateJobPieceState(gameId, normalizedRole, variant, {
                  status: finalStatus,
                  url: urlPath,
                  reused: true,
                  prompt: promptForModel,
                });
              }
              await writeManifestPartial(false);
              log('reused existing asset', { packId, role: p.role, variant, resumePackId: resumePackIdClean });
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
                theme,
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
                log('photo sprite result discarded due to cancellation', { packId, role: p.role, variant });
                break;
              }
              if (svg) {
                const hasPngImage = /data:image\/png;base64,/i.test(svg);
                log('photo sprite success', { packId, role: p.role, variant, hasPngImage, length: svg.length });
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
              emitProgress(progressChannel, 'piece-error', { packId, role: p.role, variant, error: err?.message || err });
              throw new Error(`Photoreal generation failed for ${p.role}/${variant}: ${err?.message || err}`);
            }
            if (!svg) {
              log('photo sprite generation returned empty', { role: p.role, variant });
              emitProgress(progressChannel, 'piece-error', { packId, role: p.role, variant, error: `Photoreal generation failed for ${p.role}/${variant}` });
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
                providerPreference,
                openai: willUseOpenAI,
              });
              if (willUseOpenAI) {
                svg = await generateAISVG({
                  role: p.role,
                  variant,
                  prompt: promptForModel,
                  size: pieceSize,
                  theme,
                  signal: upstreamAbortController.signal,
                  providerPreference,
                });
              } else {
                log('vector ai skipped openai (provider resolved to local)', { packId, role: p.role, variant, providerPreference });
                svg = null;
              }
              if (cancelled) {
                log('vector svg result discarded due to cancellation', { packId, role: p.role, variant });
                break;
              }
              if (svg) {
                log('vector ai success', { packId, role: p.role, variant, length: svg.length });
              }
            }
            if (upstreamAbortController.signal.aborted) {
              cancelled = true;
            }
            if (cancelled) break;

            if (!svg) {
              const fallbackSvg = (() => {
                if (isCover) {
                  try {
                    const coverSeed = `${gameId || ''}-${packId}-${Date.now()}`;
                    log('cover render fallback', { packId, gameId, seed: coverSeed, prompt: promptForModel });
                    return renderCoverSVG({ size: pieceSize, theme, title: gameName || stylePrompt || 'Custom Game', seed: coverSeed });
                  } catch (err) {
                    log('cover fallback render failed', { packId, error: err?.message || err, stack: err?.stack ? 'yes' : 'no' });
                    return null;
                  }
                }
                try {
                  const fillColor = variant === 'p1' ? theme?.p1Color || '#1e90ff' : variant === 'p2' ? theme?.p2Color || '#ff3b30' : color;
                  return renderChessPieceSVG({ role: normalizedRole, size: pieceSize, fill: fillColor, accent: theme?.accent || '#ffd60a', outline: theme?.outline || '#202020' });
                } catch (err) {
                  log('vector fallback render failed', { packId, role: p.role, variant, error: err?.message || err });
                  return null;
                }
              })();
              if (fallbackSvg) {
                svg = fallbackSvg;
                finalStatus = 'fallback';
                log('vector generation fallback used', { packId, role: p.role, variant });
              } else {
                finalStatus = 'missing';
                log('vector generation returned empty', { packId, role: p.role, variant, reason: promptForAI ? 'AI returned empty' : 'No prompt provided' });
              }
            } else {
              finalStatus = 'ready';
            }
          }

          if (cancelled) break;

          if (!svg) {
            emitProgress(progressChannel, 'piece-error', { packId, role: p.role, variant, error: `generation failed for ${p.role}/${variant}` });
            if (gameId) {
              updateJobPieceState(gameId, normalizedRole, variant, { status: 'error' });
            }
            remainingPieces -= 1;
            const continueAfterMissing = await awaitAdvanceIfNeeded();
            if (!continueAfterMissing) {
              break;
            }
            continue;
          }

          await fs.writeFile(filePath, svg, 'utf8');
          log('   wrote asset', { packId, boardId, role: p.role, variant, filePath });

          const rolePath = isCover ? 'cover' : `pieces/${p.role}`;
          const urlPath = `/skins/${packId}/${boardId}/${rolePath}/${filename}`;
          
          // Phase 2: Use formatIdentifier for consistent key generation
          const assetKey = formatIdentifier({
            role: normalizedRole,
            boardId,
            variant: variant === 'main' ? null : variant,
          });
          
          boardAssets[boardId] ||= {};
          if (isCover) {
            boardAssets[boardId].cover = urlPath;
          } else {
            boardAssets[boardId].tokens ||= {};
            boardAssets[boardId].tokens[variant] = urlPath;
          }

          emitProgress(progressChannel, 'piece', {
            packId,
            role: p.role,
            variant,
            url: urlPath,
            status: finalStatus,
            prompt: promptForModel,
            vectorProvider: renderStyle === 'vector' ? vectorProvider : null,
            vectorProviderResolved: renderStyle === 'vector' ? providerPreference : null,
            openai: renderStyle === 'vector' ? willUseOpenAI : null,
            openAiAvailable: renderStyle === 'vector' ? openAiEnv.openAiAvailable : null,
            openAiHasKey: renderStyle === 'vector' ? openAiEnv.hasKey : null,
          });

          if (gameId) {
            updateJobPieceState(gameId, normalizedRole, variant, {
              status: finalStatus,
              url: urlPath,
              prompt: promptForModel,
            });
          }

          if (gameId) {
            updateJobPieceState(gameId, normalizedRole, variant, {
              status: finalStatus,
              url: urlPath,
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
    }
    // end board asset generation
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
      await writeManifestPartial(false);
      log('pack generation cancelled (partial assets preserved)', { packId, baseDir });
      res.status(499).json({
        ok: false,
        cancelled: true,
        error: 'cancelled',
        packId,
        baseUrl: `/skins/${packId}/`,
        manifestUrl: `/skins/${packId}/manifest.json`,
        boardAssets: sortBoardAssets(boardAssets),
        renderStyle,
      });
      return;
    }

    // Count total pieces across all boards
    const totalPieces = Object.values(boardAssets).reduce((count, board) => {
      return count + (board.tokens ? Object.keys(board.tokens).length : 0);
    }, 0);
    
    log('pack ready', { packId, pieces: totalPieces, boards: Object.keys(boardAssets).length });
    const stateSnapshot = gameId ? jobStates.get(String(gameId)) : null;
    const promptSnapshot = collectJobPrompts(stateSnapshot);
    emitProgress(progressChannel, 'complete', {
      packId,
      baseUrl: `/skins/${packId}/`,
      manifestUrl: `/skins/${packId}/manifest.json`,
      boardAssets: sortBoardAssets(boardAssets),
      renderStyle,
      vectorProvider: renderStyle === 'vector' ? vectorProvider : null,
      vectorProviderResolved: renderStyle === 'vector' ? providerPreference : null,
      openai: renderStyle === 'vector' ? willUseOpenAI : null,
      openAiAvailable: renderStyle === 'vector' ? openAiEnv.openAiAvailable : null,
      openAiHasKey: renderStyle === 'vector' ? openAiEnv.hasKey : null,
      prompts: promptSnapshot,
    });
    closeChannel(progressChannel);
    if (gameId && upstreamAbortController) {
      clearPendingJob(gameId, upstreamAbortController);
    }
    if (gameId) {
      markJobState(gameId, { active: false });
      // Auto-cleanup old packs: keep 2 most recent per game
      cleanupOldPacksForGame(gameId, packsDir, 2).catch(err => 
        log('cleanup after generation failed', { gameId, err: err?.message || err })
      );
    }

    res.status(201).json({
      ok: true,
      packId,
      baseUrl: `/skins/${packId}/`,
      manifestUrl: `/skins/${packId}/manifest.json`,
      boardAssets: sortBoardAssets(boardAssets),
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
  const packId = req.params.id;
  if (!packId) {
    return res.status(400).json({ ok: false, error: 'packId required' });
  }

  const packPath = path.join(packsDir, packId);

  try {
    const stat = await fs.stat(packPath).catch(() => null);
    if (!stat) {
      return res.json({ ok: true, packId, deleted: false });
    }

    await fs.rm(packPath, { recursive: true, force: true });
    log('deleted pack directory', { packId });
    res.json({ ok: true, packId, deleted: true });
  } catch (err) {
    log('delete pack failed', { packId, error: err?.message || err });
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

/**
 * DELETE /api/skins/packs/for-game/:gameId
 * Delete all packs for a specific game (called when game is deleted).
 */
router.delete('/for-game/:gameId', async (req, res) => {
  const packsDir = req.app.get('packsDir');
  const { gameId } = req.params;
  
  if (!gameId) {
    return res.status(400).json({ ok: false, error: 'gameId required' });
  }

  try {
    const items = await fs.readdir(packsDir, { withFileTypes: true }).catch(() => []);
    const allPacks = items.filter(d => d.isDirectory()).map(d => d.name);
    
    // All packs are game-agnostic by name (pack_<timestamp>_<nanoId>)
    // So we delete ALL packs when game is deleted (they're temporary artifacts).
    // If you want gameId-specific cleanup, extract gameId from metadata or track it separately.
    const deleted = [];
    const failed = [];
    
    for (const packName of allPacks) {
      const packPath = path.join(packsDir, packName);
      try {
        await fs.rm(packPath, { recursive: true, force: true });
        deleted.push(packName);
        log('deleted pack for game cleanup', { gameId, packId: packName });
      } catch (err) {
        failed.push(packName);
        log('failed to delete pack for game', { gameId, packId: packName, error: err?.message || err });
      }
    }

    res.json({
      ok: true,
      gameId,
      deleted,
      failed,
      totalDeleted: deleted.length,
      totalFailed: failed.length,
    });
  } catch (err) {
    log('cleanup packs for game failed', { gameId, error: err?.message || err });
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

export default router;
