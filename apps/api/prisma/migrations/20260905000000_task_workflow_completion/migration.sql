-- Continuixai Ops task workflow completion: immutable assignment snapshots + append-only events.
ALTER TABLE "TaskAssignment"
  ADD COLUMN "jobTitle" "JobTitle",
  ADD COLUMN "recurrence" "TaskRecurrence" NOT NULL DEFAULT 'ONCE',
  ADD COLUMN "rolloverPolicy" "TaskRolloverPolicy" NOT NULL DEFAULT 'REMAIN_OVERDUE';

UPDATE "TaskAssignment" AS a
SET
  "jobTitle" = t."jobTitle",
  "recurrence" = t."recurrence",
  "rolloverPolicy" = t."rolloverPolicy"
FROM "TaskTemplate" AS t
WHERE a."templateId" = t."id";

UPDATE "TaskAssignment" AS a
SET "jobTitle" = u."jobTitle"
FROM "User" AS u
WHERE a."assignedToId" = u."id" AND a."jobTitle" IS NULL;

CREATE TABLE "TaskAssignmentEvent" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "siteId" TEXT,
  "actorUserId" TEXT,
  "action" TEXT NOT NULL,
  "fromStatus" "TaskStatus",
  "toStatus" "TaskStatus",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskAssignmentEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TaskAssignmentEvent_assignmentId_createdAt_idx"
  ON "TaskAssignmentEvent"("assignmentId", "createdAt");
CREATE INDEX "TaskAssignmentEvent_organizationId_siteId_createdAt_idx"
  ON "TaskAssignmentEvent"("organizationId", "siteId", "createdAt");
CREATE INDEX "TaskAssignmentEvent_actorUserId_createdAt_idx"
  ON "TaskAssignmentEvent"("actorUserId", "createdAt");

ALTER TABLE "TaskAssignmentEvent" ADD CONSTRAINT "TaskAssignmentEvent_assignmentId_fkey"
  FOREIGN KEY ("assignmentId") REFERENCES "TaskAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskAssignmentEvent" ADD CONSTRAINT "TaskAssignmentEvent_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskAssignmentEvent" ADD CONSTRAINT "TaskAssignmentEvent_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskAssignmentEvent" ADD CONSTRAINT "TaskAssignmentEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "enforce_task_assignment_event_scope"()
RETURNS trigger AS $$
DECLARE
  assignment_org TEXT;
  assignment_site TEXT;
BEGIN
  SELECT "organizationId", "siteId"
  INTO assignment_org, assignment_site
  FROM "TaskAssignment"
  WHERE "id" = NEW."assignmentId";

  IF assignment_org IS NULL OR assignment_org <> NEW."organizationId" THEN
    RAISE EXCEPTION 'TaskAssignmentEvent Organization must match Assignment';
  END IF;
  IF assignment_site IS DISTINCT FROM NEW."siteId" THEN
    RAISE EXCEPTION 'TaskAssignmentEvent Site must match Assignment';
  END IF;
  IF NEW."actorUserId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "OrganizationMembership"
    WHERE "organizationId" = NEW."organizationId"
      AND "userId" = NEW."actorUserId"
      AND "isActive" = true
  ) THEN
    RAISE EXCEPTION 'TaskAssignmentEvent actor must be an active Organization member';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TaskAssignmentEvent_scope_guard"
BEFORE INSERT OR UPDATE ON "TaskAssignmentEvent"
FOR EACH ROW EXECUTE FUNCTION "enforce_task_assignment_event_scope"();

CREATE OR REPLACE FUNCTION "prevent_task_assignment_event_mutation"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'TaskAssignmentEvent rows are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TaskAssignmentEvent_immutable_guard"
BEFORE UPDATE OR DELETE ON "TaskAssignmentEvent"
FOR EACH ROW EXECUTE FUNCTION "prevent_task_assignment_event_mutation"();
