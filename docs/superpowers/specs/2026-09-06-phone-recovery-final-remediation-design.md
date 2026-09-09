# ContinuiXAi Lost-Phone Recovery and Final MFA Remediation Design

Date: 2026-09-06
Status: Owner-approved design; implementation pending
Target branch: `feat/sms-first-mfa`
Supersedes: the pilot prohibition on administrator-assisted recovery in `2026-09-01-sms-mfa-design.md`

## Purpose

Close the final release-blocking gaps found by the independent adversarial review without weakening the SMS-first trust model. The primary change is a recoverable but non-silent lost-phone workflow. An administrator may initiate a recovery case, but only the employee can complete it by proving control of the registered email address and the replacement phone.

The same checkpoint closes four bounded findings: legacy restore incompatibility, login timing enumeration, non-constant-work recovery-code checks, and the absence of one explicit five-attempt/fifteen-minute verification lock.

## Non-negotiable invariants

- A password, administrator session, new phone number, or registered email address alone cannot replace a factor.
- Administrators can initiate and cancel a recovery case, but cannot obtain the employee's verification codes or complete the replacement.
- The employee must prove both registered-email possession and replacement-phone possession.
- A recovery request immediately alerts the registered email address. If that notification cannot be accepted by the provider, no usable recovery case is created.
- The replacement is one atomic PostgreSQL transition: consume proof, replace phone identity, increment `phoneVersion` and `tokenVersion`, revoke prior sessions and outstanding challenges, and append the success audit event.
- Phone uniqueness remains database-enforced across every active HMAC key version. Unverified replacement numbers use expiring provisional claims and never displace an existing verified owner.
- Public recovery responses do not disclose whether an email, employee number, case, or phone belongs to an account.
- Five incorrect verification submissions across replacement challenges trigger one durable fifteen-minute lock. Resending or changing browsers cannot reset it.
- Recovery PINs and the legacy administrator MFA-reset endpoint remain disabled.
- No raw email OTP, SMS OTP, phone number, recovery code, password, secret, provider response, or credential enters logs, audit rows, URLs, analytics, or client storage.

## Chosen recovery model

### Why this model

The approved model uses administrator initiation, registered-email verification, and new-phone SMS verification. This provides two independent controls without relying on security questions, which are guessable and difficult to administer, or on recovery codes, which many frontline employees will not retain.

Mandatory recovery-code-only recovery was rejected because it preserves the ordinary SMS-only lockout. Two-administrator approval with a fixed delay was rejected for the pilot because it is operationally slow and still lacks employee-controlled proof. A delay is unnecessary when both registered email and the new phone are independently verified; the registered-email proof is the required secondary confirmation.

### Provider boundary

Add an application-owned `RecoveryEmailProvider` with two capabilities:

- send an immediate generic recovery-request notice;
- send a short-lived recovery OTP.

The first production adapter uses a separately keyed SendGrid mail-send credential. Routes and services depend only on the application interface, and tests use a deterministic fake. Provider credentials are server-only, separately scoped, and subject to production startup validation. Email provider failure is fail-closed for case creation and verification.

ContinuiXAi generates an eight-digit email OTP with a cryptographically secure generator and stores only an HMAC-SHA-256 value under a dedicated email-OTP pepper. The OTP expires after ten minutes, is compared with a timing-safe operation, and shares the durable five-attempt lock. A resend invalidates the prior value before creating a replacement. The plaintext exists only long enough to hand to the provider adapter and is never logged, audited, or returned by an API.

The notice says that phone recovery was requested, identifies the organization and expiration time, and tells the employee how to cancel or contact an administrator. It contains no phone number, OTP, password, or privileged account detail.

## Recovery flow

### 1. Administrator initiation

An authenticated administrator with a recent SMS, TOTP, or recovery-code authentication selects the employee and starts a recovery case. The route accepts only a target user identifier; the administrator does not supply the replacement phone.

The service locks the target user, verifies `ACTIVE` state and an existing verified phone, cancels any older open case, and creates one `NOTICE_PENDING` case tied to the target `tokenVersion`. After commit it requests the registered-email notice. A second transaction changes the case to `PENDING_EMAIL` and appends `phone_recovery_requested` only when the provider accepts the notice. A rejected, timed-out, or ambiguous notice changes the case to terminal `NOTICE_FAILED`, appends a safe failure audit event, and returns a stable failure. A `NOTICE_PENDING` reaper also moves abandoned cases to `NOTICE_FAILED`; neither state can start email proof. The administrator receives a case reference and expiration time only after `PENDING_EMAIL` is committed.

An administrator cannot initiate recovery for themself. Recovery of an administrator account requires a different active administrator. The sole-administrator operational procedure remains recovery-code/TOTP use or an explicitly audited database emergency procedure outside the application; the pilot must require its administrator to retain a backup factor.

### 2. Employee email proof

The employee opens the public lost-phone recovery screen and enters the registered email, employee number, and administrator-provided case reference. Real and non-matching requests consume the same durable abuse budgets, perform equivalent local work, set the same secure challenge cookie shape, and return the same response.

For a matching open case, the server starts an email OTP challenge bound to:

- recovery case and user;
- `PHONE_RECOVERY_EMAIL` purpose;
- registered-email version/hash;
- `tokenVersion` at case creation;
- expiry and browser-bound `HttpOnly`, `Secure`, `SameSite=Strict` cookie.

A correct email OTP advances the case to `EMAIL_VERIFIED`. It does not authenticate the user or permit application access.

### 3. Replacement-phone proof

Only the browser that completed email proof may submit a replacement US mobile number and SMS consent. The server requires a fresh Turnstile proof, normalizes the number, applies account/IP/phone/prefix/global limits, and creates expiring provisional HMAC claims for every active lookup-key version.

If another verified or provisional owner has the number, the public result remains generic and no ownership changes. Otherwise an SMS challenge is created with `PHONE_RECOVERY_SMS` purpose, the case ID, proposed `phoneVersion`, `tokenVersion` at initiation, and the provisional destination identity.

A correct SMS code authorizes only the final recovery transaction. It cannot be reused for login, registration, normal phone change, password recovery, or factor removal.

### 4. Atomic completion

The completion transaction:

1. Locks the recovery case and target user in a consistent order.
2. Rechecks case state, expiry, current `tokenVersion`, proposed `phoneVersion`, email proof, SMS proof, and provisional ownership.
3. Rechecks every active phone HMAC alias under the database uniqueness rules.
4. Replaces encrypted phone data and durable aliases, marks the phone verified, and records consent.
5. Increments `phoneVersion` and `tokenVersion`.
6. Invalidates all outstanding MFA, registration, recovery, media, and purpose challenges for the prior token version.
7. Marks the case completed and appends `phone_recovery_completed` in the same transaction.

The transaction returns no authenticated session. The employee signs in again using the new phone. Old JWTs, media cookies, bearer tokens, and challenge cookies fail centralized token-version validation immediately after commit.

After commit, send generic notifications to the registered email and, when the old phone destination can still be decrypted, the old phone. Notification failures do not undo the completed recovery; they create safe `notification_failed` audit outcomes.

### 5. Cancellation and expiry

The employee may cancel an open case through a token delivered to the registered email. An administrator may also cancel a case with recent MFA. Cancellation and expiry delete provisional claims, invalidate related challenges, and append an audit event. No case may remain usable beyond 24 hours; individual OTP challenges remain limited to ten minutes.

## Data model

Add `PhoneRecoveryCase` with at least:

- `id`, `userId`, `initiatedByUserId`;
- `status` (`NOTICE_PENDING`, `NOTICE_FAILED`, `PENDING_EMAIL`, `EMAIL_VERIFIED`, `PENDING_PHONE`, `COMPLETED`, `CANCELLED`, `EXPIRED`);
- `tokenVersionAtIssue`, `phoneVersionAtIssue`;
- non-secret case reference hash;
- registered-email HMAC snapshot, timestamps, expiry, completion/cancellation metadata;
- encrypted provisional phone destination and key version only after email proof;
- proposed phone HMAC/version metadata and consent metadata.

Add `PHONE_RECOVERY_EMAIL` and `PHONE_RECOVERY_SMS` challenge purposes. Challenge rows reference the case. Add database constraints for valid state/timestamp combinations, one open case per user, and purpose/method consistency. Provisional phone claims expire and are promoted to durable `PhoneLookupAlias` rows only inside the completion transaction.

## API and browser experience

Administrator routes:

- `POST /api/auth/users/:id/phone-recovery` — initiate;
- `DELETE /api/auth/users/:id/phone-recovery/:caseId` — cancel.

Public employee routes:

- `POST /api/auth/phone-recovery/start` — match case and start email proof;
- `POST /api/auth/phone-recovery/email/check`;
- `POST /api/auth/phone-recovery/phone/start`;
- `POST /api/auth/phone-recovery/phone/check`;
- `POST /api/auth/phone-recovery/resend`;
- `POST /api/auth/phone-recovery/cancel`.

The employee screen uses one step at a time: identify case, check registered email, enter new phone and consent, check text message, recovery complete. Every step explains what will happen next, uses mobile input/autocomplete attributes, shows masked destinations, gives resend and lockout countdowns, and offers a clear restart/contact-manager path. The page never says a message was delivered; it says a request was accepted.

The administrator UI shows status, expiry, initiation/cancellation history, and safe notification outcomes. It never exposes the replacement number or verification values.

## Bounded review corrections

### Legacy backup/restore

When `SMS_MFA_ENABLED=true`, the legacy restore route returns a clear conflict response before accepting or extracting an archive. `render.yaml` explicitly sets `ENABLE_LEGACY_INVENTORY_FEATURES=false`. A future versioned backup format may round-trip MFA state, but no partial restore is allowed in this release.

### Login timing

Unknown, disabled, and known accounts all execute exactly one bcrypt comparison using a fixed production-cost decoy hash when no real password hash may be tested. The public status and response body remain identical. Tests assert the comparison path, not wall-clock timing.

### Recovery-code constant work

Both ordinary MFA-login and legacy MFA verification use `consumeBackupCodeConstantWork`. Every request performs eight padded comparisons regardless of match position or remaining-code count. Transactional single-use behavior remains unchanged.

### Literal verification lock

Add one named durable incorrect-verification budget keyed by the privacy-preserving account/destination/purpose dimensions. Five failed submissions within fifteen minutes lock all current and replacement challenges for those dimensions until a database-stored `lockedUntil`. A resend cannot clear the budget. Success clears only the applicable short-term failure budget. The existing per-challenge counter remains defense in depth but is not the authoritative lock.

## Explicitly deferred findings

- A Twilio start timeout can produce a duplicate SMS because Verify exposes no application idempotency key. Document this in the runbook and explain it beside resend controls before pilot acceptance.
- Keep the production Twilio IAM policy check fail-closed on every startup. Do not cache a stale policy attestation during the pilot because a cache could conceal revoked or broadened credentials.
- Keep the single advisory transaction lock for rate-limit mutation at pilot scale. Revisit per-bucket locking only with measured contention.
- Warn when production self-hosting uses insecure cookies, but do not break the documented HTTP-only local deployment mode.
- No inbound delivery-status webhook is required for the current synchronous Verify contract.

## Test strategy

Every behavior change follows a red/green cycle. Required coverage includes:

- administrator cannot self-initiate, complete, or inspect employee proof;
- case creation fails closed when the immediate email notice is unavailable;
- known and decoy public paths have identical response/cookie/rate-limit contracts;
- email proof alone and new-phone proof alone cannot replace a phone or create a session;
- challenge purpose, browser, case, token-version, destination-version, and expiry swapping fail;
- concurrent initiation leaves one open case; concurrent completion commits once;
- competing phone ownership and phone-change races leave exactly one durable owner;
- completion revokes JWT, media-cookie, bearer-token, and outstanding challenge access;
- audit records cover request, denial, lockout, cancellation, expiry, completion, and notification outcomes without sensitive data;
- restore is rejected before archive extraction when SMS MFA is enabled;
- unknown/disabled login performs the decoy bcrypt comparison;
- both recovery-code entry routes always compare eight slots;
- the fifth failed verification establishes a fifteen-minute lock that survives resend, browser change, process restart, and multiple API replicas.

PostgreSQL validation must exercise fresh migration, upgrade migration, constraints, trigger behavior, rollback, case races, phone-alias races, and append-only auditing. The full Node 24 API/web/build/lint/audit checkpoint runs at the release boundary. Live acceptance then covers the production email provider, Twilio policies, paid SMS delivery, deployment SHA, iPhone registration/login/recovery, and rollback.

## Release gate

No push, pull request, merge, or deployment occurs while any Critical or Important finding remains. A final hostile review must verify the complete branch, not summaries. Only after that review reports no Critical or Important code finding may the exact commit enter hosted PostgreSQL CI and controlled deployment/device acceptance.
