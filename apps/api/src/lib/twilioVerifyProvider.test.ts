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

const productionSmsConfig = {
  NODE_ENV: "production",
  SMS_MFA_ENABLED: "true",
  SMS_MFA_MIGRATION_DEADLINE: "2026-12-31T23:59:59.000Z",
  TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
  TWILIO_API_KEY_SID: `SK${"2".repeat(32)}`,
  TWILIO_VERIFY_API_KEY_TYPE: "restricted",
  TWILIO_API_KEY_SECRET: "verify-restricted-secret",
  TWILIO_VERIFY_SERVICE_SID: `VA${"3".repeat(32)}`,
  TWILIO_NOTIFICATION_API_KEY_SID: `SK${"4".repeat(32)}`,
  TWILIO_NOTIFICATION_API_KEY_TYPE: "restricted",
  TWILIO_NOTIFICATION_API_KEY_SECRET: "notification-restricted-secret",
  TWILIO_MESSAGING_SERVICE_SID: `MG${"5".repeat(32)}`,
  TURNSTILE_SECRET_KEY: "turnstile-secret",
  TURNSTILE_EXPECTED_HOSTNAME: "candidate.continuixai.com",
  PHONE_ENCRYPTION_KEYS: `1:${"11".repeat(32)}`,
  PHONE_LOOKUP_HMAC_KEYS: `1:${"22".repeat(32)}`,
  RATE_LIMIT_HMAC_KEY: "independent-rate-limit-secret",
  SMS_MFA_BOOTSTRAP_ADMIN_EMAIL: "Mitchell.Kobran@ContinuiXAi.com",
  SMS_MFA_BOOTSTRAP_ADMIN_PHONE: "+16317423355",
  SENDGRID_RECOVERY_API_KEY: "SG.recovery-key",
  MFA_RECOVERY_FROM_EMAIL: "security@continuixai.com",
  MFA_RECOVERY_PUBLIC_URL: "https://ops.continuixai.com/recover-phone",
  EMAIL_OTP_HMAC_KEY: "independent-email-otp-key-material-123456",
};

describe("Twilio Verify adapter", () => {
  it("accepts a fully separated production SMS configuration", () => {
    expect(() => assertSmsMfaConfig(productionSmsConfig)).not.toThrow();
  });

  it.each([
    "SMS_MFA_MIGRATION_DEADLINE",
    "TWILIO_VERIFY_API_KEY_TYPE",
    "TWILIO_NOTIFICATION_API_KEY_SID",
    "TWILIO_NOTIFICATION_API_KEY_TYPE",
    "TWILIO_NOTIFICATION_API_KEY_SECRET",
    "TWILIO_MESSAGING_SERVICE_SID",
    "SENDGRID_RECOVERY_API_KEY",
    "MFA_RECOVERY_FROM_EMAIL",
    "MFA_RECOVERY_PUBLIC_URL",
    "EMAIL_OTP_HMAC_KEY",
  ])("requires production setting %s", (name) => {
    expect(() => assertSmsMfaConfig({ ...productionSmsConfig, [name]: undefined }))
      .toThrow(new RegExp(name));
  });

  it.each(["main", "standard", "Restricted", "restricted "])(
    "rejects non-exact restricted-key type declaration %s",
    (keyType) => {
      expect(() => assertSmsMfaConfig({
        ...productionSmsConfig,
        TWILIO_VERIFY_API_KEY_TYPE: keyType,
      })).toThrow(/TWILIO_VERIFY_API_KEY_TYPE/);
      expect(() => assertSmsMfaConfig({
        ...productionSmsConfig,
        TWILIO_NOTIFICATION_API_KEY_TYPE: keyType,
      })).toThrow(/TWILIO_NOTIFICATION_API_KEY_TYPE/);
    },
  );

  it.each([
    ["account SID", "TWILIO_ACCOUNT_SID", `SK${"1".repeat(32)}`],
    ["Verify restricted-key SID", "TWILIO_API_KEY_SID", `AC${"2".repeat(32)}`],
    ["Verify service SID", "TWILIO_VERIFY_SERVICE_SID", `VE${"3".repeat(32)}`],
    ["notification restricted-key SID", "TWILIO_NOTIFICATION_API_KEY_SID", `AC${"4".repeat(32)}`],
    ["Messaging service SID", "TWILIO_MESSAGING_SERVICE_SID", `VA${"5".repeat(32)}`],
  ])("rejects an invalid production %s", (_label, name, value) => {
    expect(() => assertSmsMfaConfig({ ...productionSmsConfig, [name]: value }))
      .toThrow(new RegExp(name));
  });

  it.each([
    ["TWILIO_ACCOUNT_SID", `ac${"1".repeat(32)}`],
    ["TWILIO_API_KEY_SID", `sk${"2".repeat(32)}`],
    ["TWILIO_VERIFY_SERVICE_SID", `va${"3".repeat(32)}`],
    ["TWILIO_NOTIFICATION_API_KEY_SID", `sk${"4".repeat(32)}`],
    ["TWILIO_MESSAGING_SERVICE_SID", `mg${"5".repeat(32)}`],
  ])("rejects lowercase Twilio SID prefix for %s", (name, value) => {
    expect(() => assertSmsMfaConfig({ ...productionSmsConfig, [name]: value }))
      .toThrow(new RegExp(name));
  });

  it.each([
    ["key SID", { TWILIO_NOTIFICATION_API_KEY_SID: productionSmsConfig.TWILIO_API_KEY_SID }],
    ["key secret", { TWILIO_NOTIFICATION_API_KEY_SECRET: productionSmsConfig.TWILIO_API_KEY_SECRET }],
  ])("rejects reused Verify and notification %s values", (_label, duplicate) => {
    expect(() => assertSmsMfaConfig({ ...productionSmsConfig, ...duplicate }))
      .toThrow(/independent restricted credentials/);
  });

  it.each([
    "2026-12-31",
    "2026-12-31 23:59:59",
    "2026-02-30T00:00:00Z",
    "2026-12-31T25:00:00Z",
    "2026-12-31T23:59:59",
  ])("rejects non-ISO or impossible migration deadline %s", (deadline) => {
    expect(() => assertSmsMfaConfig({
      ...productionSmsConfig,
      SMS_MFA_MIGRATION_DEADLINE: deadline,
    })).toThrow(/SMS_MFA_MIGRATION_DEADLINE/);
  });

  it("accepts an ISO migration deadline with an explicit offset", () => {
    expect(() => assertSmsMfaConfig({
      ...productionSmsConfig,
      SMS_MFA_MIGRATION_DEADLINE: "2026-12-31T18:59:59-05:00",
    })).not.toThrow();
  });

  it("requires an exact bootstrap owner email and phone when SMS MFA is enabled", () => {
    const valid = {
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
      SMS_MFA_BOOTSTRAP_ADMIN_EMAIL: "Mitchell.Kobran@ContinuiXAi.com",
      SMS_MFA_BOOTSTRAP_ADMIN_PHONE: "+16317423355",
    };
    expect(() => assertSmsMfaConfig({ ...valid, SMS_MFA_BOOTSTRAP_ADMIN_EMAIL: undefined })).toThrow(/SMS_MFA_BOOTSTRAP_ADMIN_EMAIL/);
    expect(() => assertSmsMfaConfig({ ...valid, SMS_MFA_BOOTSTRAP_ADMIN_PHONE: undefined })).toThrow(/SMS_MFA_BOOTSTRAP_ADMIN_PHONE/);
    expect(() => assertSmsMfaConfig({ ...valid, SMS_MFA_BOOTSTRAP_ADMIN_PHONE: "not-a-phone" })).toThrow(/SMS_MFA_BOOTSTRAP_ADMIN_PHONE/);
    expect(() => assertSmsMfaConfig(valid)).not.toThrow();
  });

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
      SMS_MFA_BOOTSTRAP_ADMIN_EMAIL: "mitchell.kobran@continuixai.com",
      SMS_MFA_BOOTSTRAP_ADMIN_PHONE: "+16317423355",
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
      SMS_MFA_BOOTSTRAP_ADMIN_EMAIL: "mitchell.kobran@continuixai.com",
      SMS_MFA_BOOTSTRAP_ADMIN_PHONE: "+16317423355",
      SMS_MFA_MIGRATION_DEADLINE: "not-a-date",
    })).toThrow(/SMS_MFA_MIGRATION_DEADLINE/);
  });

  it("fails startup for malformed, duplicate, or reused cryptographic keys", () => {
    const valid = {
      SMS_MFA_ENABLED: "true",
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_API_KEY_SID: "SK123",
      TWILIO_API_KEY_SECRET: "secret",
      TWILIO_VERIFY_SERVICE_SID: "VA123",
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      TURNSTILE_EXPECTED_HOSTNAME: "candidate.continuixai.com",
      PHONE_ENCRYPTION_KEYS: `2:${"11".repeat(32)},1:${"22".repeat(32)}`,
      PHONE_LOOKUP_HMAC_KEYS: `2:${"33".repeat(32)},1:${"44".repeat(32)}`,
      RATE_LIMIT_HMAC_KEY: "independent-rate-limit-secret",
      SMS_MFA_BOOTSTRAP_ADMIN_EMAIL: "mitchell.kobran@continuixai.com",
      SMS_MFA_BOOTSTRAP_ADMIN_PHONE: "+16317423355",
    };

    expect(() => assertSmsMfaConfig({ ...valid, PHONE_ENCRYPTION_KEYS: "not-versioned" }))
      .toThrow(/PHONE_ENCRYPTION_KEYS/);
    expect(() => assertSmsMfaConfig({
      ...valid,
      PHONE_LOOKUP_HMAC_KEYS: `2:${"33".repeat(32)},2:${"44".repeat(32)}`,
    })).toThrow(/duplicate key version/);
    expect(() => assertSmsMfaConfig({
      ...valid,
      PHONE_LOOKUP_HMAC_KEYS: `2:${"11".repeat(32)},1:${"44".repeat(32)}`,
    })).toThrow(/must use independent key material/);
    expect(() => assertSmsMfaConfig({
      ...valid,
      RATE_LIMIT_HMAC_KEY: "11".repeat(32),
    })).toThrow(/RATE_LIMIT_HMAC_KEY must use independent key material/);
    expect(() => assertSmsMfaConfig({
      ...valid,
      PHONE_ENCRYPTION_KEYS: `1:${"61".repeat(32)}`,
      RATE_LIMIT_HMAC_KEY: "a".repeat(32),
    })).toThrow(/RATE_LIMIT_HMAC_KEY must use independent key material/);
    expect(() => assertSmsMfaConfig({
      ...valid,
      PHONE_ENCRYPTION_KEYS: `${"9".repeat(400)}:${"11".repeat(32)}`,
    })).toThrow(/safe positive integer/);
    expect(() => assertSmsMfaConfig({
      ...valid,
      PHONE_ENCRYPTION_KEYS: `2147483648:${"11".repeat(32)}`,
    })).toThrow(/32-bit integer/);
    expect(() => assertSmsMfaConfig({
      ...valid,
      PHONE_LOOKUP_HMAC_KEYS: `1:${"44".repeat(32)},`,
    })).toThrow(/empty key-ring entries/);
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

  it("treats a lost verification-check response as ambiguous but a failed send as unavailable", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("network response lost"); });
    const provider = new TwilioVerifyProvider({ ...config, fetchImpl });

    await expect(provider.check("VE123", "+16317423355", "123456"))
      .rejects.toBeInstanceOf(VerificationAmbiguousError);
    await expect(provider.start("+16317423355", "sms"))
      .rejects.not.toBeInstanceOf(VerificationAmbiguousError);
  });

  it("keeps the check deadline active while reading the provider response body", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return {
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("body aborted")), { once: true });
        }),
      } as Response;
    });
    const provider = new TwilioVerifyProvider({ ...config, timeoutMs: 5, fetchImpl });

    const outcome = await Promise.race([
      provider.check("VE123", "+16317423355", "123456").catch((error) => error),
      new Promise((resolve) => setTimeout(() => resolve("body-read-hung"), 30)),
    ]);

    expect(outcome).toBeInstanceOf(VerificationAmbiguousError);
    expect(signal?.aborted).toBe(true);
  });

  it("never includes submitted phone numbers or codes in errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("provider exploded", { status: 500 }));
    let caught: unknown;
    try { await new TwilioVerifyProvider({ ...config, fetchImpl }).check("VE123", "+16317423355", "123456"); } catch (error) { caught = error; }
    expect(String(caught)).not.toContain("+16317423355");
    expect(String(caught)).not.toContain("123456");
  });
});
