# SMS MFA Operations

## Release rule

SMS MFA is fail-closed and remains disabled until every gate below passes on one exact commit. Do not use a QR code as the normal same-phone enrollment path. QR/TOTP enrollment is an optional backup action available only after SMS verification and sign-in.

## Required production configuration

API runtime:

- `SMS_MFA_ENABLED=true` only for the controlled acceptance window
- `SMS_MFA_MIGRATION_DEADLINE` as an ISO 8601 date-time; after it passes, legacy sessions without a verified phone are restricted to `/me`, phone enrollment, and sign-out
- server-only `SMS_MFA_BOOTSTRAP_ADMIN_EMAIL` and `SMS_MFA_BOOTSTRAP_ADMIN_PHONE` for the designated owner; both must match the SMS-verified pending account before the first administrator role is granted
- `TWILIO_ACCOUNT_SID`
- restricted `TWILIO_API_KEY_SID` and `TWILIO_API_KEY_SECRET`, with `TWILIO_VERIFY_API_KEY_TYPE=restricted`; its exact allow-list must contain only `/twilio/iam/api-keys/read`, `/twilio/verify/verification/create`, and `/twilio/verify/verification-check/create`
- `TWILIO_VERIFY_SERVICE_SID`
- separately restricted notification credentials and messaging service SID, with `TWILIO_NOTIFICATION_API_KEY_TYPE=restricted`; its exact allow-list must contain only `/twilio/iam/api-keys/read` and `/twilio/messaging/messages/create`
- `SENDGRID_RECOVERY_API_KEY`, restricted to Mail Send only; do not reuse a general-purpose SendGrid key
- `MFA_RECOVERY_FROM_EMAIL`, using a SendGrid-verified sender or authenticated domain dedicated to security notices
- `MFA_RECOVERY_PUBLIC_URL`, set to the HTTPS `/recover-phone` page on the production hostname
- independent `EMAIL_OTP_HMAC_KEY` containing at least 32 characters of random key material
- `TURNSTILE_SECRET_KEY` and exact `TURNSTILE_EXPECTED_HOSTNAME`
- independent, versioned `PHONE_ENCRYPTION_KEYS` and `PHONE_LOOKUP_HMAC_KEYS`
- independent `RATE_LIMIT_HMAC_KEY`, `MFA_ENCRYPTION_KEY`, and `JWT_SECRET`
- `TRUST_PROXY=true` only behind the trusted Railway ingress
- `BUILD_SHA` set to the deployed commit

Web image build:

- `NEXT_PUBLIC_TURNSTILE_SITE_KEY`
- `NEXT_PUBLIC_SMS_CONSENT_VERSION`
- `NEXT_PUBLIC_BUILD_SHA` set to the same deployed commit

Never place raw phone numbers, OTPs, recovery codes, authenticator secrets, or provider credentials in logs, screenshots, issue text, or acceptance records.

## Pre-deployment gates

Run with Node 24:

```bash
CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1 DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy npm run prisma:generate
npm test
npm run lint
npm run build
npm audit --omit=dev --audit-level=high
git diff --check
```

CI must also pass the fresh and populated-upgrade PostgreSQL validations. Any commit after a green run invalidates that evidence.

When SMS MFA is enabled in production, the API queries Prisma's migration history before contacting Twilio or opening its listening socket. A missing, unfinished, rolled-back, or unreadable required migration blocks startup with a generic error that does not expose database details.

## Provider readiness

Before enabling the flag:

1. Confirm the Twilio account is paid and the pilot destination is allowed by its geographic and fraud controls.
2. Confirm in Twilio that the Verify credential has the exact allow-list above and is not a Main or Standard key. At startup, the two independent keys inspect one another through the read-only IAM permission; a missing, broader, unavailable, or non-Restricted policy blocks startup.
3. Confirm in Twilio that the notification credential is separate and has the exact allow-list above. The IAM read permission exposes key metadata and policies, never key secrets, and exists solely for the cross-check startup gate.
4. In SendGrid, confirm the recovery key can send mail but cannot manage users, keys, templates, contacts, or account settings. Confirm the configured sender/domain is verified, SPF/DKIM is healthy, and a real notice reaches the pilot inbox. Rotate the key by creating and validating a second Mail-Send-only key, updating the deployment secret, restarting successfully, and then revoking the old key.
5. Confirm Turnstile accepts `sms_registration`, `sms_phone_enrollment`, and `phone_recovery` widget actions only on the production hostname; the API validates the expected action for each flow.
6. Confirm API and web expose the same full commit SHA at `/api/health/version` and Settings → Build.
7. Confirm no secret value is present in either client bundle or deployment logs.

## Lost-phone recovery

An administrator with MFA in the last ten minutes may start recovery for another active user. Self-initiation and sole-password recovery are prohibited. The administrator privately gives the case reference to the employee; the registered email receives the same reference and continuation URL. A case is usable only after SendGrid accepts that initial notice. A SendGrid rejection, timeout, or ambiguous result makes the case terminal and the administrator must start a new case after the provider is healthy.

The employee enters the registered email, employee number, and case reference, then proves the registered email with an eight-digit, ten-minute code. Only that browser may continue. The replacement phone requires explicit SMS consent, a fresh `phone_recovery` Turnstile proof, and a six-digit SMS approval. Completion atomically replaces the phone, increments phone and token versions, invalidates outstanding challenges and old sessions, promotes provisional phone aliases, and appends `phone_recovery_completed`. It does not create a session; the employee signs in again using the new phone.

Cases expire after 24 hours and every read or transition enforces the deadline. Expired MFA challenges are purged hourly. Expired provisional claims are ignored and purged transactionally before a new phone reservation, so they cannot retain ownership after expiry. Starting a later recovery marks an older expired case `EXPIRED`. An administrator with recent MFA may cancel an open case immediately; cancellation invalidates its challenges, deletes its provisional claims, and records `phone_recovery_cancelled`.

Safe audit outcomes include `phone_recovery_initiated`, `phone_recovery_notice_failed`, `phone_recovery_completed`, `phone_recovery_cancelled`, `phone_recovery_email_notification`, and `phone_recovery_sms_notification`. Provider outcomes use only `provider_accepted`, `provider_request_failed`, `provider_destination_unavailable`, or `notification_unavailable`, with the recovery case ID as the correlation ID. Never record destinations, codes, provider responses, or credentials.

After completion, failure to deliver the email or old-phone notice does not undo the secure phone replacement; the UI shows a warning and the audit records the failed channel. A Twilio start request that times out is marked ambiguous and is never automatically retried. The provider may nevertheless have accepted it, so a later user-requested challenge can produce two text messages; the employee must use the newest code.

The designated sole administrator must retain both an enrolled authenticator and offline recovery codes. There is intentionally no in-app self-recovery or administrator reset bypass. If both backup factors and the phone are lost, treat restoration as a security incident: stop application traffic, preserve a database snapshot and audit trail, require two authorized people to approve and record the intervention, restore access through a reviewed one-time database procedure, rotate affected credentials, and rerun the full acceptance gate before reopening service.

## Existing-account enrollment

An active legacy user without a verified phone signs in with their existing identifier, password, and already-enrolled authenticator or recovery code. The web app then routes the authenticated user to Settings, which requests phone consent, a mobile number, and Turnstile proof before sending an SMS code. Approval consumes the method-bound challenge and atomically verifies the staged phone, clears the retired Recovery PIN, rotates the token version, stores hashed recovery codes, preserves the enrolled authenticator, and creates a replacement session. A rejected or replayed code must not perform any of those mutations.

The authenticated enrollment session must be no more than ten minutes old and must record authenticator or recovery-code authentication. “Send another code” is server-authoritative: it replaces and invalidates the prior challenge, retains the same bound user/purpose/destination/version, and remains subject to local account/IP limits.

Password possession alone cannot bind a new phone. A user without a working enrolled factor receives the stable support-required response and remains unable to access application data.

## Rollback

If delivery, activation, lockout, session issuance, or build-marker behavior is inconsistent:

1. Set `SMS_MFA_ENABLED=false` and redeploy both services. This stops new SMS challenges; it does not remove the verified-phone factor from any account.
2. Preserve the database and all current/previous phone encryption and lookup keys; do not delete or rewrite phone data.
3. Record only correlation IDs, timestamps, status codes, and safe reason codes.
4. Reproduce in a disposable PostgreSQL environment and rerun the complete gate before re-enabling.

Rollback does not mean reverting the additive migration. Accounts with an already-enrolled authenticator or recovery code may use that existing backup factor while SMS delivery is disabled. SMS-only accounts fail closed until SMS is restored; administrator-assisted factor replacement is not available in the pilot, and password possession alone must never offer authenticator enrollment.

## Phone-key rotation

Generate independent 32-byte keys and never reuse a lookup key as an encryption or rate-limit key. `PhoneLookupAlias.hash` is the database-enforced phone identity: its primary key makes claims for every configured lookup-key version atomic across registrations, enrollment, replicas, and mixed-version races. The `User_claim_phone_lookup_hash` trigger also claims the canonical stored hash for writes made by an older application replica.

Set `SMS_GLOBAL_SEND_LIMIT_PER_MINUTE` to the maximum Verify sends allowed across the deployment each minute (default `100`). The database-backed limiter also applies per-phone, per-account, per-IP, and shared US numbering-prefix budgets; invalid limit configuration fails closed.

Registration start and resend responses are deliberately generic. If Verify rejects or times out, the API persists a non-activating decoy challenge and returns the same response shape used for identifier conflicts. A resend for a known pending account retries real delivery; no decoy can activate an account. The registration UI therefore says a code will arrive only if registration can continue and never falsely confirms delivery.

Rotate `PHONE_LOOKUP_HMAC_KEYS` in two phases:

1. Add the new version after the old version (`old,new`), leaving the old version first. Apply the alias migration before rolling out the alias-aware application. Do not reorder the ring yet.
2. After every application replica is alias-aware, run `npm --workspace apps/api run phone-keys:backfill` through the production API deployment identity. The command decrypts phones only in process memory, performs a no-write cross-key collision preflight, and claims aliases transactionally in batches. Every claim and canonical-hash promotion locks the user row and requires the `phoneVersion` observed during the scan; if a phone changes concurrently, the command aborts and must be rerun. Set `PHONE_LOOKUP_BACKFILL_BATCH_SIZE` from 1 through 1000 when the default of 250 is unsuitable.
3. Confirm the command reports full two-version coverage. Independently query for missing aliases; both counts must be zero:

   ```sql
   SELECT COUNT(*) FROM "User" u
   WHERE u."phoneLookupHash" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "PhoneLookupAlias" a WHERE a."userId" = u."id" AND a."keyVersion" = <old_version>);

   SELECT COUNT(*) FROM "User" u
   WHERE u."phoneLookupHash" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "PhoneLookupAlias" a WHERE a."userId" = u."id" AND a."keyVersion" = <new_version>);
   ```

4. Reorder the ring to `new,old`, redeploy every replica, and run the backfill command again. It promotes each canonical `User.phoneLookupHash` and `phoneLookupKeyVersion` to the first key without deleting rollback aliases.
5. Verify `SELECT COUNT(*) FROM "User" WHERE "phoneLookupHash" IS NOT NULL AND "phoneLookupKeyVersion" <> <new_version>;` returns zero. Keep both keys and both alias versions for the rollback window.
6. For rollback, restore `old,new`, redeploy, rerun the command, and verify the canonical-version count before removing the new key. For retirement, remove the old key only after the window closes and the new-version canonical count remains zero; then delete old-version alias rows in a transaction. Removing a key before canonical promotion and coverage verification is prohibited.

Encryption-key rotation is separate: retain every encryption version referenced by `User.phoneEncryptionKeyVersion` until those ciphertexts have been re-encrypted and verified. Restores must include every still-referenced encryption key and every lookup key required by the selected rollback point.
