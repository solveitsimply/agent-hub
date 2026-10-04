/** Read observed host/Git context without guessing the target app environment. */
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export function repositoryIdentifier(remote) {
  if (typeof remote !== 'string') return null;
  let host, path;
  try {
    if (remote.includes('://')) {
      const url = new URL(remote);
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
      host = url.hostname; path = url.pathname;
    } else {
      const match = /^(?:[^@\s]+@)?([a-z0-9.-]+):([^\s]+)$/iu.exec(remote);
      if (!match) return null;
      [, host, path] = match;
    }
    const identifier = `${host.toLowerCase()}/${path.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '')}`;
    return /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/iu.test(identifier) && identifier.length <= 256 ? identifier : null;
  } catch { return null; }
}

export function captureContext(directory) {
  const cwd = resolve(directory ?? process.cwd());
  const git = args => {
    try { return execFileSync('git', args, {cwd, encoding:'utf8', timeout:2000, maxBuffer:4096, stdio:['ignore','pipe','ignore']}).trim(); }
    catch { return null; }
  };
  const repository = repositoryIdentifier(git(['config', '--get', 'remote.origin.url']));
  const commit = git(['rev-parse', '--verify', 'HEAD']);
  return {
    machine: hostname().toLowerCase().replace(/\.$/u, ''),
    workContext: repository ? {repository, branch:git(['symbolic-ref','--quiet','--short','HEAD']), commit:commit && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit) ? commit : null} : null,
  };
}
