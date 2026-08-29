# Continuixai Ops — Claude Round 2 Handoff

## Mission

This archive is the remediation build produced after Claude Round 1 returned **CONDITIONAL GO**. Do not trust this handoff as proof. Re-run the full adversarial review and attempt to invalidate every claimed fix.

Review the archive's current `HEAD` (`git rev-parse HEAD`) rather than relying on a commit hash copied into this document.

Read in this order:

1. `docs/CLAUDE-ROUND1-ADVERSARIAL-REVIEW.md`
2. `docs/CLAUDE-COMPLETE-REVIEW-BRIEF.md`
3. this file

## Round 1 findings and claimed remediation

### F-01 / F-02 — production deployment blueprint

Claimed fix:
- `render.yaml` now declares a generated `MFA_ENCRYPTION_KEY` independently from `JWT_SECRET`.
- both Render services are pinned to `continuixai-ops-completion`, the reviewed release branch.
- Docker/Postgres defaults use Continuixai Ops identifiers.

Attack it:
- confirm the API can satisfy `assertMfaEncryptionConfig()` in production;
- confirm both services deploy the same reviewed branch;
- inspect every deployment descriptor, not only Render.

### F-03 — inherited non-pilot application surface

Claimed fix:
- runtime/storage/deployment identifiers were rebranded to Continuixai Ops;
- the old web route `/store-scan` was removed;
- non-pilot inherited API routes and background jobs are disabled by default and require `ENABLE_LEGACY_INVENTORY_FEATURES=true`;
- direct navigation to inherited web pages redirects to `/my-work` via `apps/web/proxy.ts`;
- the old unrelated roadmap was replaced with the Continuixai Ops pilot-scope roadmap;
- the branding gate now scans app code, packages, scripts, docs, CI, README, env and deployment files for inherited identifiers.

Attack it:
- prove whether any disabled legacy route is still reachable with the default environment;
- inspect import-time side effects;
- verify the web proxy actually runs under this Next.js version;
- look for user-visible inherited features or identifiers missed by the gate.

### F-04 — one-time assignment duplicate retry

Claimed fix:
- `TaskAssignment.idempotencyKey` is nullable with a tenant-scoped unique constraint on `(organizationId, idempotencyKey)` in migration `20260907000000_task_assignment_idempotency`;
- one-time assignment POST requires a stable client idempotency key;
- the Team Work client preserves that key across failed/retried submissions and resets it only after success;
- the API returns the existing assignment for an identical retry and rejects key reuse for different work;
- concurrent unique-key races converge on the winner rather than creating a second event/assignment.

Attack it concurrently and verify exactly one assignment and one CREATED event survive. Also try reusing the same idempotency key from two different organizations; one tenant must not reserve or interfere with another tenant's key.

### F-05 — unsynced Count loss on logout/401

Claimed fix:
- auth invalidation no longer clears the Count queue;
- explicit logout/logout-all warns when unsynced Count scans remain and allows the user to cancel sign-out;
- a 401 warns that unsynced work remains on-device and preserves the queue for the next sign-in;
- the queue storage key is now `continuixai_count_queue`; the pre-rebrand queue key is migrated once so existing unsynced work is not stranded;
- every queued scan is bound to `ownerUserId`; replay is filtered to the currently authenticated user; ownerless legacy queue entries fail closed for manual reconciliation rather than auto-syncing.

Attack explicit logout, logout-all, token expiry, remote revocation, refresh, offline/reconnect and account switching. Verify preserving the queue does not allow one employee's queued scans to be silently attributed to a different employee.

### F-06 — site isolation

Claimed fix:
- new `SiteMembership` join model and migration `20260908000000_site_membership`;
- single-site organizations are safely backfilled; existing multi-site organizations are not guessed/backfilled;
- site resolution prefers active site membership and remains fail-closed if multiple sites are assigned without a selector;
- manager employee listing, one-time assignment, and reassignment validate active membership in the current site.

Attack same-organization cross-site employee discovery and assignment. Pay special attention to migration/backfill behavior and newly-created employees.

### F-07 — skipped work invisible to employee

Claimed fix:
- My Work groups SKIPPED work in a dedicated read-only `Skipped today` section;
- Daily Summary returns and renders skipped work for the requested site-local date;
- employees still cannot mutate skipped assignments.

### F-08 — UTC manager date seed

Claimed fix:
- Team Work no longer derives initial dates from `new Date().toISOString()`;
- date controls begin blank/disabled and are initialized from `/api/tasks/team`'s server/site-local `date`;
- report fetch without an anchor lets the server choose the site-local date.

Attack slow/failing first requests around UTC/local midnight boundaries.

### F-09 — missing manager reassignment UI

Claimed fix:
- each non-completed Team Work assignment now has an employee selector that invokes the existing audited reassignment endpoint;
- completed work requires reopening before reassignment.

### F-10 — nonportable pure verification scripts

Claimed fix:
- all five scripts resolve TypeScript with `require('typescript')`; no absolute `/opt/nvm/...` path remains.

Run them from a clean checkout after `npm ci`.

### F-11 — manager navigation heuristic

Claimed fix:
- Team nav visibility now uses only `isAdmin || user.taskManager === true`; job-title strings no longer grant UI manager affordances.

## Additional hardening added during remediation

- Removed the old `/store-scan` page. `Store Scan` may exist only as the title of an assignable daily task; the actual capability and navigation label are **Count**.
- Simplified `/settings` to account/preferences/security/session controls so disabled legacy backup/integration features are not exposed from the supported UI.
- Reduced the service worker to the supported Continuixai Ops shell; it no longer caches the inherited item API.
- `Store Scan` task detection still recognizes that specific task title but its action button always says `Start Count`.

## Required Round 2 gates

A **GO** is prohibited unless all of these run against this exact archive/HEAD:

```bash
npm ci
npm run prisma:generate
npm test
npm run lint
npm run build
node scripts/test-task-workflow-pure.cjs
node scripts/test-task-schedule-pure.cjs
node scripts/test-task-presentation-pure.cjs
node scripts/test-starter-task-catalog.cjs
node scripts/verify-task-route-contract.cjs
node scripts/verify-work-ui-contract.cjs
node scripts/verify-continuixai-branding.cjs
node scripts/verify-continuixai-readiness.cjs
node scripts/verify-claude-round1-remediation.cjs
node scripts/transpile-check.cjs
git diff --check
```

Also validate Prisma migrations against a real PostgreSQL database, including the new tenant-scoped idempotency unique index and SiteMembership backfill. For existing multi-site organizations, confirm the migration does not guess site assignments and the application stays fail-closed until explicit SiteMembership rows exist.

## Verdict format

Return exactly one overall verdict: **GO**, **CONDITIONAL GO**, or **NO-GO**.

Separately verdict:
- TENANT ISOLATION
- NO-LOSS / NO-DUPLICATE
- DEPLOYMENT READINESS
- MOBILE/HANDHELD READINESS

For every remaining finding include severity, file/line, reproduction, consequence, correction and regression test. Do not silently fix anything on this pass.
