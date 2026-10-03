import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  createAwsEnvironment,
  parameterNameForPrincipal,
  parseLauncherArguments,
  pipeRedacted,
  resolveHubCredentials,
  runAws,
} from '../scripts/aws-hub-credentials.mjs';

const principal = {
  account: '123456789012',
  arn: 'arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_AgentHub_abc123/alex@example.test',
  userId: 'AROAXXXXXXXXXXXXXXXX:alex@example.test',
};
const secret = 'synthetic-agent-hub-token-for-unit-tests-only';

test('AWS startup is bounded and timeout diagnostics never echo process output', () => {
  assert.throws(() => runAws(['sts', 'get-caller-identity'], {PATH:'/mock/bin',HOME:'/home/test'}, (_file, _args, options) => {
    assert.equal(options.timeout, 15_000);
    return {error:Object.assign(new Error(secret),{code:'ETIMEDOUT'}),stderr:secret};
  }), error => error.code === 'AWS_TIMEOUT' && !error.message.includes(secret));
  assert.throws(() => parseLauncherArguments(['identity', '/arbitrary']), {code:'USAGE'});
});
const document = (override = {}) => JSON.stringify({
  schemaVersion: 1,
  principal,
  hubUrl: 'https://agent-hub.example.workers.dev',
  hubToken: secret,
  ...override,
});

function awsFixture(ssmValue = document(), identity = principal, parameterOverride = {}) {
  const calls = [];
  const aws = (args) => {
    calls.push([...args]);
    if (args[0] === 'sts') return JSON.stringify({ Account: identity.account, Arn: identity.arn, UserId: identity.userId });
    return JSON.stringify({ Parameter: { Name: args[args.indexOf('--name') + 1], Type: 'SecureString', Value: ssmValue, ...parameterOverride } });
  };
  return { calls, aws };
}

test('credential lookup derives one SSM name from the complete authenticated SSO identity', () => {
  const expected = createHash('sha256').update(JSON.stringify([
    principal.account, principal.arn, principal.userId,
  ])).digest('hex');
  assert.equal(parameterNameForPrincipal(principal), `/agent-hub/principals/${expected}`);

  const fixture = awsFixture();
  const credentials = resolveHubCredentials({ aws: fixture.aws });
  assert.deepEqual(credentials, { hubUrl: 'https://agent-hub.example.workers.dev', hubToken: secret });
  assert.deepEqual(fixture.calls, [
    ['sts', 'get-caller-identity', '--profile', 'default', '--region', 'us-east-1', '--output', 'json', '--no-cli-pager'],
    ['ssm', 'get-parameter', '--name', `/agent-hub/principals/${expected}`, '--with-decryption', '--profile', 'default', '--region', 'us-east-1', '--output', 'json', '--no-cli-pager'],
  ]);
});

test('custom profile, region and parameter root keep the identity-derived suffix', () => {
  const fixture = awsFixture();
  const options = { profile: 'work.sso', region: 'eu-west-1', parameterRoot: '/example/hub/principals' };
  const expectedName = parameterNameForPrincipal(principal, options.parameterRoot);
  assert.match(expectedName, /^\/example\/hub\/principals\/[a-f0-9]{64}$/u);
  assert.deepEqual(resolveHubCredentials({ ...options, aws: fixture.aws }), { hubUrl: 'https://agent-hub.example.workers.dev', hubToken: secret });
  assert.deepEqual(fixture.calls, [
    ['sts', 'get-caller-identity', '--profile', 'work.sso', '--region', 'eu-west-1', '--output', 'json', '--no-cli-pager'],
    ['ssm', 'get-parameter', '--name', expectedName, '--with-decryption', '--profile', 'work.sso', '--region', 'eu-west-1', '--output', 'json', '--no-cli-pager'],
  ]);
});

test('credential lookup rejects a SecureString bound to another authenticated principal', () => {
  const other = { ...principal, userId: 'AROAXXXXXXXXXXXXXXXX:other@example.test' };
  const fixture = awsFixture(document({ principal: other }));
  assert.throws(() => resolveHubCredentials({ aws: fixture.aws }), { code: 'SSM_DOCUMENT_INVALID' });
  assert.equal(fixture.calls.length, 2);
});

test('credential lookup rejects a substituted parameter name or non-SecureString value', () => {
  for (const parameterOverride of [{ Name: '/agent-hub/principals/other' }, { Type: 'String' }]) {
    const fixture = awsFixture(document(), principal, parameterOverride);
    assert.throws(() => resolveHubCredentials({ aws: fixture.aws }), { code: 'SSM_RESPONSE_INVALID' });
  }
});

test('credential lookup rejects malformed or expanded credential documents', () => {
  for (const value of [
    '{not json',
    document({ unexpected: 'field' }),
    document({ hubUrl: 'https://user:pass@agent-hub.example.workers.dev' }),
    document({ hubUrl: 'http://agent-hub.example.workers.dev' }),
    document({ hubToken: 'short' }),
    document({ hubToken: `bad token ${secret}` }),
  ]) {
    const fixture = awsFixture(value);
    assert.throws(() => resolveHubCredentials({ aws: fixture.aws }), { code: 'SSM_DOCUMENT_INVALID' });
  }
});

test('profile and launcher arguments cannot select arbitrary SSM parameters', () => {
  const fixture = awsFixture();
  assert.throws(() => resolveHubCredentials({ profile: '../../other', aws: fixture.aws }), { code: 'PROFILE_INVALID' });
  assert.throws(() => resolveHubCredentials({ region: 'not-a-region', aws: fixture.aws }), { code: 'REGION_INVALID' });
  assert.throws(() => resolveHubCredentials({ parameterRoot: '/example/../other', aws: fixture.aws }), { code: 'PARAMETER_ROOT_INVALID' });
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(parseLauncherArguments(['--profile', 'work.sso', '--region', 'eu-west-1', '--parameter-root', '/example/hub/principals', 'client', 'send']), {
    profile: 'work.sso', region: 'eu-west-1', parameterRoot: '/example/hub/principals', mode: 'client', forwarded: ['send'],
  });
  assert.deepEqual(parseLauncherArguments(['identity']), {
    profile: 'default', region: 'us-east-1', parameterRoot: '/agent-hub/principals', mode: 'identity', forwarded: [],
  });
  assert.throws(() => parseLauncherArguments(['--profile', '--parameter', 'mcp']), { code: 'USAGE' });
  assert.throws(() => parseLauncherArguments(['--region', 'not-a-region', 'mcp']), { code: 'USAGE' });
  assert.throws(() => parseLauncherArguments(['--parameter-root', '/example/../other', 'mcp']), { code: 'USAGE' });
  assert.throws(() => parseLauncherArguments(['mcp', '--parameter-name', '/other']), { code: 'USAGE' });
});

test('AWS CLI profile calls do not inherit ambient credentials that could override SSO', () => {
  const env = createAwsEnvironment({
    PATH: '/mock/bin', HOME: '/home/test', AWS_CONFIG_FILE: '/home/test/.aws/config',
    AWS_ACCESS_KEY_ID: 'synthetic-access-key', AWS_SECRET_ACCESS_KEY: 'synthetic-secret-key',
    AWS_SESSION_TOKEN: 'synthetic-session-token', AWS_DEFAULT_PROFILE: 'other',
  });
  assert.deepEqual(env, { PATH: '/mock/bin', HOME: '/home/test', AWS_CONFIG_FILE: '/home/test/.aws/config' });
});

test('identity validation rejects incomplete and non-account-scoped AWS responses', () => {
  const fixture = awsFixture(document(), { ...principal, account: '123' });
  assert.throws(() => resolveHubCredentials({ aws: fixture.aws }), { code: 'AWS_IDENTITY_INVALID' });
});

test('launcher output redaction catches secrets split across child-process chunks', async () => {
  const source = new PassThrough();
  const destination = new PassThrough();
  const chunks = [];
  destination.on('data', (chunk) => chunks.push(chunk));
  pipeRedacted(source, destination, secret);
  let output = '';
  destination.on('data', (chunk) => { output += chunk.toString('utf8'); });
  source.write('{"jsonrpc":"2.0","id":1}\n');
  assert.equal(output, '{"jsonrpc":"2.0","id":1}\n', 'complete MCP frames should not wait for child shutdown');
  source.write(`prefix:${secret.slice(0, 11)}`);
  source.end(`${secret.slice(11)}:suffix`);
  await new Promise((resolve) => source.once('end', resolve));
  destination.end();
  await new Promise((resolve) => destination.once('end', resolve));
  assert.equal(Buffer.concat(chunks).toString('utf8'), '{"jsonrpc":"2.0","id":1}\nprefix:[redacted]:suffix');
});
