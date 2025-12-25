// service-assets/src/routes/packs.js
import { Router } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';
import Joi from 'joi';
import { generateAISVG, isOpenAiSvgAvailable, getOpenAiSvgEnv } from '../services/aiSvgGenerator.js';
import { generatePhotoSpriteSVG, generatePhotoBoardSVG } from '../services/photoSpriteGenerator.js';
import { sanitizePrompt } from '../lib/sanitizePrompt.js';
import { renderChessPieceSVG, renderCoverSVG, renderTokenSVG, renderBackgroundSVG, renderTileSVG } from '../tri/svgTemplates.js';
import {
  emitProgress,
  closeChannel,
  attachAbortController,
  getClientCount,
} from '../services/progressHub.js';
import { normalizeIdentifier, formatIdentifier } from '../types/assetIdentifier.js';

const router = Router();
const log = (...msg) => console.log(new Date().toISOString(), '[packs]', ...msg);

export const pendingJobs = new Map(); // gameId -> { controller, progressChannel, packId, startedAt }
export const jobStates = new Map(); // gameId -> { ownerUserId?, packId, renderStyle, baseUrl, manifestUrl, progressChannel, active, pieces, boardAssets, activePiece, updatedAt }

const WAIT_FOR_CLIENT_ADVANCE = String(process.env.WAIT_FOR_CLIENT_ADVANCE || 'true').toLowerCase() !== 'false';
const CLIENT_ADVANCE_TIMEOUT_MS = Math.max(
  0,
  Number(process.env.CLIENT_ADVANCE_TIMEOUT_MS || 8000),
);

// progressChannel -> { count:number, waiters:Set<Function> }
const advanceState = new Map();

const emitProgressWithGame = (channelId, event, payload, gameId) =>
  emitProgress(channelId, event, { ...(payload || {}), gameId: gameId || null });

function signalClientAdvance(progressChannel) {
  if (!progressChannel) return;
  const entry = advanceState.get(progressChannel) || { count: 0, waiters: new Set() };
  if (entry.waiters.size > 0) {
    const [resolve] = entry.waiters;
    entry.waiters.delete(resolve);
    advanceState.set(progressChannel, entry);
    try {
      resolve(true);
    } catch {
      // ignore
    }
    return;
  }
  entry.count += 1;
  advanceState.set(progressChannel, entry);
}

function waitForClientAdvance(progressChannel, { signal, timeoutMs = CLIENT_ADVANCE_TIMEOUT_MS } = {}) {
  if (!progressChannel) return Promise.resolve(false);
  const entry = advanceState.get(progressChannel) || { count: 0, waiters: new Set() };
  if (entry.count > 0) {
    entry.count = Math.max(0, entry.count - 1);
    advanceState.set(progressChannel, entry);
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        entry.waiters.delete(finish);
      } catch {}
      try {
        resolve(result);
      } catch {}
    };

    // Store waiter
    entry.waiters.add(finish);
    advanceState.set(progressChannel, entry);

    timer =
      timeoutMs > 0
        ? setTimeout(() => {
            finish(false);
          }, timeoutMs)
        : null;

    if (signal && typeof signal.addEventListener === 'function') {
      const onAbort = () => {
        finish(false);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export function sanitizeUserId(value) {
  const raw = typeof value === 'string' ? value : value == null ? '' : String(value);
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const safe = trimmed.replace(/[^a-zA-Z0-9_-]/g, '');
  return safe || null;
}

function getRequestUserId(req) {
  const fromQuery = sanitizeUserId(req?.query?.userId);
  if (fromQuery) return fromQuery;
  const fromBody = sanitizeUserId(req?.body?.userId);
  if (fromBody) return fromBody;
  const fromHeader = sanitizeUserId(req?.headers?.['x-user-id']);
  if (fromHeader) return fromHeader;
  return null;
}

function assertOwnerOr403(req, res, state) {
  const owner = sanitizeUserId(state?.ownerUserId);
  if (!owner) return true; // owner enforcement disabled when ownerUserId is absent
  const requestUserId = getRequestUserId(req);
  if (!requestUserId || requestUserId !== owner) {
    res.status(403).json({ ok: false, error: 'Forbidden' });
    return false;
  }
  return true;
}

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

function emitStateSnapshot(gameId) {
  if (!gameId) return;
  const state = jobStates.get(String(gameId));
  if (!state) return;
  const channel = state.progressChannel ? String(state.progressChannel).trim() : null;
  if (!channel) return;
  emitProgressWithGame(channel, 'state', serializeJobState(state), gameId);
}

function updateJobPieceState(gameId, boardId, role, variant, patch = {}) {
  if (!gameId) return;
  const state = jobStates.get(String(gameId));
  if (!state) return;
  if (!state.pieces) state.pieces = {};
  const normalizedRole = String(role || '').trim();
  const normalizedBoardId = boardId ? String(boardId).trim() : null;
  const normalizedVariant = variant == null ? null : String(variant).trim().toLowerCase();
  const pieceKey = formatIdentifier({
    role: normalizedRole,
    boardId: normalizedBoardId,
    variant: normalizedVariant === 'main' ? null : normalizedVariant,
  });
  const existing = state.pieces?.[pieceKey] || {
    id: pieceKey,
    role: normalizedRole,
    boardId: normalizedBoardId,
    variant: normalizedVariant,
  };
  state.pieces[pieceKey] = {
    ...existing,
    ...patch,
    id: pieceKey,
    role: normalizedRole,
    boardId: normalizedBoardId,
    variant: normalizedVariant,
  };
  state.updatedAt = Date.now();
  emitStateSnapshot(gameId);
}

function markJobState(gameId, patch = {}) {
  if (!gameId) return;
  const state = jobStates.get(String(gameId));
  if (!state) return;
  Object.assign(state, patch);
  state.updatedAt = Date.now();
  emitStateSnapshot(gameId);
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
  state.activePiece = null;
  state.progressChannel = null;
  state.updatedAt = Date.now();
  emitStateSnapshot(gameId);
}

export function serializeJobState(state) {
  if (!state) return null;
  const progressChannel =
    state.progressChannel != null && String(state.progressChannel).trim()
      ? String(state.progressChannel).trim()
      : null;
  return {
    packId: state.packId || null,
    renderStyle: state.renderStyle || null,
    renderDetail: state.renderDetail || null,
    baseUrl: state.baseUrl || null,
    manifestUrl: state.manifestUrl || null,
    progressChannel,
    resumePackId: state.resumePackId || null,
    active: Boolean(state.active),
    updatedAt: state.updatedAt || Date.now(),
    pieces: state.pieces || {},
    boardAssets:
      state.boardAssets && typeof state.boardAssets === 'object'
        ? state.boardAssets
        : null,
    activePiece:
      state.activePiece && typeof state.activePiece === 'object'
        ? state.activePiece
        : null,
    prompts: collectJobPrompts(state),
  };
}

/**
 * Auto-cleanup old packs for a game.
 * Keeps the latest N packs per gameId and deletes older ones.
 * Call after a successful pack generation.
 */
export const PACK_META_FILENAME = 'pack-meta.json';

export async function readPackMeta(packDir) {
  if (!packDir) return null;
  try {
    const raw = await fs.readFile(path.join(packDir, PACK_META_FILENAME), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writePackMeta(packDir, meta) {
  if (!packDir) return false;
  try {
    const payload = meta && typeof meta === 'object' ? meta : {};
    await fs.writeFile(
      path.join(packDir, PACK_META_FILENAME),
      JSON.stringify(payload),
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}

export async function cleanupOldPacksForGame(gameId, packsDir, keepLatest = 2, keepPackIds = null) {
  if (!gameId) return;
  try {
    const keepSet = new Set(
      Array.isArray(keepPackIds) || keepPackIds instanceof Set
        ? Array.from(keepPackIds || []).filter(Boolean)
        : [],
    );
    const items = await fs.readdir(packsDir, { withFileTypes: true }).catch(() => []);
    const allPacks = items.filter(d => d.isDirectory()).map(d => d.name);
    
    const normalizeGameId = (value) => String(value || '').trim();
    const targetGameId = normalizeGameId(gameId);
    if (!targetGameId) return;

    const parseTimestampFromName = (name) => {
      const parts = String(name || '').split('_');
      const timestamp = parts.length > 1 ? Number(parts[1]) : 0;
      return Number.isFinite(timestamp) ? timestamp : 0;
    };

    const gamePacksInfo = [];
    for (const name of allPacks) {
      if (!name.startsWith('pack_')) continue;
      const packPath = path.join(packsDir, name);
      const meta = await readPackMeta(packPath);
      const metaGameId = normalizeGameId(meta?.gameId);
      if (!metaGameId || metaGameId !== targetGameId) continue;
      const createdAt =
        Number.isFinite(Number(meta?.createdAt)) && Number(meta.createdAt) > 0
          ? Number(meta.createdAt)
          : parseTimestampFromName(name);
      gamePacksInfo.push({ name, createdAt });
    }

    gamePacksInfo.sort((a, b) => b.createdAt - a.createdAt);
    
    // Keep the latest `keepLatest` packs, delete the rest (except explicitly kept)
    if (gamePacksInfo.length > keepLatest) {
      const toDelete = gamePacksInfo.slice(keepLatest);
      for (const { name } of toDelete) {
        if (keepSet.has(name)) {
          log('auto-clean skip (script referenced)', { packId: name });
          continue;
        }
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

function collectJobPrompts(state) {
  const prompts = {};
  if (!state?.pieces) return prompts;
  Object.values(state.pieces).forEach((piece) => {
    if (!piece || !piece.prompt) return;
    const key =
      typeof piece.id === 'string' && piece.id.trim()
        ? piece.id.trim()
        : `${piece.role}-${piece.variant}`;
    prompts[key] = piece.prompt;
  });
  return prompts;
}

function extractPackIdsFromBoardAssets(boardAssets) {
  const packIds = new Set();
  if (!boardAssets || typeof boardAssets !== 'object') return packIds;
  const collectFromValue = (value) => {
    if (typeof value !== 'string') return;
    const match = value.match(/\/skins\/(pack_[^/]+)\//i);
    if (match && match[1]) {
      packIds.add(match[1]);
    }
  };
  Object.values(boardAssets).forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    collectFromValue(entry.cover);
    collectFromValue(entry.boardPreview);
    collectFromValue(entry.background);
    collectFromValue(entry.tileLight);
    collectFromValue(entry.tileDark);
    if (entry.tokens && typeof entry.tokens === 'object') {
      Object.values(entry.tokens).forEach((url) => collectFromValue(url));
    }
  });
  return packIds;
}

function normalizePromptOverrides(source) {
  const overrides = new Map();
  if (!source || typeof source !== 'object') return overrides;
  Object.entries(source).forEach(([rawKey, rawValue]) => {
    if (typeof rawKey !== 'string' || typeof rawValue !== 'string') return;
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim();
    if (!key || !value) return;
    overrides.set(key, value);
  });
  return overrides;
}

function promptKeyFromIdentifier(identifier) {
  const id = formatIdentifier(identifier);
  return typeof id === 'string' ? id.trim().toLowerCase() : '';
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
  userId: Joi.string().allow('', null),
  gameId: Joi.string().allow('', null),
  gameName: Joi.string().allow('', null),
  stylePrompt: Joi.string().allow('', null),
  assetGenerationLocation: Joi.string().valid('local', 'remote').allow('', null),
  openaiKey: Joi.string().allow('', null),
  comfyuiUrl: Joi.string().allow('', null),
  triposrUrl: Joi.string().allow('', null),
  renderStyle: Joi.string().valid('vector', 'photoreal').default('vector'),
  renderDetail: Joi.string().valid('low', 'medium', 'high').default('medium'),
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
  targetBoardIds: Joi.array().items(Joi.string()).default([]), // Which boards to regenerate
  targetIds: Joi.array().items(Joi.string()).default([]), // Specific asset identifiers to regenerate
  existingBoardAssets: Joi.object().pattern(
    Joi.string(),
    Joi.object({
      boardPreview: Joi.string().allow('', null),
      cover: Joi.string().allow('', null),
      background: Joi.string().allow('', null),
      tileLight: Joi.string().allow('', null),
      tileDark: Joi.string().allow('', null),
      tokens: Joi.object().pattern(Joi.string(), Joi.string().allow('', null)),
    })
  ).default({}), // Existing board assets with URLs to copy from
  size: Joi.number().integer().min(64).max(1024).default(512), // SVG viewBox (square)
  resumePackId: Joi.string().allow('', null),
  reuseExistingPack: Joi.boolean().default(false),
  reuseExistingPieces: Joi.boolean().default(true),
  vectorProvider: Joi.string().valid('auto', 'openai', 'local').default('auto'),
  piecePrompts: Joi.object().pattern(
    Joi.string(),
    Joi.string().allow('', null),
  ).default({}),
});

export function validateCreatePackPayload(body) {
  return createSchema.validate(body || {}, { stripUnknown: true });
}

function fileUrl(base, ...p) {
  const joined = ['','skins', ...p].join('/').replace(/\/+/g, '/');
  return base ? `${base}${joined}` : joined; // base is the apache-proxied origin
}

// NOTE: define /progress/by-game before /progress/:channelId so Express doesn't treat "by-game"
// as a channel id.

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

async function findLatestPackForBoard(packsDir, boardId, excludePackId) {
  try {
    const entries = await fs.readdir(packsDir, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (!name.startsWith('pack_')) continue;
      if (excludePackId && name === excludePackId) continue;
      const boardPath = path.join(packsDir, name, boardId);
      if (!(await pathExists(boardPath))) continue;
      const stat = await fs.stat(path.join(packsDir, name));
      candidates.push({ packId: name, mtime: stat.mtimeMs || 0 });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0].packId;
  } catch {
    return null;
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
  const state = jobStates.get(key);
  if (state && !assertOwnerOr403(req, res, state)) return;
  const job = pendingJobs.get(key);
  if (!job) {
    res.json({ ok: true, cancelled: false, message: 'no active job for gameId' });
    return;
  }
  pendingJobs.delete(key);
  markJobStateCancelled(key);
  const { progressChannel, controller, packId } = job;
  log('cancel job request', { gameId: key, progressChannel, packId });
  try {
    if (controller) controller.abort();
  } catch (err) {
    log('cancel job controller abort failed', err?.message || err);
  }
  if (progressChannel) {
    emitProgressWithGame(progressChannel, 'cancelled', { packId, reason }, key);
    closeChannel(progressChannel);
  }
  res.json({ ok: true, cancelled: true, gameId: key });
});

router.post('/jobs/advance', (req, res) => {
  const { progressChannel, gameId } = req.body || {};
  const channel =
    typeof progressChannel === 'string' && progressChannel.trim()
      ? progressChannel.trim()
      : null;
  if (!channel) {
    res.status(400).json({ ok: false, error: 'progressChannel required' });
    return;
  }

  const key = gameId ? String(gameId) : null;
  const state = key ? jobStates.get(key) : null;
  const pending = key ? pendingJobs.get(key) : null;
  const effectiveState = state || pending || null;
  if (effectiveState && !assertOwnerOr403(req, res, effectiveState)) return;

  // If we have a gameId, ensure the channel matches the running job.
  const expectedChannel =
    (state?.progressChannel && String(state.progressChannel).trim()) ||
    (pending?.progressChannel && String(pending.progressChannel).trim()) ||
    null;
  if (expectedChannel && expectedChannel !== channel) {
    res.status(409).json({ ok: false, error: 'progressChannel does not match active job' });
    return;
  }

  signalClientAdvance(channel);
  res.json({ ok: true, advanced: true });
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
  const state = jobStates.get(key);
  if (state && !assertOwnerOr403(req, res, state)) return;
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
  if (state && !assertOwnerOr403(req, res, state)) return;
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
  if (state && !assertOwnerOr403(req, res, state)) return;
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
  const { value, error } = validateCreatePackPayload(req.body);
  if (error) return res.status(400).json({ ok: false, error: error.message });

  const {
    userId = null,
    gameId = null,
    gameName = null,
    stylePrompt = '',
    assetGenerationLocation = null,
    openaiKey = null,
    comfyuiUrl = null,
    triposrUrl = null,
    progressChannel = null,
    renderStyle = 'vector',
    renderDetail = 'medium',
    theme,
    pieces,
    boards,
    targetBoardIds,
    targetIds,
    existingBoardAssets = {},
    size,
    resumePackId = null,
    reuseExistingPack = false,
    reuseExistingPieces = true,
    vectorProvider = 'auto',
    piecePrompts = {},
  } = value;
  let effectiveVectorProvider = vectorProvider;
  const normalizedLocation =
    typeof assetGenerationLocation === 'string' && assetGenerationLocation.trim()
      ? assetGenerationLocation.trim().toLowerCase()
      : null;
  const openAiKey =
    typeof openaiKey === 'string' && openaiKey.trim()
      ? openaiKey.trim()
      : null;
  if (renderStyle === 'vector' && normalizedLocation === 'local') {
    effectiveVectorProvider = 'local';
  }
  const ownerUserId = sanitizeUserId(userId);
  const packsDir = req.app.get('packsDir');
  const mergedPrompt = [gameName, stylePrompt].map((s) => (s || '').trim()).filter(Boolean).join(' — ');
  const promptOverrides = normalizePromptOverrides(piecePrompts);
  const targetIdSet =
    Array.isArray(targetIds) && targetIds.length
      ? new Set(
          targetIds
            .map((id) => (typeof id === 'string' ? id.trim().toLowerCase() : ''))
            .filter(Boolean),
        )
      : null;
  const boardAssetRoles = new Set(['board', 'boardpreview', 'background', 'tilelight', 'tiledark']);
  const parseBoardIdFromTargetId = (rawId) => {
    const text = String(rawId || '').trim().toLowerCase();
    if (!text) return null;
    const parts = text.split('-');
    if (parts.length < 3 || parts[1] !== 'board') return null;
    const role = parts[0];
    if (boardAssetRoles.has(role) || role === 'cover') {
      return parts.slice(1).join('-');
    }
    if (parts.length <= 3) return null;
    return parts.slice(1, -1).join('-');
  };
  const targetedBoardAssets = new Set();
  if (targetIdSet) {
    targetIdSet.forEach((id) => {
      const parts = id.split('-');
      const role = parts[0];
      if (!boardAssetRoles.has(role)) return;
      const boardId = parseBoardIdFromTargetId(id);
      if (boardId) targetedBoardAssets.add(boardId);
    });
  }
  let shouldGenerateBoardAssets = !targetIdSet || targetedBoardAssets.size > 0;
  const forcedBoardAssetBoards = new Set();
  const preferScriptTruth = Boolean(gameId);
  log('REQUEST TARGETS', {
    packId: 'pending',
    gameId,
    targetIds,
    targetIdSetSize: targetIdSet ? targetIdSet.size : 0,
    targetedBoardAssets: Array.from(targetedBoardAssets),
    shouldGenerateBoardAssets,
    preferScriptTruth,
  });
  const resolvePiecePromptOverride = ({ role, boardId, variant }) => {
    const key = promptKeyFromIdentifier({ role, boardId, variant });
    return key ? promptOverrides.get(key) || null : null;
  };
  const resolveBoardPrompt = ({ role, boardId, name }) => {
    const specificKey = promptKeyFromIdentifier({ role, boardId, variant: null });
    const boardKey = promptKeyFromIdentifier({ role: 'board', boardId, variant: null });
    const specificOverride = specificKey ? promptOverrides.get(specificKey) : null;
    const boardOverride = boardKey ? promptOverrides.get(boardKey) : null;
    const baseSegments = [gameName, stylePrompt, name].map((s) => (s || '').trim()).filter(Boolean);
    const basePrompt = baseSegments.join(' — ') || mergedPrompt || 'custom board game';
    const roleSuffixes = {
      board:
        'top-down board preview with clear grid lines, visible borders, readable squares, centered composition; must look different from the background texture',
      background:
        'seamless board background texture only; no grid lines, no borders, no tiles, subtle and not busy',
      tilelight: 'single light tile texture, subtle shading, consistent scale, no grid lines',
      tiledark: 'single dark tile texture, subtle shading, consistent scale, no grid lines',
    };
    const roleKey = String(role || '').toLowerCase();
    const suffix = roleSuffixes[roleKey] || '';
    const withSuffix = (text) => (suffix ? `${text} — ${suffix}` : text);
    const chosen = specificOverride
      ? withSuffix(specificOverride)
      : boardOverride
        ? withSuffix(boardOverride)
        : withSuffix(basePrompt);
    const { prompt: sanitized } = sanitizePrompt(chosen);
    return sanitized || chosen;
  };
  log('PROMPT OVERRIDES SUMMARY', {
    gameId,
    overrideCount: promptOverrides.size,
    overrideKeys: Array.from(promptOverrides.keys()).slice(0, 20),
  });
  const pendingKey = gameId ? String(gameId) : null;
  const resumePackIdClean = resumePackId && typeof resumePackId === 'string'
    ? resumePackId.trim()
    : null;
  const providerPreference = renderStyle === 'vector' ? effectiveVectorProvider : 'auto';
  const willUseOpenAI = renderStyle === 'vector' && isOpenAiSvgAvailable(providerPreference, openAiKey);
  const openAiEnv = getOpenAiSvgEnv(openAiKey);
  const progressChannelResolved =
    typeof progressChannel === 'string' && progressChannel.trim()
      ? progressChannel.trim()
      : nanoid(12);
  if (renderStyle === 'vector' && normalizedLocation === 'remote' && !willUseOpenAI && gameId) {
    emitProgressWithGame(
      progressChannelResolved,
      'notice',
      {
        type: 'openai-vector-disabled',
        reason: openAiKey ? 'provider-unavailable' : 'missing-openai-key',
        providerPreference,
      },
      gameId,
    );
  }

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
  const allowReuseExistingPieces = Boolean(allowReuseExisting && reuseExistingPieces !== false);

  if (renderStyle === 'vector' && effectiveVectorProvider === 'openai' && !isOpenAiSvgAvailable('openai', openAiKey)) {
    const msg = 'OpenAI SVG generation requested but no OpenAI API key was provided.';
    log('openai svg unavailable', { gameId, reason: msg });
    emitProgressWithGame(progressChannelResolved, 'error', { packId: null, error: msg }, gameId);
    res.status(400).json({ ok: false, error: msg });
    return;
  }

  if (renderStyle === 'photoreal' && !openAiKey) {
    const msg = 'Photoreal generation requested but no OpenAI API key was provided.';
    log('openai image unavailable', { gameId, reason: msg });
    emitProgressWithGame(progressChannelResolved, 'error', { packId: null, error: msg }, gameId);
    res.status(400).json({ ok: false, error: msg });
    return;
  }

  if (pendingKey && pendingJobs.has(pendingKey)) {
    log('rejecting concurrent pack request', { gameId: pendingKey });
    emitProgressWithGame(
      progressChannelResolved,
      'rejected',
      { reason: 'job_in_progress' },
      pendingKey,
    );
    closeChannel(progressChannelResolved);
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
    vectorProvider: effectiveVectorProvider,
    assetGenerationLocation: normalizedLocation || null,
    willUseOpenAI,
    resumePackId: resumePackIdClean || '<none>',
    reuseExisting: allowReuseExisting,
    reuseExistingPieces: allowReuseExistingPieces,
  });
  log('DETAILED REQUEST SHAPE', {
    packId,
    gameId,
    boardsArray: JSON.stringify(boards),
    piecesArray: JSON.stringify(pieces),
  });

  emitProgressWithGame(
    progressChannelResolved,
    'start',
    {
      packId,
      size,
      roles: pieces?.map((p) => p.role) || [],
      boards: Array.isArray(boards) ? boards.map((b) => b?.id).filter(Boolean) : [],
      renderStyle,
      vectorProvider: effectiveVectorProvider,
      vectorProviderResolved: providerPreference,
      willUseOpenAI,
      openAiAvailable: openAiEnv.openAiAvailable,
      resumePackId: resumePackIdClean,
      reuseExisting: allowReuseExisting,
    },
    gameId,
  );
  log('job start provider', {
    gameId,
    renderStyle,
    vectorProvider: effectiveVectorProvider,
    providerPreference,
    willUseOpenAI,
    openAiEnv,
  });

  let upstreamAbortController = null;

  try {
	    upstreamAbortController = new AbortController();

    if (gameId) {
      trackPendingJob(gameId, {
        ownerUserId,
        controller: upstreamAbortController,
        progressChannel: progressChannelResolved,
        packId,
      });
    }

    attachAbortController(progressChannelResolved, upstreamAbortController);

    await fs.mkdir(baseDir, { recursive: true });
	    await writePackMeta(baseDir, {
	      packId,
	      gameId: gameId || null,
	      createdAt: Date.now(),
	    });

    let boardAssets = {};  // Use 'let' to allow recreation if frozen
    const rewriteAssetUrl = (value) => {
      if (typeof value !== 'string') return value;
      return value.replace(/\/skins\/pack_[^/]+/g, `/skins/${packId}`);
    };
    const rewriteBoardAssets = (input) => {
      if (!input || typeof input !== 'object') return {};
      const out = {};
      Object.entries(input).forEach(([boardId, entry]) => {
        if (!entry || typeof entry !== 'object') return;
        const next = {};
        Object.entries(entry).forEach(([key, value]) => {
          if (key === 'tokens' && value && typeof value === 'object') {
            const tokens = {};
            Object.entries(value).forEach(([tokenKey, tokenUrl]) => {
              tokens[tokenKey] = rewriteAssetUrl(tokenUrl);
            });
            next.tokens = tokens;
            return;
          }
          next[key] = rewriteAssetUrl(value);
        });
        out[boardId] = next;
      });
      return out;
    };
    if (
      preferScriptTruth &&
      (!boardAssets || Object.keys(boardAssets).length === 0) &&
      existingBoardAssets &&
      typeof existingBoardAssets === 'object'
    ) {
      boardAssets = JSON.parse(JSON.stringify(existingBoardAssets));
      log('SCRIPT TRUTH: seeded boardAssets from existingBoardAssets', {
        packId,
        gameId,
        seededBoards: Object.keys(boardAssets || {}),
      });
    }
    // legacy write helpers to keep old paths alive until frontend fully per-board
    const boardsMap = Array.isArray(boards)
      ? boards.reduce((acc, b) => {
          const id = String(b?.id || '').trim();
          if (!id) return acc;
          const rows =
            Number(b?.rows || b?.Rows || b?.grid?.rows || b?.grid?.Rows || b?.Grid?.rows || b?.Grid?.Rows) ||
            null;
          const columns =
            Number(
              b?.columns ||
                b?.Columns ||
                b?.grid?.columns ||
                b?.grid?.Columns ||
                b?.Grid?.columns ||
                b?.Grid?.Columns,
            ) || null;
          acc[id] = {
            id,
            name: b?.name,
            rows,
            columns,
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
    // Manifest writing disabled; keep placeholders for future reactivation.
    const writeManifestPartial = async () => {};
    // Manifest files are not a source of truth; the script's assets block is.
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
    let stateBroadcastTimer = null; // Timer for periodic state broadcasts during generation
    const markCancelled = (reason = 'requested') => {
      if (cancelled) return;
      cancelled = true;
      log('pack generation marked cancelled', { packId, gameId, reason });
    };
    const onControllerAbort = () => {
      markCancelled('abort-signal');
    };
    upstreamAbortController.signal.addEventListener('abort', onControllerAbort);
    // Do not cancel generation if the upstream HTTP client disconnects.
    // Cancellation is explicit via /packs/jobs/cancel.

    const maybeWaitForClient = async ({ boardId, role, variant } = {}) => {
      if (!WAIT_FOR_CLIENT_ADVANCE) return;
      if (cancelled) return;
      // If no clients are currently attached, never block generation (refresh/tab swaps should not stall).
      if (getClientCount(progressChannelResolved) <= 0) return;

      const advanced = await waitForClientAdvance(progressChannelResolved, {
        signal: upstreamAbortController.signal,
        timeoutMs: CLIENT_ADVANCE_TIMEOUT_MS,
      });
      if (!advanced && !cancelled) {
        log('client advance timeout (continuing)', { packId, gameId, boardId, role, variant });
      }
    };

    await writeManifestPartial(false);

    let boardIds = Object.keys(boardsMap).length ? Object.keys(boardsMap) : ['board-1'];
    if (targetIdSet && targetIdSet.size) {
      const targetedBoardsFromIds = new Set();
      targetIdSet.forEach((id) => {
        const boardId = parseBoardIdFromTargetId(id);
        if (boardId) targetedBoardsFromIds.add(boardId);
      });
      if (targetedBoardsFromIds.size) {
        boardIds = boardIds.filter((id) => targetedBoardsFromIds.has(String(id).toLowerCase()));
      }
    }
    
    log('BEFORE FILTERING', {
      packId,
      gameId,
      boardIds,
      targetBoardIds,
      existingBoardAssetsKeys: Object.keys(existingBoardAssets || {}),
    });
    
    // Filter to only regenerate targeted boards if specified
    if (Array.isArray(targetBoardIds) && targetBoardIds.length > 0) {
      const targetSet = new Set(targetBoardIds.map(id => String(id).toLowerCase()));
      boardIds = boardIds.filter(id => targetSet.has(String(id).toLowerCase()));
      log('FILTERED TO TARGET BOARDS', {
        packId,
        gameId,
        allBoards: Object.keys(boardsMap),
        targetBoardIds,
        filteredBoardIds: boardIds,
      });
      
      // Copy non-targeted boards from their existing packs
      if (!preferScriptTruth && existingBoardAssets && typeof existingBoardAssets === 'object') {
        // Get ALL board IDs from existingBoardAssets, not just from boardsMap
        const allExistingBoardIds = Object.keys(existingBoardAssets);
        const nonTargetedBoards = allExistingBoardIds.filter(id => !targetSet.has(String(id).toLowerCase()));
        
        log('COPYING NON-TARGETED BOARDS', {
          packId,
          gameId,
          allExistingBoardIds,
          targetBoardIds,
          nonTargetedBoards,
          existingBoardAssetsKeys: Object.keys(existingBoardAssets),
        });
        
        for (const boardId of nonTargetedBoards) {
          const existing = existingBoardAssets[boardId];
          if (!existing || typeof existing !== 'object') {
            log('no existing assets for board', { packId, boardId });
            continue;
          }
          
          // Extract source pack ID from any existing URL
          const sourcePackId = (() => {
            const urls = [
              existing.background,
              existing.tileLight,
              existing.tileDark,
              existing.boardPreview,
              existing.cover,
            ].filter(Boolean);
            for (const url of urls) {
              const match = String(url).match(/\/skins\/(pack_[^\/]+)\//);
              if (match) return match[1];
            }
            return null;
          })();
          
          if (!sourcePackId && resumePackIdClean) {
            sourcePackId = resumePackIdClean;
            log('fallback source pack to resume pack', {
              packId,
              boardId,
              sourcePackId,
            });
          }

          if (!sourcePackId) {
            log('could not extract source pack for board', { packId, boardId, existing });
            continue;
          }
          
          let sourcePath = path.join(packsDir, sourcePackId, boardId);
          const destPath = path.join(baseDir, boardId);
          
          try {
            // Check if source exists, fallback to resume pack if the extracted one was cleaned.
            const sourceExists = await pathExists(sourcePath);
            if (!sourceExists && resumePackIdClean && resumePackIdClean !== sourcePackId) {
              const fallbackPath = path.join(packsDir, resumePackIdClean, boardId);
              const fallbackExists = await pathExists(fallbackPath);
              if (fallbackExists) {
                log('fallback to resume pack for board copy', {
                  packId,
                  boardId,
                  sourcePackId,
                  fallbackPackId: resumePackIdClean,
                });
                sourcePackId = resumePackIdClean;
                sourcePath = fallbackPath;
              } else {
                const latestPackId = await findLatestPackForBoard(packsDir, boardId, packId);
                if (latestPackId) {
                  log('fallback to latest available pack for board copy', {
                    packId,
                    boardId,
                    sourcePackId,
                    fallbackPackId: resumePackIdClean,
                    latestPackId,
                  });
                  sourcePackId = latestPackId;
                  sourcePath = path.join(packsDir, latestPackId, boardId);
                } else {
                  log('no source board directory found', {
                    packId,
                    boardId,
                    sourcePackId,
                    fallbackPackId: resumePackIdClean,
                  });
                  continue;
                }
              }
            } else if (!sourceExists) {
              const latestPackId = await findLatestPackForBoard(packsDir, boardId, packId);
              if (latestPackId) {
                log('fallback to latest available pack for board copy', {
                  packId,
                  boardId,
                  sourcePackId,
                  latestPackId,
                });
                sourcePackId = latestPackId;
                sourcePath = path.join(packsDir, latestPackId, boardId);
              } else {
                log('no source board directory found', { packId, boardId, sourcePackId });
                continue;
              }
            }
            
            // Copy the entire board directory
            await fs.cp(sourcePath, destPath, { recursive: true });
            
            // Update boardAssets with new URLs
            // Build a fresh object to avoid any frozen object issues
            const updatedBoardData = {};
            if (existing.boardPreview) {
              updatedBoardData.boardPreview = existing.boardPreview.replace(sourcePackId, packId);
            }
            if (existing.cover) {
              updatedBoardData.cover = existing.cover.replace(sourcePackId, packId);
            }
            if (existing.background) {
              updatedBoardData.background = existing.background.replace(sourcePackId, packId);
            }
            if (existing.tileLight) {
              updatedBoardData.tileLight = existing.tileLight.replace(sourcePackId, packId);
            }
            if (existing.tileDark) {
              updatedBoardData.tileDark = existing.tileDark.replace(sourcePackId, packId);
            }
            if (existing.tokens && typeof existing.tokens === 'object') {
              updatedBoardData.tokens = {};
              for (const [variant, url] of Object.entries(existing.tokens)) {
                if (typeof url === 'string') {
                  updatedBoardData.tokens[variant] = url.replace(sourcePackId, packId);
                }
              }
            }
            // Assign the complete object at once
            // Defensive: if boardAssets is frozen, recreate it
            try {
              // Deep clone boardAssets before assignment to avoid frozen object issues
              if (Object.isFrozen(boardAssets)) {
                boardAssets = JSON.parse(JSON.stringify(boardAssets));
              }
              boardAssets[boardId] = updatedBoardData;
            } catch (assignError) {
              if (assignError.message && assignError.message.includes('read only')) {
                log('boardAssets was frozen, recreating as mutable', {
                  packId,
                  boardId,
                  existingKeys: Object.keys(boardAssets),
                });
                // Recreate as a fresh mutable object
                boardAssets = JSON.parse(JSON.stringify({ ...boardAssets, [boardId]: updatedBoardData }));
              } else {
                throw assignError;
              }
            }
            
            log('copied board from existing pack', {
              packId,
              boardId,
              sourcePackId,
              copiedAssets: Object.keys(boardAssets[boardId] || {}),
            });
          } catch (err) {
            log('failed to copy board from existing pack', {
              packId,
              boardId,
              sourcePackId,
              error: err?.message || err,
            });
          }
        }
      }
    }

    if (allowReuseExisting && resumeSourceDir) {
      if (existingBoardAssets && typeof existingBoardAssets === 'object') {
        boardAssets = preferScriptTruth
          ? JSON.parse(JSON.stringify(existingBoardAssets))
          : rewriteBoardAssets(existingBoardAssets);
        log('REUSE EXISTING: seeded boardAssets from existingBoardAssets', {
          packId,
          gameId,
          boardIds,
          seededBoards: Object.keys(boardAssets || {}),
          preferScriptTruth,
        });
      }
      for (const boardId of boardIds) {
        try {
          if (preferScriptTruth) {
            log('REUSE EXISTING: skipping cover/pieces copy (script truth mode)', {
              packId,
              boardId,
            });
            continue;
          }
          const srcCover = path.join(resumeSourceDir, boardId, 'cover');
          const destCover = path.join(baseDir, boardId, 'cover');
          const srcPieces = path.join(resumeSourceDir, boardId, 'pieces');
          const destPieces = path.join(baseDir, boardId, 'pieces');
          const coverId = formatIdentifier({ role: 'cover', boardId, variant: null }).toLowerCase();
          const isCoverTargeted = Boolean(targetIdSet && targetIdSet.has(coverId));
          const hasTargetedPieceForBoard = Boolean(
            targetIdSet &&
              Array.from(targetIdSet).some((id) => {
                if (!id || !id.includes(`-${boardId}-`)) return false;
                return !(
                  id.startsWith('cover-') ||
                  id.startsWith('background-') ||
                  id.startsWith('tilelight-') ||
                  id.startsWith('tiledark-') ||
                  id.startsWith('board-')
                );
              }),
          );
          const shouldCopyCover = !isCoverTargeted;
          const shouldCopyPieces = !hasTargetedPieceForBoard;
          const coverExists = shouldCopyCover && (await pathExists(srcCover));
          const piecesExists = shouldCopyPieces && (await pathExists(srcPieces));
          if (coverExists) {
            await fs.mkdir(destCover, { recursive: true });
            await fs.cp(srcCover, destCover, { recursive: true });
          }
          if (piecesExists) {
            await fs.mkdir(destPieces, { recursive: true });
            await fs.cp(srcPieces, destPieces, { recursive: true });
          }
          log('REUSE EXISTING: copied cover/pieces', {
            packId,
            boardId,
            from: resumePackIdClean,
            coverCopied: coverExists,
            piecesCopied: piecesExists,
          });
        } catch (err) {
          log('REUSE EXISTING: failed to copy cover/pieces', {
            packId,
            boardId,
            error: err?.message || err,
          });
        }
      }
    }

    // If we are NOT regenerating board assets, still copy existing board art for targeted boards
    // so cover/piece-only regenerations don't wipe board/tiles/preview files.
    if (allowReuseExisting && resumeSourceDir && !shouldGenerateBoardAssets) {
      for (const boardId of boardIds) {
        try {
          if (preferScriptTruth) {
            log('REUSE EXISTING: skipping board art copy (script truth mode)', {
              packId,
              boardId,
            });
            continue;
          }
          const srcBoard = path.join(resumeSourceDir, boardId, 'board');
          const destBoard = path.join(baseDir, boardId, 'board');
          const boardExists = await pathExists(srcBoard);
          if (!boardExists) {
            forcedBoardAssetBoards.add(String(boardId).toLowerCase());
            log('REUSE EXISTING: board art missing, forcing generation', {
              packId,
              boardId,
              srcBoard,
            });
            continue;
          }
          await fs.mkdir(destBoard, { recursive: true });
          await fs.cp(srcBoard, destBoard, { recursive: true });
          const boardPreviewRel = `/skins/${packId}/${boardId}/board/preview.svg`;
          const bgRel = `/skins/${packId}/${boardId}/board/background.svg`;
          const lightRel = `/skins/${packId}/${boardId}/board/tileLight.svg`;
          const darkRel = `/skins/${packId}/${boardId}/board/tileDark.svg`;
          boardAssets[boardId] ||= {};
          boardAssets[boardId].boardPreview ||= boardPreviewRel;
          boardAssets[boardId].background ||= bgRel;
          boardAssets[boardId].tileLight ||= lightRel;
          boardAssets[boardId].tileDark ||= darkRel;
          boardsMap[boardId] ||= { id: boardId };
          boardsMap[boardId].preview ||= boardPreviewRel;
          boardsMap[boardId].background ||= bgRel;
          boardsMap[boardId].tileLight ||= lightRel;
          boardsMap[boardId].tileDark ||= darkRel;
          log('REUSE EXISTING: copied board art for targeted board', { packId, boardId });
        } catch (err) {
          log('REUSE EXISTING: failed to copy board art', {
            packId,
            boardId,
            error: err?.message || err,
          });
        }
      }
    }

    if (forcedBoardAssetBoards.size > 0) {
      shouldGenerateBoardAssets = true;
      log('FORCING BOARD ASSET GENERATION', {
        packId,
        gameId,
        forcedBoards: Array.from(forcedBoardAssetBoards),
      });
    }

    // Seed server-side job state so refresh/resume can show current progress + already-written URLs.
    // This is intentionally lightweight: just statuses, prompts, and a minimal boardAssets skeleton.
    if (gameId) {
      const initialPieces = {};
      const ensureBoardBucket = (out, boardId) => {
        if (!out[boardId]) {
          out[boardId] = {
            boardPreview: null,
            cover: null,
            background: null,
            tileLight: null,
            tileDark: null,
            tokens: {},
          };
        }
        if (!out[boardId].tokens || typeof out[boardId].tokens !== 'object') {
          out[boardId].tokens = {};
        }
        return out[boardId];
      };
      const initialBoardAssets = {};

      if (shouldGenerateBoardAssets) {
        boardIds.forEach((bid) => {
          ensureBoardBucket(initialBoardAssets, bid);
          ['board', 'background', 'tileLight', 'tileDark'].forEach((role) => {
            const id = formatIdentifier({ role, boardId: bid, variant: null });
            const normalizedId = id.toLowerCase();
            if (targetIdSet && !targetIdSet.has(normalizedId)) return;
            initialPieces[id] = {
              id,
              role,
              boardId: bid,
              variant: null,
              status: 'queued',
              prompt: resolveBoardPrompt({ role, boardId: bid, name: boardsMap?.[bid]?.name }),
            };
          });
        });
      }

      orderedPieces.forEach((p) => {
        const normalizedRole = String(p.role || '').toLowerCase();
        const isCover = normalizedRole === 'cover';
        const variants = Array.isArray(p.variants) ? p.variants : [];
        for (const bid of boardIds) {
          ensureBoardBucket(initialBoardAssets, bid);
          for (const vRaw of variants) {
            const variant = String(isCover ? 'main' : vRaw || 'p1').toLowerCase();
            const promptOverride = resolvePiecePromptOverride({
              role: normalizedRole,
              boardId: bid,
              variant: variant === 'main' ? null : variant,
            });
            const id = formatIdentifier({
              role: normalizedRole,
              boardId: bid,
              variant: variant === 'main' ? null : variant,
            });
            const normalizedId = id.toLowerCase();
            if (!targetIdSet || targetIdSet.has(normalizedId)) {
              initialPieces[id] = {
                id,
                role: normalizedRole,
                boardId: bid,
                variant,
                status: 'queued',
                prompt:
                  promptOverride ||
                  (typeof p.prompt === 'string' && p.prompt.trim()
                    ? p.prompt.trim()
                    : null),
              };
            }

            const bucket = ensureBoardBucket(initialBoardAssets, bid);
            if (isCover) continue;
            if (normalizedRole === 'token') {
              if (!(variant in bucket.tokens)) bucket.tokens[variant] = null;
            } else {
              const tokenKey = `${variant}-${normalizedRole}`;
              if (!(tokenKey in bucket.tokens)) bucket.tokens[tokenKey] = null;
            }
          }
        }
      });

      seedJobState(gameId, {
        ownerUserId,
        packId,
        renderStyle,
        renderDetail,
        baseUrl: `/skins/${packId}`,
        manifestUrl: null,
        progressChannel: progressChannelResolved,
        active: true,
        pieces: initialPieces,
        boardAssets: initialBoardAssets,
        activePiece: null,
      });
      emitStateSnapshot(gameId);
    }

    const totalPieceCount =
      boardIds.length *
      orderedPieces.reduce(
        (sum, piece) => sum + (Array.isArray(piece.variants) ? piece.variants.length : 0),
        0,
      );
    
    log('GENERATION LOOP STARTING', {
      packId,
      gameId,
      boardIds: JSON.stringify(boardIds),
      orderedPieces: JSON.stringify(orderedPieces.map(p => ({ role: p.role, variants: p.variants }))),
      totalPieceCount,
    });

    // Generate board assets (SVG/OpenAI) for boards when requested.
      if (boardIds.length && shouldGenerateBoardAssets) {
        const applyBoardPreviewOverlay = (svg) => {
          if (!svg || typeof svg !== 'string') return svg;
          const viewBoxMatch = svg.match(/viewBox="0 0 ([0-9.]+) ([0-9.]+)"/i);
          const vbW = viewBoxMatch ? Number(viewBoxMatch[1]) : 100;
          const vbH = viewBoxMatch ? Number(viewBoxMatch[2]) : 100;
          const insetX = vbW * 0.02;
          const insetY = vbH * 0.02;
          const borderW = vbW - insetX * 2;
          const borderH = vbH - insetY * 2;
          const radius = Math.min(vbW, vbH) * 0.06;
          const overlay = [
            `<rect x="0" y="0" width="${vbW}" height="${vbH}" fill="black" fill-opacity="0.04" />`,
            `<rect x="${insetX}" y="${insetY}" width="${borderW}" height="${borderH}" rx="${radius}" ry="${radius}" fill="none" stroke="black" stroke-opacity="0.18" stroke-width="${Math.min(vbW, vbH) * 0.012}" />`,
          ].join('');
          if (svg.includes('</svg>')) {
            return svg.replace('</svg>', `${overlay}</svg>`);
          }
          return svg;
        };
        const normalizeSvgToBoardSize = (svg, boardId) => {
          if (!svg || typeof svg !== 'string') return svg;
          const rows = Number(boardsMap?.[boardId]?.rows) || null;
          const columns = Number(boardsMap?.[boardId]?.columns) || null;
          if (!rows || !columns) return svg;
          const targetW = columns * 128;
          const targetH = rows * 128;
          const viewBoxMatch = svg.match(/viewBox="0 0 ([0-9.]+) ([0-9.]+)"/i);
          const sourceW = viewBoxMatch ? Number(viewBoxMatch[1]) : 100;
          const sourceH = viewBoxMatch ? Number(viewBoxMatch[2]) : 100;
          if (!sourceW || !sourceH) return svg;
          if (sourceW === targetW && sourceH === targetH) return svg;
          const innerMatch = svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/i);
          const inner = innerMatch ? innerMatch[1] : svg;
          const scaleX = targetW / sourceW;
          const scaleY = targetH / sourceH;
          return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${targetW} ${targetH}"><g transform="scale(${scaleX} ${scaleY})">${inner}</g></svg>`;
        };
        const writeBoardAsset = async (boardId, name) => {
          if (targetIdSet && targetedBoardAssets.size && !targetedBoardAssets.has(String(boardId).toLowerCase())) {
            log('writeBoardAsset skipping board (not targeted)', { packId, boardId });
            return;
          }
        const boardPreviewId = formatIdentifier({ role: 'board', boardId, variant: null }).toLowerCase();
        const backgroundId = formatIdentifier({ role: 'background', boardId, variant: null }).toLowerCase();
        const tileLightId = formatIdentifier({ role: 'tileLight', boardId, variant: null }).toLowerCase();
        const tileDarkId = formatIdentifier({ role: 'tileDark', boardId, variant: null }).toLowerCase();
        const forceBoardAssets = forcedBoardAssetBoards.has(String(boardId).toLowerCase());
        const wantsBoardPreview = forceBoardAssets || !targetIdSet || targetIdSet.has(boardPreviewId);
        const wantsBackground = forceBoardAssets || !targetIdSet || targetIdSet.has(backgroundId);
        const wantsTileLight = forceBoardAssets || !targetIdSet || targetIdSet.has(tileLightId);
        const wantsTileDark = forceBoardAssets || !targetIdSet || targetIdSet.has(tileDarkId);
        const hasTargetedBoardAssets =
          forceBoardAssets ||
          (targetIdSet && (wantsBoardPreview || wantsBackground || wantsTileLight || wantsTileDark));
          const boardPath = path.join(baseDir, boardId, 'board');
          await fs.mkdir(boardPath, { recursive: true });
          let boardAssetMode = 'template';
          
          log('writeBoardAsset start', { 
            boardId, 
            resumeSourceDir: resumeSourceDir ? 'exists' : 'null',
            resumeSourceDirPath: resumeSourceDir,
          });
          
          // CRITICAL: Always copy existing board assets when resumeSourceDir exists
          // This preserves board-1 assets when adding board-2
          const shouldCopyExisting =
            resumeSourceDir &&
            !(Array.isArray(targetBoardIds) && targetBoardIds.length > 0);
          let existingBoardPath = resumeSourceDir ? path.join(resumeSourceDir, boardId, 'board') : null;
          let copiedFromExisting = false;
          
          log('writeBoardAsset paths', {
            packId,
            boardId,
            shouldCopyExisting,
            existingBoardPath,
            newBoardPath: boardPath,
          });

          if (existingBoardPath && !(await pathExists(existingBoardPath))) {
            const latestPackId = await findLatestPackForBoard(packsDir, boardId, packId);
            if (latestPackId) {
              existingBoardPath = path.join(packsDir, latestPackId, boardId, 'board');
              log('writeBoardAsset fallback existingBoardPath', {
                packId,
                boardId,
                latestPackId,
                existingBoardPath,
              });
            }
          }

          if (hasTargetedBoardAssets && !existingBoardPath) {
            const removed = [];
            const currentAssets = boardAssets[boardId] || {};
            const nextAssets = { ...currentAssets };
            if (!wantsBoardPreview && nextAssets.boardPreview) {
              delete nextAssets.boardPreview;
              removed.push('boardPreview');
            }
            if (!wantsBackground && nextAssets.background) {
              delete nextAssets.background;
              removed.push('background');
            }
            if (!wantsTileLight && nextAssets.tileLight) {
              delete nextAssets.tileLight;
              removed.push('tileLight');
            }
            if (!wantsTileDark && nextAssets.tileDark) {
              delete nextAssets.tileDark;
              removed.push('tileDark');
            }
            if (removed.length) {
              boardAssets[boardId] = nextAssets;
            }
            const currentMap = boardsMap[boardId] || {};
            const nextMap = { ...currentMap };
            if (!wantsBoardPreview && nextMap.preview) delete nextMap.preview;
            if (!wantsBackground && nextMap.background) delete nextMap.background;
            if (!wantsTileLight && nextMap.tileLight) delete nextMap.tileLight;
            if (!wantsTileDark && nextMap.tileDark) delete nextMap.tileDark;
            boardsMap[boardId] = nextMap;
            log('writeBoardAsset pruned untargeted (no resume)', {
              packId,
              boardId,
              removed,
            });
          }
          
          if (existingBoardPath) {
            try {
              const existingBgPath = path.join(existingBoardPath, 'background.svg');
              const existingLightPath = path.join(existingBoardPath, 'tileLight.svg');
              const existingDarkPath = path.join(existingBoardPath, 'tileDark.svg');
              const existingPreviewPath = path.join(existingBoardPath, 'preview.svg');
              
              log('writeBoardAsset checking files', {
                packId,
                boardId,
                existingBgPath,
                existingLightPath,
                existingDarkPath,
                existingPreviewPath,
              });
              
              // Check if all required files exist
              const [bgExists, lightExists, darkExists, previewExists] = await Promise.all([
                pathExists(existingBgPath),
                pathExists(existingLightPath),
                pathExists(existingDarkPath),
                pathExists(existingPreviewPath),
              ]);
              
              log('writeBoardAsset file existence check', {
                packId,
                boardId,
                bgExists,
                lightExists,
                darkExists,
                previewExists,
                allExist: bgExists && lightExists && darkExists && previewExists,
              });
              
              if (bgExists && lightExists && darkExists && previewExists) {
                // Copy all board assets from existing pack
                log('writeBoardAsset copying files', { packId, boardId, from: resumePackIdClean });
                await Promise.all([
                  fs.copyFile(existingBgPath, path.join(boardPath, 'background.svg')),
                  fs.copyFile(existingLightPath, path.join(boardPath, 'tileLight.svg')),
                  fs.copyFile(existingDarkPath, path.join(boardPath, 'tileDark.svg')),
                  fs.copyFile(existingPreviewPath, path.join(boardPath, 'preview.svg')),
                ]);
                
                const bgRel = `/skins/${packId}/${boardId}/board/background.svg`;
                const lightRel = `/skins/${packId}/${boardId}/board/tileLight.svg`;
                const darkRel = `/skins/${packId}/${boardId}/board/tileDark.svg`;
                const boardPreviewRel = `/skins/${packId}/${boardId}/board/preview.svg`;
                
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
                
                copiedFromExisting = true;
                boardAssetMode = 'copied';
                log('copied existing board assets', { packId, boardId, from: resumePackIdClean });
              } else {
                log('writeBoardAsset skipping copy - not all files exist', {
                  packId,
                  boardId,
                  bgExists,
                  lightExists,
                  darkExists,
                  previewExists,
                });
              }
            } catch (err) {
              log('failed to copy existing board assets, will regenerate', { 
                packId, 
                boardId, 
                error: err?.message,
                stack: err?.stack,
              });
            }
          } else {
            log('writeBoardAsset no existingBoardPath', { packId, boardId });
          }

          if (existingBoardPath && hasTargetedBoardAssets) {
            const copyIfPresent = async (sourcePath, destPath, label) => {
              try {
                const exists = await pathExists(sourcePath);
                if (!exists) return false;
                await fs.copyFile(sourcePath, destPath);
                log('writeBoardAsset copied untargeted asset', { packId, boardId, label });
                return true;
              } catch (err) {
                log('writeBoardAsset failed to copy untargeted asset', {
                  packId,
                  boardId,
                  label,
                  error: err?.message || err,
                });
                return false;
              }
            };

            const bgRel = `/skins/${packId}/${boardId}/board/background.svg`;
            const lightRel = `/skins/${packId}/${boardId}/board/tileLight.svg`;
            const darkRel = `/skins/${packId}/${boardId}/board/tileDark.svg`;
            const boardPreviewRel = `/skins/${packId}/${boardId}/board/preview.svg`;

            if (!wantsBackground) {
              const copied = await copyIfPresent(
                path.join(existingBoardPath, 'background.svg'),
                path.join(boardPath, 'background.svg'),
                'background',
              );
              if (copied) {
                boardAssets[boardId] = {
                  ...(boardAssets[boardId] || {}),
                  background: bgRel,
                };
                boardsMap[boardId] = {
                  ...(boardsMap[boardId] || {}),
                  id: boardId,
                  name: name || boardsMap[boardId]?.name || boardId,
                  background: bgRel,
                };
              } else {
                if (boardAssets[boardId]?.background) {
                  delete boardAssets[boardId].background;
                }
                if (boardsMap[boardId]?.background) {
                  delete boardsMap[boardId].background;
                }
              }
            }
            if (!wantsTileLight) {
              const copied = await copyIfPresent(
                path.join(existingBoardPath, 'tileLight.svg'),
                path.join(boardPath, 'tileLight.svg'),
                'tileLight',
              );
              if (copied) {
                boardAssets[boardId] = {
                  ...(boardAssets[boardId] || {}),
                  tileLight: lightRel,
                };
                boardsMap[boardId] = {
                  ...(boardsMap[boardId] || {}),
                  id: boardId,
                  name: name || boardsMap[boardId]?.name || boardId,
                  tileLight: lightRel,
                };
              } else {
                if (boardAssets[boardId]?.tileLight) {
                  delete boardAssets[boardId].tileLight;
                }
                if (boardsMap[boardId]?.tileLight) {
                  delete boardsMap[boardId].tileLight;
                }
              }
            }
            if (!wantsTileDark) {
              const copied = await copyIfPresent(
                path.join(existingBoardPath, 'tileDark.svg'),
                path.join(boardPath, 'tileDark.svg'),
                'tileDark',
              );
              if (copied) {
                boardAssets[boardId] = {
                  ...(boardAssets[boardId] || {}),
                  tileDark: darkRel,
                };
                boardsMap[boardId] = {
                  ...(boardsMap[boardId] || {}),
                  id: boardId,
                  name: name || boardsMap[boardId]?.name || boardId,
                  tileDark: darkRel,
                };
              } else {
                if (boardAssets[boardId]?.tileDark) {
                  delete boardAssets[boardId].tileDark;
                }
                if (boardsMap[boardId]?.tileDark) {
                  delete boardsMap[boardId].tileDark;
                }
              }
            }
            if (!wantsBoardPreview) {
              const copied = await copyIfPresent(
                path.join(existingBoardPath, 'preview.svg'),
                path.join(boardPath, 'preview.svg'),
                'preview',
              );
              if (copied) {
                boardAssets[boardId] = {
                  ...(boardAssets[boardId] || {}),
                  boardPreview: boardPreviewRel,
                };
                boardsMap[boardId] = {
                  ...(boardsMap[boardId] || {}),
                  id: boardId,
                  name: name || boardsMap[boardId]?.name || boardId,
                  preview: boardPreviewRel,
                };
              } else {
                if (boardAssets[boardId]?.boardPreview) {
                  delete boardAssets[boardId].boardPreview;
                }
                if (boardsMap[boardId]?.preview) {
                  delete boardsMap[boardId].preview;
                }
              }
            }
          }
          
          // Only generate if we didn't copy from existing, or if we explicitly targeted board assets.
          if (!copiedFromExisting || hasTargetedBoardAssets) {
            log('writeBoardAsset generating new assets', { 
              packId, 
              boardId,
              reason: existingBoardPath ? 'copy failed or files missing' : 'no resume pack',
            });
            
            const light = theme?.p1Color || '#e8e8e8';
            const dark = theme?.p2Color || '#d8d8d8';
            const accent = theme?.accent || '#ffd60a';
            const outline = theme?.outline || '#202020';

            const backgroundPromptForModel = resolveBoardPrompt({
              role: 'background',
              boardId,
              name,
            });
            const boardPreviewPromptForModel = resolveBoardPrompt({
              role: 'board',
              boardId,
              name,
            });
            const tileLightPromptForModel = resolveBoardPrompt({
              role: 'tileLight',
              boardId,
              name,
            });
            const tileDarkPromptForModel = resolveBoardPrompt({
              role: 'tileDark',
              boardId,
              name,
            });
          const wantsPhotorealBoards =
              renderStyle === 'photoreal' && normalizedLocation === 'remote' && openAiKey;
            const wantsVectorBoards =
              renderStyle === 'vector' && normalizedLocation === 'remote' && willUseOpenAI;
            log('BOARD PROMPT RESOLVE', {
              packId,
              boardId,
              wantsBoardPreview,
              wantsBackground,
              wantsTileLight,
              wantsTileDark,
              renderDetail,
              boardPreviewPromptPreview: String(boardPreviewPromptForModel || '').slice(0, 160),
              backgroundPromptPreview: String(backgroundPromptForModel || '').slice(0, 160),
              tileLightPromptPreview: String(tileLightPromptForModel || '').slice(0, 160),
              tileDarkPromptPreview: String(tileDarkPromptForModel || '').slice(0, 160),
            });

            let backgroundSvg = null;
            let previewSvg = null;
            let tileLightSvg = null;
            let tileDarkSvg = null;
            if (wantsPhotorealBoards) {
              try {
                if (wantsBackground || wantsBoardPreview) {
                  backgroundSvg = await generatePhotoBoardSVG({
                    kind: 'background',
                    prompt: backgroundPromptForModel,
                    size: 1024,
                    theme,
                    signal: upstreamAbortController.signal,
                    apiKey: openAiKey,
                    renderDetail,
                  });
                  if (wantsBoardPreview) {
                    previewSvg = backgroundSvg;
                  }
                }
                if (wantsTileLight) {
                  tileLightSvg = await generatePhotoBoardSVG({
                    kind: 'tileLight',
                    prompt: tileLightPromptForModel,
                    size: 512,
                    theme,
                    signal: upstreamAbortController.signal,
                    apiKey: openAiKey,
                    renderDetail,
                  });
                }
                if (wantsTileDark) {
                  tileDarkSvg = await generatePhotoBoardSVG({
                    kind: 'tileDark',
                    prompt: tileDarkPromptForModel,
                    size: 512,
                    theme,
                    signal: upstreamAbortController.signal,
                    apiKey: openAiKey,
                    renderDetail,
                  });
                }
                boardAssetMode = 'openai-photoreal';
              } catch (err) {
                log('photo board generation failed, falling back', {
                  packId,
                  boardId,
                  error: err?.message || err,
                });
              }
            } else if (wantsVectorBoards) {
              try {
                if (wantsBackground || wantsBoardPreview) {
                  backgroundSvg = await generateAISVG({
                    role: 'background',
                    variant: 'main',
                    prompt: backgroundPromptForModel,
                    size: 1024,
                    theme,
                    signal: upstreamAbortController.signal,
                    providerPreference,
                    apiKey: openAiKey,
                  });
                  if (wantsBoardPreview) {
                    try {
                      log('board preview ai request', {
                        packId,
                        boardId,
                        promptPreview: String(boardPreviewPromptForModel || '').slice(0, 160),
                        providerPreference,
                      });
                      previewSvg = await generateAISVG({
                        role: 'board',
                        variant: 'preview',
                        prompt: boardPreviewPromptForModel,
                        size: 1024,
                        theme,
                        signal: upstreamAbortController.signal,
                        providerPreference,
                        apiKey: openAiKey,
                      });
                      log('board preview ai success', {
                        packId,
                        boardId,
                        length: previewSvg ? String(previewSvg).length : 0,
                      });
                    } catch (err) {
                      log('board preview ai failed', {
                        packId,
                        boardId,
                        error: err?.message || err,
                      });
                    }
                  }
                }
                if (wantsTileLight) {
                  tileLightSvg = await generateAISVG({
                    role: 'tileLight',
                    variant: 'light',
                    prompt: tileLightPromptForModel,
                    size: 512,
                    theme,
                    signal: upstreamAbortController.signal,
                    providerPreference,
                    apiKey: openAiKey,
                  });
                }
                if (wantsTileDark) {
                  tileDarkSvg = await generateAISVG({
                    role: 'tileDark',
                    variant: 'dark',
                    prompt: tileDarkPromptForModel,
                    size: 512,
                    theme,
                    signal: upstreamAbortController.signal,
                    providerPreference,
                    apiKey: openAiKey,
                  });
                }
                boardAssetMode = 'openai-svg';
              } catch (err) {
                log('vector board ai generation failed, falling back', {
                  packId,
                  boardId,
                  error: err?.message || err,
                });
              }
            }
            
            // Generate with seeds for variation
            const bgSeed = `${gameId || ''}-${packId}-${boardId}-bg-${Date.now()}`;
            const lightSeed = `${gameId || ''}-${packId}-${boardId}-light-${Date.now()}`;
            const darkSeed = `${gameId || ''}-${packId}-${boardId}-dark-${Date.now()}`;
            
            if ((wantsBackground || wantsBoardPreview) && !backgroundSvg) {
              const rows = Number(boardsMap?.[boardId]?.rows) || null;
              const columns = Number(boardsMap?.[boardId]?.columns) || null;
              const width = columns ? columns * 128 : 1024;
              const height = rows ? rows * 128 : 1024;
              backgroundSvg = renderBackgroundSVG({
                light,
                dark,
                accent,
                outline,
                seed: bgSeed,
                width,
                height,
              });
            }
            if (wantsBoardPreview && !previewSvg) {
              previewSvg = applyBoardPreviewOverlay(backgroundSvg);
            }
            backgroundSvg = normalizeSvgToBoardSize(backgroundSvg, boardId);
            previewSvg = normalizeSvgToBoardSize(previewSvg, boardId);
            if (wantsTileLight && !tileLightSvg) {
              tileLightSvg = renderTileSVG({ fill: light, accent, outline, isLight: true, seed: lightSeed });
            }
            if (wantsTileDark && !tileDarkSvg) {
              tileDarkSvg = renderTileSVG({ fill: dark, accent, outline, isLight: false, seed: darkSeed });
            }
            
            const bgRel = `/skins/${packId}/${boardId}/board/background.svg`;
            const lightRel = `/skins/${packId}/${boardId}/board/tileLight.svg`;
            const darkRel = `/skins/${packId}/${boardId}/board/tileDark.svg`;
            const boardPreviewRel = `/skins/${packId}/${boardId}/board/preview.svg`;
            if (wantsBackground && backgroundSvg) {
              await fs.writeFile(path.join(boardPath, 'background.svg'), backgroundSvg, 'utf8');
            }
            if (wantsTileLight && tileLightSvg) {
              await fs.writeFile(path.join(boardPath, 'tileLight.svg'), tileLightSvg, 'utf8');
            }
            if (wantsTileDark && tileDarkSvg) {
              await fs.writeFile(path.join(boardPath, 'tileDark.svg'), tileDarkSvg, 'utf8');
            }
            if (wantsBoardPreview && (previewSvg || backgroundSvg)) {
              await fs.writeFile(
                path.join(boardPath, 'preview.svg'),
                previewSvg || backgroundSvg,
                'utf8',
              );
            }
            boardAssets[boardId] = {
              ...(boardAssets[boardId] || {}),
              ...(wantsBoardPreview ? { boardPreview: boardPreviewRel } : {}),
              ...(wantsBackground ? { background: bgRel } : {}),
              ...(wantsTileLight ? { tileLight: lightRel } : {}),
              ...(wantsTileDark ? { tileDark: darkRel } : {}),
            };
            boardsMap[boardId] = {
              ...(boardsMap[boardId] || {}),
              id: boardId,
              name: name || boardsMap[boardId]?.name || boardId,
              ...(wantsBackground ? { background: bgRel } : {}),
              ...(wantsTileLight ? { tileLight: lightRel } : {}),
              ...(wantsTileDark ? { tileDark: darkRel } : {}),
              ...(wantsBoardPreview ? { preview: boardPreviewRel } : {}),
            };
            
            log('generated new board assets', { packId, boardId });
          }
          if (gameId) {
            emitProgressWithGame(
              progressChannelResolved,
              'notice',
              { type: 'board-assets', boardId, mode: boardAssetMode },
              gameId,
            );
          }
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
      if (gameId) {
        markJobState(gameId, { boardAssets: JSON.parse(JSON.stringify(boardAssets)) });
        for (const bid of boardIds) {
          const bucket = boardAssets?.[bid] || {};
          if (bucket.boardPreview) {
            updateJobPieceState(gameId, bid, 'board', null, {
              status: 'ready',
              url: bucket.boardPreview,
            });
          }
          if (bucket.background) {
            updateJobPieceState(gameId, bid, 'background', null, {
              status: 'ready',
              url: bucket.background,
            });
          }
          if (bucket.tileLight) {
            updateJobPieceState(gameId, bid, 'tileLight', null, {
              status: 'ready',
              url: bucket.tileLight,
            });
          }
          if (bucket.tileDark) {
            updateJobPieceState(gameId, bid, 'tileDark', null, {
              status: 'ready',
              url: bucket.tileDark,
            });
          }
        }
      }
    }

      log('STARTING PIECES GENERATION', {
        packId,
        gameId,
        boardIds: JSON.stringify(boardIds),
        boardAssetsBeforeLoop: JSON.stringify(boardAssets),
      });

      // Start periodic state broadcasts during generation to help reconnecting clients
      // stay synchronized even when the 200-event buffer is full during long-running jobs.
      const STATE_BROADCAST_INTERVAL_MS = Number(process.env.STATE_BROADCAST_INTERVAL_MS || 30_000);
      if (gameId && progressChannelResolved && STATE_BROADCAST_INTERVAL_MS > 0) {
        stateBroadcastTimer = setInterval(() => {
          if (!cancelled) {
            const currentState = jobStates.get(String(gameId));
            if (currentState?.active) {
              emitProgressWithGame(
                progressChannelResolved,
                'state',
                serializeJobState(currentState),
                gameId,
              );
            }
          }
        }, STATE_BROADCAST_INTERVAL_MS);
      }

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
          const pieceId = formatIdentifier({
            role: normalizedRole,
            boardId,
            variant: variant === 'main' ? null : variant,
          }).toLowerCase();
          if (targetIdSet && !targetIdSet.has(pieceId)) {
            continue;
          }
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
            allowReuseExistingPieces && resumeSourceDir
              ? path.join(
                  resumeSourceDir,
                  boardId,
                  isCover ? 'cover' : path.join('pieces', p.role),
                  filename,
                )
              : null;
          let svg = null;
          const boardScopedOverride = resolvePiecePromptOverride({
            role: normalizedRole,
            boardId,
            variant: variant === 'main' ? null : variant,
          });
          const variantPromptOverride = resolveVariantPrompt(p.variantPrompts, variant);
          const promptSegments = (
            boardScopedOverride
              ? [boardScopedOverride]
              : variantPromptOverride
              ? [variantPromptOverride]
              : [mergedPrompt, p.prompt]
          ).map((s) => (s || '').trim());
          const piecePrompt = promptSegments.filter(Boolean).join(' — ');
          const promptForAI = piecePrompt || mergedPrompt || variantPromptOverride || boardScopedOverride || '';
          const { prompt: safePrompt, replacements } = sanitizePrompt(promptForAI);
          const promptForModel = safePrompt || promptForAI || mergedPrompt || 'custom board game';
          const wantsPhotoreal = renderStyle === 'photoreal';

          if (gameId) {
            markJobState(gameId, {
              activePiece: {
                id: pieceId,
                role: normalizedRole,
                boardId,
                variant,
              },
            });
            updateJobPieceState(gameId, boardId, normalizedRole, variant, {
              status: 'loading',
              prompt: promptForModel,
            });
          }

          if (replacements.length && Array.isArray(replacements) && replacements.length > 0) {
            log('prompt sanitized', { packId, role: p.role, variant, replacements });
            emitProgressWithGame(
              progressChannelResolved,
              'notice',
              { packId, role: p.role, variant, replacements },
              gameId,
            );
          }

          emitProgressWithGame(
            progressChannelResolved,
            'piece-start',
            {
              packId,
              boardId,
              role: p.role,
              variant,
              status: 'loading',
              vectorProvider: renderStyle === 'vector' ? effectiveVectorProvider : null,
              vectorProviderResolved: renderStyle === 'vector' ? providerPreference : null,
              openai: renderStyle === 'vector' ? willUseOpenAI : null,
              openAiAvailable: renderStyle === 'vector' ? openAiEnv.openAiAvailable : null,
              openAiHasKey: renderStyle === 'vector' ? openAiEnv.hasKey : null,
              renderDetail: renderStyle === 'photoreal' ? renderDetail : null,
            },
            gameId,
          );

          log('generate piece', {
            packId,
            role: p.role,
            variant,
            renderStyle,
            renderDetail,
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
	                const tokenKey = normalizedRole === 'token' ? variant : `${variant}-${normalizedRole}`;
	                boardAssets[boardId].tokens[tokenKey] = urlPath;
	              }

              emitProgressWithGame(
                progressChannelResolved,
                'piece',
                {
                  packId,
                  boardId,
                  role: p.role,
                  variant,
                  url: urlPath,
                  status: finalStatus,
                  reused: true,
                  resumePackId: resumePackIdClean,
                  prompt: promptForModel,
                },
                gameId,
              );
              if (gameId) {
                updateJobPieceState(gameId, boardId, normalizedRole, variant, {
                  status: finalStatus,
                  url: urlPath,
                  reused: true,
                  prompt: promptForModel,
                });
                markJobState(gameId, {
                  boardAssets: JSON.parse(JSON.stringify(boardAssets)),
                  activePiece: null,
                });
              }
              await writeManifestPartial(false);
              log('reused existing asset', { packId, role: p.role, variant, resumePackId: resumePackIdClean });
              await maybeWaitForClient({ boardId, role: p.role, variant });
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
            try {
              log('photo sprite request', {
                packId,
                role: p.role,
                variant,
                promptPreview: (promptForModel || '').slice(0, 160),
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
              apiKey: openAiKey,
              renderDetail,
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
              emitProgressWithGame(
                progressChannelResolved,
                'piece-error',
                { packId, boardId, role: p.role, variant, error: err?.message || err },
                gameId,
              );
              throw new Error(`Photoreal generation failed for ${p.role}/${variant}: ${err?.message || err}`);
            }
            if (!svg) {
              log('photo sprite generation returned empty', { role: p.role, variant });
              emitProgressWithGame(
                progressChannelResolved,
                'piece-error',
                { packId, boardId, role: p.role, variant, error: `Photoreal generation failed for ${p.role}/${variant}` },
                gameId,
              );
              if (gameId) {
                updateJobPieceState(gameId, boardId, normalizedRole, variant, { status: 'error' });
                markJobState(gameId, { activePiece: null });
              }
              throw new Error(`Photoreal generation failed for ${p.role}/${variant}`);
            }
          } else {
              log('vector ai request', {
                packId,
                role: p.role,
                variant,
                promptPreview: (promptForModel || '').slice(0, 160),
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
                  apiKey: openAiKey,
                });
              } else {
                // Local provider: use template SVGs with variation (don't log as skipped, this IS the local generation)
                log('vector local generation using templates', { packId, role: p.role, variant, providerPreference });
                // Generate immediately using template with seed for variation
                const pieceSeed = `${gameId || ''}-${packId}-${normalizedRole}-${variant}-${Date.now()}`;
                if (isCover) {
                  const coverSeed = `${gameId || ''}-${packId}-${Date.now()}`;
                  svg = renderCoverSVG({ size: pieceSize, theme, title: gameName || stylePrompt || 'Custom Game', seed: coverSeed });
                } else {
                  const fillColor = variant === 'p1' ? theme?.p1Color || '#1e90ff' : variant === 'p2' ? theme?.p2Color || '#ff3b30' : color;
                  // Use token SVG for token roles, chess piece SVG for specific roles
                  if (normalizedRole === 'token') {
                    svg = renderTokenSVG({ 
                      size: pieceSize, 
                      fill: fillColor, 
                      accent: theme?.accent || '#ffd60a', 
                      outline: theme?.outline || '#202020',
                      seed: pieceSeed
                    });
                  } else {
                    svg = renderChessPieceSVG({ 
                      role: normalizedRole, 
                      size: pieceSize, 
                      fill: fillColor, 
                      accent: theme?.accent || '#ffd60a', 
                      outline: theme?.outline || '#202020',
                      seed: pieceSeed
                    });
                  }
                }
                log('vector local template generated', { packId, role: p.role, variant, length: svg?.length || 0 });
              }
              if (cancelled) {
                log('vector svg result discarded due to cancellation', { packId, role: p.role, variant });
                break;
              }
              if (svg) {
                log('vector ai success', { packId, role: p.role, variant, length: svg.length });
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
                  const pieceSeed = `${gameId || ''}-${packId}-${normalizedRole}-${variant}-${Date.now()}`;
                  // Use token SVG for token roles, chess piece SVG for specific roles
                  if (normalizedRole === 'token') {
                    return renderTokenSVG({ 
                      size: pieceSize, 
                      fill: fillColor, 
                      accent: theme?.accent || '#ffd60a', 
                      outline: theme?.outline || '#202020',
                      seed: pieceSeed
                    });
                  } else {
                    return renderChessPieceSVG({ 
                      role: normalizedRole, 
                      size: pieceSize, 
                      fill: fillColor, 
                      accent: theme?.accent || '#ffd60a', 
                      outline: theme?.outline || '#202020',
                      seed: pieceSeed
                    });
                  }
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
            emitProgressWithGame(
              progressChannelResolved,
              'piece-error',
              { packId, boardId, role: p.role, variant, error: `generation failed for ${p.role}/${variant}` },
              gameId,
            );
            if (gameId) {
              updateJobPieceState(gameId, boardId, normalizedRole, variant, { status: 'error' });
              markJobState(gameId, { activePiece: null });
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
	            const tokenKey = normalizedRole === 'token' ? variant : `${variant}-${normalizedRole}`;
	            boardAssets[boardId].tokens[tokenKey] = urlPath;
	          }

          emitProgressWithGame(
            progressChannelResolved,
            'piece',
            {
              packId,
              boardId,
              role: p.role,
              variant,
              url: urlPath,
              status: finalStatus,
              prompt: promptForModel,
              vectorProvider: renderStyle === 'vector' ? effectiveVectorProvider : null,
              vectorProviderResolved: renderStyle === 'vector' ? providerPreference : null,
              openai: renderStyle === 'vector' ? willUseOpenAI : null,
              openAiAvailable: renderStyle === 'vector' ? openAiEnv.openAiAvailable : null,
              openAiHasKey: renderStyle === 'vector' ? openAiEnv.hasKey : null,
            },
            gameId,
          );

          if (gameId) {
            updateJobPieceState(gameId, boardId, normalizedRole, variant, {
              status: finalStatus,
              url: urlPath,
              prompt: promptForModel,
            });
            markJobState(gameId, {
              boardAssets: JSON.parse(JSON.stringify(boardAssets)),
              activePiece: null,
            });
          }

          await writeManifestPartial(false);
          await maybeWaitForClient({ boardId, role: p.role, variant });
        }
      }
    }
    // end board asset generation

    upstreamAbortController.signal.removeEventListener('abort', onControllerAbort);

    if (cancelled) {
      // Stop periodic state broadcasts on cancellation
      if (stateBroadcastTimer) {
        clearInterval(stateBroadcastTimer);
        stateBroadcastTimer = null;
      }

      if (gameId) {
        markJobStateCancelled(gameId);
      }
      clearPendingJob(gameId, upstreamAbortController);
      await writeManifestPartial(false);
      log('pack generation cancelled (partial assets preserved)', { packId, baseDir });
      const finalManifestUrl = null;
      res.status(499).json({
        ok: false,
        cancelled: true,
        error: 'cancelled',
        packId,
        baseUrl: `/skins/${packId}/`,
        manifestUrl: finalManifestUrl,
        boardAssets: sortBoardAssets(boardAssets),
        renderStyle,
        renderDetail,
      });
      return;
    }

    // Count total pieces across all boards
    const totalPieces = Object.values(boardAssets).reduce((count, board) => {
      return count + (board.tokens ? Object.keys(board.tokens).length : 0);
    }, 0);
    
    const totalCovers = Object.values(boardAssets).reduce(
      (count, board) => count + (board.cover ? 1 : 0),
      0,
    );
    const totalBoardFiles = Object.values(boardAssets).reduce((count, board) => {
      return (
        count +
        (board.boardPreview ? 1 : 0) +
        (board.background ? 1 : 0) +
        (board.tileLight ? 1 : 0) +
        (board.tileDark ? 1 : 0)
      );
    }, 0);

    log('pack ready', {
      packId,
      boards: Object.keys(boardAssets).length,
      tokenVariants: totalPieces,
      covers: totalCovers,
      boardFiles: totalBoardFiles,
      totalAssets: totalPieces + totalCovers + totalBoardFiles,
    });
    // Stop periodic state broadcasts now that generation is complete
    if (stateBroadcastTimer) {
      clearInterval(stateBroadcastTimer);
      stateBroadcastTimer = null;
    }

    const stateSnapshot = gameId ? jobStates.get(String(gameId)) : null;
    const promptSnapshot = collectJobPrompts(stateSnapshot);
    const finalManifestUrl = null;
    emitProgressWithGame(
      progressChannelResolved,
      'complete',
      {
        packId,
        baseUrl: `/skins/${packId}/`,
        manifestUrl: finalManifestUrl,
        boardAssets: sortBoardAssets(boardAssets),
        renderStyle,
        renderDetail,
        vectorProvider: renderStyle === 'vector' ? effectiveVectorProvider : null,
        vectorProviderResolved: renderStyle === 'vector' ? providerPreference : null,
        openai: renderStyle === 'vector' ? willUseOpenAI : null,
        openAiAvailable: renderStyle === 'vector' ? openAiEnv.openAiAvailable : null,
        openAiHasKey: renderStyle === 'vector' ? openAiEnv.hasKey : null,
        prompts: promptSnapshot,
      },
      gameId,
    );
    closeChannel(progressChannelResolved);
    if (gameId && upstreamAbortController) {
      clearPendingJob(gameId, upstreamAbortController);
    }
    if (gameId) {
      markJobState(gameId, {
        active: false,
        progressChannel: null,
        activePiece: null,
        manifestUrl: finalManifestUrl,
      });
      const referencedPackIds = extractPackIdsFromBoardAssets(existingBoardAssets);
      referencedPackIds.add(packId);
      // Auto-cleanup old packs: keep 2 most recent per game (plus script-referenced packs)
      cleanupOldPacksForGame(gameId, packsDir, 2, referencedPackIds).catch(err => 
        log('cleanup after generation failed', { gameId, err: err?.message || err })
      );
    }

    res.status(201).json({
      ok: true,
      packId,
      baseUrl: `/skins/${packId}/`,
      manifestUrl: finalManifestUrl,
      boardAssets: sortBoardAssets(boardAssets),
      renderStyle,
      renderDetail,
    });
  } catch (err) {
    // Stop periodic state broadcasts on error
    if (stateBroadcastTimer) {
      clearInterval(stateBroadcastTimer);
      stateBroadcastTimer = null;
    }

    log('pack creation failed', { packId, error: err?.message || err });
    if (gameId) {
      markJobState(gameId, { active: false, progressChannel: null, activePiece: null });
    }
    emitProgressWithGame(
      progressChannelResolved,
      'error',
      {
        packId,
        error: err?.message || err,
      },
      gameId,
    );
    closeChannel(progressChannelResolved);
    if (gameId && upstreamAbortController) {
      clearPendingJob(gameId, upstreamAbortController);
    }
    res.status(500).json({ ok: false, error: err.message });
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
    
    const normalizeGameId = (value) => String(value || '').trim();
    const targetGameId = normalizeGameId(gameId);
    if (!targetGameId) {
      return res.status(400).json({ ok: false, error: 'gameId required' });
    }

    const deleted = [];
    const failed = [];
    
    for (const packName of allPacks) {
      const packPath = path.join(packsDir, packName);
      try {
        const meta = await readPackMeta(packPath);
        const metaGameId = normalizeGameId(meta?.gameId);
        if (!metaGameId || metaGameId !== targetGameId) {
          continue;
        }
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
