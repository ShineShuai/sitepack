import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from './build.mjs';
import { resolveLayout } from './config.mjs';
import { copyTree, isInside } from './util.mjs';

// Lays the staged site `inDir` out as the layout says: the original at its mount, the packed
// copy at its mount (a mount is "/" or "/name/"). -> the layout used.
export async function compose({ inDir, outDir, config, layoutName, overrides, manifestPath, log }) {
  const layout = resolveLayout(config, layoutName, overrides);
  if (isInside(outDir, inDir) || isInside(inDir, outDir)) {
    throw new Error('input and output must not contain each other');
  }
  const tmp = await mkdtemp(join(tmpdir(), 'sitepack-compose-'));
  try {
    const sources = [];
    if (layout.unpacked) {
      sources.push([layout.unpacked, inDir]);
    }
    if (layout.packed) {
      const packed = join(tmp, 'packed');
      await build({ inDir, outDir: packed, config, level: layout.level, manifestPath, log });
      sources.push([layout.packed, packed]);
    }
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    sources.sort((a, b) => a[0].length - b[0].length);
    for (const [mount, source] of sources) {
      const dest = join(outDir, mount.slice(1));
      if (mount !== '/' && existsSync(dest)) {
        throw new Error(`cannot publish at ${mount}: the site already has that path`);
      }
      await copyTree(source, dest);
      log?.(`${source === inDir ? 'unpacked' : 'packed'} -> ${mount}`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return layout;
}
