import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { scriptHash, scriptHashes } from './csp.mjs';
import { attr, scan } from './html.mjs';
import { isLocalRef, stripQuery, walk } from './util.mjs';

const REFS = [['script', 'src'], ['link', 'href'], ['img', 'src'], ['a', 'href'],
  ['source', 'src'], ['audio', 'src'], ['video', 'src']];
const EXECUTABLE = new Set(['', 'module', 'text/javascript', 'application/javascript']);

export const inlineScripts = (html, tags) =>
  tags
    .filter(tag => tag.name === 'script' && !tag.closing && attr(tag, 'src') === undefined)
    .filter(tag => EXECUTABLE.has((attr(tag, 'type') ?? '').toLowerCase()))
    .filter(tag => tag.content.end > tag.content.start)
    .map(tag => html.slice(tag.content.start, tag.content.end));

export const cspMeta = tags =>
  tags.find(tag => tag.name === 'meta' &&
    /^content-security-policy$/i.test(attr(tag, 'http-equiv') ?? ''));

function exists(path) {
  return existsSync(path) && (!statSync(path).isDirectory() || existsSync(join(path, 'index.html')));
}

// Problems of the site in `dir`: references that point nowhere, CSP hashes that do not match
// the inline scripts. -> a list of strings (empty = fine).
export async function checkSite(dir) {
  const problems = [];
  for (const rel of (await walk(dir)).filter(name => name.endsWith('.html'))) {
    const html = await readFile(join(dir, rel), 'utf8');
    const tags = scan(html);
    for (const tag of tags.filter(item => !item.closing)) {
      for (const [name, key] of REFS) {
        const value = tag.name === name ? attr(tag, key) : undefined;
        if (isLocalRef(value) && !exists(resolve(dirname(join(dir, rel)), stripQuery(value)))) {
          problems.push(`${rel}: <${name} ${key}="${value}"> points to nothing`);
        }
      }
    }
    const meta = cspMeta(tags);
    const policy = meta ? attr(meta, 'content') : null;
    if (policy && scriptHashes(policy).length > 0) {
      const have = new Set(scriptHashes(policy));
      const want = new Set(inlineScripts(html, tags).map(scriptHash));
      for (const hash of want) {
        if (!have.has(hash)) {
          problems.push(`${rel}: an inline script is not allowed by script-src (${hash})`);
        }
      }
      for (const hash of have) {
        if (!want.has(hash)) {
          problems.push(`${rel}: script-src has a hash that no inline script matches (${hash})`);
        }
      }
    }
  }
  return problems;
}
