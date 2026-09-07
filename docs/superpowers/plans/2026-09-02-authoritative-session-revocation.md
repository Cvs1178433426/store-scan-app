# Authoritative Session Revocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure password changes, logout-all, account disablement, and MFA factor removal immediately revoke every normal and attachment-access credential across all API instances.

**Architecture:** Replace process-local token-version authorization with one authoritative user-state lookup that validates `tokenVersion`, `accountStatus`, and `isActive`. Put the current token version in media credentials, validate both cookie and bearer attachment access through the same state rule, and reject all challenge-purpose tokens at attachment routes.

**Tech Stack:** TypeScript 7, Fastify 5, `@fastify/jwt`, Prisma 7/PostgreSQL, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-09-01-sms-mfa-design.md`

## Global Constraints

- A security change that increments `tokenVersion` invalidates every normal JWT and media credential immediately across API instances.
- Only users with `accountStatus = ACTIVE` and `isActive = true` may access protected API or attachment routes.
- Purpose-scoped MFA/setup/recovery tokens never authorize attachment access.
- Media credentials contain only `sub`, `purpose = media`, and `tv`; they contain no role, phone, OTP, TOTP secret, recovery code, password, or provider credential.
- Authorization failures return the existing generic `{ "error": "unauthorized" }` response and do not disclose account state.
- Automated tests use local JWTs and deterministic state fakes; they do not contact Twilio or another external service.

---

### Task 1: Enforce authoritative revocation for normal and media access

**Files:**
- Modify: `apps/api/src/lib/tokenVersion.ts`
- Modify: `apps/api/src/lib/mediaAuth.ts`
- Create: `apps/api/src/lib/mediaAuth.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/routes/mfa.ts`
- Modify: `apps/api/src/routes/registration.ts`
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/routes/mfa.http.test.ts`
- Modify: `apps/api/src/routes/registration.http.test.ts`

**Interfaces:**
- Produces: `getAuthoritativeAccessState(userId): Promise<{ tokenVersion: number; isActive: boolean; accountStatus: string } | null>` using an uncached Prisma read.
- Produces: `isCurrentActiveAccess(userId, tokenVersion): Promise<boolean>` requiring both active-state fields and an exact version match.
- Changes: `signMediaToken(app, userId, tokenVersion)` and `setMediaCookie(app, reply, userId, tokenVersion)`.
- Consumes: existing session JWT `tv`, `bumpTokenVersion`, factor-removal token-version increment, and account-status enum values.

- [ ] **Step 1: Write failing media authorization tests**

Create `mediaAuth.test.ts` using a local Fastify instance with cookie/JWT plugins and a mocked authoritative-state function. Prove:

```ts
it("embeds the current token version in a media credential", () => {
  const token = signMediaToken(app, "user-1", 7);
  expect(app.jwt.verify(token)).toMatchObject({ sub: "user-1", purpose: "media", tv: 7 });
});

it("rejects a stale media cookie after tokenVersion changes", async () => {
  accessState.mockResolvedValue({ tokenVersion: 8, isActive: true, accountStatus: "ACTIVE" });
  expect(await authorizeCookie(signMediaToken(app, "user-1", 7))).toEqual({ statusCode: 401 });
});

it("rejects disabled and inactive users", async () => {
  accessState.mockResolvedValue({ tokenVersion: 7, isActive: false, accountStatus: "DISABLED" });
  expect(await authorizeCookie(signMediaToken(app, "user-1", 7))).toEqual({ statusCode: 401 });
});

it("rejects MFA-purpose bearer tokens even when their signature and version are valid", async () => {
  const token = app.jwt.sign({ sub: "user-1", purpose: "mfa-login", tv: 7 });
  expect(await authorizeBearer(token)).toEqual({ statusCode: 401 });
});
```

Also prove a current active media cookie, current active normal bearer JWT, and current active media bearer token are accepted; missing/non-numeric `tv`, missing `sub`, and an absent user are rejected.

- [ ] **Step 2: Run the media test and verify RED**

Run: `cd apps/api && ../../node_modules/.bin/vitest run src/lib/mediaAuth.test.ts`

Expected: FAIL because media tokens do not contain `tv` and attachment authorization does not consult authoritative user state.

- [ ] **Step 3: Implement uncached authoritative state validation**

In `tokenVersion.ts`, add an uncached Prisma query selecting exactly `tokenVersion`, `isActive`, and `accountStatus`. Add `isCurrentActiveAccess` that returns true only when the row exists, both active fields agree on active status, and `tokenVersion` exactly matches. Do not use the existing in-memory cache for authorization decisions. Keep `invalidateTokenVersionCache` temporarily as a compatibility no-op or cache cleanup for existing callers, but no protected access decision may depend on that cache.

- [ ] **Step 4: Bind and validate media credentials**

Update `signMediaToken` and `setMediaCookie` to require the current numeric token version. In `requireMediaAccess`, cryptographically verify each credential, require string `sub` and numeric `tv`, and then call `isCurrentActiveAccess`.

- Cookie path: require `purpose === "media"`.
- Bearer path: allow only `purpose === undefined` for a normal API JWT or `purpose === "media"` for an attachment-scoped JWT; reject every other purpose.
- On any signature, shape, purpose, user-state, or version failure, fall through to the existing generic 401.

- [ ] **Step 5: Enforce the same rule in central authentication and issuers**

Update the central `authenticate` hook to use `isCurrentActiveAccess` rather than cached version comparison. Pass each user's actual `tokenVersion` to `setMediaCookie` from MFA and registration session issuance. Update test fixtures and assertions to use the new signature.

- [ ] **Step 6: Make account disablement compatible with authoritative state**

Update the administrator disable route so one database update sets `accountStatus: "DISABLED"`, sets `isActive: false`, and increments `tokenVersion`. Call `invalidateTokenVersionCache(userId)` after success for compatibility. Add or extend an HTTP test proving the exact atomic update shape and that old credentials fail the shared state validator.

- [ ] **Step 7: Run focused and full verification**

Run:

```bash
cd apps/api && ../../node_modules/.bin/vitest run src/lib/mediaAuth.test.ts src/routes/mfa.http.test.ts src/routes/registration.http.test.ts && ../../node_modules/.bin/vitest run && ../../node_modules/.bin/eslint src/lib/tokenVersion.ts src/lib/mediaAuth.ts src/lib/mediaAuth.test.ts src/index.ts src/routes/mfa.ts src/routes/registration.ts src/routes/auth.ts src/routes/mfa.http.test.ts src/routes/registration.http.test.ts && ../../node_modules/.bin/tsc -p tsconfig.json && cd ../.. && git diff --check
```

Expected: all focused and full API tests pass; ESLint, TypeScript, and diff checks exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/tokenVersion.ts apps/api/src/lib/mediaAuth.ts apps/api/src/lib/mediaAuth.test.ts apps/api/src/index.ts apps/api/src/routes/mfa.ts apps/api/src/routes/registration.ts apps/api/src/routes/auth.ts apps/api/src/routes/mfa.http.test.ts apps/api/src/routes/registration.http.test.ts
git commit -m "fix: revoke every stale access credential"
```

## Self-Review Record

- Spec coverage: the task makes session invalidation authoritative for normal and attachment access, enforces active account state, binds media credentials to token version, and eliminates purpose confusion.
- Scope: this plan fixes the Critical whole-branch review finding plus the directly coupled disablement constraint failure; it does not implement unrelated registration UI, recovery, rate-limit, rotation, or deployment work.
- Type consistency: every media-token issuer supplies the same numeric `tokenVersion` consumed by the shared authorization rule.
- Test integrity: tests exercise signed JWTs and the real media-authorization function with only the database state lookup mocked; no external provider is involved.
