import { accessApi } from './access-api.mjs';
import { compactSession, compactMessage } from './agent-view.mjs';
import { parseAttribution, attributionView } from './attribution.mjs';
import { ATTENTION, LIFECYCLE_COLUMNS, lifecycleView, parseCheckpoint } from './lifecycle.mjs';
import { lifecycleApi, observerApi } from './lifecycle-api.mjs';
import { attributionLabels, canonicalAgentName, agentNameSql, machineAliases, canonicalMachine, machineFilterValues, ENVIRONMENTS, parseWorkContext } from './session-context.mjs';
const STATUSES = new Set(['RUNNING','WAITING_ON_USER','WAITING_ON_AGENT','BLOCKED','DONE']);
const KINDS = new Set(['NOTE','HANDOFF','QUESTION','ANSWER']);
const encoder = new TextEncoder();
const headers = {
  'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY',
  'Strict-Transport-Security':'max-age=31536000',
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
const ACTIVE_PRINCIPAL='EXISTS(SELECT 1 FROM principals WHERE id=? AND active=1)';
const dayAgo=()=>new Date(Date.now()-86400000).toISOString();
async function requireCurrent(db,principal){
  if(!await db.prepare('SELECT 1 FROM principals WHERE id=? AND active=1').bind(principal.id).first())fail(401,'UNAUTHORIZED','This invitation has been revoked.');
}
const noSecrets = value=>{
  if(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[\w.+/=~-]{16,}|\b(?:hub_agent_|hub_owner_|hub_observer_)[A-Za-z0-9_-]{20,}|\b(?:sk-|AIza)[A-Za-z0-9_-]{20,}|\b(?:password|api[_ -]?key|access[_ -]?token|verification[_ -]?code|step[_ -]?up[_ -]?code)\s*[=:]\s*["']?\S{4,}/i.test(value))
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
const principalView = row=>({id:row.id,name:row.name,account:row.account,role:row.role,profile:row.access_profile??'agent',projects:JSON.parse(row.projects_json),active:row.active===1});
async function authenticate(request,env,db){
  if(typeof env.OWNER_TOKEN!=='string'||env.OWNER_TOKEN.length<32)fail(503,'NOT_CONFIGURED','Owner authentication is not configured.');
  const authorization=request.headers.get('authorization');
  if(!authorization?.startsWith('Bearer ')||authorization.length>520)fail(401,'UNAUTHORIZED','Connect with a valid workspace invitation.');
  const token=authorization.slice(7);const tokenHash=await digest(token);
  if(equal(tokenHash,await digest(env.OWNER_TOKEN)))return {id:'owner',name:'Workspace owner',account:'Owner',role:'owner',profile:'owner',projects:['*']};
  const row=await db.prepare('SELECT * FROM principals WHERE token_hash=? AND active=1 AND role=\'agent\'').bind(tokenHash).first();
  if(!row)fail(401,'UNAUTHORIZED','Connect with a valid workspace invitation.');return principalView(row);
}
const latestAttribution = row=>{
  if(!row.latest_attribution_json)return null;
  const {provider,client,model,interface:interfaceLabel,reportedClient}=attributionLabels(JSON.parse(row.latest_attribution_json));
  return {provider,client,model,...(interfaceLabel?{interface:interfaceLabel}:{}),...(reportedClient?{reportedClient}:{})};
};
// Enrollment grants project-scoped coordination access. All reported text
// remains untrusted evidence, never human approval or execution authority.
const sessionView = (row,principal,aliases)=>{
  const {workContext=null,...details}=JSON.parse(row.details_json),machine=canonicalMachine(row.machine,aliases);
  const lifecycle=lifecycleView(row),interval=lifecycle.checkpoint?.presenceIntervalSeconds;
  return {id:row.id,principalId:row.principal_id,principalName:row.principal_name,account:row.account,externalId:row.external_id,machine:machine,reportedMachine:machine!==row.machine?row.machine:null,label:row.label,project:row.project,task:row.task,status:row.status,environment:ENVIRONMENTS.includes(row.environment)?row.environment:null,workContext:workContext,details:details,latestAttribution:latestAttribution(row),createdAt:row.created_at,lastSeenAt:row.last_seen_at,archivedAt:row.archived_at,stale:Date.now()-Date.parse(row.last_seen_at)>(interval??60)*3000,lifecycle};
};
const segmentView=row=>attributionView(row);
const SESSION_FROM=' FROM sessions s JOIN principals p ON p.id=s.principal_id LEFT JOIN session_attribution_segments a ON a.id=(SELECT id FROM session_attribution_segments WHERE session_id=s.id ORDER BY id DESC LIMIT 1)';
const SESSION_SELECT='SELECT s.*,p.name AS principal_name,p.account,a.metadata_json AS latest_attribution_json'+LIFECYCLE_COLUMNS+SESSION_FROM;
// Count claims once for discovery, rather than scanning ownership for each card.
// This works before the optional read-efficiency indexes have been installed.
const SESSION_LIST_SELECT='SELECT s.*,p.name AS principal_name,p.account,a.metadata_json AS latest_attribution_json'+LIFECYCLE_COLUMNS.replace('(SELECT COUNT(*) FROM ownership WHERE owner_session_id=s.id) AS held_claims','COALESCE(claims.total,0) AS held_claims')+SESSION_FROM+' LEFT JOIN (SELECT owner_session_id,COUNT(*) AS total FROM ownership GROUP BY owner_session_id) claims ON claims.owner_session_id=s.id';
const AGENT_NAME_SQL=agentNameSql("json_extract(a.metadata_json,'$.client')");
const sessionFilters = (url,aliases)=>{
  const clauses=[],values=[];
  for(const [name,column,max] of [['agentName',AGENT_NAME_SQL,160],['agentModel',"json_extract(a.metadata_json,'$.model')",160],['machine','s.machine',120],['environment','s.environment',32],['repository',"json_extract(s.details_json,'$.workContext.repository')",256],['branch',"json_extract(s.details_json,'$.workContext.branch')",256]]){
    const value=url.searchParams.get(name),unknown=url.searchParams.get(name+'Unknown');
    if(unknown!==null&&unknown!=='1')fail(422,'INVALID_FILTER',`${name}Unknown must be 1 when supplied.`);
    if(value!==null&&unknown!==null)fail(422,'INVALID_FILTER',`Choose a ${name} label or Unknown, not both.`);
    if(unknown!==null)clauses.push(`${column} IS NULL`);
    else if(value!==null){
      const selected=string(value,name,max);
      if(name==='environment'&&!ENVIRONMENTS.includes(selected))fail(422,'INVALID_FILTER','Use local, dev, staging or production for environment.');
      if(name==='branch'&&!url.searchParams.get('repository'))fail(422,'INVALID_FILTER','A branch filter requires its repository.');
      if(name==='machine'){const matches=machineFilterValues(selected,aliases);clauses.push(`lower(rtrim(${column},'.')) IN (${matches.map(()=>'?').join(',')})`);values.push(...matches);}
      else {clauses.push(`${column}=?`);values.push(name==='agentName'?canonicalAgentName(selected):selected);}
    }
  }
  return {clauses,values};
};
const SESSION_CUSTODY_SELECT='SELECT s.id,s.project,s.principal_id,s.archived_at FROM sessions s JOIN principals p ON p.id=s.principal_id';
async function sessionById(db,id,principal,own=false,{custodyOnly=false}={}){
  const row=await db.prepare(`${custodyOnly?SESSION_CUSTODY_SELECT:SESSION_SELECT} WHERE s.id=?`).bind(string(id,'sessionId',80)).first();
  if(!row)fail(404,'SESSION_NOT_FOUND','Session not found.');requireProject(principal,row.project);
  if(own&&row.principal_id!==principal.id)fail(403,'SESSION_OWNER_REQUIRED','Only the principal owning that session can update or send from it.');return row;
}
const MESSAGE_SELECT='SELECT m.*,sender.name AS sender_name,recipient.name AS recipient_name FROM messages m JOIN principals sender ON sender.id=m.from_principal_id JOIN principals recipient ON recipient.id=m.to_principal_id';
const messageView=(row,principal,conversation=false)=>({id:row.id,fromSessionId:row.from_session_id,toSessionId:row.to_session_id,fromPrincipalId:row.from_principal_id,toPrincipalId:row.to_principal_id,fromPrincipalName:row.sender_name,toPrincipalName:row.recipient_name,project:row.project,kind:row.kind,body:principal.role==='owner'||(conversation&&principal.profile==='observer'&&mayProject(principal,row.project))||(row.review_state==='APPROVED'&&row.to_session_id!==null)?row.body:null,replyTo:row.reply_to,createdAt:row.created_at,acknowledgedAt:row.acknowledged_at,reviewState:row.review_state,reviewedAt:row.reviewed_at,deliveryCursor:row.delivery_id,...(principal.role==='owner'?{payloadHash:row.payload_hash}:{})});
const requireActive=session=>{if(session?.archived_at)fail(409,'SESSION_ARCHIVED','This session was archived; register a new session for new work.');};
const audit=(db,principal,action,id)=>db.prepare(`INSERT INTO audit_events(principal_id,action,target_id,created_at) SELECT ?,?,?,? WHERE ${ACTIVE_PRINCIPAL} AND CASE WHEN EXISTS(SELECT 1 FROM audit_events WHERE principal_id=? AND action=? AND target_id=? AND created_at>=?) THEN 0 ELSE (SELECT COUNT(*)<100000 AND COUNT(*) FILTER (WHERE principal_id=?)<10000 FROM audit_events) END`).bind(principal.id,action,String(id),now(),principal.id,principal.id,action,String(id),dayAgo(),principal.id);
async function messageById(db,id,principal){
  const row=await db.prepare(`${MESSAGE_SELECT} WHERE m.id=?`).bind(id).first();
  if(!row)fail(404,'MESSAGE_NOT_FOUND','Message not found.');requireProject(principal,row.project);
  if(principal.role!=='owner'&&![row.from_principal_id,row.to_principal_id].includes(principal.id))fail(403,'MESSAGE_DENIED','This message belongs to another conversation.');
  if(principal.role!=='owner'&&(row.review_state!=='APPROVED'||row.to_session_id===null))fail(403,'MESSAGE_NOT_DELIVERED','This message is not available to connected agents.');return row;
}
function numeric(value,name){const result=Number(value);if(!Number.isSafeInteger(result)||result<0)fail(422,'INVALID_CURSOR',`${name} must be a nonnegative integer.`);return result;}
function readOptions(url, maximum) {
  const view=url.searchParams.get('view')??'full';
  if(!['compact','full'].includes(view))fail(422,'INVALID_VIEW','Use compact or full.');
  const raw=url.searchParams.get('limit');
  const limit=raw===null?(view==='compact'?20:maximum):Number(raw);
  if((raw!==null&&!/^[1-9]\d*$/.test(raw))||!Number.isSafeInteger(limit)||limit<1||limit>maximum)fail(422,'INVALID_LIMIT',`limit must be 1 to ${maximum}.`);
  return {view,limit};
}
async function api(request,env){
  const url=new URL(request.url);const origin=request.headers.get('origin');
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))fail(403,'HTTPS_REQUIRED','Use HTTPS for hosted coordination.');
  if(origin&&origin!==url.origin)fail(403,'ORIGIN_DENIED','Cross-origin coordination requests are disabled.');
  if(!env.DB)fail(503,'NOT_CONFIGURED','Coordination database is not configured.');
  const db=env.DB.withSession('first-primary');
  if(url.pathname.startsWith('/api/observer/')||url.pathname==='/api/observer'||request.headers.get('authorization')?.startsWith('Bearer hub_observer_'))return observerApi({request,db,path:url.pathname,method:request.method,readBody:()=>bodyOf(request),digest,fail,checkKeys,string,json});
  const principal=await authenticate(request,env,db),aliases=machineAliases(env.MACHINE_ALIASES_JSON);
  const readBody=async()=>{const body=await bodyOf(request);await requireCurrent(db,principal);return body;};
  const path=url.pathname,method=request.method;
  if(principal.profile==='observer'&&method!=='GET'&&path!=='/api/connections'&&!(path==='/api/sessions'&&method==='POST')&&!(/^\/api\/sessions\/[^/]+(?:\/(?:heartbeat|archive|attribution))?$/.test(path)&&['POST','PATCH'].includes(method)))fail(403,'OBSERVER_READ_ONLY','Project observers can read conversations and report their own sessions, but cannot send, acknowledge or manage coordination.');
  const accessResponse=await accessApi({path,method,url,db,principal,readBody,fail,checkKeys,string,numeric,readOptions,ownerOnly,requireProject,sessionById,requireCurrent,json,messageSelect:MESSAGE_SELECT,messageView,activePrincipal:ACTIVE_PRINCIPAL,now});
  if(accessResponse)return accessResponse;
  const lifecycleResponse=await lifecycleApi({path,method,url,db,principal,readBody,fail,string,checkKeys,ownerOnly,sessionById,requireActive,requireCurrent,digest,json,sessionView,aliases,select:SESSION_SELECT,messageById});
  if(lifecycleResponse)return lifecycleResponse;
  if(path==='/api/me'&&method==='GET')return json({principal});
  if(path==='/api/principals'&&method==='GET'){
    ownerOnly(principal);const rows=await db.prepare("SELECT * FROM principals WHERE id!='hub-accountability' ORDER BY created_at DESC LIMIT 200").all();return json({principals:rows.results.map(principalView)});
  }
  if(path==='/api/principals'&&method==='POST'){
    ownerOnly(principal);const body=await readBody();checkKeys(body,['name','account','projects','profile']);
    const profile=body.profile??'agent';if(!['agent','observer'].includes(profile))fail(422,'INVALID_PROFILE','Choose agent or observer.');
    if(!Array.isArray(body.projects)||body.projects.length<1||body.projects.length>20)fail(422,'INVALID_PROJECTS','Select 1 to 20 explicit project scopes.');
    const projects=[...new Set(body.projects.map(slug))];const id=crypto.randomUUID();const bytes=crypto.getRandomValues(new Uint8Array(32));const token='hub_agent_'+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
    const name=string(body.name,'name',120),account=string(body.account,'account',160);
    const insert=profile==='observer'
      ? db.prepare('INSERT INTO principals(id,name,account,role,token_hash,projects_json,created_at,access_profile) VALUES (?,?,?,\'agent\',?,?,?,?)').bind(id,name,account,await digest(token),JSON.stringify(projects),now(),profile)
      : db.prepare('INSERT INTO principals(id,name,account,role,token_hash,projects_json,created_at) VALUES (?,?,?,\'agent\',?,?,?)').bind(id,name,account,await digest(token),JSON.stringify(projects),now());
    await db.batch([insert,audit(db,principal,'invite.created',id)]);
    return json({principal:{id,name,account,role:'agent',profile,projects,active:true},token},201);
  }
  const principalMatch=path.match(/^\/api\/principals\/([^/]+)$/);
  if(principalMatch&&method==='DELETE'){
    ownerOnly(principal);if(['owner','hub-accountability'].includes(principalMatch[1]))fail(403,'OWNER_IMMUTABLE','Workspace identities cannot be revoked through invitations.');
    const result=await db.prepare('UPDATE principals SET active=0 WHERE id=? AND role=\'agent\'').bind(principalMatch[1]).run();if(!result.meta.changes)fail(404,'PRINCIPAL_NOT_FOUND','Invitation not found.');
    await audit(db,principal,'invite.revoked',principalMatch[1]).run();return json({revoked:true});
  }
  if(path==='/api/sessions'&&method==='GET'){
    const {view,limit}=readOptions(url,200);
    const project=url.searchParams.get('project');if(project)requireProject(principal,slug(project));
    let scope=' WHERE s.archived_at IS NULL',scopeValues=[];
    if(project){scope+=' AND s.project=?';scopeValues=[project];}
    else if(principal.role!=='owner'){scope+=` AND s.project IN (${principal.projects.map(()=>'?').join(',')})`;scopeValues=principal.projects;}
    const filters=sessionFilters(url,aliases),filteredScope=scope+(filters.clauses.length?' AND '+filters.clauses.join(' AND '):''),filterValues=[...scopeValues,...filters.values];
    const status=url.searchParams.get('status');if(status!==null&&status!=='WAITING'&&!STATUSES.has(status))fail(422,'INVALID_FILTER','Select a supported status.');
    const staleOnly=url.searchParams.get('staleOnly');if(staleOnly!==null&&staleOnly!=='1')fail(422,'INVALID_FILTER','staleOnly must be 1.');
    const attention=url.searchParams.get('attention');if(attention!==null&&!ATTENTION.includes(attention))fail(422,'INVALID_FILTER','Select a supported attention category.');
    // Admission caps the workspace at 2000 active sessions. Read this authorized
    // baseline once; all counts precede the response page and status filters.
    const rows=await db.prepare(SESSION_LIST_SELECT+filteredScope+' ORDER BY s.last_seen_at DESC,s.id ASC LIMIT 2000').bind(...filterValues).all();
    const baseline=rows.results.map(row=>sessionView(row,principal,aliases));
    const ordered=baseline.filter(session=>(status===null||(status==='WAITING'?['WAITING_ON_USER','WAITING_ON_AGENT'].includes(session.status):session.status===status))&&(staleOnly===null||(session.stale&&session.status!=='DONE'))&&(!attention||session.lifecycle.attention===attention));
    const total=ordered.length;
    if(view==='compact')return json({sessions:ordered.slice(0,limit).map(compactSession),limit,total,hasMore:total>limit});
    const options=filters.clauses.length
      ? await db.prepare(`SELECT DISTINCT s.machine,s.environment,${AGENT_NAME_SQL} AS agent_name,json_extract(a.metadata_json,'$.model') AS agent_model,json_extract(s.details_json,'$.workContext.repository') AS repository,json_extract(s.details_json,'$.workContext.branch') AS branch`+SESSION_FROM+scope).bind(...scopeValues).all()
      : {results:baseline.map(session=>({machine:session.machine,environment:session.environment,agent_name:session.latestAttribution?.client??null,agent_model:session.latestAttribution?.model??null,repository:session.workContext?.repository??null,branch:session.workContext?.branch??null}))};
    const distinct=key=>[...new Set(options.results.map(row=>row[key]??null))].sort((left,right)=>left===null?1:right===null?-1:left.localeCompare(right));
    const machines=[...new Set(options.results.map(row=>canonicalMachine(row.machine,aliases)))].sort((a,b)=>a===null?1:b===null?-1:a.localeCompare(b));
    const branches=[...new Map(options.results.map(row=>{const value=row.repository&&row.branch?{repository:row.repository,branch:row.branch}:null;return [JSON.stringify(value),value];})).values()];
    const summary={RUNNING:0,WAITING_ON_USER:0,WAITING_ON_AGENT:0,BLOCKED:0,DONE:0,stale:0};
    const accountability={categories:Object.fromEntries(ATTENTION.map(key=>[key,0])),unaccounted:0,oldestUnaccountedAt:null,checkpointCoverage:0,observerCoverage:0,total:baseline.length,unaccountedClaims:0};
    for(const session of baseline){summary[session.status]++;if(session.status!=='DONE'&&session.stale)summary.stale++;const value=session.lifecycle;accountability.categories[value.attention]++;if(value.checkpoint)accountability.checkpointCoverage++;if(value.coverage==='available')accountability.observerCoverage++;if(value.unaccounted){accountability.unaccounted++;accountability.unaccountedClaims+=value.heldClaims;if(!accountability.oldestUnaccountedAt||value.unaccountedSince<accountability.oldestUnaccountedAt)accountability.oldestUnaccountedAt=value.unaccountedSince;}}
    return json({sessions:ordered.slice(0,limit),limit,total,summary,accountability,filterOptions:{agentNames:distinct('agent_name'),agentModels:distinct('agent_model'),machines,environments:distinct('environment'),branches}});
  }
  if(path==='/api/sessions'&&method==='POST'){
    const body=await readBody();checkKeys(body,['externalId','machine','label','project','task','status','environment','workContext','details','checkpoint']);
    const project=slug(body.project);requireProject(principal,project);const externalId=string(body.externalId,'externalId',160),machine=string(body.machine,'machine',120);
    const status=body.status;if(!STATUSES.has(status))fail(422,'INVALID_STATUS','Select a supported session status.');
    const id=crypto.randomUUID(),date=now();
    const environment=string(body.environment,'environment',32,true);if(environment&&!ENVIRONMENTS.includes(environment))fail(422,'INVALID_ENVIRONMENT','Use dev, staging, production or local for the target application instance.');
    const details=detailsOf(body.details);if(body.workContext!==undefined)details.workContext=parseWorkContext(body.workContext,fail);
    const checkpoint=body.checkpoint===undefined?null:parseCheckpoint(body.checkpoint,{fail,string,checkKeys});
    if(checkpoint?.wait?.sessionId){const dependency=await sessionById(db,checkpoint.wait.sessionId,principal);if(dependency.project!==project)fail(403,'PROJECT_MISMATCH','Dependency must belong to this project.');}
    if(checkpoint?.wait?.messageId){const message=await messageById(db,Number(checkpoint.wait.messageId),principal);if(message.project!==project)fail(403,'PROJECT_MISMATCH','Message must belong to this project.');}
    if(checkpoint?.wait)checkpoint.waitStartedAt=date;
    await db.prepare('INSERT INTO sessions(id,principal_id,external_id,machine,label,project,task,status,environment,details_json,created_at,last_seen_at,checkpoint_json,checkpoint_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM principals WHERE id=? AND active=1) AND (SELECT COUNT(*) FROM sessions WHERE principal_id=?)<1000 AND (SELECT COUNT(*) FROM sessions)<10000 AND (SELECT COUNT(*) FROM sessions WHERE archived_at IS NULL AND principal_id=?)<100 AND (SELECT COUNT(*) FROM sessions WHERE archived_at IS NULL)<2000 ON CONFLICT(principal_id,external_id) DO NOTHING').bind(id,principal.id,externalId,machine,string(body.label,'label',120),project,string(body.task,'task',2000),status,environment,JSON.stringify(details),date,date,checkpoint?JSON.stringify(checkpoint):null,checkpoint?date:null,principal.id,principal.id,principal.id).run();
    await requireCurrent(db,principal);
    const row=await db.prepare(`${SESSION_SELECT} WHERE s.principal_id=? AND s.external_id=?`).bind(principal.id,externalId).first();
    if(!row)fail(409,'SESSION_CAPACITY','Session capacity reached (100/2000 active or 1000/10000 retained per principal/workspace). Archiving preserves retained history.');
    if(canonicalMachine(row.machine,aliases)!==canonicalMachine(machine,aliases)||row.project!==project)fail(409,'SESSION_IDENTITY_CONFLICT','That external session already belongs to a different machine or project.');
    if(row.id===id)await audit(db,principal,'session.registered',id).run();return json({session:sessionView(row,principal,aliases)},row.id===id?201:200);
  }
  const attributionMatch=path.match(/^\/api\/sessions\/([^/]+)\/attribution$/);
  if(attributionMatch&&['GET','POST'].includes(method)){
    const session=await sessionById(db,attributionMatch[1],principal,method==='POST');
    if(method==='GET'){
      const after=numeric(url.searchParams.get('after')??0,'after');
      const rows=await db.prepare('SELECT * FROM (SELECT *,COALESCE(LEAD(started_at) OVER (ORDER BY id),?) AS ended_at FROM session_attribution_segments WHERE session_id=?) WHERE id>? ORDER BY id LIMIT 201').bind(session.archived_at,session.id,after).all();
      const page=rows.results.slice(0,200);
      return json({segments:page.map(row=>segmentView(row,principal)),nextCursor:rows.results.length>200?page.at(-1).id:null,limit:200});
    }
    requireActive(session);
    const body=await readBody(),parsed=parseAttribution(body,fail);
    const payloadHash=await digest(JSON.stringify({metadata:parsed.metadata,previousSegmentId:parsed.previousSegmentId}));
    await db.prepare('INSERT INTO session_attribution_segments(session_id,principal_id,idempotency_key,payload_hash,metadata_json,started_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM principals WHERE id=? AND active=1) AND (SELECT COUNT(*) FROM session_attribution_segments WHERE principal_id=?)<10000 AND (SELECT COUNT(*) FROM session_attribution_segments)<100000 AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND principal_id=? AND archived_at IS NULL) AND (SELECT MAX(id) FROM session_attribution_segments WHERE session_id=?) IS ? AND (SELECT COUNT(*) FROM session_attribution_segments WHERE session_id=?)<10000 ON CONFLICT(session_id,idempotency_key) DO NOTHING').bind(session.id,principal.id,parsed.idempotencyKey,payloadHash,JSON.stringify(parsed.metadata),now(),principal.id,principal.id,session.id,principal.id,session.id,parsed.previousSegmentId,session.id).run();
    await requireCurrent(db,principal);
    const row=await db.prepare('SELECT * FROM (SELECT *,LEAD(started_at) OVER (ORDER BY id) AS ended_at FROM session_attribution_segments WHERE session_id=?) WHERE idempotency_key=?').bind(session.id,parsed.idempotencyKey).first();
    if(!row)fail(409,'ATTRIBUTION_CHANGED','Session or attribution changed, or the history limit was reached. Read the current history before recording a new change.');
    if(row.payload_hash!==payloadHash)fail(409,'IDEMPOTENCY_CONFLICT','That idempotency key already records different attribution.');
    return json({segment:segmentView(row,principal)},201);
  }
  const archiveMatch=path.match(/^\/api\/sessions\/([^/]+)\/archive$/);
  if(archiveMatch&&method==='POST'){
    const body=await readBody();checkKeys(body,[]);const row=await sessionById(db,archiveMatch[1],principal,true);
    if(row.archived_at)return json({session:sessionView(row,principal,aliases)});
    if(row.status!=='DONE')fail(409,'SESSION_NOT_DONE','Only a completed session may be archived.');
    if(row.checkpoint_json && lifecycleView(row).attention!=='COMPLETE')fail(409,'CLOSEOUT_REQUIRED','Record objective, workspace and native-chat closeout before archiving this checkpoint-enabled session.');
    const held=await db.prepare('SELECT 1 FROM ownership WHERE owner_session_id=? LIMIT 1').bind(row.id).first();if(held)fail(409,'OWNERSHIP_HELD','Release this session’s coordination claims before archiving.');
    await db.batch([db.prepare('UPDATE sessions SET archived_at=? WHERE id=? AND principal_id=? AND EXISTS(SELECT 1 FROM principals WHERE id=? AND active=1) AND status=\'DONE\' AND NOT EXISTS(SELECT 1 FROM ownership WHERE owner_session_id=?) AND revision=?').bind(now(),row.id,principal.id,principal.id,row.id,row.revision),audit(db,principal,'session.archive.requested',row.id)]);
    await requireCurrent(db,principal);const current=await sessionById(db,row.id,principal,true);if(!current.archived_at)fail(409,'OWNERSHIP_HELD','Session custody changed; recheck its claims before archiving.');return json({session:sessionView(current,principal,aliases)});
  }
  const sessionMatch=path.match(/^\/api\/sessions\/([^/]+)(\/heartbeat)?$/);
  if(sessionMatch&&((method==='POST'&&sessionMatch[2])||(method==='PATCH'&&!sessionMatch[2]))){
    const row=await sessionById(db,sessionMatch[1],principal,true);requireActive(row);const body=await readBody();
    if(sessionMatch[2]){checkKeys(body,[]);await db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=? AND principal_id=? AND archived_at IS NULL AND EXISTS(SELECT 1 FROM principals WHERE id=? AND active=1)').bind(now(),row.id,principal.id,principal.id).run();}
    else{
      checkKeys(body,['label','status','task','details','environment','workContext']);const status=body.status??row.status;if(!STATUSES.has(status))fail(422,'INVALID_STATUS','Select a supported session status.');
      const label=body.label===undefined?row.label:string(body.label,'label',120);
      const task=body.task===undefined?row.task:string(body.task,'task',2000),previous=JSON.parse(row.details_json),details=body.details===undefined?previous:detailsOf(body.details);
      if(body.details!==undefined && previous.workContext!==undefined)details.workContext=previous.workContext;
      if(body.workContext!==undefined)details.workContext=parseWorkContext(body.workContext,fail);
      const environment=body.environment===undefined?row.environment:string(body.environment,'environment',32,true);if(environment&&!ENVIRONMENTS.includes(environment))fail(422,'INVALID_ENVIRONMENT','Use local, dev, staging or production for the target application instance.');
      await db.batch([db.prepare('UPDATE sessions SET status=?,task=?,label=?,details_json=?,environment=?,last_seen_at=? WHERE id=? AND principal_id=? AND archived_at IS NULL AND EXISTS(SELECT 1 FROM principals WHERE id=? AND active=1)').bind(status,task,label,JSON.stringify(details),environment,now(),row.id,principal.id,principal.id),audit(db,principal,'session.updated',row.id)]);
    }
    await requireCurrent(db,principal);const current=await sessionById(db,row.id,principal,true);requireActive(current);return json({session:sessionView(current,principal,aliases)});
  }
  if(path==='/api/messages'&&method==='POST'){
    const body=await readBody();checkKeys(body,['fromSessionId','toSessionId','project','kind','body','idempotencyKey','replyTo']);const project=slug(body.project);requireProject(principal,project);
    if(!KINDS.has(body.kind))fail(422,'INVALID_KIND','Select a supported message kind.');
    const from=body.fromSessionId?await sessionById(db,body.fromSessionId,principal,true,{custodyOnly:true}):null;if(!from&&principal.role!=='owner')fail(403,'SENDER_REQUIRED','An agent must send from its own registered session.');
    const to=body.toSessionId?await sessionById(db,body.toSessionId,principal,false,{custodyOnly:true}):null;requireActive(from);requireActive(to);
    if(!to&&body.kind!=='QUESTION')fail(422,'RECIPIENT_REQUIRED','Only a question can be addressed directly to the workspace owner.');
    if(!from&&!to)fail(422,'RECIPIENT_REQUIRED','Select a recipient session.');
    if((from&&from.project!==project)||(to&&to.project!==project))fail(403,'PROJECT_MISMATCH','Sender and recipient must both belong to the selected project.');
    const recipient=to?.principal_id??'owner';
    const replyTo=body.replyTo===undefined||body.replyTo===null?null:numeric(body.replyTo,'replyTo');
    if(replyTo!==null){const prior=await messageById(db,replyTo,principal);if(prior.project!==project||prior.from_principal_id!==recipient||prior.to_principal_id!==principal.id||prior.from_session_id!==(to?.id??null)||prior.to_session_id!==(from?.id??null))fail(403,'REPLY_MISMATCH','Replies must reverse the original conversation.');if(prior.to_principal_id==='owner'&&principal.role!=='owner')fail(403,'OWNER_REQUIRED','Only the owner may answer an owner question.');}
    const text=string(body.body,'body',6000),key=string(body.idempotencyKey,'idempotencyKey',160);
    const payloadHash=await digest(JSON.stringify({from:from?.id??null,to:to?.id??null,project,kind:body.kind,body:text,replyTo}));
    const date=now();
    await db.batch([
      db.prepare(`INSERT INTO messages(from_principal_id,to_principal_id,from_session_id,to_session_id,project,kind,body,idempotency_key,payload_hash,reply_to,created_at,review_state,reviewed_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${ACTIVE_PRINCIPAL} AND EXISTS(SELECT 1 FROM principals WHERE id=? AND active=1) AND EXISTS(SELECT 1 FROM principals p WHERE p.id=? AND (p.role='owner' OR EXISTS(SELECT 1 FROM json_each(p.projects_json) WHERE value=?))) AND EXISTS(SELECT 1 FROM principals p WHERE p.id=? AND (p.role='owner' OR EXISTS(SELECT 1 FROM json_each(p.projects_json) WHERE value=?))) AND (? IS NULL OR EXISTS(SELECT 1 FROM sessions WHERE id=? AND principal_id=? AND project=? AND archived_at IS NULL)) AND (? IS NULL OR EXISTS(SELECT 1 FROM sessions WHERE id=? AND principal_id=? AND project=? AND archived_at IS NULL)) AND (SELECT COUNT(*)<10000 AND COUNT(*) FILTER (WHERE from_principal_id=?)<1000 AND COUNT(*) FILTER (WHERE created_at>=?)<5000 AND COUNT(*) FILTER (WHERE from_principal_id=? AND created_at>=?)<500 FROM messages) ON CONFLICT(from_principal_id,idempotency_key) DO NOTHING`).bind(principal.id,recipient,from?.id??null,to?.id??null,project,body.kind,text,key,payloadHash,replyTo,date,'APPROVED',null,principal.id,recipient,principal.id,project,recipient,project,from?.id??null,from?.id??null,principal.id,project,to?.id??null,to?.id??null,recipient,project,principal.id,dayAgo(),principal.id,dayAgo()),
      db.prepare(`INSERT INTO message_deliveries(message_id) SELECT id FROM messages WHERE from_principal_id=? AND idempotency_key=? AND review_state='APPROVED' AND to_session_id IS NOT NULL AND ${ACTIVE_PRINCIPAL} ON CONFLICT(message_id) DO NOTHING`).bind(principal.id,key,principal.id),
      db.prepare(`UPDATE messages SET delivery_id=(SELECT id FROM message_deliveries WHERE message_id=messages.id) WHERE from_principal_id=? AND idempotency_key=? AND review_state='APPROVED' AND to_session_id IS NOT NULL AND ${ACTIVE_PRINCIPAL}`).bind(principal.id,key,principal.id),
    ]);
    await requireCurrent(db,principal);
    const row=await db.prepare(`${MESSAGE_SELECT} WHERE m.from_principal_id=? AND m.idempotency_key=?`).bind(principal.id,key).first();
    if(!row)fail(409,'MESSAGE_CAPACITY','Session or invitation custody changed, or message capacity was reached.');if(row.payload_hash!==payloadHash)fail(409,'IDEMPOTENCY_CONFLICT','That idempotency key already belongs to different message content.');return json({message:messageView(row,principal)},201);
  }
  if(path==='/api/messages'&&method==='GET'){
    const {view,limit}=readOptions(url,100);
    const owner=principal.role==='owner',cursorColumn=owner?'m.id':'m.delivery_id';
    const after=numeric(url.searchParams.get('after')??0,'after');const sessionId=url.searchParams.get('sessionId');
    const direction=url.searchParams.get('direction')??'all';
    if(!['all','incoming'].includes(direction)||direction==='incoming'&&!sessionId)fail(422,'INVALID_DIRECTION','Use all, or incoming with an exact sessionId.');
    let query=MESSAGE_SELECT+` WHERE ${cursorColumn}>?`,values=[after];
    if(sessionId){const session=await sessionById(db,sessionId,principal,false,{custodyOnly:true});if(direction==='incoming'){query+=' AND m.to_session_id=?';values.push(session.id);}else{query+=' AND (m.from_session_id=? OR m.to_session_id=?)';values.push(session.id,session.id);}}
    if(!owner){query+=` AND m.review_state='APPROVED' AND m.to_session_id IS NOT NULL AND (m.from_principal_id=? OR m.to_principal_id=?) AND m.project IN (${principal.projects.map(()=>'?').join(',')})`;values.push(principal.id,principal.id,...principal.projects);}
    const reviewState=url.searchParams.get('reviewState');if(reviewState!==null){ownerOnly(principal);if(!['PENDING','APPROVED','REJECTED'].includes(reviewState))fail(422,'INVALID_REVIEW','Select a supported review state.');query+=' AND m.review_state=?';values.push(reviewState);}
    const kind=url.searchParams.get('kind');
    if(kind!==null){if(!KINDS.has(kind))fail(422,'INVALID_KIND','Select a supported message kind.');query+=' AND m.kind=?';values.push(kind);}
    const beforeValue=url.searchParams.get('before'),latest=url.searchParams.get('latest')==='1';
    if(beforeValue!==null){if(after!==0||latest)fail(422,'INVALID_CURSOR','Use one pagination direction at a time.');query+=` AND ${cursorColumn}<?`;values.push(numeric(beforeValue,'before'));}
    const descending=latest||beforeValue!==null;
    const rows=await db.prepare(query+` ORDER BY ${cursorColumn} ${descending?'DESC':'ASC'} LIMIT ${limit+1}`).bind(...values).all();
    const hasMore=rows.results.length>limit,page=rows.results.slice(0,limit);
    const ordered=descending?page.reverse():page;
    const cursor=row=>owner?row.id:row.delivery_id;
    return json({messages:ordered.map(row=>{const message=messageView(row,principal);return view==='compact'?compactMessage(message):message;}),nextCursor:ordered.length?cursor(ordered.at(-1)):after,nextBefore:descending&&(view==='compact'?hasMore:ordered.length===limit)?cursor(ordered[0]):null,...(view==='compact'?{limit,hasMore}:{})});
  }
  const ackMatch=path.match(/^\/api\/messages\/(\d+)\/ack$/);
  if(ackMatch&&method==='POST'){
    const body=await readBody();checkKeys(body,['sessionId']);const row=await messageById(db,numeric(ackMatch[1],'messageId'),principal);
    if(row.to_principal_id!==principal.id)fail(403,'RECIPIENT_REQUIRED','Only the recipient can acknowledge a message.');
    if(row.to_session_id){const session=await sessionById(db,body.sessionId,principal,true,{custodyOnly:true});if(session.id!==row.to_session_id)fail(403,'RECIPIENT_REQUIRED','Select the exact receiving session.');}
    else if(principal.role!=='owner'||body.sessionId!==undefined)fail(403,'OWNER_REQUIRED','Owner questions require owner acknowledgment.');
    if(row.review_state!=='APPROVED'&&!(principal.role==='owner'&&row.to_session_id===null))fail(403,'MESSAGE_NOT_DELIVERED','Only an approved delivery or human owner question can be acknowledged.');
    await db.prepare(`UPDATE messages SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE id=? AND to_principal_id=? AND (review_state='APPROVED' OR to_session_id IS NULL) AND ${ACTIVE_PRINCIPAL}`).bind(now(),row.id,principal.id,principal.id).run();await requireCurrent(db,principal);return json({message:messageView(await messageById(db,row.id,principal),principal)});
  }
  const OWNERSHIP_SELECT='SELECT o.*,s.label AS owner_label FROM ownership o JOIN sessions s ON s.id=o.owner_session_id';
  const ownershipView=(row,knownKey=null)=>({project:row.project,resourceKey:row.resource_key,ownerSessionId:row.owner_session_id,ownerLabel:row.owner_label,claimedAt:row.claimed_at});
  if(path==='/api/ownership'&&method==='GET'){
    const project=url.searchParams.get('project');let query=OWNERSHIP_SELECT,values=[];
    if(project){requireProject(principal,slug(project));query+=' WHERE o.project=?';values=[project];}
    else if(principal.role!=='owner'){query+=` WHERE o.project IN (${principal.projects.map(()=>'?').join(',')})`;values=principal.projects;}
    const key=url.searchParams.get('resourceKey');if(key!==null){query+=(values.length?' AND ':' WHERE ')+'o.resource_key=?';values.push(string(key,'resourceKey',160));}
    const rows=await db.prepare(query+' ORDER BY o.claimed_at DESC LIMIT 200').bind(...values).all();return json({ownership:rows.results.map(row=>ownershipView(row,key))});
  }
  if(['/api/ownership/claim','/api/ownership/release'].includes(path)&&method==='POST'){
    const body=await readBody();checkKeys(body,['sessionId','resourceKey']);const session=await sessionById(db,body.sessionId,principal,true,{custodyOnly:true});requireActive(session);const resourceKey=string(body.resourceKey,'resourceKey',160);
    if(path.endsWith('/release')){const result=await db.prepare('DELETE FROM ownership WHERE project=? AND resource_key=? AND owner_session_id=? AND EXISTS(SELECT 1 FROM principals WHERE id=? AND active=1)').bind(session.project,resourceKey,session.id,principal.id).run();await requireCurrent(db,principal);if(!result.meta.changes)fail(409,'OWNER_MISMATCH','This session does not hold that coordination claim.');await audit(db,principal,'ownership.released',session.id).run();return json({released:true});}
    await db.prepare('INSERT INTO ownership(project,resource_key,owner_session_id,claimed_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM principals WHERE id=? AND active=1) AND (SELECT COUNT(*) FROM ownership WHERE owner_session_id=?)<100 AND (SELECT COUNT(*) FROM ownership)<5000 AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND archived_at IS NULL) ON CONFLICT(project,resource_key) DO NOTHING').bind(session.project,resourceKey,session.id,now(),principal.id,session.id,session.id).run();
    await requireCurrent(db,principal);
    const row=await db.prepare(`${OWNERSHIP_SELECT} WHERE o.project=? AND o.resource_key=?`).bind(session.project,resourceKey).first();if(!row)fail(409,'SESSION_ARCHIVED','Session custody changed or claim capacity reached (100 per session/5000 workspace).');if(row.owner_session_id!==session.id)fail(409,'OWNERSHIP_CONFLICT','Another session owns this correction. Coordinate before acting; stale heartbeats do not authorize takeover.');return json({ownership:ownershipView(row,resourceKey)});
  }
  fail(404,'ROUTE_NOT_FOUND','Coordination endpoint not found.');
}
export default {
  async fetch(request,env){
    try{
      const url=new URL(request.url),path=url.pathname;
      if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)){
        if(path.startsWith('/api/'))fail(403,'HTTPS_REQUIRED','Use HTTPS for hosted coordination.');
        url.protocol='https:';return Response.redirect(url.href,308);
      }
      if(path==='/health'&&request.method==='GET')return json({ok:true,service:'agent-hub'});
      if(path.startsWith('/api/'))return await api(request,env);
      if(!['GET','HEAD'].includes(request.method))return json({error:{code:'METHOD_NOT_ALLOWED',message:'Use a supported method.'}},405);
      return await env.ASSETS.fetch(request);
    }catch(error){
      if(error instanceof HttpError)return json({error:{code:error.code,message:error.message}},error.status);
      for(let current=error,depth=0;current&&depth<3;current=current.cause,depth++){
        if(typeof current.message==='string'&&current.message.includes("Your account has exceeded D1's free tier daily row read limit")){
          const response=json({error:{code:'STORAGE_READ_QUOTA_EXCEEDED',message:'The Hub storage daily read allowance is exhausted. The owner can review account capacity; the free allowance resets at 00:00 UTC.'}},503);
          response.headers.set('Retry-After',String(Math.max(1,Math.ceil((Math.floor(Date.now()/86400000)*86400000+86400000-Date.now())/1000))));
          return response;
        }
      }
      return json({error:{code:'INTERNAL_ERROR',message:'The coordination request failed. No external operation was started.'}},500);
    }
  },
  async scheduled(_event,env){
    // Old minute triggers may briefly survive a rollout. They must do no work
    // except the existing daily retention window, and never send check-ins.
    if(_event.cron==='* * * * *'&&new Date(_event.scheduledTime??Date.now()).getUTCHours()!==3)return;
    if(_event.cron==='* * * * *'&&new Date(_event.scheduledTime??Date.now()).getUTCMinutes()!==17)return;
    const cutoff=new Date(Date.now()-30*86400000).toISOString(),auditCutoff=new Date(Date.now()-90*86400000).toISOString();
    await env.DB.batch([env.DB.prepare('DELETE FROM messages WHERE created_at<?').bind(cutoff),env.DB.prepare('DELETE FROM audit_events WHERE created_at<?').bind(auditCutoff)]);
    try{await env.DB.prepare('DELETE FROM connection_events WHERE connected_at<?').bind(auditCutoff).run();}catch(error){if(!/no such table: connection_events/i.test(String(error.message)))throw error;}
  },
};
