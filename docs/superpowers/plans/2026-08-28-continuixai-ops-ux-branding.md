# Continuixai Ops UX and Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the employee and manager UI, sign-out summary, and complete Continuixai Ops application branding.

**Architecture:** Add focused My Work, Team Work, and Daily Summary pages that consume task APIs. Make My Work the authenticated home and keep inventory counting as an operational tool. Update user-visible app branding without changing compatibility-sensitive persistence/protocol identifiers unless safe.

**Tech Stack:** Next.js 16, React 19, TypeScript, CSS, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-28-continuixai-ops-completion-design.md`

## Global Constraints

- Company: Continuixai.
- Application: Continuixai Ops.
- legacy scan task may appear only as the name of an operational task/workflow.
- Employee UX is phone-first; manager UX responsive across phone/tablet/desktop.
- Sign-out summary is informational and never silently changes task status.
- Pharmacy task-note UI warns against entering PHI.

---

### Task 1: Shared task presentation model

**Files:**
- Modify: `apps/web/lib/types.ts`
- Create: `apps/web/lib/taskPresentation.test.ts`
- Create: `apps/web/lib/taskPresentation.ts`

**Interfaces:**
- Produces task grouping, priority ordering, site-local greeting, date labels, and manager-role helpers.

- [ ] Write failing pure tests for greeting boundaries and task grouping/order.
- [ ] Verify RED.
- [ ] Implement minimal presentation helpers and types.
- [ ] Verify focused tests/syntax.
- [ ] Commit `feat: add work presentation model`.

### Task 2: My Work and Daily Summary

**Files:**
- Create: `apps/web/app/my-work/page.tsx`
- Create: `apps/web/app/daily-summary/page.tsx`
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/components/BottomNav.tsx`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Consumes employee task APIs and daily summary.

- [ ] Add failing source contract test for `/my-work`, `/daily-summary`, legacy scan task task shortcut, note/status controls, and PHI warning.
- [ ] Verify RED.
- [ ] Implement My Work and Daily Summary with loading/error/empty states and touch-friendly controls.
- [ ] Make `/` redirect to `/my-work`.
- [ ] Verify source contract and syntax.
- [ ] Commit `feat: add employee my work and daily summary`.

### Task 3: Team Work manager UI

**Files:**
- Create: `apps/web/app/team-work/page.tsx`
- Modify: `apps/web/components/BottomNav.tsx`
- Modify: `apps/web/app/users/page.tsx`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Consumes manager task APIs.

- [ ] Add failing source contract tests for templates, employee job titles, one-time assignment, team status, history, reopen/skip/cancel, and report export.
- [ ] Verify RED.
- [ ] Implement responsive Team Work UI and link job-title management into team workflow.
- [ ] Verify source contract and syntax.
- [ ] Commit `feat: add team work manager workspace`.

### Task 4: Continuixai Ops branding

**Files:**
- Modify user-visible metadata/copy in `apps/web/app/**`, `apps/web/components/**`, `apps/web/public/sw.js`, API notification/MFA issuer copy, docs, deployment descriptors where product names are visible.
- Create: `scripts/verify-continuixai-branding.cjs`

**Interfaces:**
- Produces a source scan that fails if prohibited application-level branding remains outside an explicit legacy compatibility allowlist or legacy scan task workflow references.

- [ ] Write branding verifier and confirm it fails on current legacy scan task application branding.
- [ ] Replace application-level branding with Continuixai Ops and company references with Continuixai.
- [ ] Keep legacy scan task only where it refers to the task/workflow or legacy route compatibility.
- [ ] Run branding verifier to green.
- [ ] Commit `brand: adopt Continuixai Ops product identity`.
