// service-assets/src/services/aiSvgGenerator.js
// Optional AI-backed SVG generation. Currently supports OpenAI Responses API.

const PROVIDER = (process.env.AI_SVG_PROVIDER || '').toLowerCase();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.PLAYFACTORY_OPENAI_KEY;
const OPENAI_MODEL = process.env.AI_SVG_MODEL || 'gpt-4o-mini';
const OPENAI_URL = process.env.AI_SVG_ENDPOINT || 'https://api.openai.com/v1/responses';
const REQUEST_TIMEOUT = Number(process.env.AI_SVG_TIMEOUT_MS || 15000);
const OPENAI_TEMP = Number(process.env.AI_SVG_TEMP || 0.05);
const OPENAI_SEED_RAW = process.env.AI_SVG_SEED;
let seedWarningLogged = false;

const openAiEnabled = PROVIDER === 'openai' && !!OPENAI_API_KEY;

function extractSvgFromResponse(data) {
  if (!data) return null;
  const candidates = [];
  if (Array.isArray(data.output)) {
    data.output.forEach((chunk) => {
      const content = chunk?.content;
      if (Array.isArray(content)) {
        content.forEach((c) => {
          if (typeof c?.text === 'string') candidates.push(c.text);
        });
      } else if (typeof content === 'string') {
        candidates.push(content);
      }
    });
  }
  if (typeof data.output_text === 'string') candidates.push(data.output_text);
  if (Array.isArray(data.output_text)) candidates.push(...data.output_text);

  const text = candidates
    .map((t) => String(t || '')?.trim())
    .find((t) => t.startsWith('<svg'));
  return text || null;
}

async function callOpenAI({ prompt, signal }) {
  if (!openAiEnabled) return null;
  const body = {
    model: OPENAI_MODEL,
    input: prompt,
    temperature: OPENAI_TEMP,
    top_p: 0.1,
    max_output_tokens: 2048,
  };

  if (OPENAI_SEED_RAW && !seedWarningLogged) {
    console.warn('[aiSvg] seed parameter is currently unsupported by the OpenAI Responses API; skipping AI_SVG_SEED.');
    seedWarningLogged = true;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onExternalAbort);
    }
  }

  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      console.warn('[aiSvg] openai request failed:', res.status, msg);
      return null;
    }
    const data = await res.json();
    return extractSvgFromResponse(data);
  } catch (err) {
    if (err?.name === 'AbortError') {
      const reason = signal?.aborted ? 'aborted by caller' : 'timed out';
      console.warn(`[aiSvg] openai request aborted (${reason})`);
    } else {
      console.warn('[aiSvg] openai request error:', err?.message || err);
    }
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) {
      signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

export async function generateAISVG({
  role,
  variant,
  prompt,
  size,
  theme,
  signal,
}) {
  if (!openAiEnabled || !role) return null;

  const sanitizedPrompt = (prompt || '').trim() || 'custom board game';
  const normalizedRole = String(role || 'token').toLowerCase();

  if (normalizedRole === 'cover') {
    const coverSize = Number(size) || 820;
    const paletteLine = theme
      ? `Primary palette: ${theme.p1Color || '#1e90ff'} & ${theme.p2Color || '#ff3b30'} with accents of ${theme.accent || '#ffd60a'}.`
      : '';
    const instructions = `You are an SVG generator. Produce ONLY valid SVG markup (no fences, no explanations).
Requirements:
- Subject: cinematic board game box cover illustration.
- Theme prompt: ${sanitizedPrompt}.
- Composition: dynamic hero characters, environmental storytelling, dramatic lighting, subtle game board or iconography.
- ${paletteLine}
- Ensure focal elements remain readable at thumbnail size.
- Canvas: ${coverSize}px square viewBox 0 0 100 100.
- Use layered gradients, shapes, and outlines; no external raster images.
- Include depth cues (glow, shadow) to create a premium look.
`;
    return callOpenAI({ prompt: instructions, signal });
  }
  const ROLE_DESCRIPTIONS = {
    king: 'Regal crown with cross, tall column body, classic chess king silhouette.',
    queen: 'Elegant crown with multiple points, taller than bishop, graceful curves.',
    bishop: 'Tall miter hat with diagonal cut, slender body, resembles chess bishop.',
    knight: 'Horse head profile facing right, stylized but recognizable as knight.',
    rook: 'Castle tower with crenellations, sturdy base, resembles chess rook.',
    pawn: 'Small sphere head, tapered stem, classic pawn profile.',
  };
  const canonical = ROLE_DESCRIPTIONS[normalizedRole] || `Iconic representation of a "${role}" game piece.`;
  const primaryColor =
    variant === 'p1'
      ? theme?.p1Color || '#1e90ff'
      : theme?.p2Color || '#ff3b30';
  const secondaryColor =
    variant === 'p1'
      ? theme?.p2Color || '#ff3b30'
      : theme?.p1Color || '#1e90ff';

  const styleCuesLine = sanitizedPrompt
    ? `- Style cues: ${sanitizedPrompt}.`
    : '';
  const thematicRule = sanitizedPrompt
    ? `- Interpret the theme literally. Incorporate recognizable motifs, props, or textures from the prompt (holiday decor, franchise gear, signature silhouettes, etc.).`
    : `- Invent a distinctive motif so the piece feels bespoke rather than generic.`;

  const instructions = `
You are an SVG generator. Produce ONLY a valid SVG markup snippet (no \`\`\` fences, no explanations).
Requirements:
- Subject: ${role} game piece (${variant}).
- Piece description: ${canonical}
- Theme prompt: ${sanitizedPrompt}.
${styleCuesLine}
- Geometry silhouette must clearly read as the role while showcasing the theme.
- Avoid reusing plain geometric tokens; design something iconic for this theme.
- ${thematicRule}
- Colors: primary ${primaryColor} (main body), secondary ${secondaryColor} (optional trim), accent ${theme?.accent || '#ffd60a'}, outline ${theme?.outline || '#202020'}.
- Geometry must stay identical for every variant/color; never change silhouette between players.
- Canvas: ${size || 512}px square viewBox 0 0 100 100.
- Keep SVG simple, flat, and lightweight. Use only shapes/paths/gradients. No external images.
`;

  const svg = await callOpenAI({ prompt: instructions, signal });
  if (!svg) return null;
  return svg;
}
