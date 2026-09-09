import { normalizeUsPhone, parsePhoneKeyRing } from "./phone.js";
import { assertRecoveryEmailConfig } from "./recoveryEmailProvider.js";

export type VerificationChannel = "sms";
export type VerificationStartResult = { providerRef: string };
export type VerificationCheckResult = { matched: boolean };

export interface VerificationProvider {
  start(destination: string, channel: VerificationChannel): Promise<VerificationStartResult>;
  check(providerRef: string, destination: string, code: string): Promise<VerificationCheckResult>;
}

export class VerificationProviderError extends Error {
  constructor(message = "Verification provider request failed.") {
    super(message);
    this.name = "VerificationProviderError";
  }
}

export class VerificationAmbiguousError extends VerificationProviderError {
  constructor() {
    super("Verification result is unavailable. Start a new challenge.");
    this.name = "VerificationAmbiguousError";
  }
}

const REQUIRED_SMS_MFA_SETTINGS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_VERIFY_SERVICE_SID",
  "TURNSTILE_SECRET_KEY",
  "TURNSTILE_EXPECTED_HOSTNAME",
  "PHONE_ENCRYPTION_KEYS",
  "PHONE_LOOKUP_HMAC_KEYS",
  "RATE_LIMIT_HMAC_KEY",
  "SMS_MFA_BOOTSTRAP_ADMIN_EMAIL",
  "SMS_MFA_BOOTSTRAP_ADMIN_PHONE",
] as const;

const REQUIRED_PRODUCTION_SMS_MFA_SETTINGS = [
  "SMS_MFA_MIGRATION_DEADLINE",
  "TWILIO_VERIFY_API_KEY_TYPE",
  "TWILIO_NOTIFICATION_API_KEY_SID",
  "TWILIO_NOTIFICATION_API_KEY_TYPE",
  "TWILIO_NOTIFICATION_API_KEY_SECRET",
  "TWILIO_MESSAGING_SERVICE_SID",
] as const;

const TWILIO_SID_PATTERNS = {
  TWILIO_ACCOUNT_SID: /^AC[0-9a-fA-F]{32}$/,
  TWILIO_API_KEY_SID: /^SK[0-9a-fA-F]{32}$/,
  TWILIO_VERIFY_SERVICE_SID: /^VA[0-9a-fA-F]{32}$/,
  TWILIO_NOTIFICATION_API_KEY_SID: /^SK[0-9a-fA-F]{32}$/,
  TWILIO_MESSAGING_SERVICE_SID: /^MG[0-9a-fA-F]{32}$/,
} as const;

function isValidIso8601DateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return false;
  if (zone !== "Z") {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

export function assertSmsMfaConfig(environment: Record<string, string | undefined> = process.env): void {
  if (environment.SMS_MFA_ENABLED !== "true") return;
  assertRecoveryEmailConfig(environment);
  for (const name of REQUIRED_SMS_MFA_SETTINGS) {
    if (!environment[name]?.trim()) throw new Error(`${name} is required when SMS_MFA_ENABLED=true.`);
  }
  const isProduction = environment.NODE_ENV === "production";
  if (isProduction) {
    for (const name of REQUIRED_PRODUCTION_SMS_MFA_SETTINGS) {
      if (!environment[name]?.trim()) {
        throw new Error(`${name} is required in production when SMS_MFA_ENABLED=true.`);
      }
    }
    for (const [name, pattern] of Object.entries(TWILIO_SID_PATTERNS)) {
      if (!pattern.test(environment[name]!.trim())) {
        throw new Error(`${name} must be a valid Twilio SID in production.`);
      }
    }
    for (const name of ["TWILIO_VERIFY_API_KEY_TYPE", "TWILIO_NOTIFICATION_API_KEY_TYPE"] as const) {
      if (environment[name] !== "restricted") {
        throw new Error(`${name} must be exactly 'restricted' in production.`);
      }
    }
    if (
      environment.TWILIO_API_KEY_SID!.trim() === environment.TWILIO_NOTIFICATION_API_KEY_SID!.trim()
      || environment.TWILIO_API_KEY_SECRET!.trim() === environment.TWILIO_NOTIFICATION_API_KEY_SECRET!.trim()
    ) {
      throw new Error("Twilio Verify and notification providers must use independent restricted credentials.");
    }
  }
  const bootstrapEmail = environment.SMS_MFA_BOOTSTRAP_ADMIN_EMAIL!.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bootstrapEmail)) {
    throw new Error("SMS_MFA_BOOTSTRAP_ADMIN_EMAIL must be a valid email address.");
  }
  try {
    normalizeUsPhone(environment.SMS_MFA_BOOTSTRAP_ADMIN_PHONE!);
  } catch {
    throw new Error("SMS_MFA_BOOTSTRAP_ADMIN_PHONE must be a valid United States phone number.");
  }
  const migrationDeadline = environment.SMS_MFA_MIGRATION_DEADLINE?.trim();
  if (migrationDeadline && !isValidIso8601DateTime(migrationDeadline)) {
    throw new Error("SMS_MFA_MIGRATION_DEADLINE must be a valid ISO 8601 date-time.");
  }
  const encryptionKeys = parsePhoneKeyRing("PHONE_ENCRYPTION_KEYS", environment.PHONE_ENCRYPTION_KEYS);
  const lookupKeys = parsePhoneKeyRing("PHONE_LOOKUP_HMAC_KEYS", environment.PHONE_LOOKUP_HMAC_KEYS);
  const keyOwners = new Map<string, string>();
  for (const [owner, entries] of [
    ["PHONE_ENCRYPTION_KEYS", encryptionKeys],
    ["PHONE_LOOKUP_HMAC_KEYS", lookupKeys],
  ] as const) {
    for (const entry of entries) {
      const fingerprint = entry.key.toString("hex");
      if (keyOwners.has(fingerprint)) {
        throw new Error("SMS MFA cryptographic settings must use independent key material.");
      }
      keyOwners.set(fingerprint, owner);
    }
  }
  const rateLimitKey = environment.RATE_LIMIT_HMAC_KEY!.trim().toLowerCase();
  const rateLimitUtf8Fingerprint = Buffer.from(environment.RATE_LIMIT_HMAC_KEY!.trim(), "utf8").toString("hex");
  if (keyOwners.has(rateLimitKey) || keyOwners.has(rateLimitUtf8Fingerprint)) {
    throw new Error("RATE_LIMIT_HMAC_KEY must use independent key material.");
  }
}

const REQUIRED_TWILIO_KEY_POLICIES = {
  verify: [
    "/twilio/iam/api-keys/read",
    "/twilio/verify/verification/create",
    "/twilio/verify/verification-check/create",
  ],
  notification: [
    "/twilio/iam/api-keys/read",
    "/twilio/messaging/messages/create",
  ],
} as const;

type TwilioKeyPolicyResponse = {
  sid?: unknown;
  policy?: { allow?: unknown } | null;
};

async function fetchTwilioKeyPolicy(
  targetSid: string,
  credentialSid: string,
  credentialSecret: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<TwilioKeyPolicyResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`https://iam.twilio.com/v1/Keys/${targetSid}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentialSid}:${credentialSecret}`).toString("base64")}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("policy request rejected");
    return await response.json() as TwilioKeyPolicyResponse;
  } finally {
    clearTimeout(timeout);
  }
}

function hasExactPolicy(
  response: TwilioKeyPolicyResponse,
  expectedSid: string,
  expectedAllow: readonly string[],
): boolean {
  if (response.sid !== expectedSid || !Array.isArray(response.policy?.allow)) return false;
  const actual = response.policy.allow;
  if (!actual.every((entry): entry is string => typeof entry === "string")) return false;
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expectedAllow].sort());
}

export async function assertTwilioRestrictedKeyPolicies(
  environment: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<void> {
  if (environment.NODE_ENV !== "production" || environment.SMS_MFA_ENABLED !== "true") return;
  assertSmsMfaConfig(environment);
  const verifySid = environment.TWILIO_API_KEY_SID!.trim();
  const verifySecret = environment.TWILIO_API_KEY_SECRET!.trim();
  const notificationSid = environment.TWILIO_NOTIFICATION_API_KEY_SID!.trim();
  const notificationSecret = environment.TWILIO_NOTIFICATION_API_KEY_SECRET!.trim();
  try {
    const notificationKey = await fetchTwilioKeyPolicy(
      notificationSid,
      verifySid,
      verifySecret,
      fetchImpl,
      timeoutMs,
    );
    if (!hasExactPolicy(notificationKey, notificationSid, REQUIRED_TWILIO_KEY_POLICIES.notification)) {
      throw new Error("notification policy mismatch");
    }
    const verifyKey = await fetchTwilioKeyPolicy(
      verifySid,
      notificationSid,
      notificationSecret,
      fetchImpl,
      timeoutMs,
    );
    if (!hasExactPolicy(verifyKey, verifySid, REQUIRED_TWILIO_KEY_POLICIES.verify)) {
      throw new Error("Verify policy mismatch");
    }
  } catch {
    throw new Error("Twilio restricted-key policy validation failed; SMS MFA startup is blocked.");
  }
}
