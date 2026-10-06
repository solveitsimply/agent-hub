import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {SqliteD1} from './d1-sqlite.mjs';
const ORIGIN='https://hub.test',RESOURCE=ORIGIN+'/mcp',CLIENT='test-client',REDIRECT='https://client.test/callback';
const OWNER='synthetic-only-owner-12345678901234567890';
const verifier='synthetic-pkce-verifier-0123456789012345678901234567890123456789';
const sha=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('hex');
const pkce=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('base64url');
const now=()=>Math.floor(Date.now()/1000);
async function fixture(t){
  const DB=new SqliteD1();t.after(()=>DB.close());const env={DB,OWNER_TOKEN:OWNER,MCP_AUTH_RATE_LIMITER:{async limit(){return {success:true};}},MCP_ORIGIN:ORIGIN,MCP_OAUTH_CLIENTS_JSON:JSON.stringify([{client_id:CLIENT,client_name:'Synthetic client <unsafe>',redirect_uris:[REDIRECT]}])};
  const request=(path,options={})=>worker.fetch(new Request(path.startsWith('http')?path:ORIGIN+path,options),env);
  const api=async(token,path,body,method=body===undefined?'GET':'POST')=>{const r=await request(path,{method,headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
  const invite=async(name,profile='coordinator',projects=['alpha','beta'])=>(await api(OWNER,'/api/principals',{name,account:'synthetic',profile,projects})).body;
  const session=async(actor,label='Synthetic session',project='alpha')=>(await api(actor.token,'/api/sessions',{externalId:crypto.randomUUID(),machine:'synthetic',label,project,task:'Synthetic MCP transport test',status:'RUNNING'})).body.session;
  const actor=await invite('Coordinator <script>'),own=await session(actor),second=await session(actor,'Other owned chat'),peer=await invite('Peer','agent'),peerSession=await session(peer),foreign=await invite('Foreign','agent',['gamma']),outside=await session(foreign,'Other project','gamma');
  const postForm=(path,data,headers={})=>request(path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...headers},body:typeof data==='string'?data:new URLSearchParams(data)});
  const begin=async(changes={})=>{const params={response_type:'code',client_id:CLIENT,redirect_uri:REDIRECT,resource:RESOURCE,scope:'hub:read hub:message',state:'synthetic-state-01234567890123456789',code_challenge:await pkce(verifier),code_challenge_method:'S256',...changes};const r=await request('/oauth/authorize?'+new URLSearchParams(params)),body=await r.text();return {r,body,request_id:body.match(/name="request_id" value="([^"]+)"/)?.[1],cookie:r.headers.get('set-cookie')?.split(';')[0],params};};
  const review=(b,changes={})=>postForm('/oauth/authorize',{action:'review',request_id:b.request_id,invitation:actor.token,session_id:own.id,project:'alpha',...changes},{origin:ORIGIN,cookie:b.cookie});
  const approve=(b,changes={})=>postForm('/oauth/authorize',{action:'approve',request_id:b.request_id,...changes},{origin:ORIGIN,cookie:b.cookie});
  const consent=async(changes={})=>{const b=await begin(changes);assert.equal(b.r.status,200,b.body);let r=await review(b);assert.equal(r.status,200,await r.clone().text());r=await approve(b);assert.equal(r.status,303,await r.clone().text());const location=new URL(r.headers.get('location'));assert.equal(location.searchParams.get('iss'),ORIGIN);return {b,code:location.searchParams.get('code')};};
  const exchange=(code,changes={})=>postForm('/oauth/token',{grant_type:'authorization_code',client_id:CLIENT,resource:RESOURCE,code,redirect_uri:REDIRECT,code_verifier:verifier,...changes});
  const connect=async(changes={})=>{const consented=await consent(changes);const r=await exchange(consented.code);assert.equal(r.status,200,await r.clone().text());return {...consented,...await r.json()};};
  const rpc=async(token,method,params={},changes={})=>{const r=await request('/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream',...changes.headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params,...changes.body})});return {status:r.status,headers:r.headers,body:r.status===202?null:await r.json()};};
  const call=(token,name,args={})=>rpc(token,'tools/call',{name,arguments:args});
  return {DB,env,request,api,invite,session,actor,own,second,peer,peerSession,foreign,outside,postForm,begin,review,approve,consent,exchange,connect,rpc,call};
}
const sendArgs=(f,changes={})=>({toSessionId:f.peerSession.id,kind:'NOTE',body:'Synthetic authorized coordination',idempotencyKey:crypto.randomUUID(),userAuthorized:true,...changes});
const refresh=(f,tokens,changes={})=>f.postForm('/oauth/token',{grant_type:'refresh_token',client_id:CLIENT,resource:RESOURCE,refresh_token:tokens.refresh_token,...changes});

test('metadata and all MCP methods require the intended configuration and authorization',async t=>{
  const f=await fixture(t);let r=await f.request('/.well-known/oauth-protected-resource/mcp');assert.equal(r.status,200);assert.equal((await r.json()).resource,RESOURCE);
  r=await f.request('/.well-known/oauth-authorization-server');const discovery=await r.json();assert.deepEqual(discovery.code_challenge_methods_supported,['S256']);assert.deepEqual(discovery.token_endpoint_auth_methods_supported,['none']);assert.equal(discovery.authorization_response_iss_parameter_supported,true);assert.equal(discovery.registration_endpoint,undefined);
  for(const token of ['',OWNER,f.actor.token]){const result=await f.rpc(token,'tools/list');assert.equal(result.status,401);assert.match(result.headers.get('www-authenticate'),/resource_metadata/);}
  assert.equal((await f.request('http://hub.test/oauth/token',{method:'POST',body:'fixture'})).status,403);
  assert.equal((await f.request('https://wrong.test/.well-known/oauth-authorization-server')).status,503);
  delete f.env.MCP_ORIGIN;assert.equal((await f.request('/mcp')).status,503);
});

test('scoped consent, PKCE, discovery and reads preserve exact identity and do not leak credentials',async t=>{
  const f=await fixture(t),before=f.DB.database.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  const b=await f.begin();assert.ok(b.cookie);assert.match(b.body,/&lt;unsafe&gt;/);let r=await f.review(b);const preview=await r.text();assert.match(preview,/Coordinator &lt;script&gt;/);assert.ok(preview.includes(f.own.id));assert.ok(!preview.includes(f.actor.token));
  r=await f.approve(b);const code=new URL(r.headers.get('location')).searchParams.get('code');const tokenResponse=await f.exchange(code),tokens=await tokenResponse.json();assert.equal(tokenResponse.status,200);
  const stored=JSON.stringify(f.DB.database.prepare('SELECT * FROM mcp_oauth_requests').all())+JSON.stringify(f.DB.database.prepare('SELECT * FROM mcp_oauth_grants').all())+JSON.stringify(f.DB.database.prepare('SELECT * FROM mcp_oauth_tokens').all());for(const secret of [f.actor.token,code,tokens.access_token,tokens.refresh_token])assert.ok(!stored.includes(secret));
  let result=await f.rpc(tokens.access_token,'initialize',{protocolVersion:'2025-11-25'});assert.equal(result.status,200);assert.equal(result.body.result.protocolVersion,'2025-11-25');
  result=await f.rpc(tokens.access_token,'tools/list');assert.deepEqual(result.body.result.tools.map(t=>t.name),['hub_connection_info','hub_list_sessions','hub_read_conversations','hub_read_inbox','hub_send_message']);
  result=await f.call(tokens.access_token,'hub_connection_info');assert.equal(result.body.result.structuredContent.sessionId,f.own.id);assert.equal(result.body.result.structuredContent.principal.id,f.actor.principal.id);
  result=await f.call(tokens.access_token,'hub_list_sessions');assert.equal(result.body.result.isError,false);assert.ok(result.body.result.structuredContent.sessions.every(s=>s.project==='alpha'));
  assert.equal((await f.api(tokens.access_token,'/api/me')).status,401);assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,before);
});

test('consent rejects owner, ordinary agent, observer, foreign session, other project and merged session',async t=>{
  const f=await fixture(t),observer=await f.invite('Observer','observer');
  for(const changes of [{invitation:OWNER},{invitation:f.peer.token},{invitation:observer.token},{session_id:f.peerSession.id},{project:'gamma'},{session_id:f.outside.id}]){const b=await f.begin();assert.equal((await f.review(b,changes)).status,403);}
  const b=await f.begin();await f.api(f.actor.token,'/api/sessions/'+f.second.id+'/merge',{targetSessionId:f.own.id});
  // A distinct external ID cannot merge, so use a direct synthetic alias fixture.
  f.DB.database.prepare('INSERT INTO session_aliases VALUES (?,?,?,?,?,?)').run(f.second.id,f.own.id,new Date().toISOString(),f.actor.principal.id,'{}','{}');
  assert.equal((await f.review(b,{session_id:f.second.id})).status,403);
});

test('review is immutable and approval is bound to the verified session',async t=>{
  const f=await fixture(t),b=await f.begin();assert.equal((await f.review(b)).status,200);assert.equal((await f.review(b,{session_id:f.second.id})).status,409);
  assert.equal((await f.approve(b,{session_id:f.second.id})).status,400);assert.equal((await f.approve(b)).status,303);assert.equal((await f.approve(b)).status,403);
  assert.equal(f.DB.database.prepare('SELECT session_id FROM mcp_oauth_grants').get().session_id,f.own.id);
});

test('consent requires browser CSRF, same origin and fresh active identity at approval',async t=>{
  const f=await fixture(t),b=await f.begin();assert.equal((await f.postForm('/oauth/authorize',{action:'review',request_id:b.request_id,invitation:f.actor.token,session_id:f.own.id,project:'alpha'},{origin:ORIGIN})).status,403);
  assert.equal((await f.postForm('/oauth/authorize',{action:'approve',request_id:b.request_id},{origin:'https://evil.test',cookie:b.cookie})).status,403);
  assert.equal((await f.approve(b)).status,400);assert.equal((await f.review(b)).status,200);
  await f.api(OWNER,'/api/principals/'+f.actor.principal.id,{profile:'observer'},'PATCH');assert.equal((await f.approve(b)).status,403);
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_grants').get().n,0);
});

test('authorization rejects open redirects, wrong audiences, plain PKCE, broad scopes and duplicate parameters',async t=>{
  const f=await fixture(t);
  for(const changes of [{redirect_uri:'https://evil.test/callback'},{resource:'https://other.test/mcp'},{scope:'hub:read owner:admin'},{code_challenge_method:'plain'},{client_id:'other'},{state:'short'}])assert.equal((await f.begin(changes)).r.status,400);
  const b=await f.begin();assert.equal((await f.request('/oauth/authorize?'+new URLSearchParams(b.params)+'&client_id=test-client')).status,400);
});

test('code exchange enforces every binding and codes can only be consumed once',async t=>{
  const f=await fixture(t),{code}=await f.consent();
  for(const changes of [{client_id:'other'},{redirect_uri:'https://evil.test/callback'},{resource:ORIGIN+'/other'},{code_verifier:'wrong-but-long-enough-012345678901234567890123456789'},{scope:'hub:read'}])assert.equal((await f.exchange(code,changes)).status,400);
  const results=await Promise.all([f.exchange(code),f.exchange(code)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);
  assert.equal(f.DB.database.prepare("SELECT COUNT(*) AS n FROM mcp_oauth_tokens WHERE kind='access'").get().n,1);
});

test('read-only consent has no write tool, and forged arguments cannot expand project/session access',async t=>{
  const f=await fixture(t),tokens=await f.connect({scope:'hub:read'}),list=await f.rpc(tokens.access_token,'tools/list');assert.equal(list.body.result.tools.some(t=>t.name==='hub_send_message'),false);
  for(const [name,args] of [['hub_send_message',sendArgs(f)],['hub_list_sessions',{project:'beta'}],['hub_read_inbox',{sessionId:f.second.id}],['hub_read_conversations',{project:'gamma'}],['hub_read_inbox',{limit:1000}],['hub_read_conversations',{latest:false}],['hub_claim_ownership',{}]])assert.ok((await f.call(tokens.access_token,name,args)).body.error);
  const result=await f.call(tokens.access_token,'hub_read_conversations',{sessionId:f.outside.id});assert.equal(result.body.result.isError,true);
});

test('messages use fixed sender/project and require authorization without owner or session-state control',async t=>{
  const f=await fixture(t),tokens=await f.connect(),args=sendArgs(f);
  for(const bad of [{...args,userAuthorized:false},{...args,kind:'HANDOFF'},{...args,fromSessionId:f.second.id},{...args,project:'beta'},{...args,ownerRelay:{ownerProvided:true,sourceReference:'synthetic'}}]){const r=await f.call(tokens.access_token,'hub_send_message',bad);assert.ok(r.body.error||r.body.result.isError);}
  let result=await f.call(tokens.access_token,'hub_send_message',args);assert.equal(result.body.result.isError,false,JSON.stringify(result.body));
  let rows=f.DB.database.prepare('SELECT * FROM messages').all();assert.equal(rows.length,1);assert.equal(rows[0].from_session_id,f.own.id);assert.equal(rows[0].from_principal_id,f.actor.principal.id);assert.equal(rows[0].project,'alpha');
  result=await f.call(tokens.access_token,'hub_send_message',args);assert.equal(result.body.result.isError,false);assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);
  result=await f.call(tokens.access_token,'hub_send_message',sendArgs(f,{toSessionId:f.outside.id}));assert.equal(result.body.result.isError,true);
});

test('owner answer relay stays verbatim, delegate-reported and leaves question custody unchanged',async t=>{
  const f=await fixture(t),question=(await f.api(f.peer.token,'/api/messages',{fromSessionId:f.peerSession.id,project:'alpha',kind:'QUESTION',body:'Synthetic question for owner',idempotencyKey:'owner-question'})).body.message;
  const before=f.DB.database.prepare('SELECT * FROM messages WHERE id=?').get(question.id),tokens=await f.connect();
  const read=await f.call(tokens.access_token,'hub_read_conversations');assert.equal(read.body.result.structuredContent.messages[0].body,'Synthetic question for owner');
  const answer='  Synthetic exact human answer.\nKeep these bytes.  ';
  const result=await f.call(tokens.access_token,'hub_send_message',sendArgs(f,{kind:'ANSWER',body:answer,replyTo:question.id,ownerRelay:{ownerProvided:true,sourceReference:'Synthetic human turn 42'}}));assert.equal(result.body.result.isError,false,JSON.stringify(result.body));
  const saved=f.DB.database.prepare("SELECT * FROM messages WHERE kind='ANSWER'").get();assert.equal(saved.body,answer);assert.equal(saved.from_principal_id,f.actor.principal.id);assert.equal(saved.owner_relay_reference,'Synthetic human turn 42');assert.deepEqual(f.DB.database.prepare('SELECT * FROM messages WHERE id=?').get(question.id),before);
});

test('refresh rotation and replay revoke the entire grant',async t=>{
  const f=await fixture(t),tokens=await f.connect();let r=await refresh(f,tokens);assert.equal(r.status,200);const next=await r.json();assert.notEqual(next.refresh_token,tokens.refresh_token);
  assert.equal((await f.rpc(next.access_token,'tools/list')).status,200);r=await refresh(f,tokens);assert.equal(r.status,400);assert.equal((await f.rpc(next.access_token,'tools/list')).status,401);assert.equal((await f.rpc(tokens.access_token,'tools/list')).status,401);
});

test('revocation endpoint is idempotent and revokes both access and refresh',async t=>{
  const f=await fixture(t),tokens=await f.connect();for(let i=0;i<2;i++)assert.equal((await f.postForm('/oauth/revoke',{client_id:CLIENT,token:tokens.refresh_token})).status,200);
  assert.equal((await f.rpc(tokens.access_token,'tools/list')).status,401);assert.equal((await refresh(f,tokens)).status,400);
});

test('profile, project, credential, session and grant changes immediately invalidate resource access',async t=>{
  for(const change of ['profile','project','credential','archive','merge','grant','access','grant-expiry']){
    const f=await fixture(t),tokens=await f.connect();
    if(change==='profile')f.DB.database.prepare('UPDATE principals SET coordinator_access=0 WHERE id=?').run(f.actor.principal.id);
    if(change==='project')f.DB.database.prepare("UPDATE principals SET projects_json='[\"beta\"]' WHERE id=?").run(f.actor.principal.id);
    if(change==='credential')f.DB.database.prepare("UPDATE principals SET token_hash='replacement-synthetic-hash' WHERE id=?").run(f.actor.principal.id);
    if(change==='archive')f.DB.database.prepare("UPDATE sessions SET archived_at='2026-01-01' WHERE id=?").run(f.own.id);
    if(change==='merge')f.DB.database.prepare('INSERT INTO session_aliases VALUES (?,?,?,?,?,?)').run(f.own.id,f.second.id,new Date().toISOString(),f.actor.principal.id,'{}','{}');
    if(change==='grant')f.DB.database.prepare('UPDATE mcp_oauth_grants SET revoked_at=1').run();
    if(change==='access')f.DB.database.prepare("UPDATE mcp_oauth_tokens SET expires_at=1 WHERE kind='access'").run();
    if(change==='grant-expiry')f.DB.database.prepare('UPDATE mcp_oauth_grants SET expires_at=1').run();
    assert.equal((await f.rpc(tokens.access_token,'tools/list')).status,401,change);
  }
});

test('mutation predicates stop revocation and token expiration at the actual write boundary',async t=>{
  for(const change of ['grant','access','project','archive']){
    const f=await fixture(t),tokens=await f.connect(),original=f.DB.batch.bind(f.DB);let invoked=false;
    f.DB.batch=async statements=>{if(!invoked){invoked=true;if(change==='grant')f.DB.database.prepare('UPDATE mcp_oauth_grants SET revoked_at=1').run();if(change==='access')f.DB.database.prepare("UPDATE mcp_oauth_tokens SET expires_at=1 WHERE kind='access'").run();if(change==='project')f.DB.database.prepare("UPDATE principals SET projects_json='[]' WHERE id=?").run(f.actor.principal.id);if(change==='archive')f.DB.database.prepare("UPDATE sessions SET archived_at='2026-01-01' WHERE id=?").run(f.own.id);}return original(statements);};
    const result=await f.call(tokens.access_token,'hub_send_message',sendArgs(f));assert.equal(result.status,401,change);assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0,change);assert.equal(invoked,true);
  }
});

test('invalid protocol, Origin, body and notification requests cannot trigger messages',async t=>{
  const f=await fixture(t),tokens=await f.connect();
  assert.equal((await f.rpc(tokens.access_token,'tools/list',{}, {headers:{origin:'https://evil.test'}})).status,403);
  assert.equal((await f.rpc(tokens.access_token,'tools/list',{}, {headers:{'mcp-protocol-version':'not-a-protocol'}})).status,400);
  assert.equal((await f.rpc(tokens.access_token,'tools/list',{}, {headers:{accept:'application/json'}})).status,406);
  const request={jsonrpc:'2.0',method:'tools/call',params:{name:'hub_send_message',arguments:sendArgs(f)}};
  let r=await f.request('/mcp',{method:'POST',headers:{authorization:'Bearer '+tokens.access_token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify(request)});assert.equal((await r.json()).error.code,-32600);assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0);
  r=await f.request('/mcp',{headers:{authorization:'Bearer '+tokens.access_token}});assert.equal(r.status,405);
  const initialized=await f.rpc(tokens.access_token,'notifications/initialized',{}, {body:{id:undefined}});assert.equal(initialized.status,202);
  r=await f.request('/mcp',{method:'POST',headers:{authorization:'Bearer '+tokens.access_token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:' '.repeat(17000)});assert.equal(r.status,413);
});

test('capacity guards bound pending consent and refresh token accumulation',async t=>{
  const f=await fixture(t),tokens=await f.connect(),grant=f.DB.database.prepare('SELECT * FROM mcp_oauth_grants').get();
  for(let i=0;i<150;i++)f.DB.database.prepare("INSERT INTO mcp_oauth_tokens(token_hash,grant_id,kind,expires_at,created_at) VALUES (?,?,'refresh',?,?)").run('synthetic-refresh-'+i,grant.id,now()+3600,now());
  assert.equal((await refresh(f,tokens)).status,429);assert.equal((await f.rpc(tokens.access_token,'tools/list')).status,200);
  const request=f.DB.database.prepare('INSERT INTO mcp_oauth_requests(id_hash,csrf_hash,client_id,redirect_uri,resource,scope,state,challenge,expires_at) VALUES (?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<1000;i++)request.run('synthetic-request-'+i,'synthetic-csrf',CLIENT,REDIRECT,RESOURCE,'hub:read','synthetic-state','synthetic-challenge',now()+600);
  assert.equal((await f.begin()).r.status,429);
});

test('ANSWER without explicit owner provenance is rejected and pagination is usable',async t=>{
  const f=await fixture(t),tokens=await f.connect();
  const answer=await f.call(tokens.access_token,'hub_send_message',sendArgs(f,{kind:'ANSWER'}));assert.equal(answer.body.result.isError,true);assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0);
  const first=(await f.call(tokens.access_token,'hub_list_sessions',{limit:1})).body.result.structuredContent;assert.equal(first.hasMore,true);assert.equal(first.nextOffset,1);
  const next=(await f.call(tokens.access_token,'hub_list_sessions',{limit:1,offset:first.nextOffset})).body.result.structuredContent;assert.notEqual(next.sessions[0].id,first.sessions[0].id);
});

test('OAuth edge rate limiting fails closed before any database query',async t=>{
  const f=await fixture(t);let touched=false;f.env.DB={withSession(){touched=true;throw new Error('Must not touch DB');}};
  f.env.MCP_AUTH_RATE_LIMITER={async limit(){return {success:false};}};
  let r=await f.request('/oauth/authorize');assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'60');assert.equal(touched,false);
  delete f.env.MCP_AUTH_RATE_LIMITER;r=await f.request('/oauth/authorize');assert.equal(r.status,503);assert.equal(touched,false);
});

test('concurrent refresh replay invalidates the complete family without duplicate issuance',async t=>{
  const f=await fixture(t),tokens=await f.connect();const results=await Promise.all([refresh(f,tokens),refresh(f,tokens)]);assert.ok(results.some(r=>r.status===400));assert.ok(results.every(r=>[200,400,401].includes(r.status)));
  assert.equal((await f.rpc(tokens.access_token,'tools/list')).status,401);
  assert.equal(f.DB.database.prepare("SELECT COUNT(*) AS n FROM mcp_oauth_tokens WHERE kind='refresh'").get().n,2);
});

test('expiry and authority changes between review and grant insertion prevent any grant',async t=>{
  const f=await fixture(t),b=await f.begin();await f.review(b);const original=f.DB.batch.bind(f.DB);let count=0;
  f.DB.batch=async statements=>{count++;if(count===2)f.DB.database.prepare("UPDATE sessions SET archived_at='2026-01-01' WHERE id=?").run(f.own.id);return original(statements);};
  const result=await f.approve(b);assert.equal(result.status,409);assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_grants').get().n,0);
});

test('access tokens remain valid after a capacity refusal and refresh evidence survives cleanup',async t=>{
  const f=await fixture(t),tokens=await f.connect();let r=await refresh(f,tokens);const next=await r.json();
  const used=await sha(tokens.refresh_token);assert.ok(f.DB.database.prepare('SELECT consumed_by FROM mcp_oauth_tokens WHERE token_hash=?').get(used).consumed_by);
  // Starting another consent only clears expired browser transactions, never replay evidence.
  await f.begin();assert.ok(f.DB.database.prepare('SELECT consumed_by FROM mcp_oauth_tokens WHERE token_hash=?').get(used));assert.equal((await f.rpc(next.access_token,'tools/list')).status,200);
});

test('expired unexchanged consent does not trap grant capacity for a week',async t=>{
  const f=await fixture(t);await f.consent();assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_grants').get().n,1);
  f.DB.database.prepare("UPDATE mcp_oauth_tokens SET expires_at=1 WHERE kind='code'").run();
  const tokens=await f.connect();assert.equal((await f.rpc(tokens.access_token,'tools/list')).status,200);assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_grants').get().n,1);
});

test('empty-client bootstrap exposes metadata and an OAuth challenge but never tools or data',async t=>{
  const f=await fixture(t);for(const setting of [undefined,'[]']){
    if(setting===undefined)delete f.env.MCP_OAUTH_CLIENTS_JSON;else f.env.MCP_OAUTH_CLIENTS_JSON=setting;
    const metadata=await f.request('/.well-known/oauth-protected-resource/mcp');assert.equal(metadata.status,200);assert.equal((await metadata.json()).resource,RESOURCE);
    for(const method of ['initialize','tools/list','tools/call']){const r=await f.rpc(f.actor.token,method);assert.equal(r.status,401);assert.match(r.headers.get('www-authenticate'),/hub:read hub:message/);}
    const b=await f.begin();assert.equal(b.r.status,400);assert.equal(b.cookie,undefined);assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_requests').get().n,0);
  }
});

test('client removal suspends existing access, refresh and pending consent without broadening access',async t=>{
  const f=await fixture(t),tokens=await f.connect(),b=await f.begin();await f.review(b);const config=f.env.MCP_OAUTH_CLIENTS_JSON;delete f.env.MCP_OAUTH_CLIENTS_JSON;
  assert.equal((await f.rpc(tokens.access_token,'tools/list')).status,401);assert.equal((await refresh(f,tokens)).status,400);assert.equal((await f.approve(b)).status,400);assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_grants').get().n,1);
  f.env.MCP_OAUTH_CLIENTS_JSON=config;assert.equal((await f.rpc(tokens.access_token,'tools/list')).status,200);
});

test('bootstrap defaults only missing client config and keeps malformed configuration closed',async t=>{
  const f=await fixture(t);for(const config of ['', 'null', '{}', '[null]', '[{}]', 'not-json']){f.env.MCP_OAUTH_CLIENTS_JSON=config;assert.equal((await f.request('/.well-known/oauth-authorization-server')).status,503,config);}
});

test('OAuth authorization ignores unrecognized extensions without reflecting or persisting them',async t=>{
  const f=await fixture(t),b=await f.begin({prompt:'consent',access_type:'offline',login_hint:'synthetic@example.test',extension_data:'synthetic-extension-marker',project:'gamma',principal_id:'owner',session_id:f.peerSession.id,invitation:'synthetic-untrusted-extension',action:'approve'});
  assert.equal(b.r.status,200);assert.ok(!b.body.includes('synthetic-extension-marker'));assert.ok(!b.body.includes('synthetic@example.test'));
  const row=f.DB.database.prepare('SELECT * FROM mcp_oauth_requests').get();assert.equal(row.scope,'hub:read hub:message');assert.equal(row.project,null);assert.equal(row.principal_id,null);assert.ok(!JSON.stringify(row).includes('synthetic-extension-marker'));
  assert.equal((await f.review(b)).status,200);assert.equal((await f.approve(b)).status,303);const grant=f.DB.database.prepare('SELECT * FROM mcp_oauth_grants').get();assert.equal(grant.project,'alpha');assert.equal(grant.session_id,f.own.id);assert.equal(grant.principal_id,f.actor.principal.id);
});

test('OAuth code exchange and refresh ignore extensions while preserving token bindings',async t=>{
  const f=await fixture(t),{code}=await f.consent({prompt:'consent'});
  let r=await f.exchange(code,{extension_flag:'enabled',audience:'https://unrelated.test',resource:ORIGIN+'/wrong'});assert.equal(r.status,400);
  r=await f.exchange(code,{extension_flag:'enabled',audience:'https://unrelated.test'});assert.equal(r.status,200);const tokens=await r.json();
  r=await refresh(f,tokens,{extension_flag:'enabled',audience:'https://unrelated.test'});assert.equal(r.status,200);const next=await r.json();assert.equal((await f.rpc(next.access_token,'tools/list')).status,200);
  assert.equal(f.DB.database.prepare('SELECT resource FROM mcp_oauth_grants').get().resource,RESOURCE);
});

test('known invalid OAuth values remain invalid when extension parameters are present',async t=>{
  const f=await fixture(t);for(const changes of [{client_id:'other'},{redirect_uri:'https://evil.test/callback'},{resource:'https://other.test/mcp'},{scope:'hub:read owner:admin'},{code_challenge_method:'plain'},{response_type:'token'}])assert.equal((await f.begin({prompt:'consent',...changes})).r.status,400);
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_requests').get().n,0);
});

test('duplicate OAuth parameters still fail, including unrecognized extensions',async t=>{
  const f=await fixture(t),b=await f.begin();assert.equal((await f.request('/oauth/authorize?'+new URLSearchParams(b.params)+'&prompt=one&prompt=two')).status,400);
  const {code}=await f.consent();const params=new URLSearchParams({grant_type:'authorization_code',client_id:CLIENT,resource:RESOURCE,code,redirect_uri:REDIRECT,code_verifier:verifier});
  assert.equal((await f.postForm('/oauth/token',params.toString()+'&extension=one&extension=two')).status,400);assert.equal((await f.exchange(code)).status,200);
});

test('unsupported client authentication remains rejected rather than ignored as an extension',async t=>{
  const f=await fixture(t),{code}=await f.consent();for(const changes of [{client_secret:'synthetic-not-a-secret'},{client_assertion:'synthetic-not-an-assertion'},{client_assertion_type:'unsupported'},{client_secret:''},{client_assertion:''},{client_assertion_type:''}])assert.equal((await f.exchange(code,changes)).status,400);
  assert.equal((await f.exchange(code)).status,200);
});

test('request-object extensions cannot replace required security parameters',async t=>{
  const f=await fixture(t),b=await f.begin();for(const omitted of ['client_id','redirect_uri','resource','code_challenge','code_challenge_method']){
    const params={...b.params,request:'synthetic-unsigned-request-object',request_uri:'https://unrelated.test/request-object'};delete params[omitted];
    assert.equal((await f.request('/oauth/authorize?'+new URLSearchParams(params))).status,400,omitted);
  }
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_requests').get().n,1);
});

test('extension compatibility never relaxes consent-form or MCP tool argument validation',async t=>{
  const f=await fixture(t),b=await f.begin();assert.equal((await f.review(b,{unknown_extension:'synthetic'})).status,400);
  assert.equal(f.DB.database.prepare('SELECT principal_id FROM mcp_oauth_requests').get().principal_id,null);
  const tokens=await f.connect(),result=await f.call(tokens.access_token,'hub_read_inbox',{unknown_extension:'synthetic'});assert.equal(result.body.error.code,-32602);
});

test('consent HTML uses strict-origin while token, metadata and redirect responses stay no-referrer',async t=>{
  const f=await fixture(t),b=await f.begin();assert.equal(b.r.headers.get('referrer-policy'),'strict-origin');assert.match(b.r.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(b.r.headers.get('content-security-policy'),/form-action 'self'/);
  let r=await f.review(b);assert.equal(r.status,200);assert.equal(r.headers.get('referrer-policy'),'strict-origin');assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  r=await f.approve(b);assert.equal(r.status,303);assert.equal(r.headers.get('referrer-policy'),'no-referrer');const code=new URL(r.headers.get('location')).searchParams.get('code');r=await f.exchange(code);assert.equal(r.status,200);assert.equal(r.headers.get('referrer-policy'),'no-referrer');
  r=await f.request('/.well-known/oauth-authorization-server');assert.equal(r.headers.get('referrer-policy'),'no-referrer');
});

test('consent keeps exact Origin and browser CSRF requirements, including rejection of null Origin',async t=>{
  const f=await fixture(t),b=await f.begin();const form={action:'review',request_id:b.request_id,invitation:f.actor.token,session_id:f.own.id,project:'alpha'};
  for(const origin of ['null','https://evil.test','https://hub.test.evil.test']){const r=await f.postForm('/oauth/authorize',form,{origin,cookie:b.cookie});assert.equal(r.status,403);assert.equal(r.headers.get('referrer-policy'),'no-referrer');}
  assert.equal((await f.postForm('/oauth/authorize',form,{cookie:b.cookie})).status,403);
  assert.equal((await f.postForm('/oauth/authorize',form,{origin:ORIGIN})).status,403);
  assert.equal((await f.review(b)).status,200);assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_grants').get().n,0);
  const selected=f.DB.database.prepare('SELECT * FROM mcp_oauth_requests').get();
  for(const action of ['approve','deny'])for(const origin of ['null','https://evil.test','http://hub.test','https://hub.test:444']){assert.equal((await f.postForm('/oauth/authorize',{action,request_id:b.request_id},{origin,cookie:b.cookie})).status,403);assert.deepEqual(f.DB.database.prepare('SELECT * FROM mcp_oauth_requests').get(),selected);}
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_grants').get().n,0);assert.equal((await f.approve(b)).status,303);
});
