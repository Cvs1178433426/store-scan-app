# ContinuiXAi Professional Home Experience Design

## Goal

Make the installed ContinuiXAi PWA immediately recognizable and credible on an iPhone home screen, during launch, and on the first authenticated or unauthenticated screen.

## Approved direction

The experience uses a restrained enterprise visual system built from the official navy, teal, and amber brand colors. It prioritizes clarity and trust over decoration. Count is the dominant employee action; My Work, Products, and Locations remain easy secondary actions. The product must not display invented operating statistics or unfinished placeholder content.

## Home-screen icon

- Use a valid, opaque iOS Apple touch icon with the ContinuiXAi mark centered on a navy brand field.
- Keep all essential artwork inside maskable safe-area boundaries.
- Generate valid 180, 192, and 512 pixel PNG assets plus a 512 pixel maskable asset from a checked-in vector master.
- Keep the root Apple icon and `/icons/apple-touch-icon.png` identical so browser lookup paths cannot diverge.
- Automated tests must prove each PNG has a valid signature, expected dimensions, complete pixel data, and no trailing/truncated image payload.

## Launch experience

- Set the manifest launch background to ContinuiXAi navy to eliminate the current generic white launch impression.
- Add portrait iOS startup images for the supported iPhone viewport families, referenced with the corresponding device media queries.
- Startup artwork uses the centered mark and name on a quiet navy field with teal/amber accents; no controls or misleading progress indicators appear in the static image.
- While application authentication resolves, show a matching in-app launch panel with the brand name, tagline, and an accessible status message so transition from native splash to web content is coherent.

## Unauthenticated opening screen

- Show the official lockup, a confident product statement, the approved tagline, and one prominent Sign In action.
- State the product purpose in plain language: inventory, counting, and team operations.
- Avoid stock photography, marketing claims that are not yet proven, registration shortcuts, and duplicate actions.

## Authenticated dashboard

- Show a compact branded header, time-aware personal greeting, and Sign Out.
- Make `Start or resume Count` a full-width primary action with a scan glyph and explicit destination `/store-count`.
- Present My Work, Products, and Locations as secondary cards with individual accessible SVG glyphs.
- Preserve the existing routes, authorization, authentication, MFA, offline queue, bottom navigation, and Count behavior.
- Remain touch-friendly and readable from narrow iPhones through desktop, including safe areas, light mode, dark mode, reduced motion, and keyboard focus.

## Scope boundaries

This change does not create the native App Store/Play Store packages, add business metrics, change APIs or database schema, alter MFA, change scanner behavior, or deploy to production. Deployment and physical iPhone reinstallation remain separate acceptance gates.

## Acceptance evidence

1. Asset regression tests fail on the current damaged PNGs and pass on regenerated files.
2. Home-experience regression tests fail before the redesign and pass after it.
3. Web tests, lint, and production build complete successfully.
4. Generated icon and representative startup image are visually inspected.
5. Mobile and desktop screenshots are captured from a local production-equivalent render when feasible.
6. The feature is not called production-complete until deployment and removal/re-addition of the cached iPhone home-screen shortcut confirm the new icon and opening experience on the physical device.
