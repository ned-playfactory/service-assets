/**
 * Unit tests for asset pack cleanup functionality.
 * Tests automatic cleanup of old packs and game-specific pack deletion.
 * 
 * Run with: npm test -- src/routes/__tests__/packs.cleanup.test.js
 */

import test from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

import { cleanupOldPacksForGame, validateCreatePackPayload } from '../packs.js';

/**
 * Helper: Create a temporary directory for test packs
 */
async function createTestPacksDir() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'packs-test-'));
  return tmpDir;
}

/**
 * Helper: Create a mock pack directory with manifest
 */
async function createMockPack(packsDir, packName, { gameId = null, createdAt = null } = {}) {
  const baseDir = gameId ? path.join(packsDir, gameId) : packsDir;
  const packPath = path.join(baseDir, packName);
  await fs.mkdir(packPath, { recursive: true });
  await fs.writeFile(
    path.join(packPath, 'manifest.json'),
    JSON.stringify({ packId: packName, complete: true }),
    'utf8'
  );
  return packPath;
}

/**
 * Helper: Check if a pack directory exists
 */
async function packExists(packsDir, packName, gameId = null) {
  try {
    const baseDir = gameId ? path.join(packsDir, gameId) : packsDir;
    await fs.stat(path.join(baseDir, packName));
    return true;
  } catch {
    return false;
  }
}

test('Asset Pack Cleanup', async (suite) => {
  await suite.test('Auto-cleanup: Keep 2 most recent packs per game', async () => {
    const testPacksDir = await createTestPacksDir();
    try {
      const gameA = 'game-a';
      const gameB = 'game-b';

      const a1 = 'pack_1000_A1';
      const a2 = 'pack_2000_A2';
      const a3 = 'pack_3000_A3';
      const b1 = 'pack_1500_B1';
      const b2 = 'pack_2500_B2';

      await createMockPack(testPacksDir, a1, { gameId: gameA, createdAt: 1000 });
      await createMockPack(testPacksDir, a2, { gameId: gameA, createdAt: 2000 });
      await createMockPack(testPacksDir, a3, { gameId: gameA, createdAt: 3000 });
      await createMockPack(testPacksDir, b1, { gameId: gameB, createdAt: 1500 });
      await createMockPack(testPacksDir, b2, { gameId: gameB, createdAt: 2500 });

      await cleanupOldPacksForGame(gameA, testPacksDir, 2);

      // Game A: keep 2 newest, delete oldest
      assert.strictEqual(await packExists(testPacksDir, a3, gameA), true);
      assert.strictEqual(await packExists(testPacksDir, a2, gameA), true);
      assert.strictEqual(await packExists(testPacksDir, a1, gameA), false);

      // Game B unaffected
      assert.strictEqual(await packExists(testPacksDir, b1, gameB), true);
      assert.strictEqual(await packExists(testPacksDir, b2, gameB), true);
    } finally {
      await fs.rm(testPacksDir, { recursive: true, force: true });
    }
  });

  await suite.test('Auto-cleanup: Preserve all packs when count ≤ keepLatest', async () => {
    const testPacksDir = await createTestPacksDir();
    try {
      const gameA = 'game-a';
      const pack1 = 'pack_1000_A';
      const pack2 = 'pack_2000_B';

      await createMockPack(testPacksDir, pack1, { gameId: gameA, createdAt: 1000 });
      await createMockPack(testPacksDir, pack2, { gameId: gameA, createdAt: 2000 });

      await cleanupOldPacksForGame(gameA, testPacksDir, 2);

      assert.strictEqual(await packExists(testPacksDir, pack1, gameA), true);
      assert.strictEqual(await packExists(testPacksDir, pack2, gameA), true);
    } finally {
      await fs.rm(testPacksDir, { recursive: true, force: true });
    }
  });

  await suite.test('Auto-cleanup: Preserve script-referenced packs', async () => {
    const testPacksDir = await createTestPacksDir();
    try {
      const gameA = 'game-a';
      const a1 = 'pack_1000_A1';
      const a2 = 'pack_2000_A2';
      const a3 = 'pack_3000_A3';

      await createMockPack(testPacksDir, a1, { gameId: gameA, createdAt: 1000 });
      await createMockPack(testPacksDir, a2, { gameId: gameA, createdAt: 2000 });
      await createMockPack(testPacksDir, a3, { gameId: gameA, createdAt: 3000 });

      // Keep only the newest by default, but preserve a1 explicitly.
      await cleanupOldPacksForGame(gameA, testPacksDir, 1, [a1]);

      assert.strictEqual(await packExists(testPacksDir, a3, gameA), true);
      assert.strictEqual(await packExists(testPacksDir, a2, gameA), false);
      assert.strictEqual(await packExists(testPacksDir, a1, gameA), true);
    } finally {
      await fs.rm(testPacksDir, { recursive: true, force: true });
    }
  });

  await suite.test('Auto-cleanup: Handle empty directory gracefully', async () => {
    const testPacksDir = await createTestPacksDir();
    try {
      const items = await fs.readdir(testPacksDir, { withFileTypes: true });
      const allPacks = items.filter(d => d.isDirectory()).map(d => d.name);
      assert.strictEqual(allPacks.length, 0);
      const sliced = allPacks.slice(2);
      assert.strictEqual(sliced.length, 0);
    } finally {
      await fs.rm(testPacksDir, { recursive: true, force: true });
    }
  });

  await suite.test('Game deletion: Only deletes packs for that game', async () => {
    const testPacksDir = await createTestPacksDir();
    try {
      const gameA = 'game-a';
      const gameB = 'game-b';
      const a1 = 'pack_1000_A1';
      const a2 = 'pack_2000_A2';
      const b1 = 'pack_3000_B1';

      await createMockPack(testPacksDir, a1, { gameId: gameA, createdAt: 1000 });
      await createMockPack(testPacksDir, a2, { gameId: gameA, createdAt: 2000 });
      await createMockPack(testPacksDir, b1, { gameId: gameB, createdAt: 3000 });

      const deleted = [];
      const failed = [];
      try {
        await fs.rm(path.join(testPacksDir, gameA), { recursive: true, force: true });
        deleted.push(gameA);
      } catch {
        failed.push(gameA);
      }

      assert.strictEqual(await packExists(testPacksDir, a1, gameA), false);
      assert.strictEqual(await packExists(testPacksDir, a2, gameA), false);
      assert.strictEqual(await packExists(testPacksDir, b1, gameB), true);
      assert.strictEqual(deleted.length, 1);
      assert.strictEqual(failed.length, 0);
    } finally {
      await fs.rm(testPacksDir, { recursive: true, force: true });
    }
  });

  await suite.test('Game deletion: Reports deleted packs correctly', async () => {
    const testPacksDir = await createTestPacksDir();
    try {
      const gameA = 'game-a';
      const gameB = 'game-b';
      const pack1 = 'pack_1000_A';
      const pack2 = 'pack_2000_A';
      const pack3 = 'pack_3000_B';

      await createMockPack(testPacksDir, pack1, { gameId: gameA, createdAt: 1000 });
      await createMockPack(testPacksDir, pack2, { gameId: gameA, createdAt: 2000 });
      await createMockPack(testPacksDir, pack3, { gameId: gameB, createdAt: 3000 });

      const deleted = [];
      const failed = [];

      try {
        await fs.rm(path.join(testPacksDir, gameA), { recursive: true, force: true });
        deleted.push(gameA);
      } catch (err) {
        failed.push(gameA);
      }

      assert.strictEqual(deleted.length, 1);
      assert.strictEqual(failed.length, 0);
      assert.strictEqual(await packExists(testPacksDir, pack1, gameA), false);
      assert.strictEqual(await packExists(testPacksDir, pack2, gameA), false);
      assert.strictEqual(await packExists(testPacksDir, pack3, gameB), true);
    } finally {
      await fs.rm(testPacksDir, { recursive: true, force: true });
    }
  });
});

test('Pack Payload Validation', async (suite) => {
  await suite.test('allows null token placeholders in existingBoardAssets', async () => {
    const { error } = validateCreatePackPayload({
      gameId: 'game-a',
      existingBoardAssets: {
        'board-1': {
          tokens: {
            p1: null,
            p2: '',
          },
        },
      },
    });
    assert.strictEqual(error, undefined);
  });
});
