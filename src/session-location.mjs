import {hasCoordinationSchema} from './coordination-capacity.mjs';
import {registrationKeys} from './session-management.mjs';

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
// An operator-confirmed saved-history location is coordination metadata. It
// grants no native execution, delivery, approval, or resource authority.
export async function sessionLocationApi(c){
  const {path,method,db,principal,readBody,fail,checkKeys,string,sessionById,requireActive,requireCurrent,json,sessionView,aliases,audit,now}=c;
  const match=path.match(/^\/api\/sessions\/([^/]+)\/location$/);
  if(!match||method!=='POST')return null;
  if(!await hasCoordinationSchema(db))fail(503,'COORDINATION_UPGRADE_REQUIRED','Upgrade the coordination schema before reconciling locations.');
  const row=await sessionById(db,match[1],principal,true);requireActive(row);
  const body=await readBody();
  checkKeys(body,['requestId','expectedRevision','expectedLastSeenAt','expectedMachine','expectedExternalId','expectedPrincipalId','expectedProject','machine','reference','nativeId']);
  const requestId=string(body.requestId,'requestId',36),nativeId=string(body.nativeId,'nativeId',36);
  if(!UUID.test(requestId)||!UUID.test(nativeId))fail(422,'INVALID_IDENTITY','Use exact UUID request and native identities.');
  if(!body.reference||typeof body.reference!=='object'||Array.isArray(body.reference))fail(422,'INVALID_REFERENCE','Select an exact device, profile and conversation.');
  checkKeys(body.reference,['deviceId','profileId','app','conversationId']);
  const reference={deviceId:string(body.reference.deviceId,'deviceId',36),profileId:string(body.reference.profileId,'profileId',160),app:string(body.reference.app,'app',16),conversationId:string(body.reference.conversationId,'conversationId',200)};
  if(!UUID.test(reference.deviceId)||!['claude','codex'].includes(reference.app))fail(422,'INVALID_REFERENCE','Unsupported native device or app.');
  if(reference.app==='codex'&&reference.conversationId.toLowerCase()!==nativeId.toLowerCase())fail(422,'INVALID_REFERENCE','Codex conversation must use the exact native UUID.');
  if(reference.app==='claude'&&!UUID.test(reference.conversationId)&&!/^local_[a-f0-9-]{36}$/i.test(reference.conversationId))fail(422,'INVALID_REFERENCE','Unsupported Claude conversation identity.');
  const identity=registrationKeys(row.external_id).canonical;
  const legacy=reference.app==='claude'&&/^claude-code(?:-desktop)?:/.test(identity)?identity.replace(/^claude-code(?:-desktop)?:/,'claude:'):identity;
  const codex=reference.app==='codex'?legacy.replace(/^codex-desktop:/,'codex:'):legacy;
  if(codex.toLowerCase()!==`${reference.app}:${nativeId.toLowerCase()}`)fail(409,'SESSION_IDENTITY_CONFLICT','The selected native UUID does not match this Hub registration.');
  const machine=string(body.machine,'machine',120),previous=JSON.parse(row.details_json),old=previous.nativeLocation;
  const payload={machine,reference,nativeId:nativeId.toLowerCase()};
  if(old?.requestId===requestId){
    if(JSON.stringify({machine:old.machine,reference:old.reference,nativeId:old.nativeId})!==JSON.stringify(payload))fail(409,'IDEMPOTENCY_CONFLICT','This request ID records another location.');
    await requireCurrent(db,principal);return json({session:sessionView(row,principal,aliases),reused:true});
  }
  if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||body.expectedRevision!==row.revision||body.expectedLastSeenAt!==row.last_seen_at||body.expectedMachine!==row.machine||body.expectedExternalId!==row.external_id||body.expectedPrincipalId!==row.principal_id||body.expectedProject!==row.project)fail(409,'SESSION_CHANGED','Registration changed; reread it before reconciling location.');
  const location={...payload,requestId,source:'operator_confirmed',confirmedAt:now(),previousMachine:row.machine};
  const details=JSON.stringify({...previous,nativeLocation:location});
  // Guard custody and invitation scope at the actual write. Claims, task,
  // status, history, checkpoint and last_seen_at are deliberately preserved.
  const results=await db.batch([
    db.prepare(`UPDATE sessions SET machine=?,details_json=?,revision=revision+1 WHERE id=? AND principal_id=? AND revision=? AND last_seen_at=? AND machine=? AND external_id=? AND project=? AND archived_at IS NULL AND details_json=? AND NOT EXISTS(SELECT 1 FROM observer_sessions WHERE session_id=sessions.id) AND EXISTS(SELECT 1 FROM principals WHERE id=? AND active=1 AND access_profile='agent' AND coordinator_access=0 AND EXISTS(SELECT 1 FROM json_each(projects_json) WHERE value=?))`).bind(machine,details,row.id,principal.id,row.revision,row.last_seen_at,row.machine,row.external_id,row.project,row.details_json,principal.id,row.project),
    audit(db,principal,'session.location.confirmed',`${row.id}:${requestId}`,true),
  ]);
  await requireCurrent(db,principal);
  if(!results[0].meta.changes)fail(409,'SESSION_CHANGED','Custody, invitation, observer binding or registration changed; no location was moved.');
  return json({session:sessionView(await sessionById(db,row.id,principal,true),principal,aliases),reused:false});
}
