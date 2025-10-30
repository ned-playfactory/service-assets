// service-assets/src/tri/svgTemplates.js
// Tiny, pretty-ish token SVG (glossy disc + accent)
// Scales cleanly to any square size.
const DEFAULT_FILL = '#1e90ff';
const DEFAULT_ACCENT = '#ffd60a';
const DEFAULT_OUTLINE = '#202020';

export function renderTokenSVG({
  size = 512,
  fill = DEFAULT_FILL,
  accent = DEFAULT_ACCENT,
  outline = DEFAULT_OUTLINE
} = {}) {
  const s = Number(size) || 512;
  const r = s * 0.44;
  const cx = s / 2;
  const cy = s / 2;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="g1" cx="50%" cy="45%" r="65%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.25"/>
      <stop offset="60%" stop-color="#ffffff" stop-opacity="0.06"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.25"/>
    </radialGradient>
  </defs>
  <circle cx="${cx}" cy="${cy}" r="${r + 6}" fill="${outline}" opacity="0.9"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#g1)" />
  <circle cx="${cx - r * 0.35}" cy="${cy - r * 0.35}" r="${r * 0.10}" fill="${accent}" opacity="0.9"/>
</svg>`;
}

const chessRoles = new Set(['king', 'queen', 'rook', 'bishop', 'knight', 'pawn']);

function baseSvg(size, outline, content) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="22" y="80" width="56" height="12" rx="3" fill="${outline}" opacity="0.9"/>
  <rect x="28" y="72" width="44" height="10" rx="3" fill="${outline}" opacity="0.6"/>
  ${content}
</svg>`;
}

function pawnSvg(fill, accent, outline) {
  return `
  <circle cx="50" cy="26" r="10" fill="${accent}" stroke="${outline}" stroke-width="3"/>
  <rect x="40" y="36" width="20" height="28" rx="8" fill="${fill}" stroke="${outline}" stroke-width="3"/>
  <rect x="35" y="64" width="30" height="6" rx="3" fill="${fill}" stroke="${outline}" stroke-width="3"/>`;
}

function rookSvg(fill, accent, outline) {
  return `
  <rect x="34" y="24" width="32" height="40" fill="${fill}" stroke="${outline}" stroke-width="3"/>
  <rect x="30" y="20" width="8" height="8" fill="${accent}" stroke="${outline}" stroke-width="3"/>
  <rect x="46" y="20" width="8" height="8" fill="${accent}" stroke="${outline}" stroke-width="3"/>
  <rect x="62" y="20" width="8" height="8" fill="${accent}" stroke="${outline}" stroke-width="3"/>
  <rect x="32" y="64" width="36" height="6" fill="${fill}" stroke="${outline}" stroke-width="3"/>`;
}

function knightSvg(fill, accent, outline) {
  return `
  <path d="M62 70H38L34 60 45 45 36 32 46 22 60 28 66 22 70 28 64 42 72 50 66 58 66 66Z"
        fill="${fill}" stroke="${outline}" stroke-width="3" stroke-linejoin="round"/>
  <circle cx="58" cy="32" r="4" fill="${accent}" stroke="${outline}" stroke-width="2"/>`;
}

function bishopSvg(fill, accent, outline) {
  return `
  <ellipse cx="50" cy="32" rx="12" ry="16" fill="${fill}" stroke="${outline}" stroke-width="3"/>
  <rect x="42" y="48" width="16" height="18" rx="6" fill="${fill}" stroke="${outline}" stroke-width="3"/>
  <path d="M44 30 L56 44" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>
  <rect x="38" y="66" width="24" height="6" fill="${fill}" stroke="${outline}" stroke-width="3"/>`;
}

function queenSvg(fill, accent, outline) {
  return `
  <path d="M32 60 L50 24 L68 60 Z" fill="${fill}" stroke="${outline}" stroke-width="3"/>
  <circle cx="50" cy="22" r="6" fill="${accent}" stroke="${outline}" stroke-width="3"/>
  <circle cx="34" cy="26" r="5" fill="${accent}" stroke="${outline}" stroke-width="2"/>
  <circle cx="66" cy="26" r="5" fill="${accent}" stroke="${outline}" stroke-width="2"/>
  <rect x="36" y="60" width="28" height="8" fill="${fill}" stroke="${outline}" stroke-width="3"/>`;
}

function kingSvg(fill, accent, outline) {
  return `
  <path d="M36 62 L50 30 L64 62 Z" fill="${fill}" stroke="${outline}" stroke-width="3"/>
  <rect x="47" y="18" width="6" height="18" fill="${accent}" stroke="${outline}" stroke-width="3"/>
  <rect x="42" y="24" width="16" height="6" fill="${accent}" stroke="${outline}" stroke-width="3"/>
  <circle cx="50" cy="14" r="5" fill="${accent}" stroke="${outline}" stroke-width="3"/>
  <rect x="38" y="62" width="24" height="8" fill="${fill}" stroke="${outline}" stroke-width="3"/>`;
}

const roleToSvg = {
  pawn: pawnSvg,
  rook: rookSvg,
  knight: knightSvg,
  bishop: bishopSvg,
  queen: queenSvg,
  king: kingSvg,
};

export function renderChessPieceSVG({
  role,
  size = 512,
  fill = DEFAULT_FILL,
  accent = DEFAULT_ACCENT,
  outline = DEFAULT_OUTLINE,
} = {}) {
  const normalized = (role || '').toLowerCase();
  if (!chessRoles.has(normalized)) {
    return renderTokenSVG({ size, fill, accent, outline });
  }

  const renderer = roleToSvg[normalized];
  const content = renderer ? renderer(fill, accent, outline) : pawnSvg(fill, accent, outline);
  return baseSvg(Number(size) || 512, outline, content);
}

function escapeForSvg(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function renderCoverSVG({
  size = 820,
  theme = {},
  title = 'Custom Game',
} = {}) {
  const s = Number(size) || 820;
  const safeTitle = escapeForSvg(title || 'Custom Game');
  const truncatedTitle = safeTitle.length > 48 ? `${safeTitle.slice(0, 45)}…` : safeTitle;
  const subtitle = escapeForSvg('Board Game Experience');
  const p1 = theme.p1Color || DEFAULT_FILL;
  const p2 = theme.p2Color || '#ff3b30';
  const accent = theme.accent || DEFAULT_ACCENT;
  const outline = theme.outline || DEFAULT_OUTLINE;
  const gridColor = `${outline}22`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${s}" height="${s}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="coverGradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${p1}" />
      <stop offset="60%" stop-color="${accent}" />
      <stop offset="100%" stop-color="${p2}" />
    </linearGradient>
    <pattern id="boardPattern" width="10" height="10" patternUnits="userSpaceOnUse">
      <rect width="10" height="10" fill="transparent" />
      <rect x="0" y="0" width="5" height="5" fill="${gridColor}" />
      <rect x="5" y="5" width="5" height="5" fill="${gridColor}" />
    </pattern>
  </defs>
  <rect x="0" y="0" width="100" height="100" rx="6" fill="url(#coverGradient)" />
  <rect x="12" y="20" width="76" height="60" rx="6" fill="url(#boardPattern)" opacity="0.65"/>
  <circle cx="25" cy="60" r="13" fill="${p1}" stroke="${outline}" stroke-width="2" opacity="0.85"/>
  <circle cx="75" cy="62" r="11" fill="${p2}" stroke="${outline}" stroke-width="2" opacity="0.85"/>
  <path d="M40 70 L48 36 L62 36 L70 70" fill="${p2}" opacity="0.8" stroke="${outline}" stroke-width="1.5" stroke-linejoin="round"/>
  <circle cx="55" cy="32" r="7" fill="${accent}" stroke="${outline}" stroke-width="2"/>
  <text x="50" y="30" text-anchor="middle" fill="#ffffff" font-size="8" font-weight="600" opacity="0.85" letter-spacing="0.5">${escapeForSvg(subtitle)}</text>
  <text x="50" y="44" text-anchor="middle" fill="#ffffff" font-size="14" font-weight="700" letter-spacing="0.8">${truncatedTitle}</text>
  <text x="50" y="84" text-anchor="middle" fill="#ffffff" font-size="5" opacity="0.85">PlayFactory Generated Art</text>
</svg>`;
}
