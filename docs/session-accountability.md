# Session accountability

The Hub separates the reported objective, independently observed execution, and the next action. “Not recently seen” establishes neither abandonment nor completion and never permits taking foreign claims.

## Checkpoints

Register with an optional `checkpoint`, or read `hub_read_lifecycle` then call `hub_record_checkpoint` at progress, wait and turn boundaries. CLI: `lifecycle SESSION_ID` and `checkpoint SESSION_ID < JSON`. Synthetic example:

```json
{
  "expectedRevision": 0,
  "checkpoint": {
    "outcome": "Complete the reviewed improvement",
    "acceptanceCriteria": "Verification passes and release is accepted",
    "nextAction": "Inspect verification results",
    "lastProgressAt": "2026-10-03T12:00:00Z",
    "nextCheckAt": "2026-10-03T12:30:00Z",
    "wait": {"kind": "external", "reason": "Verification running", "runId": "synthetic-run", "expectedEvent": "Run succeeds or fails"}
  }
}
```

The server stamps receipt/revision; conditional writes reject obsolete revisions. Heartbeats do not change the objective revision. Material status/task/title changes invalidate an episode. A new checkpoint resolves earlier check-ins; acknowledgment does not. Keep secrets, transcripts, customer records and approval packets out of these fields; reference the original native chat for a human decision.

Wait kinds are `user`, `agent`, `external`, `scheduled`. Every wait needs a reason and next check time. Agent dependencies can reference another session in the same project. Its DONE report makes an observed idle chat with a next action “Ready”; independently verify acceptance evidence. `pauseReason` records a pause; `completionEvidence` holds up to twelve short references. `presenceIntervalSeconds` is only for clients implementing that periodic contract. Legacy clients keep boundary reporting.

Session cards show the reported blocking or waiting reason, the expected event,
next check time (including overdue checks), and next action. For agent waits,
set `wait.sessionId` to the other session's full Hub ID; its current title,
reported agent app, machine and status appear even when it is outside the current
list filters. These dependency details remain restricted to the same project.
Missing reasons, linked agents, next checks and next actions are labelled as
not reported; the UI never infers them from task prose. For a blocked session,
record its prerequisite in `wait.reason` with the appropriate wait kind, or use
`pauseReason` for an actual pause. A completed dependency report still requires
verification of its acceptance evidence.

## Read-only native observation

The owner selects exact session/native-ID mappings and issues an expiring observer credential. It can read only its mappings and report native state, never read inboxes, discover other sessions, change reported status, claim resources, start turns or archive chats. Principal/owner tokens are refused by the observer endpoint. Revocation, expiry and archival apply at the write boundary. Replacing an active mapping requires revocation. Save credentials only in private configuration with restrictive permissions.

Run `scripts/native-observer.mjs PRIVATE_CONFIG.json --once`. Add absolute `codexBinary` and `socketPath` to the downloaded configuration. It connects through documented `codex app-server proxy --sock` to the existing authority owning that chat; it never starts/restarts a server. Reads are `thread/read` with `includeTurns:false` and optional `thread/goal/get`. Execution/approval requests are refused. Missing runtime status is unavailable coverage; `notLoaded` is not DONE. Goal completion is separate from acceptance/closeout.

Use `--watch` only after verifying authority. Polling needs no model calls, normally sixty seconds with jitter/backoff. SIGTERM stops only the observer's proxy. Failed reads report offline. Sequence/time ordering rejects obsolete evidence; missing observations after three minutes show offline. Connector activity never refreshes unrelated sessions.

Some desktops expose no control socket. Keep coverage unavailable and use read-only app tools for an operator audit. Do not inspect private databases, restart chats or install another daemon to simulate visibility. Automatic native continuation is a later capability enrollment requiring exact authority, selected objective/effects, budgets, quiet hours and tested stop conditions. This release offers a native-chat link and has no automatic native resumer.

## Explicit compatibility operations

Priority: Waiting on User, Ready, Needs reconciliation, agent/event waits, Working, Paused; DONE uses a separate closeout category. Summary counts/filtering cover the full dataset before the 200-card limit. The main measure is unfinished sessions lacking observed execution or a current accountable next action. Report and observer coverage expose uncertainty.

Owners can explicitly send one eligible check-in through the API. Stored opt-in policies are retained for compatibility but do not schedule messages. Check-ins use its existing enrolled inbox, author “Hub accountability”; they neither impersonate the owner nor start native turns. No owner credential goes to services/observers.

Defaults: five-minute deadline grace; legacy eligibility after three minutes without a report. Active execution, user decisions, pauses, paused/budget-limited/failed goals, offline/revoked observers and DONE suppress questions. Explicitly enrolled unmapped legacy chats can receive one classification question; delivery does not establish reachability.

Episode key: session + material revision. Explicit HTTP retries share one inbox message. Writes recheck revision, custody, native state and policy. Episodes prevent redispatch after message retention. Default ceiling: one per rolling day, owner maximum three. Unanswered delivery can escalate after fifteen minutes only while native coverage is available. No blind retries, timer-based DONE, foreign claim release or automatic archive.

The only scheduled operation is retention at `17 3 * * *` (03:17 UTC).
It does not enumerate sessions or send messages. Owner `POST /api/reconcile`
remains an explicit compatibility operation; it is absent from the dashboard.
The dashboard shows status, reported next actions/waits, inbox and ownership;
it has no accountability counters, checkpoint/closeout forms, native-observer
enrollment or automatic check-in controls. Existing data and scoped APIs remain
available for clients already using them.

## Closeout

The executor verifies acceptance, reports DONE, releases its own claims, and performs repository-required local cleanup. Record `objective`, `workspace`, `nativeChat` through `hub_record_closeout` / `closeout SESSION_ID < JSON`, each with `state` and scoped `evidence`. Retained workspace/chat results need a `revisitAt` trigger; failed steps stay visible for conditional retry. The Hub deletes no filesystem data and archives no native chats.

Checkpoint-enabled archive requires verified objective, zero claims and complete/retained/not-applicable workspace/native-chat dispositions. Legacy DONE-plus-zero-claims clients remain compatible. Native archive stays independently authorized.

## API additions

* GET `/api/sessions`: per-session `lifecycle`, full-dataset `accountability`; `attention` filters before limiting.
* GET `/api/sessions/:id/checkpoint`: project-visible evidence.
* PUT `/api/sessions/:id/checkpoint`: owned `{expectedRevision,checkpoint}`.
* PUT `/api/sessions/:id/closeout`: owned DONE `{expectedRevision,objective,workspace,nativeChat}`.
* Owner POST `/api/sessions/:id/accountability-policy`: `{checkInEnabled,graceSeconds?,dailyLimit?,escalationSeconds?}`.
* Owner POST `/api/sessions/:id/check-in`: `{expectedRevision}`; POST `/api/reconcile`: `{}`.
* Owner POST `/api/observers`: `{name,sessions:[{sessionId,nativeId}],expiresInDays?}` returns a one-time token; GET lists without tokens; DELETE `/api/observers/:id` revokes.
* Observer-only GET `/api/observer`; POST `/api/observer/observations`: `{sessionId,nativeId,sequence,state,goalState?,observedAt}`. Recent UTC observation and server receipt are separate.

Apply additive migration 0006 before deployment. Preserve identities, inbox cursors, project enrollment, attribution and ownership.
