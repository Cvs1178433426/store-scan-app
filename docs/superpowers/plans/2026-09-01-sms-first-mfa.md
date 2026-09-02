# SMS-First MFA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mandatory same-phone TOTP enrollment with secure SMS-first registration and login while retaining TOTP and single-use recovery codes as backup factors.

**Architecture:** ContinuiXAi owns challenge state, expiry, rate limits, lockouts, account activation, and audit outcomes. Twilio Verify is isolated behind a send/match adapter, phone numbers are encrypted with a separately keyed lookup HMAC, and MFA challenges use method-bound server records referenced only by secure HttpOnly cookies. The rollout is additive and feature-flagged; the existing TOTP path remains available while users migrate.

**Tech Stack:** TypeScript 7, Node.js 24, Fastify 5, Prisma 7/PostgreSQL 17, Next.js 16/React 19, Vitest 4, Twilio Verify REST API, Cloudflare Turnstile Siteverify.

**Spec:** `docs/superpowers/specs/2026-09-01-sms-mfa-design.md`

## Global Constraints

- SMS is required/default for new accounts; TOTP and recovery codes are optional backup factors.
- Pilot phone numbers are United States E.164 numbers and unique per user.
- Local limits are 3 sends/15 minutes, 5 wrong checks/challenge, 10 sends/24 hours, and a 15-minute lockout.
- The provider adapter sends and matches only; application state owns expiry, attempts, rate limits, and visible statuses.
- No OTP, raw phone number, recovery code, secret, password, or provider credential may enter logs, URLs, analytics, or ordinary API responses.
- Challenge identifiers exist only in `HttpOnly; Secure; SameSite=Strict` cookies.
- The Recovery PIN and administrator factor-reset paths must be unavailable before SMS MFA is enabled.
- `accountStatus` is authoritative and must remain database-consistent with `isActive` during migration.
- All feature work targets `chatgpt-development`; do not merge to `master` before exact-SHA CI, deployment, and physical iPhone acceptance.

## File Structure

- `apps/api/src/lib/phone.ts`: E.164 normalization, authenticated encryption, masking, versioned HMAC lookup.
- `apps/api/src/lib/verificationProvider.ts`: provider-neutral send/match contract and result types.
- `apps/api/src/lib/twilioVerifyProvider.ts`: Twilio REST adapter using restricted credentials.
- `apps/api/src/lib/verificationPolicy.ts`: challenge creation, attempt accounting, send limits, circuit breaker.
- `apps/api/src/lib/turnstile.ts`: server-side proof-of-humanity validation.
- `apps/api/src/lib/mfaChallengeCookie.ts`: secure cookie creation, reading, and clearing.
- `apps/api/src/routes/registration.ts`: pending registration, exact-match resume, SMS approval, atomic first-admin activation.
- `apps/api/src/routes/mfa.ts`: SMS/TOTP/recovery-code login and factor-management routes.
- `apps/api/src/routes/auth.ts`: password gate, account-state checks, Recovery PIN retirement, prohibited admin reset.
- `apps/web/components/PhoneField.tsx`: accessible US phone input and masked confirmation.
- `apps/web/components/VerificationCodeForm.tsx`: six-digit code, resend timer, retry feedback.
- `apps/web/app/register/page.tsx`: registration and SMS approval stages.
- `apps/web/app/login/page.tsx`: SMS-default login and explicit backup-method selection.
- `apps/web/app/settings/page.tsx`: phone change, TOTP backup, recovery-code management.
- `apps/api/scripts/smsMfaValidation.ts`: disposable-PostgreSQL integration validation for CI.

---

### Task 1: Add additive account, phone, challenge, and rate-limit schema

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260909000000_sms_first_mfa/migration.sql`
- Test: `apps/api/scripts/smsMfaValidation.ts`

**Interfaces:**
- Produces: `AccountStatus`, `MfaMethod`, `User.accountStatus`, encrypted/versioned phone fields, `MfaChallenge`, `VerificationSendBucket`, and `SecurityAuditEvent` persistence.

- [ ] **Step 1: Write the failing PostgreSQL validation**

Create a script that asserts a new pending user has `accountStatus = PENDING_PHONE_VERIFICATION` and `isActive = false`, then attempts a raw SQL update to set `isActive = true` without changing status and expects PostgreSQL check-constraint rejection. Add a concurrent transaction test proving only one verified user can receive the first `ADMIN` role.

```ts
await prisma.user.create({ data: pendingUser });
await expect(prisma.$executeRawUnsafe(
  `UPDATE "User" SET "isActive" = true WHERE email = $1`, pendingUser.email,
)).rejects.toThrow();
```

- [ ] **Step 2: Run the validation to verify it fails**

Run: `DATABASE_URL="$DATABASE_URL" npx tsx apps/api/scripts/smsMfaValidation.ts`

Expected: FAIL because the enum, fields, tables, and constraint do not exist.

- [ ] **Step 3: Add the Prisma models and additive SQL migration**

Use these stable names:

```prisma
enum AccountStatus { PENDING_PHONE_VERIFICATION ACTIVE DISABLED }
enum MfaMethod { SMS TOTP RECOVERY_CODE }
enum MfaChallengePurpose { REGISTRATION LOGIN PASSWORD_RESET PHONE_CHANGE FACTOR_REMOVAL }

model MfaChallenge {
  id String @id @default(cuid())
  userId String?
  pendingEmail String?
  phoneLookupHash String?
  purpose MfaChallengePurpose
  method MfaMethod
  destinationVersion Int?
  expiresAt DateTime
  incorrectAttempts Int @default(0)
  consumedAt DateTime?
  invalidatedAt DateTime?
  createdAt DateTime @default(now())
  user User? @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, purpose, createdAt])
  @@index([expiresAt])
}
```

Add `accountStatus`, `phoneEncrypted`, `phoneEncryptionKeyVersion`, `phoneLookupHash`, `phoneLookupKeyVersion`, `phoneLast4`, `phoneVerifiedAt`, and `phoneVersion`. Backfill existing active users to `ACTIVE`; keep their phone fields nullable for migration. Add SQL constraint:

```sql
ALTER TABLE "User" ADD CONSTRAINT "User_account_status_active_consistency"
CHECK (("accountStatus" = 'ACTIVE' AND "isActive" = true) OR
       ("accountStatus" <> 'ACTIVE' AND "isActive" = false));
```

- [ ] **Step 4: Generate Prisma and rerun migration validation**

Run: `npm run prisma:generate && DATABASE_URL="$DATABASE_URL" npx prisma migrate deploy --schema apps/api/prisma/schema.prisma && DATABASE_URL="$DATABASE_URL" npx tsx apps/api/scripts/smsMfaValidation.ts`

Expected: PASS, including constraint and concurrent bootstrap assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260909000000_sms_first_mfa/migration.sql apps/api/scripts/smsMfaValidation.ts
git commit -m "feat: add SMS MFA persistence invariants"
```

### Task 2: Implement phone cryptography and key rotation

**Files:**
- Create: `apps/api/src/lib/phone.ts`
- Create: `apps/api/src/lib/phone.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `normalizeUsPhone(input): string`, `encryptPhone(e164): EncryptedPhone`, `decryptPhone(value, version): string`, `hashPhone(e164, version): string`, `maskPhone(e164): string`.

- [ ] **Step 1: Write failing phone tests**

Cover `(631) 742-3355 -> +16317423355`, invalid/non-US rejection, AES-256-GCM tamper rejection, deterministic versioned HMAC, different encryption ciphertexts for the same number, and `(***) ***-3355` masking.

```ts
expect(normalizeUsPhone("(631) 742-3355")).toBe("+16317423355");
expect(() => decryptPhone(tampered, 1)).toThrow("Unable to decrypt phone number");
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -w apps/api -- src/lib/phone.test.ts`

Expected: FAIL because `phone.ts` does not exist.

- [ ] **Step 3: Implement minimal versioned crypto**

Use Node `crypto` AES-256-GCM with random 12-byte IV for encryption and HMAC-SHA-256 for lookup. Read comma-delimited key rings from `PHONE_ENCRYPTION_KEYS` and `PHONE_LOOKUP_HMAC_KEYS`; the first entry is current. Never include raw input in thrown errors.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -w apps/api -- src/lib/phone.test.ts && npm run build -w apps/api`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .env.example apps/api/src/lib/phone.ts apps/api/src/lib/phone.test.ts
git commit -m "feat: protect verified phone numbers"
```

### Task 3: Add proof-of-humanity and provider adapters

**Files:**
- Create: `apps/api/src/lib/turnstile.ts`
- Create: `apps/api/src/lib/turnstile.test.ts`
- Create: `apps/api/src/lib/verificationProvider.ts`
- Create: `apps/api/src/lib/twilioVerifyProvider.ts`
- Create: `apps/api/src/lib/twilioVerifyProvider.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `VerificationProvider.start(destination, channel): Promise<{ providerRef: string }>` and `VerificationProvider.check(providerRef, destination, code): Promise<{ matched: boolean }>`.
- Produces: `verifyHuman(token, remoteIp): Promise<boolean>`.

- [ ] **Step 1: Write failing contract tests**

Test successful send/match mapping, rejected code, 404-after-resolution mapping to `VerificationAmbiguousError`, redaction of phone/code from thrown errors, timeout behavior, and Turnstile hostname/action validation.

```ts
await expect(provider.check("VE123", "+16317423355", "123456"))
  .resolves.toEqual({ matched: true });
expect(String(caught)).not.toContain("123456");
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -w apps/api -- src/lib/turnstile.test.ts src/lib/twilioVerifyProvider.test.ts`

Expected: FAIL because the adapters do not exist.

- [ ] **Step 3: Implement adapters using built-in `fetch`**

Authenticate Twilio with Restricted API Key SID/secret, form-encode requests, apply an abort timeout, and keep service/provider references server-only. Validate Turnstile through Siteverify, requiring `success`, the configured hostname, and expected action `sms_registration`.

- [ ] **Step 4: Wire configuration with production fail-closed checks**

Add `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_VERIFY_SERVICE_SID`, `TURNSTILE_SECRET_KEY`, and `TURNSTILE_EXPECTED_HOSTNAME`. Startup must fail when `SMS_MFA_ENABLED=true` and any required setting is absent.

- [ ] **Step 5: Run tests and build**

Run: `npm test -w apps/api -- src/lib/turnstile.test.ts src/lib/twilioVerifyProvider.test.ts && npm run build -w apps/api`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .env.example apps/api/src/index.ts apps/api/src/lib/turnstile* apps/api/src/lib/verificationProvider.ts apps/api/src/lib/twilioVerifyProvider*
git commit -m "feat: add protected verification providers"
```

### Task 4: Implement application-owned challenge policy

**Files:**
- Create: `apps/api/src/lib/verificationPolicy.ts`
- Create: `apps/api/src/lib/verificationPolicy.test.ts`
- Create: `apps/api/src/lib/mfaChallengeCookie.ts`
- Create: `apps/api/src/lib/mfaChallengeCookie.test.ts`

**Interfaces:**
- Produces: `startChallenge(input): Promise<ChallengeStartResult>`, `checkChallenge(input): Promise<ChallengeCheckResult>`, `switchChallengeMethod(input): Promise<void>`.
- Produces: `setChallengeCookie(reply, id)`, `readChallengeCookie(request)`, `clearChallengeCookie(reply)`.

- [ ] **Step 1: Write failing policy tests**

Test 3/15-minute, 10/24-hour, 5-wrong-code, 15-minute lockout, challenge expiry, one-method/one-destination binding, single consumption, ambiguous provider timeout without attempt penalty, global circuit breaker, and `Retry-After: 900` behavior.

```ts
for (let i = 0; i < 5; i += 1) await checkWrong(challenge.id);
await expect(checkWrong(challenge.id)).rejects.toMatchObject({ retryAfter: 900 });
```

Assert cookie options exactly include `httpOnly: true`, `secure: true`, `sameSite: "strict"`, `path: "/api"`, and ten-minute expiry.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -w apps/api -- src/lib/verificationPolicy.test.ts src/lib/mfaChallengeCookie.test.ts`

Expected: FAIL because policy and cookie helpers do not exist.

- [ ] **Step 3: Implement transactional policy**

Use database rows and PostgreSQL transactions rather than browser counters. Rate-limit keys are keyed HMACs of account, phone, IP-prefix, and global dimensions. Call the provider only after local policy approves the send. On ambiguous checks, invalidate the challenge and return `fresh_challenge_required` without incrementing incorrect attempts.

- [ ] **Step 4: Run tests and build**

Run: `npm test -w apps/api -- src/lib/verificationPolicy.test.ts src/lib/mfaChallengeCookie.test.ts && npm run build -w apps/api`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/verificationPolicy* apps/api/src/lib/mfaChallengeCookie*
git commit -m "feat: enforce SMS verification policy"
```

### Task 5: Build registration and atomic first-user activation routes

**Files:**
- Create: `apps/api/src/routes/registration.ts`
- Create: `apps/api/src/routes/registration.http.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `packages/shared/src/schemas/auth.ts`
- Test: `apps/api/scripts/smsMfaValidation.ts`

**Interfaces:**
- Produces: `POST /api/auth/register/start`, `/register/check`, `/register/resend`.
- Consumes: phone helpers, Turnstile, challenge policy, and challenge cookie.

- [ ] **Step 1: Write failing HTTP and concurrency tests**

Cover pending inactive creation, exact email+phone resume, email-match/phone-mismatch generic rejection without mutation, phone-match/email-mismatch rejection, no session before approval, approval activation, expired cleanup version guard, duplicate timing tolerance, and concurrent first-user approval.

```ts
expect(second.statusCode).toBe(202);
expect(await storedPhoneHash(original.id)).toBe(originalHash);
expect(adminCount).toBe(1);
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -w apps/api -- src/routes/registration.http.test.ts`

Expected: FAIL because the routes do not exist.

- [ ] **Step 3: Update shared schemas and implement routes**

`registerStartSchema` contains `name`, normalized business email, US phone, password, consent boolean/version, and Turnstile token. Return `202` with the same response envelope for created, resumed, and conflict paths. Approval transaction acquires `pg_advisory_xact_lock(hashtext('continuixai-pilot-bootstrap'))`, locks the challenge/user row, consumes the challenge, activates the user, and assigns exactly one first `ADMIN`.

- [ ] **Step 4: Retire unsafe registration/bootstrap behavior**

Remove Recovery PIN from registration. Make legacy `/register` and `/bootstrap/admin` return `410` while the feature flag is enabled, so no active account can be created outside verified approval.

- [ ] **Step 5: Run route, database, shared, and build checks**

Run: `npm run build:shared && npm test -w apps/api -- src/routes/registration.http.test.ts && DATABASE_URL="$DATABASE_URL" npx tsx apps/api/scripts/smsMfaValidation.ts && npm run build -w apps/api`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/schemas/auth.ts apps/api/src/index.ts apps/api/src/routes/auth.ts apps/api/src/routes/registration* apps/api/scripts/smsMfaValidation.ts
git commit -m "feat: require SMS approval for registration"
```

### Task 6: Convert login, recovery, and factor management to method-bound challenges

**Files:**
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/routes/mfa.ts`
- Create: `apps/api/src/routes/mfa.http.test.ts`
- Modify: `apps/api/src/lib/mfa.ts`
- Modify: `packages/shared/src/schemas/auth.ts`
- Modify: `apps/api/prisma/seed.ts`

**Interfaces:**
- Produces: password-gated SMS login; explicit `/mfa/method`; `/mfa/check`; `/mfa/totp/enroll`; `/mfa/totp/remove`; `/mfa/recovery-codes/regenerate`; factor-backed password reset.

- [ ] **Step 1: Write failing route tests**

Test that password success creates an SMS challenge cookie but no session; an SMS cookie cannot verify TOTP; method switching invalidates the prior challenge; TOTP removal requires a different recent factor; recovery codes consume atomically; token version changes after factor removal/phone change; migration-deadline users can access enrollment only; and provider outage never bypasses MFA.

- [ ] **Step 2: Write Recovery PIN and admin-reset retirement tests**

Assert `/recover/user-id`, PIN-based `/recover/password`, and `/users/:id/reset-mfa` return `410`/`403` and never modify credentials or factors. Keep administrator account disablement and token invalidation.

- [ ] **Step 3: Run tests to verify failure**

Run: `npm test -w apps/api -- src/routes/mfa.http.test.ts`

Expected: FAIL against the current JSON challenge token and combined TOTP/recovery endpoint.

- [ ] **Step 4: Implement method-bound login and recovery**

Replace client-visible `challengeToken` with the secure cookie. Store the selected method and destination version on `MfaChallenge`. Each check route accepts only the code; it reads the challenge ID from the cookie. Password reset requires a `PASSWORD_RESET` challenge and increments `tokenVersion` without returning a session.

- [ ] **Step 5: Implement safe factor reduction and security notifications**

Require a consumed `FACTOR_REMOVAL` challenge using another method before clearing TOTP or regenerating recovery codes. Send the existing verified phone a generic security notification after removal; notification failure records an audit failure but does not silently undo an already committed security transaction.

- [ ] **Step 6: Run focused and full API tests**

Run: `npm test -w apps/api -- src/routes/mfa.http.test.ts src/lib/mfa.test.ts && npm test -w apps/api && npm run build -w apps/api`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/schemas/auth.ts apps/api/prisma/seed.ts apps/api/src/lib/mfa.ts apps/api/src/routes/auth.ts apps/api/src/routes/mfa.ts apps/api/src/routes/mfa.http.test.ts
git commit -m "feat: make SMS the default MFA method"
```

### Task 7: Build accessible registration and login UX

**Files:**
- Create: `apps/web/components/PhoneField.tsx`
- Create: `apps/web/components/VerificationCodeForm.tsx`
- Create: `apps/web/components/VerificationCodeForm.test.tsx`
- Modify: `apps/web/app/register/page.tsx`
- Modify: `apps/web/app/login/page.tsx`
- Modify: `apps/web/lib/api.ts`
- Modify: `apps/web/lib/i18n/translations.ts`
- Modify: `apps/web/app/layout.tsx`

**Interfaces:**
- Consumes: registration and MFA routes from Tasks 5-6.
- Produces: same-phone SMS registration/login with explicit TOTP and recovery-code backup selection.

- [ ] **Step 1: Write failing UI tests**

Test phone formatting, `autocomplete="tel"`, `autocomplete="one-time-code"`, numeric six-digit input, resend disabled for 30 seconds, `Retry-After` messaging, masked destination, method switching, and no challenge material in local/session storage.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -w apps/web -- components/VerificationCodeForm.test.tsx`

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement registration stages**

Replace Recovery PIN with mobile number and transactional-text consent. Render `details -> code -> recovery-codes -> complete`; never display an employee number before SMS approval. Load Turnstile only on the registration-send stage and send its token once to the server.

- [ ] **Step 4: Implement SMS-default login stages**

Render `password -> sms`; show `Use authenticator app` and `Use a recovery code` only when the API says they are enrolled. Requests use `credentials: "include"`; no challenge token is read or stored by React.

- [ ] **Step 5: Add accessibility and stable error copy**

Use visible labels, focus the first invalid field, `aria-live="polite"`, paste-friendly OTP input, and the exact lockout message: `Too many verification attempts. Please try again in 15 minutes.`

- [ ] **Step 6: Run web tests, lint, and build**

Run: `npm test -w apps/web && npm run lint -w apps/web && npm run build -w apps/web`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/layout.tsx apps/web/app/login/page.tsx apps/web/app/register/page.tsx apps/web/components/PhoneField.tsx apps/web/components/VerificationCodeForm* apps/web/lib/api.ts apps/web/lib/i18n/translations.ts
git commit -m "feat: add same-phone SMS authentication UX"
```

### Task 8: Add phone/TOTP settings, migration gate, and visible build marker

**Files:**
- Modify: `apps/web/app/settings/page.tsx`
- Create: `apps/web/components/SecurityFactors.tsx`
- Create: `apps/web/components/SecurityFactors.test.tsx`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/web/app/layout.tsx`
- Create: `apps/web/components/BuildMarker.tsx`

**Interfaces:**
- Produces: verified phone change, manual-key TOTP backup enrollment, recent-MFA factor removal, migration enrollment-only routing, and candidate SHA visibility.

- [ ] **Step 1: Write failing settings and authorization tests**

Test current-factor proof plus new-phone approval, phone hash uniqueness, TOTP manual key always visible, factor removal step-up, security notification, and post-deadline users receiving `403 enrollment_required` on every protected application route while retaining enrollment access.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -w apps/api -- src/routes/mfa.http.test.ts && npm test -w apps/web -- components/SecurityFactors.test.tsx`

Expected: FAIL because settings and enrollment-only enforcement are absent.

- [ ] **Step 3: Implement security settings and migration middleware**

Phone change uses two sequential challenges: a current non-new-phone factor, then the new SMS destination. Commit encrypted phone/hash/version replacement and `tokenVersion` increment atomically. Central authentication middleware rejects non-enrollment routes after `SMS_MFA_MIGRATION_DEADLINE` when no verified phone exists.

- [ ] **Step 4: Add build marker**

Expose `NEXT_PUBLIC_BUILD_SHA` in a small settings/footer marker and return the same SHA from `/api/health/version`. Acceptance compares both before testing; neither value is a secret.

- [ ] **Step 5: Run focused and full tests**

Run: `npm test -w apps/api -- src/routes/mfa.http.test.ts && npm test -w apps/web -- components/SecurityFactors.test.tsx && npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/index.ts apps/api/src/routes/auth.ts apps/web/app/layout.tsx apps/web/app/settings/page.tsx apps/web/components/BuildMarker.tsx apps/web/components/SecurityFactors*
git commit -m "feat: add MFA security settings and migration gate"
```

### Task 9: Add operational controls, CI validation, and runbooks

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.env.example`
- Modify: `apps/api/scripts/smsMfaValidation.ts`
- Create: `docs/SMS-MFA-OPERATIONS.md`
- Modify: `docs/RETAIL_COUNT_MVP_ACCEPTANCE.md`
- Modify: `README.md`

**Interfaces:**
- Produces: repeatable database validation, key-rotation/rollback instructions, Twilio readiness gates, and physical acceptance record.

- [ ] **Step 1: Expand database validation script**

Exercise migration parity, status constraint, exact-match resume, cross-route pending/disabled denial, concurrent bootstrap, rate-limit persistence, Recovery PIN retirement, factor-removal step-up, HMAC rotation, and audit redaction against disposable PostgreSQL.

- [ ] **Step 2: Add CI execution**

Add `npx tsx scripts/smsMfaValidation.ts` to `database-validation` after migration parity and before Store Count validation. Provide fake-provider and deterministic test keys only in that CI step; never configure live Twilio credentials.

- [ ] **Step 3: Write the operations runbook**

Document Restricted API Key creation/90-day rotation, US geo permissions, upgraded-account confirmation, Turnstile hostname/action, API-only encryption-key access, dual-key HMAC rotation/rollback, circuit-breaker thresholds, provider outage behavior, backup restoration with matching keys, and rollback that preserves TOTP access. The separate factor-change notification key permits only the required Messages-create action, rotates every 90 days, and is never the Verify key or a master Auth Token. Document that factor removal returns `503` before challenge creation when `TWILIO_NOTIFICATION_API_KEY_SID`, `TWILIO_NOTIFICATION_API_KEY_SECRET`, or `TWILIO_MESSAGING_SERVICE_SID` is absent. Copy these exact requirements into `docs/SMS-MFA-OPERATIONS.md` when creating the runbook.

- [ ] **Step 4: Expand physical acceptance**

Require visible SHA match or Safari data clearance, Mitchell's business email `Mitchell.Kobran@ContinuiXAi.com`, live paid-account SMS, wrong-code and lockout behavior, resend/delayed-code rejection, same-phone flow without QR, TOTP manual key, one recovery-code consumption, factor-change session invalidation, and redacted screenshots.

- [ ] **Step 5: Run full local verification**

Run: `npm run prisma:generate && npm test && npm run lint && npm run build && npm audit --omit=dev --audit-level=high && git diff --check`

Expected: every command exits 0, with no high-severity production dependency finding.

- [ ] **Step 6: Commit**

```bash
git add .env.example .github/workflows/ci.yml README.md apps/api/scripts/smsMfaValidation.ts docs/SMS-MFA-OPERATIONS.md docs/RETAIL_COUNT_MVP_ACCEPTANCE.md
git commit -m "docs: add SMS MFA operational gates"
```

### Task 10: Independent review, PR, deployment, and physical acceptance

**Files:**
- Create: `docs/CLAUDE-SMS-MFA-IMPLEMENTATION-REVIEW-BRIEF.md`
- Create after testing: `docs/SMS-MFA-PHYSICAL-ACCEPTANCE.md`

**Interfaces:**
- Consumes: all prior tasks and exact candidate SHA.
- Produces: reviewed PR, green CI, Railway candidate deployment, and documented iPhone acceptance.

- [ ] **Step 1: Request independent code review**

Use `superpowers:requesting-code-review` against the complete branch diff. Require explicit checks for C1-C6 and I1-I16 from the design review. Resolve technically valid findings one at a time with focused tests.

- [ ] **Step 2: Run fresh completion verification**

Run: `npm run prisma:generate && npm test && npm run lint && npm run build && npm audit --omit=dev --audit-level=high && git diff --check && git status --short`

Expected: all verification commands exit 0; status contains only intended documentation/evidence files.

- [ ] **Step 3: Push and open a PR to `chatgpt-development`**

PR body must list security invariants, Recovery PIN/admin-reset retirement, migrations, automated evidence, rollout flag default, and exact physical steps still pending. Do not target `master`.

- [ ] **Step 4: Require exact-SHA CI**

Confirm `lint`, `build`, `test`, and `database-validation` all succeed on the PR head. Any new commit invalidates prior CI evidence and requires the full suite again.

- [ ] **Step 5: Deploy the exact green SHA to Railway candidate services**

Confirm API and web deployments reference the same SHA and `/api/health/version` matches the visible web build marker. Keep `SMS_MFA_ENABLED=false` until secrets, paid Twilio status, restricted permissions, and rollback checks are recorded.

- [ ] **Step 6: Run and document physical iPhone acceptance**

Enable the flag for the pilot, perform every spec acceptance step, record outcomes without OTPs/phone numbers/recovery codes, and immediately disable the rollout flag on any activation, lockout, session, or delivery inconsistency.

- [ ] **Step 7: Final implementation commit**

```bash
git add docs/CLAUDE-SMS-MFA-IMPLEMENTATION-REVIEW-BRIEF.md docs/SMS-MFA-PHYSICAL-ACCEPTANCE.md
git commit -m "docs: record SMS MFA acceptance evidence"
```

## Self-Review Record

- Spec coverage: provider boundary, cryptography, status invariants, exact resume, atomic bootstrap, rate limits, Turnstile, secure challenges, Recovery PIN retirement, admin-reset prohibition, TOTP/recovery codes, migration, key rotation, CI, rollback, and physical acceptance are each assigned to a task.
- Placeholder scan: the plan contains no deferred implementation placeholders; future voice/shared-device/administrator recovery remain explicit non-pilot scope from the approved design.
- Type consistency: `VerificationProvider`, phone helper, challenge policy, cookie helper, route, schema, and UI names are defined before consumption.
