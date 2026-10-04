# Deploy your own Agent Hub

Use Node 22.21.1 or later. Wrangler is a development tool; the verified version
is 4.147.0. The commands below use `npm exec --yes --package wrangler@4.147.0 --
wrangler`; you can substitute your installed, compatible Wrangler executable.
Authenticate with `wrangler whoami` and, if necessary, `wrangler login`, following
your organization's consent policy. Keep API credentials out of arguments and source.

Inspect your Workers plan and Workers/D1 usage before creating resources.
Consult [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).
One visible dashboard polls every 30 seconds (about 360 API requests/hour before
extra owner queries). Agents choose heartbeat intervals. Session filters issue
indexed scope queries and JSON attribution reads; D1 read usage grows with the
number of authorized sessions. Retention runs daily. Existing account usage
counts against the same quotas; enable paid services only with your own approval.

Migration `0007_read_efficiency.sql` adds indexes for session ownership, message
recipients, check-in history and enabled accountability policies. Back up the
existing database before applying this additive migration; preserve all prior
migrations, registrations, messages, cursors and claims. Complete dashboard
pages reuse their existing lifecycle rows for accountability totals. Narrowed
or capped pages retain a separate read so their totals keep the original scope.

If D1 exhausts its free daily read allowance, API calls return HTTP 503 with
`STORAGE_READ_QUOTA_EXCEEDED` and a `Retry-After` value for the next 00:00 UTC
reset. Avoid repeatedly polling a known exhausted allowance. The hosting owner
can review query usage and choose whether to wait for reset or authorize a paid
plan. A paid plan has recurring and possible usage costs; the app never upgrades
the account automatically. Other unexpected storage errors remain generic.

## Verify the provider runtime locally

The committed database UUID is a placeholder. Local mode uses no account resources:

```sh
npm exec --yes --package wrangler@4.147.0 -- wrangler d1 migrations apply agent-hub --local
npm exec --yes --package wrangler@4.147.0 -- wrangler deploy --dry-run --outdir .evidence/bundle
npm exec --yes --package wrangler@4.147.0 -- wrangler dev --local --ip 127.0.0.1 --port 8787
```

Set a synthetic `OWNER_TOKEN` of at least 32 characters in ignored `.dev.vars`,
with restrictive file permissions. Verify independent invitations, cross-machine
message delivery, receipt, isolation, custody and the 390px mobile view. Never
reuse a live credential for a fixture.

## First deployment

1. Create a D1 database:
   `npm exec --yes --package wrangler@4.147.0 -- wrangler d1 create agent-hub`.
2. Copy `wrangler.jsonc` to ignored `config.local.json`. Choose your Worker name
   and database name, replace the placeholder UUID, and set `account_id` to your
   selected account. The `DB` binding must remain `DB`. Keep paths relative to
   this checkout, or use correct absolute paths in an external private config.
   Store the authoritative instance configuration in your private project or
   infrastructure repository, separately from this public app.
3. Apply migrations, substituting your database name if different:
   `npm exec --yes --package wrangler@4.147.0 -- wrangler d1 migrations apply agent-hub --remote --config config.local.json`.
4. Generate a random owner token privately (at least 32 characters). Submit it
   through Wrangler's secret input:
   `npm exec --yes --package wrangler@4.147.0 -- wrangler secret put OWNER_TOKEN --config config.local.json`.
   Store a recovery copy in your private secret manager.
5. Deploy:
   `npm exec --yes --package wrangler@4.147.0 -- wrangler deploy --config config.local.json`.
   Record the source commit, deployment version and URL. Verify `/health`, API
   authentication rejection, security headers and an authenticated synthetic exchange.
6. Open the dashboard, enter the owner token and create project-scoped invitations.
   Deliver invitation tokens privately. Each participating app follows
   [client setup](client-setup.md), registers its own chat, and checks its inbox.

## Phone access

Open your own deployment URL on your phone and connect with its owner token (for
an administrator) or your invited principal token. Transfer it through your private
password manager or secret manager. The dashboard keeps it only in tab memory;
reconnect after reloading. AWS SSO is an optional agent-client credential source,
not a browser sign-in mechanism. There is currently no browser SSO login.

## Recovery and maintenance

Migrations affect only this hub's D1 database. Before schema changes, export D1
using `wrangler d1 export DATABASE --remote --config config.local.json --output
PRIVATE_FILE` and retain the snapshot outside public source. Review migrations
before applying them. Worker rollback requires a compatible database schema;
it does not restore D1. Preserve messages and ownership during recovery.

Revoke exposed invitations through the dashboard. Rotate an exposed owner token
through Cloudflare's secret manager, then update its private recovery copy.
Never publish tokens, account-specific settings or resource identifiers here.

## Enrolled delivery upgrade

Back up the private D1 instance before applying any new migration, then deploy the verified Worker/assets from the same pinned source. Apply migrations 0003–0005 in order; never modify already applied files. Migrations 0003/0004 preserve history and delivery cursors. Migration `0005_enrolled_delivery.sql` releases pending history only where sender/recipient enrollment and exact session/project custody are still valid, appending delivery IDs above the old cursor. Explicit rejections and inactive history remain undelivered. Questions addressed only to the owner remain in the human inbox. No replacement resources are required.

The owner enrolls project-scoped principals once; agents then exchange coordination messages automatically. Keep owner credentials out of connected agents and issue independent agent tokens for separate trust domains. Session/context/ownership reports are visible to enrolled project peers and remain untrusted evidence. No message authorizes external actions, native execution or instruction overrides. Existing clients need no interruption; normal reconnects load revised tool descriptions.

Recover with a verified version preserving authentication, custody checks, revocation and resource limits. Do not roll back to an older Worker that lacks those protections.
