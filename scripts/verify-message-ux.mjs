// Optional browser QA; reuse an installed Playwright and a fresh synthetic local server.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.HUB_BROWSER_MODULE || 'playwright');
import {mkdir} from 'node:fs/promises';
const origin=process.env.HUB_FIXTURE_ORIGIN || 'http://127.0.0.1:8798';
assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/,'Browser verification requires a fresh loopback fixture');
const OWNER=process.env.HUB_FIXTURE_OWNER_TOKEN;
assert.ok(OWNER && OWNER.length>=32,'Supply the local synthetic OWNER_TOKEN through HUB_FIXTURE_OWNER_TOKEN');
async function call(token,path,body){const r=await fetch(origin+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,await r.clone().text());return r.json();}
const a=await call(OWNER,'/principals',{name:'Release agent',account:'release@example.test',projects:['demo']});
const b=await call(OWNER,'/principals',{name:'Review agent',account:'review@example.test',projects:['demo']});
const observer=await call(OWNER,'/principals',{name:'Project coordinator',account:'coordinator@example.test',projects:['demo'],profile:'observer'});
const register=(actor,label,status='RUNNING')=>call(actor.token,'/sessions',{externalId:crypto.randomUUID(),label,machine:'Example laptop',project:'demo',task:'Coordinate the session-centered messaging change',status});
const x=(await register(a,'Release readiness','WAITING_ON_USER')).session,y=(await register(b,'Review messaging UX')).session;
await call(a.token,'/messages',{fromSessionId:x.id,toSessionId:y.id,project:'demo',kind:'HANDOFF',body:'The message drawer is ready for review. Check session search, mobile layout and recipient context.',idempotencyKey:crypto.randomUUID()});
await call(a.token,'/messages',{fromSessionId:x.id,project:'demo',kind:'QUESTION',body:'Should we proceed after the reviewed acceptance checks pass?',idempotencyKey:crypto.randomUUID()});
const browser=await chromium.launch({headless:true,...(process.env.HUB_BROWSER_EXECUTABLE?{executablePath:process.env.HUB_BROWSER_EXECUTABLE}:{})});const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
const evidence=process.env.HUB_FIXTURE_EVIDENCE_DIR || fileURLToPath(new URL('../.evidence/message-ux/',import.meta.url));await mkdir(evidence,{recursive:true});
async function connect(token){await page.goto(origin);await page.locator('#hub-token').fill(token);await page.locator('#connect-form button').click();await page.locator('.session-card').first().waitFor();}
async function overflow(){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page overflow');assert.ok(await page.locator('#message-drawer').evaluate(el=>el.scrollWidth<=el.clientWidth),'drawer overflow');}
try {
await connect(OWNER);
await page.screenshot({path:evidence+'/message-ux-board.png',fullPage:true});
await page.locator('.session-card').filter({hasText:y.label}).getByRole('button',{name:'Send message to:',exact:false}).click();
await page.locator('#message-form').waitFor({state:'visible'});assert.match(await page.locator('#compose-recipient').innerText(),/Review messaging UX/);assert.equal(await page.locator('#to-session').count(),0);
await page.locator('#message-body').fill('Owner message to the selected review session.');await page.locator('#send-button').click();await page.locator('#send-message').filter({hasText:'delivered'}).waitFor();
const messages=await call(OWNER,'/messages?sessionId='+y.id);assert.equal(messages.messages.at(-1).toSessionId,y.id);
await page.locator('#cancel-compose').click();await page.locator('#message-search').fill('drawer');await page.waitForResponse(r=>r.url().includes('/messages?')&&r.url().includes('q=drawer'));await page.locator('#message-list .message-card').waitFor();assert.equal(await page.locator('#message-list .message-card').count(),1);
await page.screenshot({path:evidence+'/message-ux-desktop.png'});await overflow();
await page.keyboard.press('Escape');await page.locator('#message-drawer').waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.className==='session-select');
await page.locator('#session-search').fill('readiness');await page.waitForResponse(r=>r.url().includes('/sessions?q=readiness'));await page.waitForFunction(()=>document.querySelectorAll('.session-card').length===1);
await page.locator('#open-owner-inbox').click();await page.locator('#message-list .message-card').waitFor();assert.equal(await page.locator('#message-list .message-card').count(),1);
await page.getByRole('button',{name:'Answer question'}).click();assert.match(await page.locator('#compose-recipient').innerText(),/Release readiness/);await page.locator('#message-body').fill('Please complete the documented review checks.');await page.locator('#send-button').click();await page.locator('#send-message').filter({hasText:'delivered'}).waitFor();
await page.locator('#close-drawer').click();
await connect(a.token);await page.locator('#status-filter').selectOption('WAITING_ON_USER');await page.waitForResponse(r=>r.url().includes('status=WAITING_ON_USER'));await page.locator('#session-search').fill('readiness');await page.waitForResponse(r=>r.url().includes('q=readiness'));
await page.locator('#ask-owner').click();await page.locator('#from-session option').filter({hasText:'Release readiness'}).waitFor({state:'attached'});assert.equal(await page.locator('#from-session').inputValue(),x.id);await page.locator('#message-body').fill('Question from the contextual sender.');await page.locator('#send-button').click();await page.locator('#send-message').filter({hasText:'Question submitted'}).waitFor();await page.keyboard.press('Escape');
await page.locator('#status-filter').selectOption('ALL');await page.locator('#session-search').fill('Review');await page.waitForResponse(r=>r.url().includes('q=Review'));
await page.locator('.session-card').filter({hasText:y.label}).getByRole('button',{name:'Send message to:',exact:false}).click();await page.locator('#from-session option').filter({hasText:'Release readiness'}).waitFor({state:'attached'});assert.equal(await page.locator('#from-session').inputValue(),x.id);
let dropResponse=true;await page.route('**/api/messages',async route=>{if(route.request().method()==='POST' && dropResponse){dropResponse=false;await route.fetch();await route.abort('failed');}else await route.continue();});
await page.locator('#message-body').fill('Retry-safe contextual agent message.');await page.locator('#send-button').click();await page.waitForFunction(()=>document.getElementById('send-message').textContent && !document.getElementById('send-button').disabled);
await page.locator('#send-button').click();await page.locator('#send-message').filter({hasText:'delivered'}).waitFor();await page.unroute('**/api/messages');
const retryMessages=await call(OWNER,'/messages?sessionId='+y.id);assert.equal(retryMessages.messages.filter(m=>m.body==='Retry-safe contextual agent message.').length,1);await page.keyboard.press('Escape');
await connect(b.token);await page.locator('.session-card').filter({hasText:y.label}).getByRole('button',{name:'Messages:',exact:false}).click();await page.getByRole('button',{name:'Acknowledge receipt'}).first().click();await page.locator('.acknowledged-label').first().waitFor();await page.keyboard.press('Escape');
await connect(observer.token);assert.equal(await page.getByRole('button',{name:'Send message to:',exact:false}).count(),0);await page.locator('#open-owner-inbox').click();await page.locator('#message-list .message-card').first().waitFor();assert.equal(await page.getByRole('button',{name:'Answer question'}).count(),0);assert.equal(await page.getByRole('button',{name:'Acknowledge receipt'}).count(),0);await page.keyboard.press('Escape');
// Merged history remains visible even though original segment/session IDs are preserved.
const historical=await call(OWNER,'/principals',{name:'History agent',account:'history@example.test',projects:['demo']});
const historicalExternal=crypto.randomUUID();
const historicalSession=async externalId=>(await call(historical.token,'/sessions',{externalId,label:'Merged history session',machine:'Example laptop',project:'demo',task:'Verify immutable history',status:'RUNNING'})).session;
const oldRegistration=await historicalSession(historicalExternal),canonicalRegistration=await historicalSession('codex:'+historicalExternal);
const earlierSegment=await call(historical.token,'/sessions/'+oldRegistration.id+'/attribution',{provider:'Example provider',client:'Example client',model:'Earlier model',previousSegmentId:null,idempotencyKey:crypto.randomUUID()});
await call(historical.token,'/sessions/'+canonicalRegistration.id+'/attribution',{provider:'Example provider',client:'Example client',model:'Current model',previousSegmentId:oldRegistration.id===canonicalRegistration.id?earlierSegment.segment.id:null,idempotencyKey:crypto.randomUUID()});
const historyRoute='**/api/sessions/'+canonicalRegistration.id+'/attribution**';
if(oldRegistration.id!==canonicalRegistration.id) await call(historical.token,'/sessions/'+oldRegistration.id+'/merge',{targetSessionId:canonicalRegistration.id});
else {
  // New registrations deduplicate immediately. Simulate the authorized legacy
  // projection for the UI check; structural tests seed real pre-upgrade aliases.
  await page.route(historyRoute,async route=>{const response=await route.fetch(),body=await response.json();body.segments[0].sessionId='synthetic-earlier-registration';await route.fulfill({response,json:body});});
}
await connect(OWNER);await page.locator('.session-card').filter({hasText:'Merged history session'}).getByRole('button',{name:'Messages:',exact:false}).click();await page.locator('#session-details-wrap summary').click();await page.waitForFunction(()=>document.querySelectorAll('.attribution-item').length===2);assert.match(await page.locator('.attribution-list').innerText(),/Earlier model/);assert.match(await page.locator('.attribution-list').innerText(),/Earlier registration:/);await page.keyboard.press('Escape');await page.unroute(historyRoute);
await page.setViewportSize({width:390,height:844});await connect(OWNER);await page.locator('.session-card').filter({hasText:y.label}).getByRole('button',{name:'Messages:',exact:false}).click();await page.locator('#message-list .message-card').first().waitFor();await overflow();await page.screenshot({path:evidence+'/message-ux-mobile.png'});
await page.locator('#compose-message').click();await page.locator('#message-body').fill('Mobile composer draft');await overflow();await page.screenshot({path:evidence+'/message-ux-mobile-compose.png'});
await page.locator('#close-drawer').click();await page.emulateMedia({colorScheme:'dark'});await page.locator('#open-all-messages').click();await page.locator('#message-list .message-card').first().waitFor();await overflow();await page.screenshot({path:evidence+'/message-ux-dark.png'});assert.equal(await page.evaluate(()=>document.getElementById('open-owner-inbox').getBoundingClientRect().top < document.getElementById('sessions-title').getBoundingClientRect().top),true);await page.locator('#close-drawer').click();
// Sender discovery must include old sessions beyond the first response page.
for(let i=0;i<200;i++)await register(a,'Additional sending session '+i);
await connect(a.token);await page.locator('#ask-owner').click();await page.waitForFunction(()=>document.querySelectorAll('#from-session option').length===202);await page.locator('#from-session').selectOption(x.id);assert.equal(await page.locator('#from-session').inputValue(),x.id);await page.locator('#message-body').fill('Pagination draft only');
await page.locator('#logout-button').evaluate(el=>el.click());await page.locator('#message-drawer').waitFor({state:'hidden'});assert.equal(await page.locator('#message-body').inputValue(),'');assert.deepEqual(errors,[]);
console.log('Browser checks passed: contextual recipient/send/reply, session/message search, sender discovery despite board filters and beyond 200 sessions, alias-origin attribution display, owner/observer custody, Escape/disconnect, desktop and 390px overflow.');

} finally { await browser.close(); }
