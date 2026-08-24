-- Enforce the Store Count recovery invariant at the database level.
-- A user may keep historical COMPLETED/CANCELLED sessions, but only one ACTIVE
-- session can exist at a time. startedById is nullable for historical/system rows,
-- so the partial unique index applies only to authenticated user sessions.
CREATE UNIQUE INDEX "StoreCountSession_one_active_per_user_key"
ON "StoreCountSession" ("startedById")
WHERE "status" = 'ACTIVE' AND "startedById" IS NOT NULL;
