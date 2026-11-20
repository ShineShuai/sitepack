import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

// The packed site is published at `packed`, the original (unpacked) one at `unpacked`; a variant
// that is not named is not published. A mount is "/" or "/name/" (or null for none).
export const DEFAULT_LAYOUT = { unpacked: '/', packed: '/packed/' };

export const DEFAULTS = {
  pages: 'auto',
  assetsDir: 'pack',
  target: 'es2022',
  minify: true,
  sourcemap: 'external',
  inlineMax: 4096,
  inlineScripts: 'keep',
  csp: 'recompute',
  preload: true,
  prune: 'consumed',
  drop: [],
  strict: false,
  layouts: {},
};

const CHOICES = {
  sourcemap: ['external', 'none'],
  inlineScripts: ['keep', 'minify'],
  csp: ['recompute', 'keep'],
  prune: ['consumed', 'none'],
};
const BOOLEANS = ['minify', 'preload', 'strict'];

export function normalizeMount(value) {
  if (value === null || value === undefined || value === false || value === 'none') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`mount ${JSON.stringify(value)} is not a string`);
  }
  const segments = value.split('/').filter(Boolean);
  if (segments.some(part => !/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..')) {
    throw new Error(`mount "${value}" has a segment that is not a plain name`);
  }
  return segments.length === 0 ? '/' : `/${segments.join('/')}/`;
}

function checkPath(value, key) {
  const parts = String(value).split('/');
  if (!value || value.startsWith('/') || parts.includes('..') || parts.includes('.')) {
    throw new Error(`${key}: "${value}" must be a relative path without . or ..`);
  }
}

export function resolveConfig(raw = {}) {
  const config = { ...DEFAULTS };
  for (const [key, value] of Object.entries(raw)) {
    if (key === '$schema') {
      continue;
    }
    if (!(key in DEFAULTS)) {
      throw new Error(`sitepack config: unknown key "${key}"`);
    }
    config[key] = value;
  }
  for (const [key, allowed] of Object.entries(CHOICES)) {
    if (!allowed.includes(config[key])) {
      throw new Error(`sitepack config: ${key} must be one of ${allowed.join(', ')}`);
    }
  }
  for (const key of BOOLEANS) {
    if (typeof config[key] !== 'boolean') {
      throw new Error(`sitepack config: ${key} must be true or false`);
    }
  }
  if (!Number.isInteger(config.inlineMax) || config.inlineMax < 0) {
    throw new Error('sitepack config: inlineMax must be a number of bytes (0 = off)');
  }
  if (config.pages !== 'auto' && !Array.isArray(config.pages)) {
    throw new Error('sitepack config: pages must be "auto" or a list of html paths');
  }
  checkPath(config.assetsDir, 'assetsDir');
  for (const prefix of config.drop) {
    checkPath(prefix, 'drop');
  }
  for (const page of config.pages === 'auto' ? [] : config.pages) {
    checkPath(page, 'pages');
  }
  for (const [name, layout] of Object.entries(config.layouts)) {
    config.layouts[name] = checkLayout(name, layout);
  }
  return config;
}

export function checkLayout(name, layout) {
  const unpacked = normalizeMount(layout.unpacked);
  const packed = normalizeMount(layout.packed);
  if (!unpacked && !packed) {
    throw new Error(`layout "${name}" publishes nothing`);
  }
  if (unpacked === packed) {
    throw new Error(`layout "${name}": both variants are at ${packed}`);
  }
  const nested = unpacked && packed && unpacked !== '/' && packed !== '/' &&
    (unpacked.startsWith(packed) || packed.startsWith(unpacked));
  if (nested) {
    throw new Error(`layout "${name}": ${unpacked} and ${packed} are nested`);
  }
  return { unpacked, packed };
}

export function resolveLayout(config, name, overrides = {}) {
  let base = DEFAULT_LAYOUT;
  if (name) {
    base = config.layouts[name];
    if (!base) {
      const known = Object.keys(config.layouts).join(', ') || 'none';
      throw new Error(`unknown layout "${name}" (known: ${known})`);
    }
  }
  const layout = { ...base };
  if (overrides.packedAt !== undefined) {
    layout.packed = overrides.packedAt;
  }
  if (overrides.unpackedAt !== undefined) {
    layout.unpacked = overrides.unpackedAt;
  }
  return checkLayout(name ?? 'default', layout);
}

// `file` undefined: ./sitepack.json when it exists, else the defaults.
export async function loadConfig(file) {
  const path = file ?? (existsSync('sitepack.json') ? 'sitepack.json' : null);
  if (!path) {
    return resolveConfig();
  }
  return resolveConfig(JSON.parse(await readFile(path, 'utf8')));
}
