# SMS MFA security baseline

Recorded on 2026-09-02 for the `feat/sms-first-mfa` branch.

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
`database-validation` job. The fresh-database mode requires exactly 31 finished,
non-rolled-back migrations and an empty user/challenge state before it exercises
the real Prisma/PostgreSQL repositories and transactions. It asserts one pending
SMS registration, one winner from two concurrent completions, one active first
administrator, one-time recovery-code consumption, transactional TOTP removal,
authoritative API/media credential revocation, and eight persisted subject
rate-limit buckets enforced by a new store instance. SMS delivery and the
factor-change notification use deterministic local provider doubles; no paid SMS
or live provider credentials are configured.

The same CI job creates a second disposable database, applies the 29 migrations
that predate SMS MFA, seeds one active and one inactive legacy user, and then
deploys the two SMS migrations. Upgrade validation requires all 31 migrations,
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

The high-severity dependency gate remains open. Both `npm audit
--audit-level=high` and the production-only audit report `mysql2@3.15.3` through
Prisma (GHSA-3f6p-5ww8-9rcr) and exit 1. A narrow `mysql2@3.24.3` resolution made
the audit green in an installation probe, but it was reverted because this
environment blocked the required Prisma-generation proof. Do not use the
auditor's breaking Prisma downgrade. Merge remains prohibited until a reviewed
resolution passes `npm ci`, dependency-tree inspection, Prisma generation, fresh
and upgrade PostgreSQL migration validation, tests, build, lint, and the high
audit on one exact SHA.
