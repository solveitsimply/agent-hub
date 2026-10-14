# Explicit session location reconciliation

`POST /api/sessions/:id/location` records a human-confirmed device/profile
location for an existing registration. Only its existing executing principal
may write it. It cannot adopt another principal's session, move an observer
binding, or revive an archived registration.

The caller supplies `requestId` (UUID), the exact receipt values
`expectedRevision`, `expectedLastSeenAt`, `expectedMachine`,
`expectedExternalId`, `expectedPrincipalId`, `expectedProject`, and the new
`machine`, `nativeId` (UUID), and
`reference: {deviceId, profileId, app, conversationId}`. The native UUID must
match the registration's documented current or legacy identity. A reused
request ID returns the recorded result; changing its payload conflicts.

The client must refresh complete device/profile discovery, verify the exact
current native ID and selected destination, review copied histories, and
obtain explicit operator confirmation. The server rechecks identity,
invitation scope, observer absence and revision at the write boundary. It
preserves the Hub ID, external identity, claims, task, status, checkpoint,
history and last report time, updates machine/location and revision, and
records an audit event. Ordinary session updates preserve this location.

`details.nativeLocation` is labeled `source: operator_confirmed`. It is saved
history location metadata, never proof of a running native process, task
completion, human approval, or permission to deliver a message. Receiving
devices must authorize native messaging separately. Old-machine lifecycle
receipts must be quarantined after reconciliation rather than replayed as
fresh activity or closeout.
