import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { recoveryEventLabel } from "../components/PhoneRecoveryAdmin";

function source(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("guided lost-phone recovery UI", () => {
  it("labels administrator history events accurately", () => {
    expect(recoveryEventLabel({ eventType: "phone_recovery_cancelled", outcome: "accepted" })).toBe("Recovery cancelled");
    expect(recoveryEventLabel({ eventType: "phone_recovery_completed", outcome: "accepted" })).toBe("Recovery completed");
    expect(recoveryEventLabel({ eventType: "phone_recovery_email_notification", outcome: "failed" })).toBe("Notification failed");
    expect(recoveryEventLabel({ eventType: "phone_recovery_email_denied", outcome: "denied" })).toBe("Email code rejected");
    expect(recoveryEventLabel({ eventType: "phone_recovery_sms_locked", outcome: "locked" })).toBe("Text verification locked");
  });
  it("presents the five employee steps in order with accessible mobile inputs", () => {
    const wizard = source("components/PhoneRecoveryWizard.tsx");
    const codeForm = source("components/VerificationCodeForm.tsx");
    const headings = [
      "Find your recovery request",
      "Check your registered email",
      "Enter your replacement phone",
      "Check your text messages",
      "Recovery complete",
    ];
    let position = -1;
    for (const heading of headings) {
      const next = wizard.indexOf(heading);
      expect(next).toBeGreaterThan(position);
      position = next;
    }
    expect(wizard).toContain('autoComplete="email"');
    expect(wizard).toContain("Employee number (if assigned)");
    expect(wizard).toContain("Leave this blank if your account was created before employee numbers were assigned.");
    expect(wizard).toContain('autoComplete="tel"');
    expect(wizard).toContain('codeLength={8}');
    expect(wizard).toContain('codeLabel="8-digit email code"');
    expect(wizard).toContain('codeHelp="Enter the 8-digit code from your registered email."');
    expect(codeForm).toContain('autoComplete="one-time-code"');
    expect(codeForm).toContain("If you requested another code recently, more than one text may arrive. Use the newest code.");
    expect(wizard).toContain('aria-describedby=');
    expect(wizard).toContain('role="alert"');
    expect(wizard).toContain("Sign in with your new phone");
  });

  it("uses body-bound recovery APIs and never stores proof values or puts them in URLs", () => {
    const wizard = source("components/PhoneRecoveryWizard.tsx");
    const api = source("lib/api.ts");
    expect(api).toContain('"/api/auth/phone-recovery/start"');
    expect(api).toContain('"/api/auth/phone-recovery/email/check"');
    expect(api).toContain('"/api/auth/phone-recovery/phone/start"');
    expect(api).toContain('"/api/auth/phone-recovery/phone/check"');
    expect(wizard).not.toMatch(/localStorage|sessionStorage|URLSearchParams|window\.location\.search/);
    expect(wizard).toContain("Your request was accepted");
    expect(wizard).not.toMatch(/we sent|was sent/i);
    expect(wizard).toContain("Start again");
    expect(wizard).toContain("Contact your manager");
  });

  it("gives administrators safe initiate and cancel controls without exposing factor details", () => {
    const admin = source("components/PhoneRecoveryAdmin.tsx");
    const users = source("app/users/page.tsx");
    expect(users).toContain("PhoneRecoveryAdmin");
    expect(admin).toContain("Start phone recovery");
    expect(admin).toContain("Cancel recovery");
    expect(admin).toContain("Recovery reference");
    expect(admin).toContain("expiresAt");
    expect(admin).toContain("phoneRecoveryApi.adminStatus");
    expect(admin).toContain("Recovery status");
    expect(admin).toContain("Recovery history");
    expect(admin).toContain("Notification accepted");
    expect(admin).not.toMatch(/phoneLast4|providerRef|verification code/i);
  });

  it("links the sign-in screen to the lost-phone recovery route", () => {
    const login = source("app/login/page.tsx");
    const page = source("app/recover-phone/page.tsx");
    expect(login).toContain('href="/recover-phone"');
    expect(page).toContain("PhoneRecoveryWizard");
  });
});
