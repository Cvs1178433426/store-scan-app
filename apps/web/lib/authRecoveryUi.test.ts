import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("account recovery UI", () => {
  it("uses the registered email and verified factors instead of the retired Recovery PIN", () => {
    const login = source("app/login/page.tsx");
    const forgotUserId = source("app/forgot-user-id/page.tsx");
    const forgotPassword = source("app/forgot-password/page.tsx");
    const help = source("app/help/page.tsx");
    const registration = source("app/register/page.tsx");

    expect(login).toContain("Registered email or Employee Number");
    expect(login).not.toContain("Work email");
    expect(forgotUserId).toContain("registered email");
    expect(forgotUserId).toContain('href="/login"');
    expect(forgotUserId).toContain('href="/forgot-password"');
    expect(forgotUserId).not.toContain("Recovery PIN");
    expect(forgotUserId).not.toContain("/api/auth/recover/user-id");

    expect(forgotPassword).toContain("registered email");
    expect(forgotPassword).toContain('requestRecovery("SMS")');
    expect(forgotPassword).toContain("prove it is you");
    expect(forgotPassword).toContain("Text me a verification code");
    expect(forgotPassword).toContain("verified phone");
    expect(help).toContain("registered email");
    expect(help).toContain("verified phone");
    expect(help).not.toContain("Recovery PIN");
    expect(help).not.toContain("administrator to reset");
    expect(registration).toContain("Email address");
    expect(registration).not.toContain("work email");
    expect(registration).not.toContain("Work email");
    expect(registration).toContain("result.backupCodes");
    expect(registration).toContain("OneTimeSecrets");
    expect(registration).toContain("They will not be shown again");
  });
});
