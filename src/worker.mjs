import { parseAttribution, attributionView } from './attribution.mjs';
const STATUSES = new Set(['RUNNING','WAITING_ON_USER','WAITING_ON_AGENT','BLOCKED','DONE']);
const KINDS = new Set(['NOTE','HANDOFF','QUESTION','ANSWER']);
const encoder = new TextEncoder();
const headers = {
  'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
class HttpError extends Error { constructor(status,code,message){super(message);this.status=status;this.code=code;} }
const fail = (status,code,message)=>{throw new HttpError(status,code,message);};
const json = (data,status=200)=>Response.json(data,{status,headers});
const now = ()=>new Date().toISOString();
const digest = async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
const equal = (a,b)=>{let difference=a.length^b.length;for(let i=0;i<64;i++)difference|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return difference===0;};
const string = (value,name,max=256,optional=false)=>{
  if(optional && (value===undefined||value===null))return null;
  if(typeof value!=='string'||!value.trim()||value.length>max)fail(422,'INVALID_FIELD',`${name} must be a nonempty string of at most ${max} characters.`);
  return value.trim();
};
const slug = value=>{const result=string(value,'project',64);if(!/^[a-z0-9][a-z0-9-]*$/.test(result))fail(422,'INVALID_PROJECT','Use a lowercase project slug.');return result;};
const checkKeys = (body,keys)=>{for(const key of Object.keys(body))if(!keys.includes(key))fail(422,'UNKNOWN_FIELD',`Unsupported field: ${key}`);};
const mayProject = (principal,project)=>principal.role==='owner'||principal.projects.includes(project);
const requireProject = (principal,project)=>{if(!mayProject(principal,project))fail(403,'PROJECT_DENIED','This invitation does not include that project.');};
const ownerOnly = principal=>{if(principal.role!=='owner')fail(403,'OWNER_REQUIRED','Only the workspace owner can manage invitations.');};
const noSecrets = value=>{
  if(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[\w.+/=~-]{16,}|\b(?:hub_agent_|hub_owner_)[A-Za-z0-9_-]{20,}|\b(?:sk-|AIza)[A-Za-z0-9_-]{20,}|\b(?:password|api[_ -]?key|access[_ -]?token|verification[_ -]?code|step[_ -]?up[_ -]?code)\s*[=:]\s*["']?\S{4,}/i.test(value))
    fail(422,'SECRET_DETECTED','Remove credentials or verification codes before sharing coordination content.');
};
async function bodyOf(request){
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))fail(415,'JSON_REQUIRED','Use application/json.');
  const reader=request.body?.getReader();let size=0;const chunks=[];
  if(reader){while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();fail(413,'BODY_TOO_LARGE','Coordination bodies are limited to 16 KiB.');}chunks.push(value);}}
  const data=new Uint8Array(size);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
  let body;try{body=JSON.parse(new TextDecoder().decode(data));}catch{fail(400,'INVALID_JSON','Provide a JSON object.');}
  if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'INVALID_JSON','Provide a JSON object.');
  noSecrets(JSON.stringify(body));return body;
}
function detailsOf(value){
  if(value===undefined)return {};
  if(!value||typeof value!=='object'||Array.isArray(value))fail(422,'INVALID_DETAILS','details must be an object.');
  checkKeys(value,['releaseRequestId','selectedCommit','nativeBuildStatus','migrationState','recoveryBoundary','evidence']);
  const output={};for(const key of ['releaseRequestId','selectedCommit','nativeBuildStatus','migrationState','recoveryBoundary']){
    if(value[key]!==undefined){output[key]=string(value[key],key,1536,true);if(key==='selectedCommit'&&output[key]&&!/^[a-f0-9]{40}$/.test(output[key]))fail(422,'INVALID_COMMIT','selectedCommit must be an immutable 40-character Git SHA.');}
  }
  if(value.evidence!==undefined){
    if(!Array.isArray(value.evidence)||value.evidence.length>12)fail(422,'INVALID_EVIDENCE','Provide at most 12 scoped evidence claims.');
    output.evidence=value.evidence.map(item=>{
      if(!item||typeof item!=='object'||Array.isArray(item))fail(422,'INVALID_EVIDENCE','Each evidence claim must be an object.');
      checkKeys(item,['kind','value','observedAt','scope']);const observedAt=string(item.observedAt,'observedAt',36);
      if(!/^\d{4}-\d{2}-\d{2}T/.test(observedAt)||Number.isNaN(Date.parse(observedAt)))fail(422,'INVALID_EVIDENCE','Evidence needs a UTC timestamp.');
      return {kind:string(item.kind,'kind',64),value:string(item.value,'value',1024),observedAt,scope:string(item.scope,'scope',256)};
    });
  }
  if(JSON.stringify(output).length>6000)fail(422,'INVALID_DETAILS','Release details exceed 6000 characters.');return output;
}
const principalView = row=>({id:row.id,name:row.name,account:row.account,role:row.role,projects:JSON.parse(row.projects_json),active:row.active===1});
async function authenticate(request,env,db){
  if(typeof env.OWNER_TOKEN!=='string'||env.OWNER_TOKEN.length<32)fail(503,'NOT_CONFIGURED','Owner authentication is not configured.');
  const authorization=request.headers.get('authorization');
  if(!authorization?.startsWith('Bearer ')||authorization.length>520)fail(401,'UNAUTHORIZED','Connect with a valid workspace invitation.');
  const token=authorization.slice(7);const tokenHash=await digest(token);
  if(equal(tokenHash,await digest(env.OWNER_TOKEN)))return {id:'owner',name:'Workspace owner',account:'Owner',role:'owner',projects:['*']};
  const row=await db.prepare('SELECT id,name,account,role,projects_json,active FROM principals WHERE token_hash=? AND active=1 AND role=\'agent\'').bind(tokenHash).first();
  if(!row)fail(401,'UNAUTHORIZED','Connect with a valid workspace invitation.');return principalView(row);
}
const latestAttribution = row=>{
  if(!row.latest_attribution_json)return null;
  const {provider,client,model}=JSON.parse(row.latest_attribution_json);
  return {provider,client,model};
};
const sessionView = row=>({id:row.id,principalId:row.principal_id,principalName:row.principal_name,account:row.account,externalId:row.external_id,machine:row.machine,label:row.label,project:row.project,task:row.task,status:row.status,environment:row.environment,details:JSON.parse(row.details_json),latestAttribution:latestAttribution(row),createdAt:row.created_at,lastSeenAt:row.last_seen_at,archivedAt:row.archived_at,stale:Date.now()-Date.parse(row.last_seen_at)>180000});
const SESSION_FROM=' FROM sessions s JOIN principals p ON p.id=s.principal_id LEFT JOIN session_attribution_segments a ON a.id=(SELECT id FROM session_attribution_segments WHERE session_id=s.id ORDER BY id DESC LIMIT 1)';
const SESSION_SELECT='SELECT s.*,p.name AS principal_name,p.account,a.metadata_json AS latest_attribution_json'+SESSION_FROM;
const sessionFilters = (url)=>{
  const clauses=[],values=[];
  for(const [name,column,max] of [['agentName',"json_extract(a.metadata_json,'$.client')",160],['agentModel',"json_extract(a.metadata_json,'$.model')",160],['machine','s.machine',120]]){
    const value=url.searchParams.get(name),unknown=url.searchParams.get(name+'Unknown');
    if(unknown!==null&&unknown!=='1')fail(422,'INVALID_FILTER',`${name}Unknown must be 1 when supplied.`);
    if(value!==null&&unknown!==null)fail(422,'INVALID_FILTER',`Choose a ${name} label or Unknown, not both.`);
    if(unknown!==null)clauses.push(`${column} IS NULL`);
    else if(value!==null){clauses.push(`${column}=?`);values.push(string(value,name,max));}
  }
  return {clauses,values};
};
async function sessionById(db,id,principal,own=false){
  const row=await db.prepare(`${SESSION_SELECT} WHERE s.id=?`).bind(string(id,'sessionId',80)).first();
  if(!row)fail(404,'SESSION_NOT_FOUND','Session not found.');requireProject(principal,row.project);
  if(own&&row.principal_id!==principal.id)fail(403,'SESSION_OWNER_REQUIRED','Only the principal owning that session can update or send from it.');return row;
}
const MESSAGE_SELECT='SELECT m.*,sender.name AS sender_name,recipient.name AS recipient_name FROM messages m JOIN principals sender ON sender.id=m.from_principal_id JOIN principals recipient ON recipient.id=m.to_principal_id';
const messageView=row=>({id:row.id,fromSessionId:row.from_session_id,toSessionId:row.to_session_id,fromPrincipalId:row.from_principal_id,toPrincipalId:row.to_principal_id,fromPrincipalName:row.sender_name,toPrincipalName:row.recipient_name,project:row.project,kind:row.kind,body:row.body,replyTo:row.reply_to,createdAt:row.created_at,acknowledgedAt:row.acknowledged_at});
const requireActive=session=>{if(session?.archived_at)fail(409,'SESSION_ARCHIVED','This session was archived; register a new session for new work.');};
const audit=(db,principal,action,id)=>db.prepare('INSERT INTO audit_events(principal_id,action,target_id,created_at) VALUES (?,?,?,?)').bind(principal.id,action,String(id),now());
async function messageById(db,id,principal){
  const row=await db.prepare(`${MESSAGE_SELECT} WHERE m.id=?`).bind(id).first();
  if(!row)fail(404,'MESSAGE_NOT_FOUND','Message not found.');requireProject(principal,row.project);
  if(principal.role!=='owner'&&![row.from_principal_id,row.to_principal_id].includes(principal.id))fail(403,'MESSAGE_DENIED','This message belongs to another conversation.');return row;
}
function numeric(value,name){const result=Number(value);if(!Number.isSafeInteger(result)||result<0)fail(422,'INVALID_CURSOR',`${name} must be a nonnegative integer.`);return result;}
async function api(request,env){
  const url=new URL(request.url);const origin=request.headers.get('origin');
  if(origin&&origin!==url.origin)fail(403,'ORIGIN_DENIED','Cross-origin coordination requests are disabled.');
  if(!env.DB)fail(503,'NOT_CONFIGURED','Coordination database is not configured.');
  const db=env.DB.withSession('first-primary');const principal=await authenticate(request,env,db);
  const path=url.pathname,method=request.method;
  if(path==='/api/me'&&method==='GET')return json({principal});
  if(path==='/api/principals'&&method==='GET'){
    ownerOnly(principal);const rows=await db.prepare('SELECT id,name,account,role,projects_json,active FROM principals ORDER BY created_at DESC LIMIT 200').all();return json({principals:rows.results.map(principalView)});
  }
  if(path==='/api/principals'&&method==='POST'){
    ownerOnly(principal);const body=await bodyOf(request);checkKeys(body,['name','account','projects']);
    if(!Array.isArray(body.projects)||body.projects.length<1||body.projects.length>20)fail(422,'INVALID_PROJECTS','Select 1 to 20 explicit project scopes.');
    const projects=[...new Set(body.projects.map(slug))];const id=crypto.randomUUID();const bytes=crypto.getRandomValues(new Uint8Array(32));const token='hub_agent_'+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
    const name=string(body.name,'name',120),account=string(body.account,'account',160);
    await db.batch([db.prepare('INSERT INTO principals(id,name,account,role,token_hash,projects_json,created_at) VALUES (?,?,?,\'agent\',?,?,?)').bind(id,name,account,await digest(token),JSON.stringify(projects),now()),audit(db,principal,'invite.created',id)]);
    return json({principal:{id,name,account,role:'agent',projects,active:true},token},201);
  }
  const principalMatch=path.match(/^\/api\/principals\/([^/]+)$/);
  if(principalMatch&&method==='DELETE'){
    ownerOnly(principal);if(principalMatch[1]==='owner')fail(403,'OWNER_IMMUTABLE','The owner cannot be revoked through invitations.');
    const result=await db.prepare('UPDATE principals SET active=0 WHERE id=? AND role=\'agent\'').bind(principalMatch[1]).run();if(!result.meta.changes)fail(404,'PRINCIPAL_NOT_FOUND','Invitation not found.');
    await audit(db,principal,'invite.revoked',principalMatch[1]).run();return json({revoked:true});
  }
  if(path==='/api/sessions'&&method==='GET'){
    const project=url.searchParams.get('project');if(project)requireProject(principal,slug(project));
    let scope=' WHERE s.archived_at IS NULL',scopeValues=[];
    if(project){scope+=' AND s.project=?';scopeValues=[project];}
    else if(principal.role!=='owner'){scope+=` AND s.project IN (${principal.projects.map(()=>'?').join(',')})`;scopeValues=principal.projects;}
    const filters=sessionFilters(url),where=scope+(filters.clauses.length?' AND '+filters.clauses.join(' AND '):''),values=[...scopeValues,...filters.values];
    const rows=await db.prepare(SESSION_SELECT+where+' ORDER BY s.last_seen_at DESC,s.id ASC LIMIT 200').bind(...values).all();
    const total=await db.prepare('SELECT COUNT(*) AS total'+SESSION_FROM+where).bind(...values).first('total');
    const options=await db.prepare("SELECT DISTINCT s.machine,json_extract(a.metadata_json,'$.client') AS agent_name,json_extract(a.metadata_json,'$.model') AS agent_model"+SESSION_FROM+scope).bind(...scopeValues).all();
    const distinct=key=>[...new Set(options.results.map(row=>row[key]??null))].sort((left,right)=>left===null?1:right===null?-1:left.localeCompare(right));
    return json({sessions:rows.results.map(sessionView),limit:200,total,filterOptions:{agentNames:distinct('agent_name'),agentModels:distinct('agent_model'),machines:distinct('machine')}});
  }
  if(path==='/api/sessions'&&method==='POST'){
    const body=await bodyOf(request);checkKeys(body,['externalId','machine','label','project','task','status','environment','details']);
    const project=slug(body.project);requireProject(principal,project);const externalId=string(body.externalId,'externalId',160),machine=string(body.machine,'machine',120);
    const status=body.status;if(!STATUSES.has(status))fail(422,'INVALID_STATUS','Select a supported session status.');
    const id=crypto.randomUUID(),date=now();
    const environment=string(body.environment,'environment',32,true);if(environment&&!['dev','staging','production','local'].includes(environment))fail(422,'INVALID_ENVIRONMENT','Use dev, staging, production or local.');
    await db.prepare('INSERT INTO sessions(id,principal_id,external_id,machine,label,project,task,status,environment,details_json,created_at,last_seen_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM sessions WHERE archived_at IS NULL AND principal_id=?)<100 AND (SELECT COUNT(*) FROM sessions WHERE archived_at IS NULL)<2000 ON CONFLICT(principal_id,external_id) DO NOTHING').bind(id,principal.id,externalId,machine,string(body.label,'label',120),project,string(body.task,'task',2000),status,environment,JSON.stringify(detailsOf(body.details)),date,date,principal.id).run();
    const row=await db.prepare(`${SESSION_SELECT} WHERE s.principal_id=? AND s.external_id=?`).bind(principal.id,externalId).first();
    if(!row)fail(409,'SESSION_CAPACITY','Active-session capacity reached (100 per principal or 2000 workspace-wide). Archive an owned completed session first.');
    if(row.machine!==machine||row.project!==project)fail(409,'SESSION_IDENTITY_CONFLICT','That external session already belongs to a different machine or project.');
    if(row.id===id)await audit(db,principal,'session.registered',id).run();return json({session:sessionView(row)},row.id===id?201:200);
  }
  const attributionMatch=path.match(/^\/api\/sessions\/([^/]+)\/attribution$/);
  if(attributionMatch&&['GET','POST'].includes(method)){
    const session=await sessionById(db,attributionMatch[1],principal,method==='POST');
    if(method==='GET'){
      const after=numeric(url.searchParams.get('after')??0,'after');
      const rows=await db.prepare('SELECT * FROM (SELECT *,COALESCE(LEAD(started_at) OVER (ORDER BY id),?) AS ended_at FROM session_attribution_segments WHERE session_id=?) WHERE id>? ORDER BY id LIMIT 201').bind(session.archived_at,session.id,after).all();
      const page=rows.results.slice(0,200);
      return json({segments:page.map(attributionView),nextCursor:rows.results.length>200?page.at(-1).id:null,limit:200});
    }
    requireActive(session);
    const body=await bodyOf(request),parsed=parseAttribution(body,fail);
    const payloadHash=await digest(JSON.stringify({metadata:parsed.metadata,previousSegmentId:parsed.previousSegmentId}));
    await db.prepare('INSERT INTO session_attribution_segments(session_id,principal_id,idempotency_key,payload_hash,metadata_json,started_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sessions WHERE id=? AND principal_id=? AND archived_at IS NULL) AND (SELECT MAX(id) FROM session_attribution_segments WHERE session_id=?) IS ? AND (SELECT COUNT(*) FROM session_attribution_segments WHERE session_id=?)<10000 ON CONFLICT(session_id,idempotency_key) DO NOTHING').bind(session.id,principal.id,parsed.idempotencyKey,payloadHash,JSON.stringify(parsed.metadata),now(),session.id,principal.id,session.id,parsed.previousSegmentId,session.id).run();
    const row=await db.prepare('SELECT * FROM (SELECT *,LEAD(started_at) OVER (ORDER BY id) AS ended_at FROM session_attribution_segments WHERE session_id=?) WHERE idempotency_key=?').bind(session.id,parsed.idempotencyKey).first();
    if(!row)fail(409,'ATTRIBUTION_CHANGED','Session or attribution changed, or the history limit was reached. Read the current history before recording a new change.');
    if(row.payload_hash!==payloadHash)fail(409,'IDEMPOTENCY_CONFLICT','That idempotency key already records different attribution.');
    return json({segment:attributionView(row)},201);
  }
  const archiveMatch=path.match(/^\/api\/sessions\/([^/]+)\/archive$/);
  if(archiveMatch&&method==='POST'){
    const body=await bodyOf(request);checkKeys(body,[]);const row=await sessionById(db,archiveMatch[1],principal,true);
    if(row.archived_at)return json({session:sessionView(row)});
    if(row.status!=='DONE')fail(409,'SESSION_NOT_DONE','Only a completed session may be archived.');
    const held=await db.prepare('SELECT 1 FROM ownership WHERE owner_session_id=? LIMIT 1').bind(row.id).first();if(held)fail(409,'OWNERSHIP_HELD','Release this session’s coordination claims before archiving.');
    await db.batch([db.prepare('UPDATE sessions SET archived_at=? WHERE id=? AND principal_id=? AND status=\'DONE\' AND NOT EXISTS(SELECT 1 FROM ownership WHERE owner_session_id=?)').bind(now(),row.id,principal.id,row.id),audit(db,principal,'session.archive.requested',row.id)]);
    const current=await sessionById(db,row.id,principal,true);if(!current.archived_at)fail(409,'OWNERSHIP_HELD','Session custody changed; recheck its claims before archiving.');return json({session:sessionView(current)});
  }
  const sessionMatch=path.match(/^\/api\/sessions\/([^/]+)(\/heartbeat)?$/);
  if(sessionMatch&&((method==='POST'&&sessionMatch[2])||(method==='PATCH'&&!sessionMatch[2]))){
    const row=await sessionById(db,sessionMatch[1],principal,true);requireActive(row);const body=await bodyOf(request);
    if(sessionMatch[2]){checkKeys(body,[]);await db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=? AND principal_id=? AND archived_at IS NULL').bind(now(),row.id,principal.id).run();}
    else{
      checkKeys(body,['label','status','task','details']);const status=body.status??row.status;if(!STATUSES.has(status))fail(422,'INVALID_STATUS','Select a supported session status.');
      const label=body.label===undefined?row.label:string(body.label,'label',120);
      const task=body.task===undefined?row.task:string(body.task,'task',2000);const details=body.details===undefined?row.details_json:JSON.stringify(detailsOf(body.details));
      await db.batch([db.prepare('UPDATE sessions SET status=?,task=?,label=?,details_json=?,last_seen_at=? WHERE id=? AND principal_id=? AND archived_at IS NULL').bind(status,task,label,details,now(),row.id,principal.id),audit(db,principal,'session.updated',row.id)]);
    }
    const current=await sessionById(db,row.id,principal,true);requireActive(current);return json({session:sessionView(current)});
  }
  if(path==='/api/messages'&&method==='POST'){
    const body=await bodyOf(request);checkKeys(body,['fromSessionId','toSessionId','project','kind','body','idempotencyKey','replyTo']);const project=slug(body.project);requireProject(principal,project);
    if(!KINDS.has(body.kind))fail(422,'INVALID_KIND','Select a supported message kind.');
    const from=body.fromSessionId?await sessionById(db,body.fromSessionId,principal,true):null;if(!from&&principal.role!=='owner')fail(403,'SENDER_REQUIRED','An agent must send from its own registered session.');
    const to=body.toSessionId?await sessionById(db,body.toSessionId,principal):null;requireActive(from);requireActive(to);
    if(!to&&body.kind!=='QUESTION')fail(422,'RECIPIENT_REQUIRED','Only a question can be addressed directly to the workspace owner.');
    if(!from&&!to)fail(422,'RECIPIENT_REQUIRED','Select a recipient session.');
    if((from&&from.project!==project)||(to&&to.project!==project))fail(403,'PROJECT_MISMATCH','Sender and recipient must both belong to the selected project.');
    const recipient=to?.principal_id??'owner';
    const replyTo=body.replyTo===undefined||body.replyTo===null?null:numeric(body.replyTo,'replyTo');
    if(replyTo!==null){const prior=await messageById(db,replyTo,principal);if(prior.project!==project||prior.from_principal_id!==recipient||prior.to_principal_id!==principal.id||prior.from_session_id!==(to?.id??null)||prior.to_session_id!==(from?.id??null))fail(403,'REPLY_MISMATCH','Replies must reverse the original conversation.');if(prior.to_principal_id==='owner'&&principal.role!=='owner')fail(403,'OWNER_REQUIRED','Only the owner may answer an owner question.');}
    const text=string(body.body,'body',6000),key=string(body.idempotencyKey,'idempotencyKey',160);
    const payloadHash=await digest(JSON.stringify({from:from?.id??null,to:to?.id??null,project,kind:body.kind,body:text,replyTo}));
    await db.prepare('INSERT INTO messages(from_principal_id,to_principal_id,from_session_id,to_session_id,project,kind,body,idempotency_key,payload_hash,reply_to,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE (? IS NULL OR EXISTS(SELECT 1 FROM sessions WHERE id=? AND archived_at IS NULL)) AND (? IS NULL OR EXISTS(SELECT 1 FROM sessions WHERE id=? AND archived_at IS NULL)) ON CONFLICT(from_principal_id,idempotency_key) DO NOTHING').bind(principal.id,recipient,from?.id??null,to?.id??null,project,body.kind,text,key,payloadHash,replyTo,now(),from?.id??null,from?.id??null,to?.id??null,to?.id??null).run();
    const row=await db.prepare(`${MESSAGE_SELECT} WHERE m.from_principal_id=? AND m.idempotency_key=?`).bind(principal.id,key).first();
    if(!row)fail(409,'SESSION_ARCHIVED','Session custody changed; recheck before sending.');if(row.payload_hash!==payloadHash)fail(409,'IDEMPOTENCY_CONFLICT','That idempotency key already belongs to different message content.');return json({message:messageView(row)},201);
  }
  if(path==='/api/messages'&&method==='GET'){
    const after=numeric(url.searchParams.get('after')??0,'after');const sessionId=url.searchParams.get('sessionId');let query=MESSAGE_SELECT+' WHERE m.id>?',values=[after];
    if(sessionId){const session=await sessionById(db,sessionId,principal,principal.role!=='owner');query+=' AND (m.from_session_id=? OR m.to_session_id=?)';values.push(session.id,session.id);}
    else if(principal.role!=='owner')fail(422,'SESSION_REQUIRED','Select your session inbox.');
    if(principal.role!=='owner'){query+=' AND (m.from_principal_id=? OR m.to_principal_id=?)';values.push(principal.id,principal.id);}
    const beforeValue=url.searchParams.get('before'),latest=url.searchParams.get('latest')==='1';
    if(beforeValue!==null){if(after!==0||latest)fail(422,'INVALID_CURSOR','Use one pagination direction at a time.');query+=' AND m.id<?';values.push(numeric(beforeValue,'before'));}
    const descending=latest||beforeValue!==null;
    const rows=await db.prepare(query+(descending?' ORDER BY m.id DESC LIMIT 100':' ORDER BY m.id ASC LIMIT 100')).bind(...values).all();
    const ordered=descending?rows.results.reverse():rows.results;
    return json({messages:ordered.map(messageView),nextCursor:ordered.at(-1)?.id??after,nextBefore:descending&&ordered.length===100?ordered[0].id:null});
  }
  const ackMatch=path.match(/^\/api\/messages\/(\d+)\/ack$/);
  if(ackMatch&&method==='POST'){
    const body=await bodyOf(request);checkKeys(body,['sessionId']);const row=await messageById(db,numeric(ackMatch[1],'messageId'),principal);
    if(row.to_principal_id!==principal.id)fail(403,'RECIPIENT_REQUIRED','Only the recipient can acknowledge a message.');
    if(row.to_session_id){const session=await sessionById(db,body.sessionId,principal,true);if(session.id!==row.to_session_id)fail(403,'RECIPIENT_REQUIRED','Select the exact receiving session.');}
    else if(principal.role!=='owner'||body.sessionId!==undefined)fail(403,'OWNER_REQUIRED','Owner questions require owner acknowledgment.');
    await db.prepare('UPDATE messages SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE id=? AND to_principal_id=?').bind(now(),row.id,principal.id).run();return json({message:messageView(await messageById(db,row.id,principal))});
  }
  const OWNERSHIP_SELECT='SELECT o.*,s.label AS owner_label FROM ownership o JOIN sessions s ON s.id=o.owner_session_id';
  const ownershipView=row=>({project:row.project,resourceKey:row.resource_key,ownerSessionId:row.owner_session_id,ownerLabel:row.owner_label,claimedAt:row.claimed_at});
  if(path==='/api/ownership'&&method==='GET'){
    const project=url.searchParams.get('project');let query=OWNERSHIP_SELECT,values=[];
    if(project){requireProject(principal,slug(project));query+=' WHERE o.project=?';values=[project];}
    else if(principal.role!=='owner'){query+=` WHERE o.project IN (${principal.projects.map(()=>'?').join(',')})`;values=principal.projects;}
    const rows=await db.prepare(query+' ORDER BY o.claimed_at DESC LIMIT 200').bind(...values).all();return json({ownership:rows.results.map(ownershipView)});
  }
  if(['/api/ownership/claim','/api/ownership/release'].includes(path)&&method==='POST'){
    const body=await bodyOf(request);checkKeys(body,['sessionId','resourceKey']);const session=await sessionById(db,body.sessionId,principal,true);requireActive(session);const resourceKey=string(body.resourceKey,'resourceKey',160);
    if(path.endsWith('/release')){const result=await db.prepare('DELETE FROM ownership WHERE project=? AND resource_key=? AND owner_session_id=?').bind(session.project,resourceKey,session.id).run();if(!result.meta.changes)fail(409,'OWNER_MISMATCH','This session does not hold that coordination claim.');await audit(db,principal,'ownership.released',session.id).run();return json({released:true});}
    await db.prepare('INSERT INTO ownership(project,resource_key,owner_session_id,claimed_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM sessions WHERE id=? AND archived_at IS NULL) ON CONFLICT(project,resource_key) DO NOTHING').bind(session.project,resourceKey,session.id,now(),session.id).run();
    const row=await db.prepare(`${OWNERSHIP_SELECT} WHERE o.project=? AND o.resource_key=?`).bind(session.project,resourceKey).first();if(!row)fail(409,'SESSION_ARCHIVED','Session custody changed; recheck before claiming.');if(row.owner_session_id!==session.id)fail(409,'OWNERSHIP_CONFLICT','Another session owns this correction. Coordinate before acting; stale heartbeats do not authorize takeover.');return json({ownership:ownershipView(row)});
  }
  fail(404,'ROUTE_NOT_FOUND','Coordination endpoint not found.');
}
export default {
  async fetch(request,env){
    try{
      const path=new URL(request.url).pathname;
      if(path==='/health'&&request.method==='GET')return json({ok:true,service:'agent-hub'});
      if(path.startsWith('/api/'))return await api(request,env);
      if(!['GET','HEAD'].includes(request.method))return json({error:{code:'METHOD_NOT_ALLOWED',message:'Use a supported method.'}},405);
      return await env.ASSETS.fetch(request);
    }catch(error){
      if(error instanceof HttpError)return json({error:{code:error.code,message:error.message}},error.status);
      return json({error:{code:'INTERNAL_ERROR',message:'The coordination request failed. No external operation was started.'}},500);
    }
  },
  async scheduled(_event,env){
    const cutoff=new Date(Date.now()-30*86400000).toISOString(),auditCutoff=new Date(Date.now()-90*86400000).toISOString();
    await env.DB.batch([env.DB.prepare('DELETE FROM messages WHERE created_at<?').bind(cutoff),env.DB.prepare('DELETE FROM audit_events WHERE created_at<?').bind(auditCutoff)]);
  },
};
