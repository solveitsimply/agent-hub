import {lifecycleView,parseCheckpoint,sendCheckIn,reconcile} from './lifecycle.mjs';

export async function lifecycleApi(ctx) {
  const {path,method,url,db,principal,readBody,fail,string,checkKeys,ownerOnly,sessionById,requireActive,requireCurrent,digest,json,sessionView,aliases,select}=ctx;
  const helpers={fail,string,checkKeys,digest};
  const match=path.match(/^\/api\/sessions\/([^/]+)\/(checkpoint|closeout|accountability-policy|check-in)$/);
  if(match){
    const operation=match[2],own=['checkpoint','closeout'].includes(operation);
    const row=await sessionById(db,match[1],principal,own);
    if(method==='GET')return json({lifecycle:lifecycleView(row)});
    if(!['POST','PUT'].includes(method))return null;
    requireActive(row);const body=await readBody();
    if(operation==='check-in'){
      ownerOnly(principal);checkKeys(body,['expectedRevision']);
      if(body.expectedRevision!==row.revision)fail(409,'SESSION_CHANGED','Read the latest checkpoint before sending a check-in.');
      return json(await sendCheckIn(db,row,helpers),201);
    }
    if(operation==='accountability-policy'){
      ownerOnly(principal);checkKeys(body,['checkInEnabled','graceSeconds','dailyLimit','escalationSeconds']);
      if(typeof body.checkInEnabled!=='boolean')fail(422,'INVALID_POLICY','checkInEnabled must be a boolean.');
      const grace=body.graceSeconds??300,limit=body.dailyLimit??1,escalation=body.escalationSeconds??900;
      for(const [value,min,max] of [[grace,60,86400],[limit,1,3],[escalation,300,86400]])if(!Number.isInteger(value)||value<min||value>max)fail(422,'INVALID_POLICY','Policy limits are grace 60–86400s, daily messages 1–3, escalation 300–86400s.');
      await db.prepare('INSERT INTO accountability_policies(session_id,check_in_enabled,grace_seconds,daily_limit,escalation_seconds,updated_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sessions WHERE id=? AND archived_at IS NULL) ON CONFLICT(session_id) DO UPDATE SET check_in_enabled=excluded.check_in_enabled,grace_seconds=excluded.grace_seconds,daily_limit=excluded.daily_limit,escalation_seconds=excluded.escalation_seconds,updated_at=excluded.updated_at').bind(row.id,Number(body.checkInEnabled),grace,limit,escalation,new Date().toISOString(),row.id).run();
      return json({lifecycle:lifecycleView(await sessionById(db,row.id,principal))});
    }
    checkKeys(body,operation==='checkpoint'?['expectedRevision','checkpoint']:['expectedRevision','objective','workspace','nativeChat']);
    if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision!==row.revision)fail(409,'SESSION_CHANGED','Read the latest session revision and retry with the current checkpoint.');
    let serialized;
    if(operation==='checkpoint'){
      const checkpoint=parseCheckpoint(body.checkpoint,helpers);
      if(checkpoint.wait){const previous=row.checkpoint_json?JSON.parse(row.checkpoint_json):null;checkpoint.waitStartedAt=JSON.stringify(previous?.wait)===JSON.stringify(checkpoint.wait)?previous.waitStartedAt||row.checkpoint_at:new Date().toISOString();}
      if(checkpoint.wait?.sessionId){const dependency=await sessionById(db,checkpoint.wait.sessionId,principal);if(dependency.project!==row.project||dependency.id===row.id)fail(422,'INVALID_DEPENDENCY','A dependency must be another session in this project.');}
      // A message reference is an opaque pointer. Never expand other conversations.
      if(checkpoint.wait?.messageId){const message=await ctx.messageById(db,Number(checkpoint.wait.messageId),principal);if(message.project!==row.project)fail(403,'PROJECT_MISMATCH','The message is outside this project.');}
      serialized=JSON.stringify(checkpoint);
    } else {
      if(row.status!=='DONE')fail(409,'SESSION_NOT_DONE','Verify and report DONE before recording closeout.');
      const result={};
      for(const [key,states] of [['objective',['verified','failed']],['workspace',['complete','retained','failed','not_applicable']],['nativeChat',['archived','retained','failed','not_applicable']]]){
        const value=body[key];if(!value||typeof value!=='object'||Array.isArray(value))fail(422,'INVALID_CLOSEOUT',`${key} needs state and evidence.`);
        checkKeys(value,['state','evidence','revisitAt']);if(!states.includes(value.state))fail(422,'INVALID_CLOSEOUT',`Unsupported ${key} state.`);
        result[key]={state:value.state,evidence:string(value.evidence,`${key}.evidence`,1000)};
        if(value.state==='retained')result[key].revisitAt=string(value.revisitAt,`${key}.revisitAt`,512);
      }
      serialized=JSON.stringify(result);
    }
    const date=new Date().toISOString(),column=operation==='checkpoint'?'checkpoint_json':'closeout_json';
    const result=await db.prepare(`UPDATE sessions SET ${column}=?,revision=revision+1,last_seen_at=?${operation==='checkpoint'?',checkpoint_at=?':''} WHERE id=? AND principal_id=? AND revision=? AND archived_at IS NULL AND EXISTS(SELECT 1 FROM principals WHERE id=? AND active=1)${operation==='closeout'?" AND status='DONE'":''}`).bind(serialized,date,...(operation==='checkpoint'?[date]:[]),row.id,principal.id,body.expectedRevision,principal.id).run();
    await requireCurrent(db,principal);if(!result.meta.changes)fail(409,'SESSION_CHANGED','Session custody or revision changed; reread before updating.');
    await db.prepare('UPDATE session_check_ins SET resolved_at=COALESCE(resolved_at,?) WHERE session_id=? AND revision<?').bind(date,row.id,row.revision+1).run();
    return json({session:sessionView(await sessionById(db,row.id,principal,true),principal,aliases)});
  }
  if(path==='/api/reconcile'&&method==='POST'){
    ownerOnly(principal);checkKeys(await readBody(),[]);return json(await reconcile(db,select,helpers));
  }
  if(path==='/api/observers'&&method==='GET'){
    ownerOnly(principal);const rows=await db.prepare('SELECT id,name,active,created_at,expires_at FROM observers ORDER BY created_at DESC LIMIT 100').all();return json({observers:rows.results});
  }
  if(path==='/api/observers'&&method==='POST'){
    ownerOnly(principal);const body=await readBody();checkKeys(body,['name','sessions','expiresInDays']);
    if(!Array.isArray(body.sessions)||body.sessions.length<1||body.sessions.length>20)fail(422,'INVALID_OBSERVER','Choose 1–20 exact session/native ID mappings.');
    const days=body.expiresInDays??7;if(!Number.isInteger(days)||days<1||days>30)fail(422,'INVALID_OBSERVER','Observer credentials expire in 1–30 days.');
    const mappings=[];
    for(const mapping of body.sessions){if(!mapping||typeof mapping!=='object'||Array.isArray(mapping))fail(422,'INVALID_OBSERVER','Each mapping must name sessionId and nativeId.');checkKeys(mapping,['sessionId','nativeId']);const row=await sessionById(db,mapping.sessionId,principal);requireActive(row);mappings.push({sessionId:row.id,nativeId:string(mapping.nativeId,'nativeId',160)});}
    if(new Set(mappings.map(x=>x.sessionId)).size!==mappings.length||new Set(mappings.map(x=>x.nativeId)).size!==mappings.length)fail(422,'INVALID_OBSERVER','Mappings must be unique.');
    const id=crypto.randomUUID(),date=new Date().toISOString(),expires=new Date(Date.now()+days*86400000).toISOString(),name=string(body.name,'name',120);
    const token='hub_observer_'+Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
    if(await db.prepare('SELECT COUNT(*) AS n FROM observers').first('n')>=100)fail(409,'OBSERVER_CAPACITY','Revoke/reuse an existing observer; at most 100 records are supported.');
    for(const mapping of mappings)if(await db.prepare('SELECT 1 FROM observer_sessions os JOIN observers o ON o.id=os.observer_id WHERE session_id=? AND o.active=1 AND o.expires_at>?').bind(mapping.sessionId,date).first())fail(409,'OBSERVER_EXISTS','Revoke the existing observer before replacing its mapping.');
    await db.batch([
      db.prepare('INSERT INTO observers(id,name,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)').bind(id,name,await digest(token),date,expires),
      ...mappings.map(mapping=>db.prepare(`INSERT INTO observer_sessions(session_id,observer_id,native_id) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM sessions s JOIN principals p ON p.id=s.principal_id WHERE s.id=? AND s.archived_at IS NULL AND p.active=1) ON CONFLICT(session_id) DO UPDATE SET observer_id=excluded.observer_id,native_id=excluded.native_id,sequence=-1,state=NULL,goal_state=NULL,observed_at=NULL,received_at=NULL WHERE NOT EXISTS(SELECT 1 FROM observers o WHERE o.id=observer_sessions.observer_id AND o.active=1 AND o.expires_at>?)`).bind(mapping.sessionId,id,mapping.nativeId,mapping.sessionId,date)),
    ]);
    const count=await db.prepare('SELECT COUNT(*) AS n FROM observer_sessions WHERE observer_id=?').bind(id).first('n');
    if(count!==mappings.length){await db.prepare('UPDATE observers SET active=0 WHERE id=?').bind(id).run();fail(409,'OBSERVER_CHANGED','Session/observer custody changed. No usable credential was issued.');}
    return json({observer:{id,name,expiresAt:expires,capabilities:['observe'],sessions:mappings},token},201);
  }
  const observerMatch=path.match(/^\/api\/observers\/([^/]+)$/);
  if(observerMatch&&method==='DELETE'){ownerOnly(principal);checkKeys(await readBody(),[]);await db.prepare('UPDATE observers SET active=0 WHERE id=?').bind(observerMatch[1]).run();return json({revoked:true});}
  return null;
}

export async function observerApi({request,db,path,method,readBody,digest,fail,checkKeys,string,json}) {
  const token=request.headers.get('authorization')?.slice(7),date=new Date().toISOString();
  const observer=await db.prepare('SELECT id FROM observers WHERE token_hash=? AND active=1 AND expires_at>?').bind(await digest(token??''),date).first();
  if(!observer)fail(401,'UNAUTHORIZED','Observer credential is expired, revoked or invalid.');
  if(path==='/api/observer'&&method==='GET'){
    const rows=await db.prepare(`SELECT os.session_id AS sessionId,os.native_id AS nativeId,os.sequence FROM observer_sessions os JOIN sessions s ON s.id=os.session_id JOIN principals p ON p.id=s.principal_id WHERE os.observer_id=? AND s.archived_at IS NULL AND p.active=1`).bind(observer.id).all();
    return json({observerId:observer.id,capabilities:['observe'],sessions:rows.results});
  }
  if(path!=='/api/observer/observations'||method!=='POST')fail(403,'OBSERVER_SCOPE','Observer credentials can only report native state for their exact mappings.');
  const body=await readBody();checkKeys(body,['sessionId','nativeId','sequence','state','goalState','observedAt']);
  const sessionId=string(body.sessionId,'sessionId',80),nativeId=string(body.nativeId,'nativeId',160);
  if(!Number.isSafeInteger(body.sequence)||body.sequence<0)fail(422,'INVALID_OBSERVATION','sequence must be a nonnegative integer.');
  if(!['active','idle','waiting_user','not_loaded','offline','archived','missing'].includes(body.state))fail(422,'INVALID_OBSERVATION','Unsupported native state.');
  if(body.goalState!==undefined && body.goalState!==null && !['active','complete','paused','budget_limited','failed'].includes(body.goalState))fail(422,'INVALID_OBSERVATION','Unsupported native goal state.');
  const observedAt=string(body.observedAt,'observedAt',36),time=Date.parse(observedAt);
  if(!Number.isFinite(time)||!observedAt.endsWith('Z')||time>Date.now()+10000||time<Date.now()-180000)fail(422,'INVALID_OBSERVATION','Report a UTC observation from the last three minutes; future observations are rejected.');
  const result=await db.prepare(`UPDATE observer_sessions SET sequence=?,state=?,goal_state=?,observed_at=?,received_at=? WHERE observer_id=? AND session_id=? AND native_id=? AND sequence<? AND (observed_at IS NULL OR observed_at<=?) AND EXISTS(SELECT 1 FROM observers WHERE id=? AND active=1 AND expires_at>?) AND EXISTS(SELECT 1 FROM sessions s JOIN principals p ON p.id=s.principal_id WHERE s.id=? AND s.archived_at IS NULL AND p.active=1)`).bind(body.sequence,body.state,body.goalState??null,new Date(time).toISOString(),date,observer.id,sessionId,nativeId,body.sequence,new Date(time).toISOString(),observer.id,date,sessionId).run();
  if(!result.meta.changes)fail(409,'OBSERVATION_CHANGED','Mapping, invitation or sequence changed; reread the observer manifest.');
  return json({recorded:true});
}
