import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scriptHash, scriptHashes, withScriptHashes } from '../src/csp.mjs';
import { applyEdits, attr, renderTag, scan } from '../src/html.mjs';

test('scan: tags, attributes, comments, raw text', () => {
  const html = '<!-- <script src="no.js"></script> --><link rel=stylesheet href="a.css" defer>' +
    '<script type="module" src=\'m.js\'></script><script>if (a < b) { x = "</p>"; }</script>';
  const tags = scan(html);
  assert.deepEqual(tags.map(tag => tag.name), ['link', 'script', 'script']);
  assert.equal(attr(tags[0], 'rel'), 'stylesheet');
  assert.equal(attr(tags[0], 'defer'), null);
  assert.equal(attr(tags[1], 'src'), 'm.js');
  const inline = tags[2];
  assert.equal(html.slice(inline.content.start, inline.content.end), 'if (a < b) { x = "</p>"; }');
  assert.equal(html.slice(inline.closeEnd - 9, inline.closeEnd), '</script>');
});

test('renderTag and applyEdits', () => {
  assert.equal(renderTag('link', [['rel', 'x'], ['defer', null], ['href', 'a"b']]),
    '<link rel="x" defer href="a&quot;b">');
  assert.equal(applyEdits('0123456789', [
    { start: 2, end: 4, text: 'AB' },
    { start: 7, end: 7, text: '-' },
  ]), '01AB456-789');
});

test('csp: hashes are replaced, a policy without hashes is kept', () => {
  const hash = scriptHash('x=1');
  const policy = "default-src 'self'; script-src 'self' 'sha256-OLD'; img-src data:";
  const next = withScriptHashes(policy, [hash, hash]);
  assert.deepEqual(scriptHashes(next), [hash]);
  assert.match(next, /default-src 'self'; script-src 'self' 'sha256-/);
  const open = "script-src 'self' 'unsafe-inline'";
  assert.equal(withScriptHashes(open, [hash]), open);
});
