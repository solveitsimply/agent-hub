#!/usr/bin/env node
// Connect only to an existing, explicitly selected native authority. This
// program never starts a daemon, starts a turn, answers approval, or archives.
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHubClient} from './hub-client.mjs';

const READ_METHODS=new Set(['initialize','thread/read','thread/goal/get']);
export function nativeState(thread) {
  if(thread?.archived===true)return 'archived';
  const status=thread?.status;
  if(status?.type==='active')return status.activeFlags?.some(flag=>['waitingOnApproval','waitingOnUserInput'].includes(flag))?'waiting_user':'active';
  if(status?.type==='idle')return 'idle';
  if(status?.type==='notLoaded')return 'not_loaded';
  // Absence from one page/list or absence of runtime status proves nothing.
  return null;
}

export function connectCodex({codexBinary,socketPath}) {
  if(!codexBinary?.startsWith('/')||!socketPath?.startsWith('/'))throw new Error('Supply absolute codexBinary and the existing authority socketPath in private config.');
  const child=spawn(codexBinary,['app-server','proxy','--sock',socketPath],{stdio:['pipe','pipe','pipe'],shell:false});
  let sequence=0,closed=false;const pending=new Map(),lines=createInterface({input:child.stdout});
  const stop=()=>{closed=true;for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('Native authority disconnected.'));}pending.clear();};
  child.on('error',stop);child.on('exit',stop);child.stderr.resume();
  lines.on('line',line=>{
    if(Buffer.byteLength(line)>2*1024*1024){stop();child.kill('SIGTERM');return;}
    let value;try{value=JSON.parse(line);}catch{return;}
    if(value.method && value.id!==undefined){child.stdin.write(JSON.stringify({id:value.id,error:{code:-32601,message:'Read-only observer cannot handle execution or approval requests.'}})+'\n');return;}
    const item=pending.get(value.id);if(!item)return;clearTimeout(item.timer);pending.delete(value.id);
    if(value.error)item.reject(new Error('Native read unavailable.'));else item.resolve(value.result);
  });
  const rpc=(method,params)=>new Promise((resolveResult,reject)=>{
    if(closed||!READ_METHODS.has(method)){reject(new Error('Read-only method unavailable.'));return;}
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Native read timed out.'));},10000);
    pending.set(id,{resolve:resolveResult,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  let initialized=false;
  return {
    async read(nativeId){
      if(!initialized){await rpc('initialize',{clientInfo:{name:'agent_hub_observer',version:'0.1.0'}});child.stdin.write(JSON.stringify({method:'initialized'})+'\n');initialized=true;}
      const value=await rpc('thread/read',{threadId:nativeId,includeTurns:false});
      if(value?.thread?.id!==nativeId)throw new Error('Native authority returned a different thread.');
      const state=nativeState(value.thread);if(!state)throw new Error('Authority does not expose runtime status.');
      let goalState=null;try{const goal=await rpc('thread/goal/get',{threadId:nativeId});if(['active','complete','paused','budget_limited','failed'].includes(goal?.goal?.status))goalState=goal.goal.status;}catch{/* Optional capability. */}
      return {state,goalState,observedAt:new Date().toISOString()};
    },
    close(){stop();lines.close();child.stdin.end();if(child.exitCode===null)child.kill('SIGTERM');},
  };
}

export async function collectObservations(client,read) {
  const manifest=await client.request('GET','/api/observer');
  if(manifest.capabilities?.join(',')!=='observe')throw new Error('Credential is not a read-only observer.');
  let recorded=0,offline=0;
  for(const mapping of manifest.sessions){
    let observation;try{observation=await read(mapping.nativeId);}catch{offline++;observation={state:'offline',observedAt:new Date().toISOString()};}
    await client.request('POST','/api/observer/observations',{body:{sessionId:mapping.sessionId,nativeId:mapping.nativeId,sequence:mapping.sequence+1,...observation}});recorded++;
  }
  return {recorded,offline};
}

async function main(){
  const [configPath,mode]=process.argv.slice(2);if(!configPath||!['--once','--watch',undefined].includes(mode))throw new Error('Usage: native-observer.mjs PRIVATE_CONFIG.json [--once|--watch]');
  const raw=await readFile(configPath,'utf8');if(raw.length>16384)throw new Error('Private config is too large.');const config=JSON.parse(raw);
  const client=createHubClient({HUB_URL:config.hubUrl,HUB_TOKEN:config.observerToken});
  if(!config.observerToken?.startsWith('hub_observer_'))throw new Error('Use an observer credential; principal and owner credentials are refused.');
  let connection=null,stopping=false;
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;connection?.close();});
  let failures=0;
  try{do{
    try{connection=connectCodex(config);const result=await collectObservations(client,id=>connection.read(id));process.stdout.write(JSON.stringify(result)+'\n');failures=result.offline?failures+1:0;if(mode!=='--watch'&&result.offline)process.exitCode=2;}
    catch(error){if(mode!=='--watch')throw error;failures++;process.stderr.write('Observer unavailable; backing off.\n');}
    finally{connection?.close();connection=null;}
    if(mode!=='--watch'||stopping)break;
    await new Promise(resolveWait=>{const done=()=>{clearTimeout(timer);for(const signal of ['SIGINT','SIGTERM'])process.removeListener(signal,done);resolveWait();};const timer=setTimeout(done,Math.min(900000,60000*2**Math.min(failures,4))+Math.floor(Math.random()*5000));for(const signal of ['SIGINT','SIGTERM'])process.once(signal,done);});
  }while(!stopping);}finally{connection?.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{process.stderr.write('Native observer failed. Check the private mapping, credential and existing authority connection. No native operation was started.\n');process.exitCode=1;});
