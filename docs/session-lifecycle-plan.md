# Session accountability and continuation — implementation proposal

Status: approved staged rollout. Checkpoints, independent observation, attention queues, deduplicated opt-in Hub check-ins and closeout tracking are implemented. See [session accountability](session-accountability.md). Native observation requires the correct existing authority. Automatic native continuation remains a later capability enrollment; this release does not start native turns.

## Outcome

Every unfinished session should have an accountable next action: work is executing, a named dependency is pending, a specific human decision is needed, or reconciliation is required. A stopped turn is not evidence that the objective is complete. Conversely, absence from the Hub is not evidence that work stopped.

The existing `stale` field means only that no session update or explicit heartbeat reached the Hub for three minutes. Clients report at work boundaries; the MCP bridge has no periodic presence loop. Long tool calls, sleeping computers and deliberately waiting sessions all cross this threshold. DONE sessions also used to contribute. Increasing the threshold or adding a daemon that renews every chat would conceal these distinctions.

## Separate three observations

| Dimension | Fields | Meaning |
| --- | --- | --- |
| Objective lifecycle | outcome, acceptance criteria, last reported status, completion evidence | What remains to be achieved |
| Execution / presence | native thread state, observedAt, source, host adapter availability, expectedReportAt | Whether execution can be observed and reached |
| Progress / next action | lastProgressAt, nextAction, waitFor, waitReason, nextCheckAt | Why work is waiting and what unblocks it |

Keep last agent report separate from adapter observation. An adapter cannot rewrite an agent's self-reported status. Show conflicting observations explicitly, with timestamps and coverage. Existing RUNNING records without native evidence become “Reported running · execution unverified,” not “dead.” A host connector's own heartbeat indicates connector availability; it must never freshen every chat on that host.

Add a bounded structured checkpoint to registration/update: outcome, nextAction, lastProgressAt, wait.kind (`user`, `agent`, `external`, `scheduled`), wait.reason, dependency session/message/run ID where applicable, expected event, nextCheckAt and completion evidence references. Store opaque IDs and scoped summaries, not transcripts or secrets. Server stamps receipt times. Work progress remains a reported claim until independently observed.

## Dashboard

Prioritize **Waiting on User**, then **Ready to continue**, **Needs reconciliation**, **Waiting on Agent / external event**, and **Working**. Keep Completed in a separate history/cleanup view. Each card needs a visible next action and wait age, along with separate “last Hub report” and “native execution observed” times.

Use amber attention for a specific human action, neutral “Not recently seen” for missing reports, and stronger alerts for an unresolved missed checkpoint or orphaned custody. Presence alone should not determine urgency. Display coverage (“native adapter available / not configured / offline”), so Unknown cannot be mistaken for stopped. Show overdue completed cleanup separately from unfinished work.

Summary counts must cover the entire filtered dataset, independent of the display limit. Status shortcuts retain the selected project, machine, environment and repository/branch context. Keep Inbox selection and message custody intact. Every attention item links to its exact session, dependency, pending review or resume action.

## Reconciler before questioning agents

Run a deterministic service over scoped session IDs and native observations. Adapters expose capabilities such as read state, observe goal, deliver notification and resume; availability of one capability does not authorize another. Prototype Codex read-only observation first; add other apps through their documented interfaces rather than private chat databases. A generic public Hub contains protocol and synthetic fixtures; host mappings and continuation policy belong to each installation's private config.

| Observation | Action |
| --- | --- |
| Native turn active | Record observation; do not message or resume it. Flag a missed progress checkpoint separately. |
| Waiting on User | Surface the exact outstanding decision. Do not repeatedly wake the agent while the decision remains unanswered. |
| Waiting on Agent | Follow the named dependency. On its completion/failure/approved answer, reassess whether this session can continue. |
| Waiting for CI, deployment or timed event | Observe that event and its expected check time. Preserve in-flight jobs. |
| Native idle + unfinished objective + executable next action | Offer continuation; use an existing active native goal when available. Only automatically resume within an explicitly authorized session policy. |
| Native idle + uncertain outcome/wait | Draft one structured check-in for human delivery review. |
| Connector offline or session mapping missing | Ask for host/session reconciliation. A Hub message cannot wake a disconnected chat. |
| DONE | Verify closeout separately; never classify an absent heartbeat as abandoned work. |

Use a session revision and conditional update/dispatch so user input, a new turn or a changed checkpoint cancels a stale action. Key each check-in to `(sessionId, checkpointRevision, episode)` and persist its state: suggested, pending review, approved, delivered, acknowledged, answered, resolved or escalated. Re-reading an unchanged checkpoint must not create another message.

Suggested first check-in: “The Hub has not received the checkpoint expected at TIME. Report whether your objective is complete, executing, awaiting a specific person/event, paused, or blocked. If unfinished, identify the next action and next check time. Preserve current work and approval boundaries.” It asks for evidence, not why a timer happened to expire.

Current admission permits coordination within enrolled project scope. The owner selects sessions for automatic check-ins; separate read-only observer credentials report exact native mappings. Delivery does not start a native turn and acknowledgment does not prove progress. Never provision owner credentials to adapters. Native continuation requires independent capability enrollment and bounded recipient-local authorization.

## Timing and continuation policy

Proposed pilot defaults, to be tuned using observed false positives:

* Collect native state/events where supported; otherwise sample every 60 seconds with jitter and backoff, without invoking models. Host sleep/offline is a separate observation.
* Expect session reports at start, wait transition, meaningful progress and before returning control. While native execution is active, an expected report can be negotiated for a long command instead of assuming three minutes universally.
* For a client explicitly supporting a 60-second presence interval, show “not recently seen” after three missed intervals. For boundary-only clients, show report age and coverage; do not imply a periodic heartbeat contract exists.
* Treat a missed nextCheckAt plus a five-minute grace period as a reconciliation candidate. For legacy incomplete sessions without checkpoints, enqueue one classification suggestion. Prioritize held claims and user decisions.
* Allow at most one pending check-in per episode. Proposed escalation after 15 minutes starts from confirmed delivery/known ability to receive; suppress retries while review is pending or host is offline. Retry only after an observation change or explicit review, with a daily per-session ceiling.
* An opted-in continuation policy specifies objective, allowed effects, adapter/thread, concurrent-work exclusion, token/run budget, quiet hours, retry ceiling and stop conditions. Pause on human pause, unresolved approval, budget exhaustion, offline host, repeated identical failure or new contradictory input. Never broaden permissions or bypass repository controls.

Prefer the app's native durable objective mechanism to repeated “please continue” prompts. Native completion evidence and budgets are more useful than a forever-running timer. Event-driven dependency resolution avoids waking every waiting session on every interval. Fair queueing and machine capacity limits protect active verification and deployment work.

## Closeout is a reconciled process

1. The executing session verifies the objective against its acceptance evidence and reports completion or a concrete blocker. A turn ending, lack of response, or stale heartbeat cannot establish DONE.
2. It releases its own Hub claims and completes repository-required local closeout: preserve evidence, inspect Git state, processes and actual dependencies; remove only finished inactive owned checkouts or record a retained reason and revisit trigger. Never delete a worktree based on a timer.
3. Persist a closeout checklist with separate objective, claim, local-workspace and native-chat results. A partial failure stays visible and retries only the failed step with an idempotency key.
4. Archive the DONE Hub session through its owning principal after custody is clear; retain messages/history. Native chat archival remains an independently authorized operation. Historical DONE records can await cleanup without inflating unfinished-work alerts.

Sessions without a reachable owning adapter require owner reconciliation, not impersonation. Revoked principals, duplicate registrations and missing native chats each need an explicit disposition while preserving evidence and message custody.

## Measures of usefulness

Primary measure: unfinished sessions lacking both observable execution and an accountable next action. Report its count and oldest age. Also measure time waiting on user, dependency completion-to-resume latency, ready-but-idle duration, completion-to-closeout latency, claims held by unaccounted sessions, checkpoint coverage, connector coverage, check-in delivery/answer latency and stale-alert false-positive rate. Track paused and budget-limited work separately. Do not reward frequent heartbeats or model turns as progress, or label task completion from turn completion.

## Delivery sequence and acceptance

1. Audit legacy sessions against native state without waking or archiving them; propose classifications and show uncertainty. Remove completed sessions from presence alerts and provide an owner cleanup queue.
2. Implement checkpoint schema, presence observations and dashboard actions with compatibility for old clients. No periodic contract is inferred for legacy sessions. Add a narrowly scoped adapter credential; keep owner credentials human-only.
3. Pilot a read-only Codex adapter and owner-reviewed check-in queue on a small explicitly selected set. Measure useful detections and false positives before changing timing.
4. Add opt-in native continuation only after reviewing exact effects and limits. Expand app coverage after verifying each adapter. Keep deterministic observation separate from paid model execution.

Acceptance scenarios include long-running tools, slept/offline machines, an ended but unfinished turn, human pause, budget exhaustion, completed dependency, pending/rejected message review, late approval, duplicate scheduler runs, concurrent user input, a revoked principal, cross-project denial, partial closeout failure, and DONE with retained worktrees. No test should allow duplicate wakeups, loss of a queued answer, foreign claim release or archive inferred solely from elapsed time.

## Research basis

Google SRE recommends actionable alerts and filtering benign conditions; this supports escalating a missing next action rather than every absent report. [Monitoring distributed systems](https://sre.google/sre-book/monitoring-distributed-systems/).

OpenTelemetry OpAMP explicitly negotiates heartbeat support and intervals. This supports separating connector liveness from session execution, and representing clients without a heartbeat contract honestly. [OpAMP heartbeat negotiation](https://opentelemetry.io/docs/specs/opamp/#opampconnectionsettingsheartbeat_interval_seconds).

Codex Goals retain a thread-scoped objective with evidence and budgets, and continue at idle boundaries. This supports using native continuation where authorized rather than treating a completed turn as completed work. Availability and integration must be verified per installed adapter. [Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex).

The documented Codex App Server exposes thread status changes and loaded-thread inspection; unloading or closing a runtime subscription is different from task completion. A production adapter must connect to the correct running app authority and verify capabilities; starting an independent server does not prove visibility into desktop execution. [Codex App Server](https://learn.chatgpt.com/docs/app-server).

These are design inferences from the sources and the existing Hub implementation, not promises that every connected app exposes the same capabilities.
