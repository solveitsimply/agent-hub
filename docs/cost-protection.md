# Cost protection

Workers Paid is usage-based. This application cannot guarantee a monthly dollar
ceiling. Keep account-specific budgets, limiter namespace IDs, email recipients
and Cloudflare permissions in the private deployment configuration.

## Application safeguards

The example Wrangler configuration sets a 50 ms CPU ceiling per invocation.
Verify the private configuration uses the same ceiling. Waiting for D1 is not
CPU time. CPU limits do not cap request counts or database work.

Set `HUB_USAGE_LIMITS_JSON` to `{}` to enable the default daily budgets after
applying migration `0014_usage_budgets.sql`. Defaults are 10000 admitted
operations, 100 million D1 rows read and 100000 rows written per UTC day.
The default per-operation reservations are 1 million reads and 1000 writes;
all five positive integer settings are configurable. Omit the variable to
disable this feature; invalid settings or a missing counter table fail closed.

Admission reserves read/write headroom atomically before authentication or
coordination SQL. Successful statements report actual D1 `meta` usage, including
batch and first-row reads, and settlement releases unused headroom. Accounting
includes conservative guard overhead. Failed/terminated operations retain their
reservations. An unusually expensive statement can exceed its reservation;
its observed usage is charged in full and subsequent statements stop. In-flight
work, rejected admissions, owner inspections, migrations and other applications
are reasons these counters cannot serve as billing proof. Small budgets may
pause valid work early. A failed response can follow a committed mutation:
check its outcome and use the original idempotency key before retrying.

Normal API calls, remote MCP/OAuth and daily retention share the daily budget. Exhaustion returns
`429 HUB_DAILY_BUDGET` with `Retry-After` until 00:00 UTC. Retention prunes counter
rows older than 90 days; counters contain no principal IDs or message contents.
Existing message/session custody and authorization checks still apply.

Configure optional native rate-limit bindings named `HUB_IP_LIMITER` and
`HUB_GLOBAL_LIMITER` in private Wrangler settings. Use a unique namespace ID
for each binding. The former uses Cloudflare's connecting IP; the latter uses a
single aggregate key. Set `HUB_TRAFFIC_GUARD_REQUIRED=true` to fail closed if
either binding is absent. Limiter failures return 503; throttling returns
`429 HUB_RATE_LIMITED` and a 60-second retry delay. These approximate counters
are per Cloudflare location, and execute after the Worker invocation begins.
They protect D1 access but do not prevent request charges. Consider a zone WAF
rule before the Worker when the hosting domain and plan support it.

Set `HUB_PAUSED=true` through the owner's deployment configuration to stop normal
API work and retention. The public health response and owner-only
`GET /api/usage` remain available. Pausing does not remove stored coordination
data. Owner inspection bypasses admission, so it remains usable during a pause.

## Warnings and email alerts

`GET /api/usage` returns today's Hub budgets and counters to the owner only.
Warnings start at 70% and become critical at 85%. Successful normal API responses
also carry `X-Hub-Usage-Warning` at these levels. The owner's dashboard displays
these warnings and provides a manual **Check usage** button. No polling or model
execution is added. These warnings do not send email and are not Cloudflare
account-wide measurements.

Configure provider email warnings against actual included allowances, independently
of application counters. Workers requests, CPU, D1 reads/writes and storage are
separate billing dimensions. Do not treat 70% of one dimension as a dollar amount.
Confirm the account's supported notification products/datasets before relying on
any email threshold. Where native product alerts are unavailable, explicit
account-level monitoring is needed; dashboard warnings alone are insufficient.

Cloudflare dollar budget alerts exclude the fixed Workers subscription fee,
notify after additional usage-based spend, and never stop work. They can arrive
the following day. Use a small dollar alert as backup, not as the warning before
the included allowances are exhausted.

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[rate-limit accuracy](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
[budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/),
[budget alert timing](https://developers.cloudflare.com/changelog/post/2026-06-15-budget-alerts-default-on/).
