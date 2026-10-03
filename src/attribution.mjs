/** Reporting labels are claims, never authentication or provider billing proof. */
export const attributionFields = ['provider', 'client', 'model', 'accountLabel', 'apiKeyLabel'];

export function parseAttribution(body, fail) {
  const permitted = [...attributionFields, 'idempotencyKey', 'previousSegmentId'];
  for (const key of Object.keys(body)) if (!permitted.includes(key))
    fail(422, 'UNKNOWN_FIELD', `Unsupported attribution field: ${key}`);
  const metadata = { source: 'agent-reported' };
  for (const key of attributionFields) {
    const value = body[key];
    if (value === undefined || value === null) { metadata[key] = null; continue; }
    if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\r\n\x00-\x1f]/u.test(value))
      fail(422, 'INVALID_ATTRIBUTION', `${key} must be a nonempty reporting label of at most 160 characters.`);
    metadata[key] = value.trim();
  }
  if (!metadata.provider || !metadata.client)
    fail(422, 'INVALID_ATTRIBUTION', 'Identify the provider and client; unavailable account, key and model labels remain null.');
  if (typeof body.idempotencyKey !== 'string' || !body.idempotencyKey.trim() || body.idempotencyKey.length > 160)
    fail(422, 'INVALID_ATTRIBUTION', 'Provide a stable idempotency key for this change.');
  if (body.previousSegmentId !== null && (!Number.isSafeInteger(body.previousSegmentId) || body.previousSegmentId < 1))
    fail(422, 'INVALID_ATTRIBUTION', 'previousSegmentId must match the current segment ID, or be null for the first segment.');
  return { metadata, idempotencyKey: body.idempotencyKey.trim(), previousSegmentId: body.previousSegmentId };
}

export const attributionView = row => ({
  id: row.id, sessionId: row.session_id, startedAt: row.started_at,
  endedAt: row.ended_at ?? null, ...JSON.parse(row.metadata_json),
});
