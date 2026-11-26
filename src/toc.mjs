// Level 3: a contents list at the top of a bundle. esbuild writes `// <path>` before the code of
// each module of an unminified bundle; the list gives the line of each of those banners.
export function addToc(text, inputs, title) {
  const banners = new Set(inputs.map(input => `// ${input}`));
  const found = [];
  text.split('\n').forEach((line, index) => {
    if (banners.has(line)) {
      found.push([index, line.slice(3)]);
    }
  });
  if (found.length === 0) {
    return text;
  }
  const headerLength = found.length + 3;
  const entries = found.map(
    ([index, name]) => `//   ${String(index + headerLength + 1).padStart(6)}  ${name}`,
  );
  const heading = `// ${title}: ${found.length} modules. Contents (line, module):`;
  const header = [heading, ...entries, '//', ''];
  return `${header.join('\n')}\n${text}`;
}
