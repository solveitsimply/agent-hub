import {hasCoordinationSchema} from './coordination-capacity.mjs';

export async function canonicalSessionId(db,id){
  if(!id||!await hasCoordinationSchema(db))return id;
  return await db.prepare('SELECT canonical_session_id FROM session_aliases WHERE alias_session_id=?').bind(id).first('canonical_session_id')??id;
}
// A bare UUID is a legacy Codex registration, only when paired explicitly with
// codex:<that same UUID>. Never infer identity from similar titles or machines.
function chatIdentity(value){
  if(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))return 'codex:'+value.toLowerCase();
  const match=value.match(/^(codex|claude|gemini|grok|chatgpt):(.+)$/);
  if(!match)return value;
  return match[1]+':'+(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(match[2])?match[2].toLowerCase():match[2]);
}
export function registrationKeys(value){
  const identity=chatIdentity(value);
  if(/^codex:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(identity))return {keys:[identity,identity.slice(6)],uuid:true,canonical:identity};
  return {keys:[value,value],uuid:false,canonical:value};
}
export async function sessionManagementApi(c){
  const {path,method,db,principal,readBody,fail,checkKeys,string,ownerOnly,sessionById,requireActive,requireCurrent,json,sessionView,aliases,audit,now}=c;
  const mergeMatch=path.match(/^\/api\/sessions\/([^/]+)\/merge$/);
  if(!mergeMatch||method!=='POST')return null;
  if(!await hasCoordinationSchema(db))fail(503,'COORDINATION_UPGRADE_REQUIRED','Apply migration 0010 before merging registrations.');
  const body=await readBody();checkKeys(body,['targetSessionId']);
  const source=await sessionById(db,mergeMatch[1],principal,false,{resolveMerged:false});
  const target=await sessionById(db,string(body.targetSessionId,'targetSessionId',80),principal);
  if(source.principal_id!==target.principal_id||principal.role!=='owner'&&source.principal_id!==principal.id)fail(403,'SESSION_OWNER_REQUIRED','Merge only duplicate registrations owned by the same principal.');
  const existing=await db.prepare('SELECT canonical_session_id,merged_at FROM session_aliases WHERE alias_session_id=?').bind(source.id).first();
  if(existing){if(existing.canonical_session_id!==target.id)fail(409,'MERGE_CONFLICT','This registration already resolves to a different session.');return json({merge:{sourceSessionId:source.id,canonicalSessionId:target.id,mergedAt:existing.merged_at},session:sessionView(target,principal,aliases)});}
  if(source.id===target.id||source.project!==target.project||chatIdentity(source.external_id)!==chatIdentity(target.external_id)||!target.external_id.includes(':'))fail(422,'NOT_DUPLICATE_SESSIONS','Select the namespaced registration for the exact same external chat and project.');
  if(c.machineName(source.machine)!==c.machineName(target.machine))fail(422,'SESSION_IDENTITY_CONFLICT','Duplicate registrations must belong to the same machine.');
  requireActive(source);requireActive(target);
  const native=await db.prepare('SELECT session_id FROM observer_sessions WHERE session_id IN (?,?)').bind(source.id,target.id).all();
  if(new Set(native.results.map(row=>row.session_id)).size>1)fail(409,'MERGE_OBSERVER_CONFLICT','Both registrations have native observer bindings; reconcile those bindings before merging.');
  const claimCount=await db.prepare('SELECT COUNT(*) AS n FROM ownership WHERE owner_session_id IN (?,?)').bind(source.id,target.id).first('n');
  if(claimCount>100)fail(409,'MERGE_CLAIM_CAPACITY','Combined ownership exceeds the per-session claim budget.');
  const policies=await db.prepare('SELECT * FROM accountability_policies WHERE session_id IN (?,?)').bind(source.id,target.id).all();
  const policyValues=row=>JSON.stringify([row.check_in_enabled,row.grace_seconds,row.daily_limit,row.escalation_seconds]);
  if(policies.results.length===2&&policyValues(policies.results[0])!==policyValues(policies.results[1]))fail(409,'MERGE_POLICY_CONFLICT','Both registrations have different accountability policies; reconcile them before merging.');
  const date=now(),latest=source.last_seen_at>target.last_seen_at?source:target;
  const guard='EXISTS(SELECT 1 FROM session_aliases WHERE alias_session_id=? AND canonical_session_id=? AND merged_at=?)';
  const guarded=()=>[source.id,target.id,date];
  await db.batch([
    db.prepare(`INSERT INTO session_aliases SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sessions WHERE id=? AND principal_id=? AND revision=? AND last_seen_at=? AND project=? AND external_id=? AND machine=? AND archived_at IS NULL) AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND principal_id=? AND revision=? AND last_seen_at=? AND project=? AND external_id=? AND machine=? AND archived_at IS NULL) AND EXISTS(SELECT 1 FROM principals WHERE id=? AND active=1 AND (role='owner' OR (access_profile='agent' AND coordinator_access=0)) AND (role='owner' OR EXISTS(SELECT 1 FROM json_each(projects_json) WHERE value=?))) AND EXISTS(SELECT 1 FROM principals WHERE id=? AND active=1 AND (role='owner' OR EXISTS(SELECT 1 FROM json_each(projects_json) WHERE value=?))) AND (SELECT COUNT(*) FROM ownership WHERE owner_session_id IN (?,?))<=100 AND (SELECT COUNT(*) FROM observer_sessions WHERE session_id IN (?,?))<=1 AND NOT EXISTS(SELECT 1 FROM accountability_policies a JOIN accountability_policies b ON b.session_id=? WHERE a.session_id=? AND (a.check_in_enabled!=b.check_in_enabled OR a.grace_seconds!=b.grace_seconds OR a.daily_limit!=b.daily_limit OR a.escalation_seconds!=b.escalation_seconds)) ON CONFLICT(alias_session_id) DO NOTHING`).bind(source.id,target.id,date,principal.id,JSON.stringify(source),JSON.stringify(target),source.id,source.principal_id,source.revision,source.last_seen_at,source.project,source.external_id,source.machine,target.id,target.principal_id,target.revision,target.last_seen_at,target.project,target.external_id,target.machine,principal.id,source.project,source.principal_id,source.project,source.id,target.id,source.id,target.id,target.id,source.id),
    db.prepare(`UPDATE ownership SET owner_session_id=? WHERE owner_session_id=? AND ${guard}`).bind(target.id,source.id,...guarded()),
    db.prepare(`UPDATE observer_sessions SET session_id=? WHERE session_id=? AND ${guard}`).bind(target.id,source.id,...guarded()),
    db.prepare(`INSERT INTO accountability_policies SELECT ?,check_in_enabled,grace_seconds,daily_limit,escalation_seconds,updated_at FROM accountability_policies WHERE session_id=? AND ${guard} ON CONFLICT(session_id) DO NOTHING`).bind(target.id,source.id,...guarded()),
    db.prepare(`UPDATE session_aliases SET canonical_session_id=? WHERE canonical_session_id=? AND ${guard}`).bind(target.id,source.id,...guarded()),
    db.prepare(`UPDATE sessions SET label=?,task=?,status=?,environment=?,details_json=?,checkpoint_json=?,checkpoint_at=?,closeout_json=?,revision=revision+1,last_seen_at=? WHERE id=? AND ${guard}`).bind(latest.label,latest.task,latest.status,latest.environment,latest.details_json,latest.checkpoint_json,latest.checkpoint_at,latest.closeout_json,latest.last_seen_at,target.id,...guarded()),
    db.prepare(`UPDATE sessions SET archived_at=? WHERE id=? AND ${guard}`).bind(date,source.id,...guarded()),
  ]);
  await requireCurrent(db,principal);
  const merged=await db.prepare('SELECT canonical_session_id,merged_at FROM session_aliases WHERE alias_session_id=?').bind(source.id).first();
  if(!merged||merged.canonical_session_id!==target.id)fail(409,'SESSION_CHANGED','Registration changed during merge; reread both sessions.');
  await audit(db,principal,'session.merged',source.id).run();
  return json({merge:{sourceSessionId:source.id,canonicalSessionId:target.id,mergedAt:merged.merged_at},session:sessionView(await sessionById(db,target.id,principal),principal,aliases)});
}
