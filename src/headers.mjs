// The Cloudflare `_headers` rule for the hashed files: they never change under their name.
export function headerRules({ prefix = '/', assetsDir }) {
  const mount = `/${prefix.split('/').filter(Boolean).join('/')}`.replace(/\/?$/, '/');
  return `${mount}${assetsDir}/*\n  Cache-Control: public, max-age=31536000, immutable\n`;
}
