import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync,statSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCallMetrics} from '../scripts/call-metrics.mjs';
import {summarizeCallMetrics} from '../scripts/summarize-call-metrics.mjs';

test('local counters stay bounded, private and content-free; repeated reads send no extra calls',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'hub-metrics-'));t.after(()=>rmSync(dir,{recursive:true}));
  let time=100000;const tools=[{name:'hub_read_inbox'},{name:'hub_send_message'}];
  const metrics=createCallMetrics({HUB_METRICS_DIR:dir},{tools,clock:()=>time});
  const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',secret='synthetic-never-log-token',body='private message must not be logged';
  metrics.record('hub_read_inbox',{sessionId:id,after:0},{messages:[],nextCursor:0},2);
  time+=1000;metrics.record('hub_read_inbox',{sessionId:id,after:0},{messages:[{body}],nextCursor:1},3);
  metrics.record('hub_send_message',{fromSessionId:id,body,credential:secret},{message:{id:1}},4,true);
  metrics.record('arbitrary-tool-name',{body},null,0);
  for(let i=0;i<140;i++)metrics.record('hub_read_inbox',{sessionId:`${i.toString(16).padStart(8,'0')}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`},{messages:[]},1);
  metrics.flush();
  const names=readdirSync(dir);assert.equal(names.length,1,'one overwritten snapshot, not an append log');
  const path=join(dir,names[0]),text=readFileSync(path,'utf8'),report=JSON.parse(text);
  for(const value of [id,secret,body])assert.ok(!text.includes(value));
  assert.equal(statSync(path).mode&0o077,0);assert.equal(report.total.calls,143);assert.equal(report.total.errors,1);
  assert.equal(report.total.repeatedReadsWithin60Seconds,1);assert.equal(report.total.messages,1);
  assert.ok(Object.keys(report.bySession).length<=130);assert.ok(text.length<60000);
  const summary=await summarizeCallMetrics(dir);assert.equal(summary.bridges,1);assert.deepEqual(summary.total,report.total);
});

test('metrics disabled by default and refuse shared or symlinked directories',t=>{
  const dir=mkdtempSync(join(tmpdir(),'hub-metrics-disabled-'));t.after(()=>rmSync(dir,{recursive:true}));
  const tools=[{name:'hub_read_inbox'}];
  for(const env of [{},{HUB_METRICS_DIR:'relative/path'},{HUB_METRICS_DIR:tmpdir()}]){
    const metrics=createCallMetrics(env,{tools});metrics.record('hub_read_inbox',{},null,1);metrics.flush();
  }
  const link=dir+'-link';symlinkSync(dir,link);t.after(()=>rmSync(link));
  const metrics=createCallMetrics({HUB_METRICS_DIR:link},{tools});metrics.record('hub_read_inbox',{},null,1);metrics.flush();
  assert.deepEqual(readdirSync(dir),[]);
});
