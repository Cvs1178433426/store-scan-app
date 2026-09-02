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
