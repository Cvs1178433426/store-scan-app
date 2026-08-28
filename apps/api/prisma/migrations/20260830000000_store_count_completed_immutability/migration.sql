-- Enforce the Retail Count MVP invariant that count entries cannot be changed
-- after their parent count session is completed or cancelled.
--
-- The route layer already rejects scans into non-ACTIVE sessions. This trigger
-- closes race conditions and prevents direct ORM/database entry edits or deletes
-- from silently rewriting completed count history.

CREATE OR REPLACE FUNCTION "prevent_nonactive_store_count_entry_write"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_session_id text;
  parent_status "StoreCountSessionStatus";
BEGIN
  parent_session_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."sessionId" ELSE NEW."sessionId" END;

  SELECT "status"
    INTO parent_status
    FROM "StoreCountSession"
   WHERE "id" = parent_session_id;

  -- During a cascading parent-session delete the parent row can already be gone;
  -- allow that referential cleanup. A direct entry mutation still sees its parent.
  IF NOT FOUND THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF parent_status <> 'ACTIVE'::"StoreCountSessionStatus" THEN
    RAISE EXCEPTION 'store count session % is not active; completed/cancelled count entries are immutable', parent_session_id
      USING ERRCODE = '55000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS "StoreCountEntry_require_active_session" ON "StoreCountEntry";

CREATE TRIGGER "StoreCountEntry_require_active_session"
BEFORE INSERT OR UPDATE OR DELETE ON "StoreCountEntry"
FOR EACH ROW
EXECUTE FUNCTION "prevent_nonactive_store_count_entry_write"();
