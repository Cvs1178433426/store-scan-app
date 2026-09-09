# SMS MFA Final Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every remaining Important finding from the full-branch SMS-first MFA review before asking Claude for a final adversarial verdict.

**Architecture:** Keep identity-sensitive public responses indistinguishable, bind all factor changes to a recent different verified factor, and make every security transition atomic in PostgreSQL. Provider uncertainty must invalidate the current challenge and produce one retry contract; production startup must fail before listening when database/configuration invariants cannot be proven.

**Tech Stack:** TypeScript, Fastify, Prisma 7.10, PostgreSQL, Next.js, Vitest, Twilio Verify/Messaging, Cloudflare Turnstile.

**Spec:** `docs/superpowers/specs/2026-09-01-sms-mfa-design.md`

## Global Constraints

- SMS remains the default same-phone factor; authenticator and recovery codes are optional backups.
- Password possession alone cannot enroll, replace, or remove a factor.
- Recovery PIN and administrator-reset bypasses remain permanently disabled.
- Raw phone numbers, OTPs, recovery codes, secrets, and provider payloads never enter logs or audit rows.
- No push, pull request, merge, rollout, or deployment while a Critical or Important finding remains.
- Every behavior change follows a demonstrated red/green regression cycle and receives an independent adversarial review.

---

### Task 1: Identity-indistinguishable public starts

**Files:**
- Modify: `apps/api/src/routes/registration.ts`
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/routes/registration.http.test.ts`
- Modify: `apps/api/src/routes/passwordRecovery.http.test.ts`
- Create if needed: `apps/api/src/lib/publicAuthResponse.ts`

- [ ] Write delayed-provider tests comparing known, unknown, conflicting, and provider-failure responses.
- [ ] Verify the tests fail because provider latency leaks account state.
- [ ] Add one bounded, shared public-response timing contract without logging identity data or falsely claiming delivery.
- [ ] Verify focused route tests, API build, lint, and diff checks.
- [ ] Commit independently.

### Task 2: Verified phone replacement and recovery-code regeneration

**Files:**
- Modify: `apps/api/src/routes/mfa.ts`
- Modify: `apps/api/src/lib/verificationPolicy.ts`
- Modify: `apps/api/src/routes/mfa.http.test.ts`
- Modify: `apps/web/components/SecurityFactors.tsx`
- Modify: `apps/web/lib/api.ts`
- Modify: `apps/web/lib/authRecoveryUi.test.ts`

- [ ] Write failing HTTP/service tests for current-different-factor proof, new-phone SMS approval, atomic phone replacement, token-version bump, audit, notification, and one-time recovery-code regeneration.
- [ ] Implement the minimum route/service/UI changes using challenge-purpose binding.
- [ ] Verify old sessions/cookies/codes are revoked and recovery codes appear once.
- [ ] Run focused API/web tests, builds, lint, and diff checks.
- [ ] Commit independently.

### Task 3: Provisional phone ownership

**Files:**
- Modify: `apps/api/src/lib/registrationService.ts`
- Modify: `apps/api/src/routes/mfa.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_provisional_phone_claims/migration.sql`
- Modify: matching registration/enrollment/migration tests.

- [ ] Write a failing concurrency test proving an abandoned, unverified enrollment cannot permanently block another verified owner.
- [ ] Separate expiring provisional claims from durable aliases; promote only in the approval transaction.
- [ ] Verify competing approvals serialize and only one verified owner can win.
- [ ] Run focused tests and disposable PostgreSQL migration validation.
- [ ] Commit independently.

### Task 4: Outage-safe backup recovery

**Files:**
- Modify: `apps/api/src/lib/passwordRecoveryService.ts`
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/routes/passwordRecovery.http.test.ts`
- Modify: `apps/web/app/forgot-password/page.tsx`

- [ ] Write failing tests for starting TOTP/recovery-code password recovery while SMS delivery is unavailable.
- [ ] Start a method-bound local challenge without contacting Twilio after identifier lookup and pre-lookup abuse-budget enforcement.
- [ ] Preserve generic public responses and challenge cookies for known and unknown identifiers.
- [ ] Verify focused API/web tests, build, lint, and diff checks.
- [ ] Commit independently.

### Task 5: Uniform ambiguous-provider recovery

**Files:**
- Modify: `apps/api/src/lib/verificationPolicy.ts`
- Modify: all MFA/registration/recovery route handlers.
- Modify: focused policy and HTTP tests.

- [ ] Write failing tests for an ambiguous check result on every SMS completion route.
- [ ] Invalidate the challenge, clear its cookie, and return one stable retry-required response without consuming an incorrect attempt.
- [ ] Verify a fresh challenge is required and no protected mutation/session occurs.
- [ ] Run focused security tests, API build, lint, and diff checks.
- [ ] Commit independently.

### Task 6: Complete immutable security auditing

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_security_audit_integrity/migration.sql`
- Modify: registration, login, enrollment, factor-change, recovery, lockout, and configuration services/routes.
- Modify: focused audit and PostgreSQL tests.

- [ ] Enumerate every security transition and write failing tests for missing success/failure events.
- [ ] Add safe reason codes and correlation IDs only; prohibit sensitive fields.
- [ ] Add database guards preventing audit UPDATE/DELETE.
- [ ] Verify transactional success events, best-effort denial events, redaction, and append-only PostgreSQL behavior.
- [ ] Commit independently.

### Task 7: Production startup enforcement

**Files:**
- Modify: `apps/api/src/lib/verificationProvider.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `.env.example`
- Modify: `.github/workflows/ci.yml`
- Modify: startup/configuration/PostgreSQL tests and `docs/SMS-MFA-OPERATIONS.md`.

- [ ] Write failing tests for absent migration deadline, unapplied migrations, master-token style credentials, shared Verify/notification keys, and invalid restricted-key SIDs.
- [ ] Validate exact required migration state before the server listens when SMS MFA is enabled.
- [ ] Reject ambiguous/overprivileged credential configurations and require separate restricted API keys.
- [ ] Verify focused tests plus disposable PostgreSQL validation.
- [ ] Commit independently.

### Task 8: Release checkpoint and Claude packet

- [ ] Run fresh install/generation, all API/web tests, PWA regression, builds, lint, production/full audits, PostgreSQL fresh/upgrade validation, diff check, and clean-status check.
- [ ] Request an independent hostile review of the complete branch diff; fix every valid Critical/Important finding with another red/green cycle.
- [ ] Create a sanitized exact-commit source archive and a Claude prompt listing requirements, attack surfaces, evidence, and external gates.
- [ ] Do not push or deploy; report the exact local commit and any remaining external acceptance actions.
