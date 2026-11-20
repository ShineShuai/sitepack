import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from '../src/build.mjs';
import { checkSite } from '../src/check.mjs';
import { resolveConfig } from '../src/config.mjs';
import { scriptHash } from '../src/csp.mjs';
import { page, site, snapshot, temp } from './helpers.mjs';

const INLINE = 'window.inline = 1;';
const basic = () => site({
  'app/index.html': page({
    head: `<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'sha256-STALE'">\n` +
      `<script>${INLINE}</script>\n<link rel="stylesheet" href="a.css">\n` +
      '<link rel="stylesheet" href="b.css">',
    body: '<img src="logo.svg" alt=""><script type="module" src="main.js"></script>',
  }),
  'app/main.js': "import { add } from './math.js';\n" +
    'globalThis.out = add(1, 2);\nglobalThis.flag = globalThis.__PACKED__ === true;\n' +
    "export const lazy = () => import('./lazy.js');\n",
  'app/math.js': 'export const add = (a, b) => a + b;\n',
  'app/lazy.js': "import { add } from './math.js';\nexport const ok = add(2, 2);\n",
  'app/a.css': '.a { margin: 1px; }\n',
  'app/b.css': '.b { margin: 2px; }\n',
  'app/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>',
});

async function run(inDir, over = {}, outDir = temp()) {
  const config = resolveConfig({ pages: ['app/index.html'], ...over });
  const result = await build({ inDir, outDir, config });
  return { ...result, outDir };
}

test('build: bundles, merges css, recomputes the CSP, prunes the sources', async () => {
  const { outDir, pages } = await run(basic());
  const info = pages['app/index.html'];
  assert.equal(info.scripts.length, 1);
  assert.equal(info.styles.length, 1);
  assert.ok(info.preload.length >= 1, 'the shared chunk is preloaded');
  const html = await readFile(join(outDir, 'app/index.html'), 'utf8');
  assert.doesNotMatch(html, /main\.js|a\.css|b\.css/);
  assert.match(html, /rel="modulepreload"/);
  assert.match(html, /<img src="data:image\/svg\+xml,/);
  assert.ok(html.includes(scriptHash(INLINE)));
  assert.ok(!html.includes('STALE'));
  const css = await readFile(join(outDir, 'app', info.styles[0]), 'utf8');
  assert.ok(css.indexOf('.a') >= 0 && css.indexOf('.a') < css.indexOf('.b'));
  for (const gone of ['main.js', 'math.js', 'lazy.js', 'a.css', 'b.css']) {
    assert.ok(!existsSync(join(outDir, 'app', gone)), `${gone} is pruned`);
  }
  assert.deepEqual(await checkSite(outDir), []);
});

test('build: the packed entry runs the same (flag, shared chunk, lazy chunk)', async () => {
  const { outDir, pages } = await run(basic());
  const entry = join(outDir, 'app', pages['app/index.html'].scripts[0]);
  const module = await import(pathToFileURL(entry));
  assert.equal(globalThis.out, 3);
  assert.equal(globalThis.flag, true);
  assert.equal((await module.lazy()).ok, 4);
});

test('build: is deterministic', async () => {
  const inDir = basic();
  const first = await run(inDir);
  const second = await run(inDir);
  assert.deepEqual(await snapshot(first.outDir), await snapshot(second.outDir));
});

const workerSite = (worker, extra = {}) => site({
  'app/index.html': page({ body: '<script type="module" src="main.js"></script>' }),
  'app/main.js': "export const make = () => new Worker(new URL('./w.js', import.meta.url), " +
    "{ type: 'module' });\nexport const css = new URL('./x.css', import.meta.url).href;\n",
  'app/w.js': worker,
  'app/x.css': '.x { color: red; }\n',
  ...extra,
});

test('build: a worker and a css url are emitted first, so their names reach the referrer', async () => {
  const { outDir, pages } = await run(workerSite('self.onmessage = () => 1;\n'));
  const entry = pages['app/index.html'].scripts[0];
  const text = await readFile(join(outDir, 'app', entry), 'utf8');
  const worker = /new URL\("\.\/(w-[A-Z0-9]+\.js)",import\.meta\.url\)/.exec(text)?.[1];
  const css = /new URL\("\.\/(x-[a-z0-9A-Z]+\.css)",import\.meta\.url\)/.exec(text)?.[1];
  assert.ok(worker && existsSync(join(outDir, 'pack', worker)), 'worker file');
  assert.ok(css && existsSync(join(outDir, 'pack', css)), 'css file');
});

test('build: a changed worker changes the name of the file that starts it', async () => {
  const one = await run(workerSite('self.onmessage = () => 1;\n'));
  const same = await run(workerSite('self.onmessage = () => 1;\n'));
  const other = await run(workerSite('self.onmessage = () => 2;\n'));
  const name = result => result.pages['app/index.html'].scripts[0];
  assert.equal(name(one), name(same));
  assert.notEqual(name(one), name(other));
});

const warned = () => site({
  'app/index.html': page({ body: '<script type="module" src="main.js"></script>' }),
  'app/main.js': "export const o = { a: 1, a: 2 };\nconst e = new URL('./x.js', import.meta.url).href;\n" +
    'export const load = () => import(e);\n',
  'app/x.js': 'export default 1;\n',
});

test('build: warnings are listed; strict makes them fail', async () => {
  const { warnings } = await run(warned());
  assert.ok(warnings.some(text => /Duplicate key/.test(text)));
  assert.ok(warnings.some(text => /not resolved here/.test(text)));
  assert.ok(warnings.some(text => /computed specifier/.test(text)));
  await assert.rejects(run(warned(), { strict: true }), /warnings \(strict\)/);
});

test('build: drop removes the prefixes; inlineMax 0 keeps images as files', async () => {
  const inDir = site({
    'app/index.html': page({ body: '<img src="l.svg"><script type="module" src="src/m.js"></script>' }),
    'app/src/m.js': 'globalThis.q = 1;\n',
    'app/src/notes.md': 'doc',
    'app/l.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  });
  const { outDir } = await run(inDir, { drop: ['app/src'], inlineMax: 0 });
  assert.ok(!existsSync(join(outDir, 'app/src')));
  assert.match(await readFile(join(outDir, 'app/index.html'), 'utf8'), /<img src="l\.svg">/);
});

test('build: inline scripts can be minified, the CSP follows', async () => {
  const inDir = site({
    'app/index.html': page({
      head: `<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'sha256-X'">`,
      body: '<script>\n  window.a   =   1 + 2;\n</script>',
    }),
  });
  const { outDir } = await run(inDir, { inlineScripts: 'minify' });
  const html = await readFile(join(outDir, 'app/index.html'), 'utf8');
  assert.match(html, /<script>window\.a=3;<\/script>/);
  assert.ok(html.includes(scriptHash('window.a=3;')));
});

test('build: a missing script and an existing pack directory are errors', async () => {
  const missing = site({ 'app/index.html': page({ body: '<script type="module" src="no.js"></script>' }) });
  await assert.rejects(run(missing), /does not exist/);
  const clash = site({ 'app/index.html': page(), 'pack/x.txt': 'x' });
  await assert.rejects(run(clash), /pack\/ exists/);
});

test('check: broken references and a stale CSP hash are found', async () => {
  const dir = site({
    'index.html': page({
      head: `<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'sha256-OLD'">`,
      body: '<a href="gone.html">x</a><script>a()</script><img src="no.png">',
    }),
  });
  const problems = await checkSite(dir);
  assert.equal(problems.filter(text => /points to nothing/.test(text)).length, 2);
  assert.equal(problems.filter(text => /script-src/.test(text)).length, 2);
});
