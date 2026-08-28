# Continuixai Ops Claude Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden and package Continuixai Ops for an independent Claude adversarial review.

**Architecture:** Use deterministic source checks and the full project verification suite where dependencies are available. Update the review brief to match the final product architecture and explicitly challenge the new task/reporting surfaces plus the unchanged counting core.

**Tech Stack:** npm workspaces, Vitest, ESLint, TypeScript, Prisma/PostgreSQL CI, Node source-verification scripts.

**Spec:** `docs/superpowers/specs/2026-08-28-continuixai-ops-completion-design.md`

## Global Constraints

- Do not claim a test/build passed unless it was freshly executed and returned success.
- Network/dependency limitations must be reported as unverified, not inferred green.
- Claude must review the exact final source archive/commit it is given.

---

### Task 1: Static integrity and security checks

**Files:**
- Create: `scripts/verify-task-workflow.cjs`
- Modify as findings require: task API/UI/schema files.

- [ ] Add static checks for scoped queries, assignment snapshots, event model, manager endpoints, employee self-only endpoint, summary/report endpoints, and no product-level Store Scan branding.
- [ ] Run checks and fix only demonstrated gaps.
- [ ] Re-run until green.
- [ ] Commit `test: add Continuixai Ops workflow integrity checks`.

### Task 2: Full verification attempt

**Files:** none unless verified failures require fixes.

- [ ] Run `npm test`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run build`.
- [ ] Run project migration/integrity scripts from CI.
- [ ] For every failure, distinguish environment/dependency failure from product failure; use systematic debugging before changing code.
- [ ] Re-run fixed product failures.

### Task 3: Claude adversarial review package

**Files:**
- Replace/update: `docs/CLAUDE-COMPLETE-REVIEW-BRIEF.md`
- Create: `docs/CLAUDE-READY-HANDOFF.md`

- [ ] Update terminology to Continuixai Ops and Store Scan-as-workflow.
- [ ] Require review of employee, manager, reporting, task events/snapshots, PHI warning, tenant isolation, and the unchanged counting core.
- [ ] Record exact verification commands and results, including anything blocked by environment.
- [ ] Produce a clean archive for Claude review.
- [ ] Commit `docs: prepare Claude adversarial review handoff`.
