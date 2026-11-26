import * as esbuild from 'esbuild';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepComments, shim } from '../src/comments.mjs';
import { addToc } from '../src/toc.mjs';

test('shim: full-line comments become legal comments, nothing else changes', () => {
  const source = [
    '// line', '  // indented', '//! already', '/** doc', ' * text', ' */',
    '/* block */', '/**/', '/*! legal */', 'const a = 1; // trailing', 'const b = "// no";',
  ].join('\n');
  assert.equal(shim(source, 'js'), [
    '//! line', '  //! indented', '//! already', '/*! doc', ' * text', ' */',
    '/*! block */', '/**/', '/*! legal */', 'const a = 1; // trailing', 'const b = "// no";',
  ].join('\n'));
  assert.equal(shim('/* a */\n  /* b */\n/*! c */', 'css'), '/*! a */\n  /*! b */\n/*! c */');
});

test('guard: comments are kept, a template literal is left alone', async () => {
  const plain = '// note\n/* block\n   text */\nexport const c = 1;\n// end\n';
  const kept = await keepComments(esbuild, plain);
  assert.equal(kept.kept, true);
  assert.match(kept.text, /^\/\/! note/);
  const closing = await keepComments(esbuild, 'export function f(v) {\n  return v;\n  // end\n}\n');
  assert.equal(closing.kept, true);
  for (const literal of ['`\n// in the string\nx`', '`\n/* in the string */\nx`']) {
    const source = `export const html = ${literal};\n`;
    const result = await keepComments(esbuild, source);
    assert.deepEqual(result, { text: source, kept: false });
  }
  const broken = await keepComments(esbuild, '// c\nexport const = ;\n');
  assert.equal(broken.kept, false);
  const css = await keepComments(esbuild, '/* c */\na { b: c; }\n', 'css');
  assert.deepEqual(css, { text: '/*! c */\na { b: c; }\n', kept: true });
});

test('toc: the listed line numbers are the lines of the banners', () => {
  const body = [
    '// app/a.js', 'const a = 1;', '', '// app/b.js', 'const b = 2;', '// not/a/banner.js',
  ];
  const text = addToc(body.join('\n'), ['app/a.js', 'app/b.js'], 'sitepack level indexed');
  const lines = text.split('\n');
  const listed = lines.filter(line => /^\/\/ {3}\s*\d+ {2}/.test(line));
  assert.equal(listed.length, 2);
  for (const line of listed) {
    const [, number, name] = /^\/\/\s+(\d+)\s+(\S+)$/.exec(line);
    assert.equal(lines[Number(number) - 1], `// ${name}`);
  }
  assert.equal(addToc('const x = 1;\n', ['app/a.js'], 't'), 'const x = 1;\n');
});
