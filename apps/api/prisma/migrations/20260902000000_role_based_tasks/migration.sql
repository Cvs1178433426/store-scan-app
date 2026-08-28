CREATE TYPE "JobTitle" AS ENUM (
  'STORE_MANAGER',
  'INVENTORY_MANAGER',
  'STOCK_COUNT_ASSOCIATE',
  'RECEIVER',
  'CASHIER_CUSTOMER_SERVICE',
  'PHARMACY_TEAM'
);

CREATE TYPE "TaskRecurrence" AS ENUM ('ONCE', 'DAILY', 'WEEKLY', 'MONTHLY');
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED', 'CANCELLED');
CREATE TYPE "TaskRolloverPolicy" AS ENUM ('REMAIN_OVERDUE', 'ROLL_FORWARD', 'SKIP');

ALTER TABLE "User" ADD COLUMN "jobTitle" "JobTitle";
CREATE INDEX "User_jobTitle_isActive_idx" ON "User"("jobTitle", "isActive");

ALTER TABLE "Site" ADD COLUMN "timeZone" TEXT NOT NULL DEFAULT 'America/New_York';

CREATE TABLE "TaskTemplate" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "siteId" TEXT,
  "jobTitle" "JobTitle" NOT NULL,
  "title" TEXT NOT NULL,
  "instructions" TEXT,
  "recurrence" "TaskRecurrence" NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE,
  "weeklyDay" INTEGER,
  "monthlyDay" INTEGER,
  "dueTime" TEXT,
  "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
  "rolloverPolicy" "TaskRolloverPolicy" NOT NULL DEFAULT 'REMAIN_OVERDUE',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT NOT NULL,
  "updatedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TaskTemplate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaskTemplate_weeklyDay_check" CHECK ("weeklyDay" IS NULL OR "weeklyDay" BETWEEN 0 AND 6),
  CONSTRAINT "TaskTemplate_monthlyDay_check" CHECK ("monthlyDay" IS NULL OR "monthlyDay" BETWEEN 1 AND 31),
  CONSTRAINT "TaskTemplate_dueTime_check" CHECK ("dueTime" IS NULL OR "dueTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT "TaskTemplate_date_range_check" CHECK ("endDate" IS NULL OR "endDate" >= "startDate")
);

CREATE TABLE "TaskAssignment" (
  "id" TEXT NOT NULL,
  "templateId" TEXT,
  "organizationId" TEXT NOT NULL,
  "siteId" TEXT,
  "assignedToId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "instructions" TEXT,
  "scheduledDate" DATE NOT NULL,
  "dueAt" TIMESTAMP(3),
  "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
  "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
  "employeeNote" TEXT,
  "managerNote" TEXT,
  "completedAt" TIMESTAMP(3),
  "completedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TaskAssignment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TaskTemplate_organizationId_isActive_jobTitle_idx"
  ON "TaskTemplate"("organizationId", "isActive", "jobTitle");
CREATE INDEX "TaskTemplate_siteId_isActive_jobTitle_idx"
  ON "TaskTemplate"("siteId", "isActive", "jobTitle");
CREATE UNIQUE INDEX "TaskAssignment_templateId_assignedToId_scheduledDate_key"
  ON "TaskAssignment"("templateId", "assignedToId", "scheduledDate");
CREATE INDEX "TaskAssignment_assignedToId_scheduledDate_status_idx"
  ON "TaskAssignment"("assignedToId", "scheduledDate", "status");
CREATE INDEX "TaskAssignment_organizationId_siteId_scheduledDate_status_idx"
  ON "TaskAssignment"("organizationId", "siteId", "scheduledDate", "status");
CREATE INDEX "TaskAssignment_templateId_idx" ON "TaskAssignment"("templateId");

ALTER TABLE "TaskTemplate" ADD CONSTRAINT "TaskTemplate_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskTemplate" ADD CONSTRAINT "TaskTemplate_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskTemplate" ADD CONSTRAINT "TaskTemplate_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaskTemplate" ADD CONSTRAINT "TaskTemplate_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "TaskTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_assignedToId_fkey"
  FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_completedById_fkey"
  FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "validate_task_template_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  site_org TEXT;
  creator_is_member BOOLEAN;
  updater_is_member BOOLEAN;
BEGIN
  IF NEW."siteId" IS NOT NULL THEN
    SELECT "organizationId" INTO site_org FROM "Site" WHERE "id" = NEW."siteId";
    IF site_org IS NULL OR site_org <> NEW."organizationId" THEN
      RAISE EXCEPTION 'TaskTemplate Site must belong to Organization';
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM "OrganizationMembership"
    WHERE "organizationId" = NEW."organizationId" AND "userId" = NEW."createdById" AND "isActive" = true
  ) INTO creator_is_member;
  SELECT EXISTS (
    SELECT 1 FROM "OrganizationMembership"
    WHERE "organizationId" = NEW."organizationId" AND "userId" = NEW."updatedById" AND "isActive" = true
  ) INTO updater_is_member;

  IF NOT creator_is_member OR NOT updater_is_member THEN
    RAISE EXCEPTION 'TaskTemplate creators and updaters must be active Organization members';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "TaskTemplate_scope_guard"
BEFORE INSERT OR UPDATE ON "TaskTemplate"
FOR EACH ROW EXECUTE FUNCTION "validate_task_template_scope"();

CREATE OR REPLACE FUNCTION "validate_task_assignment_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  site_org TEXT;
  template_org TEXT;
  template_site TEXT;
  assignee_is_member BOOLEAN;
  completer_is_member BOOLEAN;
BEGIN
  IF NEW."siteId" IS NOT NULL THEN
    SELECT "organizationId" INTO site_org FROM "Site" WHERE "id" = NEW."siteId";
    IF site_org IS NULL OR site_org <> NEW."organizationId" THEN
      RAISE EXCEPTION 'TaskAssignment Site must belong to Organization';
    END IF;
  END IF;

  IF NEW."templateId" IS NOT NULL THEN
    SELECT "organizationId", "siteId" INTO template_org, template_site
    FROM "TaskTemplate" WHERE "id" = NEW."templateId";
    IF template_org IS NULL OR template_org <> NEW."organizationId" THEN
      RAISE EXCEPTION 'TaskAssignment Template must belong to Organization';
    END IF;
    IF template_site IS NOT NULL AND template_site IS DISTINCT FROM NEW."siteId" THEN
      RAISE EXCEPTION 'TaskAssignment Site must match site-scoped Template';
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM "OrganizationMembership"
    WHERE "organizationId" = NEW."organizationId" AND "userId" = NEW."assignedToId" AND "isActive" = true
  ) INTO assignee_is_member;
  IF NOT assignee_is_member THEN
    RAISE EXCEPTION 'TaskAssignment assignee must be an active Organization member';
  END IF;

  IF NEW."completedById" IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM "OrganizationMembership"
      WHERE "organizationId" = NEW."organizationId" AND "userId" = NEW."completedById" AND "isActive" = true
    ) INTO completer_is_member;
    IF NOT completer_is_member THEN
      RAISE EXCEPTION 'TaskAssignment completer must be an active Organization member';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "TaskAssignment_scope_guard"
BEFORE INSERT OR UPDATE ON "TaskAssignment"
FOR EACH ROW EXECUTE FUNCTION "validate_task_assignment_scope"();
