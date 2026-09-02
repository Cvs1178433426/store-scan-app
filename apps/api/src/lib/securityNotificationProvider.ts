import { TwilioMessagingNotificationProvider } from "./twilioMessagingNotificationProvider.js";

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

type SecurityNotificationEnvironment = {
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_NOTIFICATION_API_KEY_SID?: string;
  TWILIO_NOTIFICATION_API_KEY_SECRET?: string;
  TWILIO_MESSAGING_SERVICE_SID?: string;
};

function requiredSetting(environment: SecurityNotificationEnvironment, setting: keyof SecurityNotificationEnvironment): string {
  const value = environment[setting]?.trim();
  if (!value) throw new SecurityNotificationConfigurationError("Security notification configuration is invalid.");
  return value;
}

export function createSecurityNotificationProvider(
  environment: SecurityNotificationEnvironment,
  fetchImpl: typeof fetch = fetch,
): SecurityNotificationProvider {
  return new TwilioMessagingNotificationProvider({
    accountSid: requiredSetting(environment, "TWILIO_ACCOUNT_SID"),
    apiKeySid: requiredSetting(environment, "TWILIO_NOTIFICATION_API_KEY_SID"),
    apiKeySecret: requiredSetting(environment, "TWILIO_NOTIFICATION_API_KEY_SECRET"),
    messagingServiceSid: requiredSetting(environment, "TWILIO_MESSAGING_SERVICE_SID"),
  }, fetchImpl);
}
