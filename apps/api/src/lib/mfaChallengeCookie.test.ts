import { describe, expect, it, vi } from "vitest";
import { clearChallengeCookie, readChallengeCookie, setChallengeCookie } from "./mfaChallengeCookie.js";

describe("MFA challenge cookie", () => {
  it("sets an opaque identifier with strict server-only attributes", () => {
    const setCookie = vi.fn();
    setChallengeCookie({ setCookie } as never, "challenge-id");
    expect(setCookie).toHaveBeenCalledWith("continuixai_mfa_challenge", "challenge-id", {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/api",
      maxAge: 600,
    });
  });

  it("reads and clears only the named challenge cookie", () => {
    expect(readChallengeCookie({ cookies: { continuixai_mfa_challenge: "challenge-id" } } as never)).toBe("challenge-id");
    expect(readChallengeCookie({ cookies: {} } as never)).toBeNull();
    const clearCookie = vi.fn();
    clearChallengeCookie({ clearCookie } as never);
    expect(clearCookie).toHaveBeenCalledWith("continuixai_mfa_challenge", { path: "/api" });
  });
});
