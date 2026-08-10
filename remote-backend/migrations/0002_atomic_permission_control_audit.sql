-- Keep each permission-control mutation and its audit receipt in one SQLite statement.
CREATE TRIGGER permission_control_audit_environment
AFTER UPDATE OF control_version ON environments
WHEN NEW.control_version = OLD.control_version + 1
BEGIN
  INSERT INTO permission_control_audit(
    id, scope, household_id, operator_id, previous_version, next_version,
    create_permission, respond_or_issue_permission, consume_permission,
    service_epoch, created_at_ms
  ) VALUES(
    lower(hex(randomblob(16))), 'environment', NULL,
    NEW.updated_by_operator_id, OLD.control_version, NEW.control_version,
    NEW.create_permission, NEW.respond_or_issue_permission, NEW.consume_permission,
    NEW.service_epoch, NEW.updated_at_ms
  );
END;

CREATE TRIGGER permission_control_audit_household
AFTER UPDATE OF control_version ON households
WHEN NEW.control_version = OLD.control_version + 1
BEGIN
  INSERT INTO permission_control_audit(
    id, scope, household_id, operator_id, previous_version, next_version,
    create_permission, respond_or_issue_permission, consume_permission,
    service_epoch, created_at_ms
  ) VALUES(
    lower(hex(randomblob(16))), 'household', NEW.id,
    NEW.controls_updated_by_operator_id, OLD.control_version, NEW.control_version,
    NEW.create_permission, NEW.respond_or_issue_permission, NEW.consume_permission,
    NEW.service_epoch, NEW.controls_updated_at_ms
  );
END;
