BEGIN;

CREATE OR REPLACE FUNCTION "SecurityAuditEvent_reject_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'SecurityAuditEvent rows are append-only';
END;
$$;

CREATE TRIGGER "SecurityAuditEvent_immutable_guard"
BEFORE UPDATE OR DELETE ON "SecurityAuditEvent"
FOR EACH ROW
EXECUTE FUNCTION "SecurityAuditEvent_reject_mutation"();

COMMIT;
