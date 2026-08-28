# Continuixai Ops Completion Design

## Product identity

- Company: **Continuixai**.
- Application: **Continuixai Ops**.
- `legacy scan task` is not the application name. It is one operational workflow/task inside Continuixai Ops.
- Existing `/store-scan` and `/store-count` route paths may remain for backward compatibility, but application titles, navigation, login/recovery copy, PWA metadata, notifications, docs, and new code must identify the product as Continuixai Ops.
- Legacy persistence keys or protocol headers may remain where renaming would break deployed clients; they must not be presented as product branding.

## Goal

Complete the role-based work system documented in `docs/ROLE-BASED-TASKS.md` through employee workflow, manager workflow, sign-out summary/reporting, and adversarial review readiness while preserving the existing inventory counting core.

## Architecture

### Employee workspace

The authenticated landing page becomes **My Work**. It uses site-local time for the greeting and daily boundary. It shows overdue, today, this week, and completed-today groups; priority and due time; instructions; employee notes; and task status controls. A Count shortcut appears only when relevant counting work is assigned, while the counting engine remains an independent subsystem.

### Manager workspace

Authorized organization/site OWNER, ADMIN, or MANAGER members and platform ADMIN users receive **Team Work**. The manager API exposes scoped employees, templates, one-time assignments, status/history views, and controlled task actions. Every route re-derives organization/site scope from the authenticated user; client-supplied tenant identifiers are not trusted.

### Task history and snapshots

Assignments preserve the operational facts that were true when materialized: job title, recurrence, rollover policy, title, instructions, priority, scheduled date, and due timestamp. Template edits do not rewrite assignment history. Assignment status changes are recorded in an append-only event table with actor and timestamps.

### Recurrence and rollover

Recurring assignment creation remains idempotent. Site timezone determines the scheduled day and due timestamp. Monthly dates beyond the last day of a month run on the last day. Historical OPEN/IN_PROGRESS assignments remain visible. `SKIP` policy may automatically mark stale assignments skipped with an audit event; `REMAIN_OVERDUE` stays overdue. `ROLL_FORWARD` remains open and is surfaced in the current work queue without mutating its original scheduled date, preserving audit truth.

### Daily summary and reports

A server-generated daily summary uses the authorized site's timezone. It includes tasks completed/open/overdue, next task, completed count sessions, locations counted, unique products/barcodes, total units, and count duration. Manager reporting supports daily/weekly/monthly date ranges and CSV export. Sign-out never modifies work state.

### Pharmacy privacy

Pharmacy task surfaces display a warning not to enter patient names, prescriptions, diagnoses, DOBs, or other PHI in task notes. Notes are operational only.

## Error handling and security

- Employee task reads/updates are always constrained to `assignedToId = authenticated user` plus authorized organization/site.
- Manager reads/writes are constrained to the manager's derived organization/site.
- Completed employee tasks cannot be reopened by employees.
- Managers may reopen, skip, cancel, or reassign only within scope; all such actions create events.
- Cross-tenant IDs return 404 or 403 without exposing foreign tenant details.
- Task notes are length limited and rendered as React text, not HTML.
- Report exports are generated from scoped server queries, never client-filtered global data.

## Responsive UX

- Employee experience is phone-first, with touch targets at least 44px and a simple bottom navigation.
- Manager pages are responsive on phone, tablet, and desktop; denser tables collapse into cards on narrow screens.
- Existing inventory count UI remains available and is linked as an operational tool.

## Testing

- Pure date/time/report presentation logic receives unit coverage.
- Route tests cover self-only access, manager scope, snapshot preservation, idempotency, reopening/cancel/skip, PHI warning behavior where applicable, and summary calculations.
- Frontend tests cover task grouping, site-local greeting, and label/route contracts.
- Final gates: API tests, web tests, lint, production build, migration validation, tenant-integrity scripts, and a source-level scan confirming no application-level legacy scan task branding remains.
- Because the present container cannot reach npm registry, unavailable dependency-backed verification is explicitly deferred until run in a network-enabled GitHub/Codex/CI environment; it must not be represented as passing.

## Claude adversarial review target

Claude receives the exact final branch/commit and a revised brief instructing it to attack tenant boundaries, privilege escalation, recurrence duplication, DST/month-end behavior, event auditability, completed-history immutability, race conditions, Store Count no-loss/no-duplicate guarantees, offline retry behavior, report correctness, PHI exposure risks, mobile usability, and stale branding.
