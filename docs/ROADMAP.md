# Continuixai Ops — Product Roadmap

Continuixai Ops is the operational-work platform developed by Continuixai. The controlled-pilot scope is intentionally narrower than the historical codebase it was derived from.

## Pilot-supported surface

- Authentication, employee identity, MFA, and session security
- My Work employee task workflow
- Team Work manager workflow
- Daily/weekly/monthly recurring work
- Daily Summary and operational reporting
- Products and store locations required by Count
- Count sessions, barcode scanning, retry/offline queueing, completion, and export

## Legacy surface policy

Historical household-inventory features that are not part of Continuixai Ops pilot scope are disabled by default at the API layer. They may only be enabled deliberately with `ENABLE_LEGACY_INVENTORY_FEATURES=true` for migration/testing. They are not supported for a retail pilot until separately reviewed.

## Next release gates

1. Full dependency-backed CI: Prisma generate, tests, lint, production build.
2. Independent adversarial review with no unresolved Critical/High findings.
3. Real iPhone/Android camera testing and selected handheld-scanner testing.
4. Controlled mock-store reconciliation with no lost or duplicated Count activity.
5. Multi-site rollout only after site-scoped membership is implemented and tested.
