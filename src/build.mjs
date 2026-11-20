import * as esbuild from 'esbuild';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { createAssets } from './assets.mjs';
import { checkSite, cspMeta, inlineScripts } from './check.mjs';
import { scriptHash, withScriptHashes } from './csp.mjs';
import { applyEdits, attr, renderTag, scan, withAttr } from './html.mjs';
import {
  copyTree, isInside, isLocalRef, relativeUrl, removeEmptyDirs, stripQuery, toPosix, walk,
} from './util.mjs';

const IMAGE_TYPES = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
};
const PLAIN_LINK = new Set(['rel', 'href', 'type', 'crossorigin']);

function assertDisjoint(inDir, outDir) {
  if (isInside(outDir, inDir) || isInside(inDir, outDir)) {
    throw new Error(`input ${inDir} and output ${outDir} must not contain each other`);
  }
}

// Short, unique names for the entry bundles: the path below the common directory of the entries.
function entryNames(files) {
  const dirs = files.map(dirname);
  let base = dirs[0];
  while (!dirs.every(dir => isInside(dir, base))) {
    base = dirname(base);
  }
  const stems = files.map(file => {
    const rel = toPosix(file.slice(base.length + 1, -extname(file).length));
    return files.length === 1 ? `${basename(dirname(file))}-${basename(rel)}` : rel;
  });
  const used = new Map();
  return new Map(files.map((file, index) => {
    const stem = stems[index].replaceAll('/', '-');
    const count = used.get(stem) ?? 0;
    used.set(stem, count + 1);
    return [file, count === 0 ? stem : `${stem}-${count + 1}`];
  }));
}

function staticClosure(metafile, roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const key = queue.shift();
    for (const imported of metafile.outputs[key]?.imports ?? []) {
      if (imported.kind === 'import-statement' && !seen.has(imported.path)) {
        seen.add(imported.path);
        queue.push(imported.path);
      }
    }
  }
  return seen;
}

function stylesheetGroups(tags, dir) {
  const groups = [];
  let run = [];
  const flush = () => {
    if (run.length > 0) {
      groups.push(run);
    }
    run = [];
  };
  for (const tag of tags) {
    const local = tag.name === 'link' && !tag.closing &&
      (attr(tag, 'rel') ?? '').toLowerCase() === 'stylesheet' && isLocalRef(attr(tag, 'href'));
    if (!local) {
      flush();
      continue;
    }
    const plain = tag.attrs.every(([key]) => PLAIN_LINK.has(key.toLowerCase()));
    if (!plain) {
      flush();
      groups.push([tag]);
    } else {
      run.push(tag);
    }
  }
  flush();
  return groups.map(tags_ => ({
    tags: tags_,
    files: tags_.map(tag => resolve(dir, stripQuery(attr(tag, 'href')))),
  }));
}

async function inlineImage(tag, dir, max) {
  const src = attr(tag, 'src');
  if (max === 0 || !isLocalRef(src)) {
    return null;
  }
  const file = resolve(dir, stripQuery(src));
  const type = IMAGE_TYPES[extname(file).toLowerCase()];
  if (!type || !existsSync(file) || statSync(file).size > max) {
    return null;
  }
  const data = await readFile(file);
  const body = type === 'image/svg+xml'
    ? encodeURIComponent(data.toString('utf8').trim())
    : `;base64,${data.toString('base64')}`;
  const uri = type === 'image/svg+xml' ? `data:${type},${body}` : `data:${type}${body}`;
  return renderTag('img', withAttr(tag.attrs, 'src', uri));
}

// Packs the site in `inDir` into `outDir`. -> { files, pages, warnings }.
export async function build({ inDir, outDir, config, manifestPath, log = () => {} }) {
  assertDisjoint(inDir, outDir);
  await rm(outDir, { recursive: true, force: true });
  await copyTree(inDir, outDir);
  const packDir = join(outDir, config.assetsDir);
  if (existsSync(packDir)) {
    throw new Error(`${config.assetsDir}/ exists in the input: set another assetsDir`);
  }
  await mkdir(packDir);
  const work = await mkdtemp(join(tmpdir(), 'sitepack-'));
  try {
    return await run({ outDir, packDir, work, config, manifestPath, log });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function run({ outDir, packDir, work, config, manifestPath, log }) {
  const consumed = new Set();
  const warnings = new Set();
  const assets = createAssets({ esbuild, outDir, packDir, work, config, consumed, warnings });

  const names = config.pages === 'auto'
    ? (await walk(outDir)).filter(name => name.endsWith('.html'))
    : config.pages;
  const pages = [];
  for (const rel of names) {
    const abs = join(outDir, rel);
    const html = await readFile(abs, 'utf8');
    const tags = scan(html);
    const scripts = tags.filter(tag => tag.name === 'script' && !tag.closing &&
      attr(tag, 'type') === 'module' && isLocalRef(attr(tag, 'src')));
    const entries = scripts.map(tag => resolve(dirname(abs), stripQuery(attr(tag, 'src'))));
    for (const entry of entries) {
      if (!existsSync(entry)) {
        throw new Error(`${rel}: script ${entry.slice(outDir.length + 1)} does not exist`);
      }
    }
    pages.push({ rel, abs, dir: dirname(abs), html, tags, scripts, entries });
  }

  const all = [...new Set(pages.flatMap(page => page.entries))];
  const outputOf = new Map();
  let metafile = { outputs: {} };
  if (all.length > 0) {
    const named = entryNames(all);
    metafile = await assets.bundleEntries(all.map(abs => ({ abs, name: named.get(abs) })));
    for (const [key, output] of Object.entries(metafile.outputs)) {
      if (output.entryPoint) {
        outputOf.set(resolve(outDir, output.entryPoint), key);
      }
    }
  }
  const urlOf = (page, key) => relativeUrl(page.dir, resolve(outDir, key));

  const manifest = { pages: {} };
  for (const page of pages) {
    const edits = [];
    const info = { scripts: [], styles: [], preload: [] };
    for (const tag of page.scripts) {
      const key = outputOf.get(resolve(page.dir, stripQuery(attr(tag, 'src'))));
      info.scripts.push(urlOf(page, key));
      edits.push({
        start: tag.start,
        end: tag.closeEnd,
        text: `${renderTag('script', withAttr(tag.attrs, 'src', urlOf(page, key)))}</script>`,
      });
    }
    const stem = page.rel.replace(/\.html$/, '').replaceAll('/', '-');
    const groups = stylesheetGroups(page.tags, page.dir);
    for (const [index, group] of groups.entries()) {
      const name = index === 0 ? stem : `${stem}-${index + 1}`;
      const href = urlOf(page, `${toPosix(config.assetsDir)}/${await assets.bundleCss(group.files, name)}`);
      info.styles.push(href);
      const [first, ...rest] = group.tags;
      edits.push({
        start: first.start,
        end: first.end,
        text: renderTag('link', withAttr(first.attrs, 'href', href)),
      });
      edits.push(...rest.map(tag => ({ start: tag.start, end: tag.end, text: '' })));
    }
    for (const tag of page.tags.filter(item => item.name === 'img' && !item.closing)) {
      const text = await inlineImage(tag, page.dir, config.inlineMax);
      if (text) {
        edits.push({ start: tag.start, end: tag.end, text });
      }
    }
    if (config.preload && page.scripts.length > 0) {
      const own = page.scripts.map(tag => outputOf.get(resolve(page.dir, stripQuery(attr(tag, 'src')))));
      const chunks = [...staticClosure(metafile, own)].filter(key => !own.includes(key)).sort();
      info.preload = chunks.map(key => urlOf(page, key));
      const head = page.tags.find(tag => tag.name === 'head' && tag.closing);
      const at = head ? head.start : page.scripts[0].start;
      const links = chunks.map(key =>
        renderTag('link', [['rel', 'modulepreload'], ['href', urlOf(page, key)]]));
      if (links.length > 0) {
        edits.push({ start: at, end: at, text: `${links.join('\n')}\n` });
      }
    }
    // Inline scripts: optionally minified; every hash of the policy is recomputed from the result.
    const finalScripts = [];
    for (const tag of page.tags.filter(item => item.name === 'script' && item.content)) {
      const text = page.html.slice(tag.content.start, tag.content.end);
      const inline = inlineScripts(page.html, [tag]).length === 1;
      if (inline && config.inlineScripts === 'minify') {
        const { code } = await esbuild.transform(text, { minify: true, target: config.target });
        edits.push({ start: tag.content.start, end: tag.content.end, text: code.trim() });
        finalScripts.push(code.trim());
      } else if (inline) {
        finalScripts.push(text);
      }
    }
    const meta = cspMeta(page.tags);
    if (meta && config.csp === 'recompute') {
      const policy = attr(meta, 'content');
      const next = withScriptHashes(policy, finalScripts.map(scriptHash));
      if (next !== policy) {
        edits.push({
          start: meta.start,
          end: meta.end,
          text: renderTag('meta', withAttr(meta.attrs, 'content', next)),
        });
      }
    }
    await writeFile(page.abs, applyEdits(page.html, edits));
    manifest.pages[page.rel] = info;
  }

  await assets.scanLeftovers();
  if (config.prune === 'consumed') {
    for (const file of consumed) {
      const source = /\.(?:m?js|css)$/.test(file) && isInside(file, outDir) &&
        !isInside(file, packDir);
      if (source && existsSync(file)) {
        await rm(file);
      }
    }
  }
  for (const prefix of config.drop) {
    await rm(join(outDir, prefix), { recursive: true, force: true });
  }
  await removeEmptyDirs(outDir);

  const problems = await checkSite(outDir);
  if (problems.length > 0) {
    throw new Error(`the packed site has problems:\n${problems.join('\n')}`);
  }
  if (config.strict && warnings.size > 0) {
    throw new Error(`warnings (strict):\n${[...warnings].join('\n')}`);
  }

  manifest.files = {};
  // A site without bundles has no pack directory: the empty one is removed with the other empty ones.
  for (const name of existsSync(packDir) ? await walk(packDir) : []) {
    const data = await readFile(join(packDir, name));
    const isMap = name.endsWith('.map');
    manifest.files[name] = {
      bytes: data.length,
      brotli: isMap ? null : brotliCompressSync(data).length,
    };
  }
  manifest.warnings = [...warnings];
  if (manifestPath) {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const code = Object.entries(manifest.files).filter(([name]) => !name.endsWith('.map'));
  const bytes = code.reduce((sum, [, info]) => sum + info.bytes, 0);
  const brotli = code.reduce((sum, [, info]) => sum + info.brotli, 0);
  log(`packed ${pages.length} pages into ${code.length} files: ${bytes} bytes, ${brotli} brotli`);
  for (const warning of warnings) {
    log(`warning: ${warning}`);
  }
  return { files: manifest.files, pages: manifest.pages, warnings: [...warnings] };
}
