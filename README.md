# sitepack

Deploy-time packer for static web apps. The source stays plain ES modules (dev and tests run it
unbundled); `sitepack` turns a *staged* site into few, content-hashed files for deployment.

Measured on zigzag (play app): 169 module requests at depth 8 become 1 HTML + 1 CSS + 2 entry
scripts + 4 preloaded chunks; JS 1,276 KB raw / 407 KB brotli becomes 475 KB / 154 KB (plus 58 KB / 11 KB CSS).
Hashed files can be cached `immutable`, so a returning player makes no JS request.

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

1. Finds the pages (`pages`: `"auto"` = every `.html`, or a list).
2. Bundles every `<script type="module" src>` with esbuild: one bundle per entry, shared code in
   common chunks, `import('./x.js')` becomes a lazy chunk. Output is flat in `assetsDir`
   (`pack/`), named `<name>-<hash>`, with external source maps.
3. Merges each run of plain `<link rel=stylesheet>` into one minified file (order kept).
4. Adds `<link rel=modulepreload>` for the static chunks of a page's entries (one round trip).
5. Inlines `<img>` files up to `inlineMax` bytes as data URIs (`0` = off).
6. Recomputes the hashes of a CSP `<meta>` `script-src` from the inline scripts that are left
   (`csp: "recompute"`). Inline scripts are kept as they are unless `inlineScripts: "minify"`.
7. Deletes the source `.js`/`.css` files that went into a bundle (`prune: "consumed"`) and the
   `drop` prefixes, then runs `check`. `strict: true` also fails on any warning (esbuild's too).

Everything not mentioned is copied as it is (data files, themes, images, other pages).

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

## Layouts (what is published where)

A layout names a mount for each variant; a variant that is not named is not published. A mount
is `/` or `/name/`. Default: unpacked at `/`, packed at `/packed/`.

```json
{
  "layouts": {
    "pages": { "unpacked": "/", "packed": "/packed/" },
    "prod": { "packed": "/" }
  }
}
```

`sitepack compose --layout prod` or `--packed-at /p/ --unpacked-at none` (command line wins).
Each variant is a complete tree (its own `data/`, `assets/`), so relative URLs keep working.
Both variants on one host share the origin, so also localStorage.

## Config (`sitepack.json`, all optional)

| Key | Default | |
|---|---|---|
| `pages` | `"auto"` | html files to process |
| `assetsDir` | `"pack"` | hashed output folder, must not exist in the input |
| `target` | `"es2022"` | esbuild target |
| `minify` | `true` | |
| `sourcemap` | `"external"` | or `"none"` |
| `inlineMax` | `4096` | bytes; `0` = never inline images |
| `inlineScripts` | `"keep"` | or `"minify"` |
| `csp` | `"recompute"` | or `"keep"` |
| `preload` | `true` | modulepreload links |
| `prune` | `"consumed"` | or `"none"` |
| `drop` | `[]` | path prefixes removed from the output |
| `strict` | `false` | warnings fail the build |
| `layouts` | `{}` | see above |

## Determinism (needed when an old commit is rebuilt)

Same sources + same sitepack and esbuild versions give byte-identical output (tested). So: pin
sitepack by tag in the app's lockfile, keep all URLs relative (no base path in the output), and
write no timestamps into hashed files.

## Limits

- The HTML scanner is for hand-written pages: no unquoted `>` in attribute values, no CDATA.
- Only `<script type="module">` is bundled; classic `<script src>` is left alone.
- No import maps, no JS imports of CSS, no `single` (one-file) mode yet: the output stage is
  separate from the bundling, so it can be added.
- A tab that stays open over a deploy can ask for a lazy chunk that is gone: handle a failed
  `import()` in the app (offer a reload).
