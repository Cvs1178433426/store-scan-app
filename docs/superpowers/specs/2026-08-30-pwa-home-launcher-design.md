# ContinuiXai PWA Home Launcher Design

## Goal
Make ContinuiXai Ops on iPhone, Android, and desktop feel like one simple application: open ContinuiXai, authenticate with the existing password + MFA flow, land on a personalized Home launcher, and enter the desired work area with one tap.

## Approved user flow
1. User opens the installed ContinuiXai PWA/Home Screen icon or visits the root URL.
2. If unauthenticated, the user sees the existing branded authentication experience and signs in.
3. Existing MFA remains mandatory and unchanged.
4. After successful MFA/enrollment, the user lands on `/` (Home), not directly in Count.
5. Home recognizes the authenticated user's first name and local time and displays a greeting such as `Good morning, Mitchell — ready to start working?`.
6. Home presents four large, touch-friendly launcher buttons: Count, My Work, Products, Locations.
7. One tap opens the corresponding existing application area.
8. Home is intentionally extensible so future role-authorized applications/suboptions can be added without redesigning authentication.

## Architecture
This is an extension of the existing Next.js web/PWA application, not a second native application. Existing service-worker registration, Apple web-app metadata, authentication, MFA, API, database, Count workflow, offline behavior, and tenant/site authorization remain intact.

The root route becomes an authenticated Home launcher. Authentication redirects are changed so successful MFA ends at `/`. Existing feature routes remain unchanged and retain their own authorization behavior.

## Home launcher
Home must:
- require an authenticated user;
- use the user's first/preferred display token from the existing authenticated user object, never a hard-coded name;
- derive morning/afternoon/evening from the browser's local time;
- render a clear ContinuiXai brand lockup;
- render four large launcher controls with labels and concise supporting text;
- use direct links to `/store-count`, `/my-work`, `/products`, and `/locations`;
- remain usable on iPhone-sized screens and desktop;
- preserve the existing bottom navigation inside the authenticated app;
- provide a clear sign-out action using the existing auth mechanism.

## Authentication
No authentication security is weakened for convenience. Password login and MFA remain required according to current server policy. Both normal MFA verification and first-time MFA enrollment completion redirect to `/`.

The launcher must not introduce a second token/session store, bypass MFA, expose backup codes, or create a parallel account system.

## PWA behavior
Reuse the existing PWA foundation. The app must retain:
- Apple standalone-web-app metadata;
- ContinuiXai application title/icon;
- service-worker registration;
- mobile viewport/safe-area behavior;
- current offline infrastructure.

The installed Home Screen experience should launch into the same production application and root flow rather than a separate build.

## Error and loading behavior
While authentication state is being resolved, Home shows a simple branded loading state rather than protected content. Unauthenticated users are routed to `/login`. Feature-level API/network errors remain owned by the existing feature pages.

## Scope boundaries
This change does not modify Count persistence, scanning, product/location data, organization/site authorization, database schema, Railway services, GitHub/Railway account identities, SMS MFA, employee onboarding, or native App Store packaging.

## Verification contract
Before merge:
1. Add regression coverage proving successful MFA and MFA-enrollment completion route to `/`.
2. Add regression coverage for Home launcher labels/routes and non-hard-coded personalized greeting behavior.
3. Verify existing Count/scanner regression tests remain green.
4. Run lint, tests, build, dependency/security audit, and PostgreSQL database validation through CI.
5. Review the exact PR diff for authentication/security regressions.
6. Merge only a fully green exact head SHA and verify post-merge CI.
7. Verify the deployed production build before manual iPhone installation/testing.
8. Manually verify on iPhone: Home Screen launch, sign-in, MFA, personalized Home, all four launcher buttons, Count camera permission/scan path, and return navigation.
9. Submit exact final branch/commit, CI evidence, and manual evidence to Claude for independent adversarial review before calling the experience complete.
