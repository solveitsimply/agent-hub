#!/usr/bin/env node
/** Resolve this AWS SSO principal's Agent Hub token, then launch a client. */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_PARAMETER_ROOT = '/agent-hub/principals';
const DEFAULT_AWS_PROFILE = 'default';
const DEFAULT_AWS_REGION = 'us-east-1';
const MAX_AWS_OUTPUT_BYTES = 64 * 1024;
const AWS_TIMEOUT_MS = 15_000;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+){1,4}-[1-9][0-9]*$/u;
const PARAMETER_ROOT_PATTERN = /^\/[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/u;
const CLIENT = new URL('./hub-client.mjs', import.meta.url);
const BRIDGE = new URL('./mcp-bridge.mjs', import.meta.url);

export class CredentialBootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CredentialBootstrapError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new CredentialBootstrapError(code, message); };
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validateParameterRoot = (root) => {
  if (typeof root !== 'string' || root.length > 512 || !PARAMETER_ROOT_PATTERN.test(root))
    fail('PARAMETER_ROOT_INVALID', 'SSM parameter root must be an absolute path of simple segments.');
  return root;
};

export function parameterNameForPrincipal(principal, parameterRoot = DEFAULT_PARAMETER_ROOT) {
  if (!isPrincipal(principal)) fail('AWS_IDENTITY_INVALID', 'AWS returned an incomplete authenticated identity.');
  validateParameterRoot(parameterRoot);
  const suffix = createHash('sha256').update(JSON.stringify([
    principal.account,
    principal.arn,
    principal.userId,
  ])).digest('hex');
  return `${parameterRoot}/${suffix}`;
}

function isPrincipal(value) {
  return isRecord(value) &&
    typeof value.account === 'string' && /^\d{12}$/u.test(value.account) &&
    typeof value.arn === 'string' && new RegExp(`^arn:aws:sts::${value.account}:assumed-role/AWSReservedSSO_[^/]{1,256}/[^/]{1,128}$`, 'u').test(value.arn) &&
    typeof value.userId === 'string' && /^[A-Za-z0-9+=,.@_-]{8,128}:[A-Za-z0-9+=,.@_-]{1,128}$/u.test(value.userId);
}

function parseJson(raw, code, message) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_AWS_OUTPUT_BYTES)
    fail(code, message);
  try { return JSON.parse(raw); } catch { fail(code, message); }
}

function validateHubDocument(document, principal) {
  const expectedKeys = ['schemaVersion', 'principal', 'hubUrl', 'hubToken'];
  if (!isRecord(document) || Object.keys(document).sort().join(',') !== expectedKeys.sort().join(',') ||
      document.schemaVersion !== 1 || !isPrincipal(document.principal) ||
      document.principal.account !== principal.account ||
      document.principal.arn !== principal.arn ||
      document.principal.userId !== principal.userId)
    fail('SSM_DOCUMENT_INVALID', 'The Hub credential parameter is malformed or bound to another AWS principal.');

  let url;
  try { url = new URL(document.hubUrl); } catch { fail('SSM_DOCUMENT_INVALID', 'The Hub credential parameter has an invalid URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    fail('SSM_DOCUMENT_INVALID', 'The Hub URL must be an HTTPS origin without credentials, path, query, or fragment.');
  if (typeof document.hubToken !== 'string' || document.hubToken.length < 32 || document.hubToken.length > 2048 || /\s/u.test(document.hubToken))
    fail('SSM_DOCUMENT_INVALID', 'The Hub credential parameter contains a malformed token.');
  return { hubUrl: url.origin, hubToken: document.hubToken };
}

export function createAwsEnvironment(env) {
  const clean = { PATH: env.PATH ?? '/usr/bin:/bin', HOME: env.HOME ?? '' };
  for (const key of ['TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CA_BUNDLE']) {
    if (env[key]) clean[key] = env[key];
  }
  return clean;
}

export function runAws(args, env, execute = spawnSync) {
  const result = execute('aws', args, {
    encoding: 'utf8',
    env: createAwsEnvironment(env),
    maxBuffer: MAX_AWS_OUTPUT_BYTES,
    timeout: AWS_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    if (result.error?.code === 'ETIMEDOUT')
      fail('AWS_TIMEOUT', 'AWS credential lookup timed out. Confirm SSO and network access, then retry.');
    const diagnostic = typeof result.stderr === 'string' ? result.stderr : '';
    if (/ExpiredToken|InvalidClientTokenId|Token (?:has expired|is expired)|refresh failed|SSO[^\n]*(?:expired|does not exist)/iu.test(diagnostic))
      fail('SSO_SESSION_EXPIRED', 'The selected AWS SSO session is expired. Run `aws sso login --profile <name>` and retry.');
    if (args[0] === 'ssm' && /ParameterNotFound/iu.test(diagnostic))
      fail('PRINCIPAL_NOT_ENROLLED', 'This AWS principal has no Agent Hub credential yet. Ask the Hub owner to enroll this principal.');
    fail('AWS_COMMAND_FAILED', 'AWS could not resolve this principal’s Hub credential. Confirm the selected SSO profile and retry.');
  }
  return result.stdout;
}

export function resolveAwsPrincipal({ profile = DEFAULT_AWS_PROFILE, region = DEFAULT_AWS_REGION, parameterRoot = DEFAULT_PARAMETER_ROOT, env = process.env, aws = (args) => runAws(args, env) } = {}) {
  if (!PROFILE_PATTERN.test(profile)) fail('PROFILE_INVALID', 'AWS profile must be a simple profile name.');
  if (!REGION_PATTERN.test(region)) fail('REGION_INVALID', 'AWS region must be a valid region name.');
  validateParameterRoot(parameterRoot);
  const identity = parseJson(aws([
    'sts', 'get-caller-identity', '--profile', profile, '--region', region, '--output', 'json', '--no-cli-pager',
  ]), 'AWS_IDENTITY_INVALID', 'AWS returned invalid caller identity JSON.');
  const principal = isPrincipal({ account: identity?.Account, arn: identity?.Arn, userId: identity?.UserId })
    ? { account: identity.Account, arn: identity.Arn, userId: identity.UserId }
    : null;
  if (!principal) fail('AWS_IDENTITY_INVALID', 'AWS returned an incomplete authenticated identity.');
  return { principal, parameterName: parameterNameForPrincipal(principal, parameterRoot) };
}

export function resolveHubCredentials({ profile = DEFAULT_AWS_PROFILE, region = DEFAULT_AWS_REGION, parameterRoot = DEFAULT_PARAMETER_ROOT, env = process.env, aws = (args) => runAws(args, env) } = {}) {
  const { principal, parameterName } = resolveAwsPrincipal({ profile, region, parameterRoot, env, aws });
  const parameter = parseJson(aws([
    'ssm', 'get-parameter', '--name', parameterName, '--with-decryption', '--profile', profile,
    '--region', region, '--output', 'json', '--no-cli-pager',
  ]), 'SSM_RESPONSE_INVALID', 'AWS returned invalid SecureString response JSON.');
  if (parameter?.Parameter?.Name !== parameterName || parameter?.Parameter?.Type !== 'SecureString')
    fail('SSM_RESPONSE_INVALID', 'AWS returned a parameter other than the expected SecureString.');
  const value = parameter.Parameter.Value;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096)
    fail('SSM_RESPONSE_INVALID', 'The Hub SecureString is missing or exceeds the size limit.');
  return validateHubDocument(parseJson(value, 'SSM_DOCUMENT_INVALID', 'The Hub credential parameter is not valid JSON.'), principal);
}

function safeChildEnvironment(credentials, env) {
  const child = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR','HUB_METRICS_DIR']) {
    if (env[key]) child[key] = env[key];
  }
  child.HUB_URL = credentials.hubUrl;
  child.HUB_TOKEN = credentials.hubToken;
  return child;
}

export function parseLauncherArguments(argv) {
  let profile = DEFAULT_AWS_PROFILE;
  let region = DEFAULT_AWS_REGION;
  let parameterRoot = DEFAULT_PARAMETER_ROOT;
  let index = 0;
  while (['--profile', '--region', '--parameter-root'].includes(argv[index])) {
    const option = argv[index];
    const value = argv[index + 1] ?? '';
    if (!value || value.startsWith('--')) fail('USAGE', `${option} requires a value.`);
    if (option === '--profile') profile = value;
    else if (option === '--region') region = value;
    else parameterRoot = value;
    index += 2;
  }
  const mode = argv[index];
  const forwarded = argv.slice(index + 1);
  if (!PROFILE_PATTERN.test(profile)) fail('USAGE', 'Supply a simple AWS SSO profile name after --profile.');
  if (!REGION_PATTERN.test(region)) fail('USAGE', 'Supply a valid AWS region after --region.');
  if (parameterRoot.length > 512 || !PARAMETER_ROOT_PATTERN.test(parameterRoot)) fail('USAGE', 'Supply an absolute SSM parameter root of simple segments after --parameter-root.');
  if (!['identity', 'me', 'client', 'mcp'].includes(mode))
    fail('USAGE', 'Usage: aws-hub-credentials.mjs [--profile NAME] [--region REGION] [--parameter-root /PATH] identity | me | client <hub-client args...> | mcp');
  if (['identity', 'me'].includes(mode) && forwarded.length) fail('USAGE', `${mode} takes no additional arguments.`);
  if (mode === 'mcp' && forwarded.length) fail('USAGE', '`mcp` takes no additional arguments.');
  return { profile, region, parameterRoot, mode, forwarded };
}

export function pipeRedacted(source, destination, secret) {
  const needle = Buffer.from(secret, 'utf8');
  let pending = Buffer.alloc(0);
  const writeSafe = (chunk, final = false) => {
    const combined = Buffer.concat([pending, Buffer.from(chunk)]);
    let suffixLength = 0;
    if (!final) {
      for (let length = Math.min(needle.length - 1, combined.length); length > 0; length -= 1) {
        if (combined.subarray(combined.length - length).equals(needle.subarray(0, length))) {
          suffixLength = length;
          break;
        }
      }
    }
    const limit = final ? combined.length : combined.length - suffixLength;
    let cursor = 0;
    let match = combined.indexOf(needle, cursor);
    while (match >= 0 && match < limit) {
      destination.write(combined.subarray(cursor, match));
      destination.write('[redacted]');
      cursor = match + needle.length;
      match = combined.indexOf(needle, cursor);
    }
    destination.write(combined.subarray(cursor, limit));
    pending = combined.subarray(Math.max(limit, cursor));
  };
  source.on('data', (chunk) => writeSafe(chunk));
  source.on('end', () => writeSafe(Buffer.alloc(0), true));
}

export async function launch(argv = process.argv.slice(2), env = process.env) {
  const options = parseLauncherArguments(argv);
  if (options.mode === 'identity') {
    const result = resolveAwsPrincipal({ profile: options.profile, region: options.region, parameterRoot: options.parameterRoot, env });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const credentials = resolveHubCredentials({ profile: options.profile, region: options.region, parameterRoot: options.parameterRoot, env });
  const script = options.mode === 'mcp' ? fileURLToPath(BRIDGE) : fileURLToPath(CLIENT);
  const args = options.mode === 'me' ? [script, 'me'] : options.mode === 'mcp' ? [script] : [script, ...options.forwarded];
  const child = spawn(process.execPath, args, { env: safeChildEnvironment(credentials, env), stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true });
  pipeRedacted(child.stdout, process.stdout, credentials.hubToken);
  pipeRedacted(child.stderr, process.stderr, credentials.hubToken);
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (status, signal) => resolveExit(status ?? (signal ? 1 : 0)));
  });
  process.exitCode = code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launch().catch((error) => {
    const code = error instanceof CredentialBootstrapError ? error.code : 'UNEXPECTED';
    const message = error instanceof CredentialBootstrapError ? error.message : 'Credential bootstrap failed.';
    process.stderr.write(`agent-hub-aws: ${code}: ${message}\n`);
    process.exitCode = 1;
  });
}
