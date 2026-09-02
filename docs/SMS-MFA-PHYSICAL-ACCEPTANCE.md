# SMS MFA and iPhone Count Acceptance Evidence

Status: **BLOCKED — do not treat the scanner as accepted**

Candidate SHA: pending commit and CI run  
API build marker: pending deployment  
Web build marker: pending deployment  
Device: physical iPhone, browser/version to record during test

## Automated evidence

| Gate | Result | Evidence |
|---|---|---|
| API tests | PASS | 318 tests passed locally on Node 24 |
| Web tests | PASS | 81 tests passed locally on Node 24 |
| PWA launcher regression | PASS | Script completed successfully |
| Lint | PASS with existing warnings | 0 errors; 9 warnings outside this change |
| Production build | PASS | Shared, API, and 31-route Next.js build completed |
| Focused phone enrollment security tests | PASS | Existing-factor migration login, recent-factor authenticated start/approval, support-required denial, Turnstile denial, rejected-code non-mutation, cookie binding, enumeration-safe decoy resend/attempt behavior, protected-media cutoff, SMS session provenance, safe resend replacement, migration-deadline restriction, and build marker tests passed |
| Prisma generation | PASS | Prisma Client 7.10.0 generated with a dummy build-time database URL |
| Dependency audit | **FAIL / BLOCKER** | Prisma 7.10.0 transitively installs vulnerable `deepmerge-ts` and `mysql2`; no compatible stable fix is currently available |
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
| Select site, Count session, and location | Active context is visible before scanning | PENDING |
| Scan a known retail UPC | Camera decodes it and quantity increments once | PENDING |
| Rapidly scan the same UPC | Each deliberate scan increments predictably | PENDING |
| Enter manual quantity | Persisted total matches the entered amount | PENDING |
| Scan an unknown UPC | Exception is captured without losing the scan | PENDING |
| Interrupt network, scan, and reconnect | Pending work survives and syncs without double-posting | PENDING |
| Review and submit | Totals reconcile and completed count locks | PENDING |

## Acceptance decision

Pass only when the dependency audit, exact-SHA CI/deployment checks, and every physical iPhone row above pass. Any activation, lockout, session, SMS delivery, build-marker, or Count inconsistency is a blocker and requires disabling the SMS rollout flag.
