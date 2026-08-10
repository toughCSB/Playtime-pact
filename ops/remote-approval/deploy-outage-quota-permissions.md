# Remote Approval Deployment and Service Control Runbook

## Ownership

- Release owner: validates artifacts, migrations, rollback readiness, and staged cohort promotion.
- Backend on-call: owns Worker/D1 health, cleanup, latency, quota, and permission controls.
- Desktop owner: owns broker health and fail-closed enforcement.
- Android owner: owns supported-version telemetry and parent-client health.

Production Cloudflare, FCM, Windows signing, and Android signing credentials are external gates. Never place them in this repository or command history.

## Pre-deploy gates

1. Verify the full local backend/D1 contract suite, Electron broker/accounting and tamper suite, Android instrumentation, renderer accessibility suite, secret scan, and package builds.
2. Confirm environment and household permission tuples expose `create`, `respond_or_issue`, and `consume` independently and compose with logical AND.
3. Confirm entering all-false increments the service epoch and stale grants cannot revive.
4. Confirm D1 capacity and projected Worker/FCM use retain at least 5x measured headroom.
5. Confirm deletion cleanup, token delivery retry, idempotency lease cleanup, and telemetry retention jobs are healthy.
6. Record artifact hashes and production signature verification outside the repository.

## Notification and cleanup scheduler

- Configure `FCM_TOKEN_ENCRYPTION_KEY` as exactly 32 random bytes encoded with standard Base64. Rotation requires an explicit token re-registration migration; replacing it in place makes existing ciphertext undecryptable and delivery fails closed.
- Configure `NOTIFICATION_PROVIDER_ENDPOINT` as an HTTPS gateway and `NOTIFICATION_PROVIDER_BEARER` as its secret credential. The gateway accepts `{token,intentId}` and must acknowledge success with a non-empty `x-provider-receipt` header or bounded response body.
- Store all three values with the platform secret manager, never plaintext Worker variables. Missing or malformed configuration disables dispatch rather than exposing tokens.
- Confirm the one-minute Worker cron is active. Alert on retry depth, terminal delivery errors, pending deletion age, and any `FCM_CIPHERTEXT_INVALID` event.
- Exercise provider 429/5xx retry, terminal 4xx rejection, three-attempt exhaustion, opaque payload recovery, and due deletion purge in staging before promotion.

## Staged deployment

1. Apply additive schema migrations while the environment tuple is all false.
2. Deploy the Worker with all operations disabled. Run only synthetic, non-game health and cleanup probes.
3. Enable `consume` only long enough to validate stale-grant denial and no-op health paths; disable it immediately if any epoch or receipt mismatch appears.
4. Admit an internally signed Android/Electron cohort, then one household canary.
5. Enable operations in order: `consume`, `respond_or_issue`, then `create`. Verify effective environment AND household tuples after each step.
6. Expand only when authentication failures, D1 conflicts, cleanup lag, notification retry depth, request latency, and quota remain below recorded thresholds for a full observation window.

## Incident response

- Authentication, epoch, accounting-anchor, or idempotency-integrity anomaly: set all three environment permissions false immediately. Do not delete evidence.
- D1/Worker outage: disable `create` and `respond_or_issue`; leave `consume` enabled only when authoritative receipt reconciliation is healthy. Electron remains blocked except for the separately authorized memory-only local outage grant.
- FCM outage: keep authoritative APIs available; Android app-open/foreground sync is the recovery path. Push payloads remain opaque.
- Quota pressure: disable `create` first, then `respond_or_issue`; preserve consume/reconciliation where capacity permits. Never drop accounting or deletion work to admit new requests.
- Cleanup or deletion backlog: stop new pairing and request creation, preserve deny-first deletion state, and page backend on-call.

## Rollback

1. Set all environment permissions false and record the new service epoch.
2. Roll back Worker code only to a schema-compatible build. Never roll back epochs, idempotency receipts, allowance versions, accounting high-water marks, deletion tombstones, or supported Android version floors.
3. Reconcile outstanding consumes, notification intents, and deletion jobs before re-enabling any operation.
4. Re-enable in the staged order above after a clean local/staging replay and on-call sign-off.
