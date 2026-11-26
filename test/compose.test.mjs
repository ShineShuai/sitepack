import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { compose } from '../src/compose.mjs';
import { resolveConfig } from '../src/config.mjs';
import { page, site, temp } from './helpers.mjs';

const staged = (extra = {}) => site({
  'index.html': page({ body: '<script type="module" src="src/m.js"></script>' }),
  'src/m.js': 'globalThis.z = 1;\n',
  'data/d.txt': 'd',
  ...extra,
});

const go = (inDir, over = {}, layoutName, overrides) => {
  const outDir = temp();
  const config = resolveConfig({ drop: ['src'], layouts: { prod: { packed: '/' } }, ...over });
  const options = { inDir, outDir, config, layoutName, overrides };
  return compose(options).then(layout => ({ layout, outDir }));
};
const text = (dir, path) => readFile(join(dir, path), 'utf8');

test('compose: default layout is unpacked at / and packed at /packed/', async () => {
  const { outDir } = await go(staged());
  assert.match(await text(outDir, 'index.html'), /src="src\/m\.js"/);
  assert.ok(existsSync(join(outDir, 'src/m.js')));
  assert.match(await text(outDir, 'packed/index.html'), /src="pack\//);
  assert.ok(existsSync(join(outDir, 'packed/data/d.txt')));
  assert.ok(!existsSync(join(outDir, 'packed/src')));
});

test('compose: the prod layout publishes the packed site only, at /', async () => {
  const { outDir, layout } = await go(staged(), {}, 'prod');
  assert.deepEqual(layout, { unpacked: null, packed: '/', level: 0 });
  assert.match(await text(outDir, 'index.html'), /src="pack\//);
  assert.ok(!existsSync(join(outDir, 'packed')));
});

test('compose: mounts can be swapped from the command line', async () => {
  const { outDir } = await go(staged(), {}, undefined, { unpackedAt: '/dev/', packedAt: '/' });
  assert.match(await text(outDir, 'index.html'), /src="pack\//);
  assert.match(await text(outDir, 'dev/index.html'), /src="src\/m\.js"/);
});

test('compose: a path the site already has cannot be a mount', async () => {
  await assert.rejects(go(staged({ 'packed/x.txt': 'x' })), /already has that path/);
});

test('compose: the level comes from the layout; the command line wins', async () => {
  const over = { layouts: { dev: { unpacked: '/', packed: '/packed/', level: 'plain' } } };
  const { outDir, layout } = await go(staged(), over, 'dev');
  assert.equal(layout.level, 1);
  const names = await readdir(join(outDir, 'packed/pack'));
  assert.ok(!names.some(name => name.endsWith('.map')));
  const forced = await go(staged(), over, 'dev', { level: 0 });
  assert.equal(forced.layout.level, 0);
  const forcedNames = await readdir(join(forced.outDir, 'packed/pack'));
  assert.ok(forcedNames.some(name => name.endsWith('.map')));
});
