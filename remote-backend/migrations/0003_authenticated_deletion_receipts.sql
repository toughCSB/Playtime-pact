-- Retain only the operation-bound verifier and receipt needed for late delete reconciliation.
CREATE TABLE IF NOT EXISTS deletion_receipts (
  household_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  public_jwk TEXT NOT NULL CHECK(json_valid(public_jwk)),
  membership_epoch INTEGER NOT NULL,
  service_epoch INTEGER NOT NULL,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;
