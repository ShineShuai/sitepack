import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from '../src/build.mjs';
import { resolveConfig } from '../src/config.mjs';
import { page, site, snapshot, temp } from './helpers.mjs';

const fixture = () => site({
  'app/index.html': page({
    body: '<script type="module" src="boot.js"></script>\n' +
      '<script type="module" src="main.js"></script>',
  }),
  'app/boot.js': '// Boot comment.\nglobalThis.order = [...(globalThis.order ?? []), "boot"];\n',
  'app/main.js': '// Main comment.\n' +
    "import { add } from './math.js';\nimport { html } from './tpl.js';\n" +
    '/** Doc block. */\nglobalThis.order = [...(globalThis.order ?? []), "main"];\n' +
    'globalThis.sum = add(1, 2);\nglobalThis.html = html;\n' +
    "globalThis.lazy = () => import('./lazy.js');\n",
  'app/math.js': '// Add two numbers.\nexport const add = (a, b) => a + b;\n',
  'app/lazy.js': "import { add } from './math.js';\nexport const ok = add(2, 2);\n",
  'app/tpl.js': 'export const html = `\n// part of the string\nx`;\n',
});

const pack = async (level, over = {}) => {
  const outDir = temp();
  const result = await build({ inDir: fixture(), outDir, config: resolveConfig(over), level });
  return { ...result, outDir };
};

const jsFiles = async outDir =>
  (await readdir(join(outDir, 'pack'))).filter(name => name.endsWith('.js')).sort();

const allCode = async outDir => {
  const names = await jsFiles(outDir);
  const parts = await Promise.all(names.map(name => readFile(join(outDir, 'pack', name), 'utf8')));
  return parts.join('\n');
};

async function runPage(outDir, pages) {
  for (const key of ['order', 'sum', 'html', 'lazy']) {
    delete globalThis[key];
  }
  for (const src of pages['app/index.html'].scripts) {
    await import(pathToFileURL(join(outDir, 'app', src)));
  }
  const { order, sum, html } = globalThis;
  return { order, sum, html, lazy: (await globalThis.lazy()).ok };
}

test('every level runs the same', async () => {
  const results = [];
  for (const level of [0, 1, 2, 3, 4]) {
    const { outDir, pages } = await pack(level);
    results.push(await runPage(outDir, pages));
  }
  const expected = { order: ['boot', 'main'], sum: 3, html: '\n// part of the string\nx', lazy: 4 };
  assert.deepEqual(results[0], expected);
  for (const result of results) {
    assert.deepEqual(result, results[0]);
  }
});

test('levels 0 and 1: no comments; only level 0 is minified and has maps', async () => {
  const min = await pack(0);
  const plain = await pack(1);
  assert.doesNotMatch(await allCode(min.outDir), /Boot comment|Doc block/);
  assert.doesNotMatch(await allCode(plain.outDir), /Boot comment|Doc block/);
  assert.ok((await allCode(min.outDir)).split('\n').length < 12);
  assert.ok((await allCode(plain.outDir)).split('\n').length > 25);
  assert.ok((await readdir(join(min.outDir, 'pack'))).some(name => name.endsWith('.map')));
  assert.ok(!(await readdir(join(plain.outDir, 'pack'))).some(name => name.endsWith('.map')));
});

test('level 2: comments kept, a template literal is left as it is and reported', async () => {
  const { outDir, warnings } = await pack(2);
  const code = await allCode(outDir);
  for (const text of ['Boot comment', 'Main comment', 'Doc block', 'Add two numbers']) {
    assert.ok(code.includes(text), text);
  }
  assert.ok(code.includes('\n// part of the string\n'));
  assert.ok(warnings.some(text => /app\/tpl\.js: comments not kept/.test(text)));
  assert.equal((await pack(2)).warnings.length, 1);
});

test('level 3: the contents list points at the banners', async () => {
  const { outDir } = await pack(3);
  let checked = 0;
  for (const name of await jsFiles(outDir)) {
    const lines = (await readFile(join(outDir, 'pack', name), 'utf8')).split('\n');
    for (const line of lines.filter(item => /^\/\/\s+\d+\s+app\//.test(item))) {
      const [, number, module] = /^\/\/\s+(\d+)\s+(\S+)$/.exec(line);
      assert.equal(lines[Number(number) - 1], `// ${module}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 5, `${checked} modules listed`);
});

test('level 4: one file per page, in order, nothing to preload', async () => {
  const { outDir, pages } = await pack(4);
  const info = pages['app/index.html'];
  assert.equal(info.scripts.length, 1);
  assert.deepEqual(info.preload, []);
  assert.equal((await jsFiles(outDir)).length, 1);
  const html = await readFile(join(outDir, 'app/index.html'), 'utf8');
  assert.equal(html.match(/<script type="module"/g).length, 1);
  assert.doesNotMatch(html, /modulepreload/);
});

test('a level is deterministic and recorded in the manifest', async () => {
  const first = await pack(3);
  const second = await pack(3);
  assert.deepEqual(await snapshot(first.outDir), await snapshot(second.outDir));
  const manifestPath = join(temp(), 'm.json');
  await build({
    inDir: fixture(), outDir: temp(), config: resolveConfig(), level: 'indexed', manifestPath,
  });
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.level, 3);
  assert.equal(manifest.levelName, 'indexed');
  assert.ok(existsSync(manifestPath));
});
