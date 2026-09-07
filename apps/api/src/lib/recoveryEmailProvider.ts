export type RecoveryEmailMessage =
  | { kind: "recovery_requested"; destination: string; expiresAt: Date; caseReference: string }
  | { kind: "recovery_code"; destination: string; code: string; expiresAt: Date }
  | { kind: "recovery_completed"; destination: string; completedAt: Date };

export interface RecoveryEmailProvider {
  send(message: RecoveryEmailMessage): Promise<{ accepted: true }>;
}

export class RecoveryEmailConfigurationError extends Error {
  constructor(message = "Recovery email configuration is invalid.") {
    super(message);
    this.name = "RecoveryEmailConfigurationError";
  }
}

export class RecoveryEmailRequestError extends Error {
  constructor() {
    super("Recovery email request was not accepted.");
    this.name = "RecoveryEmailRequestError";
  }
}

type RecoveryEmailEnvironment = Record<string, string | undefined> & {
  SENDGRID_RECOVERY_API_KEY?: string;
  MFA_RECOVERY_FROM_EMAIL?: string;
  MFA_RECOVERY_PUBLIC_URL?: string;
  EMAIL_OTP_HMAC_KEY?: string;
};

type RecoveryEmailConfig = {
  apiKey: string;
  fromEmail: string;
  publicUrl: string;
  timeoutMs: number;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function required(environment: RecoveryEmailEnvironment, name: keyof RecoveryEmailEnvironment): string {
  const value = environment[name]?.trim();
  if (!value) throw new RecoveryEmailConfigurationError(`Recovery email setting ${String(name)} is required.`);
  return value;
}

function validatedPublicUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("unsafe URL");
    return url.toString();
  } catch {
    throw new RecoveryEmailConfigurationError("The recovery public URL must be a valid HTTPS URL.");
  }
}

function hmacFingerprint(value: string): Set<string> {
  return new Set([value.trim().toLowerCase(), Buffer.from(value.trim(), "utf8").toString("hex")]);
}

export function assertRecoveryEmailConfig(environment: RecoveryEmailEnvironment = process.env): void {
  if (environment.NODE_ENV !== "production" || environment.SMS_MFA_ENABLED !== "true") return;
  required(environment, "SENDGRID_RECOVERY_API_KEY");
  const sender = required(environment, "MFA_RECOVERY_FROM_EMAIL");
  if (!EMAIL_PATTERN.test(sender)) throw new RecoveryEmailConfigurationError("The recovery email sender must be a valid email address.");
  validatedPublicUrl(required(environment, "MFA_RECOVERY_PUBLIC_URL"));
  const hmacKey = required(environment, "EMAIL_OTP_HMAC_KEY");
  if (hmacKey.length < 32) throw new RecoveryEmailConfigurationError("EMAIL_OTP_HMAC_KEY must contain at least 32 characters of HMAC key material.");

  const fingerprints = hmacFingerprint(hmacKey);
  const independentSettings = [
    environment.JWT_SECRET,
    environment.MFA_ENCRYPTION_KEY,
    environment.RATE_LIMIT_HMAC_KEY,
    ...(environment.PHONE_ENCRYPTION_KEYS ?? "").split(",").map((entry) => entry.split(":", 2)[1]),
    ...(environment.PHONE_LOOKUP_HMAC_KEYS ?? "").split(",").map((entry) => entry.split(":", 2)[1]),
  ].filter((value): value is string => Boolean(value?.trim()));
  if (independentSettings.some((value) => [...hmacFingerprint(value)].some((fingerprint) => fingerprints.has(fingerprint)))) {
    throw new RecoveryEmailConfigurationError("EMAIL_OTP_HMAC_KEY must use independent key material.");
  }
}

function loadConfig(environment: RecoveryEmailEnvironment, timeoutMs: number): RecoveryEmailConfig {
  const fromEmail = required(environment, "MFA_RECOVERY_FROM_EMAIL");
  if (!EMAIL_PATTERN.test(fromEmail)) throw new RecoveryEmailConfigurationError("The recovery email sender must be a valid email address.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new RecoveryEmailConfigurationError("Recovery email timeout is invalid.");
  }
  return {
    apiKey: required(environment, "SENDGRID_RECOVERY_API_KEY"),
    fromEmail,
    publicUrl: validatedPublicUrl(required(environment, "MFA_RECOVERY_PUBLIC_URL")),
    timeoutMs,
  };
}

function renderMessage(message: RecoveryEmailMessage, publicUrl: string): { subject: string; text: string } {
  const subject = "ContinuiXAi security notice";
  switch (message.kind) {
    case "recovery_requested":
      return {
        subject,
        text: `A phone recovery was requested for your ContinuiXAi account. Reference: ${message.caseReference}. Continue at ${publicUrl}. This request expires at ${message.expiresAt.toISOString()}. If you did not expect this, contact your administrator.`,
      };
    case "recovery_code":
      return {
        subject,
        text: `Your ContinuiXAi phone recovery code is ${message.code}. It expires at ${message.expiresAt.toISOString()}. Do not share this code.`,
      };
    case "recovery_completed":
      return {
        subject,
        text: `The verified phone on your ContinuiXAi account was changed at ${message.completedAt.toISOString()}. If you did not make this change, contact your administrator immediately.`,
      };
  }
}

class SendGridRecoveryEmailProvider implements RecoveryEmailProvider {
  constructor(
    private readonly config: RecoveryEmailConfig,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async send(message: RecoveryEmailMessage): Promise<{ accepted: true }> {
    if (!EMAIL_PATTERN.test(message.destination)) throw new RecoveryEmailRequestError();
    const rendered = renderMessage(message, this.config.publicUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchImpl("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: message.destination }] }],
          from: { email: this.config.fromEmail },
          subject: rendered.subject,
          content: [{ type: "text/plain", value: rendered.text }],
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new RecoveryEmailRequestError();
      return { accepted: true };
    } catch {
      throw new RecoveryEmailRequestError();
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createRecoveryEmailProvider(
  environment: RecoveryEmailEnvironment = process.env,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8_000,
): RecoveryEmailProvider {
  return new SendGridRecoveryEmailProvider(loadConfig(environment, timeoutMs), fetchImpl);
}
