import { describe, expect, it } from "vitest";
import {
  LOCKOUT_MESSAGE,
  createAuthFlow,
  formatWaitTime,
  normalizeVerificationCode,
  reduceAuthFlow,
  remainingSeconds,
} from "./authFlow";

describe("cookie-bound authentication flow", () => {
  it("starts at the phone-entry step without browser-persistable secrets", () => {
    const state = createAuthFlow("phone");

    expect(state).toEqual({
      step: "entry",
      entry: "phone",
      method: "SMS",
      maskedDestination: null,
      resendAvailableAt: null,
      lockedUntil: null,
      problem: null,
    });
    expect(JSON.stringify(state)).not.toMatch(/challenge|password|code|phoneNumber/i);
  });

  it("moves from entry to code verification with only a masked destination", () => {
    const state = reduceAuthFlow(createAuthFlow("phone"), {
      type: "CODE_SENT",
      maskedDestination: "(***) ***-3355",
      now: 1_000,
    });

    expect(state).toMatchObject({
      step: "verification",
      method: "SMS",
      maskedDestination: "(***) ***-3355",
      resendAvailableAt: 31_000,
    });
  });

  it("keeps an existing authenticator user on TOTP during SMS migration", () => {
    const state = reduceAuthFlow(createAuthFlow("password"), {
      type: "CODE_SENT", method: "TOTP", now: 1_000,
    });

    expect(state).toMatchObject({ step: "verification", method: "TOTP", maskedDestination: null });
  });

  it("enforces the 30-second resend cooldown from server-confirmed sends", () => {
    const sent = reduceAuthFlow(createAuthFlow("phone"), {
      type: "CODE_SENT",
      maskedDestination: "(***) ***-3355",
      now: 1_000,
    });

    expect(remainingSeconds(sent.resendAvailableAt, 1_000)).toBe(30);
    expect(remainingSeconds(sent.resendAvailableAt, 30_001)).toBe(1);
    expect(remainingSeconds(sent.resendAvailableAt, 31_000)).toBe(0);

    const resent = reduceAuthFlow(sent, {
      type: "CODE_SENT",
      maskedDestination: "(***) ***-9912",
      now: 40_000,
    });
    expect(remainingSeconds(resent.resendAvailableAt, 40_000)).toBe(30);
    expect(resent.maskedDestination).toBe("(***) ***-9912");
  });

  it("honors a short server Retry-After without showing a 15-minute attempt lock", () => {
    const sent = reduceAuthFlow(createAuthFlow("email"), { type: "CODE_SENT", now: 0 });

    const delayed = reduceAuthFlow(sent, { type: "RETRY_AFTER", retryAfterSeconds: 42, now: 30_000 });

    expect(remainingSeconds(delayed.resendAvailableAt, 30_000)).toBe(42);
    expect(delayed).toMatchObject({ problem: null, lockedUntil: null });
  });

  it("presents server wait durations in employee-friendly units", () => {
    expect(formatWaitTime(1)).toBe("1 second");
    expect(formatWaitTime(42)).toBe("42 seconds");
    expect(formatWaitTime(900)).toBe("15 minutes");
    expect(formatWaitTime(86_400)).toBe("24 hours");
  });

  it("keeps an incorrect code on the verification step", () => {
    const verifying = reduceAuthFlow(createAuthFlow("password"), {
      type: "CODE_SENT",
      maskedDestination: "(***) ***-3355",
      now: 0,
    });

    expect(reduceAuthFlow(verifying, { type: "CODE_REJECTED" })).toMatchObject({
      step: "verification",
      problem: "invalid_code",
    });
  });

  it("marks an expired challenge and offers a safe restart", () => {
    const verifying = reduceAuthFlow(createAuthFlow("email"), {
      type: "CODE_SENT",
      now: 0,
    });
    const expired = reduceAuthFlow(verifying, { type: "CHALLENGE_EXPIRED" });

    expect(expired).toMatchObject({ step: "verification", problem: "expired" });
    expect(reduceAuthFlow(expired, { type: "RESTART" })).toEqual(createAuthFlow("email"));
  });

  it("represents the authoritative 15-minute lock without persisting it", () => {
    const verifying = reduceAuthFlow(createAuthFlow("password"), {
      type: "CODE_SENT",
      now: 0,
    });
    const locked = reduceAuthFlow(verifying, {
      type: "LOCKED",
      retryAfterSeconds: 900,
      now: 2_000,
    });

    expect(locked).toMatchObject({
      step: "verification",
      lockedUntil: 902_000,
      problem: "locked",
    });
    expect(LOCKOUT_MESSAGE).toBe("Too many verification attempts. Please try again in 15 minutes.");
  });

  it("keeps a provider outage fail-closed on the current step", () => {
    const state = createAuthFlow("password");

    expect(reduceAuthFlow(state, { type: "PROVIDER_OUTAGE" })).toMatchObject({
      step: "entry",
      problem: "outage",
    });
  });

  it("moves a verified login to completion", () => {
    const verifying = reduceAuthFlow(createAuthFlow("password"), {
      type: "CODE_SENT",
      maskedDestination: "(***) ***-3355",
      now: 0,
    });

    expect(reduceAuthFlow(verifying, { type: "VERIFIED" })).toMatchObject({
      step: "complete",
      problem: null,
    });
  });

  it("switches only the display method and clears stale SMS presentation", () => {
    const verifying = reduceAuthFlow(createAuthFlow("password"), {
      type: "CODE_SENT",
      maskedDestination: "(***) ***-3355",
      now: 0,
    });

    expect(reduceAuthFlow(verifying, { type: "METHOD_SELECTED", method: "RECOVERY_CODE" })).toMatchObject({
      step: "verification",
      method: "RECOVERY_CODE",
      maskedDestination: null,
      resendAvailableAt: null,
      problem: null,
    });
  });

  it("normalizes pasted SMS/TOTP codes to six digits and recovery codes to safe uppercase text", () => {
    expect(normalizeVerificationCode("12 34-56 extra", "SMS")).toBe("123456");
    expect(normalizeVerificationCode("98a76 543", "TOTP")).toBe("987654");
    expect(normalizeVerificationCode("a1b2-c3d4 e5!", "RECOVERY_CODE")).toBe("A1B2C3D4E5");
  });
});
