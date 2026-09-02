import { describe, expect, it, vi } from "vitest";
import { verifyHuman } from "./turnstile.js";

describe("Turnstile verification", () => {
  it("accepts only the configured hostname and registration action", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      hostname: "candidate.continuixai.com",
      action: "sms_registration",
    }), { status: 200 }));
    await expect(verifyHuman("token", "203.0.113.4", {
      secret: "secret",
      expectedHostname: "candidate.continuixai.com",
      fetchImpl,
    })).resolves.toBe(true);
  });

  it("fails closed on wrong action, wrong hostname, or provider failure", async () => {
    const wrong = vi.fn(async () => new Response(JSON.stringify({ success: true, hostname: "evil.test", action: "login" }), { status: 200 }));
    await expect(verifyHuman("token", "203.0.113.4", { secret: "secret", expectedHostname: "candidate.continuixai.com", fetchImpl: wrong })).resolves.toBe(false);
    const unavailable = vi.fn(async () => { throw new Error("offline"); });
    await expect(verifyHuman("token", "203.0.113.4", { secret: "secret", expectedHostname: "candidate.continuixai.com", fetchImpl: unavailable })).resolves.toBe(false);
  });

  it("can bind legacy phone enrollment to its own browser action", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      hostname: "candidate.continuixai.com",
      action: "sms_phone_enrollment",
    }), { status: 200 }));

    await expect(verifyHuman("token", "203.0.113.4", {
      secret: "secret",
      expectedHostname: "candidate.continuixai.com",
      expectedAction: "sms_phone_enrollment",
      fetchImpl,
    })).resolves.toBe(true);
  });
});
