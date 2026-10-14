// Transport only. The receiving broker still verifies the nested native
// signature, mutual local pairing, enrollment epoch and exact runtime target.
const DOMAIN='ai-profiles/native-relay/1';
const OPS=['inspect','prepare','deliver','receipt','acknowledge'];
const encoder=new TextEncoder();
const seconds=()=>Math.floor(Date.now()/1000);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const raw=value=>Uint8Array.from(atob(value),character=>character.charCodeAt(0));
const keys=(value,allowed,fail)=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail(422,'INVALID_RELAY_SCHEMA','Unsupported native relay schema.');
};
function enabled(env,fail){
  if(env.NATIVE_RELAY_ENABLED!=='true')fail(404,'RELAY_DISABLED','Native relay is not enabled.');
  if(env.HUB_USAGE_LIMITS_JSON===undefined||env.HUB_TRAFFIC_GUARD_REQUIRED!=='true')fail(503,'RELAY_BUDGET_REQUIRED','Enable request budgets and traffic guards before native relay.');
}
async function signed(envelope,kind,device,origin,fail){
  keys(envelope,['version','id','origin','project','payload','signature'],fail);
  if(envelope.version!==1||!uuid(envelope.id)||envelope.origin!==origin||envelope.project!==device.project||typeof envelope.payload!=='string'||encoder.encode(envelope.payload).length>32768||typeof envelope.signature!=='string'||! /^[A-Za-z0-9+/]{86}$/.test(envelope.signature))fail(422,'INVALID_RELAY_ENVELOPE','Native relay envelope scope, version or size is invalid.');
  let valid=false;
  try{
    const key=await crypto.subtle.importKey('raw',raw(device.public_key),{name:'Ed25519'},false,['verify']);
    valid=await crypto.subtle.verify('Ed25519',key,raw(envelope.signature),encoder.encode(JSON.stringify([DOMAIN,kind,envelope.id,envelope.origin,envelope.project,envelope.payload])));
  }catch{}
  if(!valid)fail(403,'RELAY_SIGNATURE','Native relay signature was rejected.');
  let payload;try{payload=JSON.parse(envelope.payload);}catch{fail(422,'INVALID_RELAY_SCHEMA','Native relay payload must be JSON.');}
  return payload;
}
const deviceSelect=`SELECT d.* FROM native_relay_devices d JOIN principals p ON p.id=d.principal_id WHERE d.active=1 AND d.expires_at>? AND p.active=1 AND (p.role='owner' OR EXISTS(SELECT 1 FROM json_each(p.projects_json) WHERE value=d.project))`;
async function device(db,id,fail){
  const row=await db.prepare(deviceSelect+' AND d.id=?').bind(seconds(),id).first();
  if(!row)fail(403,'RELAY_DEVICE_REVOKED','Native relay device is unavailable or revoked.');
  return row;
}
async function authenticated(ctx){
  const {request,db,digest,fail}=ctx;
  const authorization=request.headers.get('authorization');
  if(!authorization?.startsWith('Bearer hub_device_')||authorization.length>520)fail(401,'RELAY_DEVICE_REQUIRED','A separate native relay device capability is required.');
  const tokenHash=await digest(authorization.slice(7));
  const row=await db.prepare(deviceSelect+' AND d.token_hash=?').bind(seconds(),tokenHash).first();
  if(!row)fail(401,'RELAY_DEVICE_REVOKED','Native relay device is unavailable or revoked.');
  return row;
}
function pair(sender,recipient,fail){
  if(sender.project!==recipient.project||sender.id===recipient.id||!sender.can_send||!recipient.can_receive||!JSON.parse(sender.peers_json).includes(recipient.id)||!JSON.parse(recipient.peers_json).includes(sender.id))fail(403,'RELAY_PAIR_DENIED','The native relay devices are not mutually enrolled for this operation.');
}
// Rechecked atomically at each queue/claim/reply mutation, including token
// rotation, project revocation and both device directions.
const authority=`EXISTS(SELECT 1 FROM native_relay_devices a JOIN principals p ON p.id=a.principal_id JOIN native_relay_devices b ON b.id=? JOIN principals q ON q.id=b.principal_id WHERE a.id=? AND a.token_hash=? AND a.active=1 AND b.active=1 AND a.expires_at>? AND b.expires_at>? AND p.active=1 AND q.active=1 AND a.project=b.project AND (p.role='owner' OR EXISTS(SELECT 1 FROM json_each(p.projects_json) WHERE value=a.project)) AND (q.role='owner' OR EXISTS(SELECT 1 FROM json_each(q.projects_json) WHERE value=b.project)) AND EXISTS(SELECT 1 FROM json_each(a.peers_json) WHERE value=b.id) AND EXISTS(SELECT 1 FROM json_each(b.peers_json) WHERE value=a.id))`;
const guardValues=(caller,other)=>[other.id,caller.id,caller.token_hash,seconds(),seconds()];
function referenceAllowed(recipient,reference,fail){
  keys(reference,['deviceId','profileId','app','conversationId'],fail);
  if(reference.deviceId!==recipient.id||typeof reference.conversationId!=='string'||!reference.conversationId||reference.conversationId.length>256||!JSON.parse(recipient.profiles_json).some(profile=>profile.profileId===reference.profileId&&profile.app===reference.app))fail(403,'RELAY_TARGET_DENIED','The receiving app/profile is outside the relay device scope.');
}
function nativeRequest(payload,caller,recipient,fail){
  keys(payload,['intent','body','signature'],fail);
  const intent=payload.intent;
  keys(intent,['version','operation','requestId','sender','recipient','reference','epoch','handle','bodyDigest','issuedAt','expiresAt'],fail);
  if(intent.version!==1||!OPS.includes(intent.operation)||!uuid(intent.requestId)||intent.sender!==caller.id||intent.recipient!==recipient.id||!Number.isSafeInteger(intent.issuedAt)||!Number.isSafeInteger(intent.expiresAt)||intent.issuedAt>seconds()+5||intent.expiresAt<=seconds()||intent.expiresAt<=intent.issuedAt||intent.expiresAt-intent.issuedAt>120||typeof payload.body!=='string'||typeof payload.signature!=='string')fail(422,'INVALID_NATIVE_INTENT','Native relay requires a current, exact signed native intent.');
  referenceAllowed(recipient,intent.reference,fail);
  return intent;
}
async function rowFor(ctx,caller,url){
  const {db,fail}=ctx;
  const requestId=url.searchParams.get('requestId'),operation=url.searchParams.get('operation'),peerId=url.searchParams.get('peerId');
  if(!uuid(requestId)||!uuid(peerId)||!OPS.includes(operation))fail(422,'INVALID_RELAY_REQUEST','Select an exact relay request and operation.');
  const row=await db.prepare('SELECT * FROM native_relay_requests WHERE request_id=? AND operation=? AND ((sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?))').bind(requestId,operation,caller.id,peerId,peerId,caller.id).first();
  if(!row)fail(404,'RELAY_REQUEST_UNKNOWN','Native relay request is unavailable.');
  const other=await device(db,peerId,fail);
  pair(row.sender_id===caller.id?caller:other,row.recipient_id===caller.id?caller:other,fail);
  return {row,other};
}

export async function nativeRelayApi(ctx){
  const {request,env,db,url,readBody,digest,fail,json}=ctx;
  enabled(env,fail);
  const caller=await authenticated(ctx),path=url.pathname,method=request.method;
  if(path==='/api/native-relay/self'&&method==='GET')return json({deviceId:caller.id,project:caller.project,publicKey:caller.public_key,canSend:!!caller.can_send,canReceive:!!caller.can_receive,expiresAt:caller.expires_at});
  if(path==='/api/native-relay/info'&&method==='PUT'){
    const envelope=await readBody(),info=await signed(envelope,'info',caller,url.origin,fail);
    keys(info,['deviceId','epoch','enabled','publicKey','issuedAt','expiresAt'],fail);
    if(info.deviceId!==caller.id||info.publicKey!==caller.public_key||!uuid(info.epoch)||typeof info.enabled!=='boolean'||!Number.isSafeInteger(info.issuedAt)||!Number.isSafeInteger(info.expiresAt)||info.issuedAt>seconds()+5||info.expiresAt<=seconds()||info.expiresAt<=info.issuedAt||info.expiresAt-info.issuedAt>900)fail(422,'INVALID_RELAY_INFO','Device metadata must be fresh and signed for this device.');
    await device(db,caller.id,fail);
    const result=await db.prepare(`UPDATE native_relay_devices SET info_json=?,info_expires_at=? WHERE id=? AND token_hash=? AND active=1 AND expires_at>? AND EXISTS(SELECT 1 FROM principals p WHERE p.id=? AND p.active=1 AND (p.role='owner' OR EXISTS(SELECT 1 FROM json_each(p.projects_json) WHERE value=native_relay_devices.project)))`).bind(JSON.stringify(envelope),info.expiresAt,caller.id,caller.token_hash,seconds(),caller.principal_id).run();
    if(!result.meta.changes)fail(409,'RELAY_DEVICE_REVOKED','Native relay enrollment changed.');
    return json({published:true});
  }
  if(path==='/api/native-relay/info'&&method==='GET'){
    const recipient=await device(db,url.searchParams.get('peerId'),fail);pair(caller,recipient,fail);
    if(!recipient.info_json||recipient.info_expires_at<=seconds())fail(409,'RELAY_INFO_STALE','The receiving companion needs to refresh its signed relay metadata.');
    await authenticated(ctx);await device(db,recipient.id,fail);
    return json({envelope:JSON.parse(recipient.info_json)});
  }
  if(path==='/api/native-relay/requests'&&method==='POST'){
    const envelope=await readBody(),payload=await signed(envelope,'request',caller,url.origin,fail);
    const recipient=await device(db,payload?.intent?.recipient,fail);pair(caller,recipient,fail);
    const intent=nativeRequest(payload,caller,recipient,fail),hash=await digest(JSON.stringify(envelope)),date=seconds();
    const existing=await db.prepare('SELECT payload_hash,state FROM native_relay_requests WHERE sender_id=? AND recipient_id=? AND request_id=? AND operation=?').bind(caller.id,recipient.id,envelope.id,intent.operation).first();
    if(existing){if(existing.payload_hash!==hash)fail(409,'RELAY_REPLAY_CONFLICT','That request is already bound to different signed content.');await authenticated(ctx);return json({requestId:envelope.id,operation:intent.operation,state:existing.state});}
    // Small indexed counts bound both outstanding work and retained tombstones.
    const result=await db.prepare(`INSERT INTO native_relay_requests(sender_id,recipient_id,request_id,native_request_id,operation,project,payload_hash,payload_json,state,expires_at,created_at) SELECT ?,?,?,?,?,?,?,?,'pending',?,? WHERE ${authority} AND (SELECT COUNT(*) FROM native_relay_requests WHERE recipient_id=? AND state IN ('pending','claimed') AND expires_at>?)<10 AND COALESCE((SELECT requests FROM native_relay_daily_usage WHERE device_id=? AND day=?),0)<100 AND (SELECT retained FROM native_relay_capacity WHERE id=1)<5000 ON CONFLICT(sender_id,recipient_id,request_id,operation) DO NOTHING`).bind(caller.id,recipient.id,envelope.id,intent.requestId,intent.operation,caller.project,hash,JSON.stringify(envelope),intent.expiresAt,date,...guardValues(caller,recipient),recipient.id,date,caller.id,Math.floor(date/86400)).run();
    if(!result.meta.changes)fail(409,'RELAY_CAPACITY_OR_REVOCATION','Relay capacity, custody or enrollment changed; check the exact request before retrying.');
    return json({requestId:envelope.id,operation:intent.operation,state:'pending'},201);
  }
  if(path==='/api/native-relay/pending'&&method==='GET'){
    if(!caller.can_receive)fail(403,'RELAY_RECEIVE_DENIED','This device cannot receive relay requests.');
    await db.prepare("UPDATE native_relay_requests SET state='expired',payload_json=NULL WHERE recipient_id=? AND state='pending' AND expires_at<=?").bind(caller.id,seconds()).run();
    const rows=await db.prepare("SELECT sender_id AS senderId,request_id AS requestId,operation,expires_at AS expiresAt,payload_hash AS payloadHash FROM native_relay_requests WHERE recipient_id=? AND state='pending' AND expires_at>? ORDER BY expires_at LIMIT 10").bind(caller.id,seconds()).all();
    await authenticated(ctx);return json({pending:rows.results});
  }
  if(path==='/api/native-relay/request'&&method==='GET'){
    const {row}=await rowFor(ctx,caller,url);await authenticated(ctx);
    return json({state:row.state,envelope:row.reply_json?JSON.parse(row.reply_json):null});
  }
  if(path==='/api/native-relay/claim'&&method==='POST'){
    const body=await readBody();keys(body,['requestId','operation','peerId','payloadHash'],fail);
    const selected=new URL(url);for(const name of ['requestId','operation','peerId'])selected.searchParams.set(name,body[name]);
    const {row,other}=await rowFor(ctx,caller,selected);
    if(!caller.can_receive||row.recipient_id!==caller.id||row.payload_hash!==body.payloadHash||row.state!=='pending'||row.expires_at<=seconds()||!row.payload_json)fail(409,'RELAY_ALREADY_ATTEMPTED','Relay request was claimed, expired or changed. Never redeliver an ambiguous attempt.');
    const claimId=crypto.randomUUID();
    const result=await db.prepare(`UPDATE native_relay_requests SET state='claimed',claim_id=?,payload_json=NULL WHERE sender_id=? AND recipient_id=? AND request_id=? AND operation=? AND state='pending' AND expires_at>? AND payload_hash=? AND ${authority}`).bind(claimId,row.sender_id,caller.id,row.request_id,row.operation,seconds(),body.payloadHash,...guardValues(caller,other)).run();
    if(!result.meta.changes)fail(409,'RELAY_ALREADY_ATTEMPTED','Another worker claimed the request or enrollment changed.');
    await authenticated(ctx);await device(db,other.id,fail);
    return json({claimId,envelope:JSON.parse(row.payload_json)});
  }
  if(path==='/api/native-relay/reply'&&method==='POST'){
    const body=await readBody();keys(body,['requestId','operation','peerId','claimId','envelope'],fail);
    const selected=new URL(url);for(const name of ['requestId','operation','peerId'])selected.searchParams.set(name,body[name]);
    const {row,other}=await rowFor(ctx,caller,selected);
    if(!caller.can_receive||row.recipient_id!==caller.id||row.claim_id!==body.claimId||!['claimed','complete'].includes(row.state))fail(403,'RELAY_CLAIM_REQUIRED','Only the exact receiving claim can publish a receipt.');
    const reply=await signed(body.envelope,'reply',caller,url.origin,fail);
    if(body.envelope.id!==row.request_id||reply.requestId!==row.native_request_id||reply.sender!==caller.id||reply.recipient!==other.id)fail(422,'RELAY_REPLY_MISMATCH','Receipt identity does not match the claimed request.');
    const serialized=JSON.stringify(body.envelope);
    if(row.reply_json){if(row.reply_json!==serialized)fail(409,'RELAY_REPLY_CONFLICT','A different receipt is already recorded.');return json({recorded:true});}
    const result=await db.prepare(`UPDATE native_relay_requests SET state='complete',reply_json=? WHERE sender_id=? AND recipient_id=? AND request_id=? AND operation=? AND claim_id=? AND state='claimed' AND ${authority}`).bind(serialized,other.id,caller.id,row.request_id,row.operation,body.claimId,...guardValues(caller,other)).run();
    if(!result.meta.changes)fail(409,'RELAY_DEVICE_REVOKED','Native relay enrollment changed before receipt persistence.');
    return json({recorded:true});
  }
  fail(404,'ROUTE_NOT_FOUND','Native relay endpoint not found.');
}

export async function nativeRelayEnrollment(ctx){
  const {path,method,env,db,principal,readBody,digest,fail,json}=ctx;
  if(!path.startsWith('/api/native-devices'))return null;
  enabled(env,fail);
  if(principal.role!=='owner')fail(403,'OWNER_REQUIRED','Only the owner can enroll separate relay device capabilities.');
  if(path==='/api/native-devices'&&method==='GET'){
    const rows=await db.prepare('SELECT id AS deviceId,principal_id AS principalId,project,public_key AS publicKey,active,expires_at AS expiresAt,can_send AS canSend,can_receive AS canReceive,peers_json,profiles_json FROM native_relay_devices ORDER BY created_at LIMIT 128').all();
    return json({devices:rows.results.map(({peers_json,profiles_json,...row})=>({...row,peers:JSON.parse(peers_json),profiles:JSON.parse(profiles_json)}))});
  }
  if(path==='/api/native-devices'&&method==='POST'){
    const body=await readBody();keys(body,['deviceId','principalId','project','publicKey','peers','profiles','canSend','canReceive','expiresInDays'],fail);
    if(!uuid(body.deviceId)||typeof body.principalId!=='string'||typeof body.project!=='string'||! /^[a-z0-9][a-z0-9-]{0,63}$/.test(body.project)||typeof body.publicKey!=='string'||! /^[A-Za-z0-9+/]{43}$/.test(body.publicKey)||!Array.isArray(body.peers)||body.peers.length>16||body.peers.some(peer=>!uuid(peer)||peer===body.deviceId)||!Array.isArray(body.profiles)||body.profiles.length>128||typeof body.canSend!=='boolean'||typeof body.canReceive!=='boolean'||!Number.isInteger(body.expiresInDays)||body.expiresInDays<1||body.expiresInDays>30)fail(422,'INVALID_RELAY_ENROLLMENT','Provide an exact device, key, project, peers, profiles, capabilities and 1–30 day lifetime.');
    for(const profile of body.profiles){keys(profile,['profileId','app'],fail);if(typeof profile.profileId!=='string'||!profile.profileId||profile.profileId.length>128||!['claude','codex'].includes(profile.app))fail(422,'INVALID_RELAY_ENROLLMENT','Select exact Claude or Codex profile IDs.');}
    const token='hub_device_'+Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');
    const result=await db.prepare(`INSERT INTO native_relay_devices(id,principal_id,project,public_key,token_hash,peers_json,profiles_json,can_send,can_receive,expires_at,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM principals WHERE id=? AND active=1 AND (role='owner' OR EXISTS(SELECT 1 FROM json_each(projects_json) WHERE value=?))) AND ((SELECT COUNT(*) FROM native_relay_devices)<128 OR EXISTS(SELECT 1 FROM native_relay_devices WHERE id=? AND active=0)) ON CONFLICT(id) DO UPDATE SET public_key=excluded.public_key,token_hash=excluded.token_hash,peers_json=excluded.peers_json,profiles_json=excluded.profiles_json,can_send=excluded.can_send,can_receive=excluded.can_receive,active=1,expires_at=excluded.expires_at,info_json=NULL,info_expires_at=NULL WHERE native_relay_devices.active=0 AND native_relay_devices.principal_id=excluded.principal_id AND native_relay_devices.project=excluded.project`).bind(body.deviceId,body.principalId,body.project,body.publicKey,await digest(token),JSON.stringify(body.peers),JSON.stringify(body.profiles),Number(body.canSend),Number(body.canReceive),seconds()+body.expiresInDays*86400,seconds(),body.principalId,body.project,body.deviceId).run();
    if(!result.meta.changes)fail(409,'RELAY_ENROLLMENT_CONFLICT','Device identity exists, principal/project is unavailable or enrollment capacity is full. Revoke explicitly before changing identity.');
    return json({deviceId:body.deviceId,token,expiresAt:seconds()+body.expiresInDays*86400},201);
  }
  const match=path.match(/^\/api\/native-devices\/([0-9a-f-]+)$/i);
  if(match&&method==='DELETE'){
    await db.prepare('UPDATE native_relay_devices SET active=0,info_json=NULL WHERE id=?').bind(match[1]).run();
    // Pending bodies are removed; claimed attempts remain non-redeliverable.
    await db.prepare("UPDATE native_relay_requests SET payload_json=NULL,state=CASE WHEN state='pending' THEN 'expired' ELSE state END WHERE sender_id=? OR recipient_id=?").bind(match[1],match[1]).run();
    return json({revoked:true});
  }
  fail(404,'ROUTE_NOT_FOUND','Native relay enrollment endpoint not found.');
}
