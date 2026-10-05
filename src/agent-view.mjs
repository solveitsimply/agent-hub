// Explicit projections: never truncate message text, evidence, or cursors.
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));

export function compactSession(session) {
  const result = pick(session, ['id','label','project','task','status','machine','environment','workContext','latestAttribution','stale']);
  if (session.lifecycle) {
    result.lifecycle = pick(session.lifecycle, ['revision','attention','reason','coverage','overdue','heldClaims']);
    const checkpoint = session.lifecycle.checkpoint;
    if (checkpoint) result.lifecycle.checkpoint = pick(checkpoint, ['nextAction','wait','nextCheckAt','pauseReason']);
  }
  return result;
}

export const compactMessage = message => pick(message, ['id','fromSessionId','toSessionId','project','kind','body','replyTo','createdAt','acknowledgedAt','deliveryCursor','ownerRelay','fromPrincipalId','fromPrincipalName']);

// Write receipts omit echoed content; explicit lifecycle/history reads stay full.
export function compactReceipt(result) {
  if (result.session) return {...result, session: {
    ...pick(result.session, ['id','label','project','status','lastSeenAt','archivedAt']),
    ...(result.session.lifecycle ? {lifecycle:pick(result.session.lifecycle, ['revision','attention','heldClaims'])} : {}),
  }};
  if (result.lifecycle) return {...result,lifecycle:pick(result.lifecycle,['revision','attention','heldClaims'])};
  if (result.message) return {...result, message:pick(result.message, ['id','fromSessionId','toSessionId','project','kind','replyTo','createdAt','acknowledgedAt','deliveryCursor','ownerRelay','fromPrincipalId','fromPrincipalName'])};
  return result;
}
