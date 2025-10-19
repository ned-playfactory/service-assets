// service-assets/src/tri/svgTemplates.js
// Tiny, pretty-ish token SVG (glossy disc + accent)
// Scales cleanly to any square size.
export function renderTokenSVG({
  size = 512,
  fill = '#1e90ff',
  accent = '#ffd60a',
  outline = '#202020'
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
