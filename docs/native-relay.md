# Optional native relay pilot

This is an optional transport for ai-profiles' human-reviewed native messages when a direct encrypted Tailscale route is unavailable. It defaults off. It supplies no native execution authority and does not consume or acknowledge Hub inboxes, release claims, update tasks, or start a coding session. A relay queue acknowledgement is not a native receipt.

## Deployment boundary

Review and apply additive migration **0015_native_relay.sql** to the existing database only after the operator's backup, capacity and approval requirements pass. It adds separate device capabilities, request tombstones and bounded admission counters. No Queue, KV namespace, Durable Object, database, Worker or schedule is created. Cleanup uses the existing daily retention window.

Enable `NATIVE_RELAY_ENABLED=true` only with `HUB_USAGE_LIMITS_JSON` configured and `HUB_TRAFFIC_GUARD_REQUIRED=true` backed by the existing traffic guard bindings. The relay refuses operation without these controls. The example configuration leaves the feature off. Ordinary invitation and observer tokens cannot authenticate a device endpoint.

The foreground client pilot requires the receiving ai-profiles app visible and focused. It performs one device-wide check per minute, backs off failures and respects provider Retry-After. It refreshes unchanged signed metadata every ten minutes. Background delivery, push infrastructure and unattended model initiation are not implemented. Sleeping/offline receivers do not acquire an automatic resend when they return.

## Explicit device enrollment

Owner-only `GET /api/native-devices` returns a bounded list without tokens or hashes. Owner-only `POST /api/native-devices` accepts:

```json
{
  "deviceId": "12345678-1234-4234-8234-123456789abc",
  "principalId": "synthetic-project-principal",
  "project": "example-project",
  "publicKey": "<32-byte Ed25519 public key in unpadded standard base64>",
  "peers": ["22345678-1234-4234-8234-123456789abc"],
  "profiles": [{"profileId": "default:codex", "app": "codex"}],
  "canSend": true,
  "canReceive": true,
  "expiresInDays": 1
}
```

The response returns a one-time `hub_device_...` token. Store it in the receiving installation's Keychain through the ai-profiles setup UI, never Git or a native message. Device UUIDs and signing keys come from local installation/pairing evidence, not Hub task text or machine labels. Grant exact projects, peer installations and app/profile IDs. Both directions must enroll each other. The client pilot requires both send and receive capabilities; the server keeps them distinct.

`DELETE /api/native-devices/:id` revokes a device and removes its pending bodies. Claimed requests remain non-redeliverable. Explicit reenrollment can rotate a revoked credential/key only under the same principal/project; historical custody cannot transfer through reenrollment. It preserves tombstones, and native local pairing must separately approve any key change. Existing active device records cannot be overwritten.

Local pairing and a receiving profile/chat grant are still required. The server's device scope cannot grant native permission, override a user gate or update an existing observer invitation's authority. Principal/project revocation also invalidates its device capability. Revocation blocks new admission and claims; it cannot recall native I/O after a claim has authorized its one attempt. Local receiving grants and process state are independently rechecked immediately before native I/O.

## Signed transport contract

An envelope contains `version:1`, a random queue `id`, exact `origin`, `project`, a UTF-8 JSON `payload` string and an Ed25519 `signature`. Sign deterministic JSON array bytes:

```text
["ai-profiles/native-relay/1", kind, id, origin, project, payload]
```

Kinds are `info`, `request`, and `reply` in separate signature domains. Standard unpadded base64 encodes keys/signatures. The opaque payload string is signed as supplied; the relay cannot reserialize its inner contents. Rust/ring and WebCrypto have a shared deterministic test vector.

A request payload is ai-profiles' existing independently signed native intent and body. It binds installation/profile/app/conversation, sender, receiver, operation, native enrollment epoch, prepared handle, exact body digest and a maximum two-minute lifetime. The receiver verifies both envelope and native intent, then rechecks its local grant and verified existing runtime. Native permission and arbitration policies remain effective.

The queue ID is separate from the native request ID. A new receipt read uses a fresh queue ID while still referring to the original native request. A lost native delivery response never creates another native request or automatic enqueue. Replies bind the exact queue ID and retain the original independently signed native receipt and intent digest. The sender verifies both layers before displaying a native fact.

## Device endpoints

All `/api/native-relay/*` endpoints require the separate device token, active principal/project membership and current device authority. Transport uses outbound HTTPS only, disallows redirects/cross-origin requests and bounds request/response sizes.

| Method/path | Purpose |
| --- | --- |
| GET `/api/native-relay/self` | Verify device, project, key, capabilities and expiry during local setup |
| PUT `/api/native-relay/info` | Publish own signed epoch/key/enabled metadata with at most 15-minute expiry |
| GET `/api/native-relay/info?peerId=...` | Read a mutually enrolled receiver's signed metadata |
| POST `/api/native-relay/requests` | Enqueue one signed request, idempotent for the exact queue identity/content |
| GET `/api/native-relay/pending` | At most ten body-free request descriptors for this receiver |
| POST `/api/native-relay/claim` | Atomically claim exact peer/request/operation/hash; returns envelope once |
| POST `/api/native-relay/reply` | Persist exact claimed queue ID and signed receiver reply |
| GET `/api/native-relay/request?peerId=...&requestId=...&operation=...` | Read queue state and signed reply; never redispatch |

Claim/reply bodies use `peerId`, queue `requestId`, `operation`, and respectively `payloadHash` or `claimId` plus `envelope`. The first claim removes the queued body and changes state permanently. There is no expiring lease, worker takeover, timer requeue or automatic drain. A crash after claim remains unknown. Native durable journals supply the second independent at-most-once attempt boundary. The same user's OS account remains the native broker's trust boundary.

## Capacity, retention and costs

Admission limits are ten outstanding requests per receiving device, 100 new queued operations per sending device per UTC day, 5,000 retained request tombstones and 128 device records. Indexed pending reads and counters avoid project-wide/chat-wide scans. Duplicate admission consumes no new queue slot. Request bodies are removed on claim, explicit revocation, expiry cleanup during receiver checks, or daily retention. Expired pending bodies may remain stored until that cleanup; they cannot be delivered. Tombstones and signed body-free replies remain for at most 30 days under the existing daily retention job. Disabled deployments preserve existing records until an operator chooses cleanup.

For planning, eight foreground hours produce at most 480 pending checks plus approximately 48 unchanged metadata publications per device: **528 HTTP requests/day** before sends, retries from explicit user actions, or other Hub usage. Three such devices total about **1,584/day**. Opening/reviewing/sending a native message can add up to three queued operations, each with one enqueue, at most twelve receipt reads, two peer-metadata reads, and two receiver claim/reply writes: conservatively **51 HTTP requests per message**. Successful fast replies usually need fewer reads. These are client request-count bounds, not measured D1 billing.

Local query-plan tests prove indexed pending lookup and atomic admission counters. They do not establish provider `rows_read`, `rows_written`, CPU or remaining account capacity. Measure those actual values for an idle check and complete send against the operator's budget before enabling a pilot. The existing application budget includes reservation/accounting overhead; it is not an account-wide billing cap. No model calls run in idle checks.

Cloudflare's current [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) counts scanned rows, mutations and index writes, and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) separately counts Worker usage. A free-plan pilot can have no incremental charge while staying within available allowances; existing account usage must be checked, and no paid upgrade is implied by this feature. Metadata and queued plaintext are visible to the self-hosted operator under TLS; this transport is not end-to-end encryption.

## Validation and rollback

Synthetic tests exercise wrong keys, changed payloads, wrong origins/projects/targets, expiry and unknown schemas, competing claimants, crash-after-claim semantics, receipt conflicts, project/device revocation including mutation races, counter limits, fresh receipt-read nonces and explicit credential reenrollment. Existing inbox and ownership rows remain untouched. Provider-native Wrangler dry-run validates the Worker bundle. Hosted deployment, billing measurements and actual cloud-to-native delivery require a separately approved pilot; passing local tests does not establish them.

Rollback disables the feature, revokes device tokens and disables the client relay. Local direct discovery/delivery remain available. Preserve native unknown journals and claimed tombstones; never replay them as a rollback operation. The migration is additive and does not alter existing coordination records.

## Hosted pilot acceptance

An owner-approved deployment applied migration 0015 after a verified private
backup and retained its existing Worker, database, rate controls, daily budgets
and retention schedule. The signed client completed inspect, prepare and one
native delivery through the cloud queue to an existing disposable Codex chat.
Both signature layers and the sender's durable native acceptance receipt
verified. Read-only native history showed one exact user input, its requested
assistant ACK and no tool calls; all queue bodies were removed. A forged outer
signature was refused without admission or native input.

An isolated empty receiver check advanced the Hub's conservative meter by one
request, 17 read rows and 10 written rows. Full pilot-window counters include
concurrent Hub traffic and are not an isolated per-message billing measurement.
Device invitations, native runtime/version checks, per-profile receiving grants,
foreground-only processing and unknown/no-resend policy remain necessary. Private
identities, tokens, deployment settings and raw runtime evidence stay outside
this public repository.
