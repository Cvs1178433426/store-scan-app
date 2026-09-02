# ContinuiXAi SMS-First MFA Design

Date: 2026-09-01
Status: Owner-approved; implementation in progress
Target branch: `chatgpt-development`

## Purpose

Replace the impractical same-phone QR requirement as the default enrollment path with six-digit SMS verification. SMS is the required primary MFA method for every account. TOTP authenticator apps remain an optional, stronger backup. Existing users keep their current TOTP access until SMS enrollment has passed production acceptance.

The pilot uses Twilio Verify. ContinuiXAi owns authentication policy and state, but it does not generate, receive, store, or log SMS verification codes. The implementation must isolate Twilio behind a provider interface so AWS End User Messaging or another provider can replace it without changing the public authentication routes or user experience.

SMS is possession-based and is not phishing-resistant. The product must not describe it as stronger than TOTP. TOTP remains the recommended backup for administrators and other privileged users.

## Goals

- Require a verified mobile number for every new account.
- Make same-phone registration and login practical.
- Preserve TOTP and recovery codes as backup methods.
- Prevent SMS abuse, enumeration, replay, and browser-side lockout bypasses.
- Encrypt mobile numbers while retaining a safe uniqueness constraint.
- Preserve the existing first-user administrator bootstrap safely.
- Provide a clean future migration path from Twilio to AWS.
- Keep current users able to sign in during rollout.

## Non-goals

- Replacing the existing password and JWT/session system with Amazon Cognito.
- Building or storing proprietary SMS verification codes.
- Supporting email-only MFA.
- Removing TOTP before SMS production acceptance.
- Silently bypassing MFA during a provider outage.
- Merging the feature into `master` before physical acceptance.

## Architecture

### Provider boundary

Add an application-owned `MfaVerificationProvider` interface with operations equivalent to:

- `startVerification(destination, context)`
- `checkVerification(destination, code, context)`

The provider boundary is deliberately narrow: it can start delivery and answer whether a submitted code matched. ContinuiXAi—not the provider—owns challenge expiry, attempt counts, rate limits, lockouts, and all application-visible status semantics. Twilio-specific SIDs, errors, and response shapes stay inside the Twilio adapter. This contract must remain implementable by a provider that returns only a match/no-match result.

Production uses `TwilioVerifyProvider`. Automated tests use an in-memory fake provider. Provider selection is configuration-driven. No API route, database model, or React component imports the Twilio SDK directly.

Twilio credentials and the Verify Service SID are server-only environment variables. Production uses a Restricted API Key granting only the Verify endpoint permissions required to start and check verifications, never the master Auth Token. Credentials rotate at least every 90 days and immediately after suspected exposure. Startup must fail closed in production when SMS MFA is enabled but required configuration is missing.

### Security notification boundary

Verification codes and ordinary security notices are separate capabilities. `TwilioVerifyProvider` remains limited to starting and checking OTP verifications. It must never be used to simulate a factor-change notification.

Add an application-owned `SecurityNotificationProvider` interface with one operation equivalent to `notifyFactorChanged(destination, event, correlationId)`. Production uses `TwilioMessagingNotificationProvider` backed by Twilio Programmable Messaging. Automated tests use a deterministic fake provider. API routes, database models, and React components do not import Twilio-specific code.

The notification adapter uses a dedicated Restricted API Key and Messaging Service SID. Its permissions are separate from the Verify adapter, and the master Auth Token is forbidden. Required server-only configuration is `TWILIO_ACCOUNT_SID`, `TWILIO_NOTIFICATION_API_KEY_SID`, `TWILIO_NOTIFICATION_API_KEY_SECRET`, and `TWILIO_MESSAGING_SERVICE_SID`. The notification key follows the same 90-day rotation and suspected-exposure rules as the Verify key.

Factor removal is unavailable when the notification adapter is not configured; the start route returns a stable `503` before issuing a `FACTOR_REMOVAL` challenge. After configuration passes, the removal flow requires a recent, method-bound challenge using a different factor. The database transaction consumes that challenge, clears the selected factor, increments `tokenVersion`, invalidates sessions, and records the factor-removal audit event atomically.

Only after that transaction commits does the adapter request a generic notice to the pre-existing verified phone number. The notice identifies that an authentication factor changed and directs the user to contact support if it was unexpected. It contains no OTP, recovery code, password, TOTP secret, or full phone number. Twilio acceptance means only that the request was accepted for delivery; the application must not describe it as delivered.

If Twilio rejects or times out after the security transaction commits, the factor removal remains effective. Record a separate `notification_failed` audit outcome with a non-PII correlation ID and stable reason code, return an honest warning to the signed-in user, and do not recreate the removed factor or restore invalidated sessions. Logs and audit records contain neither the destination nor provider credentials.

### Code ownership

Twilio Verify owns OTP generation, delivery, expiration, and code comparison. ContinuiXAi never receives the generated code and never stores submitted codes. ContinuiXAi sends the user-entered code directly to the provider over the server-side adapter and stores only policy/audit outcomes.

### Phone-number representation

Accept a user-friendly phone input and normalize it server-side to E.164. Store:

- `phoneEncrypted`: authenticated encryption of the E.164 number for future delivery.
- `phoneLookupHash`: keyed HMAC of the normalized E.164 number for uniqueness and lookup.
- `phoneLast4`: last four digits for masking only.
- `phoneVerifiedAt`: verification completion time.

The HMAC key and encryption key are separate secrets. A unique database constraint applies to `phoneLookupHash`. Raw numbers must not appear in routine logs, error telemetry, audit metadata, URLs, or analytics.

## User and Authentication State

Add an explicit account status:

- `PENDING_PHONE_VERIFICATION`
- `ACTIVE`
- `DISABLED`

`accountStatus` is the source of truth. During the additive migration, the existing `isActive` column remains for compatibility but a database check constraint makes disagreement impossible: `isActive` is true if and only if `accountStatus = ACTIVE`. Every state transition updates both fields in one transaction. The central authentication hook enforces both during rollout, and cross-route integration tests cover every protected route before release. A later migration may remove `isActive` only after all references are eliminated.

New registrations begin in `PENDING_PHONE_VERIFICATION` with `isActive = false`. They receive no authenticated session, organization access, or application data until SMS verification succeeds.

The first successfully verified user becomes the pilot administrator only after phone verification succeeds. The verification-approval handler acquires the existing PostgreSQL advisory transaction lock, rechecks whether an active owner already exists, activates the user, and assigns the first-user role inside the same database transaction. Simultaneous approvals can create exactly one first administrator.

Track the preferred MFA method separately from whether TOTP is enrolled. SMS remains the required default. TOTP can be enrolled after account activation and used as a backup.

## Registration Flow

1. User enters full name, business email, mobile number, password, and current required registration fields.
2. User explicitly consents to receive transactional security texts and sees that message/data rates may apply, how the number will be used, and links to applicable terms and privacy information.
3. Server validates and normalizes the email and phone number.
4. Server rejects duplicate email or phone-hash conflicts with a generic response that does not disclose which identifier exists.
5. Server creates or resumes a pending registration only when normalized email and phone HMAC both exactly match the existing pending row. A match on only one identifier is a conflict: return the same generic response and never mutate the existing destination. Record consent timestamp, policy version, source flow, and a non-PII request correlation key.
6. Server applies local policy limits and requests an SMS verification from the provider.
7. UI shows the masked destination, six-digit code field, countdown, and available backup actions.
8. Successful provider approval activates the account, sets `phoneVerifiedAt`, completes first-user bootstrap when applicable, creates the authenticated session, and writes an audit event.
9. Expired, incorrect, blocked, or provider-failed verification never activates the account.

Pending registrations expire after 24 hours and may be safely restarted. Cleanup conditions deletion on both pending status and observed version so it cannot delete a newly activated account. Duplicate and new-registration responses use a minimum server-controlled response duration plus jitter so identifier conflicts do not create a useful timing oracle.

## Login Flow

1. User submits identifier and password.
2. Server validates credentials using the existing generic failure response.
3. Active users receive a ten-minute, purpose-, method-, user-, token-version-, and destination-bound MFA challenge—not an authenticated application session.
4. SMS is sent to the verified encrypted phone destination unless the user explicitly chooses an enrolled backup method.
5. Successful SMS, TOTP, or recovery-code verification creates the authenticated session.
6. The challenge identifier is transported only in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie. It never appears in a URL, browser storage, analytics, or client-readable JSON. Switching methods invalidates the current challenge and mints a new method-scoped challenge.

The UI must show `Send text to (***) ***-1234` as the default. `Use authenticator app` and `Use a recovery code` appear only when those methods are enrolled.

## Limits and Lockouts

Enforce limits server-side. Browser state is informational only.

- Maximum three SMS starts per phone/account within 15 minutes.
- Maximum five incorrect code checks per verification challenge.
- Maximum ten SMS starts per phone/account in 24 hours.
- Fifteen-minute lockout after a short-term limit is exceeded.
- Successful verification clears the relevant short-term incorrect-attempt counter.
- A configurable global circuit breaker and per-prefix velocity alert stop abnormal aggregate send volume even when requests rotate accounts, phone numbers, and IP addresses.

Meter by account ID when known, phone lookup hash, IP-derived non-PII key, and provider-supported rate-limit keys. Do not send raw PII as Twilio rate-limit key names or audit metadata. Twilio Fraud Guard and geo permissions remain enabled.

Lockout responses include a safe `Retry-After` value and the message: `Too many verification attempts. Please try again in 15 minutes.` Responses must not reveal whether the email or phone number belongs to an account.

Provider rate limits supplement local limits; they do not replace them. Local policy must still work with the fake provider and a future AWS adapter. Before the first send to a never-verified destination, registration requires a Cloudflare Turnstile token verified server-side through Siteverify; client-side success alone is never trusted. Repeated or suspicious requests require a fresh token. Turnstile configuration is isolated behind a proof-of-humanity interface so it can be replaced, and its accessible failure/help path is part of acceptance.

## Resend and Expiration

The resend control is disabled for 30 seconds after a successful send request. The server remains authoritative even if the browser timer is altered. The UI must not claim that a new code was sent unless the provider accepted the request.

Provider expiration controls whether a submitted SMS code is valid. The UI describes the code as expiring in ten minutes only while that matches the configured Twilio Verify behavior. Configuration or provider changes must update the displayed policy from a server-owned value rather than duplicated client constants.

## TOTP Backup

Current TOTP logic remains available. New users can add Google Authenticator or Microsoft Authenticator only after SMS activation. Same-phone setup must always show the manual secret in addition to the QR code.

TOTP secrets remain encrypted with the existing MFA encryption boundary. TOTP enrollment requires proof of a valid generated code before it becomes active.

## Recovery Codes

Generate a new set of single-use recovery codes after primary MFA enrollment. Store only strong hashes. Display the plaintext codes once with clear save/print instructions. Consuming a code removes it atomically and writes an audit event.

Regenerating recovery codes requires recent MFA and invalidates all older recovery codes. Recovery codes must never be returned from ordinary user/profile APIs.

The existing six-digit Recovery PIN is retired before SMS MFA is enabled. `/recover/user-id` and `/recover/password` no longer accept it, registration no longer collects it, and existing PIN hashes are cleared only after the replacement recovery path is deployed and verified. Password recovery requires a valid method-scoped SMS, TOTP, or single-use recovery-code challenge and never creates an authenticated session by itself. Tests must prove the legacy endpoints cannot recover an account with a PIN.

## Phone Change and Account Recovery

A signed-in phone-number change normally requires:

1. Recent MFA on the current account.
2. Verification of the current phone or an enrolled TOTP/recovery code.
3. Verification of the new phone.
4. Atomic replacement of encrypted phone data and lookup hash.
5. Incrementing `tokenVersion` to invalidate active sessions.
6. Security audit and user notification.

Administrator-assisted factor replacement is not available in the pilot. An administrator may disable an account but cannot reset TOTP, replace a phone, generate recovery codes, or activate a user on the user's behalf. A later assisted-recovery design requires a separate security review, verified-channel notifications, objection/cancellation handling, separation of duties, and privileged-admin step-up before it can be enabled.

Because telephone numbers can be reassigned and SMS can be compromised through SIM-swap attacks, recovery cannot rely on possession of a new number alone. Privileged users must enroll TOTP and retain recovery codes before normal operation. Removing any enrolled factor—including TOTP—requires recent MFA using a different enrolled factor, increments `tokenVersion`, invalidates active sessions, and sends a security notification to the existing verified phone.

Administrators cannot view OTPs, recovery codes, full phone numbers, TOTP secrets, or provider credentials.

## Error Handling

- Fail closed when the verification provider is unavailable.
- Offer `Resend code`, an enrolled authenticator, or a recovery code; never bypass MFA.
- Map provider errors to stable, generic user messages.
- Preserve enough non-PII diagnostic detail and correlation IDs for support.
- Do not create an authenticated session on ambiguous or timed-out provider responses.
- Make activation and recovery transitions idempotent so retried requests cannot duplicate bootstrap or consume a recovery code twice.
- If a provider check times out or its response is lost, do not count it as a wrong code and do not create a session. Twilio deletes approved verification resources, so the application must not claim it can safely replay the same provider check. Invalidate the local challenge, offer a fresh send immediately without an incorrect-attempt penalty, and record the ambiguous outcome.

## Audit Events

Record at least:

- registration verification requested, approved, expired, blocked, or failed;
- login MFA requested, approved, blocked, or failed;
- short-term and daily lockouts;
- TOTP enrollment or removal;
- recovery-code generation, consumption, and regeneration;
- phone-change start and completion;
- account disablement and any attempted administrator factor reset;
- session invalidation caused by a security change.

Audit records contain actor, target user, tenant where applicable, timestamp, outcome, method, safe reason code, and correlation ID. They do not contain OTPs, raw phone numbers, secrets, recovery codes, passwords, or Twilio credentials.

## Migration and Rollout

1. Add schema and provider abstraction without changing current login behavior.
2. Add SMS enrollment and verification behind a rollout flag.
3. Enroll the pilot administrator using the real iPhone.
4. Keep TOTP login working for all existing users.
5. Give existing users a 30-day enrollment window with in-app reminders. After the deadline, password plus existing TOTP may access only the phone-enrollment flow, not application data. Users without a working existing factor require security support and remain disabled—there is no silent grace period or MFA bypass.
6. Do not remove current TOTP enrollment or reset existing secrets automatically.
7. Deploy only to `chatgpt-development` first.
8. Do not merge into `master` until physical acceptance and rollback readiness are documented.

Provider metrics must track requests, approvals, failures, lockouts, delivery problems, global-circuit-breaker events, and estimated cost without storing raw phone numbers. Review provider cost around 10,000 verifications per month or earlier if Twilio spend becomes material. The pilot is limited to United States numbers; international consent, delivery, and regulatory requirements require a later review.

The pilot assumes one individually controlled mobile number per user, so `phoneLookupHash` remains unique. Before onboarding employees beyond the named pilot, the pilot-site owner must confirm this assumption. Shared devices require a separately designed kiosk/shared-device authentication mode and must not be simulated by weakening phone uniqueness.

### Key rotation and access

Phone encryption and lookup-HMAC keys are versioned. Writes use the current key version; reads accept the current and immediately previous versions during a rotation. HMAC rotation backfills a second indexed lookup hash in batches, verifies coverage and uniqueness, switches reads and writes, then retires the old hash and key. Rollback retains the prior key until post-rotation verification completes.

Only the API runtime identity may read the phone-encryption key. Support tools, BI exports, developer shells, client bundles, CI logs, and ad hoc scripts may not receive it. Backup/restore runbooks must restore matching versioned keys or explicitly accept that encrypted phone data will be unusable.

## Testing

### Unit and contract tests

- Provider-neutral status mapping.
- E.164 normalization, encryption/decryption, masking, and HMAC uniqueness.
- Consent recording and policy-version preservation.
- Challenge expiration and purpose binding.
- Send, incorrect-entry, and daily rate limits.
- Generic enumeration-safe responses.
- Recovery-code atomic consumption.
- Session invalidation after security changes.
- Twilio adapter request/response and error mapping using controlled fixtures.
- Challenge method/destination binding and cookie security attributes.
- HMAC dual-key rotation and rollback.
- Duplicate and delayed SMS handling.

### Database and HTTP integration tests

- Pending accounts cannot authenticate or access tenant data.
- Duplicate normalized phone numbers are rejected safely.
- Pending resume rejects email/phone mismatches without mutating the original row.
- First-user bootstrap occurs once and only after phone verification.
- Two concurrent first-user approvals produce exactly one administrator.
- Lockouts survive refreshes, browser changes, and new sessions.
- Provider retries cannot double-activate accounts.
- Removing TOTP or another factor requires recent MFA using a different factor.
- Privileged accounts cannot complete rollout without an enrolled non-SMS backup.
- Audit rows contain required fields and no prohibited secrets or raw PII.
- Existing TOTP users continue to authenticate during rollout.
- Users past the migration deadline can access enrollment only, not application data.
- Legacy Recovery PIN endpoints cannot recover or authenticate an account.

### Security tests

- Altered challenge tokens and token-purpose confusion are rejected.
- Replayed approvals, recovery codes, and activation calls are rejected or idempotent.
- API and logs never expose full phone numbers or verification codes.
- Rate limits apply across account, phone-hash, and IP-derived keys.
- Aggregate velocity triggers the global circuit breaker.
- Password success alone never creates an authenticated session when MFA is required.
- Duplicate and new-registration paths remain within the defined response-timing tolerance.

### Provider testing

Automated suites use the fake provider and do not send paid SMS. Twilio trial testing uses only a preverified destination number. Before production acceptance, confirm the Twilio account is upgraded, the Restricted API Key has only required Verify permissions, geo permissions are US-only, and a live send succeeds without trial destination restrictions. No status-callback webhook is required for v1. If one is later added, it must validate Twilio's signature and may update telemetry only—never authentication or activation state.

SMS remains the required pilot enrollment channel. A voice fallback is deferred because it adds another abuse and cost surface; a confirmed delivery failure produces a support message rather than an insecure activation path. Broader rollout requires measuring delivery failures and separately approving either voice verification under the same controls or another verified fallback.

## Physical Acceptance

Using `Mitchell.Kobran@ContinuiXAi.com` and the pilot iPhone:

1. Confirm a visible build marker matches the exact deployed candidate SHA; if it does not, clear Safari site data/service-worker state and reload before testing.
2. Register with the required mobile number.
3. Confirm the masked number is correct.
4. Receive and approve the SMS code.
5. Confirm the account activates only after approval.
6. Sign out and complete an SMS-protected login.
7. Submit one incorrect code and verify safe feedback.
8. Confirm the resend countdown and successful resend.
9. Confirm the same-phone flow requires no QR scan.
10. Enroll TOTP using the manual key or QR from another device.
11. Save recovery codes and consume exactly one.
12. Confirm the used recovery code cannot be reused.
13. Confirm sign-out/session invalidation behavior after a security change.
14. Confirm duplicate/delayed messages cannot approve an expired or replaced local challenge.

Acceptance evidence records the visible deployed SHA/build marker, CI run, Railway deployment, device/browser version, steps completed, outcomes, and screenshots with OTPs, recovery codes, phone numbers, and other secrets redacted.

## Rollback

The rollout flag can stop new SMS enrollment while preserving existing TOTP sign-in. Rollback must not strand SMS-enrolled users: before broad rollout, ensure every enrolled user has an alternate recovery path or retain the deployed SMS verification route until migration is complete. Database migrations are additive during the pilot and must not destructively remove existing MFA fields.

## Required Configuration

- Twilio Account SID
- Twilio Restricted API Key SID and secret with only required Verify permissions
- Twilio Verify Service SID
- Phone encryption key
- Phone lookup HMAC key
- SMS MFA rollout flag
- Cloudflare Turnstile site key and server-side secret
- Server-owned policy values for resend, attempt, daily, and lockout limits

Secrets are configured in the deployment environment, never committed to the repository, embedded in the client bundle, or printed in CI output.

## Acceptance Gate

The feature is complete only when:

- all automated test, build, lint, audit, and PostgreSQL validation jobs pass on the exact candidate SHA;
- independent security/code review has no unresolved Critical or Important findings;
- Railway deployment succeeds on that exact SHA;
- the complete physical iPhone acceptance sequence passes;
- rollback and existing-user access are verified;
- the result is documented before any merge into `master`.

## Adversarial Review Resolution

The 2026-09-01 Claude review returned `BLOCK`. This revision resolves its findings as follows:

| Finding | Resolution |
|---|---|
| C1 | Retire Recovery PIN registration and recovery endpoints before enabling SMS MFA. |
| C2 | Resume only on exact normalized email plus phone-HMAC match; never mutate on a partial match. |
| C3 | Remove administrator-assisted factor replacement from the pilot. |
| C4 | Require recent MFA with a different factor before removing any factor. |
| C5 | Make `accountStatus` authoritative and constrain `isActive` to agree at the database boundary. |
| C6 | Perform first-admin selection inside the SMS-approval transaction under the existing advisory lock. |
| I1-I3 | Add Turnstile, aggregate circuit breaking, and timing-normalized generic registration responses. |
| I4 | Add a versioned dual-key HMAC/encryption rotation and rollback runbook. |
| I5 | Fail closed on ambiguous provider checks and issue a fresh challenge without a wrong-attempt penalty. |
| I6-I7 | Use a secure HttpOnly challenge cookie bound to one method and destination. |
| I8 | Use a least-privilege Twilio Restricted API Key with rotation. |
| I9 | Omit webhooks from v1; require signature validation and telemetry-only effects if added later. |
| I10 | Keep expiry, attempts, limits, and visible statuses application-owned; adapters only send and match. |
| I11 | Defer voice for the pilot rather than silently activate; measure failures before approving another channel. |
| I12 | Define the 30-day migration deadline and enrollment-only state. |
| I13 | Preserve one-phone-per-user uniqueness and require a pilot-site readiness confirmation; shared devices need a separate mode. |
| I14-I16 | Add build-marker verification, paid-account/live-delivery checks, and strict encryption-key access boundaries. |
| M1-M6 | Acknowledge masked last-four exposure; redact acceptance evidence; limit pilot geography; add accessibility, delayed-message, and key-aware backup tests/runbooks. |

One factual qualification: the current Recovery PIN does not directly mint an authenticated session, so the review's phrase “skips MFA entirely” overstates the present code. It can independently reset a password and reveal account identifiers, which is still too weak to retain beside mandatory MFA; retirement remains the chosen correction.
