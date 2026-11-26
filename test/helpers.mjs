import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { walk } from '../src/util.mjs';

const made = [];
process.on('exit', () => made.forEach(dir => rmSync(dir, { recursive: true, force: true })));

export function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'sitepack-test-'));
  made.push(dir);
  return dir;
}

// A directory holding `files` ({ 'a/b.txt': 'text' }).
export function site(files) {
  const dir = temp();
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

export async function snapshot(dir) {
  const entries = await Promise.all(
    (await walk(dir)).map(async name => {
      const data = await readFile(join(dir, name));
      return [name, data.toString('base64')];
    }),
  );
  return Object.fromEntries(entries);
}

export const page = ({ head = '', body = '' } = {}) =>
  `<!DOCTYPE html>\n<html><head>\n${head}\n</head><body>\n${body}\n</body></html>\n`;
