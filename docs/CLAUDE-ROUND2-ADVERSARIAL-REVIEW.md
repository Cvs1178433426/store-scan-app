# Continuixai Ops — Round 2 Independent Adversarial Review

**Review target:** commit `da83f87ead0e56cb43d5c80d46c8b932ce861b50`, branch `continuixai-ops-completion`, confirmed via `git rev-parse HEAD` against the extracted, checksum-verified archive (`continuixai-ops-claude-round2-da83f87.zip`, sha256 `c8b3cb92c4cb7b5043cb027a595209068a8efdce81784c8748d364f1b34b554d`, matched exactly).

**Method:** Round 1's own findings and the Round 2 handoff's claimed remediations were treated as unverified assertions, not evidence. Every claim below was independently re-derived from source, and where possible backed by *execution* rather than reading: I ran all nine dependency-light verification scripts myself (not trusted from the handoff's self-report), and — new this round — stood up a real PostgreSQL 16 instance and applied all 27 migrations against fresh and seeded databases, including live concurrent-transaction races against the new unique constraint, to verify claims that cannot be trusted from source reading alone. I also used live web search against Next.js's own documentation to verify one claim (the `proxy.ts` convention) rather than assume it from training data, since the review brief explicitly demanded that check. I could not obtain a network-enabled Node 24 environment in this sandbox; that gap is reported honestly in §7, not glossed over.

---

## 1. Overall verdict

# **CONDITIONAL GO**

Every one of Round 1's eleven findings (F-01 through F-11) has genuine, verifiable remediation — not just claimed, but independently confirmed this round through direct code inspection, live execution of the dependency-light verification scripts, and, for the two highest-stakes data-integrity claims (idempotency and site isolation), through real PostgreSQL migration application and concurrent-transaction testing. Two new minor issues were found (§4), neither pilot-blocking.

**The verdict is CONDITIONAL GO, not GO, for one specific and explicit reason:** the dependency-backed gates (`npm ci`, `npm run prisma:generate`, `npm test`, `npm run lint`, `npm run build`) still could not be executed in this environment — the same sandbox network restriction that blocked Round 1 blocks Round 2 (confirmed fresh, see §7). The Round 2 handoff document itself states this rule in its own words: *"A GO is prohibited unless all of these run against this exact archive/HEAD."* That is not a defect I found in the application; it is a verification step that has still never been completed by anyone against this exact commit, in any environment on record. Per the user's own explicit instruction this round — *"A GO is prohibited if npm install, Prisma generation/migrations, tests, lint, or production builds do not run green"* — GO remains categorically unavailable until that gap is closed, regardless of how strong the rest of the evidence is.

This is a materially stronger CONDITIONAL GO than Round 1's: Round 1 had a confirmed reproducible defect (duplicate one-time tasks) and a confirmed broken deployment blueprint. Round 2 has neither — what remains is an execution gap, not a known defect.

### Separate guarantee verdicts (as required)

**TENANT ISOLATION** — *Substantially strengthened; no confirmed breach.* The Round 1 latent gap (organization-only membership, no site-level check) is now closed by a real `SiteMembership` model, verified three ways: by reading the authorization code (`ensurePilotSiteForUser`, and the three endpoints `GET /employees`, `POST /assignments`, `PATCH /assignments/:id` all now filter/validate against active `SiteMembership` rows, §5.1); by applying the actual migration against a live database seeded with single-site, multi-site, and edge-case (inactive-membership, inactive-site) organizations and confirming the backfill behaves exactly as claimed (§5.2); and by confirming the fail-closed behavior for multi-site users is preserved and now defended at more than one endpoint. The residual caveat: I still cannot run the live Fastify server (no `npm ci`), so this is code- and database-verified, not black-box HTTP-verified. I have high confidence in it, but "high confidence from static and DB evidence" is not the same as "observed under live attack," and I say so plainly rather than rounding up to an unconditional pass.

**NO-LOSS / NO-DUPLICATE** — *Fixed for one-time task creation, confirmed at the database layer under real concurrency.* I opened two genuinely concurrent PostgreSQL transactions attempting to insert the same `(organizationId, idempotencyKey)` pair and confirmed exactly one committed while the other received a clean unique-constraint violation — precisely the signal the application code's catch block (`tasks.ts:718-719`) is written to handle by returning the winner's row to the loser (§5.3). I also confirmed, live, that the identical literal idempotency-key string reused across two different organizations does not interfere — both inserts succeeded independently, satisfying the specific cross-tenant-key-reuse test the user asked for. Recurring-assignment idempotency (unchanged from Round 1, already sound) and the Count offline queue's per-employee ownership scoping (newly added, verified in §5.4) both hold up under code review. As with tenant isolation, this is DB- and code-verified, not live-HTTP-verified.

**DEPLOYMENT READINESS** — *Configuration-level defects are fixed and verified; overall readiness cannot yet be certified.* `render.yaml` now declares a generated `MFA_ENCRYPTION_KEY` distinct from `JWT_SECRET` and both services correctly target `continuixai-ops-completion` (§5.5); `docker-compose.yml`/`docker-compose.prod.yml` use `continuixai_ops`/`continuixai-ops-*` identifiers throughout; the legacy inventory surface is gated behind `ENABLE_LEGACY_INVENTORY_FEATURES` at the route-registration level in `index.ts`, confirmed by direct code read (§5.6). But deployment readiness as a whole still cannot be certified without the dependency-backed build actually succeeding somewhere, and this round surfaced an additional environment-matching risk: `@zxing/library@0.23.0` (used by the Count barcode scanner) declares `engines.node >= 24.0.0`, while every Node runtime available anywhere in this sandbox — and the one this repository's own `.env`/CI expectations imply — tops out at 22 here; the handoff document itself now flags this same mismatch. That is a real thing for whoever runs the required gates to get right, not a sandbox artifact.

**MOBILE/HANDHELD READINESS** — *Improved and verified at the code level; not independently confirmed live.* The Count offline queue now preserves unsynced work through logout, logout-all, and 401/token-expiry, warns the user with an explicit count and lets them cancel sign-out, and correctly scopes replay to the currently authenticated employee only — verified by reading `auth-context.tsx`, `storeCountQueue.ts`, and `store-count/page.tsx` together and confirming every read/write path is consistent (§5.4). SKIPPED tasks are now visible to the employee in a dedicated read-only "Skipped today" section on My Work and in the Daily Summary window (§5.7). As in Round 1, I had no live device, browser, or running server available to exercise these flows end-to-end; this assessment is code-verified, not observed.

---

## 2. Re-test of every Round 1 finding

| # | Round 1 finding | Verdict this round | Evidence |
|---|---|---|---|
| F-01 | `render.yaml` crashes on boot (missing `MFA_ENCRYPTION_KEY`) | **Fixed.** | `render.yaml` now lists `MFA_ENCRYPTION_KEY` with `generateValue: true` in the API service's `envVars`, alongside `JWT_SECRET` with the same generation strategy (independently generated, so they cannot collide). Read in full this round. |
| F-02 | `render.yaml` deploys the wrong branch | **Fixed.** | Both service blocks now read `branch: continuixai-ops-completion`, matching the actual working branch and this review's own `git branch -a` output. |
| F-03 | Undisclosed inherited "Stash" surface, mismatched deployment identifiers | **Fixed.** | `docker-compose.yml`/`docker-compose.prod.yml` now default to `continuixai_ops`/`continuixai-ops-api`/`continuixai-ops-web` throughout (read in full). `docs/ROADMAP.md` — previously an entirely unrelated household-inventory roadmap — is replaced with a genuine Continuixai Ops pilot-scope document that explicitly discloses the legacy surface and its gating (read in full, quoted in §5.6). The branding gate's scan scope was widened to `docs/`, `.github/`, and named root config files including `docker-compose*.yml` and `render.yaml`, and now also flags the bare token `stash` in addition to `@stash/` and the phrase "store scan" — I ran this script myself against the live tree and it passed (§6). |
| F-04 | One-time task creation has no idempotency protection | **Fixed, verified under real concurrency.** | See §5.3. Required idempotency key, tenant-scoped unique constraint, pre-check + catch-on-conflict pattern, client-side key persistence across retries — all read in full and independently confirmed against a live PostgreSQL database, including a genuine two-transaction race. |
| F-05 | Offline Count queue silently discarded on logout/401 | **Fixed.** | See §5.4. `auth-context.tsx`'s logout/logout-all/401 paths no longer touch the Count queue at all; explicit `window.confirm`/`window.alert` warnings with accurate unsynced counts were added; ownership (`ownerUserId`) is bound at scan time and every read path is filtered to the current user. |
| F-06 | Cross-site isolation rests on one helper with no defense-in-depth | **Fixed, verified against a live database.** | See §5.1–§5.2. Real `SiteMembership` model, correct fail-closed multi-site behavior preserved and now independently enforced at three endpoints, migration backfill behavior verified against seeded single-site/multi-site/edge-case data. |
| F-07 | SKIPPED tasks invisible to the employee | **Fixed.** | See §5.7. Dedicated "Skipped today" section on My Work; server-side `GET /me` and `GET /me/summary` both now include SKIPPED assignments scoped to the requested local day; employees still cannot mutate them (409 preserved). |
| F-08 | Manager forms seed initial date from browser UTC | **Fixed.** | `oneTimeDate`, `anchor`, and the new-template `startDate` all now initialize to `""` and are set exactly once, from the server's site-local `date` field in the first successful `/api/tasks/team` response — read in full, no `todayKey()`/browser-`Date` seeding remains anywhere in the file. |
| F-09 | No reassignment control in Team Work UI | **Fixed.** | An employee `<select>` bound to `assignedToId` now exists on every non-completed assignment row, invoking the same audited reassignment endpoint; it is disabled for `COMPLETED` assignments, matching the claim that completed work must be reopened before reassignment. |
| F-10 | Nonportable "pure" verification scripts (hardcoded absolute path) | **Fixed, executed myself.** | All five previously-broken scripts now use plain `require('typescript')`; I ran all nine required scripts plus `verify-claude-round1-remediation.cjs` and `git diff --check` directly in this sandbox and every one passed on the first try, with no symlink workaround needed this time (§6). |
| F-11 | Manager-nav visibility used a job-title heuristic | **Fixed.** | `BottomNav.tsx`'s `likelyManager` is now exactly `isAdmin || user?.taskManager === true` — the job-title fallback is gone. |

---

## 3. Verification of the user's specific Round 2 attack requests

1. **Two sites inside the same organization** — tested live against PostgreSQL with a synthetic `multi_org` (two active sites, two distinct employees) seeded *before* the `SiteMembership` migration ran. After migration, neither employee received a `SiteMembership` row (§5.2) — the app's `ensurePilotSiteForUser` therefore still returns `null` (403) for both until an explicit membership is created, exactly as designed.
2. **One-time task idempotency under retries, double-clicks, and concurrent requests** — code-verified (client key persistence, server pre-check-then-catch pattern) and live-DB-verified under a genuine two-transaction race (§5.3); exactly one row survived.
3. **Same idempotency key reused across two different organizations** — live-DB-verified: identical literal key text inserted for `org1` and `org2` both succeeded independently with no interference, because the unique constraint is `(organizationId, idempotencyKey)`, not `(idempotencyKey)` alone (§5.3).
4. **Count queue behavior across logout, 401, expired JWT, remote logout-all, offline/reconnect, account switching on a shared device** — code-verified end-to-end across `auth-context.tsx`, `storeCountQueue.ts`, and `store-count/page.tsx` (§5.4). Every code path that clears authentication state was checked and none clears the queue; every code path that reads the queue for sync/display was checked and all are scoped by `ownerUserId`.
5. **One employee replaying another employee's queued Count scans** — not possible per the code: `flushQueue()` calls `getPendingCountQueue(user.id)`, and the queue's own `ownerUserId` is fixed at enqueue time from the scanning user's own session, never re-derived at replay time. Verified by reading every call site of `getPendingCountQueue`/`getFailedCountQueue`/`getCountQueue` in the Count feature and confirming none omits the owner filter during actual replay (§5.4).
6. **Pre-rebrand queued scans preserved but not auto-attributed to a different employee** — `storeCountQueue.ts` migrates the legacy `store_scan_count_queue` localStorage key into `continuixai_count_queue` once, on first read, preserving the data (§5.4). Critically, any entry lacking `ownerUserId` (i.e., queued before this field existed) is force-normalized to `ownerUserId: "unattributed"` and `status: "failed"` with an explicit reconciliation message — it is *never* silently synced under whichever employee happens to be logged in next. This is a genuinely careful piece of engineering and I verified it by reading `normalizeQueuedScan()` directly, line by line.
7. **SiteMembership migration and multi-site fail-closed behavior** — see §5.2; live-tested against seeded pre-migration data.
8. **Manager reassignment** — present and functional per code read; see F-09 above.
9. **SKIPPED-task visibility** — see F-07 above.
10. **Site-local date behavior around UTC midnight and DST boundaries** — the underlying date/DST math (`taskSchedule.ts`) is unchanged from the version verified in Round 1 (confirmed by its absence from anything I found different this round); I re-ran `test-task-schedule-pure.cjs` myself and it passed. The one Round 1 defect in this area (manager-form UTC seeding) is fixed per F-08 above.
11. **Disabled inherited legacy application surface reachability** — see §5.6. I could not send live HTTP requests (no running server), so this is a code-level confirmation that the registration is conditional on `ENABLE_LEGACY_INVENTORY_FEATURES === "true"` with no other code path registering those routes, not an observed 404. I also checked the Next.js `proxy.ts` redirect list against the actual `apps/web/app/` directory tree and found one small gap — see §4, Finding N-02.
12. **Continuixai / Continuixai Ops branding, Store Scan only as a task name** — verified; `countTaskActionLabel()` now unconditionally returns `"Start Count"` regardless of task title, and the branding gate (which I ran myself) passed against the full widened scope including `docs/`, `.github/`, and deployment config files.
13. **Render, Docker, CI, production deployment configuration** — see F-01/F-02/F-03 above and §5.5–§5.6. I did not have access to actually trigger a GitHub Actions CI run for `.github/workflows/`, so that file was read for correctness (references Node 24, matching the package requirement) but not executed.

---

## 4. New findings this round

### N-01 — LOW — `CLEAR_USER_DATA` service-worker message has no listener; it is dead code

**Files:** `apps/web/lib/auth-context.tsx` (posts the message on both the 401 path and explicit logout), `apps/web/public/sw.js` (no `message` event listener anywhere in the file)
**What's wrong:** `auth-context.tsx` calls `navigator.serviceWorker.controller?.postMessage({ type: "CLEAR_USER_DATA" })` on logout and on 401-triggered invalidation, clearly intending for the service worker to purge any cached per-user data. But `sw.js` — read in full, 66 lines — registers `install`, `activate`, `fetch`, `push`, and `notificationclick` listeners only. There is no `self.addEventListener("message", ...)` anywhere. The `postMessage` call is a complete no-op.
**How discovered:** grepped `sw.js` for `CLEAR_USER_DATA` and for any `message` listener while verifying the brief's explicit requirement ("verify user-specific cached API data is cleared on logout"); found the call site but no receiver.
**Why it's not currently a data-integrity bug:** the service worker's `fetch` handler explicitly excludes anything matching `/api/` from caching (`if (request.url.includes("/api/")) return;`), and both `my-work/page.tsx` and `team-work/page.tsx` are `"use client"` components with no server-embedded per-user data in their cached shell HTML — so there is currently no per-user cached data for this message to need to clear. The call is harmless today, not silently dangerous.
**Consequence:** it is misleading dead code that creates the appearance of a safeguard that does not exist. If the service worker is ever extended to cache API responses or server-rendered per-user content (a realistic future direction for a PWA that wants better offline support), this broken wiring would silently fail to protect against stale or cross-user data exposure on a shared handheld device, and nobody would notice — a `postMessage` to a service worker with no listener doesn't throw or log anything.
**Fix:** either add a `message` listener to `sw.js` that actually clears any per-user cache entries, or remove the dead `postMessage` calls from `auth-context.tsx` until there is something for them to do, so the code doesn't imply a protection that isn't real.
**Regression test:** a test that registers a mock service worker, triggers logout, and asserts either that a `message` listener exists and responds, or (if the calls are removed) that no `postMessage` is attempted.

### N-02 — LOW — `/i/[id]` legacy deep-link page is not in the proxy redirect list (double-redirects, does not leak data)

**Files:** `apps/web/app/i/[id]/page.tsx`, `apps/web/proxy.ts`
**What's wrong:** `apps/web/app/i/[id]/page.tsx` is a server component that unconditionally issues `redirect(`/items/${id}`)` — this is the short deep-link target for physically printed QR labels from the inherited household-inventory product. It is not included in `proxy.ts`'s `LEGACY_PATHS` array, so `proxy.ts` lets a request to `/i/<id>` pass through to this page, which then issues its own redirect to `/items/<id>` — a path that *is* in `LEGACY_PATHS` and gets redirected to `/my-work` on the resulting second request.
**How discovered:** enumerated every directory under `apps/web/app/` and cross-referenced against `proxy.ts`'s `LEGACY_PATHS`; `i/[id]` was the one route present in the app tree but absent from the list.
**Consequence:** not a security or data-exposure issue — the final destination (`/items/<id>`) is still caught and redirected to `/my-work` on the second hop, so no gated legacy page is ever actually rendered. It is a UX/product artifact: anyone scanning a physical `/i/<id>` label printed under the prior product identity will now bounce through two redirects and land on My Work with zero explanation of what happened to the label they scanned, rather than a single clean redirect.
**Fix:** either add `/i` to `LEGACY_PATHS` directly (skip the pointless double-hop), or, if these physical labels are expected to still resolve to something useful during a transition period, make `/i/[id]` redirect straight to `/my-work` (or a dedicated "this label is no longer supported" page) instead of bouncing through the now-gated `/items/:id`.
**Regression test:** a routing test asserting `/i/<any-id>` results in a single redirect to a defined destination, not a redirect chain.

---

## 5. Detailed verification evidence

### 5.1 Site-scoped authorization (F-06), code

`apps/api/src/routes/tasks.ts` now filters/validates against `SiteMembership` at every place Round 1 flagged:

- `GET /employees` (line 475): `where: { organizationId: ..., isActive: true, user: { isActive: true, siteMemberships: { some: { siteId: context.site.id, isActive: true } } } }`
- One-time assignment target check (lines 669–671): requires `siteMemberships: { where: { siteId: context.site.id, isActive: true }, take: 1 }` to be non-empty, else 404 "Active employee for this site not found."
- Reassignment target check (lines 748–750): identical pattern.

`apps/api/src/lib/pilotSite.ts` (`ensurePilotSiteForUser`, read in full) now resolves site scope primarily from real `SiteMembership` rows, self-heals a single-site org's missing membership row on the fly, and preserves fail-closed behavior (`return null`) the instant more than one active site is in play without an explicit membership row — for both the org-membership fallback path and the true `SiteMembership`-backed path.

### 5.2 SiteMembership migration, live PostgreSQL evidence

Applied `apps/api/prisma/migrations/20260907000000_task_assignment_idempotency` and `20260908000000_site_membership` to a database seeded to represent realistic pre-migration state:

- `single_org`: one active site, one active member → **backfilled** (`SiteMembership(userId=u_single_emp, siteId=s_single, isActive=true)`).
- `multi_org`: two active sites, two active members → **not backfilled at all** — zero `SiteMembership` rows for either user.
- `single_org` inactive member (`om_inactive`, `OrganizationMembership.isActive=false`) → backfilled but correctly carried over as `isActive=false`, not silently activated.
- `inactive_site_org`: one active site + one explicitly inactive site → correctly treated as effectively single-site; the member was backfilled to the *active* site only.

Query and full result set:

```sql
SELECT sm."userId", sm."siteId", s."organizationId", sm."isActive"
FROM "SiteMembership" sm JOIN "Site" s ON s.id = sm."siteId"
ORDER BY sm."userId";

      userId       |     siteId     |  organizationId   | isActive
-------------------+----------------+--------------------+----------
 u_inact_org_emp   | s_inact_active | inactive_site_org  | t
 u_inactive_member | s_single       | single_org         | f
 u_single_emp      | s_single       | single_org         | t
(3 rows)
```

`u_multi_emp1` and `u_multi_emp2` (the two `multi_org` members) do not appear at all — confirmed not guessed, exactly as the handoff claims.

All 27 migrations, applied in order to a completely fresh database, succeeded with no errors (brief §15 scenario 1). The append-only and tenant-scope enforcement triggers created by earlier migrations (`prevent_task_assignment_event_mutation`, `enforce_task_assignment_event_scope`, `validate_task_assignment_scope`, `validate_task_template_scope`) are still present and active on the resulting schema and were exercised directly (§5.3).

### 5.3 Idempotency, live PostgreSQL evidence

Schema confirmed: `TaskAssignment_organizationId_idempotencyKey_key` is a genuine unique btree index on `("organizationId", "idempotencyKey")`.

Direct SQL tests against a seeded database:

- Same org + same key, different content → **blocked**: `ERROR: duplicate key value violates unique constraint "TaskAssignment_organizationId_idempotencyKey_key"`.
- Same literal key text, different org (`org1` vs `org2`) → **both succeeded independently**, confirming no cross-tenant interference.
- Recurring-assignment uniqueness (`templateId, assignedToId, scheduledDate`) → duplicate plain insert blocked with the expected unique-violation error; an `ON CONFLICT ... DO NOTHING` insert (mirroring the app's `createMany({skipDuplicates:true})`) correctly no-ops, leaving exactly one row.
- Genuine concurrency: two background `psql` sessions, each wrapped in `BEGIN; SELECT pg_sleep(0.5); INSERT ...; COMMIT;` targeting the same `(organizationId, idempotencyKey)`, launched together. One committed (`INSERT 0 1` / `COMMIT`); the other received the unique-violation error at the `INSERT` statement. Exactly one row survived. This is the literal DB-level event the application's `catch (error) { if (error.code !== "P2002") throw; ... }` block (`tasks.ts:718-729`) is written to handle, and it behaves exactly as the code assumes.
- Application-level pre-check and reuse-rejection logic (`tasks.ts:660-730`, read in full): a retried request with an identical key *and* identical `assignedToId`/`title`/`scheduledDate`/site returns the existing row (200); a request reusing the key for genuinely different work returns 409 "Idempotency key was already used for different work." Both branches were read and reasoned through against the schema directly; the DB-level tests above confirm the substrate they depend on behaves correctly under real concurrency.
- Client-side key lifecycle (`team-work/page.tsx:195-217`): the key is generated once (`crypto.randomUUID()`), stored in a `useRef`, reused on any retry (the `catch` block leaves it intact), and reset to `null` only after a confirmed successful response — matching the claimed "preserve across retries, reset only on success" behavior exactly.

### 5.4 Count offline queue and auth invalidation

Two separate offline queues exist in this codebase and must not be confused:

- `apps/web/lib/scanQueue.ts` — used only by the legacy `/scan` page (the inherited household-inventory item-scan flow), which is now gated out of the pilot surface entirely via `proxy.ts`'s redirect to `/my-work`. This queue's `QueuedScan` type genuinely has no `ownerUserId` field — but since `/scan` is unreachable in the supported pilot configuration, this does not affect the pilot-scope Count workflow.
- `apps/web/lib/storeCountQueue.ts` — the actual Count feature's queue, used by `apps/web/app/store-count/page.tsx`. This is the one Round 1's F-05 and the user's Round 2 questions are actually about, and it is the one that matters for the pilot.

`storeCountQueue.ts`, read in full: every `QueuedCountScan` carries `ownerUserId`, set at `enqueueCountScan()` time from the actively authenticated user (`store-count/page.tsx:279`, `ownerUserId: user.id`). Every read used for sync/replay or display (`flushQueue()` at line 212, the pending-count badge at line 90, the failed-scan review list at line 91, the session-close check at line 352) passes `user.id` (or `user?.id`) as the owner filter — I grepped every call site of `getPendingCountQueue`/`getFailedCountQueue`/`getCountQueue` in the Count feature and confirmed none of the actual sync/replay paths omits it. Legacy (pre-ownership-field) entries are force-normalized in `normalizeQueuedScan()` to `ownerUserId: "unattributed"` and `status: "failed"`, which excludes them from any owner-filtered pending-queue read and therefore from auto-sync — they require explicit manual reconciliation rather than being silently attributed to whoever is currently logged in. The pre-rebrand storage key (`store_scan_count_queue`) is migrated once, non-destructively, into the new key (`continuixai_count_queue`) on first read.

`apps/web/lib/auth-context.tsx`, read in full: `logout()` and `logoutAll()` both compute `unsyncedCountForCurrentIdentity()` and, if nonzero, show a `window.confirm` the user can cancel; the 401 path in `fetchMe()` shows an informational `window.alert` with the same count and explicitly does not touch the queue. No code path in this file calls `clearCountQueue()`, `removeFromCountQueue()`, or otherwise mutates `storeCountQueue.ts`'s storage on any auth-invalidation path — the queue genuinely survives logout, logout-all, 401, and (implicitly, since nothing clears it) account switching on a shared device.

### 5.5 Deployment descriptors

`render.yaml`, `docker-compose.yml`, `docker-compose.prod.yml`, and `Caddyfile` all read in full this round; see F-01/F-02/F-03 above for specifics. All identifiers are consistently `continuixai-ops`/`continuixai_ops`; both Render services target the correct branch; the API service now declares `MFA_ENCRYPTION_KEY`.

### 5.6 Legacy surface gating

`apps/api/src/index.ts`, read in full: the pilot-scope routes (`auth`, `mfa`, `barcodes`, `lookup`, `products`, `storeLocations`, `storeCount`/`storeCountExport`, `tasks`, `attachments`) are registered unconditionally. Every inherited non-pilot route (`locations`, `categories`, `items`, `settings`, `backup`, `labels`, `movements`, `maintenance`, `push`, `audit`, `xp`, `insights`) — and, importantly, the three background jobs (`startExpiryNotificationJob`, `startTrashPurgeJob`, `startLowStockSummaryJob`) — are registered only inside `if (legacyInventoryFeaturesEnabled)`, where `legacyInventoryFeaturesEnabled = process.env.ENABLE_LEGACY_INVENTORY_FEATURES === "true"`. There is no other code path in this file, or in any route file, that registers these routes. Under the default environment (the variable unset), none of this surface exists in the running Fastify instance at all — not merely hidden by the frontend, but genuinely never registered.

`apps/web/proxy.ts`, read in full: a `NextRequest`-based redirect for the legacy page paths to `/my-work`. I verified via live web search against Next.js's own official upgrade documentation (nextjs.org/docs/app/guides/upgrading/version-16, fetched fresh this session, not from training-data recall) that Next.js 16 — the version this app pins (`"next": "^16.3.1"` in `apps/web/package.json`) — genuinely renamed `middleware.ts`/`export function middleware` to `proxy.ts`/`export function proxy`, exactly as implemented here, and that this is the correct, currently-supported convention (not a deprecated or not-yet-released one). This directly answers the brief's explicit instruction to "verify the web proxy actually runs under this Next.js version" rather than assume it.

`docs/ROADMAP.md`, read in full: entirely replaced. It now opens "Continuixai Ops is the operational-work platform developed by Continuixai. The controlled-pilot scope is intentionally narrower than the historical codebase it was derived from," lists the actual pilot-supported surface, and explicitly states the legacy household-inventory surface "is disabled by default at the API layer" and requires `ENABLE_LEGACY_INVENTORY_FEATURES=true` for migration/testing, "not supported for a retail pilot until separately reviewed." This is a genuine, substantive disclosure fix, not a cosmetic one.

### 5.7 SKIPPED task visibility

`apps/web/lib/taskPresentation.ts`'s `groupAssignments()` now buckets `status === "SKIPPED"` into a dedicated `skippedToday` array (previously silently dropped). `apps/web/app/my-work/page.tsx` renders a "Skipped today" `WorkSection` and shows a read-only "Skipped" badge with no note/action controls on those cards. Server-side, `GET /me` (`tasks.ts:390-396`) now includes `{ scheduledDate, status: "SKIPPED" }` in its `OR` clause scoped to the requested day, and `employeeDailySummary` (`tasks.ts:229-236`) independently queries `status: "SKIPPED", scheduledDate: date`. Employees still cannot mutate a SKIPPED assignment — `PATCH /:id` returns 409 for `status === "SKIPPED"` (unchanged, still correctly enforced at `tasks.ts:428`).

---

## 6. Build/test results — exact commands run this round

```
$ node --version
v22.22.2

$ npm ci
npm warn EBADENGINE Unsupported engine { package: '@zxing/library@0.23.0', required: { node: '>= 24.0.0' }, current: { node: 'v22.22.2', npm: '10.9.7' } }
npm error code E403
npm error 403 403 Forbidden - GET https://registry.npmjs.org/typescript/-/typescript-7.0.2.tgz

$ curl -sI --max-time 6 https://registry.npmjs.org      → 403 (x-deny-reason: host_not_allowed)
$ curl -sI --max-time 6 https://registry.npmmirror.com  → connection failed
$ curl -sI --max-time 6 https://cdn.jsdelivr.net        → connection failed
$ curl -sI --max-time 6 https://nodejs.org/dist/v24.0.0/ → 403
```

Same sandbox network-policy restriction as Round 1: `registry.npmjs.org` is explicitly excluded from this environment's outbound HTTP proxy (present in `NO_PROXY`) and denied directly at the host level; every other registry/CDN mirror tested is unreachable. Node 24 (required by `@zxing/library`) is not obtainable here either — only Node 22.16.0/22.22.2 are available anywhere in this sandbox, and no `nvm` binary exists to install another version, and `nodejs.org` itself is also blocked. No local install of `prisma`, `vitest`, `@prisma/client`, `zod`, or `fastify` exists anywhere in this environment, so `npm test`, `npm run build`, and `npm run prisma:generate` cannot be run in any form, faithful or partial, here — consistent with what the Round 2 handoff document itself now discloses rather than glosses over.

What I *did* execute, myself, fresh, against this exact tree — not trusted from the handoff's self-report:

```
$ node scripts/verify-task-route-contract.cjs        → task route contract passed
$ node scripts/verify-work-ui-contract.cjs           → work UI contract passed
$ node scripts/verify-continuixai-branding.cjs       → Continuixai Ops branding verification passed
$ node scripts/verify-continuixai-readiness.cjs      → Continuixai Ops readiness source contracts passed
$ node scripts/verify-claude-round1-remediation.cjs  → Claude Round 1 remediation source contracts passed
$ node scripts/test-task-workflow-pure.cjs           → task workflow pure tests passed
$ node scripts/test-task-schedule-pure.cjs           → task schedule pure tests passed
$ node scripts/test-task-presentation-pure.cjs       → task presentation pure tests passed
$ node scripts/test-starter-task-catalog.cjs         → starter task catalog passed (82 templates)
$ node scripts/transpile-check.cjs                   → transpile syntax check passed (165 TypeScript files)
$ git diff --check                                   → clean, exit 0
```

Every one of these passed on the **first attempt**, with no workaround needed this round (Round 1 required a sandbox-only symlink to unblock five of these; that hack is no longer necessary because F-10 is genuinely fixed — plain `require('typescript')` now resolves correctly wherever a TypeScript install is reachable via normal Node module resolution). This matches the Round 2 handoff's own self-reported results exactly, and I verified it independently rather than taking that match on faith.

Beyond what the handoff asked for, I additionally validated the Prisma migrations against a real PostgreSQL 16 instance — something neither the handoff nor Round 1 was able to do — covering: all 27 migrations against a fresh database; the new tenant-scoped `(organizationId, idempotencyKey)` unique constraint under both sequential and genuinely concurrent writes, including cross-organization key reuse; the `SiteMembership` backfill migration against seeded single-site, multi-site, and edge-case (inactive membership, inactive site) pre-existing data; the recurring-assignment uniqueness constraint including an `ON CONFLICT DO NOTHING` insert mirroring the app's actual `createMany({skipDuplicates:true})` call; and the append-only `TaskAssignmentEvent` trigger, which rejected both a direct `UPDATE` and a direct `DELETE` with `ERROR: TaskAssignmentEvent rows are append-only`. Full evidence in §5.2–§5.3.

**Net assessment:** the code-level remediation is genuine and, where testable without the actual application server, positively confirmed — including two of the highest-stakes claims down to the database transaction log. What remains unexecuted, on this exact commit, in any environment on record, is the actual `npm ci` → `prisma:generate` → `test` → `lint` → `build` pipeline. That gap is the single reason this is CONDITIONAL GO rather than GO.

---

## 7. Exact conditions required before pilot

1. Run `npm ci`, `npm run prisma:generate`, `npm test`, `npm run lint`, and `npm run build` to green against commit `da83f87` in a genuinely network-enabled Node 24 environment, and publish the results. This is the sole remaining gate implicated by the user's own explicit rule, and nothing else in this report should be read as a substitute for it.
2. When doing so, budget time to resolve the `@zxing/library@0.23.0` → Node ≥24 engine requirement explicitly — confirm whatever CI/build image is used actually satisfies it, since this sandbox could not.
3. Fix N-01 (wire up or remove the dead `CLEAR_USER_DATA` service-worker message) before any future work adds per-user data to the service worker cache, so the safeguard is real rather than illusory when it starts to matter.
4. Fix N-02 (add `/i` to the proxy's legacy-path list, or repoint the deep-link redirect) as routine cleanup — not blocking, but worth doing before physical labels from the prior product identity start confusing users with a double redirect.
5. Get real device/browser/live-server testing done at some point before pilot — this review, in both rounds, has been unable to exercise the actual running application, only its source, its build-time verification scripts, and (new this round) its database migrations directly. Static and DB-level evidence is strong, but it is not a substitute for watching the real thing run.

---

## 8. What this remediation pass did particularly well

1. **The idempotency fix is textbook, not just "present."** Required client key, tenant-scoped DB constraint, a pre-check for the common case, and a catch-on-conflict fallback for the genuinely concurrent case that returns the actual winning row rather than a generic error — this is the correct pattern, and it held up under a real two-transaction race I constructed myself.
2. **The SiteMembership backfill was written defensively, not just correctly for the happy path.** It explicitly refuses to guess for multi-site orgs, correctly carries over an inactive membership's inactive state rather than silently activating it, and correctly treats an org with one active site plus one deactivated site as single-site — I tested all three of these edge cases directly and none of them surprised me.
3. **The Count queue's "unattributed → fails closed" handling for pre-ownership-field legacy entries is a genuinely careful piece of engineering.** It would have been much easier, and looked equally correct in casual review, to just default missing `ownerUserId` to the current user. Instead it explicitly refuses to guess and forces manual reconciliation — exactly the right call for data that might belong to someone else.
4. **The team actually disclosed the inherited household-inventory surface this round instead of leaving it implicit.** The rewritten `docs/ROADMAP.md` names the legacy scope, states its gating mechanism, and says outright that it is not reviewed for pilot use — this is the honest version of what Round 1 flagged as missing, not a minimal patch.
5. **Every fix was verifiable from source, and every one I checked actually matched its description.** Across eleven re-tested findings and the user's thirteen specific attack requests, I did not find a single case this round where the claimed remediation didn't match the actual code — a genuinely unusual hit rate for a remediation pass, and worth naming explicitly rather than only cataloguing the two minor things that were still slightly off.

---

*Prepared as an independent adversarial review. Every claim above is either a direct citation of source at commit `da83f87`, a script I executed myself in this session, a live PostgreSQL migration/transaction I ran myself, or a live web-search verification against Next.js's own current documentation — not a restatement of the handoff document's self-reported claims. Where I could not independently execute something (the npm-dependency-backed build pipeline, live HTTP/browser/device testing), I said so plainly rather than inferring a pass.*
