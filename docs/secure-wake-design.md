# Secure inbox checks and dormant-chat wakeups

Status: research proposal; no scheduler, companion, credential or native continuation is enabled by this document. Official documentation checked 2026-10-11. Deployment identities, machine paths, mappings and local policy belong in private installation configuration.

## Recommendation

Prefer one deterministic companion per machine, with separate adapters for explicitly enrolled apps, over an LLM coordinator that runs every fifteen minutes. Begin with metadata checks and local notifications only. A Hub event is an untrusted hint that an enrolled inbox may have changed; it cannot authorize a native turn or any business action. Native continuation is a separate, later enrollment, and remains disabled for an app without verified enforcement and concurrency controls.

For a selected task that already has an owner-approved active native Goal, prefer the app's own continuation mechanism. Do not create, reactivate, expand or replenish a Goal because a Hub event arrived. A heartbeat is a scheduled model run; it is useful for a particular authorized follow-up but is not a security mechanism for routing all dormant chats.

At a fifteen-minute interval there are 96 scheduled checks per continuously awake machine/app per day. Deterministic checks need no model inference. An in-app coordinator can incur up to 96 coordinator model runs before any recipient work, with variable context/tool overhead and shared account usage. This is arithmetic, not a pricing estimate. Poll once per machine and route exact enrolled mappings; do not poll every chat separately or add heartbeat messages for every unchanged result. Event streaming could reduce latency later without changing authority.

## What is established, and what remains unverified

The current Hub is a coordination application. Its native observer accepts exact session/native-ID mappings, uses an expiring observer credential, and permits only observation. `scripts/native-observer.mjs` allowlists initialization, `thread/read` and optional `thread/goal/get`; it refuses execution and approval requests. Its read-only credential cannot read inboxes or start native turns. These are existing code boundaries, not an implementation of this proposed companion. See [session accountability](session-accountability.md) and [lifecycle plan](session-lifecycle-plan.md).

Official App Server documentation distinguishes stored-thread reads, reopening a thread and generation: `thread/read` does not resume; `thread/resume` reopens for later turns; `turn/start` begins generation. `thread/goal/get` reads Goal state. `turn/start` can preserve incoming material as `toolOutput` rather than user input. App Server also exposes approvals and powerful execution, including `thread/shellCommand` outside the thread sandbox. Thus transport access is broader authority than observation. The documented WebSocket transport is experimental and unsupported for production workloads. [Codex App Server](https://learn.chatgpt.com/docs/app-server).

These APIs do not prove that an installed desktop exposes the control socket of its existing runtime. Current repository guidance explicitly allows unavailable desktop coverage. An independent App Server or SDK process does not establish visibility into the running desktop chat or its active-turn arbitration. Do not start another server, inspect private chat databases, replay copied transcripts, restart the app or interrupt a chat to fill this gap. Capability detection must fail closed.

Official scheduled-task documentation supports returning to an existing chat, minute intervals, and local runs while the computer and app remain running. Runs use default sandbox settings; `approval_policy = "never"` is used when organizational policy permits. Full access allows unattended filesystem, command and network actions. Frequent worktree runs can accumulate worktrees. None of this establishes a bounded cross-chat wake adapter. [Scheduled tasks](https://learn.chatgpt.com/docs/automations).

The official Goal guide describes thread-scoped persisted objectives and budgets, continuation at idle boundaries, exclusions for queued input or other pending work, interruption/pause behavior and suppression of a continuation that makes no tool call. It requires a supporting build. This supports preferring native Goal arbitration; it does not establish reliable delivery of arbitrary Hub events to unloaded desktop threads. [Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex).

## Options

| Option | Benefit | Security and operational limitation | Disposition |
| --- | --- | --- | --- |
| One fifteen-minute in-app coordinator per machine/app | Existing scheduling UX and app context; no custom daemon | Recurring model runs inherit tools and defaults; prompt injection can reach cross-chat or execution tools; app must remain reachable; same-chat context grows | Optional temporary report-only pilot after tool restrictions are verified; no broad automatic recipient messaging |
| Deterministic per-machine companion | No model calls for unchanged state; exact routing, limits, deduplication and auditable eligibility | Requires new narrow Hub capability and owner-installed local policy; native control access itself is powerful | Recommended first implementation: metadata plus local notification, with native execution disabled |
| Native Goal | Existing thread objective, evidence accounting and safe continuation boundaries | Task-specific; paused/budget-limited Goals stay stopped; not a generic transport for remote prompts | Preferred for already enrolled executable work; preserve native control authority |
| Native heartbeat in each chat | Same chat context and bounded task-specific follow-up | Many schedules/model runs; can wake paused work if poorly scoped; no inherent inbox-only tool boundary | Use only for a specific owner-authorized follow-up; suspend on unresolved owner decisions |
| Documented SDK adapter | Programmatic interface with explicit sessions and policies | SDK resume can be a new execution process; history identity does not establish desktop runtime identity or safe simultaneous access | Separate per-app research/acceptance; no inferred desktop support |

Codex's SDK documents programmatic local thread start, resume and run and sandbox presets. This is suitable for a separately enrolled custom workflow; it does not by itself establish a safe bridge into an existing desktop runtime. [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk).

Claude's Agent SDK documents explicit session-ID resume and persisted history. Its permissions documentation warns that `allowedTools` pre-approves listed tools rather than removing every other tool; automatic approvals can bypass `canUseTool`. A deny mechanism and every-call enforcement must be verified rather than inferred from an allow list. These are useful adapter-design lessons, not proof of control of a dormant Claude desktop chat. [Claude SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [Claude SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions).

No Grok or Gemini desktop wake capability is established by this investigation. Their integrations remain unsupported until separately verified against primary documentation and the installed app. Shared chat history, a model API, browser automation or an SDK with similar names is insufficient evidence.

## Threat model and trust boundaries

Protect local files, source changes, native chat/Goal state, tool credentials, customer/provider systems, human approval decisions, message custody and model budgets. Attackers include a malicious enrolled peer, compromised Hub/service account, malformed or replayed remote event, poisoned inbox content, stolen device credential, concurrent schedulers, and races with human actions. A compromised same-user local process is a stronger threat than a hostile Hub: filesystem permissions alone cannot isolate processes sharing that user's authority.

The trust chain must be explicit:

1. The human installs local policy and approves exact host/app/thread/project enrollment.
2. Hub transports bounded event metadata using a narrow revocable capability.
3. A deterministic local broker validates enrollment, native state and resource limits.
4. Any permitted native inbox run has externally enforced capabilities.
5. Business execution uses the recipient's preexisting objective and approvals, with independent gates.

Text such as “only check your inbox,” a Hub `ownerRelay`, an `APPROVED` review state, a dependency DONE report, acknowledgment or a signed service event never substitutes for human execution authorization. Do not turn remote message bodies, task/title strings or instructions into trusted user messages, shell arguments, executable code, paths, native IDs or policy configuration. A locally fixed template can reference validated opaque event IDs; any fetched remote content retains its untrusted tool-result provenance. Even that role distinction reduces confusion rather than providing an execution sandbox.

### Credential boundary

Provision a new device capability, not an owner token, AWS SSO credential, broad project principal or existing general-purpose agent token. Bind it server-side to one device installation, exact project/session mappings, permitted methods, expiry, revision and issuance epoch. The first scope should permit a bounded metadata inbox-change feed and connector-level receipt only. Native observation can retain its existing separate observer capability. Native wake authorization remains local; the Hub never mints permission to operate a provider or native app.

A proposed device API is new work: it is not currently supplied by the observer endpoint. Existing session-bound MCP grants have separate scopes and custody rules; project conversation visibility is broader than this metadata feed. Do not repurpose a credential simply because its name says “observer” or “coordinator.”

Multiple chats sharing one Hub principal are not credential-isolated merely because they have distinct session IDs. Current principal custody can cover that principal's sessions. Compromise of the shared bearer credential can affect sibling sessions within its scope. A device feed must enforce exact session mappings independently at every request, including revocation, alias/merge changes, archive and project removal. A session ID in a request is a selector, not proof of authorization.

Store only the device capability in a restricted private secret store/configuration; avoid environment inheritance and command-line secrets. Expire it, make revocation immediate at each server boundary, and require a new owner enrollment to add scope. A self-renewing credential cannot silently extend its original maximum lifetime. Separate read-only observation from any later local native dispatch credential.

### Network and local process boundary

Use outbound TLS to a pinned configured Hub origin with normal certificate validation; reject cross-origin redirects and cap time, size, pagination and concurrency. Never expose a native control listener, relay inbound Hub commands directly to an app socket, or allow an event to supply a URL or executable. A companion needs no network listener. If an existing owner-installed Unix socket is eventually used, verify its owner, restrictive permissions, peer/authority identity and exact installed adapter version without starting another authority.

An App Server connection may permit command execution, permission changes and arbitrary thread control. A read-method allowlist inside a same-user process is defense in depth, not a sandbox against a compromised process holding the raw connection. Likewise a model with shell access can bypass a small wrapper if it can reach the socket or credentials itself. Keep the model outside the broker's authority: no raw socket, general shell, credential store, app-control tools, ambient broad connectors or writable policy. Where needed, use an OS-enforced isolated helper identity/process boundary and a narrow broker operation. If the installation cannot enforce that separation, do not claim native wake is safe; stay with notifications.

## Proposed metadata protocol and eligibility

Hub emits only validated event type, opaque event ID, project/session ID, delivery cursor, creation/expiry times and material revision. No inbox body, task prose, prompt, customer row or approval packet is needed for a change check. Reject unknown types, overlong fields and unrecognized mappings. Authenticate the feed, but treat authenticated values as untrusted claims. Hub state alone cannot establish native idleness or owner consent.

Use a durable cursor per device/session/mapping epoch. Inbox delivery cursors and project conversation message IDs are distinct; never mix them. Persist bounded pending records before advancing the cursor. Advancing proves connector receipt only. It must not acknowledge the existing message on behalf of the recipient, resolve a question, establish acceptance or record business execution. Suppressed candidates remain pending without causing repeated notifications; retention gaps require reconciliation rather than pretending receipt.

Eligible native inbox dispatch, if later enabled, requires all of:

- Exact local enrollment remains enabled and unexpired; device capability, session custody and mapping epoch are current.
- Local native authority is verified and supports the required operation and enforcement policy.
- Fresh native state establishes idle, with no queued user input, pending tools/background work, native approvals or unresolved question. Missing state, `notLoaded` and app absence fail closed for automatic dispatch.
- No PAUSED, WAITING_ON_USER/WAITING_USER, human stop, failed/budget-limited Goal, exhausted local budget, unresolved business gate, DONE/archive or contradictory input exists.
- Any necessary dependency event has independently checked evidence and matches the expected dependency/revision; an event does not clear a human gate.
- Quiet hours and per-device, app, thread and account budgets allow the action, and the device is online.
- The exact event/revision has no prior dispatch or ambiguous in-flight result; a current fenced lease is held.

Do not read only the most recently updated or visible-page sessions. Use explicitly enrolled exact IDs, bounded pagination and verified coverage. Unknown coverage is a reconciliation result, not a reason to resume.

## Races, replay and custody

Deduplicate by `(device, app authority, native thread, mapping epoch, material revision, event episode)`, not a title or timer timestamp. Acquire a short lease atomically with a monotonically increasing fencing token and conditional revision. Revalidate revocation, native state, pause/gate status, queued input and budgets immediately before dispatch. Any event/version change cancels the candidate; do not overwrite it with a stale classification.

Local leases arbitrate companion workers, not the human, desktop, native Goal or another SDK process. A read-idle/then-start sequence has a time-of-check race. The fetched App Server turn-start description does not establish an atomic expected-idle/revision predicate; do not invent one. Automatic native dispatch requires a proven app-owned conditional operation or arbitration that refuses stale state and queued work. Otherwise retain notification-only mode. Starting and then interrupting an accidentally concurrent turn is not acceptable mitigation: effects may already have occurred.

Treat lost dispatch responses as ambiguous. Record request identity before sending; reconcile with authoritative native dispatch evidence before retrying. If native idempotency or reconciliation is unavailable, never blindly retry a possible turn. Reject expired events and replayed sequences, do not reset epochs after restart, and recover from state corruption into disabled/reconciliation mode. Capability revocation after a model turn begins cannot undo effects; action-time gates and tight run limits are still necessary.

## Inbox receipt versus business execution

Stage one delivers local notifications containing metadata and a native-chat link. The recipient reads its own inbox at the next authorized work boundary. This improves visibility without asserting that every dormant chat has checked its inbox.

A later bounded inbox run may retrieve and classify new coordination, record a structured local next action and stop. It must be externally restricted to exact inbox/lifecycle reads and narrow receipt reporting. It cannot send to other chats, update a Goal, grant permissions, access project/customer files, execute shell commands, call provider-write connectors or act on the coordination. Business continuation is another decision under existing local policy, never an implication of inbox receipt. Receipt, delivered, read, acknowledged, answered, eligible and executed are separate audit states.

Codex documentation distinguishes sandbox enforcement from approval policy and says automatic review does not change the sandbox boundary. An unattended design cannot rely on an approval prompt appearing: `never`, automatic review, cached/session grants or a client's `acceptForSession` reply can remove that checkpoint. For inbox-only mode, prove forbidden actions are denied technically, refuse every permission expansion and approval/elicitation autoaccept, and exclude apps that cannot expose such enforcement. [Sandbox and approvals](https://learn.chatgpt.com/docs/sandboxing).

## Limits, sleep recovery and audit

Suggested pilot limits are one fifteen-minute metadata check with jitter per awake device; one concurrent adapter operation per app; no inference in the initial stage. Configure request/response ceilings, bounded spool size, exponential backoff, retry ceilings, per-thread cooldowns and quiet hours in private policy. A later inbox pilot should have owner-selected per-run token/time ceilings, daily device/app/thread ceilings and a shared-account reserve; budget unavailability means no run. Do not buy credits, consume resets or change models automatically.

After sleep or outage, coalesce missed ticks into one check, refresh capabilities and state, discard expired hints and fairly process a bounded queue. Never execute 96 missed ticks or wake all waiting chats at once. Preserve active work, stagger candidates and stop repeated identical failures. Scheduling does not guarantee operation during host sleep or app closure.

Audit only device/app identifiers, mapped opaque session/thread IDs, policy/mapping version, event/cursor/revision, decision code, lease fence, native coverage/time, request/result IDs and bounded cost/time counters. Log no prompts, inbox bodies, source files, customer data, approval packets, codes or credentials. Record each suppression once per episode and meaningful change. Keep spool/audit limits and cleanup triggers explicit; do not delete unique evidence or other sessions' resources.

A malicious Hub can at worst drive bounded rejected checks/notification candidates in stage one. Protect that residual blast radius with per-device quotas, notification deduplication and bounded parsing. If a Hub breach can select arbitrary native threads, feed trusted prompts, extend capabilities or trigger provider work, the design has failed its central boundary.

## Acceptance tests before any enrollment

Use synthetic identities and an isolated fake native adapter first; no real dormant chat should be a test fixture.

| Test | Required result |
| --- | --- |
| Foreign device/project/session, same-account sibling, forged mapping or alias reassignment | Server and local policy deny; no inbox body or native request escapes scope |
| Expired/revoked capability between feed and dispatch | No dispatch; expiry cannot be extended by retries |
| Poisoned message/title instructing execution, approval or credential disclosure | Treated as untrusted data; no user-prompt promotion, shell or provider action |
| Duplicate event, repeated tick, two workers, restart, old epoch or stale lease | One bounded receipt/candidate; no duplicate native run |
| Pause, user question/approval, gate, queued input, active turn, pending tool, budget limit or DONE | Suppression survives event arrival and sleep/restart |
| Human/new turn races with final check | Native atomic arbitration rejects dispatch; absent support leaves native dispatch disabled |
| Wrong socket/runtime, unsupported schema, missing status, offline host or `notLoaded` | Coverage unavailable; no fallback server, resume or private-database read |
| Lost native response, crash after dispatch | Ambiguous state reconciled; no blind replay |
| Receipt cursor advances, message not yet read | Original message remains unread/unacknowledged; no answer/gate resolved |
| Approval/permission/elicitation request, inherited grants or auto-review | No autoaccept or escalation; forbidden tool attempts fail under effective controls |
| Large feed, malicious redirect, clock skew, Hub spam and long outage | Bounded memory/network/notifications; no stampede; no credential leakage |
| Goal already active, paused, interrupted, complete or budget-limited | Companion does not duplicate native continuation, resume it or reset accounting |
| Logging and cleanup review | Metadata only; exact owned resources and retention triggers recorded |

For a real adapter, separately demonstrate read without resume, exact runtime/host identity, effective permission policy, pause visibility, queued-input coverage, broker isolation and dispatch arbitration on a disposable owner-enrolled test thread. A passing protocol mock does not prove the installed desktop provides these controls. Inspect actual final source and repeat cross-principal tests before release.

## Stages and next owner decision

1. Finish the capacity remediation and retain explicit boundary inbox checks; no wake infrastructure is part of that change.
2. Implement and test a metadata-only device capability, pure eligibility logic, bounded local spool and notification prototype without installing persistence or enabling native execution.
3. Present one concrete enrollment choice: **approve a read-only metadata/notification pilot on one named machine and app, for an exact private session list, with an explicit expiry and fifteen-minute cadence?** Recommendation: approve this bounded pilot after reviewing its installation and uninstall procedure. Alternative: retain manual boundary checks with no background process. This is a proposed future decision, not an authorization request issued by this document.
4. Only after adapter evidence passes, present a separate exact-thread inbox-only execution enrollment with tested sandbox, runtime identity, atomic arbitration, budgets and stop conditions. Unsupported controls retain notification-only mode.
5. Business continuation, new Goals, additional hosts/apps and provider writes each require their own existing or explicit local authorization. Do not silently broaden the pilot.

No schedules, daemons, credentials, SDK installs, native session starts/resumes or provider writes were created during this research. The only intended retained resource is this design document; the parent task owns checkout closeout.
