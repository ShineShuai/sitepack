import { createHash } from 'node:crypto';
import { cp, readdir, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

export const toPosix = path => path.split(sep).join('/');

export const hashHex = (data, length = 8) =>
  createHash('sha256').update(data).digest('hex').slice(0, length);

export function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
}

// Every file below `dir`, as paths relative to it (POSIX separators), sorted.
export async function walk(dir, base = dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(path, base)));
    } else {
      found.push(toPosix(relative(base, path)));
    }
  }
  return found.sort();
}

export const copyTree = (from, to) => cp(from, to, { recursive: true });

// Removes empty directories below `dir` (not `dir` itself).
export async function removeEmptyDirs(dir, top = dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await removeEmptyDirs(join(dir, entry.name), top);
    }
  }
  if (dir !== top && (await readdir(dir)).length === 0) {
    await rm(dir, { recursive: true });
  }
}

// Relative URL from the directory `fromDir` to the file `toFile`.
export const relativeUrl = (fromDir, toFile) => toPosix(relative(fromDir, toFile));

export const isLocalRef = value =>
  Boolean(value) && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#|\?)/i.test(value);

export const stripQuery = value => value.replace(/[?#].*$/, '');
