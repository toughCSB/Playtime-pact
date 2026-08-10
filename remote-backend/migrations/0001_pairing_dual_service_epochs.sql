-- Legacy sessions were bound to one epoch and cannot safely infer two independent authorities.
-- Revoke them during rollout; newly issued sessions write all three epoch columns.
ALTER TABLE pairing_sessions ADD COLUMN global_service_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pairing_sessions ADD COLUMN household_service_epoch INTEGER NOT NULL DEFAULT 0;

UPDATE pairing_sessions
SET revoked_at_ms = CASE WHEN used_at_ms IS NULL THEN 0 ELSE revoked_at_ms END,
    expires_at_ms = CASE WHEN used_at_ms IS NULL THEN 0 ELSE expires_at_ms END
WHERE used_at_ms IS NULL;
