# Household Deletion, Privacy, Retention, and Recovery Runbook

## Ownership and service levels

- Privacy owner: retention schedule, disclosure, backup handling, and deletion evidence.
- Backend on-call: deny-first deletion state, purge queue, tombstones, retries, and alerts.
- Client owners: local token/key/config cleanup and non-resurrection behavior.

Deletion must deny new requests, responses, grants, consumes, pairing, and token registration immediately. Physical purge may be asynchronous but must be bounded, observable, retryable, and represented by a non-authoritative expiring tombstone.

## Data classes and defaults

- Request/grant bodies and idempotency receipts: retain only for the bounded replay/audit window required by active operations.
- Notification payloads: opaque identifiers only; never include child name, game title, allowance, rejection reason, or household details.
- Notification delivery intents and tokens: remove on parent revoke/reset/delete; retain failed-delivery evidence only for the bounded incident window.
- Telemetry: conservative aggregate counters without private request content; expire on the published retention schedule.
- Deleted household tombstone: household opaque id, deletion state/version, and expiry only. It cannot authorize or resurrect membership.
- Backups: document provider retention separately; restored data remains denied by the deletion tombstone and current epochs.

## Household deletion flow

1. Authenticate a current equal parent or local administrator recovery capability and bind an idempotency key.
2. Atomically mark the household `deleting`, increment membership/service epochs, deny every operation, revoke pairings/tokens, and enqueue purge work.
3. Return a durable deletion receipt. A timeout is indeterminate: clients reconcile the same idempotency key and must not create a replacement household implicitly.
4. Purge requests, grants, allowances, reservations, debits, parent/PC credentials, notification data, telemetry links, and stale idempotency bodies in dependency-safe batches.
5. Replace the household with the minimal expiring tombstone and record completion evidence.
6. Android and Electron clear local membership, tokens, pending intents, grants, and remote UI state only after authoritative reconciliation; protected local accounting remains governed by its retention policy and cannot grant remote authority.

## Alerts and recovery

- Page backend on-call when a deletion remains `deleting` beyond the deletion SLA, a purge batch repeatedly fails, token clearing is incomplete, or deleted identities authenticate.
- Keep the household denied during repair. Retry purge idempotently from the recorded cursor.
- If a backup restore reintroduces deleted rows, the higher deletion epoch/tombstone wins; quarantine restored rows and rerun purge.
- Never remove a tombstone before its disclosed expiry and backup horizon.

## Privacy or secret incident

1. Disable affected permission operations and preserve audit evidence.
2. Revoke exposed credentials/tokens and increment relevant epochs.
3. Search source artifacts, packaged files, logs, D1 data, notification intents, and build output for the exposed material.
4. Purge unauthorized copies under the retention/deletion policy and document provider-side backup limitations.
5. Validate old credentials, tokens, pairings, requests, and grants all fail before re-enabling service.

## Rollback constraints

Code may roll back only while retaining current epochs, deletion states, tombstones, allowance versions, idempotency receipts, and accounting high-water marks. A rollback that cannot read current state stays fail closed. Household recreation after completed deletion requires explicit new setup with new identifiers and credentials; old membership never revives.
