export function generateTokenSvg({ w=90, h=90, fill='#1e90ff', stroke='#0c57a0', text='#ffffff', label='' }) {
  const r = Math.round(Math.min(w, h) * 0.22);
  const cx = Math.round(w/2), cy = Math.round(h/2);
  const innerR = Math.round(Math.min(w,h) * 0.28);
  const safeLabel = String(label || '').slice(0,6).replace(/[<&>]/g, '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="token ${safeLabel}">
  <defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.25"/></filter></defs>
  <rect x="4" y="4" width="${w-8}" height="${h-8}" rx="${r}" ry="${r}" fill="${fill}" stroke="${stroke}" stroke-width="3" filter="url(#shadow)"/>
  <circle cx="${cx}" cy="${cy}" r="${innerR}" fill="rgba(255,255,255,0.12)"/>
  ${safeLabel ? `<text x="${cx}" y="${cy+6}" font-family="Inter,Roboto,Arial,sans-serif" font-size="${Math.round(Math.min(w,h)/3)}" text-anchor="middle" fill="${text}" font-weight="700">${safeLabel}</text>` : ``}
</svg>`;
}
