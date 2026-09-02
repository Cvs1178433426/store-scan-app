import {
  SecurityNotificationRequestError,
  type FactorChangeNotification,
  type SecurityNotificationProvider,
} from "./securityNotificationProvider.js";

const BODY = "ContinuiXAi security alert: An authenticator backup was removed. If this wasn't you, contact your administrator immediately.";

type TwilioMessagingConfig = {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  messagingServiceSid: string;
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
      Body: BODY,
    }).toString().replaceAll("+", "%20");

    let response: Response;
    try {
      response = await this.fetchImpl(
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
    } catch {
      throw new SecurityNotificationRequestError("Security notification request was not accepted.");
    }

    if (!response.ok) throw new SecurityNotificationRequestError("Security notification request was not accepted.");

    const payload = await response.json().catch(() => null) as { sid?: unknown } | null;
    if (typeof payload?.sid !== "string" || !payload.sid) {
      throw new SecurityNotificationRequestError("Security notification request was not accepted.");
    }

    return { providerRef: payload.sid };
  }
}
