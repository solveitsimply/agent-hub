import {hasCoordinationSchema,messageAdmission,messagePolicy} from './coordination-capacity.mjs';

// Agent progress, native presence and human attention are independent evidence.
export const ATTENTION = ['WAITING_USER','READY','RECONCILE','WAITING','WORKING','PAUSED','CLEANUP','COMPLETE'];
const parse = value => value ? JSON.parse(value) : null;
const age = (value, time) => value ? Math.max(0, time - Date.parse(value)) : Infinity;
export function lifecycleView(row, time = Date.now()) {
  const checkpoint = parse(row.checkpoint_json), closeout = parse(row.closeout_json);
  const observation = parse(row.observation_json), policy = parse(row.policy_json);
  const checkIn = parse(row.check_in_json);
  const coverage = !observation ? 'not_configured' : !observation.active || Date.parse(observation.expiresAt) <= time ? 'revoked'
    : observation.state === 'offline' || age(observation.observedAt,time) > 180000 ? 'offline' : 'available';
  const native = coverage === 'available' ? observation.state : 'unknown';
  const overdue = Boolean(checkpoint?.nextCheckAt && time > Date.parse(checkpoint.nextCheckAt) + (policy?.graceSeconds ?? 300)*1000);
  const dependency = parse(row.dependency_json);
  const dependencyReady = Boolean(checkpoint?.wait?.kind === 'agent' && dependency?.status === 'DONE');
  const wait = checkpoint?.wait;
  const accountable = Boolean(checkpoint && (checkpoint.nextAction || (wait?.reason && checkpoint.nextCheckAt)));
  let attention, reason;
  if (row.status === 'DONE') {
    const closed = closeout?.objective?.state === 'verified' && row.held_claims === 0
      && ['complete','retained','not_applicable'].includes(closeout?.workspace?.state)
      && ['archived','retained','not_applicable'].includes(closeout?.nativeChat?.state);
    attention = closed ? 'COMPLETE' : 'CLEANUP'; reason = closed ? 'Completion reported; closeout recorded' : 'Completion reported; verify closeout';
  } else if (row.status === 'WAITING_ON_USER' || wait?.kind === 'user' || native === 'waiting_user') {
    attention = 'WAITING_USER'; reason = wait?.reason || 'Human decision needed; see the original chat';
  } else if (checkpoint?.pauseReason || ['paused','budget_limited','failed'].includes(observation?.goalState)) {
    attention = 'PAUSED'; reason = checkpoint?.pauseReason || `Native goal ${observation.goalState}`;
  } else if (native === 'active') {
    attention = 'WORKING'; reason = overdue ? 'Native execution observed; progress checkpoint overdue' : 'Native execution observed';
  } else if (native === 'idle' && checkpoint?.nextAction && (!wait || dependencyReady)) {
    attention = 'READY'; reason = dependencyReady ? 'Dependency completed; next action available' : 'Native chat idle; next action available';
  } else if (wait && !overdue && accountable) {
    attention = 'WAITING'; reason = wait.reason;
  } else if (overdue || !accountable || coverage === 'offline' || native === 'not_loaded' || native === 'archived' || native === 'missing') {
    attention = 'RECONCILE'; reason = overdue ? 'Expected checkpoint missed' : !accountable ? 'No structured next action recorded' : 'Native execution needs reconciliation';
  } else { attention = 'WORKING'; reason = 'Reported running; execution unverified'; }
  const unaccounted = row.status !== 'DONE' && native !== 'active' && (!accountable || overdue);
  const checkInState = !checkIn ? null : checkIn.resolvedAt ? 'resolved' : checkIn.revision !== row.revision ? 'superseded'
    : checkIn.acknowledgedAt ? 'acknowledged' : coverage === 'available' && time > Date.parse(checkIn.createdAt) + (policy?.escalationSeconds ?? 900)*1000 ? 'escalated' : 'delivered';
  return {revision:row.revision, checkpoint, checkpointAt:row.checkpoint_at, closeout, observation, coverage,
    attention, reason, overdue, unaccounted, unaccountedSince:unaccounted ? checkpoint?.nextCheckAt || row.created_at : null,
    heldClaims:row.held_claims ?? 0, dependency, policy:policy ?? {checkInEnabled:false,graceSeconds:300,dailyLimit:1,escalationSeconds:900},
    checkIn:checkIn ? {...checkIn,state:checkInState} : null,
    canCheckIn:attention === 'RECONCILE' && native !== 'active' && coverage !== 'offline' && coverage !== 'revoked' && (!checkIn || checkIn.revision!==row.revision) && (checkpoint ? overdue : age(row.last_seen_at,time)>180000),
    continuation:{enabled:false,reason:'Read-only observation. Continue in the native chat; bounded native execution is not enrolled.'}};
}

export const LIFECYCLE_COLUMNS = `,
 (SELECT json_object('observerId',o.id,'source',o.name,'nativeId',os.native_id,'active',o.active,'expiresAt',o.expires_at,'sequence',os.sequence,'state',os.state,'goalState',os.goal_state,'observedAt',os.observed_at,'receivedAt',os.received_at) FROM observer_sessions os JOIN observers o ON o.id=os.observer_id WHERE os.session_id=s.id) AS observation_json,
 (SELECT json_object('checkInEnabled',ap.check_in_enabled,'graceSeconds',ap.grace_seconds,'dailyLimit',ap.daily_limit,'escalationSeconds',ap.escalation_seconds) FROM accountability_policies ap WHERE ap.session_id=s.id) AS policy_json,
 (SELECT json_object('revision',ci.revision,'messageId',ci.message_id,'createdAt',ci.created_at,'resolvedAt',ci.resolved_at,'acknowledgedAt',m.acknowledged_at) FROM session_check_ins ci LEFT JOIN messages m ON m.id=ci.message_id WHERE ci.session_id=s.id ORDER BY ci.revision DESC LIMIT 1) AS check_in_json,
 (SELECT COUNT(*) FROM ownership WHERE owner_session_id=s.id) AS held_claims,
 (SELECT json_object('sessionId',d.id,'label',d.label,'status',d.status,'machine',d.machine,'agentName',(SELECT json_extract(a.metadata_json,'$.client') FROM session_attribution_segments a WHERE a.session_id=d.id ORDER BY a.id DESC LIMIT 1)) FROM sessions d WHERE d.id=json_extract(s.checkpoint_json,'$.wait.sessionId') AND d.project=s.project) AS dependency_json`;

export function parseCheckpoint(value, {fail,checkKeys,string}, time=Date.now()) {
  if(!value || typeof value !== 'object' || Array.isArray(value))fail(422,'INVALID_CHECKPOINT','Provide a structured checkpoint.');
  checkKeys(value,['outcome','acceptanceCriteria','nextAction','lastProgressAt','nextCheckAt','wait','pauseReason','completionEvidence','presenceIntervalSeconds']);
  const output={outcome:string(value.outcome,'outcome',1000),acceptanceCriteria:string(value.acceptanceCriteria,'acceptanceCriteria',1500)};
  for(const key of ['nextAction','pauseReason'])if(value[key]!==undefined)output[key]=string(value[key],key,1000,true);
  for(const key of ['lastProgressAt','nextCheckAt'])if(value[key]!==undefined && value[key]!==null){
    if(typeof value[key]!=='string'||!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value[key])||!Number.isFinite(Date.parse(value[key])))fail(422,'INVALID_CHECKPOINT',`${key} must be a UTC timestamp.`);
    if(key==='lastProgressAt' && Date.parse(value[key])>time+60000)fail(422,'INVALID_CHECKPOINT','Progress cannot be in the future.');
    output[key]=new Date(value[key]).toISOString();
  }
  if(value.wait!==undefined && value.wait!==null){
    const wait=value.wait;if(typeof wait!=='object'||Array.isArray(wait))fail(422,'INVALID_CHECKPOINT','wait must be an object.');
    checkKeys(wait,['kind','reason','sessionId','messageId','runId','expectedEvent']);
    if(!['user','agent','external','scheduled'].includes(wait.kind))fail(422,'INVALID_CHECKPOINT','Choose a supported wait kind.');
    output.wait={kind:wait.kind,reason:string(wait.reason,'wait.reason',1000)};
    for(const key of ['sessionId','messageId','runId','expectedEvent'])if(wait[key]!==undefined)output.wait[key]=string(wait[key],`wait.${key}`,key==='expectedEvent'?1000:160);
    if(!output.nextCheckAt)fail(422,'INVALID_CHECKPOINT','A wait needs a nextCheckAt, including user waits. This schedules reconciliation, not a wakeup.');
  }
  if(value.presenceIntervalSeconds!==undefined){
    if(!Number.isInteger(value.presenceIntervalSeconds)||value.presenceIntervalSeconds<30||value.presenceIntervalSeconds>3600)fail(422,'INVALID_CHECKPOINT','Presence interval must be 30–3600 seconds, only if supported by this client.');
    output.presenceIntervalSeconds=value.presenceIntervalSeconds;
  }
  if(value.completionEvidence!==undefined){
    if(!Array.isArray(value.completionEvidence)||value.completionEvidence.length>12)fail(422,'INVALID_CHECKPOINT','Provide at most twelve completion evidence references.');
    output.completionEvidence=value.completionEvidence.map(item=>string(item,'completion evidence reference',512));
  }
  if(!output.nextAction && !output.wait && !output.pauseReason && !output.completionEvidence?.length)fail(422,'INVALID_CHECKPOINT','Record a next action, wait, pause or completion evidence.');
  return output;
}

// A one-message episode survives retries, cron overlap, archive/revocation races,
// and retention of the message. No timer changes status, claims or native state.
export async function sendCheckIn(db,row,{digest,fail,messageLimits},time=Date.now(),automatic=false) {
  const view=lifecycleView(row,time);
  if(view.checkIn?.revision===row.revision)return {messageId:view.checkIn.messageId,state:view.checkIn.state,reused:true};
  if(!view.canCheckIn)fail(409,'CHECK_IN_SUPPRESSED','Reconcile current execution, wait or observer availability before asking again.');
  const date=new Date(time).toISOString(),since=new Date(time-86400000).toISOString();
  const opening=view.checkpoint?.nextCheckAt ? `The Hub has not received the checkpoint expected at ${view.checkpoint.nextCheckAt}.` : 'This session has not recorded an accountable next-action checkpoint.';
  const body=`${opening} Report whether your objective is complete, executing, awaiting a specific person/event, paused, or blocked. If unfinished, record the next action and next check time using hub_record_checkpoint. Preserve current work and approval boundaries. This coordination check-in does not start a native turn.`;
  const key=`accountability:${row.id}:${row.revision}`,hash=await digest(body);
  // Validate the same revision and absence of fresh active/offline/approval state
  // at the write boundary. A new observation invalidates the initial decision.
  const valid=`s.id=? AND s.revision=? AND s.archived_at IS NULL AND s.status NOT IN ('DONE','WAITING_ON_USER') AND EXISTS(SELECT 1 FROM principals p WHERE p.id=s.principal_id AND p.active=1) AND NOT EXISTS(SELECT 1 FROM observer_sessions os JOIN observers o ON o.id=os.observer_id WHERE os.session_id=s.id AND (o.active=0 OR o.expires_at<=? OR os.observed_at IS NULL OR os.observed_at<? OR os.state IN ('active','waiting_user','offline') OR os.goal_state IN ('paused','budget_limited','failed'))) AND NOT EXISTS(SELECT 1 FROM session_check_ins ci WHERE ci.session_id=s.id AND ci.revision=s.revision) AND (SELECT COUNT(*) FROM session_check_ins ci WHERE ci.session_id=s.id AND ci.created_at>=?)<COALESCE((SELECT daily_limit FROM accountability_policies WHERE session_id=s.id),1)${automatic?' AND EXISTS(SELECT 1 FROM accountability_policies WHERE session_id=s.id AND check_in_enabled=1)':''}`;
  const values=[row.id,row.revision,date,new Date(time-180000).toISOString(),since];
  const admission=await hasCoordinationSchema(db)?messageAdmission(messageLimits?messageLimits():messagePolicy({},fail),date,'hub-accountability',null,new TextEncoder().encode(body).byteLength):{sql:'(SELECT COUNT(*) FROM messages)<10000 AND (SELECT COUNT(*) FROM messages WHERE created_at>=?)<5000',values:[since]};
  await db.batch([
    db.prepare(`INSERT INTO messages(from_principal_id,to_principal_id,from_session_id,to_session_id,project,kind,body,idempotency_key,payload_hash,created_at,review_state) SELECT 'hub-accountability',s.principal_id,NULL,s.id,s.project,'QUESTION',?,?,?,?, 'APPROVED' FROM sessions s WHERE ${valid} AND ${admission.sql} ON CONFLICT(from_principal_id,idempotency_key) DO NOTHING`).bind(body,key,hash,date,...values,...admission.values),
    db.prepare(`INSERT INTO message_deliveries(message_id) SELECT id FROM messages WHERE from_principal_id='hub-accountability' AND idempotency_key=? ON CONFLICT(message_id) DO NOTHING`).bind(key),
    db.prepare(`UPDATE messages SET delivery_id=(SELECT id FROM message_deliveries WHERE message_id=messages.id) WHERE from_principal_id='hub-accountability' AND idempotency_key=?`).bind(key),
    db.prepare(`INSERT INTO session_check_ins(session_id,revision,message_id,created_at) SELECT to_session_id,?,id,created_at FROM messages WHERE from_principal_id='hub-accountability' AND idempotency_key=? ON CONFLICT(session_id,revision) DO NOTHING`).bind(row.revision,key),
  ]);
  const result=await db.prepare('SELECT message_id FROM session_check_ins WHERE session_id=? AND revision=?').bind(row.id,row.revision).first();
  if(!result)fail(409,'CHECK_IN_CHANGED','Session state changed or the daily check-in limit was reached.');
  return {messageId:result.message_id,state:'delivered',reused:false};
}

export async function reconcile(db,select,helpers,time=Date.now()) {
  const rows=await db.prepare(select+` JOIN accountability_policies enrolled_ap ON enrolled_ap.session_id=s.id AND enrolled_ap.check_in_enabled=1 WHERE s.archived_at IS NULL AND s.status!='DONE' AND p.active=1 AND (SELECT COUNT(*) FROM session_check_ins ci WHERE ci.session_id=s.id AND ci.created_at>=?)<enrolled_ap.daily_limit ORDER BY s.created_at LIMIT 2000`).bind(new Date(time-86400000).toISOString()).all();
  let delivered=0,suppressed=0;
  for(const row of rows.results){if(!lifecycleView(row,time).canCheckIn){suppressed++;continue;}
    try {await sendCheckIn(db,row,helpers,time,true);delivered++;} catch(error){if(error.status===409)suppressed++;else throw error;}
    if(delivered>=100)break;
  }
  return {delivered,suppressed};
}
