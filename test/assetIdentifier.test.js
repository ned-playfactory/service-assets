/**
 * Tests for AssetIdentifier utilities
 */

import {
  isBoardLevelRole,
  parseIdentifier,
  formatIdentifier,
  validateIdentifier,
  normalizeIdentifier,
} from '../src/types/assetIdentifier.js';

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('AssetIdentifier', () => {
  describe('isBoardLevelRole', () => {
    it('identifies board-level roles', () => {
      assert.strictEqual(isBoardLevelRole('background'), true);
      assert.strictEqual(isBoardLevelRole('tileLight'), true);
      assert.strictEqual(isBoardLevelRole('tileDark'), true);
      assert.strictEqual(isBoardLevelRole('board'), true);
      assert.strictEqual(isBoardLevelRole('boardPreview'), true);
    });

    it('identifies non-board-level roles', () => {
      assert.strictEqual(isBoardLevelRole('token'), false);
      assert.strictEqual(isBoardLevelRole('cover'), false);
      assert.strictEqual(isBoardLevelRole('piece'), false);
    });
  });

  describe('parseIdentifier', () => {
    it('parses simple format (token-p1)', () => {
      const result = parseIdentifier('token-p1');
      assert.deepStrictEqual(result, {
        role: 'token',
        boardId: null,
        variant: 'p1',
        isBoardLevel: false,
      });
    });

    it('parses 4-part board-scoped format (token-board-2-p1)', () => {
      const result = parseIdentifier('token-board-2-p1');
      assert.deepStrictEqual(result, {
        role: 'token',
        boardId: 'board-2',
        variant: 'p1',
        isBoardLevel: false,
      });
    });

    it('parses 3-part board-scoped format (cover-board-2)', () => {
      const result = parseIdentifier('cover-board-2');
      assert.deepStrictEqual(result, {
        role: 'cover',
        boardId: 'board-2',
        variant: 'main',
        isBoardLevel: false,
      });
    });

    it('parses board-level assets (background-board-2)', () => {
      const result = parseIdentifier('background-board-2');
      assert.deepStrictEqual(result, {
        role: 'background',
        boardId: 'board-2',
        variant: 'main',
        isBoardLevel: true,
      });
    });

    it('handles single part gracefully', () => {
      const result = parseIdentifier('token');
      assert.deepStrictEqual(result, {
        role: 'token',
        boardId: null,
        variant: 'main',
        isBoardLevel: false,
      });
    });
  });

  describe('formatIdentifier', () => {
    it('formats simple identifier', () => {
      const result = formatIdentifier({
        role: 'token',
        boardId: null,
        variant: 'p1',
        isBoardLevel: false,
      });
      assert.strictEqual(result, 'token-p1');
    });

    it('formats board-scoped token', () => {
      const result = formatIdentifier({
        role: 'token',
        boardId: 'board-2',
        variant: 'p1',
        isBoardLevel: false,
      });
      assert.strictEqual(result, 'token-board-2-p1');
    });

    it('formats board-scoped cover', () => {
      const result = formatIdentifier({
        role: 'cover',
        boardId: 'board-2',
        variant: 'main',
        isBoardLevel: false,
      });
      assert.strictEqual(result, 'cover-board-2');
    });

    it('formats board-level asset', () => {
      const result = formatIdentifier({
        role: 'background',
        boardId: 'board-2',
        variant: 'main',
        isBoardLevel: true,
      });
      assert.strictEqual(result, 'background-board-2');
    });
  });

  describe('roundtrip conversion', () => {
    const testCases = [
      'token-p1',
      'token-p2',
      'cover-main',
      'token-board-2-p1',
      'token-board-2-p2',
      'cover-board-2',
      'background-board-2',
      'tileLight-board-1',
    ];

    testCases.forEach((original) => {
      it(`roundtrips ${original}`, () => {
        const parsed = parseIdentifier(original);
        const formatted = formatIdentifier(parsed);
        assert.strictEqual(formatted, original);
      });
    });
  });

  describe('validateIdentifier', () => {
    it('validates correct identifier', () => {
      const result = validateIdentifier({
        role: 'token',
        boardId: 'board-1',
        variant: 'p1',
        isBoardLevel: false,
      });
      assert.strictEqual(result.valid, true);
    });

    it('rejects non-object', () => {
      const result = validateIdentifier('token-p1');
      assert.strictEqual(result.valid, false);
    });

    it('rejects missing role', () => {
      const result = validateIdentifier({
        boardId: 'board-1',
        variant: 'p1',
        isBoardLevel: false,
      });
      assert.strictEqual(result.valid, false);
    });

    it('rejects invalid boardId type', () => {
      const result = validateIdentifier({
        role: 'token',
        boardId: 123,
        variant: 'p1',
        isBoardLevel: false,
      });
      assert.strictEqual(result.valid, false);
    });
  });

  describe('normalizeIdentifier', () => {
    it('normalizes string input', () => {
      const result = normalizeIdentifier('token-board-2-p1');
      assert.deepStrictEqual(result, {
        role: 'token',
        boardId: 'board-2',
        variant: 'p1',
        isBoardLevel: false,
      });
    });

    it('passes through valid object', () => {
      const input = {
        role: 'token',
        boardId: 'board-1',
        variant: 'p1',
        isBoardLevel: false,
      };
      const result = normalizeIdentifier(input);
      assert.deepStrictEqual(result, input);
    });

    it('falls back to default for invalid input', () => {
      const result = normalizeIdentifier(null);
      assert.deepStrictEqual(result, {
        role: 'token',
        boardId: null,
        variant: 'main',
        isBoardLevel: false,
      });
    });
  });
});
