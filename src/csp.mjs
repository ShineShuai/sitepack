import { createHash } from 'node:crypto';

export const scriptHash = text =>
  `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

const isHash = token => /^'sha(?:256|384|512)-/.test(token);

export function parsePolicy(policy) {
  return policy
    .split(';')
    .map(part => part.trim().split(/\s+/))
    .filter(tokens => tokens[0] !== '');
}

export function scriptHashes(policy) {
  const directive = parsePolicy(policy).find(tokens => tokens[0] === 'script-src');
  return directive ? directive.filter(isHash) : [];
}

// Replaces the hash sources of script-src with `hashes`. A policy without hash sources is left as
// it is (it allows inline scripts some other way, or none).
export function withScriptHashes(policy, hashes) {
  if (scriptHashes(policy).length === 0) {
    return policy;
  }
  const unique = [...new Set(hashes)];
  return parsePolicy(policy)
    .map(tokens => {
      if (tokens[0] !== 'script-src') {
        return tokens.join(' ');
      }
      const kept = tokens.filter(token => !isHash(token));
      return [...kept, ...unique].join(' ');
    })
    .join('; ');
}
