# ContinuiXAi Professional Home Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the installed icon and deliver a cohesive, professional launch and home dashboard experience for ContinuiXAi.

**Architecture:** Retain the existing Next.js PWA and authentication flow. Add deterministic brand-asset generation, explicit iOS startup metadata, and a scoped CSS-module home presentation without changing API, session, scanner, or routing semantics.

**Tech Stack:** Next.js 16, React 19, TypeScript, CSS Modules, Vitest, SVG/PNG PWA assets, ImageMagick asset generation.

**Spec:** `docs/superpowers/specs/2026-09-02-professional-home-experience-design.md`

## Global Constraints

- Official name remains exactly `ContinuiXAi` and tagline remains exactly `Start simple. Stay in control. Grow with confidence.`
- Official brand colors remain navy `#16235A`, teal `#18B5C9`, and amber `#F5A623`.
- Count remains the primary action and continues to route to `/store-count`.
- My Work, Products, and Locations retain their existing routes.
- No API, database, authentication, MFA, scanner, offline-queue, or authorization behavior changes.
- No invented metrics, stock imagery, or unfinished placeholder content.
- Deployment and physical-iPhone verification remain explicit post-implementation gates.

---

### Task 1: Define executable brand-asset contract

**Files:**
- Modify: `apps/web/lib/brandStandard.test.ts`
- Create: `apps/web/scripts/generate-brand-assets.sh`
- Create: `apps/web/scripts/generate-brand-assets.mjs`
- Modify: `apps/web/public/icons/icon.svg`

**Interfaces:**
- Consumes: checked-in brand colors and icon destinations.
- Produces: a reproducible asset-generation command and tests that reject truncated or dimensionally incorrect PNGs.

- [ ] **Step 1: Add a PNG decoder assertion to `brandStandard.test.ts`**

Use Node `zlib.inflateSync` on concatenated IDAT chunks. Assert PNG signature, IHDR width/height, supported bit depth/color type, an IEND chunk, and inflated scanline byte length for `180x180`, `192x192`, and both `512x512` assets. Assert the two Apple icon files are byte-identical.

- [ ] **Step 2: Run the focused test and observe RED**

Run: `npm test -- lib/brandStandard.test.ts`

Expected: FAIL because at least one current icon has invalid/truncated pixel data or invalid compressed scanlines.

- [ ] **Step 3: Add the icon master and generator**

Turn the manifest icon SVG into the single vector master with an opaque navy field and a centered white/teal/amber ContinuiXAi mark inside the maskable safe area. Generate PNG outputs at 180, 192, and 512 pixels; publish the 180 pixel output atomically to both Apple lookup paths.

- [ ] **Step 4: Run the generator and focused test**

Run: `bash scripts/generate-brand-assets.sh && npm test -- lib/brandStandard.test.ts`

Expected: PASS.

### Task 2: Define and implement the professional home hierarchy

**Files:**
- Create: `apps/web/lib/homeExperience.test.ts`
- Create: `apps/web/app/home.module.css`
- Create: `apps/web/components/HomeGlyph.tsx`
- Modify: `apps/web/app/page.tsx`

**Interfaces:**
- Consumes: `useAuth()`, `BrandLockup`, `Link`, current user name, existing route map.
- Produces: loading launch state, unauthenticated opening screen, primary Count action, and secondary work cards.

- [ ] **Step 1: Add source-level presentation tests**

Assert the home page imports the CSS module, exposes `aria-live="polite"` for connecting status, uses `Start or resume Count`, retains all four route destinations, avoids inline `style={{`, and does not contain invented numeric operating metrics. Assert `HomeGlyph` uses hidden decorative SVG and the page distinguishes primary and secondary cards.

- [ ] **Step 2: Run the focused test and observe RED**

Run: `npm test -- lib/homeExperience.test.ts`

Expected: FAIL because the current page uses inline styles and does not contain the approved hierarchy.

- [ ] **Step 3: Implement the minimal JSX structure and glyph component**

Keep existing authentication branching and daypart logic. Use one primary Count link, three secondary links, semantic headings, one Sign In link, and one Sign Out button. Do not fetch new data.

- [ ] **Step 4: Add responsive scoped styling**

Build a navy/teal enterprise visual hierarchy, minimum 44 pixel targets, safe-area padding, visible focus, dark-mode variants, and reduced-motion handling in `home.module.css`.

- [ ] **Step 5: Run the focused test**

Run: `npm test -- lib/homeExperience.test.ts`

Expected: PASS.

### Task 3: Add coherent PWA launch assets and metadata

**Files:**
- Create: `apps/web/public/launch/continuixai-launch.svg`
- Generate: `apps/web/public/launch/continuixai-launch-*.png`
- Modify: `apps/web/scripts/generate-brand-assets.sh`
- Modify: `apps/web/app/layout.tsx`
- Modify: `apps/web/app/manifest.ts`
- Modify: `apps/web/lib/brandStandard.test.ts`

**Interfaces:**
- Consumes: the launch SVG and supported iPhone portrait dimensions.
- Produces: complete startup PNGs, Apple startup-image link metadata, and navy manifest launch colors.

- [ ] **Step 1: Extend the failing asset/metadata contract**

Assert the manifest background is `#16235A`; each startup image referenced by layout exists, decodes, and has the dimensions named in its filename; and layout has matching portrait media queries.

- [ ] **Step 2: Run focused tests and observe RED**

Run: `npm test -- lib/brandStandard.test.ts`

Expected: FAIL because the startup assets and metadata do not yet exist and the current manifest background is white.

- [ ] **Step 3: Add launch master, generated sizes, and metadata**

Generate portrait startup images for the selected iPhone viewport families from one checked-in SVG. Add `apple-touch-startup-image` links in `layout.tsx`, switch `appleWebApp.statusBarStyle` to `black-translucent`, and set the manifest background to navy.

- [ ] **Step 4: Run generator and focused tests**

Run: `bash scripts/generate-brand-assets.sh && npm test -- lib/brandStandard.test.ts`

Expected: PASS.

### Task 4: Verify the complete bounded change

**Files:**
- Verify all files changed by Tasks 1-3.

**Interfaces:**
- Consumes: final working tree.
- Produces: objective automated and visual evidence plus an explicit remaining physical-device gate.

- [ ] **Step 1: Run all web tests**

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 2: Run lint and production build**

Run: `npm run lint` and `npm run build`

Expected: both exit 0; any pre-existing warnings are reported rather than hidden.

- [ ] **Step 3: Validate and inspect image assets**

Run ImageMagick `identify` over all generated PNGs and visually inspect the 180 pixel icon plus one representative startup image.

- [ ] **Step 4: Review the exact diff against scope**

Confirm no API, database, authentication, MFA, scanner, offline queue, or authorization code changed.

- [ ] **Step 5: Record the remaining production gate**

After deployment, remove the cached gray iPhone shortcut, add ContinuiXAi to the Home Screen again, and capture evidence of the new icon, branded launch, Sign In screen, authenticated Home, and primary Count action.
