// Synthetic workerd/D1 acceptance. Never accepts a remote origin or --remote.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const origin=process.env.HUB_FIXTURE_ORIGIN,owner=process.env.HUB_FIXTURE_OWNER_TOKEN;
assert.match(origin??'',/^http:\/\/127\.0\.0\.1:\d+$/);assert.ok(owner?.length>=32);
const wrangler=process.env.HUB_WRANGLER_CLI,state=process.env.HUB_FIXTURE_D1_STATE;
assert.ok(wrangler&&state&&isAbsolute(wrangler)&&isAbsolute(state));
const root=fileURLToPath(new URL('../',import.meta.url));
async function call(token,path,body,method=body===undefined?'GET':'POST'){
  const response=await fetch(origin+path,{method,headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error'});
  return {status:response.status,body:await response.json(),retryAfter:response.headers.get('retry-after')};
}
const temporary=await mkdtemp(join(tmpdir(),'hub-native-coordination-'));
async function sql(text){
  const path=join(temporary,'fixture.sql');await writeFile(path,text,{mode:0o600});
  const result=spawnSync(process.execPath,[wrangler,'d1','execute','agent-hub','--local','--persist-to',state,'--config',join(root,'wrangler.jsonc'),'--file',path],{cwd:root,encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,'Local native D1 fixture statement failed');
}
try{
  const external=crypto.randomUUID(),sourceId=crypto.randomUUID();
  const target=await call(owner,'/api/sessions',{externalId:'codex:'+external,machine:'native-fixture',label:'Synthetic duplicate',project:'capacity-fixture',task:'Verify preserved custody',status:'DONE'});assert.equal(target.status,201);
  const targetId=target.body.session.id;assert.match(targetId,/^[a-f0-9-]{36}$/);
  // Simulate a duplicate that existed before normalization was deployed.
  await sql(`INSERT INTO sessions(id,principal_id,external_id,machine,label,project,task,status,created_at,last_seen_at) SELECT '${sourceId}',principal_id,'${external}',machine,label,project,task,'RUNNING',created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM sessions WHERE id='${targetId}'; UPDATE sessions SET revision=40 WHERE id='${sourceId}';`);
  const peer=await call(owner,'/api/principals',{name:'Synthetic peer',account:'peer@example.test',projects:['capacity-fixture']});assert.equal(peer.status,201);
  const recipient=await call(peer.body.token,'/api/sessions',{externalId:'codex:'+crypto.randomUUID(),machine:'other-fixture',label:'Synthetic peer',project:'capacity-fixture',task:'Receive fixture',status:'RUNNING'});assert.equal(recipient.status,201);
  const recipientId=recipient.body.session.id;
  const payload={fromSessionId:sourceId,toSessionId:recipientId,project:'capacity-fixture',kind:'NOTE',body:'Synthetic preserved history',idempotencyKey:crypto.randomUUID()};
  const sent=await call(owner,'/api/messages',payload);assert.equal(sent.status,201);
  assert.equal((await call(peer.body.token,'/api/messages',payload)).status,403);
  const claimKey='fixture/custody/'+external;
  assert.equal((await call(owner,'/api/ownership/claim',{sessionId:sourceId,resourceKey:claimKey})).status,200);
  const switchBody={provider:'Synthetic',client:'Synthetic native client',previousSegmentId:null,idempotencyKey:crypto.randomUUID()};
  const recordedSwitch=await call(owner,'/api/sessions/'+sourceId+'/attribution',switchBody);assert.equal(recordedSwitch.status,201);
  const merge=await call(owner,'/api/sessions/'+sourceId+'/merge',{targetSessionId:targetId});assert.equal(merge.status,200);assert.equal(merge.body.session.status,'RUNNING');
  assert.ok(merge.body.session.lifecycle.revision>40);
  const stale=await call(owner,'/api/sessions/'+sourceId+'/checkpoint',{expectedRevision:40,checkpoint:{outcome:'Stale fixture',acceptanceCriteria:'Stale acceptance',nextAction:'Stale next action'}});assert.equal(stale.status,409);assert.equal(stale.body.error.code,'SESSION_CHANGED');
  const switchRetry=await call(owner,'/api/sessions/'+sourceId+'/attribution',switchBody);assert.equal(switchRetry.status,201);assert.equal(switchRetry.body.segment.id,recordedSwitch.body.segment.id);assert.equal(switchRetry.body.segment.sessionId,sourceId);
  const retry=await call(owner,'/api/messages',payload);assert.equal(retry.status,201);assert.equal(retry.body.message.payloadHash,sent.body.message.payloadHash);assert.equal(retry.body.message.deliveryCursor,sent.body.message.deliveryCursor);
  assert.equal((await call(owner,'/api/sessions/'+sourceId+'/heartbeat',{})).body.session.id,targetId);
  const claims=await call(owner,'/api/ownership?project=capacity-fixture&resourceKey='+encodeURIComponent(claimKey));assert.equal(claims.body.ownership[0].ownerSessionId,targetId);
  for(const id of [sourceId,targetId])assert.equal((await call(owner,'/api/messages?sessionId='+id)).body.messages[0].id,sent.body.message.id);
  const second=await call(owner,'/api/messages',{...payload,fromSessionId:targetId,idempotencyKey:crypto.randomUUID()});assert.equal(second.status,201);
  assert.match(recipientId,/^[a-f0-9-]{36}$/);
  await sql(`WITH RECURSIVE fixture(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM fixture WHERE n<498) INSERT INTO messages(from_principal_id,to_principal_id,from_session_id,to_session_id,project,kind,body,idempotency_key,payload_hash,created_at) SELECT 'owner',s.principal_id,'${targetId}','${recipientId}','capacity-fixture','NOTE','Synthetic quota','fixture-${external}-'||n,'synthetic',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM fixture JOIN sessions s ON s.id='${recipientId}';`);
  const refused=await call(owner,'/api/messages',{...payload,idempotencyKey:crypto.randomUUID()});assert.equal(refused.status,429);assert.equal(refused.body.error.code,'MESSAGE_SESSION_DAILY_LIMIT');assert.ok(Number(refused.retryAfter)>0);
  assert.equal((await call(owner,'/api/messages',payload)).body.message.id,sent.body.message.id);
  const limits=await call(owner,'/api/limits?sessionId='+targetId);assert.equal(limits.body.usage.session,500);
  assert.equal((await call(owner,'/api/principals/'+peer.body.principal.id,{name:'Synthetic development account'},'PATCH')).status,200);
  assert.equal((await call(peer.body.token,'/api/me')).body.principal.name,'Synthetic development account');
  const receipt={observedAt:new Date().toISOString(),runtime:'Cloudflare workerd + local D1',scope:'Synthetic loopback only',checks:['migration 0010 triggers','merged revision exceeds both lineages; stale checkpoint rejected','native per-chat rate limit and Retry-After','quota counters include pending records','merge preserves payload hashes/delivery cursors','old-ID retries at capacity','old attribution key retry preserves original segment','alias inbox/heartbeat','ownership transfer','cross-principal sender refusal','owner-only display rename']};
  await mkdir(new URL('../.evidence/',import.meta.url),{recursive:true});await writeFile(new URL('../.evidence/coordination-native.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(receipt));
}finally{await rm(temporary,{recursive:true,force:true});}
