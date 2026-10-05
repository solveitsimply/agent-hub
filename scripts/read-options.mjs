// Shared CLI/MCP query contract. Validation failures never broaden a search.
import { HubClientError } from './client-error.mjs';

export const sessionFilterNames = ['project','agentName','agentModel','machine','environment','repository','branch','status','attention'];
export const sessionFlagNames = ['agentNameUnknown','agentModelUnknown','machineUnknown','environmentUnknown','repositoryUnknown','branchUnknown','staleOnly'];

export function readQuery(args, names, flags = [], maximum = 200) {
  const allowed = new Set([...names,...flags,'view','limit']);
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new HubClientError('INVALID_ARGUMENT', `Unsupported filter: ${key}`);
  const view = args.view ?? 'compact';
  if (!['compact','full'].includes(view)) throw new HubClientError('INVALID_ARGUMENT', 'view must be compact or full.');
  const limit = args.limit ?? (view === 'compact' ? 20 : maximum);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new HubClientError('INVALID_ARGUMENT', `limit must be 1 to ${maximum}.`);
  const query = {view,limit};
  for (const key of names) if (args[key] !== undefined) {
    if (key === 'after') {
      if (!Number.isSafeInteger(args[key]) || args[key] < 0) throw new HubClientError('INVALID_ARGUMENT','after must be a nonnegative integer.');
    } else if (typeof args[key] !== 'string' || !args[key].trim()) throw new HubClientError('INVALID_ARGUMENT', `${key} must be a nonempty string.`);
    if (key === 'direction' && !['incoming','all'].includes(args[key])) throw new HubClientError('INVALID_ARGUMENT','direction must be incoming or all.');
    query[key] = args[key];
  }
  for (const key of flags) if (args[key] !== undefined) {
    if (args[key] !== true) throw new HubClientError('INVALID_ARGUMENT', `${key} must be true when supplied.`);
    const known = key.replace(/Unknown$/u,'');
    if (key.endsWith('Unknown') && args[known] !== undefined) throw new HubClientError('INVALID_ARGUMENT', `Choose ${known} or ${key}.`);
    query[key] = '1';
  }
  if (args.branch !== undefined && !args.repository) throw new HubClientError('INVALID_ARGUMENT','branch requires repository.');
  return query;
}

export function cliOptions(argv, names, flags = []) {
  const aliases = Object.fromEntries([...names,...flags,'view','limit'].map(key => [key.replace(/[A-Z]/gu, letter => '-'+letter.toLowerCase()),key]));
  const options = {}, positional = [];
  for (let index=0;index<argv.length;index++) {
    const arg=argv[index];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key=aliases[arg.slice(2)];
    if (!key || Object.hasOwn(options,key)) throw new HubClientError('USAGE', `Unknown or repeated option: ${arg}`);
    if (flags.includes(key)) options[key]=true;
    else {
      const value=argv[++index];
      if (!value || value.startsWith('--')) throw new HubClientError('USAGE', `Missing value for ${arg}`);
      options[key]=key==='limit'?Number(value):value;
    }
  }
  return {options,positional};
}
