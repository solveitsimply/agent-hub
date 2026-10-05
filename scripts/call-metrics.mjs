// Opt-in local aggregates. No payloads, credentials, labels, polling or uploads.
import {createHash} from 'node:crypto';
import {mkdirSync,lstatSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';

const disabled={record(){},flush(){}};
const bucket=()=>({calls:0,errors:0,argumentCharacters:0,responseCharacters:0,responseBytes:0,durationMs:0,emptyInboxes:0,messages:0,repeatedReadsWithin60Seconds:0});
const hash=value=>createHash('sha256').update(value).digest('hex');
const reads=new Set(['hub_read_inbox','hub_list_sessions','hub_list_ownership','hub_read_lifecycle','hub_list_attribution_segments']);

export function createCallMetrics(env,{tools=[],clock=Date.now}={}) {
  const directory=env.HUB_METRICS_DIR;
  if(!directory)return disabled;
  if(!isAbsolute(directory))return disabled;
  try {
    mkdirSync(directory,{recursive:true,mode:0o700});
    const stat=lstatSync(directory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)||(process.getuid&&stat.uid!==process.getuid()))return disabled;
  }catch{return disabled;}
  const started=clock(),file=join(directory,`bridge-${started}-${process.pid}.json`),temporary=file+'.tmp';
  const report={schemaVersion:1,startedAt:new Date(started).toISOString(),updatedAt:null,toolSchemaCharacters:JSON.stringify(tools).length,total:bucket(),byTool:{},bySession:{}};
  const allowed=new Set(tools.map(tool=>tool.name)),previousReads=new Map();let lastFlush=-Infinity;
  function flush(){
    try {
      writeFileSync(temporary,JSON.stringify(report)+'\n',{mode:0o600,flag:'wx'});
      renameSync(temporary,file);lastFlush=clock();
    }catch{try{rmSync(temporary);}catch{} /* Metrics never affect custody or RPC output. */}
  }
  return {flush,record(name,args,output,durationMs,error=false){
    if(!allowed.has(name))return;
    const time=clock(),argument=JSON.stringify(args),response=output===null?'':JSON.stringify(output);
    const increment={calls:1,errors:Number(error),argumentCharacters:argument.length,responseCharacters:response.length,responseBytes:Buffer.byteLength(response),durationMs:Math.round(Math.max(0,durationMs)),emptyInboxes:Number(name==='hub_read_inbox'&&Array.isArray(output?.messages)&&output.messages.length===0),messages:name==='hub_read_inbox'?output?.messages?.length??0:0,repeatedReadsWithin60Seconds:0};
    if(reads.has(name)){
      const key=hash(name+'\0'+argument),previous=previousReads.get(key);
      increment.repeatedReadsWithin60Seconds=Number(previous!==undefined&&time-previous<60000);
      previousReads.delete(key);previousReads.set(key,time);
      if(previousReads.size>128)previousReads.delete(previousReads.keys().next().value);
    }
    const id=args.sessionId??args.fromSessionId??output?.session?.id;
    let session='unscoped';
    if(typeof id==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id)){
      session=hash(id);
      if(!report.bySession[session]&&Object.keys(report.bySession).length>=128)session='overflow';
    }
    const targets=[report.total,report.byTool[name]??=bucket(),report.bySession[session]??=bucket()];
    for(const target of targets)for(const [key,value] of Object.entries(increment))target[key]+=value;
    report.updatedAt=new Date(time).toISOString();
    if(time-lastFlush>=60000)flush();
  }};
}
