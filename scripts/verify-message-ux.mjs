// Optional browser QA; reuse an installed Playwright and a fresh synthetic local server.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.HUB_BROWSER_MODULE || 'playwright');
import {mkdir} from 'node:fs/promises';
const origin=process.env.HUB_FIXTURE_ORIGIN || 'http://127.0.0.1:8798';
assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/,'Browser verification requires a fresh loopback fixture');
const OWNER=process.env.HUB_FIXTURE_OWNER_TOKEN;
assert.ok(OWNER && OWNER.length>=32,'Supply the local synthetic OWNER_TOKEN through HUB_FIXTURE_OWNER_TOKEN');
async function call(token,path,body,method=body?'POST':'GET'){const r=await fetch(origin+'/api'+path,{method,headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,await r.clone().text());return r.json();}
const a=await call(OWNER,'/principals',{name:'Release agent',account:'release@example.test',projects:['demo']});
const b=await call(OWNER,'/principals',{name:'Review agent',account:'review@example.test',projects:['demo']});
const observer=await call(OWNER,'/principals',{name:'Project observer',account:'observer@example.test',projects:['demo'],profile:'observer'});
const coordinator=await call(OWNER,'/principals',{name:'Project coordinator',account:'coordinator@example.test',projects:['demo'],profile:'coordinator'});
const register=(actor,label,status='RUNNING')=>call(actor.token,'/sessions',{externalId:crypto.randomUUID(),label,machine:'Example laptop',project:'demo',task:'Coordinate the session-centered messaging change',status});
const x=(await register(a,'Release readiness','WAITING_ON_USER')).session,y=(await register(b,'Review messaging UX')).session,c=(await register(coordinator,'Coordination desk')).session;
await call(a.token,'/messages',{fromSessionId:x.id,toSessionId:y.id,project:'demo',kind:'HANDOFF',body:'The message drawer is ready for review. Check session search, mobile layout and recipient context.',idempotencyKey:crypto.randomUUID()});
const ownerQuestion=(await call(a.token,'/messages',{fromSessionId:x.id,project:'demo',kind:'QUESTION',body:'Should we proceed after the reviewed acceptance checks pass?',idempotencyKey:crypto.randomUUID()})).message;
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
// Coordinators read the project, but receipts/sending identity remain their own.
const foreign=await call(OWNER,'/principals',{name:'Foreign project agent',account:'foreign@example.test',projects:['beta']});
const foreignSession=(await call(foreign.token,'/sessions',{externalId:crypto.randomUUID(),label:'Foreign project session',machine:'Example laptop',project:'beta',task:'Synthetic scope check',status:'RUNNING'})).session;
await call(foreign.token,'/messages',{fromSessionId:foreignSession.id,project:'beta',kind:'QUESTION',body:'Private beta question',idempotencyKey:crypto.randomUUID()});
const ownReceipt=(await call(a.token,'/messages',{fromSessionId:x.id,toSessionId:c.id,project:'demo',kind:'NOTE',body:'Coordinator own receipt.',idempotencyKey:crypto.randomUUID()})).message;
await connect(coordinator.token);
assert.match(await page.locator('#principal-summary').innerText(),/Coordinator/);
assert.equal(await page.locator('#owner-tools').isVisible(),false);
await page.locator('#open-owner-inbox').click();
const questionCard=page.locator(`.message-card[data-message-id="${ownerQuestion.id}"]`);
await questionCard.waitFor();
assert.equal(await page.locator('.message-card').filter({hasText:'Private beta question'}).count(),0);
assert.equal(await questionCard.getByRole('button',{name:'Answer question',exact:true}).count(),0);
assert.equal(await questionCard.getByRole('button',{name:'Acknowledge receipt',exact:true}).count(),0);
const beforeQuestion=(await call(OWNER,'/messages?scope=owner&q=Should')).messages.find(m=>m.id===ownerQuestion.id);
await questionCard.getByRole('button',{name:'Relay owner answer',exact:true}).click();
await page.waitForFunction(()=>document.getElementById('from-session').value!=='' && !document.getElementById('send-button').disabled);
assert.equal(await page.locator('#from-session').inputValue(),c.id);
assert.match(await page.locator('#compose-recipient').innerText(),/Release readiness/);
assert.equal(await page.locator('#message-kind').inputValue(),'ANSWER');
assert.equal(await page.locator('#message-kind').isDisabled(),true);
assert.equal(await page.locator('#message-form').evaluate(el=>el.checkValidity()),false);
assert.equal(await page.locator('#to-session').count(),0);
const ownerAnswer='  Use the reviewed option.\nPreserve this exact wording.\n  ';
const ownerReference='Synthetic owner conversation turn 42';
await page.locator('#message-body').fill(ownerAnswer);
await page.locator('#owner-relay-source').fill(ownerReference);
assert.equal(await page.locator('#message-form').evaluate(el=>el.checkValidity()),false);
await page.locator('#owner-relay-confirmed').check();
let loseRelayResponse=true;const relayRequests=[];
await page.route('**/api/messages',async route=>{
  if(route.request().method()==='POST'){
    relayRequests.push(route.request().postDataJSON());
    if(loseRelayResponse){loseRelayResponse=false;await route.fetch();await route.abort('failed');return;}
  }
  await route.continue();
});
await page.locator('#send-button').click();
await page.waitForFunction(()=>document.getElementById('send-message').textContent && !document.getElementById('send-button').disabled);
await page.locator('#send-button').click();
await page.locator('#send-message').filter({hasText:'delivered'}).waitFor();
await page.unroute('**/api/messages');
assert.equal(relayRequests.length,2);assert.equal(relayRequests[0].idempotencyKey,relayRequests[1].idempotencyKey);
assert.equal(relayRequests[0].body,ownerAnswer);assert.equal(relayRequests[1].body,ownerAnswer);
assert.equal(relayRequests[0].toSessionId,x.id);assert.equal(relayRequests[0].project,'demo');assert.equal(relayRequests[0].replyTo,ownerQuestion.id);
assert.deepEqual(relayRequests[0].ownerRelay,{ownerProvided:true,sourceReference:ownerReference});
const relays=(await call(OWNER,'/messages?sessionId='+x.id)).messages.filter(m=>m.body===ownerAnswer);
assert.equal(relays.length,1);assert.equal(relays[0].fromPrincipalId,coordinator.principal.id);assert.equal(relays[0].fromSessionId,c.id);
assert.deepEqual(relays[0].ownerRelay,{source:'delegate-reported',sourceReference:ownerReference});
const afterQuestion=(await call(OWNER,'/messages?scope=owner&q=Should')).messages.find(m=>m.id===ownerQuestion.id);
assert.equal(afterQuestion.acknowledgedAt,beforeQuestion.acknowledgedAt);
await page.keyboard.press('Escape');
await page.locator('.session-card').filter({hasText:'Coordination desk'}).getByRole('button',{name:'Messages:',exact:false}).click();
const receiptCard=page.locator('.message-card').filter({hasText:'Coordinator own receipt.'});await receiptCard.waitFor();
await receiptCard.getByRole('button',{name:'Acknowledge receipt',exact:true}).click();await receiptCard.locator('.acknowledged-label').waitFor();
assert.ok((await call(OWNER,'/messages?sessionId='+c.id)).messages.find(m=>m.id===ownReceipt.id).acknowledgedAt);
await page.locator('#session-details-wrap summary').click();assert.equal(await page.locator('#claim-form').isVisible(),false);await page.keyboard.press('Escape');
await page.locator('.session-card').filter({hasText:y.label}).getByRole('button',{name:'Send message to:',exact:false}).click();
await page.waitForFunction(()=>document.getElementById('from-session').value!=='' && !document.getElementById('send-button').disabled);
await page.locator('#message-body').fill('Coordinator note from its own session.');await page.locator('#send-button').click();await page.locator('#send-message').filter({hasText:'delivered'}).waitFor();
assert.equal((await call(OWNER,'/messages?sessionId='+y.id)).messages.find(m=>m.body==='Coordinator note from its own session.').fromSessionId,c.id);
await page.keyboard.press('Escape');
await page.locator('#open-owner-inbox').click();await page.locator(`.message-card[data-message-id="${ownerQuestion.id}"]`).getByRole('button',{name:'Relay owner answer',exact:true}).click();
await page.waitForFunction(()=>document.getElementById('from-session').value!=='');
await page.locator('#message-body').fill('Canceled relay draft');await page.locator('#owner-relay-source').fill('Canceled source');await page.locator('#owner-relay-confirmed').check();
await page.locator('#cancel-compose').click();assert.equal(await page.locator('#message-form').isVisible(),false);assert.equal(await page.locator('#owner-relay-source').inputValue(),'');assert.equal(await page.locator('#owner-relay-confirmed').isChecked(),false);
await page.locator(`.message-card[data-message-id="${ownerQuestion.id}"]`).getByRole('button',{name:'Relay owner answer',exact:true}).click();await page.waitForFunction(()=>document.getElementById('from-session').value!=='');
await page.locator('#message-body').fill('Downgraded relay draft');await page.locator('#owner-relay-source').fill('Downgraded source');await page.locator('#owner-relay-confirmed').check();
await call(OWNER,'/principals/'+coordinator.principal.id,{profile:'observer'},'PATCH');
await page.locator('#refresh-button').evaluate(el=>el.click());await page.waitForFunction(()=>document.getElementById('principal-summary').textContent.includes('Project observer'));
assert.equal(await page.locator('#message-form').isVisible(),false);assert.equal(await page.getByRole('button',{name:'Relay owner answer',exact:true}).count(),0);assert.equal(await page.locator('#message-body').inputValue(),'');assert.equal(await page.locator('#owner-relay-source').inputValue(),'');assert.equal(await page.locator('#owner-relay-confirmed').isChecked(),false);await page.keyboard.press('Escape');
await call(OWNER,'/principals/'+coordinator.principal.id,{profile:'coordinator'},'PATCH');
await connect(a.token);await page.locator('.session-card').filter({hasText:x.label}).getByRole('button',{name:'Messages:',exact:false}).click();
const receivedRelay=page.locator('.message-card').filter({hasText:'Preserve this exact wording.'});await receivedRelay.waitFor();assert.match(await receivedRelay.innerText(),/Owner answer relayed by Project coordinator/);assert.match(await receivedRelay.innerText(),/Synthetic owner conversation turn 42/);await page.keyboard.press('Escape');
await page.setViewportSize({width:390,height:844});await connect(coordinator.token);await page.locator('#open-owner-inbox').click();await page.locator(`.message-card[data-message-id="${ownerQuestion.id}"]`).getByRole('button',{name:'Relay owner answer',exact:true}).click();await page.waitForFunction(()=>document.getElementById('from-session').value!=='');
await page.locator('#message-body').fill(ownerAnswer);await page.locator('#owner-relay-source').fill(ownerReference);await page.locator('#owner-relay-confirmed').check();await overflow();await page.screenshot({path:evidence+'/message-ux-coordinator-mobile.png'});await page.keyboard.press('Escape');await page.setViewportSize({width:1440,height:1000});

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
console.log('Browser checks passed: contextual recipient/send/reply, session/message search, sender discovery despite board filters and beyond 200 sessions, alias-origin attribution display, owner/observer/coordinator custody, verbatim attributed owner relay with stable retry and downgrade/cancel cleanup, Escape/disconnect, desktop and 390px overflow.');

} finally { await browser.close(); }
