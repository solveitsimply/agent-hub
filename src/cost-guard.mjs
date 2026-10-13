// Application budgets are a circuit breaker, not an account-wide billing cap.
// Reserve headroom before work so failures cannot silently erase usage.
const DEFAULTS = {requests:10000,rowsRead:100000000,rowsWritten:100000,readReservation:1000000,writeReservation:1000};
export function costPolicy(env,fail){
  if(env.HUB_USAGE_LIMITS_JSON===undefined)return null;
  let supplied;try{supplied=JSON.parse(env.HUB_USAGE_LIMITS_JSON);}catch{fail(503,'USAGE_NOT_CONFIGURED','Usage budgets must be valid JSON.');}
  if(!supplied||typeof supplied!=='object'||Array.isArray(supplied)||Object.keys(supplied).some(key=>!Object.hasOwn(DEFAULTS,key)))fail(503,'USAGE_NOT_CONFIGURED','Unsupported usage budget configuration.');
  const policy={...DEFAULTS,...supplied};
  for(const value of Object.values(policy))if(!Number.isSafeInteger(value)||value<1)fail(503,'USAGE_NOT_CONFIGURED','Usage budgets must be positive safe integers.');
  if(policy.readReservation>policy.rowsRead||policy.writeReservation>policy.rowsWritten)fail(503,'USAGE_NOT_CONFIGURED','Reservations must fit within daily usage budgets.');
  return policy;
}
export const usageDay=()=>new Date().toISOString().slice(0,10);
export const untilUsageReset=()=>String(Math.max(1,Math.ceil((Math.floor(Date.now()/86400000)*86400000+86400000-Date.now())/1000)));
export async function limitTraffic(request,env,fail){
  if(env.HUB_PAUSED==='true')fail(503,'HUB_PAUSED','The owner has paused Hub operations to protect the usage budget.');
  if(env.HUB_TRAFFIC_GUARD_REQUIRED==='true'&&(!env.HUB_IP_LIMITER||!env.HUB_GLOBAL_LIMITER))fail(503,'USAGE_GUARD_UNAVAILABLE','Traffic protection is not configured.');
  // Cloudflare supplies this header. No credentials or message contents become keys.
  for(const [binding,key] of [[env.HUB_IP_LIMITER,request.headers.get('cf-connecting-ip')??'local'],[env.HUB_GLOBAL_LIMITER,'hub']]){
    if(!binding)continue;
    let result;try{result=await binding.limit({key});}catch{fail(503,'USAGE_GUARD_UNAVAILABLE','Traffic protection is unavailable; try again later.');}
    if(!result?.success)fail(429,'HUB_RATE_LIMITED','Hub traffic is too frequent. Wait before retrying.');
  }
}
export async function usageStatus(db,env,fail){
  const limits=costPolicy(env,fail);
  if(!limits)return {enabled:false,paused:env.HUB_PAUSED==='true'};
  const day=usageDay(),row=await db.prepare('SELECT requests,rows_read,rows_written FROM hub_daily_usage WHERE day=?').bind(day).first();
  const used={requests:row?.requests??0,rowsRead:row?.rows_read??0,rowsWritten:row?.rows_written??0};
  const fraction=Math.max(...Object.keys(used).map(key=>used[key]/limits[key]));
  return {enabled:true,paused:env.HUB_PAUSED==='true',day,used,limits,warning:fraction>=.85?'critical':fraction>=.7?'warning':null,scope:'Hub daily budgets; not account-wide billing usage'};
}
export async function admitUsage(db,env,fail){
  const policy=costPolicy(env,fail);if(!policy)return {db,finish:async()=>{}};
  const day=usageDay();let admitted;
  try{
    admitted=await db.prepare(`INSERT INTO hub_daily_usage(day,requests,rows_read,rows_written) VALUES(?,1,?,?)
      ON CONFLICT(day) DO UPDATE SET requests=requests+1,rows_read=rows_read+excluded.rows_read,rows_written=rows_written+excluded.rows_written
      WHERE requests<? AND rows_read<=? AND rows_written<=? RETURNING requests,rows_read,rows_written`)
      .bind(day,policy.readReservation,policy.writeReservation,policy.requests,policy.rowsRead-policy.readReservation,policy.rowsWritten-policy.writeReservation).all();
  }catch{fail(503,'USAGE_GUARD_UNAVAILABLE','Usage protection is unavailable; the owner should check its configuration and migration.');}
  if(!admitted.results?.length)fail(429,'HUB_DAILY_BUDGET','The Hub daily usage budget is exhausted. Try after 00:00 UTC or contact the owner.');
  const admittedRow=admitted.results[0],fraction=Math.max(admittedRow.requests/policy.requests,(admittedRow.rows_read-policy.readReservation)/policy.rowsRead,(admittedRow.rows_written-policy.writeReservation)/policy.rowsWritten);
  // Charge guard overhead conservatively. All SQL results retain their native meta.
  let reads=10,writes=10,unknown=false;
  const originals=new WeakMap();
  const record=result=>{
    if(!Number.isSafeInteger(result?.meta?.rows_read)||result.meta.rows_read<0||!Number.isSafeInteger(result?.meta?.rows_written)||result.meta.rows_written<0)unknown=true;
    else {reads+=result.meta.rows_read;writes+=result.meta.rows_written;}
    return result;
  };
  const check=()=>{if(unknown||reads>=policy.readReservation||writes>=policy.writeReservation)fail(503,'HUB_REQUEST_BUDGET','This operation reached its usage allowance. Check its outcome before retrying.');};
  const wrap=(query,parameters=[])=>{
    const original=()=>db.prepare(query).bind(...parameters);
    const statement={
      bind(...values){return wrap(query,values);},
      async all(){check();return record(await original().all());},
      async run(){check();return record(await original().run());},
      async first(column){
        check();
        // Bound the result, preserving first() semantics and exposing D1 meta.
        const result=record(await db.prepare(`SELECT * FROM (${query}) LIMIT 1`).bind(...parameters).all());
        const row=result.results?.[0]??null;return column?(row?.[column]??null):row;
      },
    };
    originals.set(statement,original);return statement;
  };
  return {
    warning:fraction>=.85?'critical':fraction>=.7?'warning':null,
    db:{prepare:wrap,async batch(statements){check();const result=await db.batch(statements.map(statement=>{const original=originals.get(statement);if(!original)throw new Error('Foreign usage statement');return original();}));result.forEach(record);return result;}},
    async finish(){
      // Unknown/failed SQL keeps the entire reservation. Successful observations
      // may exceed it; record that excess rather than silently clamping it.
      await db.prepare('UPDATE hub_daily_usage SET rows_read=rows_read+?,rows_written=rows_written+? WHERE day=?')
        .bind(unknown?Math.max(0,reads-policy.readReservation):reads-policy.readReservation,unknown?Math.max(0,writes-policy.writeReservation):writes-policy.writeReservation,day).run();
    },
    failed(){unknown=true;},
  };
}
