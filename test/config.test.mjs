import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeMount, resolveConfig, resolveLayout } from '../src/config.mjs';
import { headerRules } from '../src/headers.mjs';

test('config: unknown keys and bad values are errors', () => {
  assert.throws(() => resolveConfig({ pack: 1 }), /unknown key "pack"/);
  assert.throws(() => resolveConfig({ csp: 'x' }), /csp must be one of/);
  assert.throws(() => resolveConfig({ minify: 'yes' }), /minify must be true or false/);
  assert.throws(() => resolveConfig({ assetsDir: '../x' }), /assetsDir/);
  assert.throws(() => resolveConfig({ drop: ['/abs'] }), /drop/);
  assert.equal(resolveConfig({ strict: true }).strict, true);
});

test('mounts are normalised', () => {
  assert.equal(normalizeMount('/'), '/');
  assert.equal(normalizeMount('packed'), '/packed/');
  assert.equal(normalizeMount('/a/b'), '/a/b/');
  assert.equal(normalizeMount('none'), null);
  assert.equal(normalizeMount(null), null);
  assert.throws(() => normalizeMount('/a/../b'), /plain name/);
  assert.throws(() => normalizeMount('/a b/'), /plain name/);
});

test('layouts: default, named, overrides, invalid', () => {
  const config = resolveConfig({ layouts: { prod: { packed: '/' }, pages: { unpacked: '/', packed: '/p/' } } });
  assert.deepEqual(resolveLayout(config), { unpacked: '/', packed: '/packed/' });
  assert.deepEqual(resolveLayout(config, 'prod'), { unpacked: null, packed: '/' });
  assert.deepEqual(resolveLayout(config, 'pages', { packedAt: 'x' }), { unpacked: '/', packed: '/x/' });
  assert.deepEqual(resolveLayout(config, 'pages', { unpackedAt: 'none' }), { unpacked: null, packed: '/p/' });
  assert.throws(() => resolveLayout(config, 'nope'), /unknown layout "nope" \(known: prod, pages\)/);
  assert.throws(() => resolveLayout(config, 'pages', { packedAt: '/' }), /both variants are at \//);
  assert.throws(() => resolveLayout(config, 'pages', { unpackedAt: '/a/', packedAt: '/a/b/' }), /nested/);
  assert.throws(() => resolveLayout(config, 'pages', { unpackedAt: 'none', packedAt: 'none' }), /nothing/);
  assert.throws(() => resolveConfig({ layouts: { x: {} } }), /publishes nothing/);
});

test('headers: the immutable rule of the hashed folder', () => {
  const rule = headerRules({ prefix: 'zigzag', assetsDir: 'pack' });
  assert.equal(rule, '/zigzag/pack/*\n  Cache-Control: public, max-age=31536000, immutable\n');
  assert.match(headerRules({ assetsDir: 'p' }), /^\/p\/\*/);
});
