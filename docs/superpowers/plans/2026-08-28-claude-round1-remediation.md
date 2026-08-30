# Claude Round 1 Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Resolve every confirmed Claude Round-1 finding that blocks Continuixai Ops from a controlled pilot and create a stronger Round-2 adversarial package.

**Architecture:** Preserve the existing tenant-scoped task and Count cores. Add idempotency at the database/API boundary, preserve unsynced Count work across auth invalidation, make employee/manager task lifecycle fully visible and usable, and narrow/disable inherited non-pilot surfaces by default rather than deleting dependencies the Count core may still share. Deployment and branding checks become release gates.

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
- [x] Add production MFA encryption secret to Render blueprint and remove stale branch pinning.
- [x] Rename Docker/Postgres defaults and image identifiers to Continuixai Ops.
- [x] Expand branding verification to deployment/docs/config and legacy inherited identifiers.
- [x] Make pure TypeScript scripts use portable module resolution.
- [x] Run the verification scripts.

### Task 2: One-time assignment idempotency
- [x] Add tenant-scoped unique `(organizationId, idempotencyKey)` protection to TaskAssignment and migration.
- [x] Require a stable high-entropy idempotency key for one-time assignment creation.
- [x] Return the existing assignment when a retry reuses the same key.
- [x] Generate/reuse the key in Team Work until a submission succeeds.
- [x] Add contract/regression coverage.

### Task 3: Offline Count queue preservation
- [x] Rename legacy storage keys and migrate the pre-rebrand Count queue without auto-attributing ownerless scans.
- [x] Do not clear unsynced Count queue on 401/logout.
- [x] Warn the user when unsynced Count work exists at sign-out/session invalidation.
- [x] Add regression coverage.

### Task 4: Employee and manager lifecycle UX
- [x] Include SKIPPED tasks in employee Daily Summary and My Work grouping.
- [x] Add manager reassignment control.
- [x] Prevent UTC-seeded manager dates before the site date is known.
- [x] Use server `taskManager` as the only manager navigation signal.
- [x] Add UI/contract coverage.

### Task 5: Site isolation and inherited legacy application surface
- [x] Add explicit SiteMembership scoping and fail-closed multi-site behavior.
- [x] Require active current-site membership for employee listing, one-time assignment, and reassignment.

- [x] Disable non-pilot inherited API routes and background jobs by default behind `ENABLE_LEGACY_INVENTORY_FEATURES=true`.
- [x] Prevent navigation to inherited web pages from the supported Continuixai Ops UX.
- [x] Replace the old inherited roadmap with an explicit legacy-surface note and Continuixai Ops roadmap pointer.
- [x] Verify Count/product/location pilot routes remain enabled.

### Task 6: Final verification and Claude Round 2 handoff
- [x] Run all dependency-free/pure checks.
- [x] Attempt clean dependency-backed verification; record that npm install cannot complete in this sandbox and Prisma CLI is unavailable in the incomplete local install.
- [x] Run git diff/status checks and scan for prohibited branding.
- [x] Update Claude adversarial brief with Round-1 fixes and remaining network/device gates.
- [ ] Package a clean Round-2 ZIP and checksum.
