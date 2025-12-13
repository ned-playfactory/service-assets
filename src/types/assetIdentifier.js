/**
 * Asset Identifier Types and Utilities
 * 
 * Canonical representation of asset identifiers as objects instead of strings.
 * Replaces fragile string parsing like "token-board-2-p1".
 */

/**
 * @typedef {Object} AssetIdentifier
 * @property {string} role - Asset role (e.g., "token", "cover", "background")
 * @property {string|null} boardId - Board identifier (e.g., "board-1", "board-2") or null for global assets
 * @property {string} variant - Variant identifier (e.g., "p1", "p2", "main")
 * @property {boolean} isBoardLevel - True for assets generated per-board (background, tiles, boardPreview)
 */

/**
 * Board-level asset roles - generated automatically for each board
 * NOT included in pieces array, driven by boards array only
 */
const BOARD_LEVEL_ROLES = new Set([
  'board',
  'boardPreview',
  'background',
  'tileLight',
  'tileDark',
]);

/**
 * Check if a role is board-level (auto-generated per board)
 * @param {string} role - The asset role
 * @returns {boolean}
 */
function isBoardLevelRole(role) {
  return BOARD_LEVEL_ROLES.has(role);
}

/**
 * Parse a string identifier into an AssetIdentifier object
 * Supports legacy formats:
 * - "token-p1" → {role: "token", boardId: null, variant: "p1", isBoardLevel: false}
 * - "token-board-2-p1" → {role: "token", boardId: "board-2", variant: "p1", isBoardLevel: false}
 * - "cover-board-2" → {role: "cover", boardId: "board-2", variant: "main", isBoardLevel: false}
 * - "background-board-2" → {role: "background", boardId: "board-2", variant: "main", isBoardLevel: true}
 * 
 * @param {string} identifier - String identifier to parse
 * @returns {AssetIdentifier}
 */
function parseIdentifier(identifier) {
  const parts = String(identifier || '').split('-');
  
  if (parts.length < 2) {
    return {
      role: parts[0] || 'token',
      boardId: null,
      variant: 'main',
      isBoardLevel: false,
    };
  }

  // Check for board-scoped format
  if (parts.length >= 3 && parts[1] === 'board') {
    const role = parts[0];
    const boardNum = parts[2];
    const boardId = `board-${boardNum}`;
    
    // Determine variant based on format length
    const variant = parts.length >= 4 
      ? parts[parts.length - 1]  // 4-part: "token-board-2-p1" → "p1"
      : (role === 'cover' ? 'main' : 'main'); // 3-part: "cover-board-2" → "main"
    
    return {
      role,
      boardId,
      variant,
      isBoardLevel: isBoardLevelRole(role),
    };
  }

  // Simple format: "token-p1"
  return {
    role: parts[0],
    boardId: null,
    variant: parts.slice(1).join('-'),
    isBoardLevel: false,
  };
}

/**
 * Format an AssetIdentifier object into a string identifier
 * @param {AssetIdentifier} identifier - Object identifier
 * @returns {string}
 */
function formatIdentifier(identifier) {
  const { role, boardId, variant } = identifier;
  
  if (!boardId) {
    // Global asset: "token-p1"
    return `${role}-${variant}`;
  }
  
  // Board-scoped asset
  if (isBoardLevelRole(role) || !variant || variant === 'main') {
    // Board-level or cover without variant: "background-board-2", "cover-board-2"
    return `${role}-${boardId}`;
  }
  
  // Token with variant: "token-board-2-p1"
  return `${role}-${boardId}-${variant}`;
}

/**
 * Validate an identifier object
 * @param {*} identifier - Value to validate
 * @returns {{valid: boolean, error?: string}}
 */
function validateIdentifier(identifier) {
  if (!identifier || typeof identifier !== 'object') {
    return { valid: false, error: 'Identifier must be an object' };
  }
  
  if (!identifier.role || typeof identifier.role !== 'string') {
    return { valid: false, error: 'Identifier must have a string role' };
  }
  
  if (identifier.boardId !== null && typeof identifier.boardId !== 'string') {
    return { valid: false, error: 'boardId must be string or null' };
  }
  
  if (!identifier.variant || typeof identifier.variant !== 'string') {
    return { valid: false, error: 'Identifier must have a string variant' };
  }
  
  if (typeof identifier.isBoardLevel !== 'boolean') {
    return { valid: false, error: 'isBoardLevel must be boolean' };
  }
  
  return { valid: true };
}

/**
 * Normalize input to AssetIdentifier object
 * Accepts both string and object formats
 * @param {string|AssetIdentifier} input - String or object identifier
 * @returns {AssetIdentifier}
 */
function normalizeIdentifier(input) {
  if (typeof input === 'string') {
    return parseIdentifier(input);
  }
  
  if (typeof input === 'object' && input !== null) {
    const validation = validateIdentifier(input);
    if (validation.valid) {
      return input;
    }
    console.warn(`Invalid identifier object: ${validation.error}`, input);
    return parseIdentifier('token-main');
  }
  
  return parseIdentifier('token-main');
}

export {
  BOARD_LEVEL_ROLES,
  isBoardLevelRole,
  parseIdentifier,
  formatIdentifier,
  validateIdentifier,
  normalizeIdentifier,
};
