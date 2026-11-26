// esbuild prints code from its syntax tree and drops comments, except "legal" ones (`//!`,
// `/*!`). The shim turns full-line comments into legal comments before esbuild reads a file,
// so levels 2 and up keep them. A line inside a template literal that starts like a comment
// would be changed too: the guard catches that and leaves such a module as it is.
const JS_RULES = [
  [/^([ \t]*)\/\/(?!!)/gm, '$1//!'],
  [/^([ \t]*)\/\*\*(?![/*])/gm, '$1/*!'],
  [/^([ \t]*)\/\*(?![!*])/gm, '$1/*!'],
];
const CSS_RULES = [[/^([ \t]*)\/\*(?!!)/gm, '$1/*!']];

export const shim = (source, loader) =>
  (loader === 'css' ? CSS_RULES : JS_RULES).reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    source,
  );

// Whitespace-only minification prints on one line, so comments cannot stay, and it keeps the
// statements apart. A ";" before "}" can still differ when a comment sat there: ignored.
const normalize = code => code.replaceAll(';}', '}');

// -> { text, kept }: `text` is the source with its comments made legal when that changes
// nothing else (`kept`), else the source as it is.
export async function keepComments(esbuild, source, loader = 'js') {
  const shimmed = shim(source, loader);
  if (shimmed === source) {
    return { text: source, kept: true };
  }
  const options = { loader, minifyWhitespace: true, legalComments: 'none', format: 'esm' };
  try {
    const [before, after] = await Promise.all([
      esbuild.transform(source, options),
      esbuild.transform(shimmed, options),
    ]);
    const same = normalize(before.code) === normalize(after.code);
    return same ? { text: shimmed, kept: true } : { text: source, kept: false };
  } catch {
    return { text: source, kept: false };
  }
}
