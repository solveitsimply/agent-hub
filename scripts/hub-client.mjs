#!/usr/bin/env node
/** Small, dependency-free client for the Agent Hub coordination API. */
import { captureContext } from './local-context.mjs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export class HubClientError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'HubClientError';
    this.code = code;
    this.status = status;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function configuredEndpoint(env) {
  if (!env.HUB_URL || !env.HUB_TOKEN) throw new HubClientError('CONFIGURATION', 'Set HUB_URL and HUB_TOKEN in the environment.');
  let url;
  try {
    url = new URL(env.HUB_URL);
  } catch {
    throw new HubClientError('CONFIGURATION', 'HUB_URL must be a valid HTTP(S) origin.');
  }
  if (url.username || url.password || url.search || url.hash)
    throw new HubClientError('CONFIGURATION', 'HUB_URL must not contain credentials, a query, or a fragment.');
  if (url.pathname !== '/') throw new HubClientError('CONFIGURATION', 'HUB_URL must be the Hub origin without an API path.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    throw new HubClientError('CONFIGURATION', 'HUB_URL must use HTTPS, except for localhost.');
  const token = env.HUB_TOKEN.trim();
  if (!token || /\s/u.test(token)) throw new HubClientError('CONFIGURATION', 'HUB_TOKEN is missing or malformed.');
  return { baseUrl: url.href.replace(/\/+$/u, ''), token };
}

function endpoint(path, query) {
  if (!path.startsWith('/api/') || path.includes('?') || path.includes('#'))
    throw new HubClientError('INVALID_REQUEST', 'Invalid API path.');
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  return `${path}${params.size ? `?${params}` : ''}`;
}

async function boundedResponse(response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      throw new HubClientError('RESPONSE_TOO_LARGE', 'Hub response exceeded the client limit.', response.status);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks, bytes).toString('utf8');
  if (!raw) throw new HubClientError('INVALID_RESPONSE', 'Hub returned an empty response.', response.status);
  try {
    return JSON.parse(raw);
  } catch {
    throw new HubClientError('INVALID_RESPONSE', 'Hub returned invalid JSON.', response.status);
  }
}

export function createHubClient(env = process.env) {
  const { baseUrl, token } = configuredEndpoint(env);
  return {
    async request(method, path, { query, body } = {}) {
      const requestPath = endpoint(path, query);
      const serialized = body === undefined ? undefined : JSON.stringify(body);
      if (serialized !== undefined && Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES)
        throw new HubClientError('REQUEST_TOO_LARGE', 'Hub request body exceeds 16 KiB.');
      let response;
      try {
        response = await fetch(`${baseUrl}${requestPath}`, {
          method,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            ...(serialized === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: serialized,
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (error instanceof HubClientError) throw error;
        throw new HubClientError('NETWORK', 'Hub request failed or timed out.');
      }
      const result = await boundedResponse(response);
      if (!response.ok) {
        const serverError = isObject(result) && isObject(result.error) ? result.error : {};
        const code = typeof serverError.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(serverError.code)
          ? serverError.code
          : 'HTTP_ERROR';
        const message = typeof serverError.message === 'string' ? serverError.message : `Hub returned HTTP ${response.status}.`;
        throw new HubClientError(code, message, response.status);
      }
      if (!isObject(result)) throw new HubClientError('INVALID_RESPONSE', 'Hub returned an unexpected JSON shape.', response.status);
      return result;
    },
  };
}

export async function readJsonStdin(stdin = process.stdin) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    bytes += chunk.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new HubClientError('REQUEST_TOO_LARGE', 'JSON stdin exceeds 16 KiB.');
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw new HubClientError('INVALID_JSON', 'Provide one JSON object on stdin.');
  }
  if (!isObject(value)) throw new HubClientError('INVALID_JSON', 'Provide one JSON object on stdin.');
  return value;
}

function usage() {
  return 'Usage: hub-client.mjs context [DIRECTORY] | me | sessions [project] | register < JSON | update SESSION_ID < JSON | heartbeat SESSION_ID | archive SESSION_ID | attribution SESSION_ID < JSON | attribution-history SESSION_ID [after] | inbox SESSION_ID [after] | send < JSON | ack MESSAGE_ID [SESSION_ID] | claim < JSON | release < JSON | ownership [project] [resourceKey]';
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const [command, ...args] = argv;
  if (command === 'context') {
    if (args.length > 1) throw new HubClientError('USAGE', usage());
    return captureContext(args[0]);
  }
  const client = createHubClient(env);
  const one = () => {
    if (args.length !== 1 || !args[0]) throw new HubClientError('USAGE', usage());
    return encodeURIComponent(args[0]);
  };
  const optionalOne = () => {
    if (args.length > 1) throw new HubClientError('USAGE', usage());
    return args[0];
  };
  switch (command) {
    case 'me':
      if (args.length) break;
      return client.request('GET', '/api/me');
    case 'sessions':
      return client.request('GET', '/api/sessions', { query: { project: optionalOne() } });
    case 'register':
      if (args.length) break;
      { const body = await readJsonStdin();
        return client.request('POST', '/api/sessions', { body: { ...body, machine: body.machine ?? hostname() } }); }
    case 'update':
      return client.request('PATCH', `/api/sessions/${one()}`, { body: await readJsonStdin() });
    case 'heartbeat':
      return client.request('POST', `/api/sessions/${one()}/heartbeat`, { body: {} });
    case 'archive':
      return client.request('POST', `/api/sessions/${one()}/archive`, { body: {} });
    case 'attribution':
      return client.request('POST', `/api/sessions/${one()}/attribution`, { body: await readJsonStdin() });
    case 'attribution-history': {
      if (args.length < 1 || args.length > 2 || !args[0]) break;
      const after = args[1];
      if (after !== undefined && (!/^(0|[1-9]\d*)$/u.test(after) || !Number.isSafeInteger(Number(after))))
        throw new HubClientError('USAGE', 'after must be a nonnegative integer.');
      return client.request('GET', `/api/sessions/${encodeURIComponent(args[0])}/attribution`, { query: { after } });
    }
    case 'inbox': {
      if (args.length < 1 || args.length > 2 || !args[0]) break;
      const after = args[1];
      if (after !== undefined && (!/^(0|[1-9]\d*)$/u.test(after) || !Number.isSafeInteger(Number(after))))
        throw new HubClientError('USAGE', 'after must be a nonnegative integer.');
      return client.request('GET', '/api/messages', { query: { sessionId: args[0], after } });
    }
    case 'send': {
      if (args.length) break;
      const { userAuthorized, ...body } = await readJsonStdin();
      if (userAuthorized !== true)
        throw new HubClientError('USER_AUTHORIZATION_REQUIRED', 'Send requires human authorization covering this message (including standing recipient/task authorization) and userAuthorized:true in JSON stdin.');
      return client.request('POST', '/api/messages', { body });
    }
    case 'ack': {
      if (args.length < 1 || args.length > 2 || !/^[1-9]\d*$/u.test(args[0] ?? '')) break;
      return client.request('POST', `/api/messages/${encodeURIComponent(args[0])}/ack`, { body: args[1] ? { sessionId: args[1] } : {} });
    }
    case 'claim':
      if (args.length) break;
      return client.request('POST', '/api/ownership/claim', { body: await readJsonStdin() });
    case 'release':
      if (args.length) break;
      return client.request('POST', '/api/ownership/release', { body: await readJsonStdin() });
    case 'ownership':
      if (args.length > 2) break;
      return client.request('GET', '/api/ownership', { query: { project: args[0], resourceKey: args[1] } });
    default:
      break;
  }
  throw new HubClientError('USAGE', usage());
}

function safeError(error, token) {
  const code = error instanceof HubClientError ? error.code : 'UNEXPECTED';
  const raw = error instanceof Error ? error.message : 'Unexpected client error.';
  const message = raw.replaceAll(token || '\0', '[redacted]').replace(/[\r\n\t]/gu, ' ').slice(0, 600);
  return `${code}: ${message}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`hub-client: ${safeError(error, process.env.HUB_TOKEN)}\n`);
      process.exitCode = 1;
    },
  );
}
