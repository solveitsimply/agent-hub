#!/usr/bin/env node
// Manual local summary; does not contact the Hub or invoke an AI model.
import {readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export async function summarizeCallMetrics(directory){
  const result={bridges:0,total:{},byTool:{},bySession:{}};
  for(const name of await readdir(directory)){
    if(!/^bridge-\d+-\d+\.json$/u.test(name))continue;
    let report;try{report=JSON.parse(await readFile(join(directory,name),'utf8'));}catch{continue;}
    if(report.schemaVersion!==1)continue;
    result.bridges++;
    const add=(target,values)=>{for(const [key,value] of Object.entries(values??{}))if(typeof value==='number'&&Number.isFinite(value)&&value>=0)target[key]=(target[key]??0)+value;};
    add(result.total,report.total);
    for(const group of ['byTool','bySession'])for(const [key,values] of Object.entries(report[group]??{})){
      if(!/^(?:hub_[a-z_]+|[0-9a-f]{64}|unscoped|overflow)$/u.test(key))continue;
      add(result[group][key]??={},values);
    }
  }
  return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  summarizeCallMetrics(process.argv[2]).then(result=>console.log(JSON.stringify(result,null,2))).catch(()=>{console.error('Provide a readable private metrics directory.');process.exitCode=1;});
}
