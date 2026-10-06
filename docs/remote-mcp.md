# Optional remote Coordinator MCP

The existing stdio bridge is unchanged. This optional transport connects a remote
MCP host to the existing Hub Worker over authenticated Streamable HTTP. It reuses
the Hub's API and invitation/session/project checks rather than storing or
forwarding an invitation token to another service. It requires migration 0011.
It is disabled until a canonical MCP_ORIGIN is configured. With no registered
OAuth clients, public discovery metadata is available and `/mcp` returns an
OAuth challenge, but no grants or data access are possible. This allows a host
to display its exact callback before the operator adds a redirect allowlist.
All `/mcp` requests, including
initialization and discovery, require an OAuth access token. Public metadata and
the browser consent entry point contain no coordination records.

## Authority

One OAuth grant is bound to one currently enrolled Coordinator, one exact active
owned session and one enrolled project. The user reviews those values and
explicitly approves them. Owner, agent and observer invitations cannot create a
grant. Repeated consent cannot overwrite an already reviewed selection.

Available tools:

- `hub_connection_info`: authenticated identity, session and scope
- `hub_list_sessions`: project discovery, with offset pagination
- `hub_read_conversations`: project history, including questions addressed to the
  owner; message-ID cursors remain distinct from inbox delivery cursors
- `hub_read_inbox`: the bound session's inbox only, incoming by default
- `hub_send_message`: NOTE, QUESTION, or faithful owner ANSWER with ownerRelay

The write tool requires `hub:read hub:message`, `userAuthorized:true`, an explicit
recipient (except an owner QUESTION), and a retry-safe idempotency key. An ANSWER
also requires the exact original question and owner-provided provenance. Its
bytes are preserved by the existing relay path. These assertions are not proof
of human approval; the invoking host's native approval rules remain mandatory.
There is no owner impersonation, principal administration, ownership claim,
acknowledgment, registration, session-state change, local context tool, native
execution control, polling daemon or automatic outbound message.

## Deployment requirements

Keep real origins, identity/session IDs, deployment names, database IDs and
integration policies in private consuming-project configuration, not this
repository. Never put any real invitation, owner credential, access token or
refresh token in source, CLI arguments, logs or a plugin's client-secret field.

Before deployment:

1. Run the complete suite under Node 22.21.1, and run provider-native Wrangler
   validation and local D1 migration checks against the final source.
2. Run `scripts/verify-remote-mcp-ui.mjs` with an installed Playwright and Chromium.
   It intercepts all requests for synthetic `hub.test` and `client.test` hosts,
   exercises credential entry/review/approve/cancel at desktop and 390 px, and
   verifies actual cross-origin redirect behavior and page overflow. It never
   contacts those hosts or uses production credentials. `HUB_BROWSER_MODULE`
   and `HUB_BROWSER_EXECUTABLE` may select installed dependencies.
3. Inspect the existing hosting plan and quotas. No new paid service is needed
   by this code, but Worker/D1 operations still use the existing account's
   allowances. Do not upgrade or authorize spend without the operator's consent.
4. Obtain approval to deploy the reviewed patch and apply additive migration
   0011 and 0012 to the existing D1 database (apply only pending migrations). Back up using the operator's normal process.
   Preserve the existing Worker/D1, owner secret, principals, sessions and UI.
5. Configure the following non-secret values and a rate-limit binding. Keep
   existing settings, and add `/mcp`, `/oauth/*`, and `/.well-known/oauth-*` to
   `assets.run_worker_first` as shown in the generic Wrangler file.

Example non-secret private Worker variables:

```json
{
  "MCP_ORIGIN": "https://hub.example.invalid",
  "MCP_OAUTH_CLIENTS_JSON": "[{\"client_id\":\"my-private-chat-client\",\"client_name\":\"My private chat client\",\"redirect_uris\":[\"https://client.example.invalid/exact-callback\"]}]"
}
```

An absent MCP_OAUTH_CLIENTS_JSON defaults to an empty client list for safe
discovery bootstrap. Explicit malformed configuration fails closed. Register a
public OAuth client with exact HTTPS redirect URIs. Wildcards,
implicit flows, client credentials, dynamic registration and CIMD are not
implemented. Copy the actual callback from the host's MCP connection settings;
do not guess it. Each selected redirect must be trusted by the operator.
The host must support an ID-only predefined public client with PKCE S256.
Do not invent a client secret if its UI requires one; resolve that compatibility
before enabling the connection.

An `MCP_AUTH_RATE_LIMITER` Worker rate-limiting binding is required before any
OAuth request reaches D1. Give it a namespace ID unique within the account and
an operator-approved rate, for example 30 operations per 60 seconds. It uses
separate fixed keys for authorize, token and revocation endpoints; keys do not
contain credentials or personal data. Cloudflare counters are approximate and
per location. Database admission caps remain the global storage bound. Missing
or failing rate limiting fails closed. Do not enable request-body logging for
OAuth forms/token endpoints.

Example binding shape (choose a private namespace identifier):

```json
{
  "ratelimits": [{
    "name": "MCP_AUTH_RATE_LIMITER",
    "namespace_id": "1001",
    "simple": {"limit": 30, "period": 60}
  }]
}
```

## Connect and prove it

In the remote host's custom MCP form, use the existing Hub origin plus `/mcp`,
select OAuth-required, and supply the configured public client ID with no client
secret. Request `hub:read hub:message` for the Coordinator workflow (or only
`hub:read` for an explicitly read-only connection). The bootstrap challenge
requests both scopes; the consent screen must show the exact capability set.
The two OAuth discovery documents are:

- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server`

Use a secure user-controlled credential entry flow for the existing Coordinator
invitation on the Hub's own consent page. The first submit only reviews the
connection. The subsequent Approve button creates persistent access and must
receive the user's action-time approval. No invitation is retained in the
browser response, URL, cookie, hidden field or database.

After connecting, verify that the intended host actually discovers the tools.
Call `hub_connection_info`, then `hub_read_inbox` with a small limit. Compare the
returned principal/project/session to the intended existing identity, and
confirm a scoped project read. A CLI, synthetic test or plugin-form submission
alone does not prove that tools are available to the intended host. Do not send
a production message simply to test installation without message authorization.

## Expiry, revocation and limits

- Access tokens last at most 15 minutes; grants and refresh families last at most
  seven days by default. Each predefined client may opt into up to 90 days
  maximum and up to 30 days without token renewal. Reconnect with fresh consent
  after expiry; refresh never extends the original absolute maximum.
- Optional client fields in private `MCP_OAUTH_CLIENTS_JSON` are
  `max_grant_days` (integer 1–90) and `refresh_idle_days` (integer 1–30, no
  greater than the maximum). Both default to 7. Invalid values fail closed.
  For example, a client can select `max_grant_days: 90` and
  `refresh_idle_days: 30`; this is an explicit increase in persistent access
  requiring the operator’s approval before activation. Values are server-side
  policy, not client-supplied OAuth arguments.
- Both durations are snapshotted when a consent request starts and displayed
  at review. Approval uses exactly that snapshot. Changing configuration never
  changes a pending consent or an existing grant. Migration 0012 adds policy
  columns with legacy seven-day defaults; it does not change any existing
  grant expiry, token, identity, scope or session.
- Each refresh token expires at the earlier of the original grant expiry and
  its issue time plus the snapshotted inactivity period. Automatic background
  renewal counts as activity: this is not a measure of human or tool use.
- Every refresh is single-use. Reuse, including concurrent refresh attempts,
  revokes the entire family and requires reauthorization. Clients should
  serialize refresh and retain the latest returned refresh token.
- `POST /oauth/revoke` implements token-based revocation: form-encoded
  `client_id` plus an access or refresh `token` invalidates that entire grant.
  Revocation is idempotent. Do not assume a host disconnect invokes revocation
  without verifying the host's behavior. Revoking or rotating the underlying
  Coordinator invitation invalidates all of its existing grants as well.
  Removing client configuration suspends access; reintroducing the same client
  can restore unexpired grants. Revoke a grant explicitly to end it permanently.
- Removing project access, changing the profile, archiving or merging the exact
  bound session also invalidates the grant. No grant follows a merged alias or
  silently broadens to a replacement session.
- Revocation, access-token expiry and current custody are enforced in the
  message INSERT predicate, not just a preceding lookup. Responses with records
  receive a fresh primary authorization recheck before release.
- Storage caps: 1,000 pending ten-minute browser transactions; 20 active grants
  per Coordinator and 1,000 retained workspace grants; 50,000 token rows;
  150 successful token issuances per grant in 24 hours. Limits are atomic.
  Capacity refusals preserve an unused refresh token and return 429; retrying
  consent is unnecessary. Spent refresh hashes remain through grant expiry to
  detect replay. Expired unexchanged consent grants are cleaned up without
  trapping a Coordinator's grant quota until the absolute expiry. An idle
  family is removed, together with its replay history, only once no unexpired
  access token, unspent refresh token or unexchanged code remains. Explicitly
  revoked families are also dead and are removed during the next cleanup.
- Longer grants retain more replay evidence: 90 days of 15-minute renewal
  retains about 8,640 refresh hashes per grant. Six continuously renewed grants
  can exhaust the existing 50,000-row cap (four at the 150/day issuance ceiling).
  The cap is not automatically raised. Plan for the number of active grants;
  capacity refusal is retry-safe but can interrupt access until space is freed.
  Do not delete live replay evidence to make space.

## Verification evidence required for activation

Record exact source revision, Node version, complete suite results, Wrangler
bundle/migration results, consent browser results, production deployment version,
plugin identity and a real host tool-discovery/read result. Clearly label
unavailable or unrun checks. Never describe a source patch as an active
connection.

## Changing an existing deployment

Apply the additive 0012 migration before deploying source that uses its columns.
Existing seven-day connections continue unchanged. Set approved per-client
values in private configuration, run source-pin checks and the full suite, then
review and deploy with the existing bindings preserved. A new consent is needed
for a longer grant; never edit a live grant’s expiry directly. Verify the displayed
lifetime and actual `hub_connection_info` expiry after reconnecting.

Rolling the Worker back to code before 0012 is safe for the added columns, but
that code does not enforce a separate refresh inactivity deadline on new tokens.
After longer grants have been issued, preserve the new token logic or explicitly
revoke affected grants before such a rollback. Reducing configured lifetimes
only affects new consent requests; it does not revoke existing access.

The generic UI currently has an owner-only invitation **Revoke** action. It
invalidates every grant and other use of that Coordinator invitation, not just
one plugin connection. Individual-grant revocation is supported through
`/oauth/revoke` by the host holding a token; there is no grant-management UI.
Never ask a user to copy a token into chat or a command to revoke it. A host’s
Disconnect button must not be described as server-side revocation unless its
behavior has been verified.

Primary references:

- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [OpenAI authentication](https://developers.openai.com/plugins/build/auth)
- [OpenAI custom MCP setup](https://developers.openai.com/api/docs/guides/custom-mcp-server)
- [Cloudflare rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

- [OAuth refresh-token security and inactivity](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2)
