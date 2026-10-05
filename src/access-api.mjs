import { sessionMessageScope } from './coordination-capacity.mjs';
import { messageFilters } from './message-filters.mjs';

import {compactMessage} from './agent-view.mjs';
// Separate project oversight from recipient delivery and human owner custody.
export async function accessApi(c) {
  const {path,method,url,db,principal,readBody,fail,checkKeys,string,numeric,
    readOptions,ownerOnly,requireProject,sessionById,requireCurrent,json,
    messageSelect,messageView,activePrincipal,now} = c;
  if(path==='/api/conversations'&&method==='GET') {
    if(principal.role!=='owner'&&!['observer','coordinator'].includes(principal.profile))
      fail(403,'OBSERVER_REQUIRED','Project conversation visibility requires an observer invitation.');
    const {view,limit}=readOptions(url,100),project=url.searchParams.get('project');
    let query=messageSelect+' WHERE 1=1',values=[];
    if(project){requireProject(principal,string(project,'project',64));query+=' AND m.project=?';values.push(project);}
    if(principal.role!=='owner'){
      query+=` AND m.project IN (${principal.projects.map(()=>'?').join(',')})`;
      values.push(...principal.projects);
    }
    const sessionId=url.searchParams.get('sessionId');
    if(sessionId){
      const session=await sessionById(db,sessionId,principal);
      const outgoing=await sessionMessageScope(db,session.id,'m.from_session_id');
      const incoming=await sessionMessageScope(db,session.id,'m.to_session_id');
      query+=` AND (${outgoing.sql} OR ${incoming.sql})`;values.push(...outgoing.values,...incoming.values);
    }
    for(const [key,column,allowed] of [['kind','m.kind',['NOTE','HANDOFF','QUESTION','ANSWER']],['reviewState','m.review_state',['PENDING','APPROVED','REJECTED']]]){
      const value=url.searchParams.get(key);if(value!==null){if(!allowed.includes(value))fail(422,'INVALID_FILTER','Select a supported conversation filter.');query+=` AND ${column}=?`;values.push(value);}
    }
    const filters=messageFilters(url,fail,true);
    if(filters.clauses.length){query+=' AND '+filters.clauses.join(' AND ');values.push(...filters.values);}
    const after=numeric(url.searchParams.get('after')??0,'after'),before=url.searchParams.get('before'),latest=url.searchParams.get('latest')==='1';
    if((before!==null||latest)&&after!==0||before!==null&&latest)fail(422,'INVALID_CURSOR','Use one pagination direction at a time.');
    query+=' AND m.id>?';values.push(after);
    if(before!==null){query+=' AND m.id<?';values.push(numeric(before,'before'));}
    const descending=latest||before!==null;
    const rows=await db.prepare(query+` ORDER BY m.id ${descending?'DESC':'ASC'} LIMIT ?`).bind(...values,limit+1).all();
    await requireCurrent(db,principal);
    const hasMore=rows.results.length>limit,page=rows.results.slice(0,limit),ordered=descending?page.reverse():page;
    // The observer cursor uses message IDs, never recipient delivery sequence.
    return json({messages:ordered.map(row=>{const message=messageView(row,principal,true);return view==='compact'?{...compactMessage(message),toPrincipalId:message.toPrincipalId,reviewState:message.reviewState}:message;}),nextCursor:ordered.at(-1)?.id??after,
      nextBefore:descending&&hasMore?ordered[0]?.id??null:null,limit,hasMore,view});
  }
  if(path==='/api/connections'&&method==='POST') {
    const body=await readBody();checkKeys(body,['connectionId','client']);
    const connectionId=string(body.connectionId,'connectionId',36);
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(connectionId))fail(422,'INVALID_CONNECTION','Use a random UUIDv4 connection ID.');
    if(!['web','cli','mcp','api'].includes(body.client))fail(422,'INVALID_CLIENT','Use web, cli, mcp or api.');
    const existing=await db.prepare('SELECT id,client,connected_at FROM connection_events WHERE principal_id=? AND connection_id=?').bind(principal.id,connectionId).first();
    if(existing){if(existing.client!==body.client)fail(409,'CONNECTION_CONFLICT','This connection ID was already used for another client.');await requireCurrent(db,principal);return json({connection:{id:existing.id,principalId:principal.id,client:existing.client,connectedAt:existing.connected_at}});}
    const timestamp=now(),hourAgo=new Date(Date.now()-3600000).toISOString(),dayAgo=new Date(Date.now()-86400000).toISOString();
    await db.prepare(`INSERT INTO connection_events(principal_id,connection_id,client,connected_at) SELECT ?,?,?,? WHERE ${activePrincipal} AND (SELECT COUNT(*) FROM connection_events WHERE principal_id=? AND connected_at>=?)<100 AND (SELECT COUNT(*) FROM connection_events WHERE connected_at>=?)<5000 ON CONFLICT(principal_id,connection_id) DO NOTHING`).bind(principal.id,connectionId,body.client,timestamp,principal.id,principal.id,hourAgo,dayAgo).run();
    await requireCurrent(db,principal);
    const row=await db.prepare('SELECT id,client,connected_at FROM connection_events WHERE principal_id=? AND connection_id=?').bind(principal.id,connectionId).first();
    if(!row)fail(429,'CONNECTION_LIMIT','Connection history is limited to 100 per identity per hour and 5000 per workspace per day.');
    if(row.client!==body.client)fail(409,'CONNECTION_CONFLICT','This connection ID was already used for another client.');
    return json({connection:{id:row.id,principalId:principal.id,client:row.client,connectedAt:row.connected_at}},201);
  }
  if(path==='/api/connections'&&method==='GET') {
    ownerOnly(principal);const {limit}=readOptions(url,100),before=url.searchParams.get('before');
    const rows=await db.prepare(`SELECT c.id,c.principal_id,c.client,c.connected_at,p.name,p.account,p.active FROM connection_events c JOIN principals p ON p.id=c.principal_id ${before===null?'':'WHERE c.id<?'} ORDER BY c.id DESC LIMIT ?`).bind(...(before===null?[]:[numeric(before,'before')]),limit+1).all();
    const hasMore=rows.results.length>limit,page=rows.results.slice(0,limit);
    return json({connections:page.map(row=>({id:row.id,principalId:row.principal_id,principalName:row.name,account:row.account,active:row.active===1,client:row.client,connectedAt:row.connected_at})),nextBefore:hasMore?page.at(-1)?.id??null:null,limit,hasMore});
  }
  return null;
}
