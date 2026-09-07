# SMS MFA security baseline

Recorded on 2026-09-02 for the `feat/sms-first-mfa` branch.

## Current remediation checkpoint

The current verified local code baseline is `c6c74119e6338270138cbfc5ad2226b66e29428e`. It includes the controlled lost-phone recovery backend and guided employee/administrator interfaces. On Node 24, the exact commit passed the PWA launcher check, 52 API files / 503 tests, 18 web files / 96 tests, shared/API/web production builds with 32 web routes, lint with 0 errors and 9 pre-existing warnings, and both production-only and complete dependency audits with 0 vulnerabilities. Hosted PostgreSQL, provider configuration, destructive review, deployment, and physical iPhone evidence remain pending; this is not a deployment approval.

## Branch gate

The source baseline is commit `2a509dabe1e14e5cc79f5c377d28162007a408f1`
(`fix: close authoritative revocation gaps`). Normal API sessions and media
credentials are both gated by the uncached
`isCurrentActiveAccess(userId, tokenVersion)` predicate. No authorization cache
is used for protected access decisions.

Focused coverage confirms the generic `{ "error": "unauthorized" }` 401 for:

- stale token versions;
- disabled and inactive accounts;
- absent users; and
- `mfa-login` and `backup` purpose-scoped credentials.

The media cases exercise media-cookie, media-bearer, and normal-bearer paths.

## Verification

| Command | Result |
| --- | --- |
| `npm exec -w apps/api vitest -- run src/index.auth.test.ts src/lib/mediaAuth.test.ts` | Passed: 2 test files, 25 tests. npm emitted one `Unknown env config "http-proxy"` warning. |
| `npm test` | Passed: PWA Home launcher regression checks; shared TypeScript build; API: 37 files / 244 tests; web: 13 files / 65 tests. npm emitted the same `http-proxy` warning before each workspace invocation. |
| `npm run build` | Passed: shared and API TypeScript builds; web Next.js 16.3.1 production build compiled, type-checked, and generated 31 static pages. npm emitted the same `http-proxy` warning. |
| `npm run lint` | Completed with 0 errors and 10 warnings, all in existing web files: `no-img-element` (3), missing `useEffect` dependencies (4), and unused eslint-disable directives (3). npm emitted the same `http-proxy` warning. |
| `npm audit --audit-level=high` | Reported 2 high-severity vulnerabilities: `mysql2 <3.22.0` (GHSA-3f6p-5ww8-9rcr), introduced through Prisma. The available `npm audit fix --force` would install breaking `prisma@6.19.3`; no dependency change was made. |
| `git diff --check` | Passed with no output. |

The audit and lint warnings are recorded baseline concerns, not changes made by
this task.

## PostgreSQL security gate

Task 5 adds `scripts/smsMfaPostgresValidation.ts` to the existing
`database-validation` job. The current fresh-database mode requires exactly 39 finished,
non-rolled-back migrations and an empty user/challenge state before it exercises
the real Prisma/PostgreSQL repositories and transactions. It asserts one pending
SMS registration, one winner from two concurrent completions, one active first
administrator, one-time recovery-code consumption, transactional TOTP removal,
authoritative API/media credential revocation, and eight persisted subject
rate-limit buckets enforced by a new store instance. SMS delivery and the
factor-change notification use deterministic local provider doubles; no paid SMS
or live provider credentials are configured.

The same CI job creates a second disposable database, applies the migrations
that predate the SMS MFA rollout, seeds one active and one inactive legacy user, and then
deploys the SMS and phone-recovery migrations. Upgrade validation requires all 39 migrations,
preserves both users, maps the inactive user to `DISABLED`, leaves both users at
phone version zero pending explicit enrollment, enforces the account-state check
constraint, and confirms schema parity. The job prints `GITHUB_SHA` only after
all database validation steps pass, so evidence is tied to the exact candidate.

Local non-database verification for Task 5 was collected from the Task 5 working
tree based on parent SHA `a2615c9167988fe7544d0da778f601ff36705e2e`, before
that working tree was committed as `8fa16e85f631c161996fbacac0a328e55fa07190`.
It is working-tree evidence and is not attributed to the parent commit itself.
That run covered the validation script's standalone TypeScript check, the full
test suite (API 40 files / 292 tests; web 14 files / 79 tests), the full
production build, CI YAML parsing, lint (0 errors / 9 existing warnings), and
`git diff --check`. Live migration and transaction execution was not possible
locally: Docker and PostgreSQL executables are unavailable, and a direct local
script load reached Prisma but failed to connect with `ECONNREFUSED`.

The PWA Home-launcher assertion correction is retained under the controller's
scope ruling: the required full test gate was blocked by a stale assertion that
contradicted the approved SMS-first login and registration paths. The production
code paths were not changed by that assertion-only correction.

The former high-severity dependency gate is closed locally without a Prisma downgrade. Prisma and `@prisma/client` remain at 7.10.0, while reviewed transitive resolutions use `mysql2@3.24.3` and `deepmerge-ts@8.0.2`. Fresh production-only and complete audits at the current checkpoint report 0 vulnerabilities. Hosted fresh/upgrade PostgreSQL validation and exact-SHA CI evidence are still mandatory before merge or deployment.
