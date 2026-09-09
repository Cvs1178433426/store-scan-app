import { describe, expect, it, vi } from "vitest";
import {
  createSecurityNotificationProvider,
  SecurityNotificationConfigurationError,
  SecurityNotificationRequestError,
} from "./securityNotificationProvider.js";

const environment = {
  TWILIO_ACCOUNT_SID: "AC123",
  TWILIO_NOTIFICATION_API_KEY_SID: "SK-NOTIFY",
  TWILIO_NOTIFICATION_API_KEY_SECRET: "notify-secret",
  TWILIO_MESSAGING_SERVICE_SID: "MG123",
};

const notificationInput = {
  destination: "+16317423355",
  event: "TOTP_REMOVED" as const,
  correlationId: "corr-1",
};

function configuredProvider(fetchImpl: typeof fetch) {
  return createSecurityNotificationProvider(environment, fetchImpl);
}

describe("Twilio Messaging security notification adapter", () => {
  it("submits a generic factor-change notice with dedicated credentials", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ sid: "SM123" }), { status: 201 }));
    const provider = configuredProvider(fetchImpl);

    await expect(provider.notifyFactorChanged(notificationInput)).resolves.toEqual({ providerRef: "SM123" });

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

  it("uses a generic old-phone alert after controlled phone recovery", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ sid: "SM456" }), { status: 201 }));
    const provider = configuredProvider(fetchImpl);

    await provider.notifyFactorChanged({ ...notificationInput, event: "PHONE_RECOVERED", correlationId: "case-1" });

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const message = new URLSearchParams(String(init.body)).get("Body") ?? "";
    expect(message).toContain("Your verified phone was replaced.");
    expect(message).not.toContain("6317423355");
  });

  it.each([400, 401, 429, 500])("fails generically for Twilio status %s", async (status) => {
    const provider = configuredProvider(async () => new Response("provider detail", { status }));

    await expect(provider.notifyFactorChanged(notificationInput)).rejects.toThrow(
      "Security notification request was not accepted.",
    );
  });

  it("fails generically when Twilio accepts a request without a message SID", async () => {
    const provider = configuredProvider(async () => new Response(JSON.stringify({}), { status: 201 }));

    await expect(provider.notifyFactorChanged(notificationInput)).rejects.toThrow(
      SecurityNotificationRequestError,
    );
  });

  it("aborts a notification request that exceeds its deadline", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as typeof fetch;
    const provider = createSecurityNotificationProvider(environment, fetchImpl, 5);

    await expect(provider.notifyFactorChanged(notificationInput)).rejects.toThrow(
      "Security notification request was not accepted.",
    );
    expect(observedSignal?.aborted).toBe(true);
  });

  it("keeps the notification deadline active while reading the provider response body", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return {
        ok: true,
        status: 201,
        json: () => new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("body aborted")), { once: true });
        }),
      } as Response;
    }) as typeof fetch;
    const provider = createSecurityNotificationProvider(environment, fetchImpl, 5);

    const outcome = await Promise.race([
      provider.notifyFactorChanged(notificationInput).catch((error) => error),
      new Promise((resolve) => setTimeout(() => resolve("body-read-hung"), 30)),
    ]);

    expect(outcome).toBeInstanceOf(SecurityNotificationRequestError);
    expect(signal?.aborted).toBe(true);
  });

  it.each([
    "TWILIO_ACCOUNT_SID",
    "TWILIO_NOTIFICATION_API_KEY_SID",
    "TWILIO_NOTIFICATION_API_KEY_SECRET",
    "TWILIO_MESSAGING_SERVICE_SID",
  ] as const)("requires a non-empty %s setting", (setting) => {
    const configuredEnvironment = { ...environment, [setting]: "  " };

    expect(() => createSecurityNotificationProvider(configuredEnvironment, fetch)).toThrow(
      SecurityNotificationConfigurationError,
    );
    expect(() => createSecurityNotificationProvider(configuredEnvironment, fetch)).not.toThrow("notify-secret");
  });
});
