# SMS MFA and iPhone Count Acceptance Evidence

Status: **BLOCKED — do not treat the scanner as accepted**

Local automated baseline: `c6c74119e6338270138cbfc5ad2226b66e29428e`

Candidate SHA: pending completion of the remaining security work and an exact-SHA CI run
API build marker: pending deployment  
Web build marker: pending deployment  
Device: physical iPhone, browser/version to record during test

## Automated evidence

| Gate | Result | Evidence |
|---|---|---|
| API tests | PASS | 52 files / 503 tests passed at local baseline `c6c74119e6338270138cbfc5ad2226b66e29428e` on Node 24 |
| Web tests | PASS | 18 files / 96 tests passed at the same local baseline on Node 24 |
| PWA launcher regression | PASS | Script completed successfully |
| Lint | PASS with existing warnings | 0 errors; 9 warnings outside this change |
| Production build | PASS | Shared, API, and 32-route Next.js build completed, including `/recover-phone` |
| Focused phone enrollment security tests | PASS | Existing-factor migration login, recent-factor authenticated start/approval, support-required denial, Turnstile denial, rejected-code non-mutation, cookie binding, enumeration-safe decoy resend/attempt behavior, protected-media cutoff, SMS session provenance, safe resend replacement, migration-deadline restriction, and build marker tests passed |
| Prisma generation | PASS | Prisma Client 7.10.0 generated with a dummy build-time database URL |
| Dependency audit | PASS | Production-only and complete audits reported 0 vulnerabilities at the local baseline; Prisma remains at 7.10.0 with reviewed transitive overrides for `deepmerge-ts` and `mysql2` |
| Disposable PostgreSQL validation | PENDING | Must pass in exact-SHA CI |
| Exact-SHA deployment | PENDING | API and web markers must match |

No production deployment or production configuration change is represented by this local evidence.

## Physical iPhone procedure

Capture screenshots only after redacting phone digits, OTPs, recovery codes, and other secrets.

| Step | Expected result | Result |
|---|---|---|
| Open production sign-in on the iPhone | Normal identifier/password screen; no QR code | PENDING |
| Sign in to an active legacy account without a verified phone | Existing authenticator/recovery challenge appears; password alone grants no session | PENDING |
| Complete the existing factor | Settings opens to “Add primary text-message sign-in” | PENDING |
| Enter consent, phone, and complete the security check | SMS challenge starts; only masked destination is shown | PENDING |
| Enter an incorrect code once | Generic rejection; no session; enrollment remains unapproved | PENDING |
| Request another SMS after the countdown | A new code is accepted for delivery and the prior challenge can no longer approve | PENDING |
| Enter the current SMS code | Phone activates and session is issued | PENDING |
| Save the one-time recovery codes | Codes appear once and can be copied/downloaded on iPhone | PENDING |
| Open Settings | SMS is primary; authenticator is labeled optional | PENDING |
| Compare Settings build marker with `/api/health/version` | Full SHAs are identical to the green CI commit | PENDING |
| As a different administrator with recent MFA, start recovery for an SMS-first employee | UI returns a case reference and expiry only; employee receives the immediate registered-email notice | PENDING |
| Start recovery for yourself or without recent MFA | Request is denied without creating a usable case | PENDING |
| On iPhone, open “Lost or changed your phone?” and enter a wrong identity/reference | Generic accepted flow reveals no account or case existence | PENDING |
| Enter an incorrect registered-email OTP five times | Fifth attempt creates the 15-minute lock; no phone-entry step or session is granted | PENDING |
| Start a fresh case and enter the correct registered-email OTP | Replacement-phone step opens only in the same browser | PENDING |
| Enter a phone already owned or provisionally claimed by another account | Generic rejection; neither account changes and no ownership is displaced | PENDING |
| Enter an unused replacement phone, consent, Turnstile, and correct SMS code | Recovery completes once; no session is issued automatically | PENDING |
| Retry the completion code and use an old session/media credential | Replay and every old credential return the generic unauthorized response | PENDING |
| Sign in using the replacement phone | A fresh SMS-first session succeeds and the old phone no longer signs in | PENDING |
| Start and then cancel another recovery as the administrator | Case, challenges, and provisional claims become unusable; cancellation is audited | PENDING |
| Allow a case and both OTP types to expire | Expired proofs remain unusable and a later phone claim is not blocked | PENDING |
| Complete recovery with email or old-phone notice delivery deliberately unavailable | Phone replacement remains committed; UI warns and a safe failed notification outcome is audited | PENDING |
| Select site, Count session, and location | Active context is visible before scanning | PENDING |
| Scan a known retail UPC | Camera decodes it and quantity increments once | PENDING |
| Rapidly scan the same UPC | Each deliberate scan increments predictably | PENDING |
| Enter manual quantity | Persisted total matches the entered amount | PENDING |
| Scan an unknown UPC | Exception is captured without losing the scan | PENDING |
| Interrupt network, scan, and reconnect | Pending work survives and syncs without double-posting | PENDING |
| Review and submit | Totals reconcile and completed count locks | PENDING |

## Acceptance decision

Pass only when the dependency audit, destructive review, exact-SHA CI/deployment checks, and every physical iPhone row above pass with redacted screenshots/log references. Record the exact deployed API/web SHA, device model, iOS/browser version, timestamp, tester, and safe correlation IDs. Any recovery, activation, lockout, session, SMS/email delivery, build-marker, or Count inconsistency is a blocker and requires disabling the SMS rollout flag.
