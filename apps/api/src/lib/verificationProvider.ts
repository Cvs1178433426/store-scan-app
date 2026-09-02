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
] as const;

export function assertSmsMfaConfig(environment: Record<string, string | undefined> = process.env): void {
  if (environment.SMS_MFA_ENABLED !== "true") return;
  for (const name of REQUIRED_SMS_MFA_SETTINGS) {
    if (!environment[name]?.trim()) throw new Error(`${name} is required when SMS_MFA_ENABLED=true.`);
  }
  const migrationDeadline = environment.SMS_MFA_MIGRATION_DEADLINE?.trim();
  if (migrationDeadline && !Number.isFinite(Date.parse(migrationDeadline))) {
    throw new Error("SMS_MFA_MIGRATION_DEADLINE must be a valid ISO 8601 date-time.");
  }
}
