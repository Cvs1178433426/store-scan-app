# SMS-First Release Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the reviewed SMS-first MFA implementation as the release candidate, preserve later tenant-isolation fixes, and make any return to mandatory QR enrollment fail CI.

**Architecture:** Start from PR #20's SMS-first head because it already contains the complete phone-verification, recovery, audit, migration, and optional-TOTP subsystem. Port only the later organization-scoping protections that apply to this branch, then validate the combined result from a fresh PostgreSQL database through the browser-facing login flow.

**Tech Stack:** TypeScript, Fastify, Next.js, Prisma, PostgreSQL 17, Vitest, Railway, Twilio Verify

**Spec:** `docs/superpowers/specs/2026-09-01-sms-mfa-design.md`

## Global Constraints

- SMS to the registered personal phone is the normal second factor.
- Authenticator TOTP is optional and enrolled only from authenticated account settings.
- Normal login and registration must never request an authenticator QR code.
- Recovery uses the registered personal email plus a separately verified challenge.
- Preserve tenant isolation, session revocation, audit immutability, rate limits, and fail-closed provider behavior.
- Do not merge or deploy production until exact-SHA CI, destructive review, Railway preview, and physical iPhone acceptance pass.

---

### Task 1: Lock the SMS-first browser contract

**Files:**
- Create: `apps/web/lib/loginSmsFirst.test.ts`
- Verify: `apps/web/app/login/page.tsx`

**Interfaces:**
- Consumes: `POST /api/auth/login` returning `{ mfaRequired: true, method: "SMS", maskedDestination }`.
- Produces: a browser regression that rejects automatic `/api/auth/mfa/setup` access and any login QR image.

- [ ] **Step 1: Write the failing regression test**

```ts
it("continues password login with SMS and never starts QR enrollment", async () => {
  apiJson.mockResolvedValueOnce({ mfaRequired: true, method: "SMS", maskedDestination: "(***) ***-3355" });
  await submitPasswordLogin();
  expect(container.textContent).toContain("Check your text messages");
  expect(container.querySelector('img[alt*="MFA QR"]')).toBeNull();
  expect(apiJson).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Verify RED against the rejected authenticator-first login**

Run: temporarily substitute the reviewed PR #21 login component and execute `npm test -w apps/web -- loginSmsFirst.test.ts`.

Expected: FAIL because login requests `/api/auth/mfa/setup` and displays authenticator enrollment.

- [ ] **Step 3: Restore the SMS-first login component**

Restore `apps/web/app/login/page.tsx` from commit `7edc5aa46ecc92524071d8e3ce3b022100829828` without changing its API contract.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -w apps/web -- loginSmsFirst.test.ts`

Expected: PASS with the SMS verification screen and no QR setup request.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/loginSmsFirst.test.ts
git commit -m "test: lock login to sms-first verification"
```

### Task 2: Preserve cross-tenant administrator isolation

**Files:**
- Modify: `apps/api/src/routes/auth.ts`
- Create: `apps/api/src/routes/auth.smsAdminIsolation.test.ts`

**Interfaces:**
- Consumes: authenticated administrator ID and target user ID.
- Produces: `findOrganizationScopedAdminTarget(adminUserId, targetUserId)` and organization-scoped list/deactivation behavior.

- [ ] **Step 1: Write failing tenant-isolation tests**

```ts
it("does not list a user outside every organization managed by the administrator", async () => {
  const response = await app.inject({ method: "GET", url: "/api/auth/users" });
  expect(response.json()).not.toContainEqual(expect.objectContaining({ id: "foreign-user" }));
});

it("rejects deactivation when the administrator does not manage every active target organization", async () => {
  const response = await app.inject({ method: "DELETE", url: "/api/auth/users/foreign-user" });
  expect(response.statusCode).toBe(404);
  expect(userUpdate).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -w apps/api -- auth.smsAdminIsolation.test.ts`

Expected: FAIL because the current list is global and deactivation uses `findUnique({ id })`.

- [ ] **Step 3: Implement the scoped query**

```ts
async function findOrganizationScopedAdminTarget(adminUserId: string, targetUserId: string) {
  return prisma.user.findFirst({
    where: {
      id: targetUserId,
      organizationMemberships: {
        some: { isActive: true, organization: { isActive: true, memberships: { some: { userId: adminUserId, isActive: true, role: { in: ["OWNER", "ADMIN"] } } } } },
        none: { isActive: true, organization: { isActive: true, memberships: { none: { userId: adminUserId, isActive: true, role: { in: ["OWNER", "ADMIN"] } } } } },
      },
    },
  });
}
```

Apply the equivalent membership scope to `GET /users`, and require the helper before deactivation.

- [ ] **Step 4: Verify GREEN and related auth tests**

Run: `npm test -w apps/api -- auth.smsAdminIsolation.test.ts mfa.http.test.ts passwordRecovery.http.test.ts`

Expected: all selected tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth.ts apps/api/src/routes/auth.smsAdminIsolation.test.ts
git commit -m "fix: preserve tenant isolation in sms-first administration"
```

### Task 3: Validate the combined candidate

**Files:**
- Verify: `.github/workflows/ci.yml`
- Verify: `apps/api/scripts/validateSmsMfaPostgres.ts`
- Modify: `docs/RETAIL_COUNT_MVP_ACCEPTANCE.md`

**Interfaces:**
- Consumes: the exact candidate SHA.
- Produces: reproducible API, web, build, lint, audit, PostgreSQL, and security-review evidence.

- [ ] **Step 1: Generate Prisma Client and run the complete local suite**

Run: `DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/continuixai?schema=public' npm run prisma:generate && npm test && npm run build && npm run lint && npm audit --audit-level=high`

Expected: zero test, build, lint-error, or high-severity audit failures.

- [ ] **Step 2: Run the PostgreSQL 17 migration validator in exact-SHA CI**

Run the existing CI workflow and require every SMS-MFA PostgreSQL validation stage to pass.

- [ ] **Step 3: Run the destructive review**

Review normal SMS login, optional TOTP enrollment, lost-phone recovery, enumeration resistance, provider ambiguity, session revocation, immutable audits, and cross-tenant mutations. Any Critical or Important finding returns the candidate to implementation.

- [ ] **Step 4: Record evidence and commit**

```bash
git add docs/RETAIL_COUNT_MVP_ACCEPTANCE.md
git commit -m "docs: record sms-first restoration evidence"
```

### Task 4: Validate the user experience without touching production

**Files:**
- Verify: `railway.toml`
- Verify: `docs/SMS-MFA-PHYSICAL-ACCEPTANCE.md`

**Interfaces:**
- Consumes: an isolated Railway PR environment at the exact reviewed SHA.
- Produces: verified API health, matching build markers, real SMS delivery, and physical iPhone acceptance.

- [ ] **Step 1: Deploy only to an isolated Railway PR environment**

Require a disposable PostgreSQL database, exact build markers, applied migrations, and no production variable or service changes.

- [ ] **Step 2: Run browser smoke checks**

Verify bootstrap collects a personal phone, login says a code will be texted, SMS entry succeeds, and no QR appears unless the signed-in user deliberately opens optional authenticator enrollment in Settings.

- [ ] **Step 3: Run physical iPhone acceptance**

Use `docs/SMS-MFA-PHYSICAL-ACCEPTANCE.md` and record each result without entering credentials or codes into chat.

- [ ] **Step 4: Hold the production gate**

Leave the PR unmerged and production unchanged until all evidence is complete and Mitchell explicitly approves the final merge/deployment.
