# Factor-Change Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow an SMS-verified user to remove an enrolled TOTP backup only after a different-factor challenge, invalidate all sessions atomically, and request an honest security alert through a separately scoped Twilio Messaging adapter.

**Architecture:** Keep OTP checks in `TwilioVerifyProvider`. Add a narrow `SecurityNotificationProvider` and a Twilio Programmable Messaging adapter, then place the removal transaction and post-commit notification outcome in a focused service. The HTTP route starts and checks an SMS `FACTOR_REMOVAL` challenge but never receives provider credentials, stores raw phone data, or claims that a provider-accepted message was delivered.

**Tech Stack:** TypeScript 7, Fastify 5, Prisma 7/PostgreSQL, Vitest 4, built-in `fetch`, Twilio Verify, Twilio Programmable Messaging.

**Spec:** `docs/superpowers/specs/2026-09-01-sms-mfa-design.md`

## Global Constraints

- SMS remains the required primary method; TOTP is optional and stronger.
- Removing TOTP requires a recent `FACTOR_REMOVAL` challenge using SMS, never TOTP itself.
- The removal transaction consumes the challenge, clears TOTP, increments `tokenVersion`, and writes the removal audit record atomically.
- Notification happens only after the removal transaction commits; notification failure never restores the removed factor or old sessions.
- Twilio acceptance is reported as `accepted`, never `delivered`.
- The notification adapter uses a dedicated Restricted API Key and Messaging Service SID, never the master Auth Token or the Verify key.
- OTPs, phone numbers, passwords, TOTP secrets, recovery codes, and credentials never enter logs or audit metadata.
- No live Twilio request runs in automated tests.

---

### Task 1: Add the security-notification provider contract and Twilio adapter

**Files:**
- Create: `apps/api/src/lib/securityNotificationProvider.ts`
- Create: `apps/api/src/lib/twilioMessagingNotificationProvider.ts`
- Create: `apps/api/src/lib/twilioMessagingNotificationProvider.test.ts`

**Interfaces:**
- Produces: `SecurityNotificationProvider.notifyFactorChanged(input): Promise<{ providerRef: string }>`.
- Produces: `createSecurityNotificationProvider(environment, fetchImpl)` which validates the four messaging settings and returns a Twilio adapter.
- Consumes: no Prisma or route types.

- [ ] **Step 1: Write the failing adapter tests**

Create table-driven tests that prove a TOTP-removal notice uses the Messages endpoint, dedicated Basic Auth credentials, the Messaging Service SID, and fixed non-secret copy. Add failure cases for non-2xx responses and a successful response missing `sid`.

```ts
it("submits a generic factor-change notice with dedicated credentials", async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ sid: "SM123" }), { status: 201 }));
  const provider = createSecurityNotificationProvider({
    TWILIO_ACCOUNT_SID: "AC123",
    TWILIO_NOTIFICATION_API_KEY_SID: "SK-NOTIFY",
    TWILIO_NOTIFICATION_API_KEY_SECRET: "notify-secret",
    TWILIO_MESSAGING_SERVICE_SID: "MG123",
  }, fetchImpl);

  await expect(provider.notifyFactorChanged({
    destination: "+16317423355",
    event: "TOTP_REMOVED",
    correlationId: "corr-1",
  })).resolves.toEqual({ providerRef: "SM123" });

  expect(fetchImpl).toHaveBeenCalledWith(
    "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json",
    expect.objectContaining({ method: "POST" }),
  );
  const init = fetchImpl.mock.calls[0][1] as RequestInit;
  expect(String((init.headers as Record<string, string>).Authorization)).toBe(
    `Basic ${Buffer.from("SK-NOTIFY:notify-secret").toString("base64")}`,
  );
  expect(String(init.body)).toContain("MessagingServiceSid=MG123");
  expect(String(init.body)).toContain("To=%2B16317423355");
  expect(decodeURIComponent(String(init.body))).toContain(
    "ContinuiXAi security alert: An authenticator backup was removed.",
  );
});

it.each([400, 401, 429, 500])("fails generically for Twilio status %s", async (status) => {
  const provider = configuredProvider(async () => new Response("provider detail", { status }));
  await expect(provider.notifyFactorChanged(notificationInput)).rejects.toThrow(
    "Security notification request was not accepted.",
  );
});
```

- [ ] **Step 2: Run the adapter test and verify RED**

Run: `cd apps/api && ../../node_modules/.bin/vitest run src/lib/twilioMessagingNotificationProvider.test.ts`

Expected: FAIL because both provider files are absent.

- [ ] **Step 3: Implement the provider-neutral contract**

```ts
export type FactorChangeEvent = "TOTP_REMOVED";

export type FactorChangeNotification = {
  destination: string;
  event: FactorChangeEvent;
  correlationId: string;
};

export interface SecurityNotificationProvider {
  notifyFactorChanged(input: FactorChangeNotification): Promise<{ providerRef: string }>;
}

export class SecurityNotificationConfigurationError extends Error {}
export class SecurityNotificationRequestError extends Error {}
```

- [ ] **Step 4: Implement the Twilio Messaging adapter**

Use injected `fetch` and form encoding. Do not log the request, destination, response body, or credentials.

```ts
const BODY = "ContinuiXAi security alert: An authenticator backup was removed. If this wasn't you, contact your administrator immediately.";

export class TwilioMessagingNotificationProvider implements SecurityNotificationProvider {
  constructor(
    private readonly config: { accountSid: string; apiKeySid: string; apiKeySecret: string; messagingServiceSid: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async notifyFactorChanged(input: FactorChangeNotification): Promise<{ providerRef: string }> {
    const body = new URLSearchParams({
      To: input.destination,
      MessagingServiceSid: this.config.messagingServiceSid,
      Body: BODY,
    });
    const response = await this.fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.config.accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.apiKeySid}:${this.config.apiKeySecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      },
    );
    if (!response.ok) throw new SecurityNotificationRequestError("Security notification request was not accepted.");
    const payload = await response.json() as { sid?: unknown };
    if (typeof payload.sid !== "string" || !payload.sid) {
      throw new SecurityNotificationRequestError("Security notification request was not accepted.");
    }
    return { providerRef: payload.sid };
  }
}
```

`createSecurityNotificationProvider` trims and requires `TWILIO_ACCOUNT_SID`, `TWILIO_NOTIFICATION_API_KEY_SID`, `TWILIO_NOTIFICATION_API_KEY_SECRET`, and `TWILIO_MESSAGING_SERVICE_SID`. Missing configuration throws `SecurityNotificationConfigurationError` without including secret values.

- [ ] **Step 5: Run tests, lint, and build**

Run: `cd apps/api && ../../node_modules/.bin/vitest run src/lib/twilioMessagingNotificationProvider.test.ts && ../../node_modules/.bin/eslint src/lib/securityNotificationProvider.ts src/lib/twilioMessagingNotificationProvider.ts src/lib/twilioMessagingNotificationProvider.test.ts && ../../node_modules/.bin/tsc -p tsconfig.json`

Expected: adapter tests pass; lint and TypeScript exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/securityNotificationProvider.ts apps/api/src/lib/twilioMessagingNotificationProvider.ts apps/api/src/lib/twilioMessagingNotificationProvider.test.ts
git commit -m "feat: add security notification provider"
```

### Task 2: Implement atomic TOTP removal and post-commit notification outcomes

**Files:**
- Create: `apps/api/src/lib/factorRemovalService.ts`
- Create: `apps/api/src/lib/factorRemovalService.test.ts`
- Modify: `apps/api/src/lib/tokenVersion.ts`

**Interfaces:**
- Consumes: `SecurityNotificationProvider`, `VerificationPolicy.completeChallenge`, encrypted verified-phone fields, and `invalidateTokenVersionCache(userId)`.
- Produces: `FactorRemovalService.startTotpRemoval(user, dimensions)` and `confirmTotpRemoval(user, challengeId, code)`.
- Produces: `PrismaFactorRemovalRepository.removeTotpFromChallenge(input)` and `recordNotificationOutcome(input)`.

- [ ] **Step 1: Write failing service tests with real service logic and local fakes**

Prove these observable behaviors:

```ts
it("starts only an SMS FACTOR_REMOVAL challenge", async () => {
  await service.startTotpRemoval(activeUser, ["account:a", "ip:b"]);
  expect(policy.startChallenge).toHaveBeenCalledWith(expect.objectContaining({
    userId: "user-1",
    purpose: "FACTOR_REMOVAL",
    method: "SMS",
    destination: "+16317423355",
    destinationHash: "phone-hash",
    destinationVersion: 2,
  }));
});

it("removes TOTP before requesting the notification and reports provider acceptance honestly", async () => {
  const order: string[] = [];
  repository.removeTotpFromChallenge.mockImplementation(async () => { order.push("commit"); return true; });
  notificationProvider.notifyFactorChanged.mockImplementation(async () => { order.push("notify"); return { providerRef: "SM123" }; });

  await expect(service.confirmTotpRemoval(activeUser, "challenge-1", "123456"))
    .resolves.toEqual({ removed: true, notification: "accepted" });
  expect(order).toEqual(["commit", "notify"]);
  expect(repository.recordNotificationOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: "accepted" }));
});

it("keeps the removal committed and records notification failure", async () => {
  repository.removeTotpFromChallenge.mockResolvedValue(true);
  notificationProvider.notifyFactorChanged.mockRejectedValue(new Error("provider unavailable"));
  await expect(service.confirmTotpRemoval(activeUser, "challenge-1", "123456"))
    .resolves.toEqual({ removed: true, notification: "failed" });
  expect(repository.recordNotificationOutcome).toHaveBeenCalledWith(expect.objectContaining({
    outcome: "failed",
    safeReasonCode: "provider_request_failed",
  }));
});
```

Add rejection tests for a user without an enrolled TOTP factor, without a verified phone, or with an inactive/non-`ACTIVE` account.

- [ ] **Step 2: Run the service test and verify RED**

Run: `cd apps/api && ../../node_modules/.bin/vitest run src/lib/factorRemovalService.test.ts`

Expected: FAIL because `FactorRemovalService` does not exist.

- [ ] **Step 3: Implement the service orchestration**

`startTotpRemoval` calls `VerificationPolicy.startChallenge` with `purpose: "FACTOR_REMOVAL"`, `method: "SMS"`, the decrypted existing phone, and caller-supplied non-PII dimensions. `confirmTotpRemoval` creates one UUID correlation ID and calls `completeChallenge` with the same purpose-bound local challenge data.

```ts
const result = await this.policy.completeChallenge({
  challengeId,
  userId: user.id,
  method: "SMS",
  destination: user.phoneE164,
  destinationHash: user.phoneLookupHash,
  destinationVersion: user.phoneVersion,
  code,
}, (boundChallengeId, approvedAt) => this.repository.removeTotpFromChallenge({
  challengeId: boundChallengeId,
  userId: user.id,
  approvedAt,
  correlationId,
}));
if (!result.approved || result.value !== true) throw new Error("Factor removal challenge was not approved.");
```

After the transaction returns true, invalidate the token-version cache, request the notification, and record `accepted` with safe reason `provider_accepted` or `failed` with safe reason `provider_request_failed`. The notification outcome record contains no Twilio SID because the approved audit schema has no provider-reference field and no operational requirement needs it.

- [ ] **Step 4: Implement the Prisma transaction boundary**

`removeTotpFromChallenge` uses `prisma.$transaction`. Inside it:

```sql
SELECT "id", "mfaEnabled" FROM "User" WHERE "id" = $userId FOR UPDATE;

UPDATE "MfaChallenge" SET "consumedAt" = $approvedAt
WHERE "id" = $challengeId AND "userId" = $userId
  AND "purpose" = 'FACTOR_REMOVAL' AND "method" = 'SMS'
  AND "consumedAt" IS NULL AND "invalidatedAt" IS NULL
  AND "expiresAt" > $approvedAt;

UPDATE "User" SET "mfaEnabled" = false, "mfaSecretEncrypted" = NULL,
  "tokenVersion" = "tokenVersion" + 1
WHERE "id" = $userId AND "accountStatus" = 'ACTIVE' AND "isActive" = true
  AND "mfaEnabled" = true AND "mfaSecretEncrypted" IS NOT NULL;
```

Both updates must affect exactly one row. Then create `SecurityAuditEvent` with `eventType: "totp_removed"`, `outcome: "succeeded"`, `method: "SMS"`, actor and target set to the user, `safeReasonCode: "different_factor_approved"`, and the correlation ID. Any zero-row result throws and rolls back all changes.

`recordNotificationOutcome` creates a second event with `eventType: "factor_change_notification"`, method `SMS`, actor/target user, the same correlation ID, and the service-supplied outcome/reason.

- [ ] **Step 5: Run service tests, full API tests, lint, and build**

Run: `cd apps/api && ../../node_modules/.bin/vitest run src/lib/factorRemovalService.test.ts && ../../node_modules/.bin/vitest run && ../../node_modules/.bin/eslint src/lib/factorRemovalService.ts src/lib/factorRemovalService.test.ts && ../../node_modules/.bin/tsc -p tsconfig.json`

Expected: all tests pass; lint and TypeScript exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/factorRemovalService.ts apps/api/src/lib/factorRemovalService.test.ts apps/api/src/lib/tokenVersion.ts
git commit -m "feat: remove TOTP with atomic step-up"
```

### Task 3: Expose the safe removal route and operational configuration

**Files:**
- Modify: `apps/api/src/routes/mfa.ts`
- Modify: `apps/api/src/routes/mfa.http.test.ts`
- Modify: `.env.example`
- Modify: `docs/superpowers/plans/2026-09-01-sms-first-mfa.md`

**Interfaces:**
- Consumes: `FactorRemovalService`, `createSecurityNotificationProvider`, `readChallengeCookie`, `setChallengeCookie`, `clearChallengeCookie`, and `clearMediaCookie`.
- Produces: `POST /api/auth/mfa/totp/remove` with start and confirm stages.

- [ ] **Step 1: Write failing HTTP tests**

Add route tests for these exact contracts:

```ts
it("refuses to start removal when security notifications are not configured", async () => {
  const response = await server.inject({ method: "POST", url: "/api/auth/mfa/totp/remove" });
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({
    error: "Security notifications are temporarily unavailable. Factor removal was not started.",
  });
  expect(mocks.startChallenge).not.toHaveBeenCalled();
});

it("starts an SMS factor-removal challenge without changing the factor", async () => {
  const response = await configuredServer.inject({ method: "POST", url: "/api/auth/mfa/totp/remove" });
  expect(response.statusCode).toBe(202);
  expect(response.json()).toEqual({
    status: "verification_pending",
    method: "SMS",
    maskedDestination: "(***) ***-3355",
  });
  expect(mocks.update).not.toHaveBeenCalled();
  expect(String(response.headers["set-cookie"])).toContain("continuixai_mfa_challenge=");
});

it("confirms removal without returning a replacement session", async () => {
  const response = await configuredServer.inject({
    method: "POST",
    url: "/api/auth/mfa/totp/remove",
    headers: { cookie: "continuixai_mfa_challenge=removal-1" },
    payload: { code: "123456" },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ removed: true, notification: "accepted" });
  expect(response.json()).not.toHaveProperty("token");
  expect(String(response.headers["set-cookie"])).toContain("continuixai_mfa_challenge=;");
});

it("reports a committed removal when the notification request fails", async () => {
  mocks.confirmTotpRemoval.mockResolvedValue({ removed: true, notification: "failed" });
  const response = await confirmRequest();
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    removed: true,
    notification: "failed",
    warning: "Authenticator removed, but the security text could not be sent.",
  });
});
```

Also prove a missing/invalid cookie is `401`, a TOTP `FACTOR_REMOVAL` challenge is rejected, and a login-purpose SMS challenge cannot remove the factor.

- [ ] **Step 2: Run the HTTP test and verify RED**

Run: `cd apps/api && ../../node_modules/.bin/vitest run src/routes/mfa.http.test.ts`

Expected: FAIL with `404` because `/mfa/totp/remove` is absent.

- [ ] **Step 3: Implement the start stage**

When no `code` is present, construct the notification provider first. Map `SecurityNotificationConfigurationError` to the exact `503` response above. Load the authenticated user and require `ACTIVE`, `isActive`, verified encrypted phone fields, `mfaEnabled`, and `mfaSecretEncrypted`. Call `startTotpRemoval`, set the secure challenge cookie, and return the `202` response with only the last four digits.

- [ ] **Step 4: Implement the confirm stage**

When `code` is present, require six digits and the challenge cookie. Load the challenge row and require the authenticated user, `purpose = FACTOR_REMOVAL`, and `method = SMS`. Call `confirmTotpRemoval`. On success, clear both the challenge cookie and the media cookie. Return `accepted` or the exact committed-removal warning response; never issue a JWT/session.

Map `VerificationLockedError` to `429` with `Retry-After: 900`. Map invalid/expired/wrong-code outcomes to `401` with `That verification code is not correct or has expired.` Do not catch the notification failure as a verification failure because the service already converted it into the explicit post-commit outcome.

- [ ] **Step 5: Document configuration and key separation**

Add to `.env.example`:

```dotenv
# Separate Restricted API Key for generic factor-change security notices.
# Do not reuse the Verify key or a master Auth Token.
TWILIO_NOTIFICATION_API_KEY_SID=
TWILIO_NOTIFICATION_API_KEY_SECRET=
TWILIO_MESSAGING_SERVICE_SID=
```

Expand the parent plan's Task 9 operations-runbook step to state that the key permits only the required Messages-create action, rotates every 90 days, and that factor removal returns `503` before challenge creation when these values are absent. Task 9 will copy those exact requirements into `docs/SMS-MFA-OPERATIONS.md` when it creates the runbook.

- [ ] **Step 6: Run complete verification**

Run: `cd apps/api && ../../node_modules/.bin/vitest run src/routes/mfa.http.test.ts src/lib/factorRemovalService.test.ts src/lib/twilioMessagingNotificationProvider.test.ts && ../../node_modules/.bin/vitest run && ../../node_modules/.bin/eslint src/routes/mfa.ts src/routes/mfa.http.test.ts src/lib/securityNotificationProvider.ts src/lib/twilioMessagingNotificationProvider.ts src/lib/twilioMessagingNotificationProvider.test.ts src/lib/factorRemovalService.ts src/lib/factorRemovalService.test.ts && ../../node_modules/.bin/tsc -p tsconfig.json && cd ../.. && git diff --check`

Expected: all focused and full API tests pass; lint, TypeScript, and diff checks exit 0.

- [ ] **Step 7: Commit**

```bash
git add .env.example apps/api/src/routes/mfa.ts apps/api/src/routes/mfa.http.test.ts docs/superpowers/plans/2026-09-01-sms-first-mfa.md
git commit -m "feat: require notified TOTP removal"
```

## Self-Review Record

- Spec coverage: separate provider boundary, dedicated credentials, configuration fail-closed behavior, different-factor challenge, atomic removal/session invalidation/audit, post-commit notification, honest acceptance terminology, and failure audit are each assigned to a task.
- Scope: recovery-code regeneration and phone changes remain in the parent SMS-first MFA plan; this plan implements only the provider boundary and TOTP-removal blocker approved on 2026-09-02.
- Type consistency: Tasks 2-3 consume the exact `SecurityNotificationProvider`, `FactorChangeNotification`, `FactorRemovalService`, and result types produced earlier.
- Test integrity: provider tests assert the real HTTP request boundary; service tests assert orchestration order and committed outcomes; route tests assert user-visible status, cookie, and session behavior.
