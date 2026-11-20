// A small scanner for hand-written HTML pages: tags with their source offsets, comments and the
// text of <script>/<style> skipped properly. Not a full HTML parser: no unquoted `>` in attribute
// values, no <![CDATA[ ]]>. That is enough for pages a person writes.
const OPEN = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/y;
const ATTR = /\s*([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
const RAW_TEXT = new Set(['script', 'style']);

export function scan(html) {
  const lower = html.toLowerCase();
  const tags = [];
  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (lt < 0) {
      break;
    }
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      index = close < 0 ? html.length : close + 3;
      continue;
    }
    OPEN.lastIndex = lt;
    const open = OPEN.exec(html);
    if (!open) {
      index = lt + 1;
      continue;
    }
    const tag = { name: open[2].toLowerCase(), closing: open[1] === '/', attrs: [], start: lt };
    let at = OPEN.lastIndex;
    for (;;) {
      ATTR.lastIndex = at;
      const attr = ATTR.exec(html);
      if (!attr || attr.index !== at) {
        break;
      }
      tag.attrs.push([attr[1], attr[2] ?? attr[3] ?? attr[4] ?? null]);
      at = ATTR.lastIndex;
    }
    const gt = html.indexOf('>', at);
    tag.end = gt < 0 ? html.length : gt + 1;
    tag.closeEnd = tag.end;
    if (RAW_TEXT.has(tag.name) && !tag.closing) {
      const close = lower.indexOf(`</${tag.name}`, tag.end);
      const stop = close < 0 ? html.length : close;
      tag.content = { start: tag.end, end: stop };
      const closeGt = html.indexOf('>', stop);
      tag.closeEnd = closeGt < 0 ? html.length : closeGt + 1;
    }
    tags.push(tag);
    index = tag.closeEnd;
  }
  return tags;
}

export const attr = (tag, name) => tag.attrs.find(([key]) => key.toLowerCase() === name)?.[1];

export function withAttr(attrs, name, value) {
  return attrs.map(pair => (pair[0].toLowerCase() === name ? [pair[0], value] : pair));
}

const escapeValue = value => value.replaceAll('"', '&quot;');

export function renderTag(name, attrs) {
  const parts = attrs.map(([key, value]) =>
    value === null ? key : `${key}="${escapeValue(value)}"`,
  );
  return `<${[name, ...parts].join(' ')}>`;
}

// Applies non-overlapping edits {start, end, text} to `html`.
export function applyEdits(html, edits) {
  let result = html;
  for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}
