import { describe, expect, it, vi } from "vitest";
import { assertTwilioRestrictedKeyPolicies } from "./verificationProvider.js";

const verifySid = `SK${"2".repeat(32)}`;
const notificationSid = `SK${"4".repeat(32)}`;
const environment = {
  NODE_ENV: "production",
  SMS_MFA_ENABLED: "true",
  SMS_MFA_MIGRATION_DEADLINE: "2026-12-31T23:59:59.000Z",
  TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
  TWILIO_API_KEY_SID: verifySid,
  TWILIO_VERIFY_API_KEY_TYPE: "restricted",
  TWILIO_API_KEY_SECRET: "verify-secret",
  TWILIO_VERIFY_SERVICE_SID: `VA${"3".repeat(32)}`,
  TWILIO_NOTIFICATION_API_KEY_SID: notificationSid,
  TWILIO_NOTIFICATION_API_KEY_TYPE: "restricted",
  TWILIO_NOTIFICATION_API_KEY_SECRET: "notification-secret",
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

const verifyPolicy = {
  allow: [
    "/twilio/iam/api-keys/read",
    "/twilio/verify/verification/create",
    "/twilio/verify/verification-check/create",
  ],
};
const notificationPolicy = {
  allow: [
    "/twilio/iam/api-keys/read",
    "/twilio/messaging/messages/create",
  ],
};

function policyFetch(overrides: Partial<Record<string, unknown>> = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const sid = url.endsWith(notificationSid) ? notificationSid : verifySid;
    const policy = sid === notificationSid ? notificationPolicy : verifyPolicy;
    return new Response(JSON.stringify({ sid, policy, ...overrides }), { status: 200 });
  }) as typeof fetch;
}

describe("Twilio restricted-key policy startup gate", () => {
  it("cross-checks both independent keys and their exact least-privilege policies", async () => {
    const fetchImpl = policyFetch();
    await expect(assertTwilioRestrictedKeyPolicies(environment, fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      `https://iam.twilio.com/v1/Keys/${notificationSid}`,
      expect.objectContaining({
        headers: { Authorization: `Basic ${Buffer.from(`${verifySid}:verify-secret`).toString("base64")}` },
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      `https://iam.twilio.com/v1/Keys/${verifySid}`,
      expect.objectContaining({
        headers: { Authorization: `Basic ${Buffer.from(`${notificationSid}:notification-secret`).toString("base64")}` },
      }),
    );
  });

  it.each([
    ["standard or Main key", { policy: null }],
    ["unexpected permission", { policy: { allow: [...verifyPolicy.allow, "/twilio/voice/calls/create"] } }],
    ["wrong key identity", { sid: `SK${"9".repeat(32)}` }],
  ])("fails closed for %s", async (_label, override) => {
    await expect(assertTwilioRestrictedKeyPolicies(environment, policyFetch(override)))
      .rejects.toThrow(/Twilio restricted-key policy validation failed/);
  });

  it("fails closed when Twilio policy inspection is unavailable", async () => {
    const fetchImpl = vi.fn(async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    await expect(assertTwilioRestrictedKeyPolicies(environment, fetchImpl))
      .rejects.toThrow(/Twilio restricted-key policy validation failed/);
  });

  it("does not contact Twilio outside an enabled production deployment", async () => {
    const fetchImpl = vi.fn() as typeof fetch;
    await expect(assertTwilioRestrictedKeyPolicies({ ...environment, NODE_ENV: "test" }, fetchImpl))
      .resolves.toBeUndefined();
    await expect(assertTwilioRestrictedKeyPolicies({ ...environment, SMS_MFA_ENABLED: "false" }, fetchImpl))
      .resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
