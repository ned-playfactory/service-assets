// service-assets/src/tri/svgTemplates.js
// Tiny, pretty-ish token SVG (glossy disc + accent)
// Scales cleanly to any square size.
const DEFAULT_FILL = '#1e90ff';
const DEFAULT_ACCENT = '#ffd60a';
const DEFAULT_OUTLINE = '#202020';

function createSeededRandom(seedValue) {
  const seedStr = seedValue ? String(seedValue) : `${Math.random()}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < seedStr.length; i += 1) {
    const ch = seedStr.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  return () => {
    h1 = Math.imul(h1 ^ (h1 >>> 15), 2246822507);
    h1 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    const combined = (h1 ^ (h1 >>> 16) ^ h2) >>> 0;
    return combined / 0xffffffff;
  };
}

export function renderTokenSVG({
  size = 512,
  fill = DEFAULT_FILL,
  accent = DEFAULT_ACCENT,
  outline = DEFAULT_OUTLINE,
  seed,
} = {}) {
  const s = Number(size) || 512;
  const r = s * 0.44;
  const cx = s / 2;
  const cy = s / 2;

  // Add variation based on seed
  let accentCount = 1;
  let accentPositions = [{ x: cx - r * 0.35, y: cy - r * 0.35, size: r * 0.10 }];
  let shapeVariation = 'circle'; // circle, hexagon, star
  let gradientRotation = 0;
  
  if (seed) {
    const rand = createSeededRandom(seed);
    
    // Vary number and position of accent dots (1-3)
    accentCount = 1 + Math.floor(rand() * 3);
    accentPositions = [];
    for (let i = 0; i < accentCount; i++) {
      const angle = (i / accentCount) * Math.PI * 2 + rand() * Math.PI * 0.5;
      const distance = r * (0.3 + rand() * 0.15);
      accentPositions.push({
        x: cx + Math.cos(angle) * distance,
        y: cy + Math.sin(angle) * distance,
        size: r * (0.08 + rand() * 0.04),
      });
    }
    
    // Vary gradient rotation
    gradientRotation = Math.floor(rand() * 360);
    
    // Vary outer shape
    const shapeRoll = rand();
    if (shapeRoll < 0.6) {
      shapeVariation = 'circle';
    } else if (shapeRoll < 0.85) {
      shapeVariation = 'hexagon';
    } else {
      shapeVariation = 'star';
    }
  }

  const accentDots = accentPositions
    .map(
      (pos) =>
        `<circle cx="${pos.x.toFixed(2)}" cy="${pos.y.toFixed(2)}" r="${pos.size.toFixed(2)}" fill="${accent}" opacity="0.9"/>`,
    )
    .join('\n  ');

  let mainShape = '';
  let outlineShape = '';
  
  if (shapeVariation === 'hexagon') {
    const hexPoints = [];
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 - Math.PI / 2;
      hexPoints.push(`${(cx + Math.cos(angle) * r).toFixed(2)},${(cy + Math.sin(angle) * r).toFixed(2)}`);
    }
    const hexOutlinePoints = [];
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 - Math.PI / 2;
      hexOutlinePoints.push(`${(cx + Math.cos(angle) * (r + 6)).toFixed(2)},${(cy + Math.sin(angle) * (r + 6)).toFixed(2)}`);
    }
    outlineShape = `<polygon points="${hexOutlinePoints.join(' ')}" fill="${outline}" opacity="0.9"/>`;
    mainShape = `<polygon points="${hexPoints.join(' ')}" fill="${fill}"/>
  <polygon points="${hexPoints.join(' ')}" fill="url(#g1)" />`;
  } else if (shapeVariation === 'star') {
    const starPoints = [];
    for (let i = 0; i < 10; i++) {
      const angle = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const radius = i % 2 === 0 ? r : r * 0.5;
      starPoints.push(`${(cx + Math.cos(angle) * radius).toFixed(2)},${(cy + Math.sin(angle) * radius).toFixed(2)}`);
    }
    const starOutlinePoints = [];
    for (let i = 0; i < 10; i++) {
      const angle = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const radius = i % 2 === 0 ? r + 6 : r * 0.5 + 6;
      starOutlinePoints.push(`${(cx + Math.cos(angle) * radius).toFixed(2)},${(cy + Math.sin(angle) * radius).toFixed(2)}`);
    }
    outlineShape = `<polygon points="${starOutlinePoints.join(' ')}" fill="${outline}" opacity="0.9"/>`;
    mainShape = `<polygon points="${starPoints.join(' ')}" fill="${fill}"/>
  <polygon points="${starPoints.join(' ')}" fill="url(#g1)" />`;
  } else {
    // Default circle
    outlineShape = `<circle cx="${cx}" cy="${cy}" r="${r + 6}" fill="${outline}" opacity="0.9"/>`;
    mainShape = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#g1)" />`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="g1" cx="50%" cy="45%" r="65%" gradientTransform="rotate(${gradientRotation} 0.5 0.5)">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.25"/>
      <stop offset="60%" stop-color="#ffffff" stop-opacity="0.06"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.25"/>
    </radialGradient>
  </defs>
  ${outlineShape}
  ${mainShape}
  ${accentDots}
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
  seed,
} = {}) {
  const normalized = (role || '').toLowerCase();
  
  // Add color variation based on seed
  let variedFill = fill;
  let variedAccent = accent;
  let variedOutline = outline;
  
  if (seed) {
    const rand = createSeededRandom(seed);
    
    // Vary the fill color slightly (hue shift)
    variedFill = varyColor(fill, rand() * 30 - 15, rand() * 0.15 - 0.075);
    
    // Vary the accent color
    variedAccent = varyColor(accent, rand() * 40 - 20, rand() * 0.2 - 0.1);
    
    // Vary the outline slightly
    variedOutline = varyColor(outline, rand() * 10 - 5, rand() * 0.1 - 0.05);
  }
  
  if (!chessRoles.has(normalized)) {
    return renderTokenSVG({ size, fill: variedFill, accent: variedAccent, outline: variedOutline });
  }

  const renderer = roleToSvg[normalized];
  const content = renderer ? renderer(variedFill, variedAccent, variedOutline) : pawnSvg(variedFill, variedAccent, variedOutline);
  return baseSvg(Number(size) || 512, variedOutline, content);
}

function varyColor(hexColor, hueShift = 0, saturationShift = 0) {
  // Parse hex color
  const hex = hexColor.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;
  
  // Convert to HSL
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  
  // Apply shifts
  h = (h + hueShift / 360) % 1;
  if (h < 0) h += 1;
  s = Math.max(0, Math.min(1, s + saturationShift));
  
  // Convert back to RGB
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  
  let newR, newG, newB;
  if (s === 0) {
    newR = newG = newB = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    newR = hue2rgb(p, q, h + 1/3);
    newG = hue2rgb(p, q, h);
    newB = hue2rgb(p, q, h - 1/3);
  }
  
  // Convert to hex
  const toHex = (n) => {
    const hex = Math.round(n * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  
  return `#${toHex(newR)}${toHex(newG)}${toHex(newB)}`;
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
  seed,
} = {}) {
  const rand = createSeededRandom(seed);
  const s = Number(size) || 820;
  const safeTitle = escapeForSvg(title || 'Custom Game');
  const truncatedTitle = safeTitle.length > 48 ? `${safeTitle.slice(0, 45)}…` : safeTitle;
  const subtitle = escapeForSvg('Board Game Experience');
  const p1 = theme.p1Color || DEFAULT_FILL;
  const p2 = theme.p2Color || '#ff3b30';
  const accent = theme.accent || DEFAULT_ACCENT;
  const outline = theme.outline || DEFAULT_OUTLINE;
  const gridColor = `${outline}22`;

  const gradientAngle = Math.floor(rand() * 360);
  const boardRotation = (rand() * 20) - 10;
  const circleOne = {
    cx: 18 + rand() * 18,
    cy: 50 + rand() * 18,
    r: 10 + rand() * 6,
  };
  const circleTwo = {
    cx: 65 + rand() * 18,
    cy: 54 + rand() * 18,
    r: 9 + rand() * 5,
  };
  const heroBaseY = 34 + rand() * 4;
  const heroWidth = 18 + rand() * 10;
  const heroLean = rand() * 6 - 3;
  const accentOrb = {
    cx: 42 + rand() * 14,
    cy: 28 + rand() * 6,
    r: 5 + rand() * 3,
  };
  const badgeWidth = 30 + rand() * 16;
  const badgeHeight = 8 + rand() * 6;
  const badgeY = 80 + rand() * 6;

  const decoCount = 3 + Math.floor(rand() * 3);
  const decoShapes = Array.from({ length: decoCount }).map((_, idx) => {
    const x = 10 + rand() * 80;
    const y = 15 + rand() * 70;
    const w = 6 + rand() * 6;
    const h = 2 + rand() * 4;
    const rotation = rand() * 360;
    const opacity = 0.25 + rand() * 0.35;
    return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="1.5" fill="${accent}" opacity="${opacity.toFixed(2)}" transform="rotate(${rotation.toFixed(1)} ${x.toFixed(2)} ${y.toFixed(2)})" />`;
  }).join('\n  ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${s}" height="${s}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="coverGradient" x1="0%" y1="0%" x2="100%" y2="100%" gradientTransform="rotate(${gradientAngle} 0.5 0.5)">
      <stop offset="0%" stop-color="${p1}" />
      <stop offset="60%" stop-color="${accent}" />
      <stop offset="100%" stop-color="${p2}" />
    </linearGradient>
    <pattern id="boardPattern" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(${boardRotation.toFixed(1)})">
      <rect width="10" height="10" fill="transparent" />
      <rect x="0" y="0" width="5" height="5" fill="${gridColor}" />
      <rect x="5" y="5" width="5" height="5" fill="${gridColor}" />
    </pattern>
  </defs>
  <rect x="0" y="0" width="100" height="100" rx="6" fill="url(#coverGradient)" />
  <rect x="12" y="18" width="76" height="64" rx="8" fill="url(#boardPattern)" opacity="0.55"/>
  ${decoShapes}
  <circle cx="${circleOne.cx.toFixed(2)}" cy="${circleOne.cy.toFixed(2)}" r="${circleOne.r.toFixed(2)}" fill="${p1}" stroke="${outline}" stroke-width="2" opacity="0.85"/>
  <circle cx="${circleTwo.cx.toFixed(2)}" cy="${circleTwo.cy.toFixed(2)}" r="${circleTwo.r.toFixed(2)}" fill="${p2}" stroke="${outline}" stroke-width="2" opacity="0.85"/>
  <path d="M${40 + heroLean} ${70 - heroLean} L${52 - heroLean} ${heroBaseY} L${52 + heroWidth} ${heroBaseY} L${66 - heroLean} ${70 + heroLean}" fill="${p2}" opacity="0.82" stroke="${outline}" stroke-width="1.3" stroke-linejoin="round"/>
  <circle cx="${accentOrb.cx.toFixed(2)}" cy="${accentOrb.cy.toFixed(2)}" r="${accentOrb.r.toFixed(2)}" fill="${accent}" stroke="${outline}" stroke-width="2"/>
  <rect x="${50 - badgeWidth / 2}" y="${badgeY.toFixed(2)}" width="${badgeWidth.toFixed(2)}" height="${badgeHeight.toFixed(2)}" rx="4" fill="${outline}22" stroke="${outline}" stroke-width="0.5"/>
  <text x="50" y="${28 + rand() * 4}" text-anchor="middle" fill="#ffffff" font-size="${7.5 + rand() * 1.5}" font-weight="600" opacity="0.85" letter-spacing="0.5">${subtitle}</text>
  <text x="50" y="${44 + rand() * 3}" text-anchor="middle" fill="#ffffff" font-size="14" font-weight="700" letter-spacing="0.8">${truncatedTitle}</text>
  <text x="50" y="${badgeY + badgeHeight - 1}" text-anchor="middle" fill="#ffffff" font-size="5" opacity="0.85">PlayFactory Generated Art</text>
</svg>`;
}

export function renderBackgroundSVG({
  light = '#e8e8e8',
  dark = '#d8d8d8',
  accent = '#ffd60a',
  outline = '#202020',
  seed,
} = {}) {
  let gradientAngle = { x1: 0, x2: 1, y1: 0, y2: 1 };
  let shapes = [];
  
  if (seed) {
    const rand = createSeededRandom(seed);
    
    // Vary gradient direction
    const angleChoice = Math.floor(rand() * 4);
    if (angleChoice === 0) {
      gradientAngle = { x1: 0, x2: 1, y1: 0, y2: 1 }; // diagonal
    } else if (angleChoice === 1) {
      gradientAngle = { x1: 0, x2: 0, y1: 0, y2: 1 }; // vertical
    } else if (angleChoice === 2) {
      gradientAngle = { x1: 0, x2: 1, y1: 0, y2: 0 }; // horizontal
    } else {
      gradientAngle = { x1: 1, x2: 0, y1: 0, y2: 1 }; // reverse diagonal
    }
    
    // Vary decorative shapes - 2-4 shapes at random positions
    const shapeCount = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < shapeCount; i++) {
      const x = 100 + rand() * 824;
      const y = 100 + rand() * 824;
      const size = 80 + rand() * 100;
      const opacity = 0.08 + rand() * 0.08;
      const fillChoice = rand();
      const fill = fillChoice < 0.5 ? accent : outline;
      
      const shapeType = Math.floor(rand() * 3);
      if (shapeType === 0) {
        // Circle
        shapes.push(`<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${size.toFixed(0)}" fill="${fill}" opacity="${opacity.toFixed(2)}"/>`);
      } else if (shapeType === 1) {
        // Rectangle
        shapes.push(`<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${(size * 1.5).toFixed(0)}" height="${(size * 1.2).toFixed(0)}" rx="${(size * 0.15).toFixed(0)}" fill="${fill}" opacity="${opacity.toFixed(2)}"/>`);
      } else {
        // Ellipse
        shapes.push(`<ellipse cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" rx="${(size * 1.2).toFixed(0)}" ry="${size.toFixed(0)}" fill="${fill}" opacity="${opacity.toFixed(2)}"/>`);
      }
    }
  } else {
    // Default shapes
    shapes = [
      `<circle cx="180" cy="180" r="120" fill="${accent}" opacity="0.12"/>`,
      `<circle cx="860" cy="220" r="140" fill="${outline}" opacity="0.08"/>`,
      `<rect x="260" y="520" width="520" height="320" rx="24" fill="${outline}" opacity="0.05"/>`,
    ];
  }
  
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="g" x1="${gradientAngle.x1}" x2="${gradientAngle.x2}" y1="${gradientAngle.y1}" y2="${gradientAngle.y2}"><stop offset="0%" stop-color="${light}" stop-opacity="0.85"/><stop offset="100%" stop-color="${dark}" stop-opacity="0.9"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#g)"/>${shapes.join('')}</svg>`;
}

export function renderTileSVG({
  fill = '#e8e8e8',
  accent = '#ffd60a',
  outline = '#202020',
  isLight = true,
  seed,
} = {}) {
  let cornerRadius = 10;
  let strokeWidth = 2;
  let hasAccent = !isLight;
  let accentShapes = [];
  let baseOpacity = isLight ? 0.5 : 0.55;
  let pattern = '';
  
  if (seed) {
    const rand = createSeededRandom(seed);
    
    // Vary corner radius more dramatically
    cornerRadius = 4 + Math.floor(rand() * 14);
    
    // Vary stroke width
    strokeWidth = 1 + rand() * 2.5;
    
    // Vary base opacity
    baseOpacity = (isLight ? 0.45 : 0.5) + rand() * 0.15;
    
    // Choose pattern type
    const patternType = Math.floor(rand() * 5);
    
    if (patternType === 0) {
      // Multiple accent dots
      const dotCount = 2 + Math.floor(rand() * 4);
      for (let i = 0; i < dotCount; i++) {
        const x = 15 + rand() * 98;
        const y = 15 + rand() * 98;
        const size = 4 + rand() * 8;
        const opacity = 0.12 + rand() * 0.18;
        accentShapes.push(`<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${size.toFixed(0)}" fill="${accent}" opacity="${opacity.toFixed(2)}"/>`);
      }
    } else if (patternType === 1) {
      // Diagonal lines pattern
      const lineCount = 3 + Math.floor(rand() * 3);
      const spacing = 128 / lineCount;
      const lineWidth = 1 + rand() * 2;
      const lineOpacity = 0.08 + rand() * 0.12;
      for (let i = 0; i < lineCount; i++) {
        const offset = i * spacing;
        pattern += `<line x1="${offset}" y1="0" x2="${offset + 128}" y2="128" stroke="${outline}" stroke-width="${lineWidth.toFixed(1)}" opacity="${lineOpacity.toFixed(2)}"/>`;
      }
    } else if (patternType === 2) {
      // Corner accents
      const cornerSize = 8 + rand() * 12;
      const cornerOpacity = 0.1 + rand() * 0.15;
      const corners = Math.floor(1 + rand() * 4);
      if (corners >= 1) accentShapes.push(`<circle cx="${cornerSize}" cy="${cornerSize}" r="${cornerSize.toFixed(0)}" fill="${accent}" opacity="${cornerOpacity.toFixed(2)}"/>`);
      if (corners >= 2) accentShapes.push(`<circle cx="${128 - cornerSize}" cy="${cornerSize}" r="${cornerSize.toFixed(0)}" fill="${accent}" opacity="${cornerOpacity.toFixed(2)}"/>`);
      if (corners >= 3) accentShapes.push(`<circle cx="${cornerSize}" cy="${128 - cornerSize}" r="${cornerSize.toFixed(0)}" fill="${accent}" opacity="${cornerOpacity.toFixed(2)}"/>`);
      if (corners >= 4) accentShapes.push(`<circle cx="${128 - cornerSize}" cy="${128 - cornerSize}" r="${cornerSize.toFixed(0)}" fill="${accent}" opacity="${cornerOpacity.toFixed(2)}"/>`);
    } else if (patternType === 3) {
      // Center shape
      const shapeChoice = Math.floor(rand() * 3);
      const size = 15 + rand() * 20;
      const opacity = 0.12 + rand() * 0.18;
      if (shapeChoice === 0) {
        accentShapes.push(`<circle cx="64" cy="64" r="${size.toFixed(0)}" fill="${accent}" opacity="${opacity.toFixed(2)}"/>`);
      } else if (shapeChoice === 1) {
        accentShapes.push(`<rect x="${(64 - size).toFixed(0)}" y="${(64 - size).toFixed(0)}" width="${(size * 2).toFixed(0)}" height="${(size * 2).toFixed(0)}" rx="${(size * 0.3).toFixed(0)}" fill="${accent}" opacity="${opacity.toFixed(2)}"/>`);
      } else {
        accentShapes.push(`<polygon points="64,${64 - size} ${64 + size},${64 + size} ${64 - size},${64 + size}" fill="${accent}" opacity="${opacity.toFixed(2)}"/>`);
      }
    } else {
      // Grid of small shapes
      const gridSize = 2 + Math.floor(rand() * 2);
      const cellSize = 128 / (gridSize + 1);
      const shapeSize = 3 + rand() * 5;
      const opacity = 0.08 + rand() * 0.12;
      for (let row = 1; row <= gridSize; row++) {
        for (let col = 1; col <= gridSize; col++) {
          const x = col * cellSize;
          const y = row * cellSize;
          accentShapes.push(`<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${shapeSize.toFixed(0)}" fill="${outline}" opacity="${opacity.toFixed(2)}"/>`);
        }
      }
    }
  } else if (!isLight) {
    accentShapes.push(`<circle cx="28" cy="28" r="12" fill="${accent}" opacity="0.2"/>`);
  }
  
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="${cornerRadius}" fill="${fill}" stroke="${outline}" stroke-width="${strokeWidth.toFixed(1)}" opacity="${baseOpacity.toFixed(2)}"/>${pattern}${accentShapes.join('')}</svg>`;
}
