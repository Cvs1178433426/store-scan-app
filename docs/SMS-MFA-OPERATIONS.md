# SMS MFA Operations

## Release rule

SMS MFA is fail-closed and remains disabled until every gate below passes on one exact commit. Do not use a QR code as the normal same-phone enrollment path. QR/TOTP enrollment is an optional backup action available only after SMS verification and sign-in.

## Required production configuration

API runtime:

- `SMS_MFA_ENABLED=true` only for the controlled acceptance window
- `SMS_MFA_MIGRATION_DEADLINE` as an ISO 8601 date-time; after it passes, legacy sessions without a verified phone are restricted to `/me`, phone enrollment, and sign-out
- `TWILIO_ACCOUNT_SID`
- restricted `TWILIO_API_KEY_SID` and `TWILIO_API_KEY_SECRET`
- `TWILIO_VERIFY_SERVICE_SID`
- separately restricted notification credentials and messaging service SID
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

## Provider readiness

Before enabling the flag:

1. Confirm the Twilio account is paid and the pilot destination is allowed by its geographic and fraud controls.
2. Confirm the Verify credential is restricted to the required Verify operations and is not the master Auth Token.
3. Confirm the notification credential is separate and least-privileged.
4. Confirm Turnstile accepts both `sms_registration` and `sms_phone_enrollment` widget actions only on the production hostname; the API validates the expected action for each flow.
5. Confirm API and web expose the same full commit SHA at `/api/health/version` and Settings → Build.
6. Confirm no secret value is present in either client bundle or deployment logs.

## Existing-account enrollment

An active legacy user without a verified phone signs in with their existing identifier, password, and already-enrolled authenticator or recovery code. The web app then routes the authenticated user to Settings, which requests phone consent, a mobile number, and Turnstile proof before sending an SMS code. Approval consumes the method-bound challenge and atomically verifies the staged phone, clears the retired Recovery PIN, rotates the token version, stores hashed recovery codes, preserves the enrolled authenticator, and creates a replacement session. A rejected or replayed code must not perform any of those mutations.

The authenticated enrollment session must be no more than ten minutes old and must record authenticator or recovery-code authentication. “Send another code” is server-authoritative: it replaces and invalidates the prior challenge, retains the same bound user/purpose/destination/version, and remains subject to local account/IP limits.

Password possession alone cannot bind a new phone. A user without a working enrolled factor receives the stable support-required response and remains unable to access application data.

## Rollback

If delivery, activation, lockout, session issuance, or build-marker behavior is inconsistent:

1. Set `SMS_MFA_ENABLED=false` and redeploy both services.
2. Preserve the database and all current/previous phone encryption and lookup keys; do not delete or rewrite phone data.
3. Record only correlation IDs, timestamps, status codes, and safe reason codes.
4. Reproduce in a disposable PostgreSQL environment and rerun the complete gate before re-enabling.

Rollback does not mean reverting the additive migration. The legacy TOTP path remains available while the feature flag is disabled.

## Phone-key rotation

Generate independent 32-byte keys. Prepend the new version to each key ring while retaining the immediately previous version. New writes use the first version; reads accept configured historical versions. Backfill lookup hashes in bounded batches, verify complete coverage and uniqueness, then remove the prior key only after the rollback window closes. Restores must include the matching versioned keys.
