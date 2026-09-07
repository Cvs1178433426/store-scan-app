import {
  SecurityNotificationRequestError,
  type FactorChangeNotification,
  type SecurityNotificationProvider,
} from "./securityNotificationProvider.js";

const BODY: Record<FactorChangeNotification["event"], string> = {
  TOTP_REMOVED: "ContinuiXAi security alert: An authenticator backup was removed. If this wasn't you, contact your administrator immediately.",
  PHONE_RECOVERED: "ContinuiXAi security alert: Your verified phone was replaced. If this wasn't you, contact your administrator immediately.",
};

type TwilioMessagingConfig = {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  messagingServiceSid: string;
  timeoutMs?: number;
};

export class TwilioMessagingNotificationProvider implements SecurityNotificationProvider {
  constructor(
    private readonly config: TwilioMessagingConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async notifyFactorChanged(_input: FactorChangeNotification): Promise<{ providerRef: string }> {
    const body = new URLSearchParams({
      To: _input.destination,
      MessagingServiceSid: this.config.messagingServiceSid,
      Body: BODY[_input.event],
    }).toString().replaceAll("+", "%20");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 8_000);
    try {
      const response = await this.fetchImpl(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.config.accountSid)}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${this.config.apiKeySid}:${this.config.apiKeySecret}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new SecurityNotificationRequestError("Security notification request was not accepted.");

      const payload = await response.json() as { sid?: unknown };
      if (typeof payload?.sid !== "string" || !payload.sid) {
        throw new SecurityNotificationRequestError("Security notification request was not accepted.");
      }

      return { providerRef: payload.sid };
    } catch {
      throw new SecurityNotificationRequestError("Security notification request was not accepted.");
    } finally {
      clearTimeout(timer);
    }
  }
}
