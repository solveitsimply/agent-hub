// Optional browser QA. All hosts and credentials are synthetic; no network is used.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import worker from '../src/worker.mjs';
import {SqliteD1} from '../test/d1-sqlite.mjs';
const {chromium}=await import(process.env.HUB_BROWSER_MODULE||'playwright');
const origin='https://hub.test',redirect='https://client.test/callback';
const DB=new SqliteD1(),env={DB,OWNER_TOKEN:'synthetic-browser-only-owner-1234567890123456',MCP_ORIGIN:origin,MCP_OAUTH_CLIENTS_JSON:JSON.stringify([{client_id:'synthetic-client',client_name:'Synthetic MCP client',redirect_uris:[redirect],max_grant_days:90,refresh_idle_days:30}]),MCP_AUTH_RATE_LIMITER:{async limit(){return {success:true};}}};
async function call(token,path,body){const r=await worker.fetch(new Request(origin+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)}),env);assert.ok(r.ok,await r.clone().text());return r.json();}
const actor=await call(env.OWNER_TOKEN,'/api/principals',{name:'Synthetic Coordinator',account:'fixture@example.test',projects:['demo'],profile:'coordinator'});
const {session}=await call(actor.token,'/api/sessions',{externalId:'synthetic:browser-chat',machine:'synthetic',label:'Synthetic coordination chat',project:'demo',task:'Verify OAuth consent without external connections',status:'RUNNING'});
const verifier='synthetic-only-browser-verifier-012345678901234567890123456789';
const challenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');
const authorization=origin+'/oauth/authorize?'+new URLSearchParams({response_type:'code',client_id:'synthetic-client',redirect_uri:redirect,resource:origin+'/mcp',scope:'hub:read hub:message',state:'synthetic-state-012345678901234567890',code_challenge:challenge,code_challenge_method:'S256'});
const browser=await chromium.launch({headless:true,...(process.env.HUB_BROWSER_EXECUTABLE?{executablePath:process.env.HUB_BROWSER_EXECUTABLE}:{})});
const evidence=process.env.HUB_FIXTURE_EVIDENCE_DIR||fileURLToPath(new URL('../.evidence/remote-mcp/',import.meta.url));await mkdir(evidence,{recursive:true});
try{
  for(const width of [1440,390]){
    const context=await browser.newContext({viewport:{width,height:1000}});const errors=[];
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin==='https://client.test'){assert.equal(url.pathname,'/callback');return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><h1>Synthetic OAuth callback received</h1>'});}
      assert.equal(url.origin,origin,'No real external connections are permitted');
      if(url.pathname==='/oauth-style.css')return route.fulfill({status:200,contentType:'text/css',body:await readFile(new URL('../public/oauth-style.css',import.meta.url),'utf8')});
      const requestHeaders=await request.allHeaders();
      if(url.pathname==='/oauth/authorize'&&request.method()==='POST')assert.equal(requestHeaders.origin,origin,'Consent form must retain its exact Origin');
      const response=await worker.fetch(new Request(url,{method:request.method(),headers:requestHeaders,...(['GET','HEAD'].includes(request.method())?{}:{body:request.postDataBuffer()})}),env);
      await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(authorization);await page.getByRole('heading',{name:'Connect Agent Hub'}).waitFor();
    assert.equal(await page.locator('input[type=password]').count(),1);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:evidence+`/consent-entry-${width}.png`,fullPage:true});
    await page.getByLabel('Coordinator invitation token').fill(actor.token);await page.getByLabel('Existing session ID').fill(session.id);await page.getByLabel('Project slug').fill('demo');await page.getByRole('button',{name:'Review connection'}).click();
    await page.getByRole('heading',{name:'Approve Agent Hub connection'}).waitFor();assert.ok((await page.locator('main').innerText()).includes(session.id));assert.match(await page.locator('main').innerText(),/up to 90 days.*30 days without token renewal/s);assert.equal(await page.locator('input[type=password]').count(),0);assert.ok(!(await page.content()).includes(actor.token));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:evidence+`/consent-review-${width}.png`,fullPage:true});
    await page.getByRole('button',{name:'Approve this scoped connection'}).click();await page.waitForURL('https://client.test/callback?*');const callback=new URL(page.url());assert.ok(callback.searchParams.get('code'));assert.equal(callback.searchParams.get('iss'),origin);await page.getByRole('heading',{name:'Synthetic OAuth callback received'}).waitFor();
    // Cancel must also survive CSP and preserve the number of grants.
    const grants=DB.database.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_grants').get().n;
    await page.goto(authorization);await page.getByLabel('Coordinator invitation token').fill(actor.token);await page.getByLabel('Existing session ID').fill(session.id);await page.getByLabel('Project slug').fill('demo');await page.getByRole('button',{name:'Review connection'}).click();await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.waitForURL('https://client.test/callback?*');assert.equal(new URL(page.url()).searchParams.get('error'),'access_denied');assert.equal(DB.database.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_grants').get().n,grants);
    assert.deepEqual(errors,[]);await context.close();console.log(`Synthetic OAuth browser verification passed at ${width}px, including approve/cancel redirects.`);
  }
}finally{await browser.close();DB.close();}
