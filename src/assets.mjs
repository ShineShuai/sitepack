import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { hashHex, walk } from './util.mjs';

// Source patterns the packer understands. The source stays valid, native ES modules.
const WORKER_URL =
  /(new\s+(?:Shared)?Worker\(\s*new\s+URL\(\s*)(['"])(\.{1,2}\/[^'"]+)\2(\s*,\s*import\.meta\.url\s*\))/g;
const ASSET_EXT = 'css|svg|png|jpe?g|gif|webp|avif|woff2?|ttf|otf|wasm|mp3|ogg|wav';
const ASSET_URL = new RegExp(
  `(new\\s+URL\\(\\s*)(['"])(\\.{1,2}\\/[^'"]+\\.(?:${ASSET_EXT}))\\2(\\s*,\\s*import\\.meta\\.url\\s*\\))`,
  'g',
);
const LEFTOVER_URL = /new URL\(\s*(["'`])(\.{1,2}\/[^"'`]+)\1\s*,\s*import\.meta\.url/g;
const COMPUTED_IMPORT = /\bimport\(\s*[^"'`\s)]/g;

// Source tests this to know it runs packed: `if (globalThis.__PACKED__ === true)`.
const DEFINE = { 'globalThis.__PACKED__': 'true' };

const FILE_LOADERS = Object.fromEntries(
  ['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.woff', '.woff2', '.ttf', '.otf']
    .map(ext => [ext, 'file']),
);

const describe = warning => {
  const at = warning.location;
  const where = at ? `${at.file}:${at.line}:${at.column}: ` : '';
  return `${where}${warning.text}`;
};

// Builds on top of esbuild. Everything lands flat in `packDir`, named `<name>-<content hash>`.
// `consumed` collects the source files that went into some bundle, `warnings` the problems.
export function createAssets({ esbuild, outDir, packDir, work, config, consumed, warnings }) {
  const emitted = new Map();
  let tmpCount = 0;
  const sourcemap = config.sourcemap === 'external' ? 'external' : false;

  const common = () => ({
    absWorkingDir: outDir,
    bundle: true,
    minify: config.minify,
    target: config.target,
    outdir: packDir,
    entryNames: '[name]-[hash]',
    chunkNames: '[name]-[hash]',
    assetNames: '[name]-[hash]',
    legalComments: 'none',
    metafile: true,
    logLevel: 'silent',
    define: DEFINE,
    loader: FILE_LOADERS,
  });

  function record(result) {
    for (const input of Object.keys(result.metafile.inputs)) {
      consumed.add(resolve(outDir, input));
    }
    for (const warning of result.warnings) {
      warnings.add(describe(warning));
    }
  }

  // A worker is built first, so that its final name is known when the file that starts it is
  // hashed: a changed worker then changes the name of its starter, never a stale copy in a cache.
  function emitScript(abs, chain) {
    if (chain.includes(abs)) {
      throw new Error(`worker cycle: ${[...chain, abs].map(path => relative(outDir, path)).join(' -> ')}`);
    }
    if (!emitted.has(abs)) {
      emitted.set(abs, (async () => {
        const result = await esbuild.build({
          ...common(),
          entryPoints: [abs],
          format: 'esm',
          sourcemap,
          plugins: [urlPlugin([...chain, abs])],
        });
        record(result);
        const [key] = Object.entries(result.metafile.outputs).find(([, out]) => out.entryPoint);
        return basename(key);
      })());
    }
    return emitted.get(abs);
  }

  function emitFile(abs) {
    if (!emitted.has(abs)) {
      emitted.set(abs, (async () => {
        if (extname(abs) === '.css') {
          return bundleCss([abs], basename(abs, '.css'));
        }
        const data = await readFile(abs);
        const name = `${basename(abs, extname(abs))}-${hashHex(data)}${extname(abs)}`;
        await writeFile(join(packDir, name), data);
        return name;
      })());
    }
    return emitted.get(abs);
  }

  async function rewrite(source, path, chain) {
    const dir = dirname(path);
    const edits = [];
    for (const match of source.matchAll(WORKER_URL)) {
      const file = await emitScript(resolve(dir, match[3]), chain);
      edits.push({ match, spec: `./${file}` });
    }
    for (const match of source.matchAll(ASSET_URL)) {
      const target = resolve(dir, match[3]);
      if (!existsSync(target)) {
        throw new Error(`${relative(outDir, path)}: ${match[3]} does not exist`);
      }
      edits.push({ match, spec: `./${await emitFile(target)}` });
    }
    let text = source;
    for (const { match, spec } of edits.sort((a, b) => b.match.index - a.match.index)) {
      const replaced = `${match[1]}${match[2]}${spec}${match[2]}${match[4]}`;
      text = text.slice(0, match.index) + replaced + text.slice(match.index + match[0].length);
    }
    return text;
  }

  function urlPlugin(chain) {
    return {
      name: 'sitepack-urls',
      setup(build) {
        build.onLoad({ filter: /\.[mc]?js$/ }, async ({ path }) => {
          const source = await readFile(path, 'utf8');
          if (!source.includes('import.meta.url')) {
            return null;
          }
          return { contents: await rewrite(source, path, chain), loader: 'js' };
        });
      },
    };
  }

  // The stylesheets `files` (absolute paths), in order, as one file. -> its name in packDir.
  async function bundleCss(files, name) {
    const dir = join(work, String(tmpCount++));
    await mkdir(dir, { recursive: true });
    const entry = join(dir, `${name}.css`);
    const imports = files.map(file => {
      const rel = relative(dir, file);
      return `@import ${JSON.stringify(rel.startsWith('.') ? rel : `./${rel}`)};`;
    });
    await writeFile(entry, imports.join('\n'));
    const result = await esbuild.build({ ...common(), entryPoints: [entry] });
    record(result);
    const [key] = Object.entries(result.metafile.outputs).find(([, out]) => out.entryPoint);
    return basename(key);
  }

  // `entries`: [{ abs, name }]. -> the esbuild metafile.
  async function bundleEntries(entries) {
    const result = await esbuild.build({
      ...common(),
      entryPoints: entries.map(({ abs, name }) => ({ in: abs, out: name })),
      format: 'esm',
      splitting: true,
      sourcemap,
      plugins: [urlPlugin([])],
    });
    record(result);
    return result.metafile;
  }

  // What the output still asks of the browser that the packer could not resolve.
  async function scanLeftovers() {
    for (const file of (await walk(packDir)).filter(name => name.endsWith('.js'))) {
      const text = await readFile(join(packDir, file), 'utf8');
      for (const match of text.matchAll(LEFTOVER_URL)) {
        if (!existsSync(resolve(packDir, match[2]))) {
          warnings.add(`${file}: new URL("${match[2]}", import.meta.url) is not resolved here`);
        }
      }
      if (COMPUTED_IMPORT.test(text)) {
        warnings.add(`${file}: import() with a computed specifier is not bundled`);
      }
      COMPUTED_IMPORT.lastIndex = 0;
    }
  }

  return { bundleCss, bundleEntries, scanLeftovers };
}
