#!/usr/bin/env node
import { resolve } from 'node:path';
import { build } from '../src/build.mjs';
import { checkSite } from '../src/check.mjs';
import { compose } from '../src/compose.mjs';
import { loadConfig } from '../src/config.mjs';
import { headerRules } from '../src/headers.mjs';

const USAGE = `usage:
  sitepack build   --in DIR --out DIR [--config FILE] [--manifest FILE]
  sitepack compose --in DIR --out DIR [--layout NAME] [--packed-at MOUNT] [--unpacked-at MOUNT]
                   [--config FILE] [--manifest FILE]
  sitepack check   DIR
  sitepack headers [--prefix /app/] [--config FILE]
MOUNT: "/", "/name/" or "none".`;

function parse(argv) {
  const options = {};
  const rest = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index].startsWith('--')) {
      options[argv[index].slice(2)] = argv[++index];
    } else {
      rest.push(argv[index]);
    }
  }
  return { options, rest };
}

const need = (options, key) => {
  if (!options[key]) {
    throw new Error(`--${key} is required\n${USAGE}`);
  }
  return resolve(options[key]);
};

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const { options, rest } = parse(argv);
  const log = message => console.log(`sitepack: ${message}`);
  if (command === 'check') {
    const problems = await checkSite(resolve(rest[0] ?? '.'));
    problems.forEach(problem => console.error(problem));
    process.exitCode = problems.length > 0 ? 1 : 0;
    return;
  }
  const config = await loadConfig(options.config);
  const manifestPath = options.manifest ? resolve(options.manifest) : undefined;
  if (command === 'build') {
    await build({ inDir: need(options, 'in'), outDir: need(options, 'out'), config, manifestPath, log });
  } else if (command === 'compose') {
    const overrides = { packedAt: options['packed-at'], unpackedAt: options['unpacked-at'] };
    await compose({
      inDir: need(options, 'in'),
      outDir: need(options, 'out'),
      config,
      layoutName: options.layout,
      overrides,
      manifestPath,
      log,
    });
  } else if (command === 'headers') {
    process.stdout.write(headerRules({ prefix: options.prefix, assetsDir: config.assetsDir }));
  } else {
    throw new Error(USAGE);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
