import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const requiredRuntimeSettings = [
  "SMS_MFA_ENABLED",
  "SMS_GLOBAL_SEND_LIMIT_PER_MINUTE",
  "SMS_MFA_MIGRATION_DEADLINE",
  "SMS_MFA_BOOTSTRAP_ADMIN_EMAIL",
  "SMS_MFA_BOOTSTRAP_ADMIN_PHONE",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_API_KEY_SID",
  "TWILIO_VERIFY_API_KEY_TYPE",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_VERIFY_SERVICE_SID",
  "TWILIO_NOTIFICATION_API_KEY_SID",
  "TWILIO_NOTIFICATION_API_KEY_TYPE",
  "TWILIO_NOTIFICATION_API_KEY_SECRET",
  "TWILIO_MESSAGING_SERVICE_SID",
  "TURNSTILE_SECRET_KEY",
  "TURNSTILE_EXPECTED_HOSTNAME",
  "PHONE_ENCRYPTION_KEYS",
  "PHONE_LOOKUP_HMAC_KEYS",
  "RATE_LIMIT_HMAC_KEY",
] as const;

function repositoryFile(name: string): string {
  return readFileSync(resolve(process.cwd(), "../..", name), "utf8");
}

describe("production deployment SMS configuration", () => {
  it.each(["docker-compose.yml", "docker-compose.prod.yml", "render.yaml"])(
    "%s passes every required SMS MFA setting to the API",
    (filename) => {
      const manifest = repositoryFile(filename);
      for (const setting of requiredRuntimeSettings) {
        expect(manifest, `${filename} must declare ${setting}`).toMatch(
          new RegExp(`(?:^|\\n)\\s*(?:${setting}:|- key: ${setting}(?:\\n|$))`),
        );
      }
    },
  );

  it("keeps the Render SMS feature flag operator-configurable and disabled by default", () => {
    const manifest = repositoryFile("render.yaml");
    expect(manifest).toMatch(/- key: SMS_MFA_ENABLED\n\s+sync: false/);
    expect(manifest).not.toMatch(/- key: SMS_MFA_ENABLED\n\s+value:/);
  });

  it("passes the public Turnstile site key to the hosted web build", () => {
    const manifest = repositoryFile("render.yaml");
    expect(manifest).toMatch(/- key: NEXT_PUBLIC_TURNSTILE_SITE_KEY\n\s+sync: false/);
  });
});
