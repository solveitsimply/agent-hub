import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root = new URL('../', import.meta.url);
const cliPath = fileURLToPath(new URL('../scripts/hub-client.mjs', import.meta.url));
const bridgePath = fileURLToPath(new URL('../scripts/mcp-bridge.mjs', import.meta.url));
const TOKEN = 'synthetic-local-test-token-not-a-real-secret';

async function localServer(t, handler = (_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: true }));
}) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}`;
}

function runCli(args, { url, input = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: fileURLToPath(root),
      env: { ...process.env, HUB_URL: url, HUB_TOKEN: TOKEN },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function startBridge(url, extraEnv={}) {
  const child = spawn(process.execPath, [bridgePath], {
    cwd: fileURLToPath(root),
    env: { ...process.env, HUB_URL: url, HUB_TOKEN: TOKEN, HUB_METRICS_DIR:'',...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = [];
  const waiters = [];
  lines.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else pending.push(line);
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  return {
    child,
    get stderr() { return stderr; },
    next() {
      if (pending.length) return Promise.resolve(pending.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for MCP response.')), 5000);
        waiters.push((line) => { clearTimeout(timer); resolve(line); });
      });
    },
    send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
  };
}

test('CLI requires explicit local authorization and strips the assertion from the API body', async (t) => {
  const requests = [];
  const url = await localServer(t, async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: body ? JSON.parse(body) : undefined });
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: { id: 7 } }));
  });
  const denied = await runCli(['send'], { url, input: JSON.stringify({ project: 'local', kind: 'NOTE', body: 'test', idempotencyKey: 'one' }) });
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /USER_AUTHORIZATION_REQUIRED/u);
  assert.equal(requests.length, 0);

  const allowed = await runCli(['send'], { url, input: JSON.stringify({ project: 'local', kind: 'NOTE', body: 'explicitly authorized local fixture', idempotencyKey: 'two', userAuthorized: true }) });
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/messages');
  assert.equal(requests[0].authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(requests[0].body, { project: 'local', kind: 'NOTE', body: 'explicitly authorized local fixture', idempotencyKey: 'two' });
  assert.equal(allowed.stdout.includes(TOKEN), false);
});

test('CLI rejects non-local HTTP and non-origin URLs before connecting', async (t) => {
  let requests = 0;
  const origin = await localServer(t, (_request, response) => { requests += 1; response.end('{"ok":true}'); });
  const pathUrl = `${origin}/nested`;
  const cases = [
    ['http://hub.example.test', /HTTPS/u],
    [pathUrl, /origin/u],
    [origin.replace('http://', `http://user:pass@`), /credentials/u],
  ];
  for (const [url, expected] of cases) {
    const result = await runCli(['me'], { url });
    assert.equal(result.code, 1);
    assert.match(result.stderr, expected);
  }
  assert.equal(requests, 0);
});

test('CLI refuses redirects and redacts a token echoed in an API error', async (t) => {
  let redirectedRequests = 0;
  const target = await localServer(t, (_request, response) => { redirectedRequests += 1; response.end('{"ok":true}'); });
  const source = await localServer(t, (_request, response) => {
    response.writeHead(302, { location: target });
    response.end();
  });
  const redirect = await runCli(['me'], { url: source });
  assert.equal(redirect.code, 1);
  assert.equal(redirectedRequests, 0);
  assert.equal(redirect.stderr.includes(TOKEN), false);

  const errorUrl = await localServer(t, (_request, response) => {
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'DENIED', message: `Rejected credential ${TOKEN}` } }));
  });
  const failed = await runCli(['me'], { url: errorUrl });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /DENIED/u);
  assert.equal(failed.stderr.includes(TOKEN), false);
});

test('MCP stdio initializes, lists tools, sends nothing spontaneously, and requires explicit send assertion', async (t) => {
  const requests = [];
  const url = await localServer(t, async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: body ? JSON.parse(body) : undefined });
    if (new URL(request.url,'http://test').pathname === '/api/sessions') {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'DENIED', message: `Credential rejected: ${TOKEN}` } }));
      return;
    }
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: { id: 9 } }));
  });
  const bridge = startBridge(url);
  t.after(() => { bridge.child.kill(); });
  bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(JSON.parse(await bridge.next()).result.protocolVersion, '2025-06-18');
  bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const listed = JSON.parse(await bridge.next());
  const sendTool=listed.result.tools.find((tool)=>tool.name==='hub_send_message');
  assert.ok(sendTool);assert.match(sendTool.description,/Delivery is automatic/);assert.match(sendTool.description,/ongoing coordination/);assert.match(sendTool.inputSchema.properties.userAuthorized.description,/standing authorization/);
  assert.ok(listed.result.tools.some((tool) => tool.name === 'hub_list_ownership'));
  assert.equal(listed.result.tools.some((tool) => /review/.test(tool.name)), false, 'Agent bridge exposes no approval capability');
  assert.equal(requests.length, 0);

  const args = { project: 'local', kind: 'NOTE', body: 'local fixture', idempotencyKey: 'mcp-1' };
  bridge.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hub_send_message', arguments: args } });
  const denied = JSON.parse(await bridge.next());
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /USER_AUTHORIZATION_REQUIRED/u);
  assert.equal(requests.length, 0);

  bridge.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hub_send_message', arguments: { ...args, userAuthorized: true } } });
  const sent = JSON.parse(await bridge.next());
  assert.equal(sent.id, 4);
  assert.match(sent.result.content[0].text, /untrusted/i);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/messages');
  assert.equal(requests[0].authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(requests[0].body, args);

  bridge.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'hub_list_sessions', arguments: {} } });
  const failed = JSON.parse(await bridge.next());
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.content[0].text.includes(TOKEN), false);
  assert.equal(requests.length, 2);
  bridge.send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'hub_list_ownership', arguments: { project: 'local', resourceKey: 'known/key' } } });
  assert.equal(JSON.parse(await bridge.next()).result.isError, undefined);
  assert.equal(requests[2].url, '/api/ownership?project=local&resourceKey=known%2Fkey');
  assert.equal(bridge.stderr.includes(TOKEN), false);
  const closed = once(bridge.child, 'close');
  bridge.child.stdin.end();
  await closed;
});

test('MCP session listing forwards known and missing-label filters without broadening invalid flags', async (t) => {
  const urls = [];
  const url = await localServer(t, (request, response) => {
    urls.push(request.url);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ sessions: [], total: 0, limit: 200, filterOptions: { agentNames: [], agentModels: [], machines: [] } }));
  });
  const bridge = startBridge(url);
  t.after(() => { bridge.child.kill(); });
  bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(JSON.parse(await bridge.next()).result.serverInfo.name, 'agent-hub');

  bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hub_list_sessions', arguments: {
    project: 'example-project', agentName: 'Codex', agentModel: 'reported-model', machine: 'test-host',
  } } });
  assert.equal(JSON.parse(await bridge.next()).result.isError, undefined);
  assert.deepEqual(Object.fromEntries(new URL(urls[0], url).searchParams), {
    view:'compact',limit:'20',project: 'example-project', agentName: 'Codex', agentModel: 'reported-model', machine: 'test-host',
  });

  bridge.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hub_list_sessions', arguments: {
    project: 'example-project', agentNameUnknown: true, agentModelUnknown: true, machineUnknown: true,
  } } });
  assert.equal(JSON.parse(await bridge.next()).result.isError, undefined);
  assert.deepEqual(Object.fromEntries(new URL(urls[1], url).searchParams), {
    view:'compact',limit:'20',project: 'example-project', agentNameUnknown: '1', agentModelUnknown: '1', machineUnknown: '1',
  });

  bridge.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hub_list_sessions', arguments: { agentNameUnknown: 'yes' } } });
  const invalid = JSON.parse(await bridge.next());
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /INVALID_ARGUMENT/u);
  assert.equal(urls.length, 2);
});

test('MCP stdio records and reads append-only attribution with an exact cursor', async (t) => {
  const requests = [];
  const segment = {
    id: 41,
    sessionId: 'session-uuid-41',
    startedAt: '2026-10-03T17:00:00.000Z',
    endedAt: null,
    provider: 'OpenAI',
    client: 'Codex',
    model: 'reported-model',
    accountLabel: null,
    apiKeyLabel: 'local-dev-label',
    source: 'agent-reported',
  };
  const url = await localServer(t, async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : undefined });
    response.writeHead(request.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.method === 'POST' ? { segment } : { segments: [segment], nextCursor: segment.id, limit: 200 }));
  });
  const bridge = startBridge(url);
  t.after(() => { bridge.child.kill(); });
  bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(JSON.parse(await bridge.next()).result.protocolVersion, '2025-06-18');

  bridge.send({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'hub_start_attribution_segment', arguments: {
      sessionId: segment.sessionId,
      provider: segment.provider,
      client: segment.client,
      model: segment.model,
      accountLabel: null,
      apiKeyLabel: segment.apiKeyLabel,
      previousSegmentId: null,
      idempotencyKey: 'synthetic-segment-start-1',
    } },
  });
  const recorded = JSON.parse(await bridge.next());
  assert.equal(recorded.id, 2);
  assert.equal(JSON.parse(recorded.result.content.at(-1).text).segment.id, segment.id);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, `/api/sessions/${segment.sessionId}/attribution`);
  assert.deepEqual(requests[0].body, {
    provider: segment.provider,
    client: segment.client,
    model: segment.model,
    accountLabel: null,
    apiKeyLabel: segment.apiKeyLabel,
    previousSegmentId: null,
    idempotencyKey: 'synthetic-segment-start-1',
  });

  bridge.send({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'hub_list_attribution_segments', arguments: { sessionId: segment.sessionId, after: 0 } },
  });
  const history = JSON.parse(await bridge.next());
  assert.equal(history.id, 3);
  assert.deepEqual(JSON.parse(history.result.content.at(-1).text), { segments: [segment], nextCursor: segment.id, limit: 200 });
  assert.equal(requests[1].method, 'GET');
  assert.equal(requests[1].url, `/api/sessions/${segment.sessionId}/attribution?after=0`);
  assert.equal(requests.length, 2);
  assert.equal(bridge.stderr.includes(TOKEN), false);
  const closed = once(bridge.child, 'close');
  bridge.child.stdin.end();
  await closed;
});

test('MCP renames an existing chat without submitting replacement identity fields', async (t) => {
  const requests = [];
  const url = await localServer(t, async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({method:request.method,url:request.url,body:JSON.parse(body)});
    response.writeHead(200, {'content-type':'application/json'});
    response.end(JSON.stringify({session:{id:'existing-chat',label:'Exact renamed app title'}}));
  });
  const bridge = startBridge(url);
  t.after(()=>bridge.child.kill());
  bridge.send({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'hub_update_session',arguments:{sessionId:'existing-chat',label:'Exact renamed app title'}}});
  const result=JSON.parse(await bridge.next());
  assert.equal(result.result.isError,undefined);
  assert.deepEqual(requests,[{method:'PATCH',url:'/api/sessions/existing-chat',body:{label:'Exact renamed app title'}}]);
});

test('CLI and MCP expose the same complete discovery filters and full escape hatch',async t=>{
  const urls=[];
  const url=await localServer(t,(request,response)=>{urls.push(request.url);response.end(JSON.stringify({sessions:[],messages:[],nextCursor:7}));});
  const args={project:'shared',agentName:'Codex',agentModel:'Example model',machine:'host',repository:'github.com/example/app',branch:'dev',environment:'dev',status:'WAITING',attention:'WAITING',limit:5,view:'full'};
  const cli=await runCli(['sessions','shared','--agent-name','Codex','--agent-model','Example model','--machine','host','--repository','github.com/example/app','--branch','dev','--environment','dev','--status','WAITING','--attention','WAITING','--limit','5','--view','full'],{url});
  assert.equal(cli.code,0,cli.stderr);
  const bridge=startBridge(url);t.after(()=>bridge.child.kill());
  bridge.send({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'hub_list_sessions',arguments:args}});
  assert.equal(JSON.parse(await bridge.next()).result.isError,undefined);
  assert.deepEqual(Object.fromEntries(new URL(urls[0],url).searchParams),Object.fromEntries(new URL(urls[1],url).searchParams));
  for(const options of [['--branch','dev'],['--agent-name','Codex','--agent-name-unknown'],['--typo','x'],['--limit','0']]){
    assert.equal((await runCli(['sessions',...options],{url})).code,1);
  }
  assert.equal(urls.length,2,'invalid filters fail before any request');
  const inbox=await runCli(['inbox','session-id','7','--kind','NOTE','--limit','1'],{url});
  assert.equal(inbox.code,0,inbox.stderr);
  bridge.send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'hub_read_inbox',arguments:{sessionId:'session-id',after:7,kind:'NOTE',limit:1}}});
  assert.equal(JSON.parse(await bridge.next()).result.isError,undefined);
  assert.deepEqual(Object.fromEntries(new URL(urls[2],url).searchParams),Object.fromEntries(new URL(urls[3],url).searchParams));
  assert.equal(new URL(urls[2],url).searchParams.get('direction'),'incoming');
  const history=await runCli(['inbox','session-id','7','--direction','all'],{url});
  assert.equal(history.code,0,history.stderr);assert.equal(new URL(urls[4],url).searchParams.get('direction'),'all');
  bridge.send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'hub_read_inbox',arguments:{sessionId:'session-id',direction:'invalid'}}});
  assert.equal(JSON.parse(await bridge.next()).result.isError,true);assert.equal(urls.length,5,'invalid direction never sends a request');
});

test('compact write receipts omit echoes but retain revision; full is stripped from mutation body',async t=>{
  const bodies=[];
  const session={id:'session',label:'Exact title',project:'shared',status:'RUNNING',task:'Long task',details:{evidence:['large fixture']},lifecycle:{revision:8,attention:'WORKING',heldClaims:0,checkpoint:{nextAction:'Continue'}}};
  const url=await localServer(t,async(request,response)=>{let body='';for await(const chunk of request)body+=chunk;bodies.push(JSON.parse(body));response.end(JSON.stringify({session}));});
  const bridge=startBridge(url);t.after(()=>bridge.child.kill());
  for(const [id,view] of [[1,'compact'],[2,'full']]){
    bridge.send({jsonrpc:'2.0',id,method:'tools/call',params:{name:'hub_update_session',arguments:{sessionId:'session',status:'RUNNING',view}}});
    const result=JSON.parse(JSON.parse(await bridge.next()).result.content.at(-1).text).session;
    assert.equal(result.lifecycle.revision,8);
    if(view==='compact'){assert.equal('details' in result,false);assert.equal('task' in result,false);}
    else assert.deepEqual(result,session);
  }
  const cli=await runCli(['update','session','--view','full'],{url,input:JSON.stringify({status:'RUNNING'})});
  assert.equal(cli.code,0,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout).session,session);
  assert.deepEqual(bodies,[{status:'RUNNING'},{status:'RUNNING'},{status:'RUNNING'}]);
});

test('checkpoint receipts retain current revision while lifecycle reads retain complete evidence',async t=>{
  const lifecycle={revision:9,attention:'WORKING',heldClaims:0,checkpoint:{outcome:'Long outcome',acceptanceCriteria:'Meaningful evidence',nextAction:'Continue',completionEvidence:['immutable evidence reference']},observation:{state:'active'}};
  const requests=[];
  const url=await localServer(t,async(request,response)=>{
    let body='';for await(const chunk of request)body+=chunk;
    requests.push({method:request.method,body:body?JSON.parse(body):null});
    response.end(JSON.stringify(request.method==='GET'?{lifecycle}:{session:{id:'session',status:'RUNNING',lifecycle}}));
  });
  const bridge=startBridge(url);t.after(()=>bridge.child.kill());
  bridge.send({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'hub_record_checkpoint',arguments:{sessionId:'session',expectedRevision:8,checkpoint:lifecycle.checkpoint}}});
  const written=JSON.parse(JSON.parse(await bridge.next()).result.content.at(-1).text);
  assert.equal(written.session.lifecycle.revision,9);assert.equal('checkpoint' in written.session.lifecycle,false);
  bridge.send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'hub_read_lifecycle',arguments:{sessionId:'session'}}});
  assert.deepEqual(JSON.parse(JSON.parse(await bridge.next()).result.content.at(-1).text),{lifecycle});
  const cli=await runCli(['lifecycle','session'],{url});assert.equal(cli.code,0,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout),{lifecycle});
  assert.deepEqual(requests[0].body,{expectedRevision:8,checkpoint:lifecycle.checkpoint});
});

test('MCP metrics record one explicit call without logging payloads or changing stdout',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'hub-bridge-counters-'));t.after(()=>rm(dir,{recursive:true}));let requests=0;
  const url=await localServer(t,(_request,response)=>{requests++;response.end(JSON.stringify({messages:[],nextCursor:8,hasMore:false}));});
  const bridge=startBridge(url,{HUB_METRICS_DIR:dir});
  bridge.send({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'hub_read_inbox',arguments:{sessionId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',after:8}}});
  const result=JSON.parse(await bridge.next());assert.deepEqual(JSON.parse(result.result.content.at(-1).text),{messages:[],nextCursor:8,hasMore:false});
  const closed=once(bridge.child,'close');bridge.child.stdin.end();await closed;
  assert.equal(requests,1);assert.equal(bridge.stderr,'');
  const files=await readdir(dir);assert.equal(files.length,1);const text=await readFile(join(dir,files[0]),'utf8');
  assert.ok(!text.includes(TOKEN));assert.ok(!text.includes('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
  assert.equal(JSON.parse(text).total.calls,1);assert.equal(JSON.parse(text).total.emptyInboxes,1);
});
