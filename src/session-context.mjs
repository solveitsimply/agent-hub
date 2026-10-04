/** Display normalization only; reporting labels never establish identity or authority. */
const AGENT_ALIASES = {
  codex: 'Codex', 'codex desktop': 'Codex', 'codex cli': 'Codex', 'openai codex': 'Codex',
  claude: 'Claude', gemini: 'Gemini', grok: 'Grok',
};
export const canonicalAgentName = value => typeof value === 'string' ? (Object.hasOwn(AGENT_ALIASES,value.trim().toLowerCase()) ? AGENT_ALIASES[value.trim().toLowerCase()] : value.trim()) : null;
export const agentNameSql = column => `CASE lower(trim(${column})) ${Object.entries(AGENT_ALIASES).map(([alias,name])=>`WHEN '${alias}' THEN '${name}'`).join(' ')} ELSE ${column} END`;
export function attributionLabels(metadata) {
  const client = canonicalAgentName(metadata.client);
  const rawClient=metadata.client?.trim().toLowerCase();
  const interfaceLabel = metadata.interface ?? (rawClient==='codex desktop'?'desktop':rawClient==='codex cli'?'cli':null);
  return {...metadata,client,...(client!==metadata.client?{reportedClient:metadata.client}:{}),...(interfaceLabel?{interface:interfaceLabel}:{})};
}

const hostLabel = value => /^[a-z0-9][a-z0-9.-]*\.?$/i.test(value) ? value.replace(/\.$/u,'').toLowerCase() : value;
export function machineAliases(raw) {
  if (!raw) return new Map();
  let entries;
  try { const value=JSON.parse(raw); if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error(); entries=Object.entries(value); } catch { throw new Error('Invalid machine alias configuration.'); }
  if(entries.length>64 || entries.some(([key,value])=>!key.trim() || key.length>120 || typeof value!=='string' || !value.trim() || value.length>120 || /[\x00-\x1f]/u.test(key+value))) throw new Error('Invalid machine alias configuration.');
  const aliases=new Map(entries.map(([key,value])=>[key.trim().toLowerCase(),hostLabel(value.trim())]));
  for(const target of aliases.values()) if(aliases.has(target.toLowerCase()) && aliases.get(target.toLowerCase())!==target) throw new Error('Machine aliases must point directly to a canonical name.');
  return aliases;
}
export const canonicalMachine = (value,aliases) => typeof value==='string' ? aliases.get(value.trim().toLowerCase()) ?? hostLabel(value.trim()) : null;
export const machineFilterValues = (value,aliases) => {
  const canonical=canonicalMachine(value,aliases);
  return [...new Set([canonical.toLowerCase().replace(/\.$/u,''),...Array.from(aliases).filter(([,target])=>target===canonical).map(([alias])=>alias.replace(/\.$/u,''))])];
};
export const ENVIRONMENTS = ['local','dev','staging','production'];
export function parseWorkContext(value,fail) {
  if(value===null)return null;
  if(!value || typeof value!=='object' || Array.isArray(value))fail(422,'INVALID_WORK_CONTEXT','workContext must be an object or null.');
  for(const key of Object.keys(value))if(!['repository','branch','commit'].includes(key))fail(422,'UNKNOWN_FIELD',`Unsupported work context field: ${key}`);
  const result={repository:null,branch:null,commit:null};
  for(const key of Object.keys(result)) {
    if(value[key]===null || value[key]===undefined)continue;
    if(typeof value[key]!=='string' || !value[key].trim() || value[key].length>256 || /[\x00-\x20\x7f]/u.test(value[key]))fail(422,'INVALID_WORK_CONTEXT',`Use a bounded ${key} identifier without spaces or control characters.`);
    result[key]=value[key].trim();
  }
  if(!result.repository)fail(422,'INVALID_WORK_CONTEXT','Identify the repository; use null to clear work context.');
  if(!/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/iu.test(result.repository))fail(422,'INVALID_WORK_CONTEXT','Use a repository identifier such as github.com/example/app, without credentials or URL parameters.');
  if(result.branch && (/[~^:?*\[\\]/u.test(result.branch) || /\.\.|@\{|\/\/|(?:^|\/)\.|\.lock(?:\/|$)|[./]$/u.test(result.branch) || result.branch==='@' || result.branch.startsWith('-') || result.branch.startsWith('/')))fail(422,'INVALID_WORK_CONTEXT','Use a Git branch name, or null for a detached checkout.');
  if(result.commit && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(result.commit))fail(422,'INVALID_WORK_CONTEXT','Use the full Git commit, or null when unavailable.');
  return result;
}
