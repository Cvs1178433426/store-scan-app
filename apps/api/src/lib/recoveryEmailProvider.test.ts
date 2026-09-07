import { describe, expect, it, vi } from "vitest";
import {
  assertRecoveryEmailConfig,
  createRecoveryEmailProvider,
  RecoveryEmailConfigurationError,
  RecoveryEmailRequestError,
} from "./recoveryEmailProvider.js";

const environment = {
  SENDGRID_RECOVERY_API_KEY: "SG.recovery-key",
  MFA_RECOVERY_FROM_EMAIL: "security@continuixai.com",
  MFA_RECOVERY_PUBLIC_URL: "https://ops.continuixai.com/recover-phone",
  EMAIL_OTP_HMAC_KEY: "independent-email-otp-key-material-123456",
};

describe("SendGrid recovery email adapter", () => {
  it("sends a generic recovery code through the verified sender", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 })) as typeof fetch;
    const provider = createRecoveryEmailProvider(environment, fetchImpl);
    const expiresAt = new Date("2026-09-06T15:15:00Z");

    await expect(provider.send({
      kind: "recovery_code",
      destination: "employee@example.com",
      code: "12345678",
      expiresAt,
    })).resolves.toEqual({ accepted: true });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.sendgrid.com/v3/mail/send",
      expect.objectContaining({ method: "POST" }),
    );
    const request = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(request.headers).toMatchObject({
      Authorization: "Bearer SG.recovery-key",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(request.body));
    expect(body.personalizations).toEqual([{ to: [{ email: "employee@example.com" }] }]);
    expect(body.from).toEqual({ email: "security@continuixai.com" });
    expect(body.subject).not.toContain("12345678");
    expect(body.content[0].value).toContain("12345678");
    expect(body.content[0].value).toContain(expiresAt.toISOString());
  });

  it.each([
    { kind: "recovery_requested" as const, destination: "employee@example.com", expiresAt: new Date("2026-09-06T15:15:00Z"), caseReference: "CX-ABC123" },
    { kind: "recovery_completed" as const, destination: "employee@example.com", completedAt: new Date("2026-09-06T15:15:00Z") },
  ])("sends the $kind template without exposing account state in the subject", async (message) => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 })) as typeof fetch;
    const provider = createRecoveryEmailProvider(environment, fetchImpl);

    await expect(provider.send(message)).resolves.toEqual({ accepted: true });
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(body.subject).toBe("ContinuiXAi security notice");
    expect(body.content[0].value).toContain("ContinuiXAi");
  });

  it.each([400, 401, 429, 500])("rejects SendGrid status %s with a generic error", async (status) => {
    const provider = createRecoveryEmailProvider(environment, async () => new Response("provider detail", { status }));

    await expect(provider.send({
      kind: "recovery_code", destination: "employee@example.com", code: "87654321", expiresAt: new Date(),
    })).rejects.toEqual(expect.objectContaining({
      name: "RecoveryEmailRequestError",
      message: "Recovery email request was not accepted.",
    }));
  });

  it("aborts the provider request after eight seconds without leaking message data", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("employee@example.com 12345678")), { once: true });
        });
      }) as typeof fetch;
      const provider = createRecoveryEmailProvider(environment, fetchImpl);
      const pending = provider.send({
        kind: "recovery_code", destination: "employee@example.com", code: "12345678", expiresAt: new Date(),
      }).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(8_000);
      const outcome = await pending;
      expect(outcome).toBeInstanceOf(RecoveryEmailRequestError);
      expect((outcome as Error).message).not.toMatch(/employee@example\.com|12345678/);
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    "SENDGRID_RECOVERY_API_KEY",
    "MFA_RECOVERY_FROM_EMAIL",
    "MFA_RECOVERY_PUBLIC_URL",
    "EMAIL_OTP_HMAC_KEY",
  ] as const)("requires production setting %s", (name) => {
    expect(() => assertRecoveryEmailConfig({
      NODE_ENV: "production", SMS_MFA_ENABLED: "true", ...environment, [name]: " ",
    })).toThrow(RecoveryEmailConfigurationError);
  });

  it("requires HTTPS, a valid sender, and independent HMAC material in production", () => {
    const base = { NODE_ENV: "production", SMS_MFA_ENABLED: "true", ...environment };
    expect(() => assertRecoveryEmailConfig({ ...base, MFA_RECOVERY_PUBLIC_URL: "http://ops.continuixai.com" })).toThrow(/HTTPS/);
    expect(() => assertRecoveryEmailConfig({ ...base, MFA_RECOVERY_FROM_EMAIL: "not-an-email" })).toThrow(/sender/);
    expect(() => assertRecoveryEmailConfig({ ...base, EMAIL_OTP_HMAC_KEY: "too-short" })).toThrow(/HMAC/);
    expect(() => assertRecoveryEmailConfig({ ...base, RATE_LIMIT_HMAC_KEY: environment.EMAIL_OTP_HMAC_KEY })).toThrow(/independent/);
    expect(() => assertRecoveryEmailConfig(base)).not.toThrow();
  });

  it("does not require recovery email settings outside enabled production MFA", () => {
    expect(() => assertRecoveryEmailConfig({ NODE_ENV: "test", SMS_MFA_ENABLED: "true" })).not.toThrow();
    expect(() => assertRecoveryEmailConfig({ NODE_ENV: "production", SMS_MFA_ENABLED: "false" })).not.toThrow();
  });
});
