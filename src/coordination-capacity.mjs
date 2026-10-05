const DEFAULTS=Object.freeze({sessionDaily:500,principalDaily:3000,workspaceDaily:5000,retainedMessages:100000,retainedBodyBytes:128*1024*1024});
const schemaCache=new WeakMap();
export function sessionPolicy(env,fail){
  const defaults={activePrincipal:500,activeWorkspace:2000,retainedPrincipal:10000,retainedWorkspace:100000};let configured={};
  try{configured=env.SESSION_LIMITS_JSON?JSON.parse(env.SESSION_LIMITS_JSON):{};}catch{fail(503,'INVALID_SESSION_POLICY','The operator must correct SESSION_LIMITS_JSON.');}
  if(!configured||typeof configured!=='object'||Array.isArray(configured)||Object.keys(configured).some(key=>!Object.hasOwn(defaults,key)))fail(503,'INVALID_SESSION_POLICY','Use documented session capacity settings.');
  const limits={...defaults,...configured};for(const value of Object.values(limits))if(!Number.isSafeInteger(value)||value<1||value>1000000)fail(503,'INVALID_SESSION_POLICY','Session capacity settings must be positive bounded integers.');
  if(limits.activeWorkspace>2000||limits.activePrincipal>limits.activeWorkspace||limits.retainedPrincipal>limits.retainedWorkspace||limits.activeWorkspace>limits.retainedWorkspace||limits.activePrincipal>limits.retainedPrincipal)fail(503,'INVALID_SESSION_POLICY','Keep active sessions within the 2000-workspace discovery ceiling and retained capacity.');
  return limits;
}
export async function hasCoordinationSchema(db){
  if(schemaCache.get(db))return true;
  const available=!!await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hub_message_usage'").first();
  if(available)schemaCache.set(db,true);
  return available;
}
export function messagePolicy(env,fail){
  let configured={};
  try{configured=env.MESSAGE_LIMITS_JSON?JSON.parse(env.MESSAGE_LIMITS_JSON):{};}catch{fail(503,'INVALID_MESSAGE_POLICY','The operator must correct MESSAGE_LIMITS_JSON.');}
  if(!configured||typeof configured!=='object'||Array.isArray(configured)||Object.keys(configured).some(key=>!Object.hasOwn(DEFAULTS,key)))fail(503,'INVALID_MESSAGE_POLICY','Use only documented message capacity settings.');
  const limits={...DEFAULTS,...configured};
  for(const value of Object.values(limits))if(!Number.isSafeInteger(value)||value<1||value>1024*1024*1024)fail(503,'INVALID_MESSAGE_POLICY','Message capacity settings must be positive bounded integers.');
  if(limits.sessionDaily>limits.principalDaily||limits.principalDaily>limits.workspaceDaily)fail(503,'INVALID_MESSAGE_POLICY','Daily limits must increase from session to principal to workspace.');
  return limits;
}
export const sessionLineage='SELECT ? UNION SELECT alias_session_id FROM session_aliases WHERE canonical_session_id=?';
export function sessionHistorySelect(select){
  return select.replace('WHERE session_id=s.id','WHERE session_id IN (SELECT s.id UNION SELECT alias_session_id FROM session_aliases WHERE canonical_session_id=s.id)')
    .replace("WHERE d.id=json_extract(s.checkpoint_json,'$.wait.sessionId')","WHERE d.id=COALESCE((SELECT canonical_session_id FROM session_aliases WHERE alias_session_id=json_extract(s.checkpoint_json,'$.wait.sessionId')),json_extract(s.checkpoint_json,'$.wait.sessionId'))");
}
export async function sessionMessageScope(db,sessionId,column){
  if(!['m.from_session_id','m.to_session_id','session_id'].includes(column))throw new Error('Unsupported session scope column');
  return await hasCoordinationSchema(db)?{sql:`${column} IN (${sessionLineage})`,values:[sessionId,sessionId]}:{sql:`${column}=?`,values:[sessionId]};
}
export function messageAdmission(limits,date,principalId,sessionId,bodyBytes){
  const day=date.slice(0,10);
  return {sql:`(SELECT messages<? AND body_bytes+?<=? FROM hub_message_storage WHERE id=1)
    AND COALESCE((SELECT messages FROM hub_message_usage WHERE scope='workspace' AND scope_id='*' AND day=?),0)<?
    AND COALESCE((SELECT messages FROM hub_message_usage WHERE scope='principal' AND scope_id=? AND day=?),0)<?
    AND (? IS NULL OR COALESCE((SELECT SUM(messages) FROM hub_message_usage WHERE scope='session' AND scope_id IN (${sessionLineage}) AND day=?),0)<?)`,
    values:[limits.retainedMessages,bodyBytes,limits.retainedBodyBytes,day,limits.workspaceDaily,principalId,day,limits.principalDaily,sessionId,sessionId,sessionId,day,limits.sessionDaily]};
}
export async function messageCapacity(db,limits,principalId,sessionId,date=new Date().toISOString()){
  const day=date.slice(0,10),storage=await db.prepare('SELECT messages,body_bytes FROM hub_message_storage WHERE id=1').first();
  const row=await db.prepare(`SELECT
    COALESCE((SELECT messages FROM hub_message_usage WHERE scope='workspace' AND scope_id='*' AND day=?),0) AS workspace,
    COALESCE((SELECT messages FROM hub_message_usage WHERE scope='principal' AND scope_id=? AND day=?),0) AS principal,
    COALESCE((SELECT SUM(messages) FROM hub_message_usage WHERE scope='session' AND scope_id IN (${sessionLineage}) AND day=?),0) AS session`).bind(day,principalId,day,sessionId,sessionId,day).first();
  return {limits,day,resetAt:new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString(),usage:{...row,retainedMessages:storage.messages,retainedBodyBytes:storage.body_bytes}};
}
export async function explainMessageCapacity(db,limits,principalId,sessionId,bodyBytes,fail){
  const {usage}=await messageCapacity(db,limits,principalId,sessionId);
  for(const [scope,key] of [['session','sessionDaily'],['principal','principalDaily'],['workspace','workspaceDaily']])if((scope!=='session'||sessionId)&&usage[scope]>=limits[key])fail(429,`MESSAGE_${scope.toUpperCase()}_DAILY_LIMIT`,`${scope} message allowance reached (${limits[key]} per UTC day). Exact retries remain safe; read /api/limits for usage and reset time.`);
  if(usage.retainedMessages>=limits.retainedMessages||usage.retainedBodyBytes+bodyBytes>limits.retainedBodyBytes)fail(503,'MESSAGE_STORAGE_LIMIT','Workspace retained-message storage budget reached. The operator must review storage capacity or retention; retries will not restore capacity.');
  fail(409,'MESSAGE_CUSTODY_CHANGED','Session or invitation custody changed; reread before sending.');
}
