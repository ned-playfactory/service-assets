export const cfg = {
  port: Number(process.env.PORT || 7012),
  publicDir: process.env.PUBLIC_DIR || 'src/public',
  skinsRoot: 'skins',
  allowOrigins: (process.env.ALLOW_ORIGINS || '*')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
};
