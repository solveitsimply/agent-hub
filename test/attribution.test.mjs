import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import { SqliteD1 } from './d1-sqlite.mjs';
const OWNER = 'synthetic-owner-for-attribution-tests-123456';
async function fixture(t) {
  const DB = new SqliteD1(); t.after(() => DB.close());
  const call = async (token, path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await worker.fetch(new Request('https://hub.test' + path, {
      method, headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { DB, OWNER_TOKEN: OWNER });
    return { status: response.status, body: await response.json() };
  };
  const invite = async (name, project = 'sample-project') => (await call(OWNER, '/api/principals', { name, account: name, projects: [project] })).body;
  const a = await invite('local'), b = await invite('remote'), outside = await invite('outside', 'different');
  const session = (await call(a.token, '/api/sessions', { externalId: 'codex:thread-1', machine: 'mac', label: 'Codex', project: 'sample-project', task: 'Test session attribution', status: 'RUNNING' })).body.session;
  return { DB, call, a, b, outside, session, path: `/api/sessions/${session.id}/attribution` };
}
const segment = (key, previousSegmentId = null, extra = {}) => ({ provider: 'OpenAI', client: 'Codex', model: 'reported-model', accountLabel: 'Example subscription', apiKeyLabel: null, idempotencyKey: key, previousSegmentId, ...extra });

test('one session preserves multiple account/key segments and supports pagination', async t => {
  const f = await fixture(t);
  const first = await f.call(f.a.token, f.path, segment('subscription'));
  assert.equal(first.status, 201);
  const second = await f.call(f.a.token, f.path, segment('api', first.body.segment.id, { accountLabel: 'Development project', apiKeyLabel: 'dev-api-label', client: 'Claude', provider: 'Anthropic' }));
  assert.equal(second.status, 201);
  const history = await f.call(OWNER, f.path);
  assert.equal(history.body.segments.length, 2);
  assert.equal(history.body.segments[0].accountLabel, 'Example subscription');
  assert.equal(history.body.segments[0].endedAt, history.body.segments[1].startedAt);
  assert.equal(history.body.segments[1].apiKeyLabel, 'dev-api-label');
  assert.equal(history.body.segments[1].endedAt, null);
  assert.equal(history.body.segments[1].source, 'agent-reported');
  const page = await f.call(f.a.token, f.path + '?after=' + first.body.segment.id);
  assert.deepEqual(page.body.segments.map(x => x.id), [second.body.segment.id]);
});
test('history is immutable, retries deduplicate and stale switches fail closed', async t => {
  const f = await fixture(t), body = segment('initial');
  const first = await f.call(f.a.token, f.path, body);
  const retry = await f.call(f.a.token, f.path, body);
  assert.equal(retry.body.segment.id, first.body.segment.id);
  assert.equal((await f.call(f.a.token, f.path, { ...body, accountLabel: 'different' })).status, 409);
  assert.equal((await f.call(f.a.token, f.path, segment('stale', null))).status, 409);
  assert.equal((await f.call(f.a.token, f.path, body, 'PATCH')).status, 404);
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM session_attribution_segments').get().n, 1);
});
test('report labels grant no write permission and remain project scoped', async t => {
  const f = await fixture(t);
  assert.equal((await f.call(f.b.token, f.path, segment('spoof'))).status, 403);
  assert.equal((await f.call(f.outside.token, f.path)).status, 403);
  await f.call(f.a.token, f.path, segment('own'));
  assert.equal((await f.call(f.b.token, f.path)).status, 200);
  await f.call(f.a.token, `/api/sessions/${f.session.id}`, { status: 'DONE' }, 'PATCH');
  await f.call(f.a.token, `/api/sessions/${f.session.id}/archive`, {});
  assert.equal((await f.call(f.a.token, f.path, segment('archived', 1))).status, 409);
  const historical = (await f.call(f.a.token, f.path)).body;
  assert.equal(historical.segments.length, 1);
  assert.ok(historical.segments[0].endedAt);
  assert.equal(historical.nextCursor, null);
});
test('same predecessor admits one switch and a prior retry remains idempotent', async t => {
  const f = await fixture(t), initial = segment('initial');
  const first = await f.call(f.a.token, f.path, initial);
  const outcomes = await Promise.all(['one', 'two'].map(key => f.call(f.a.token, f.path, segment(key, first.body.segment.id))));
  assert.deepEqual(outcomes.map(x => x.status).sort(), [201, 409]);
  const retry = (await f.call(f.a.token, f.path, initial)).body.segment;
  const history = (await f.call(f.a.token, f.path)).body.segments;
  assert.equal(retry.id, first.body.segment.id);
  assert.equal(retry.endedAt, history[1].startedAt);
  assert.equal(history.length, 2);
});
test('pagination preserves terminal intervals and signals only actual remaining pages', async t => {
  const f = await fixture(t);
  const insert = f.DB.database.prepare('INSERT INTO session_attribution_segments(session_id,principal_id,idempotency_key,payload_hash,metadata_json,started_at) VALUES (?,?,?,?,?,?)');
  for (let i = 0; i < 201; i++) insert.run(f.session.id, f.a.principal.id, String(i), 'fixture', JSON.stringify({provider:'OpenAI',client:'Codex',source:'agent-reported'}), new Date(1700000000000 + i * 1000).toISOString());
  const first = (await f.call(f.a.token, f.path)).body;
  assert.equal(first.segments.length, 200);
  assert.equal(first.nextCursor, first.segments.at(-1).id);
  const second = (await f.call(f.a.token, f.path + '?after=' + first.nextCursor)).body;
  assert.equal(second.segments.length, 1);
  assert.equal(first.segments.at(-1).endedAt, second.segments[0].startedAt);
  assert.equal(second.nextCursor, null);
});
test('unknown attribution stays unknown; raw credentials and extra fields are rejected', async t => {
  const f = await fixture(t);
  for (const extra of [{ apiKey: 'forbidden' }, { apiKeyLabel: 'sk-' + 'a'.repeat(30) }, { accountLabel: 'bad\nlabel' }, { previousSegmentId: undefined }]) {
    assert.equal((await f.call(f.a.token, f.path, segment('invalid', null, extra))).status, 422);
  }
  const result = await f.call(f.a.token, f.path, segment('unknown', null, { model: null, accountLabel: null }));
  assert.equal(result.status, 201);
  assert.equal(result.body.segment.model, null);
  assert.equal(result.body.segment.apiKeyLabel, null);
});
test('archiving between initial read and insert cannot append attribution', async t => {
  const f = await fixture(t), original = f.DB.prepare.bind(f.DB);
  f.DB.prepare = query => {
    const statement = original(query), run = statement.run;
    if (query.startsWith('INSERT INTO session_attribution_segments')) statement.run = async () => {
      f.DB.database.prepare('UPDATE sessions SET archived_at=? WHERE id=?').run(new Date().toISOString(), f.session.id);
      return run();
    };
    return statement;
  };
  assert.equal((await f.call(f.a.token, f.path, segment('race'))).status, 409);
  assert.equal(f.DB.database.prepare('SELECT COUNT(*) AS n FROM session_attribution_segments').get().n, 0);
});
