# Claude Adversarial Review Brief: ContinuiXAi SMS-First MFA

## Review target

Review `docs/superpowers/specs/2026-09-01-sms-mfa-design.md` as a security-critical authentication design for the existing ContinuiXAi application.

The current application has custom password authentication, JWT/session challenge tokens, mandatory TOTP enrollment, encrypted TOTP secrets, hashed backup codes, a six-digit Recovery PIN flow, PostgreSQL/Prisma persistence, Fastify API routes, Next.js web UI, and first-user administrator bootstrap behavior. The proposed design adds required SMS verification through Twilio Verify while retaining TOTP as an optional backup and preserving a future AWS-provider migration path.

Do not review wording or style unless ambiguity creates a security or implementation risk. Do not assume passing unit tests prove real-device, provider, database, concurrency, or recovery safety.

## Required review posture

Act as a hostile security architect and production-readiness reviewer. Try to disprove that the design is safe. Trace complete attack paths and lifecycle races rather than listing generic MFA advice.

Prioritize findings as:

- **Critical**: credible account takeover, tenant/admin compromise, authentication bypass, secret exposure, destructive migration, or unsafe production release.
- **Important**: material abuse, lockout bypass, privacy/compliance gap, rollout failure, unrecoverable user state, provider-coupling flaw, or missing acceptance gate.
- **Minor**: useful hardening or clarity improvement that does not block implementation.

Every finding must include:

1. Exact design section or quoted requirement.
2. Concrete failure or attack scenario.
3. Why existing controls do not stop it.
4. Minimum safe correction.
5. Test or acceptance evidence that would prove the correction.

Do not mark the design approved if any Critical or Important finding remains unresolved.

## Mandatory attack surfaces

Review all of the following:

1. Registration enumeration, pending-account takeover, duplicate email/phone races, and simultaneous first-user bootstrap.
2. SMS pumping, resend abuse, distributed IP/device abuse, phone-hash attacks, and Twilio rate-limit key privacy.
3. Code replay, challenge confusion, token theft, expiration disagreement, provider timeouts, ambiguous provider responses, and idempotency.
4. SIM swapping, recycled phone numbers, shared phones, number changes, administrator-assisted recovery, and malicious administrators.
5. Recovery PIN coexistence, recovery-code generation/consumption, TOTP downgrade, backup-method removal, and session invalidation.
6. Encryption/HMAC key separation, rotation, database backups, logs, telemetry, audit rows, support tooling, and masked-number leakage.
7. Tenant isolation, organization/site authorization, role elevation, disabled users, and inactive/pending accounts.
8. Twilio credential scope, webhook assumptions, Fraud Guard/geo settings, provider outage, provider compromise, and trial-to-paid transition.
9. AWS portability: identify abstractions that still leak Twilio behavior into schema, routes, UI, errors, tests, or policy.
10. Rollout/rollback: existing TOTP users, partially enrolled users, SMS-only users, schema compatibility, Railway configuration, CI validation, and master-merge gates.
11. SMS consent, privacy disclosures, PII retention, international numbering, delivery behavior, and accessibility.
12. Physical iPhone acceptance, same-phone enrollment, stale PWA/service-worker behavior, delayed texts, duplicate texts, offline recovery, and screenshots exposing secrets.

## Required output

Produce:

1. Executive verdict: `BLOCK`, `REVISE`, or `READY FOR IMPLEMENTATION`.
2. Findings table ordered Critical, Important, Minor.
3. Abuse-case walkthroughs for the three highest-risk scenarios.
4. Missing invariants that must be expressed in schema, API, or transaction boundaries.
5. Required automated tests and real-device tests not already in the specification.
6. A final checklist of changes required before implementation begins.

If no Critical or Important issues are found, explicitly state which attack surfaces were examined and why the controls are sufficient. Avoid unsupported reassurance.
