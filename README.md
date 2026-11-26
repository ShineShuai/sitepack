# sitepack

Deploy-time packer for static web apps. The source stays plain ES modules (dev and tests run it
unbundled); `sitepack` turns a *staged* site into few, content-hashed files for deployment.

Measured on zigzag, play page, JS needed at start (all levels, same build):

| Level | Name | Adds | Files | Raw | Brotli |
|---|---|---|---|---|---|
| 0 | `min` | minified, hashed, split, source maps | 6 | 475 KB | 154 KB |
| 1 | `plain` | unminified (comments are lost) | 6 | 845 KB | 198 KB |
| 2 | `commented` | comments kept, module path banners | 6 | 1,242 KB | 320 KB |
| 3 | `indexed` | contents list at the top of each file | 6 | 1,250 KB | 321 KB |
| 4 | `single` | one JS file per page | 1 | 1,351 KB | 327 KB |

Before: 169 module requests at depth 8. Hashed files can be cached `immutable`, so a returning
player makes no JS request.

## Commands

```
sitepack build   --in DIR --out DIR [--config FILE] [--manifest FILE]
sitepack compose --in DIR --out DIR [--layout NAME] [--packed-at MOUNT] [--unpacked-at MOUNT]
sitepack check   DIR
sitepack headers [--prefix /app/] [--config FILE]
```

- `build`: copies `--in` to `--out` and packs the pages there. `--in` is what your stage script
  already produces (the allowlisted runtime files). `--out` must not be inside it.
- `compose`: publishes both variants side by side, as the layout says (below).
- `check`: every local reference of every page exists; every CSP `script-src` hash matches an
  inline script and the other way round. `build` runs it on its result.
- `headers`: the Cloudflare `_headers` rule that makes the hashed folder `immutable`.

## What `build` does

1. Takes every `.html` file of the staged site as a page.
2. Bundles every `<script type="module" src>` with esbuild: one bundle per entry, shared code in
   common chunks, `import('./x.js')` becomes a lazy chunk. Output is flat in `assetsDir`
   (`pack/`), named `<name>-<hash>`.
3. Merges each run of plain `<link rel=stylesheet>` into one file (order kept).
4. Adds `<link rel=modulepreload>` for the static chunks of a page's entries (one round trip).
5. Inlines `<img>` files up to `inlineMax` bytes as data URIs (`0` = off).
6. Recomputes the hashes of a CSP `<meta>` `script-src` from the inline scripts that are left
   (`csp: "recompute"`). Inline scripts are kept as they are unless `inlineScripts: "minify"`.
7. Deletes the source `.js`/`.css` files that went into a bundle (`prune: "consumed"`) and the
   `drop` prefixes, then runs `check`. `strict: true` also fails on any warning (esbuild's too).

Everything not mentioned is copied as it is (data files, themes, images, other pages).

## Levels

The level says how readable the packed code is. It is chosen per layout (below) or with
`--level` (a number or a name); the default is 0.

| Level | minify | comments | contents list | one file per page | source maps |
|---|---|---|---|---|---|
| 0 `min` | yes | no | no | no | yes |
| 1 `plain` | no | no | no | no | no |
| 2 `commented` | no | yes | no | no | no |
| 3 `indexed` | no | yes | yes | no | no |
| 4 `single` | no | yes | yes | yes | no |

- Levels 0-3 have the same files, preload and lazy chunks. Only level 4 changes how the page
  loads: one file, lazy code inlined into the first load, and a failing first script stops the
  rest (separate scripts run on).
- Comments (level 2 and up): esbuild drops comments except `//!` and `/*!`. A shim turns
  full-line comments into those before esbuild reads a file; they appear as `//! text`. A guard
  compares the module with and without the shim (whitespace-only minification, ignoring a `;`
  before `}`); if the code differs, e.g. a template literal with a line starting with `//`, the
  module is built without the shim and a warning is printed. Trailing comments
  (`code; // note`) are not kept.
- Level 3: each bundle starts with a list of its modules and the line of their banner
  (`// <path>`, written by esbuild before each module).
- Names are hashed at every level, so the files can stay `immutable`.
- Use the same level for the site that previews a deploy and for the deploy.

## Source conventions (the source stays valid native ESM)

| In source | Packed |
|---|---|
| `new Worker(new URL('./w.js', import.meta.url), { type: 'module' })` | `w.js` is bundled on its own, the URL gets its hashed name |
| `new URL('./x.css', import.meta.url)` (also svg, png, woff2, ...) | hashed copy (css: minified) |
| `import('./x.js')` with a string literal | lazy chunk |
| `globalThis.__PACKED__ === true` | `true` (dead code of the unpacked mode is removed) |

Not understood, reported as warnings: `import(variable)` and other relative
`new URL(..., import.meta.url)`; they would break inside a bundle. Use a literal `import('./x.js')`.
A worker is built before the file that starts it, so a changed worker always changes the name of
its starter (no stale pair in an immutable cache).

## Layouts (what is published where, at which level)

A layout names a mount for each variant and a level for the packed one; a variant that is not
named is not published. A mount is `/` or `/name/`. Default layout: unpacked at `/`, packed at
`/packed/`, level 0. The layout names are yours.

```json
{
  "drop": ["webapp/src", "webapp/css"],
  "layouts": {
    "dev": { "unpacked": "/", "packed": "/packed/", "level": 2 },
    "prod": { "packed": "/", "level": 0 }
  }
}
```

`sitepack compose --layout prod`, or `--level 3 --packed-at /p/ --unpacked-at none` (the command
line wins). Each variant is a complete tree (its own `data/`, `assets/`), so relative URLs keep
working. Variants on one host share the origin, so also localStorage.

## Config (`sitepack.json`, all optional)

| Key | Default | |
|---|---|---|
| `assetsDir` | `"pack"` | hashed output folder, must not exist in the input |
| `target` | `"es2022"` | esbuild target |
| `inlineMax` | `4096` | bytes; `0` = never inline images |
| `inlineScripts` | `"keep"` | or `"minify"` |
| `csp` | `"recompute"` | or `"keep"` |
| `preload` | `true` | modulepreload links |
| `prune` | `"consumed"` | or `"none"` |
| `drop` | `[]` | path prefixes removed from the output |
| `strict` | `false` | warnings fail the build |
| `layouts` | `{}` | see above |

Which files are in the site is decided by the stage script that produces `--in`.

## Determinism (needed when an old commit is rebuilt)

Same sources + same sitepack and esbuild versions give byte-identical output (tested). So: pin
sitepack by tag in the app's lockfile, keep all URLs relative (no base path in the output), and
write no timestamps into hashed files.

## Limits

- The HTML scanner is for hand-written pages: no unquoted `>` in attribute values, no CDATA.
- Only `<script type="module">` is bundled; classic `<script src>` is left alone.
- No import maps, no JS imports of CSS, no one-HTML-file output yet.
- A tab that stays open over a deploy can ask for a lazy chunk that is gone: handle a failed
  `import()` in the app (offer a reload).
