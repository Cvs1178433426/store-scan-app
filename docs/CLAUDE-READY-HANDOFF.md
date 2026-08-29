# Continuixai Ops — Claude Ready Handoff

## Review target

This handoff is for an independent adversarial review of **Continuixai Ops**, developed by **Continuixai**.

- Application identity: **Continuixai Ops**
- Employee workspace: **My Work**
- Manager workspace: **Team Work**
- Inventory counting capability: **Count**
- `Store Scan` is permitted only as the name of an assignable operational task. It must not appear as product, navigation, report, or counting-tool branding.
- Working branch used for this package: `continuixai-ops-completion`
- Base archive lineage: `chatgpt-development`

Claude must read `docs/CLAUDE-COMPLETE-REVIEW-BRIEF.md` first and treat it as the review contract.

## What was implemented

The completion branch adds the role-based operational work system through the employee, manager, reporting, and audit layers while preserving the existing count subsystem.

The branch includes:

- assignment snapshots that preserve job title, recurrence, rollover policy, title, instructions, priority, site, assignee, scheduled date, and due timestamp;
- append-only task assignment events, including reassignment before/after assignee IDs;
- employee self-service task endpoints scoped to authenticated employee + organization + site;
- optimistic concurrency guards on employee updates, manager updates, and stale-task auto-skip;
- manager-scoped employee, template, assignment, status/history, reporting, and CSV endpoints;
- proactive recurring-task materialization for Team Work;
- six role-based starter libraries with 82 starter templates;
- phone-first My Work and Daily Summary experiences;
- responsive Team Work management UI;
- site-local greeting, grouping, daily boundaries, reports, and due-time conversion;
- DST spring-forward protection for nonexistent wall-clock due times;
- pharmacy task-note warnings against entering PHI;
- Continuixai Ops product branding across the app, with Count as the counting capability;
- a case-insensitive branding gate so legacy product branding cannot reappear accidentally;
- manager navigation based on actual active organization manager membership rather than job title alone.

## Fresh verification completed in this environment

The following commands were executed successfully against the final source tree before packaging:

```text
node scripts/test-task-workflow-pure.cjs
  PASS — task workflow pure tests passed

node scripts/test-task-schedule-pure.cjs
  PASS — task schedule pure tests passed

node scripts/test-task-presentation-pure.cjs
  PASS — task presentation pure tests passed

node scripts/test-starter-task-catalog.cjs
  PASS — starter task catalog passed (82 templates)

node scripts/verify-task-route-contract.cjs
  PASS — task route contract passed

node scripts/verify-work-ui-contract.cjs
  PASS — work UI contract passed

node scripts/verify-continuixai-branding.cjs
  PASS — Continuixai Ops branding verification passed

node scripts/verify-continuixai-readiness.cjs
  PASS — Continuixai Ops readiness source contracts passed

node scripts/transpile-check.cjs
  PASS — transpile syntax check passed (166 TypeScript files)

git diff --check
  PASS — no whitespace errors
```

## Dependency-backed gates not executable here

The container's npm dependency tree is incomplete and DNS cannot resolve `registry.npmjs.org`. These failures were traced to the environment, not represented as product passes.

Fresh attempts produced:

```text
npm test
  BLOCKED — TypeScript cannot find installed type-definition packages because node_modules is incomplete.

npm run lint
  BLOCKED — eslint executable is not installed in the incomplete node_modules tree.

npm run build
  BLOCKED — same incomplete TypeScript dependency/type tree as npm test.

npm run prisma:generate
  BLOCKED — prisma executable is not installed in the incomplete node_modules tree.
```

Claude/CI must therefore begin in a clean network-enabled checkout with:

```bash
npm ci
npm run prisma:generate
npm test
npm run lint
npm run build
```

A **GO** verdict is prohibited unless those dependency-backed gates are green.

## Highest-risk areas Claude should attack first

1. Cross-tenant and cross-site access through guessed task, template, employee, count, product, location, and report IDs.
2. Employee attempts to reach Team Work and manager-only mutations.
3. Concurrent recurring assignment materialization and starter-library installation.
4. Employee completion racing manager cancel/reopen/reassign.
5. Stale `SKIP` rollover racing another task update.
6. Template edits after assignment materialization; historical snapshots must remain unchanged.
7. Direct UPDATE/DELETE attempts against `TaskAssignmentEvent` in PostgreSQL.
8. DST, month-end, leap-year, local-midnight, and UTC-crossing completion/report scenarios.
9. Offline/retry duplicate/loss scenarios in Count.
10. Narrow-phone employee workflow and responsive manager workflow.
11. Pharmacy note surfaces and accidental PHI encouragement/storage.
12. Any visible occurrence of the old product identity outside the permitted assignable task wording.

## Required verdict

Claude should return exactly one of:

- **GO** — all required gates green and no pilot-stopping defects found;
- **CONDITIONAL GO** — no critical isolation/data-loss defect, but important remediation remains;
- **NO-GO** — any tenant leak, privilege bypass, data loss/duplication, migration failure, incorrect local-day behavior, broken critical mobile flow, or non-green required test/build gate.

Do not infer readiness from static checks. Try to break it.
