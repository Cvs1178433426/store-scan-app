# Claude Round 1 Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every confirmed Claude Round-1 finding that blocks Continuixai Ops from a controlled pilot and create a stronger Round-2 adversarial package.

**Architecture:** Preserve the existing tenant-scoped task and Count cores. Add idempotency at the database/API boundary, preserve unsynced Count work across auth invalidation, make employee/manager task lifecycle fully visible and usable, and narrow/disable inherited legacy Stash surfaces by default rather than deleting dependencies the Count core may still share. Deployment and branding checks become release gates.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL, Next.js/React, Node.js verification scripts.

**Spec:** `docs/CLAUDE-COMPLETE-REVIEW-BRIEF.md` plus `CLAUDEADVERSARIALREVIEW.md` Round-1 findings F-01 through F-11.

## Global Constraints
- Company name: Continuixai.
- Application name: Continuixai Ops.
- Store Scan is not an application/product label; it may exist only as an assignable operational task name.
- Preserve tenant/org/site scoping on every task and Count mutation.
- Preserve completed Count immutability and task event append-only history.
- One-time assignment retries must be idempotent without preventing intentionally distinct assignments.
- Unsynced Count work must never be silently discarded by logout or 401 handling.
- Legacy inherited features are disabled by default for pilot unless explicitly enabled by environment configuration.

---

### Task 1: Deployment and branding gates
- [ ] Add production MFA encryption secret to Render blueprint and remove stale branch pinning.
- [ ] Rename Docker/Postgres defaults and image identifiers to Continuixai Ops.
- [ ] Expand branding verification to deployment/docs/config and legacy `stash` tokens.
- [ ] Make pure TypeScript scripts use portable module resolution.
- [ ] Run the verification scripts.

### Task 2: One-time assignment idempotency
- [ ] Add nullable unique `idempotencyKey` to TaskAssignment and migration.
- [ ] Require a UUID idempotency key for one-time assignment creation.
- [ ] Return the existing assignment when a retry reuses the same key.
- [ ] Generate/reuse the key in Team Work until a submission succeeds.
- [ ] Add contract/regression coverage.

### Task 3: Offline Count queue preservation
- [ ] Rename legacy storage keys with backward-compatible migration.
- [ ] Do not clear unsynced Count queue on 401/logout.
- [ ] Warn the user when unsynced Count work exists at sign-out/session invalidation.
- [ ] Add regression coverage.

### Task 4: Employee and manager lifecycle UX
- [ ] Include SKIPPED tasks in employee Daily Summary and My Work grouping.
- [ ] Add manager reassignment control.
- [ ] Prevent UTC-seeded manager dates before the site date is known.
- [ ] Use server `taskManager` as the only manager navigation signal.
- [ ] Add UI/contract coverage.

### Task 5: Inherited legacy application surface
- [ ] Disable non-pilot inherited API routes and background jobs by default behind `ENABLE_LEGACY_INVENTORY_FEATURES=true`.
- [ ] Prevent navigation to inherited web pages from the supported Continuixai Ops UX.
- [ ] Replace the old Stash roadmap with an explicit legacy-surface note and Continuixai Ops roadmap pointer.
- [ ] Verify Count/product/location pilot routes remain enabled.

### Task 6: Final verification and Claude Round 2 handoff
- [ ] Run all dependency-free/pure checks.
- [ ] Attempt Prisma generation, test, lint, and build; report exact environment result.
- [ ] Run git diff/status checks and scan for prohibited branding.
- [ ] Update Claude adversarial brief with Round-1 fixes and remaining network/device gates.
- [ ] Package a clean Round-2 ZIP and checksum.
