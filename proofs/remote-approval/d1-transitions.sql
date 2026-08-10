PRAGMA foreign_keys = ON;

CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('LOCAL_ONLY', 'REMOTE_ENABLED')),
  service_epoch INTEGER NOT NULL CHECK (service_epoch > 0)
) STRICT;

CREATE TABLE households (
  id TEXT PRIMARY KEY,
  remote_enabled INTEGER NOT NULL CHECK (remote_enabled IN (0, 1)),
  service_epoch INTEGER NOT NULL CHECK (service_epoch > 0),
  membership_epoch INTEGER NOT NULL CHECK (membership_epoch > 0)
) STRICT;

CREATE TABLE parent_devices (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  public_jwk TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  membership_epoch INTEGER NOT NULL
) STRICT;

CREATE TABLE auth_replays (
  actor_id TEXT NOT NULL,
  membership_epoch INTEGER NOT NULL,
  jti TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (actor_id, membership_epoch, jti),
  UNIQUE (actor_id, membership_epoch, nonce)
) STRICT;

CREATE TABLE idempotency_records (
  actor_id TEXT NOT NULL,
  membership_epoch INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation_digest TEXT NOT NULL,
  result_json TEXT,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (actor_id, membership_epoch, idempotency_key)
) STRICT;

CREATE TABLE personal_responses (
  request_id TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  membership_epoch INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('reject', 'approve')),
  minutes INTEGER,
  responded_at_ms INTEGER NOT NULL,
  PRIMARY KEY (request_id, parent_id, membership_epoch)
) STRICT;

CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  pc_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  allowance_version INTEGER NOT NULL,
  membership_epoch INTEGER NOT NULL,
  service_epoch INTEGER NOT NULL,
  household_service_epoch INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'expired')),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  approved_at_ms INTEGER,
  approved_by TEXT,
  approved_minutes INTEGER,
  CHECK (expires_at_ms = created_at_ms + 300000),
  CHECK ((status = 'approved') = (approved_at_ms IS NOT NULL AND approved_by IS NOT NULL AND approved_minutes IS NOT NULL))
) STRICT;

CREATE TABLE approval_grants (
  request_id TEXT PRIMARY KEY REFERENCES approval_requests(id),
  household_id TEXT NOT NULL,
  pc_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  allowance_version INTEGER NOT NULL,
  membership_epoch INTEGER NOT NULL,
  service_epoch INTEGER NOT NULL,
  household_service_epoch INTEGER NOT NULL,
  approved_by TEXT NOT NULL,
  approved_minutes INTEGER NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('issued', 'consumed')),
  consumed_at_ms INTEGER,
  CHECK (expires_at_ms = issued_at_ms + 300000),
  CHECK ((state = 'consumed') = (consumed_at_ms IS NOT NULL))
) STRICT;

CREATE TABLE allowance_debits (
  request_id TEXT PRIMARY KEY REFERENCES approval_requests(id),
  allowance_version INTEGER NOT NULL,
  debit_seconds INTEGER NOT NULL CHECK (debit_seconds > 0),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TRIGGER create_grant_after_first_approval
AFTER UPDATE OF status ON approval_requests
WHEN OLD.status = 'pending' AND NEW.status = 'approved'
BEGIN
  INSERT INTO approval_grants (
    request_id, household_id, pc_id, game_id, allowance_version,
    membership_epoch, service_epoch, household_service_epoch, approved_by, approved_minutes,
    issued_at_ms, expires_at_ms, state
  ) VALUES (
    NEW.id, NEW.household_id, NEW.pc_id, NEW.game_id, NEW.allowance_version,
    NEW.membership_epoch, NEW.service_epoch, NEW.household_service_epoch, NEW.approved_by, NEW.approved_minutes,
    NEW.approved_at_ms, NEW.approved_at_ms + 300000, 'issued'
  );
END;

CREATE TRIGGER debit_after_first_consume
AFTER UPDATE OF state ON approval_grants
WHEN OLD.state = 'issued' AND NEW.state = 'consumed'
BEGIN
  INSERT INTO allowance_debits (request_id, allowance_version, debit_seconds, created_at_ms)
  VALUES (NEW.request_id, NEW.allowance_version, NEW.approved_minutes * 60, NEW.consumed_at_ms);
END;

-- First-approval-wins CAS. The Worker must require meta.changes = 1; a loser
-- reads the committed request/grant and never retries with different minutes.
-- UPDATE approval_requests AS request
-- SET status='approved', approved_at_ms=?1, approved_by=?2, approved_minutes=?3
-- WHERE id=?4 AND status='pending' AND expires_at_ms>?1
--   AND membership_epoch=?5 AND service_epoch=?6 AND household_service_epoch=?7
--   AND EXISTS (SELECT 1 FROM environments environment
--     WHERE environment.id='global' AND environment.mode='REMOTE_ENABLED' AND environment.service_epoch=?6)
--   AND EXISTS (SELECT 1 FROM households household
--     WHERE household.id=request.household_id AND household.remote_enabled=1
--       AND household.membership_epoch=?5 AND household.service_epoch=?7);

-- One-use consume CAS. Trigger insertion of the debit is in the same SQLite
-- statement transaction. The Worker must require meta.changes = 1.
-- UPDATE approval_grants AS grant_row
-- SET state='consumed', consumed_at_ms=?1
-- WHERE request_id=?2 AND state='issued' AND expires_at_ms>?1
--   AND pc_id=?3 AND game_id=?4 AND allowance_version=?5
--   AND membership_epoch=?6 AND service_epoch=?7 AND household_service_epoch=?8
--   AND EXISTS (SELECT 1 FROM environments environment
--     WHERE environment.id='global' AND environment.mode='REMOTE_ENABLED' AND environment.service_epoch=?7)
--   AND EXISTS (SELECT 1 FROM households household
--     WHERE household.id=grant_row.household_id AND household.remote_enabled=1
--       AND household.membership_epoch=?6 AND household.service_epoch=?8);

-- Idempotent mutation protocol: one D1 batch transaction inserts the unique
-- (actor, epoch, key, digest) claim, performs the CAS, and stores result_json.
-- A uniqueness failure rolls back the whole batch. The retry path reads the
-- existing row, requires the same digest and a non-null result_json, and
-- returns that cached result without executing the mutation again.
