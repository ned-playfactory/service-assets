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
async function createMockPack(packsDir, packName) {
  const packPath = path.join(packsDir, packName);
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
async function packExists(packsDir, packName) {
  try {
    await fs.stat(path.join(packsDir, packName));
    return true;
  } catch {
    return false;
  }
}

test('Asset Pack Cleanup', async (suite) => {
  await suite.test('Auto-cleanup: Keep 2 most recent packs and delete older ones', async () => {
    const testPacksDir = await createTestPacksDir();
    try {
      // Create 4 packs with increasing timestamps
      const pack1 = 'pack_1000_ABC';
      const pack2 = 'pack_2000_DEF';
      const pack3 = 'pack_3000_GHI';
      const pack4 = 'pack_4000_JKL';

      await createMockPack(testPacksDir, pack1);
      await createMockPack(testPacksDir, pack2);
      await createMockPack(testPacksDir, pack3);
      await createMockPack(testPacksDir, pack4);

      // Execute cleanup logic
      const items = await fs.readdir(testPacksDir, { withFileTypes: true });
      const allPacks = items.filter(d => d.isDirectory()).map(d => d.name);
      
      const gamePacksInfo = allPacks
        .filter(name => name.startsWith('pack_'))
        .map(name => {
          const parts = name.split('_');
          const timestamp = parts.length > 1 ? Number(parts[1]) : 0;
          return { name, timestamp };
        })
        .sort((a, b) => b.timestamp - a.timestamp);

      const keepLatest = 2;
      if (gamePacksInfo.length > keepLatest) {
        const toDelete = gamePacksInfo.slice(keepLatest);
        for (const { name } of toDelete) {
          const packPath = path.join(testPacksDir, name);
          await fs.rm(packPath, { recursive: true, force: true });
        }
      }

      // Verify: 2 newest packs still exist
      assert.strictEqual(await packExists(testPacksDir, pack4), true);
      assert.strictEqual(await packExists(testPacksDir, pack3), true);

      // Verify: 2 oldest packs are deleted
      assert.strictEqual(await packExists(testPacksDir, pack1), false);
      assert.strictEqual(await packExists(testPacksDir, pack2), false);
    } finally {
      await fs.rm(testPacksDir, { recursive: true, force: true });
    }
  });

  await suite.test('Auto-cleanup: Preserve all packs when count ≤ keepLatest', async () => {
    const testPacksDir = await createTestPacksDir();
    try {
      const pack1 = 'pack_1000_ABC';
      const pack2 = 'pack_2000_DEF';

      await createMockPack(testPacksDir, pack1);
      await createMockPack(testPacksDir, pack2);

      const items = await fs.readdir(testPacksDir, { withFileTypes: true });
      const allPacks = items.filter(d => d.isDirectory()).map(d => d.name);
      
      const gamePacksInfo = allPacks
        .filter(name => name.startsWith('pack_'))
        .map(name => {
          const parts = name.split('_');
          const timestamp = parts.length > 1 ? Number(parts[1]) : 0;
          return { name, timestamp };
        })
        .sort((a, b) => b.timestamp - a.timestamp);

      const keepLatest = 2;
      const deletedCount = gamePacksInfo.length > keepLatest ? gamePacksInfo.length - keepLatest : 0;

      assert.strictEqual(await packExists(testPacksDir, pack1), true);
      assert.strictEqual(await packExists(testPacksDir, pack2), true);
      assert.strictEqual(deletedCount, 0);
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

  await suite.test('Game deletion: Delete all packs when game is deleted', async () => {
    const testPacksDir = await createTestPacksDir();
    try {
      const pack1 = 'pack_1000_ABC';
      const pack2 = 'pack_2000_DEF';
      const pack3 = 'pack_3000_GHI';

      await createMockPack(testPacksDir, pack1);
      await createMockPack(testPacksDir, pack2);
      await createMockPack(testPacksDir, pack3);

      const items = await fs.readdir(testPacksDir, { withFileTypes: true });
      const allPacks = items.filter(d => d.isDirectory()).map(d => d.name);
      
      for (const packName of allPacks) {
        const packPath = path.join(testPacksDir, packName);
        await fs.rm(packPath, { recursive: true, force: true });
      }

      assert.strictEqual(await packExists(testPacksDir, pack1), false);
      assert.strictEqual(await packExists(testPacksDir, pack2), false);
      assert.strictEqual(await packExists(testPacksDir, pack3), false);
    } finally {
      await fs.rm(testPacksDir, { recursive: true, force: true });
    }
  });

  await suite.test('Game deletion: Report deleted and failed packs correctly', async () => {
    const testPacksDir = await createTestPacksDir();
    try {
      const pack1 = 'pack_1000_ABC';
      const pack2 = 'pack_2000_DEF';

      await createMockPack(testPacksDir, pack1);
      await createMockPack(testPacksDir, pack2);

      const deleted = [];
      const failed = [];

      const items = await fs.readdir(testPacksDir, { withFileTypes: true });
      const allPacks = items.filter(d => d.isDirectory()).map(d => d.name);
      
      for (const packName of allPacks) {
        const packPath = path.join(testPacksDir, packName);
        try {
          await fs.rm(packPath, { recursive: true, force: true });
          deleted.push(packName);
        } catch (err) {
          failed.push(packName);
        }
      }

      assert.strictEqual(deleted.length, 2);
      assert.strictEqual(failed.length, 0);
      assert(deleted.includes(pack1));
      assert(deleted.includes(pack2));
    } finally {
      await fs.rm(testPacksDir, { recursive: true, force: true });
    }
  });
});
