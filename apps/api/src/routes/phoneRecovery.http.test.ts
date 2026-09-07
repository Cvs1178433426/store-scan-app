import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { phoneRecoveryRoutes } from "./phoneRecovery.js";

const service = {
  initiate: vi.fn(),
  adminStatus: vi.fn(),
  startEmailProof: vi.fn(),
  checkEmailCode: vi.fn(),
  startPhoneProof: vi.fn(),
  checkPhoneCodeAndComplete: vi.fn(),
  cancel: vi.fn(),
  resume: vi.fn(),
  resendPhoneProof: vi.fn(),
  resend: vi.fn(),
};

async function server(
  user = { sub: "admin-1", role: "ADMIN", amr: "SMS", iat: Math.floor(Date.now() / 1_000) },
  settlePublicStart?: (startedAt: number) => Promise<void>,
) {
  const app = Fastify();
  await app.register(cookie);
  app.decorate("authenticate", async (request) => { (request as typeof request & { user: typeof user }).user = user; });
  app.decorate("requireAdmin", async () => {});
  await app.register(phoneRecoveryRoutes, { service, rateLimitKey: "r".repeat(32), settlePublicStart });
  return app;
}

describe("phone recovery routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires a recent independently MFA-authenticated administrator", async () => {
    const app = await server({ sub: "admin-1", role: "ADMIN", amr: "SMS", iat: 1 });
    const response = await app.inject({ method: "POST", url: "/users/user-1/phone-recovery" });
    expect(response.statusCode).toBe(403);
    expect(service.initiate).not.toHaveBeenCalled();
  });

  it("returns only the case reference after accepted initiation", async () => {
    const app = await server();
    service.initiate.mockResolvedValue({ caseId: "case-1", caseReference: "reference-1", expiresAt: new Date("2026-09-08T12:00:00Z") });
    const response = await app.inject({ method: "POST", url: "/users/user-1/phone-recovery" });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ caseId: "case-1", caseReference: "reference-1", expiresAt: "2026-09-08T12:00:00.000Z" });
  });

  it("returns safe administrator recovery status and history after reload", async () => {
    const app = await server();
    service.adminStatus.mockResolvedValue({
      cases: [{ caseId: "case-1", status: "EMAIL_PENDING", startedAt: new Date("2026-09-07T12:00:00Z"), expiresAt: new Date("2026-09-08T12:00:00Z") }],
      events: [{ eventType: "phone_recovery_email_notification", outcome: "accepted", safeReasonCode: "provider_accepted", occurredAt: new Date("2026-09-07T12:00:01Z") }],
    });

    const response = await app.inject({ method: "GET", url: "/users/user-1/phone-recovery" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      cases: [{ caseId: "case-1", status: "EMAIL_PENDING", startedAt: "2026-09-07T12:00:00.000Z", expiresAt: "2026-09-08T12:00:00.000Z" }],
      events: [{ eventType: "phone_recovery_email_notification", outcome: "accepted", safeReasonCode: "provider_accepted", occurredAt: "2026-09-07T12:00:01.000Z" }],
    });
    expect(response.json()).not.toHaveProperty("email");
    expect(JSON.stringify(response.json())).not.toMatch(/employee@example|6317423355|123456|providerRef/i);
  });

  it("uses the same public response and strict cookie for every start", async () => {
    const app = await server();
    service.startEmailProof.mockResolvedValue({ status: "verification_pending", challengeId: "challenge-1" });
    const response = await app.inject({
      method: "POST", url: "/phone-recovery/start",
      payload: { email: "employee@example.com", employeeNumber: "EMP-1", caseReference: "reference-1" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "verification_pending" });
    expect(response.headers["set-cookie"]).toContain("continuixai_phone_recovery=challenge-1");
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Strict");
  });

  it.each([
    ["matching", false],
    ["nonmatching or provider-failed", true],
  ])("holds the %s public start behind the same response-time gate", async (_label, rejects) => {
    let release!: () => void;
    const timingGate = new Promise<void>((resolve) => { release = resolve; });
    const settlePublicStart = vi.fn(async () => timingGate);
    const app = await server(undefined, settlePublicStart);
    if (rejects) service.startEmailProof.mockRejectedValue(new Error("private provider detail"));
    else service.startEmailProof.mockResolvedValue({ status: "verification_pending", challengeId: "challenge-1" });

    const responsePromise = app.inject({
      method: "POST", url: "/phone-recovery/start",
      payload: { email: "employee@example.com", employeeNumber: "EMP-1", caseReference: "reference-1" },
    });
    const earlyResult = await Promise.race([
      responsePromise.then(() => "responded" as const),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 10)),
    ]);
    expect(settlePublicStart).toHaveBeenCalledTimes(1);
    expect(earlyResult).toBe("waiting");

    release();
    const response = await responsePromise;
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "verification_pending" });
  });

  it("verifies email without issuing an authenticated session", async () => {
    const app = await server();
    service.checkEmailCode.mockResolvedValue({ status: "email_verified", caseId: "case-1" });
    const response = await app.inject({
      method: "POST", url: "/phone-recovery/email/check",
      headers: { cookie: "continuixai_phone_recovery=challenge-1" }, payload: { code: "12345678" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "email_verified" });
    expect(response.json()).not.toHaveProperty("token");
  });

  it("resumes a live browser-bound recovery session without returning identity data", async () => {
    const app = await server();
    service.resume.mockResolvedValue({ stage: "sms", maskedDestination: "(***) ***-3355" });
    const response = await app.inject({
      method: "GET", url: "/phone-recovery/status",
      headers: { cookie: "continuixai_phone_recovery=sms-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ stage: "sms", maskedDestination: "(***) ***-3355" });
    expect(response.json()).not.toHaveProperty("email");
    expect(response.json()).not.toHaveProperty("caseId");
  });

  it("clears an unknown or expired recovery cookie", async () => {
    const app = await server();
    service.resume.mockRejectedValue(new Error("private detail"));
    const response = await app.inject({
      method: "GET", url: "/phone-recovery/status",
      headers: { cookie: "continuixai_phone_recovery=expired" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Recovery session expired." });
    expect(response.headers["set-cookie"]).toContain("continuixai_phone_recovery=");
    expect(response.headers["set-cookie"]).toContain("Max-Age=0");
  });

  it("starts replacement-phone proof only from the browser-bound email challenge", async () => {
    const app = await server();
    service.startPhoneProof.mockResolvedValue({ status: "verification_pending", challengeId: "sms-1" });
    const response = await app.inject({
      method: "POST", url: "/phone-recovery/phone/start",
      headers: { cookie: "continuixai_phone_recovery=email-1" },
      payload: { phone: "+1 631 742 3355", smsConsent: true, consentVersion: "2026-09-01", turnstileToken: "human" },
    });
    expect(response.statusCode).toBe(202);
    expect(service.startPhoneProof).toHaveBeenCalledWith(expect.objectContaining({ emailChallengeId: "email-1" }));
    expect(response.headers["set-cookie"]).toContain("continuixai_phone_recovery=sms-1");
  });

  it("replaces the browser-bound SMS challenge without exposing recovery identity", async () => {
    const app = await server();
    service.resend.mockResolvedValue({
      status: "verification_pending",
      stage: "sms",
      challengeId: "sms-2",
      maskedDestination: "(***) ***-3355",
    });
    const response = await app.inject({
      method: "POST", url: "/phone-recovery/resend",
      headers: { cookie: "continuixai_phone_recovery=sms-1" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      status: "verification_pending",
      maskedDestination: "(***) ***-3355",
    });
    expect(response.headers["set-cookie"]).toContain("continuixai_phone_recovery=sms-2");
    expect(response.json()).not.toHaveProperty("caseId");
    expect(response.json()).not.toHaveProperty("challengeId");
  });

  it("replaces the browser-bound email challenge with the same generic response", async () => {
    const app = await server();
    service.resend.mockResolvedValue({
      status: "verification_pending",
      stage: "email",
      challengeId: "email-2",
    });
    const response = await app.inject({
      method: "POST", url: "/phone-recovery/resend",
      headers: { cookie: "continuixai_phone_recovery=email-1" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "verification_pending" });
    expect(response.headers["set-cookie"]).toContain("continuixai_phone_recovery=email-2");
  });

  it("completes recovery without issuing a session", async () => {
    const app = await server();
    service.checkPhoneCodeAndComplete.mockResolvedValue({ status: "recovery_complete", notificationWarning: false });
    const response = await app.inject({
      method: "POST", url: "/phone-recovery/phone/check",
      headers: { cookie: "continuixai_phone_recovery=sms-1" }, payload: { code: "123456" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "recovery_complete", notificationWarning: false });
    expect(response.json()).not.toHaveProperty("token");
  });
});
