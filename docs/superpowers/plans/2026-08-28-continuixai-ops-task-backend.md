# Continuixai Ops Task Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the secure task-management backend, immutable snapshots, audit events, daily summary, and reports.

**Architecture:** Extend the existing task foundation instead of replacing it. Keep tenant/site scope server-derived, preserve assignment history with snapshot fields, record state transitions in append-only events, and expose separate employee and manager endpoints.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-28-continuixai-ops-completion-design.md`

## Global Constraints

- Company name is Continuixai; application name is Continuixai Ops.
- legacy scan task is only an operational workflow/task, never the application identity.
- Existing Store Count counting behavior must not be refactored as part of task work.
- Organization/site scope is derived server-side from authenticated membership.
- Assignment snapshots and event history must not be rewritten by template edits.
- Site timezone controls day boundaries and due timestamps.
- Pharmacy task notes are operational only and surfaces warn against PHI.

---

### Task 1: Assignment snapshots and audit events

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260905000000_task_workflow_completion/migration.sql`
- Create: `apps/api/src/lib/taskWorkflow.test.ts`
- Create: `apps/api/src/lib/taskWorkflow.ts`

**Interfaces:**
- Produces `taskSnapshotData(template, fallbackSiteId, assignedToId, scheduledDate, dueAt)` and task event action types used by task routes.

- [ ] Write failing tests proving snapshot output preserves jobTitle, recurrence, rolloverPolicy, title, instructions, priority, site, assignee, scheduled date, and due date.
- [ ] Run the focused test and verify it fails because `taskWorkflow.ts` does not exist.
- [ ] Add snapshot fields and `TaskAssignmentEvent` schema/migration with indexes and foreign keys.
- [ ] Implement the pure snapshot helper.
- [ ] Re-run focused tests and syntax verification.
- [ ] Commit `feat: preserve task assignment history and events`.

### Task 2: Employee task service and rollover behavior

**Files:**
- Modify: `apps/api/src/routes/tasks.ts`
- Modify: `apps/api/src/lib/taskWorkflow.ts`
- Modify: `apps/api/src/lib/taskWorkflow.test.ts`

**Interfaces:**
- Produces `/api/tasks/me`, `/api/tasks/:id`, `/api/tasks/me/summary`.

- [ ] Add failing tests for grouping boundaries, stale SKIP behavior, and self-only assignment update policy helpers.
- [ ] Verify RED.
- [ ] Implement idempotent materialization snapshots, stale SKIP processing with events, scoped employee updates with completion events, and daily summary queries.
- [ ] Verify focused tests and source syntax.
- [ ] Commit `feat: complete employee task workflow api`.

### Task 3: Manager task APIs

**Files:**
- Modify: `apps/api/src/routes/tasks.ts`
- Create/modify: `apps/api/src/routes/tasks.manager.test.ts`

**Interfaces:**
- Produces `/api/tasks/team`, `/api/tasks/employees`, template create/update/deactivate, one-time assignment create, manager assignment patch, and reporting/export endpoints.

- [ ] Add failing route-contract tests for manager endpoints and forbidden cross-scope behavior.
- [ ] Verify RED.
- [ ] Implement scoped employee listing, template CRUD, one-time assignment, team status/history, manager transitions, and CSV reporting.
- [ ] Verify focused route tests where dependencies are available; otherwise run syntax/contract tests and leave dependency-backed verification pending.
- [ ] Commit `feat: add manager task operations and reporting`.
