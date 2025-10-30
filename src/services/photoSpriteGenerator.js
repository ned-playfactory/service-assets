// service-assets/src/services/photoSpriteGenerator.js
// Generate photoreal sprites as PNG data URIs wrapped in SVG.

const IMAGE_PROVIDER = (process.env.AI_IMAGE_PROVIDER || process.env.AI_SVG_PROVIDER || '').toLowerCase();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.PLAYFACTORY_OPENAI_KEY;
const OPENAI_IMAGE_MODEL = process.env.AI_IMAGE_MODEL || 'gpt-image-1';
const OPENAI_IMAGE_URL =
  process.env.AI_IMAGE_ENDPOINT || 'https://api.openai.com/v1/images/generations';
const OPENAI_IMAGE_RESPONSE_FORMAT = process.env.AI_IMAGE_RESPONSE_FORMAT || '';
const OPENAI_IMAGE_QUALITY = process.env.AI_IMAGE_QUALITY || '';
const OPENAI_IMAGE_STYLE = process.env.AI_IMAGE_STYLE || '';
const OPENAI_IMAGE_SIZE_OVERRIDE = process.env.AI_IMAGE_SIZE || '';
const IMAGE_TIMEOUT = Number(process.env.AI_IMAGE_TIMEOUT_MS || 20000);

const openAiEnabled = IMAGE_PROVIDER === 'openai' && !!OPENAI_API_KEY;
const PROMPT_PREVIEW_LEN = 180;
const SUPPORTED_SIZE_SET = new Set(['1024x1024', '1024x1536', '1536x1024', 'auto']);

function normalizeOpenAiSize(size) {
  if (OPENAI_IMAGE_SIZE_OVERRIDE && SUPPORTED_SIZE_SET.has(OPENAI_IMAGE_SIZE_OVERRIDE)) {
    return OPENAI_IMAGE_SIZE_OVERRIDE;
  }

  if (typeof size === 'string' && SUPPORTED_SIZE_SET.has(size)) {
    return size;
  }

  const numeric = Number(size);
  if (!Number.isNaN(numeric)) {
    if (numeric >= 1200) {
      return '1536x1024';
    }
    if (numeric >= 900) {
      return '1024x1536';
    }
  }

  return '1024x1024';
}

function buildImagePrompt({ prompt, role, variant, theme }) {
  const base = prompt || 'custom board game piece';
  const variantLabel = variant === 'p1' ? 'first player' : 'second player';
  const palette = theme
    ? `Colors: primary ${theme.p1Color || '#1e90ff'}, secondary ${theme.p2Color || '#ff3b30'}, accent ${theme.accent || '#ffd60a'}.`
    : '';
  return [
    base,
    `Design a photorealistic chess piece for role "${role}" (${variantLabel}).`,
    'Transparent background, centered, cinematic lighting, high detail.',
    'Output should be a single PNG with alpha channel.',
    palette,
  ]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(' ');
}

async function callOpenAIForImage({ prompt, size, signal }) {
  if (!openAiEnabled) {
    throw new Error(
      'OpenAI image generation is disabled. Set AI_IMAGE_PROVIDER=openai and OPENAI_API_KEY.'
    );
  }
  const requestSize = normalizeOpenAiSize(size);
  const body = {
    model: OPENAI_IMAGE_MODEL,
    prompt,
    size: requestSize,
  };
  if (OPENAI_IMAGE_RESPONSE_FORMAT) {
    body.response_format = OPENAI_IMAGE_RESPONSE_FORMAT;
  }
  if (OPENAI_IMAGE_QUALITY) {
    body.quality = OPENAI_IMAGE_QUALITY;
  }
  if (OPENAI_IMAGE_STYLE) {
    body.style = OPENAI_IMAGE_STYLE;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onExternalAbort);
    }
  }

  try {
    const res = await fetch(OPENAI_IMAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      const message = `[photoSpriteGenerator] openai image request failed ${res.status} ${errText?.slice?.(0, 200) ?? ''}`;
      console.warn(message);
      throw new Error(
        `OpenAI image request failed (${res.status}) via ${OPENAI_IMAGE_URL}. ${errText?.slice?.(0, 240) ?? res.statusText}`
      );
    }

    const data = await res.json();
    const b64 =
      data?.data?.[0]?.b64_json ||
      data?.data?.[0]?.base64 ||
      data?.data?.[0]?.b64 ||
      null;
    if (!b64) {
      throw new Error('OpenAI image response missing b64_json payload.');
    }
    return b64;
  } catch (err) {
    if (err?.name === 'AbortError') {
      const reason = signal?.aborted
        ? 'aborted by caller'
        : 'timeout';
      const message = `[photoSpriteGenerator] openai image request aborted (${reason})`;
      console.warn(message);
      throw new Error(
        reason === 'timeout'
          ? 'OpenAI image request timed out'
          : 'OpenAI image request cancelled',
      );
    }
    console.warn('[photoSpriteGenerator] openai image error', err?.message || err);
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
    if (signal) {
      signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

function wrapPngBase64AsSvg({ base64, size }) {
  if (!base64) return null;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">\n  <image href="data:image/png;base64,${base64}" x="0" y="0" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>\n</svg>`;
}

export async function generatePhotoSpriteSVG({ role, variant, prompt, size = 512, theme, signal }) {
  const imagePrompt = buildImagePrompt({ prompt, role, variant, theme });
  const promptPreview = (imagePrompt || '').slice(0, PROMPT_PREVIEW_LEN);
  const apiSize = normalizeOpenAiSize(size);
  console.log(
    new Date().toISOString(),
    '[photoSpriteGenerator]',
    'request',
    JSON.stringify({
      role,
      variant,
      size,
      apiSize,
      endpoint: OPENAI_IMAGE_URL,
      promptPreview,
    }),
  );
  const base64 = await callOpenAIForImage({ prompt: imagePrompt, size: apiSize, signal });
  if (!base64) {
    throw new Error(`OpenAI image call returned empty payload (prompt preview: "${promptPreview}")`);
  }
  return wrapPngBase64AsSvg({ base64, size });
}
