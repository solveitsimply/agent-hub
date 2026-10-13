import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {admitUsage,costPolicy,limitTraffic,usageDay,usageStatus} from '../src/cost-guard.mjs';
import {SqliteD1} from './d1-sqlite.mjs';
const OWNER='synthetic-cost-guard-owner-token-1234567890';
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
function fixture(t,limits={}){
  const raw=new SqliteD1();t.after(()=>raw.close());
  // Deterministic synthetic metering. Provider-native tests verify actual D1 meta.
  const db={prepare(query){let values=[];const statement={
    bind(...parameters){values=parameters;return statement;},
    async all(){const results=raw.database.prepare(query).all(...values);return {results,success:true,meta:{rows_read:results.length+1,rows_written:/^(INSERT|UPDATE|DELETE)/.test(query)?1:0}};},
    async first(column){const result=await statement.all(),row=result.results[0]??null;return column?(row?.[column]??null):row;},
    async run(){const result=await raw.prepare(query).bind(...values).run();return {...result,meta:{...result.meta,rows_read:1,rows_written:result.meta.changes}};},
  };return statement;},async batch(statements){return Promise.all(statements.map(statement=>statement.all()));},withSession(){return db;}};
  const env={DB:db,OWNER_TOKEN:OWNER,HUB_USAGE_LIMITS_JSON:JSON.stringify(limits)};
  const call=(path='/api/me',token=OWNER,extra={})=>worker.fetch(new Request('https://hub.test'+path,{headers:{authorization:'Bearer '+token,...extra}}),env);
  return {raw,db,env,call};
}
test('daily admission is atomic and concurrent callers cannot exceed the request budget',async t=>{
  const f=fixture(t,{requests:3});
  const responses=await Promise.all(Array.from({length:15},()=>f.call()));
  assert.equal(responses.filter(r=>r.status===200).length,3);
  for(const response of responses.filter(r=>r.status!==200)){assert.equal(response.status,429);assert.equal((await response.json()).error.code,'HUB_DAILY_BUDGET');assert.ok(Number(response.headers.get('retry-after'))>0);}
  assert.equal((await usageStatus(f.db,f.env,fail)).used.requests,3);
});
test('metering preserves first column, first row, bound SQL, all and batch results',async t=>{
  const f=fixture(t),usage=await admitUsage(f.db,f.env,fail);
  assert.equal(await usage.db.prepare('SELECT ? AS example UNION ALL SELECT 8').bind(7).first('example'),7);
  assert.equal((await usage.db.prepare('SELECT 9 AS example').first()).example,9);
  assert.equal(await usage.db.prepare('SELECT 1 WHERE 0').first(),null);
  assert.equal((await usage.db.batch([usage.db.prepare('SELECT ? AS n').bind(2)]))[0].results[0].n,2);
  await usage.finish();const status=await usageStatus(f.db,f.env,fail);
  assert.equal(status.used.rowsRead,17);assert.equal(status.used.rowsWritten,10);
});
test('read/write reservations block work before access and remain charged after failed work',async t=>{
  const f=fixture(t,{rowsRead:100,readReservation:100,rowsWritten:100,writeReservation:100});
  const usage=await admitUsage(f.db,f.env,fail);
  await assert.rejects(admitUsage(f.db,f.env,fail),{code:'HUB_DAILY_BUDGET'});
  usage.failed();await usage.finish();
  assert.deepEqual((await usageStatus(f.db,f.env,fail)).used,{requests:1,rowsRead:100,rowsWritten:100});
  await assert.rejects(admitUsage(f.db,f.env,fail),{code:'HUB_DAILY_BUDGET'});
});
test('missing D1 metadata retains reservation and prevents subsequent database work',async t=>{
  const f=fixture(t),prepare=f.db.prepare;
  f.db.prepare=query=>{const statement=prepare(query);if(query==='SELECT 1'){statement.all=async()=>({results:[{value:1}]});}return statement;};
  const usage=await admitUsage(f.db,f.env,fail);
  await usage.db.prepare('SELECT 1').all();
  await assert.rejects(usage.db.prepare('SELECT 2').all(),{code:'HUB_REQUEST_BUDGET'});
  await usage.finish();assert.equal((await usageStatus(f.db,f.env,fail)).used.rowsRead,1000000);
});
test('a SQL failure caught inside a transport still retains the usage reservation',async t=>{
  const f=fixture(t),usage=await admitUsage(f.db,f.env,fail);
  await assert.rejects(usage.db.prepare('SELECT * FROM nonexistent_fixture_table').all());
  await usage.finish();assert.equal((await usageStatus(f.db,f.env,fail)).used.rowsRead,1000000);
});
test('remote OAuth metadata shares the daily budget and cannot bypass a pause',async t=>{
  const f=fixture(t,{requests:1});f.env.MCP_ORIGIN='https://hub.test';f.env.MCP_OAUTH_CLIENTS_JSON='[]';
  assert.equal((await f.call('/.well-known/oauth-authorization-server')).status,200);
  assert.equal((await usageStatus(f.db,f.env,fail)).used.requests,1);
  assert.equal((await f.call('/.well-known/oauth-authorization-server')).status,429);
  f.env.HUB_PAUSED='true';assert.equal((await f.call('/.well-known/oauth-authorization-server')).status,503);
});
test('invalid configuration and missing schema fail closed, with no coordination mutation',async t=>{
  const f=fixture(t);f.raw.database.exec('DROP TABLE hub_daily_usage');
  const response=await f.call();assert.equal(response.status,503);assert.equal((await response.json()).error.code,'USAGE_GUARD_UNAVAILABLE');
  for(const config of ['{','[]','null','{"requests":0}','{"requests":1.5}','{"unknown":2}','{"readReservation":100000001}'])assert.throws(()=>costPolicy({HUB_USAGE_LIMITS_JSON:config},fail),{code:'USAGE_NOT_CONFIGURED'});
});
test('origin/authentication failures do not spend daily admission; invitations cannot inspect workspace budgets',async t=>{
  const f=fixture(t);
  assert.equal((await f.call('/api/me',OWNER,{origin:'https://foreign.test'})).status,403);
  assert.equal((await worker.fetch(new Request('https://hub.test/api/me'),f.env)).status,401);
  const token='synthetic-invited-agent';
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');
  f.raw.database.prepare("INSERT INTO principals(id,name,account,role,token_hash,projects_json,active,created_at) VALUES('synthetic','Agent','agent@example.test','agent',?,'[\"project-a\"]',1,?)").run(hash,new Date().toISOString());
  const prepare=f.db.prepare;f.db.prepare=()=>{throw new Error('Unmetered lookup must not run');};
  assert.equal((await f.call('/api/usage',token)).status,403);
  f.db.prepare=prepare;
  assert.equal((await usageStatus(f.db,f.env,fail)).used.requests,0);
});
test('pause protects API and cron while owner usage and public health remain available',async t=>{
  const f=fixture(t);f.env.HUB_PAUSED='true';
  assert.equal((await f.call()).status,503);
  assert.equal((await f.call('/api/usage')).status,200);
  assert.equal((await f.call('/health')).status,200);
  await worker.scheduled({cron:'17 3 * * *'},f.env);
  assert.equal((await usageStatus(f.db,f.env,fail)).used.requests,0);
});
test('traffic protection fails closed, does not expose credentials and reports retry timing',async t=>{
  const f=fixture(t);let observedKey;
  f.env.HUB_IP_LIMITER={async limit({key}){observedKey=key;return {success:false};}};
  const response=await f.call('/api/me',OWNER,{'cf-connecting-ip':'192.0.2.1'});
  assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'60');assert.equal(observedKey,'192.0.2.1');
  assert.equal((await usageStatus(f.db,f.env,fail)).used.requests,0);
  await assert.rejects(limitTraffic(new Request('https://hub.test/api/me'),{HUB_TRAFFIC_GUARD_REQUIRED:'true'},fail),{code:'USAGE_GUARD_UNAVAILABLE'});
});
test('warning levels and UTC reset retain yesterday counters without carrying its budget',async t=>{
  const f=fixture(t,{requests:100});
  f.raw.database.prepare('INSERT INTO hub_daily_usage VALUES(?,100,100000000,100000)').run('2000-01-01');
  f.raw.database.prepare('INSERT INTO hub_daily_usage VALUES(?,70,0,0)').run(usageDay());
  assert.equal((await usageStatus(f.db,f.env,fail)).warning,'warning');
  f.raw.database.prepare('UPDATE hub_daily_usage SET requests=85 WHERE day=?').run(usageDay());
  assert.equal((await usageStatus(f.db,f.env,fail)).warning,'critical');
  const response=await f.call();assert.equal(response.status,200);assert.equal(response.headers.get('X-Hub-Usage-Warning'),'critical');
});
