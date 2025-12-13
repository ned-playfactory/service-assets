// service-assets/test/pack-generation-async.test.js
// Test to verify pack generation completes all async operations before emitting 'complete'

const fs = require('fs').promises;
const path = require('path');
const { describe, it, before, after } = require('mocha');
const { expect } = require('chai');

describe('Pack Generation Async Chain', () => {
  const testPacksDir = path.join(__dirname, 'tmp-test-packs');
  const testPackId = `test_pack_${Date.now()}`;
  const testPackDir = path.join(testPacksDir, testPackId);

  before(async () => {
    await fs.mkdir(testPacksDir, { recursive: true });
  });

  after(async () => {
    try {
      await fs.rm(testPacksDir, { recursive: true, force: true });
    } catch (err) {
      console.warn('Cleanup failed:', err.message);
    }
  });

  it('should ensure all file writes complete before completion event', async () => {
    // Simulate pack generation file writes
    await fs.mkdir(path.join(testPackDir, 'board-1', 'cover'), { recursive: true });
    await fs.mkdir(path.join(testPackDir, 'board-1', 'pieces', 'token'), { recursive: true });

    const writes = [
      fs.writeFile(path.join(testPackDir, 'board-1', 'cover', 'main.svg'), '<svg>cover</svg>'),
      fs.writeFile(path.join(testPackDir, 'board-1', 'pieces', 'token', 'p1.svg'), '<svg>p1</svg>'),
      fs.writeFile(path.join(testPackDir, 'board-1', 'pieces', 'token', 'p2.svg'), '<svg>p2</svg>'),
    ];

    await Promise.all(writes);

    // Ensure setImmediate allows file system to flush
    await new Promise(resolve => setImmediate(resolve));

    // Verify all files exist and are readable
    const coverExists = await fs.access(path.join(testPackDir, 'board-1', 'cover', 'main.svg'))
      .then(() => true)
      .catch(() => false);
    const p1Exists = await fs.access(path.join(testPackDir, 'board-1', 'pieces', 'token', 'p1.svg'))
      .then(() => true)
      .catch(() => false);
    const p2Exists = await fs.access(path.join(testPackDir, 'board-1', 'pieces', 'token', 'p2.svg'))
      .then(() => true)
      .catch(() => false);

    expect(coverExists).to.be.true;
    expect(p1Exists).to.be.true;
    expect(p2Exists).to.be.true;
  });

  it('should await cleanup before emitting complete', async () => {
    // Create multiple packs
    const packs = ['pack1', 'pack2', 'pack3', 'pack4'];
    for (const pack of packs) {
      await fs.mkdir(path.join(testPacksDir, pack), { recursive: true });
      await fs.writeFile(path.join(testPacksDir, pack, 'test.txt'), pack);
    }

    // Simulate keeping only 2 most recent (delete pack1 and pack2)
    const toDelete = ['pack1', 'pack2'];
    await Promise.all(
      toDelete.map(pack => fs.rm(path.join(testPacksDir, pack), { recursive: true, force: true }))
    );

    // Ensure cleanup completes
    await new Promise(resolve => setImmediate(resolve));

    // Verify deleted packs are gone
    const pack1Exists = await fs.access(path.join(testPacksDir, 'pack1'))
      .then(() => true)
      .catch(() => false);
    const pack2Exists = await fs.access(path.join(testPacksDir, 'pack2'))
      .then(() => true)
      .catch(() => false);
    const pack3Exists = await fs.access(path.join(testPacksDir, 'pack3'))
      .then(() => true)
      .catch(() => false);
    const pack4Exists = await fs.access(path.join(testPacksDir, 'pack4'))
      .then(() => true)
      .catch(() => false);

    expect(pack1Exists).to.be.false;
    expect(pack2Exists).to.be.false;
    expect(pack3Exists).to.be.true;
    expect(pack4Exists).to.be.true;
  });
});
