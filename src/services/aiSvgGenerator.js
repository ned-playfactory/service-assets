// service-assets/src/services/aiSvgGenerator.js
// Optional AI-backed SVG generation. Currently supports OpenAI Responses API.

const PROVIDER = (process.env.AI_SVG_PROVIDER || '').toLowerCase();
const OPENAI_MODEL = process.env.AI_SVG_MODEL || 'gpt-4o-mini';
const OPENAI_URL = process.env.AI_SVG_ENDPOINT || 'https://api.openai.com/v1/responses';
const REQUEST_TIMEOUT = Number(process.env.AI_SVG_TIMEOUT_MS || 15000);
const OPENAI_TEMP = Number(process.env.AI_SVG_TEMP || 0.05);
const OPENAI_SEED_RAW = process.env.AI_SVG_SEED;
let seedWarningLogged = false;

let availabilityLogged = false;

function resolveApiKey(apiKey) {
  if (typeof apiKey !== 'string') return null;
  const trimmed = apiKey.trim();
  return trimmed ? trimmed : null;
}

function shouldUseOpenAI(preference = 'auto', apiKey = null) {
  const key = resolveApiKey(apiKey);
  if (!key) return false;
  const pref = String(preference || 'auto').toLowerCase();
  if (pref === 'local') return false;
  if (pref === 'openai') return true;
  // auto → follow env
  return PROVIDER === 'openai';
}

export function isOpenAiSvgAvailable(preference = 'auto', apiKey = null) {
  return shouldUseOpenAI(preference, apiKey);
}

export function getOpenAiSvgEnv(apiKey = null) {
  const key = resolveApiKey(apiKey);
  return {
    envProvider: PROVIDER || 'unset',
    openAiAvailable: Boolean(key),
    hasKey: Boolean(key),
    keyLen: key ? key.length : 0,
    model: OPENAI_MODEL,
  };
}

function extractSvgFromResponse(data) {
  if (!data) return null;
  const candidates = [];
  if (Array.isArray(data.output)) {
    data.output.forEach((chunk) => {
      const content = chunk?.content;
      if (Array.isArray(content)) {
        content.forEach((c) => {
          if (typeof c?.text === 'string') candidates.push(c.text);
          if (typeof c?.output_text === 'string') candidates.push(c.output_text);
          if (typeof c?.content === 'string') candidates.push(c.content);
          if (typeof c?.value === 'string') candidates.push(c.value);
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

function summarizeResponse(data) {
  if (!data || typeof data !== 'object') return { hasData: false };
  const output = Array.isArray(data.output) ? data.output : [];
  const outputTypes = output.map((chunk) => chunk?.type).filter(Boolean);
  const contentTypes = output
    .flatMap((chunk) => (Array.isArray(chunk?.content) ? chunk.content : []))
    .map((c) => c?.type)
    .filter(Boolean);
  const outputText =
    typeof data.output_text === 'string'
      ? data.output_text
      : Array.isArray(data.output_text)
        ? data.output_text.join('\n')
        : '';
  return {
    hasData: true,
    id: data.id || null,
    model: data.model || null,
    status: data.status || null,
    incompleteDetails: data.incomplete_details || null,
    outputCount: output.length,
    outputTypes,
    contentTypes,
    outputTextLength: outputText.length,
    outputTextPreview: outputText.slice(0, 400),
    hasError: Boolean(data.error),
    error: data.error || null,
    usage: data.usage || null,
  };
}

async function callOpenAI({ prompt, signal, apiKey, maxOutputTokens = 2048 }) {
  const key = resolveApiKey(apiKey);
  if (!key) return null;
  const body = {
    model: OPENAI_MODEL,
    input: prompt,
    text: {
      format: {
        type: 'text',
      },
    },
    temperature: OPENAI_TEMP,
    top_p: 0.1,
    max_output_tokens: maxOutputTokens,
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
        Authorization: `Bearer ${key}`,
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
    const svg = extractSvgFromResponse(data);
    if (!svg) {
      console.warn('[aiSvg] no svg found in response', summarizeResponse(data));
    }
    return svg;
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
  providerPreference = 'auto',
  apiKey = null,
}) {
  if (!role) return null;
  const useOpenAI = shouldUseOpenAI(providerPreference, apiKey);
  if (!availabilityLogged) {
    availabilityLogged = true;
    console.log('[aiSvg] availability', {
      providerPreference,
      envProvider: PROVIDER || 'unset',
      openAiAvailable: Boolean(resolveApiKey(apiKey)),
      model: OPENAI_MODEL,
      hasKey: Boolean(resolveApiKey(apiKey)),
    });
  }
  if (!useOpenAI) {
    console.warn('[aiSvg] skipping openai', {
      providerPreference,
      envProvider: PROVIDER || 'unset',
      openAiAvailable: Boolean(resolveApiKey(apiKey)),
      hasKey: Boolean(resolveApiKey(apiKey)),
    });
    return null;
  }

  const sanitizedPrompt = (prompt || '').trim() || 'custom board game';
  const normalizedRole = String(role || 'token').toLowerCase();

  if (normalizedRole === 'cover') {
    const coverSize = Number(size) || 820;
    const paletteLine = theme
      ? `Primary palette: ${theme.p1Color || '#1e90ff'} & ${theme.p2Color || '#ff3b30'} with accents of ${theme.accent || '#ffd60a'}.`
      : '';
    const instructions = `You are an SVG illustrator. Produce ONLY valid, standalone SVG markup (no fences, no explanations).
Requirements:
- Subject: cinematic board game box cover illustration.
- Theme prompt: ${sanitizedPrompt.slice(0, 800)}.
- Composition: dynamic hero characters, environmental storytelling, dramatic lighting, subtle game board or iconography.
- Include 3–5 distinct character silhouettes and 2–3 iconic props related to the theme; use foreground/midground/background depth.
- ${paletteLine}
- Ensure focal elements remain readable at thumbnail size.
- Canvas: ${coverSize}px square viewBox 0 0 100 100.
- Use layered gradients, shapes, and outlines; no external raster images.
- Premium, polished finish: smooth curves, consistent stroke widths, soft shadows/glows, clean edges.
- Absolutely NO text, letters, or logos in the artwork.
- Always return a valid <svg> even if minimal (include a background rect and 3 layered shapes).
- Output MUST start with "<svg" and end with "</svg>".
`;
    let svg = await callOpenAI({ prompt: instructions, signal, apiKey, maxOutputTokens: 4096 });
    if (!svg) {
      const minimal = `Return ONLY a valid <svg> (no fences, no explanations).
Requirements:
- Canvas: ${coverSize}px square viewBox 0 0 100 100.
- A background rect + 3 layered abstract shapes.
- Palette: ${theme?.p1Color || '#1e90ff'}, ${theme?.p2Color || '#ff3b30'}, accents ${theme?.accent || '#ffd60a'}.
- No text or logos.`;
      console.warn('[aiSvg] retrying cover with minimal prompt');
      svg = await callOpenAI({ prompt: minimal, signal, apiKey, maxOutputTokens: 2048 });
    }
    return svg;
  }
  if (
    normalizedRole === 'background' ||
    normalizedRole === 'board' ||
    normalizedRole === 'boardpreview' ||
    normalizedRole === 'tilelight' ||
    normalizedRole === 'tiledark'
  ) {
    const canvasSize = Number(size) || 1024;
    const paletteLine = theme
      ? `Palette: light ${theme.p1Color || '#e8e8e8'}, dark ${theme.p2Color || '#d8d8d8'}, accent ${theme.accent || '#ffd60a'}, outline ${theme.outline || '#202020'}.`
      : '';
    const basePrompt = sanitizedPrompt || 'custom board game';
    const kind =
      normalizedRole === 'background' || normalizedRole === 'board' || normalizedRole === 'boardpreview'
        ? 'background'
        : normalizedRole;
    const kindLine =
      kind === 'background'
        ? 'Create a top-down board background texture (subtle, clean, not busy). No grid lines.'
        : kind === 'tilelight'
        ? 'Create a single light board tile texture. Top-down, square, subtle pattern.'
        : 'Create a single dark board tile texture. Top-down, square, subtle pattern.';
    const colorHint =
      kind === 'tilelight'
        ? `Use light color ${theme?.p1Color || '#e8e8e8'} as the base.`
        : kind === 'tiledark'
        ? `Use dark color ${theme?.p2Color || '#d8d8d8'} as the base.`
        : '';
    const instructions = `
You are an SVG illustrator. Produce ONLY valid, standalone SVG markup (no fences, no explanations).
Requirements:
- Subject: board ${kind} artwork.
- Theme prompt: ${basePrompt}.
- ${kindLine}
- ${paletteLine}
- ${colorHint}
- Keep edges clean; avoid heavy borders.
- No text, letters, or logos.
- Canvas: ${canvasSize}px square viewBox 0 0 100 100.
- Use layered gradients, soft textures, subtle highlights.
- No external images.
`;
    let svg = await callOpenAI({ prompt: instructions, signal, apiKey });
    if (!svg) {
      const minimal = `Return ONLY a valid <svg> (no fences, no explanations).
Requirements:
- Canvas: ${canvasSize}px square viewBox 0 0 100 100.
- ${kindLine}
- Palette: ${theme?.p1Color || '#e8e8e8'}, ${theme?.p2Color || '#d8d8d8'}, accent ${theme?.accent || '#ffd60a'}.
- No text or logos.`;
      console.warn('[aiSvg] retrying board asset with minimal prompt', { kind });
      svg = await callOpenAI({ prompt: minimal, signal, apiKey });
    }
    return svg;
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
You are an SVG illustrator. Produce ONLY a valid, standalone SVG markup snippet (no \`\`\` fences, no explanations).
Requirements:
- Subject: ${role} game piece (${variant}).
- Piece description: ${canonical}
- Theme prompt: ${sanitizedPrompt}.
${styleCuesLine}
- Geometry silhouette must clearly read as the role while showcasing the theme. No amorphous blobs.
- Build the form from multiple clear parts (head/body/base if applicable), with symmetry and stable proportions; avoid single-circle tokens.
- ${thematicRule}
- Colors: primary ${primaryColor} (main body), secondary ${secondaryColor} (optional trim), accent ${theme?.accent || '#ffd60a'}, outline ${theme?.outline || '#202020'}.
- Geometry must stay identical for every variant/color; never change silhouette between players.
- Canvas: ${size || 512}px square viewBox 0 0 100 100.
- Premium icon quality: layered gradients, subtle highlights/shadows, smooth curves, clean silhouettes, consistent stroke widths.
- Absolutely NO text or letters in the art.
- Keep SVG simple and lightweight. Use only shapes/paths/gradients. No external images.
`;

  let svg = await callOpenAI({ prompt: instructions, signal, apiKey });
  if (!svg) {
    const minimal = `Return ONLY a valid <svg> (no fences, no explanations).
Requirements:
- Canvas: ${size || 512}px square viewBox 0 0 100 100.
- Subject: ${canonical}
- Palette: primary ${primaryColor}, secondary ${secondaryColor}, accent ${theme?.accent || '#ffd60a'}.
- No text or logos.`;
    console.warn('[aiSvg] retrying piece with minimal prompt', { role: normalizedRole, variant });
    svg = await callOpenAI({ prompt: minimal, signal, apiKey });
  }
  return svg;
}
