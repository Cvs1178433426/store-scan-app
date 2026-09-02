import { describe, expect, it, vi } from "vitest";
import { TwilioVerifyProvider } from "./twilioVerifyProvider.js";
import { assertSmsMfaConfig, VerificationAmbiguousError } from "./verificationProvider.js";

const config = {
  accountSid: "AC123",
  apiKeySid: "SK123",
  apiKeySecret: "secret-value",
  serviceSid: "VA123",
  timeoutMs: 500,
};

describe("Twilio Verify adapter", () => {
  it("fails startup when SMS MFA is enabled without every server-side secret", () => {
    expect(() => assertSmsMfaConfig({ SMS_MFA_ENABLED: "true" })).toThrow(/TWILIO_ACCOUNT_SID/);
    expect(() => assertSmsMfaConfig({
      SMS_MFA_ENABLED: "true",
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_API_KEY_SID: "SK123",
      TWILIO_API_KEY_SECRET: "secret",
      TWILIO_VERIFY_SERVICE_SID: "VA123",
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      TURNSTILE_EXPECTED_HOSTNAME: "candidate.continuixai.com",
      PHONE_ENCRYPTION_KEYS: `1:${"11".repeat(32)}`,
      PHONE_LOOKUP_HMAC_KEYS: `1:${"22".repeat(32)}`,
      RATE_LIMIT_HMAC_KEY: "rate-limit-secret",
    })).not.toThrow();
  });

  it("fails startup for an invalid migration deadline", () => {
    expect(() => assertSmsMfaConfig({
      SMS_MFA_ENABLED: "true",
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_API_KEY_SID: "SK123",
      TWILIO_API_KEY_SECRET: "secret",
      TWILIO_VERIFY_SERVICE_SID: "VA123",
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      TURNSTILE_EXPECTED_HOSTNAME: "candidate.continuixai.com",
      PHONE_ENCRYPTION_KEYS: `1:${"11".repeat(32)}`,
      PHONE_LOOKUP_HMAC_KEYS: `1:${"22".repeat(32)}`,
      RATE_LIMIT_HMAC_KEY: "rate-limit-secret",
      SMS_MFA_MIGRATION_DEADLINE: "not-a-date",
    })).toThrow(/SMS_MFA_MIGRATION_DEADLINE/);
  });

  it("starts an SMS verification and returns only its provider reference", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ sid: "VE123", status: "pending" }), { status: 201 }));
    const provider = new TwilioVerifyProvider({ ...config, fetchImpl });
    await expect(provider.start("+16317423355", "sms")).resolves.toEqual({ providerRef: "VE123" });
    const [, request] = fetchImpl.mock.calls[0];
    expect(String(request?.body)).toContain("To=%2B16317423355");
    expect(request?.headers).toMatchObject({ Authorization: `Basic ${Buffer.from("SK123:secret-value").toString("base64")}` });
  });

  it("maps approved and rejected checks to a provider-neutral boolean", async () => {
    const approvedFetch = vi.fn(async () => new Response(JSON.stringify({ status: "approved" }), { status: 200 }));
    await expect(new TwilioVerifyProvider({ ...config, fetchImpl: approvedFetch }).check("VE123", "+16317423355", "123456"))
      .resolves.toEqual({ matched: true });
    const rejectedFetch = vi.fn(async () => new Response(JSON.stringify({ status: "pending" }), { status: 200 }));
    await expect(new TwilioVerifyProvider({ ...config, fetchImpl: rejectedFetch }).check("VE123", "+16317423355", "654321"))
      .resolves.toEqual({ matched: false });
  });

  it("treats a missing resolved verification as ambiguous", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: 20404 }), { status: 404 }));
    await expect(new TwilioVerifyProvider({ ...config, fetchImpl }).check("VE123", "+16317423355", "123456"))
      .rejects.toBeInstanceOf(VerificationAmbiguousError);
  });

  it("never includes submitted phone numbers or codes in errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("provider exploded", { status: 500 }));
    let caught: unknown;
    try { await new TwilioVerifyProvider({ ...config, fetchImpl }).check("VE123", "+16317423355", "123456"); } catch (error) { caught = error; }
    expect(String(caught)).not.toContain("+16317423355");
    expect(String(caught)).not.toContain("123456");
  });
});
