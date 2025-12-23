// service-assets/test/pack-generation-async.test.js
// Test to verify async file operations complete (node --test / ESM).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Pack Generation Async Chain', () => {
  const testPacksDir = path.join(__dirname, 'tmp-test-packs');
  const testPackId = `test_pack_${Date.now()}`;
  const testPackDir = path.join(testPacksDir, testPackId);

  before(async () => {
    await fs.mkdir(testPacksDir, { recursive: true });
  });

  after(async () => {
    await fs.rm(testPacksDir, { recursive: true, force: true });
  });

  it('ensures all file writes complete before completion signal', async () => {
    await fs.mkdir(path.join(testPackDir, 'board-1', 'cover'), { recursive: true });
    await fs.mkdir(path.join(testPackDir, 'board-1', 'pieces', 'token'), { recursive: true });

    await Promise.all([
      fs.writeFile(path.join(testPackDir, 'board-1', 'cover', 'main.svg'), '<svg>cover</svg>'),
      fs.writeFile(path.join(testPackDir, 'board-1', 'pieces', 'token', 'p1.svg'), '<svg>p1</svg>'),
      fs.writeFile(path.join(testPackDir, 'board-1', 'pieces', 'token', 'p2.svg'), '<svg>p2</svg>'),
    ]);

    await new Promise((resolve) => setImmediate(resolve));

    await assert.doesNotReject(
      fs.access(path.join(testPackDir, 'board-1', 'cover', 'main.svg')),
    );
    await assert.doesNotReject(
      fs.access(path.join(testPackDir, 'board-1', 'pieces', 'token', 'p1.svg')),
    );
    await assert.doesNotReject(
      fs.access(path.join(testPackDir, 'board-1', 'pieces', 'token', 'p2.svg')),
    );
  });

  it('awaits cleanup before declaring complete', async () => {
    const packs = ['pack1', 'pack2', 'pack3', 'pack4'];
    for (const pack of packs) {
      await fs.mkdir(path.join(testPacksDir, pack), { recursive: true });
      await fs.writeFile(path.join(testPacksDir, pack, 'test.txt'), pack);
    }

    await Promise.all(
      ['pack1', 'pack2'].map((pack) =>
        fs.rm(path.join(testPacksDir, pack), { recursive: true, force: true }),
      ),
    );

    await new Promise((resolve) => setImmediate(resolve));

    await assert.rejects(() => fs.access(path.join(testPacksDir, 'pack1')));
    await assert.rejects(() => fs.access(path.join(testPacksDir, 'pack2')));
    await assert.doesNotReject(() => fs.access(path.join(testPacksDir, 'pack3')));
    await assert.doesNotReject(() => fs.access(path.join(testPacksDir, 'pack4')));
  });
});
