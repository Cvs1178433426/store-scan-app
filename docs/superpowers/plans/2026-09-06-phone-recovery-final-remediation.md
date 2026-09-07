# Lost-Phone Recovery and Final MFA Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a pilot-testable SMS-first MFA implementation with employee-controlled lost-phone recovery and every Critical/Important finding from the final adversarial review resolved.

**Architecture:** Land four bounded security corrections first. Then add a provider-neutral email boundary, a PostgreSQL-backed recovery-case state machine, employee email proof, provisional new-phone proof, and one atomic completion transaction that rotates phone/session state. Keep every public response enumeration-safe and every provider ambiguity fail-closed.

**Tech Stack:** TypeScript 7, Fastify 5, Prisma 7.10, PostgreSQL, Next.js 16, React 19, Vitest 4, Twilio Verify/Messaging, SendGrid REST mail delivery, Cloudflare Turnstile.

**Spec:** `docs/superpowers/specs/2026-09-06-phone-recovery-final-remediation-design.md`

## Global Constraints

- Password, administrator access, registered email, or a replacement phone alone cannot replace a factor.
- An administrator may initiate or cancel recovery but cannot complete it.
- Recovery requires registered-email OTP proof followed by replacement-phone SMS proof.
- Recovery PIN and `/users/:id/reset-mfa` remain disabled.
- Five incorrect verification submissions create one durable fifteen-minute lock that resend and browser changes cannot reset.
- Provider rejection, timeout, or ambiguity never authenticates a user or mutates a factor.
- Raw email OTPs, SMS OTPs, phone numbers, recovery codes, passwords, secrets, and provider payloads never enter logs, audit rows, URLs, analytics, or browser storage.
- No push, pull request, merge, or deployment occurs while a Critical or Important finding remains.
- Every behavior change demonstrates red then green with focused tests and receives a security-sensitive diff review.

---

### Task 1: Block incompatible legacy restores

**Files:**
- Modify: `apps/api/src/routes/backup.ts`
- Create: `apps/api/src/routes/backup.smsMfa.test.ts`
- Modify: `render.yaml`

**Interfaces:**
- Consumes: `process.env.SMS_MFA_ENABLED` and the existing authenticated `/api/backup/restore` route.
- Produces: a `409` response with `{ error: "Backup restore is unavailable while SMS MFA is enabled." }` before multipart parsing or filesystem writes.

- [ ] **Step 1: Write the failing HTTP test**

```ts
it("rejects legacy restore before reading an archive when SMS MFA is enabled", async () => {
  process.env.SMS_MFA_ENABLED = "true";
  const response = await server.inject({
    method: "POST",
    url: "/api/backup/restore",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ error: "Backup restore is unavailable while SMS MFA is enabled." });
  expect(mocks.requestFile).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused test and confirm red**

Run: `npm run test -w apps/api -- src/routes/backup.smsMfa.test.ts`

Expected: FAIL because the route attempts `request.file()` and returns `400`.

- [ ] **Step 3: Add the early gate and explicit deployment flag**

```ts
admin.post("/restore", async (request, reply) => {
  if (process.env.SMS_MFA_ENABLED === "true") {
    return reply.code(409).send({ error: "Backup restore is unavailable while SMS MFA is enabled." });
  }
  const file = await request.file({ limits: { fileSize: 500 * 1024 * 1024 } });
```

Add `ENABLE_LEGACY_INVENTORY_FEATURES: "false"` explicitly to the API environment in `render.yaml`.

- [ ] **Step 4: Run focused verification**

Run: `npm run test -w apps/api -- src/routes/backup.smsMfa.test.ts && npm run build -w apps/api && npm run lint -w apps/api && git diff --check`

Expected: the focused test, build, lint, and diff check all exit `0`.

- [ ] **Step 5: Commit the isolated correction**

```bash
git add apps/api/src/routes/backup.ts apps/api/src/routes/backup.smsMfa.test.ts render.yaml
git commit -m "fix: block legacy restore under SMS MFA"
```

---

### Task 2: Equalize login password work

**Files:**
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/routes/mfa.http.test.ts`

**Interfaces:**
- Consumes: normalized identifier and submitted password.
- Produces: exactly one bcrypt comparison for known, unknown, and inactive accounts before the generic `401` decision.

- [ ] **Step 1: Write failing comparison-path tests**

```ts
it.each(["unknown", "inactive"])("performs one password comparison for a %s account", async (state) => {
  mocks.findLoginUser.mockResolvedValue(state === "unknown" ? null : inactiveUser);
  await server.inject({ method: "POST", url: "/api/auth/login", payload: credentials });
  expect(mocks.bcryptCompare).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the focused test and confirm red**

Run: `npm run test -w apps/api -- src/routes/mfa.http.test.ts`

Expected: FAIL because unknown/inactive branches call bcrypt zero times.

- [ ] **Step 3: Add one fixed production-cost decoy hash**

```ts
const LOGIN_DECOY_PASSWORD_HASH = "$2b$10$wL9vX9fQe9O4vBLcL20RHuJQXaKf6M5kh3AD0XnVqmj3tO3IhpY7K";

const passwordHash = user?.isActive ? user.passwordHash : LOGIN_DECOY_PASSWORD_HASH;
const valid = await bcrypt.compare(parsed.data.password, passwordHash);
if (!user || !user.isActive || !valid) {
  return reply.code(401).send({ error: t("invalidCredentials", request.locale) });
}
```

- [ ] **Step 4: Run focused verification**

Run: `npm run test -w apps/api -- src/routes/mfa.http.test.ts && npm run build -w apps/api && npm run lint -w apps/api && git diff --check`

Expected: all commands exit `0`; both rejection paths call bcrypt once.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth.ts apps/api/src/routes/mfa.http.test.ts
git commit -m "fix: equalize login rejection work"
```

---

### Task 3: Make every recovery-code check constant-work

**Files:**
- Modify: `apps/api/src/routes/mfa.ts`
- Modify: `apps/api/src/routes/mfa.http.test.ts`
- Modify: `apps/api/src/lib/mfa.test.ts`

**Interfaces:**
- Consumes: `consumeBackupCodeConstantWork(code, hashes, compare?)` from `apps/api/src/lib/mfa.ts`.
- Produces: eight padded comparisons for `/mfa/check` and `/mfa/verify`, with unchanged atomic single-use persistence.

- [ ] **Step 1: Write failing route tests**

```ts
it.each(["/api/auth/mfa/check", "/api/auth/mfa/verify"])(
  "%s uses the constant-work recovery-code consumer",
  async (url) => {
    await submitRecoveryCode(url);
    expect(mocks.consumeBackupCodeConstantWork).toHaveBeenCalledTimes(1);
    expect(mocks.consumeBackupCode).not.toHaveBeenCalled();
  },
);
```

- [ ] **Step 2: Run the focused tests and confirm red**

Run: `npm run test -w apps/api -- src/routes/mfa.http.test.ts src/lib/mfa.test.ts`

Expected: FAIL because both routes call the early-exit consumer.

- [ ] **Step 3: Replace both route call sites**

```ts
import { consumeBackupCodeConstantWork } from "../lib/mfa.js";

const backup = await consumeBackupCodeConstantWork(code, hashes);
```

Remove the unused `consumeBackupCode` route import but retain the exported legacy helper until a repo-wide reference check proves it is unused.

- [ ] **Step 4: Run focused verification**

Run: `npm run test -w apps/api -- src/routes/mfa.http.test.ts src/lib/mfa.test.ts && npm run build -w apps/api && npm run lint -w apps/api && git diff --check`

Expected: all commands exit `0` and eight-slot unit assertions remain green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/mfa.ts apps/api/src/routes/mfa.http.test.ts apps/api/src/lib/mfa.test.ts
git commit -m "fix: use constant-work recovery code checks"
```

---

### Task 4: Enforce one durable verification-attempt lock

**Files:**
- Modify: `apps/api/src/lib/verificationRateLimit.ts`
- Modify: `apps/api/src/lib/verificationRateLimit.test.ts`
- Modify: `apps/api/src/lib/verificationPolicy.ts`
- Modify: `apps/api/src/lib/verificationPolicy.test.ts`
- Modify: `apps/api/src/routes/mfa.http.test.ts`

**Interfaces:**
- Produces: `consumeIncorrectVerificationAttempt(input: VerificationAttemptInput): Promise<VerificationBudgetResult>`.
- Consumes: HMAC-derived account, phone, and IP dimensions already stored on `MfaChallenge`.

```ts
export type VerificationAttemptInput = {
  action: string;
  phoneHash?: string;
  accountHash?: string;
  ipHash?: string;
  now: Date;
};
```

- [ ] **Step 1: Write a failing durable-budget unit test**

```ts
it("locks the subject for fifteen minutes on the fifth incorrect submission", async () => {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await expect(consume(inputAt(attempt))).resolves.toMatchObject({ allowed: true });
  }
  await expect(consume(inputAt(5))).resolves.toMatchObject({ allowed: false, retryAfterSeconds: 900 });
  await expect(consume(inputAt(6))).resolves.toMatchObject({ allowed: false });
});
```

- [ ] **Step 2: Write a failing resend integration test**

```ts
it("does not reset the fifteen-minute incorrect-attempt lock when a challenge is resent", async () => {
  await submitFourWrongCodes();
  await resendChallenge();
  expect((await submitWrongCode()).statusCode).toBe(429);
  expect((await resendChallenge()).headers["retry-after"]).toBeDefined();
});
```

- [ ] **Step 3: Run focused tests and confirm red**

Run: `npm run test -w apps/api -- src/lib/verificationRateLimit.test.ts src/lib/verificationPolicy.test.ts src/routes/mfa.http.test.ts`

Expected: FAIL because the incorrect counter is challenge-local and resend resets it.

- [ ] **Step 4: Add the dedicated attempt bucket**

Create an `otp-check:15m:<PURPOSE>` bucket with `limit: 5`, `durationSeconds: 900`, and a shared `sms-send:lock` row when the fifth submission is consumed. Use the existing PostgreSQL advisory transaction lock so the fifth and sixth concurrent submissions serialize. Check active locks before send, resend, and check. Do not count malformed input or provider timeouts as an incorrect attempt.

```ts
const ATTEMPT_LIMIT = 5;
const ATTEMPT_WINDOW_SECONDS = 15 * 60;

export async function consumeIncorrectVerificationAttempt(
  input: VerificationAttemptInput,
): Promise<VerificationBudgetResult> {
  return consumeAttemptWithPrisma(input);
}
```

- [ ] **Step 5: Wire policy checks and preserve fail-closed behavior**

Call the attempt consumer only after structural challenge validation and immediately before a decoy/local/provider mismatch is returned. On the fifth mismatch, invalidate the current challenge, return `VerificationLockedError(900)`, and leave the durable lock visible to resends and replacement challenges.

- [ ] **Step 6: Run focused verification**

Run: `npm run test -w apps/api -- src/lib/verificationRateLimit.test.ts src/lib/verificationPolicy.test.ts src/routes/mfa.http.test.ts && npm run build -w apps/api && npm run lint -w apps/api && git diff --check`

Expected: all commands exit `0`; the lock survives resend and the existing provider-ambiguity tests remain green.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/verificationRateLimit.ts apps/api/src/lib/verificationRateLimit.test.ts apps/api/src/lib/verificationPolicy.ts apps/api/src/lib/verificationPolicy.test.ts apps/api/src/routes/mfa.http.test.ts
git commit -m "fix: enforce durable verification attempt lock"
```

---

### Task 5: Add the recovery email provider boundary

**Files:**
- Create: `apps/api/src/lib/recoveryEmailProvider.ts`
- Create: `apps/api/src/lib/recoveryEmailProvider.test.ts`
- Modify: `apps/api/src/lib/verificationProvider.ts`
- Modify: `apps/api/src/lib/twilioVerifyProvider.test.ts`
- Modify: `apps/api/src/lib/twilioRestrictedKeyPolicy.test.ts`
- Modify: `.env.example`
- Modify: `render.yaml`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.prod.yml`

**Interfaces:**
- Produces: `RecoveryEmailProvider`, `createRecoveryEmailProvider`, and `assertRecoveryEmailConfig`.

```ts
export type RecoveryEmailMessage =
  | { kind: "recovery_requested"; destination: string; expiresAt: Date; caseReference: string }
  | { kind: "recovery_code"; destination: string; code: string; expiresAt: Date }
  | { kind: "recovery_completed"; destination: string; completedAt: Date };

export interface RecoveryEmailProvider {
  send(message: RecoveryEmailMessage): Promise<{ accepted: true }>;
}
```

- [ ] **Step 1: Write failing adapter tests**

Cover SendGrid request URL, bearer authentication, verified sender, generic templates, eight-second abort, non-2xx rejection, redacted thrown errors, and no destination/code in logs.

```ts
await provider.send({
  kind: "recovery_code",
  destination: "employee@example.com",
  code: "12345678",
  expiresAt,
});
expect(fetchMock).toHaveBeenCalledWith("https://api.sendgrid.com/v3/mail/send", expect.objectContaining({ method: "POST" }));
```

- [ ] **Step 2: Run provider tests and confirm red**

Run: `npm run test -w apps/api -- src/lib/recoveryEmailProvider.test.ts src/lib/twilioVerifyProvider.test.ts src/lib/twilioRestrictedKeyPolicy.test.ts`

Expected: FAIL because the provider and configuration variables do not exist.

- [ ] **Step 3: Implement the provider and production configuration gate**

Require `SENDGRID_RECOVERY_API_KEY`, `MFA_RECOVERY_FROM_EMAIL`, `MFA_RECOVERY_PUBLIC_URL`, and `EMAIL_OTP_HMAC_KEY` when `NODE_ENV=production && SMS_MFA_ENABLED=true`. Validate HTTPS public URL, email syntax, independent HMAC key material, and API-key presence without logging values. Use injected `fetch` and `AbortController`.

- [ ] **Step 4: Add manifest/environment wiring**

Declare the four settings in every production manifest. Mark secrets as unsynced/operator-supplied. Do not add real values.

- [ ] **Step 5: Run focused verification**

Run: `npm run test -w apps/api -- src/lib/recoveryEmailProvider.test.ts src/lib/twilioVerifyProvider.test.ts src/lib/twilioRestrictedKeyPolicy.test.ts src/index.auth.test.ts && npm run build -w apps/api && npm run lint -w apps/api && git diff --check`

Expected: all commands exit `0`; missing/invalid production configuration blocks startup.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/recoveryEmailProvider.ts apps/api/src/lib/recoveryEmailProvider.test.ts apps/api/src/lib/verificationProvider.ts apps/api/src/lib/twilioVerifyProvider.test.ts apps/api/src/lib/twilioRestrictedKeyPolicy.test.ts apps/api/src/index.auth.test.ts .env.example render.yaml docker-compose.yml docker-compose.prod.yml
git commit -m "feat: add recovery email provider boundary"
```

---

### Task 6: Add the PostgreSQL recovery-case state machine

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260909080000_phone_recovery/migration.sql`
- Modify: `apps/api/src/lib/smsMfaMigrationState.ts`
- Modify: `apps/api/src/lib/smsMfaMigrationState.test.ts`
- Create: `apps/api/src/lib/phoneRecoveryRepository.ts`
- Create: `apps/api/src/lib/phoneRecoveryRepository.test.ts`
- Create: `apps/api/scripts/phoneRecoveryPostgresValidation.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `PhoneRecoveryStatus`, `PhoneRecoveryCase`, `PhoneRecoveryRepository`, and new challenge purposes `PHONE_RECOVERY_EMAIL`/`PHONE_RECOVERY_SMS`.

```ts
export interface PhoneRecoveryRepository {
  createNoticePending(input: InitiateRecoveryInput): Promise<RecoveryCaseView>;
  markNoticeAccepted(caseId: string, at: Date): Promise<boolean>;
  markNoticeFailed(caseId: string, reason: string, at: Date): Promise<void>;
  beginEmailProof(input: BeginEmailProofInput): Promise<EmailProofChallenge>;
  recordEmailApproval(input: EmailApprovalInput): Promise<boolean>;
  reservePhone(input: ReservePhoneInput): Promise<PhoneProofChallenge>;
  complete(input: CompletePhoneRecoveryInput): Promise<CompletedRecovery>;
  cancel(input: CancelRecoveryInput): Promise<boolean>;
}
```

- [ ] **Step 1: Write failing repository/concurrency tests**

Cover one open case per user, admin self-initiation rejection, token-version snapshot, legal state transitions, notice-failure terminality, expiry, provisional alias collision, consistent lock order, one winner under concurrent completion, and audit immutability.

- [ ] **Step 2: Run focused tests and confirm red**

Run: `npm run test -w apps/api -- src/lib/phoneRecoveryRepository.test.ts src/lib/smsMfaMigrationState.test.ts`

Expected: FAIL because models, migration, and repository do not exist.

- [ ] **Step 3: Implement schema and migration constraints**

Add `PhoneRecoveryCase`, `PhoneRecoveryStatus`, a case foreign key on `MfaChallenge`, partial unique index for one open case per user, purpose/method constraints, timestamp/status checks, and expiring provisional phone aliases. Extend the migration-state allow-list with `20260909080000_phone_recovery`.

- [ ] **Step 4: Implement transaction methods**

Use `SELECT ... FOR UPDATE` on `PhoneRecoveryCase` then `User`, CAS on `tokenVersionAtIssue` and `phoneVersionAtIssue`, and the existing phone-alias claim trigger. Completion increments both versions, invalidates outstanding challenges, promotes provisional aliases, and inserts `phone_recovery_completed` before commit.

- [ ] **Step 5: Run embedded PostgreSQL validation**

Run: `npm run prisma:generate && npm run test -w apps/api -- src/lib/phoneRecoveryRepository.test.ts src/lib/smsMfaMigrationState.test.ts && npm exec -w apps/api tsx scripts/phoneRecoveryPostgresValidation.ts`

Expected: migration, state constraints, races, rollback, and audit assertions pass.

- [ ] **Step 6: Run build/lint/diff verification**

Run: `npm run build -w apps/api && npm run lint -w apps/api && git diff --check`

Expected: all commands exit `0`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma apps/api/src/lib/phoneRecoveryRepository.ts apps/api/src/lib/phoneRecoveryRepository.test.ts apps/api/src/lib/smsMfaMigrationState.ts apps/api/src/lib/smsMfaMigrationState.test.ts apps/api/scripts/phoneRecoveryPostgresValidation.ts .github/workflows/ci.yml
git commit -m "feat: add phone recovery state machine"
```

---

### Task 7: Implement administrator initiation and employee email proof

**Files:**
- Create: `apps/api/src/lib/phoneRecoveryService.ts`
- Create: `apps/api/src/lib/phoneRecoveryService.test.ts`
- Create: `apps/api/src/routes/phoneRecovery.ts`
- Create: `apps/api/src/routes/phoneRecovery.http.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/lib/mfaChallengeCookie.ts`

**Interfaces:**
- Consumes: `PhoneRecoveryRepository` and `RecoveryEmailProvider`.
- Produces: administrator initiate/cancel routes and public start/email-check routes from the approved spec.

```ts
export interface PhoneRecoveryService {
  initiate(input: { actorUserId: string; targetUserId: string; now: Date }): Promise<RecoveryCaseView>;
  startEmailProof(input: PublicCaseIdentity): Promise<PublicRecoveryPending>;
  checkEmailCode(input: { challengeId: string; code: string; now: Date }): Promise<EmailProofResult>;
  cancel(input: CancelRecoveryInput): Promise<boolean>;
}
```

- [ ] **Step 1: Write failing service and HTTP tests**

Cover recent-MFA administrator requirement, self-initiation denial, non-admin denial, notice-before-usable case, provider failure/timeout terminality, email/employee/reference mismatch decoy behavior, identical cookie/response contract, eight-digit validation, five-attempt lock, browser binding, expiry, and email proof creating no session.

- [ ] **Step 2: Run focused tests and confirm red**

Run: `npm run test -w apps/api -- src/lib/phoneRecoveryService.test.ts src/routes/phoneRecovery.http.test.ts`

Expected: FAIL because service and routes do not exist.

- [ ] **Step 3: Implement secure code generation and hashing**

```ts
const code = randomInt(0, 100_000_000).toString().padStart(8, "0");
const digest = createHmac("sha256", required("EMAIL_OTP_HMAC_KEY"))
  .update(`${challengeId}:${code}`)
  .digest();
```

Compare fixed-length buffers with `timingSafeEqual`; store only the digest. Generate a 128-bit case reference, display it only to the initiating administrator, and store only its HMAC.

- [ ] **Step 4: Implement routes and generic public contract**

Register `phoneRecoveryRoutes` at `/api/auth`. Use the existing challenge-cookie utility with a recovery-specific cookie name/path and strict attributes. Map all unknown/mismatched public starts to the same `202` body and durable budgets.

- [ ] **Step 5: Run focused verification**

Run: `npm run test -w apps/api -- src/lib/phoneRecoveryService.test.ts src/routes/phoneRecovery.http.test.ts src/lib/verificationRateLimit.test.ts && npm run build -w apps/api && npm run lint -w apps/api && git diff --check`

Expected: all commands exit `0`; audit/redaction assertions pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/phoneRecoveryService.ts apps/api/src/lib/phoneRecoveryService.test.ts apps/api/src/routes/phoneRecovery.ts apps/api/src/routes/phoneRecovery.http.test.ts apps/api/src/index.ts apps/api/src/lib/mfaChallengeCookie.ts
git commit -m "feat: add controlled phone recovery initiation"
```

---

### Task 8: Implement new-phone proof and atomic completion

**Files:**
- Modify: `apps/api/src/lib/phoneRecoveryService.ts`
- Modify: `apps/api/src/lib/phoneRecoveryService.test.ts`
- Modify: `apps/api/src/routes/phoneRecovery.ts`
- Modify: `apps/api/src/routes/phoneRecovery.http.test.ts`
- Modify: `apps/api/src/lib/verificationPolicy.ts`
- Modify: `apps/api/src/lib/verificationPolicy.test.ts`
- Modify: `apps/api/src/lib/mediaAuth.test.ts`
- Modify: `apps/api/src/routes/mfa.http.test.ts`

**Interfaces:**
- Produces: `startPhoneProof`, `checkPhoneCodeAndComplete`, and post-commit notification outcomes.

```ts
startPhoneProof(input: {
  caseId: string;
  emailChallengeId: string;
  phone: string;
  consentVersion: string;
  turnstileToken: string;
  ip: string;
}): Promise<PublicRecoveryPending>;

checkPhoneCodeAndComplete(input: {
  caseId: string;
  smsChallengeId: string;
  code: string;
}): Promise<{ completed: true; notificationWarning: boolean }>;
```

- [ ] **Step 1: Write failing state-mutation tests**

Cover email-proof prerequisite, Turnstile, normalization, consent, multi-key provisional collision, purpose/case/browser/token/phone-version swapping, provider ambiguity, delayed approval, five-attempt lock, concurrent completion, session issuance prohibition, and post-commit notifications.

- [ ] **Step 2: Write failing authoritative-revocation tests**

```ts
it.each(["session", "media-cookie", "media-bearer", "purpose-token"])(
  "revokes the prior %s after phone recovery completes",
  async (credential) => {
    const oldCredential = await issueCredential(credential, oldTokenVersion);
    await completeRecovery();
    expect((await useCredential(oldCredential)).statusCode).toBe(401);
  },
);
```

- [ ] **Step 3: Run focused tests and confirm red**

Run: `npm run test -w apps/api -- src/lib/phoneRecoveryService.test.ts src/routes/phoneRecovery.http.test.ts src/lib/verificationPolicy.test.ts src/lib/mediaAuth.test.ts src/routes/mfa.http.test.ts`

Expected: FAIL because phone proof/completion are absent.

- [ ] **Step 4: Implement SMS proof and completion**

Use `PHONE_RECOVERY_SMS`, the durable SMS queue/provider policy, provisional HMAC aliases, and the repository completion transaction. Return `200 { status: "recovery_complete" }` only after commit. Do not issue a JWT or media cookie.

- [ ] **Step 5: Implement post-commit notices**

Send `recovery_completed` email and a generic old-phone factor-change notice. Record `accepted` or `notification_failed` with stable reason codes and correlation IDs; never roll back the committed replacement.

- [ ] **Step 6: Run focused verification**

Run: `npm run test -w apps/api -- src/lib/phoneRecoveryService.test.ts src/routes/phoneRecovery.http.test.ts src/lib/verificationPolicy.test.ts src/lib/mediaAuth.test.ts src/routes/mfa.http.test.ts && npm run build -w apps/api && npm run lint -w apps/api && git diff --check`

Expected: all commands exit `0`; every stale credential is rejected.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/phoneRecoveryService.ts apps/api/src/lib/phoneRecoveryService.test.ts apps/api/src/routes/phoneRecovery.ts apps/api/src/routes/phoneRecovery.http.test.ts apps/api/src/lib/verificationPolicy.ts apps/api/src/lib/verificationPolicy.test.ts apps/api/src/lib/mediaAuth.test.ts apps/api/src/routes/mfa.http.test.ts
git commit -m "feat: complete verified phone recovery"
```

---

### Task 9: Add employee and administrator recovery interfaces

**Files:**
- Create: `apps/web/app/recover-phone/page.tsx`
- Create: `apps/web/components/PhoneRecoveryWizard.tsx`
- Create: `apps/web/components/PhoneRecoveryAdmin.tsx`
- Create: `apps/web/lib/phoneRecoveryUi.test.ts`
- Modify: `apps/web/app/users/page.tsx`
- Modify: `apps/web/app/login/page.tsx`
- Modify: `apps/web/lib/api.ts`

**Interfaces:**
- Consumes: Task 7/8 HTTP routes.
- Produces: a five-step employee wizard and an admin initiate/cancel/status control.

- [ ] **Step 1: Write failing component-contract tests**

```ts
it("presents identify, email, new-phone, SMS, and completion steps in order", () => {
  expect(source).toContain("Find your recovery request");
  expect(source).toContain('autoComplete="email"');
  expect(source).toContain('autoComplete="one-time-code"');
  expect(source).toContain('autoComplete="tel"');
  expect(source).toContain("Sign in with your new phone");
});
```

Also assert real labels, `aria-describedby`, `role="alert"`, live resend/lockout countdowns, masked destinations, no OTP/case secret in storage or URLs, and explicit cancellation/help paths.

- [ ] **Step 2: Run web tests and confirm red**

Run: `npm run test -w apps/web -- lib/phoneRecoveryUi.test.ts`

Expected: FAIL because the UI does not exist.

- [ ] **Step 3: Implement one-step-at-a-time employee UI**

Use `VerificationCodeForm` for email/SMS inputs, preserving numeric keypad and one-time-code autocomplete. Display accepted-for-delivery language, not delivered claims. Clear local component state on restart, cancellation, completion, and `401`.

- [ ] **Step 4: Implement administrator UI**

Show target employee, safe status, expiry, and initiate/cancel actions. Require a recent session and never display phone/email destinations, codes, or provider detail.

- [ ] **Step 5: Run focused verification**

Run: `npm run test -w apps/web -- lib/phoneRecoveryUi.test.ts && npm run build -w apps/web && npm run lint -w apps/web && git diff --check`

Expected: focused tests, 31-or-more route production build, lint, and diff check pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/recover-phone/page.tsx apps/web/components/PhoneRecoveryWizard.tsx apps/web/components/PhoneRecoveryAdmin.tsx apps/web/lib/phoneRecoveryUi.test.ts apps/web/app/users/page.tsx apps/web/app/login/page.tsx apps/web/lib/api.ts
git commit -m "feat: add guided phone recovery interface"
```

---

### Task 10: Complete operations documentation and acceptance evidence

**Files:**
- Modify: `docs/SMS-MFA-OPERATIONS.md`
- Modify: `docs/SMS-MFA-PHYSICAL-ACCEPTANCE.md`
- Modify: `docs/security/sms-mfa-baseline.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: final API/UI/provider behavior.
- Produces: a deployable configuration/runbook and exact recovery acceptance matrix.

- [ ] **Step 1: Add operations assertions**

Document SendGrid restricted key creation/rotation, verified sender/domain, recovery email outage behavior, case cancellation/reaping, audit reason codes, provisional-claim cleanup, and emergency sole-admin handling. Document the unavoidable possibility of two SMS messages after an ambiguous Twilio start timeout.

- [ ] **Step 2: Add user-facing duplicate-SMS copy and contract test**

```ts
expect(verificationFormSource).toContain("If you requested another code recently, more than one text may arrive. Use the newest code.");
```

- [ ] **Step 3: Extend physical acceptance**

Add real iPhone rows for admin initiation, immediate email notice, wrong email OTP, five-attempt lock, correct email OTP, conflicting replacement phone, correct new-phone SMS, old-session rejection, fresh login, cancellation, expiry, and notification outcomes. Require redacted evidence and exact deployment SHA.

- [ ] **Step 4: Run documentation/config checks**

Run: `git diff --check && npm run test -w apps/api -- src/lib/twilioVerifyProvider.test.ts src/lib/twilioRestrictedKeyPolicy.test.ts src/lib/phoneRecoveryService.test.ts && npm run test -w apps/web -- lib/phoneRecoveryUi.test.ts`

Expected: all commands exit `0` and no placeholder text remains.

- [ ] **Step 5: Commit**

```bash
git add docs/SMS-MFA-OPERATIONS.md docs/SMS-MFA-PHYSICAL-ACCEPTANCE.md docs/security/sms-mfa-baseline.md .github/workflows/ci.yml apps/web/components/VerificationCodeForm.tsx apps/web/lib/phoneRecoveryUi.test.ts
git commit -m "docs: add phone recovery operating contract"
```

---

### Task 11: Run the release checkpoint and hostile review

**Files:**
- Modify only if evidence changes: `docs/SMS-MFA-PHYSICAL-ACCEPTANCE.md`
- Create outside git: a sanitized exact-commit source archive and adversarial prompt.

**Interfaces:**
- Consumes: Tasks 1-10.
- Produces: a clean exact local commit with complete reproducible evidence and no unresolved Critical/Important code finding.

- [ ] **Step 1: Fresh dependency and generation checkpoint**

Run: `npm ci && npm run prisma:generate && npm ls mysql2 deepmerge-ts prisma @prisma/client`

Expected: clean install, Prisma generation, `prisma@7.10.0`, `@prisma/client@7.10.0`, `mysql2@3.24.3`, and `deepmerge-ts@8.0.2` without invalid peers.

- [ ] **Step 2: Run every local test/build/lint/audit gate**

Run: `npm run test && npm run build && npm run lint && npm audit --omit=dev --audit-level=high && npm audit --audit-level=high`

Expected: zero failed tests, builds exit `0`, lint has zero errors, and both audits report zero vulnerabilities.

- [ ] **Step 3: Run PostgreSQL validation**

Run the CI `database-validation` commands against a disposable PostgreSQL 17 database, including all migration-state, phone-alias, recovery-case, concurrency, audit, bootstrap, and tenant-isolation scripts.

Expected: fresh install and upgrade paths pass with no unapplied/rolled-back migration and no failed invariant.

- [ ] **Step 4: Review the complete diff**

Run: `git diff --check && git status --short && git log --oneline --decorate -20`

Expected: diff check exits `0`, worktree is clean, and every task is an isolated verified commit.

- [ ] **Step 5: Request the final destructive review**

Give the reviewer the exact source archive, spec, plan, commands/results, migration logs, and this mandate: attempt factor bypass, admin seizure, enumeration, replay, purpose swapping, provider ambiguity, session survival, duplicate phone ownership, lockout reset, case races, restore bypass, PII leakage, and mobile recovery dead ends.

Expected: no reproducible Critical or Important code finding. Any valid finding returns to a new red/green task before release.

- [ ] **Step 6: Hold external acceptance gates**

Do not push, open a PR, merge, or deploy until the code review is clear. Then require exact-SHA hosted PostgreSQL CI, live Twilio and SendGrid policy/config validation, controlled Railway deployment, and the complete physical iPhone matrix before declaring pilot readiness.
