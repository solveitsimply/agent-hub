import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {SqliteD1} from './d1-sqlite.mjs';

const OWNER='synthetic-owner-for-local-test-only-1234567890';
function fixture(t){
  const DB=new SqliteD1();t.after(()=>DB.close());
  return {DB,async call(token,path,body,method=body===undefined?'GET':'POST'){
    const headers={authorization:'Bearer '+token};if(body!==undefined)headers['content-type']='application/json';
    const response=await worker.fetch(new Request('https://hub.test'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),{DB,OWNER_TOKEN:OWNER});
    return {status:response.status,body:await response.json()};
  }};
}
async function invite(f,name,projects=['shared']){
  const result=await f.call(OWNER,'/api/principals',{name,account:name+'@example.test',projects});
  assert.equal(result.status,201);return result.body;
}
async function register(f,actor,overrides={}){
  const result=await f.call(actor.token,'/api/sessions',{externalId:'codex:'+crypto.randomUUID(),machine:'reviewer-workstation.local',label:'Continue reviewed work',project:'shared',task:'Verify source',status:'RUNNING',...overrides});
  assert.equal(result.status,201);return (await f.call(OWNER,'/api/sessions')).body.sessions.find(s=>s.id===result.body.session.id);
}
async function attribute(f,actor,session,client,model,previousSegmentId=null){
  const result=await f.call(actor.token,`/api/sessions/${session.id}/attribution`,{provider:'test-provider',client,model,previousSegmentId,idempotencyKey:crypto.randomUUID()});
  assert.equal(result.status,201);return result.body.segment;
}

test('an in-app rename preserves stable session identity, attribution and ownership',async t=>{
  const f=fixture(t),actor=await invite(f,'title-agent'),session=await register(f,actor);
  const segment=await attribute(f,actor,session,'Codex','GPT-6.1 Sol');
  await f.call(actor.token,'/api/ownership/claim',{sessionId:session.id,resourceKey:'review/source'});
  const renamed=await f.call(actor.token,`/api/sessions/${session.id}`,{label:'Review collection contract bindings'},'PATCH');
  assert.equal(renamed.status,200);
  const humanView=(await f.call(OWNER,'/api/sessions')).body.sessions.find(s=>s.id===session.id);for(const key of ['id','externalId','machine','project','principalId','status','task'])assert.equal(humanView[key],session[key]);assert.equal(humanView.label,'Review collection contract bindings');assert.match(renamed.body.session.label,/^Session /);
  assert.deepEqual(humanView.latestAttribution,{provider:'test-provider',client:'Codex',model:'GPT-6.1 Sol'});assert.equal(renamed.body.session.latestAttribution,null);
  const history=await f.call(actor.token,`/api/sessions/${session.id}/attribution`);
  assert.equal(history.body.segments.length,1);assert.equal(history.body.segments[0].id,segment.id);
  assert.equal(f.DB.database.prepare('SELECT owner_session_id FROM ownership').get().owner_session_id,session.id);
});

test('rename remains owner-only, active-only and refuses credentials or identity changes',async t=>{
  const f=fixture(t),actor=await invite(f,'owned'),foreign=await invite(f,'foreign'),session=await register(f,actor);
  for(const token of [foreign.token,OWNER])assert.equal((await f.call(token,`/api/sessions/${session.id}`,{label:'Impersonation'},'PATCH')).status,403);
  for(const body of [{label:''},{label:'x'.repeat(121)},{label:'sk-'+ 'x'.repeat(24)},{label:'Rename',externalId:'another-session'}])
    assert.equal((await f.call(actor.token,`/api/sessions/${session.id}`,body,'PATCH')).status,422);
  await f.call(actor.token,`/api/sessions/${session.id}`,{status:'DONE'},'PATCH');
  await f.call(actor.token,`/api/sessions/${session.id}/archive`,{});
  assert.equal((await f.call(actor.token,`/api/sessions/${session.id}`,{label:'After archive'},'PATCH')).status,409);
  assert.equal(f.DB.database.prepare('SELECT label FROM sessions WHERE id=?').get(session.id).label,session.label);
});

test('filters use only latest reporting segments and execution machine, with distinct Unknown semantics',async t=>{
  const f=fixture(t),actor=await invite(f,'filters'),privateActor=await invite(f,'private',['private']);
  const switched=await register(f,actor,{label:'Codex old title',environment:'dev'});
  const initial=await attribute(f,actor,switched,'Codex','GPT-6.1 Sol');
  await attribute(f,actor,switched,'Claude','Opus 5.5',initial.id);
  const unknownModel=await register(f,actor,{machine:'Codex Cloud - Default',environment:'production',label:'Gemini misleading title'});
  await attribute(f,actor,unknownModel,'Codex',null);
  const noSegment=await register(f,actor);
  const literalUnknown=await register(f,actor);await attribute(f,actor,literalUnknown,'unknown',null);
  const privateSession=await register(f,privateActor,{project:'private',machine:'private-host'});await attribute(f,privateActor,privateSession,'private-agent','private-model');
  let result=await f.call(OWNER,'/api/sessions?project=shared&agentName=Claude&agentModel=Opus%205.5&machine=reviewer-workstation.local');
  assert.equal(result.status,200);assert.equal(result.body.total,1);assert.equal(result.body.sessions[0].id,switched.id);
  assert.deepEqual(new Set(result.body.filterOptions.agentNames),new Set(['Codex','Claude','unknown',null]));
  assert.equal(result.body.filterOptions.machines.includes('private-host'),false);
  result=await f.call(actor.token,'/api/sessions?agentName=Codex&agentModelUnknown=1&machine=Codex%20Cloud%20-%20Default');
  assert.equal(result.body.total,1);assert.equal(result.body.sessions[0].id,unknownModel.id);
  assert.equal((await f.call(actor.token,'/api/sessions?agentModel=GPT-6.1%20Sol')).body.total,0);
  assert.equal((await f.call(actor.token,'/api/sessions?agentNameUnknown=1')).body.sessions[0].id,noSegment.id);
  assert.equal((await f.call(actor.token,'/api/sessions?agentName=unknown')).body.sessions[0].id,literalUnknown.id);
  assert.equal((await f.call(actor.token,'/api/sessions?agentName=Codex&agentNameUnknown=1')).status,422);
  assert.equal((await f.call(actor.token,'/api/sessions?agentModelUnknown=false')).status,422);
  assert.equal((await f.call(actor.token,'/api/sessions?project=private')).status,403);
});

test('filtering and facet discovery happen before the 200-session display limit',async t=>{
  const f=fixture(t),actors=await Promise.all(['a','b','c'].map(name=>invite(f,name)));
  const target=await register(f,actors[0],{machine:'rare-host'});await attribute(f,actors[0],target,'Gemini','Gemini rare model');
  f.DB.database.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z',target.id);
  for(let index=0;index<201;index++)await register(f,actors[Math.floor(index/75)]);
  const unfiltered=await f.call(OWNER,'/api/sessions?project=shared');
  assert.equal(unfiltered.body.sessions.length,200);assert.equal(unfiltered.body.total,202);
  assert.equal(unfiltered.body.sessions.some(session=>session.id===target.id),false);
  assert.ok(unfiltered.body.filterOptions.agentNames.includes('Gemini'));
  const filtered=await f.call(actors[0].token,'/api/sessions?agentName=Gemini&agentModel=Gemini%20rare%20model&machine=rare-host');
  assert.equal(filtered.body.sessions.length,1);assert.equal(filtered.body.total,1);assert.equal(filtered.body.sessions[0].id,target.id);
});
