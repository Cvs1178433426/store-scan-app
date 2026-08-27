import { describe, expect, it } from "vitest";
import {
  consumeBackupCode,
  decryptSecret,
  encryptSecret,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCodes,
  verifyTotp,
} from "./mfa.js";

describe("MFA helpers", () => {
  it("generates a valid base32 TOTP secret", () => {
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("encrypts the TOTP secret at rest and decrypts it correctly", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it("accepts the RFC TOTP vector using the app's six-digit truncation", () => {
    const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(verifyTotp(rfcSecret, "287082", 59_000)).toBe(true);
    expect(verifyTotp(rfcSecret, "000000", 59_000)).toBe(false);
  });

  it("makes backup codes single-use", async () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(8);
    const hashes = await hashBackupCodes(codes);
    const first = await consumeBackupCode(codes[0], hashes);
    expect(first.valid).toBe(true);
    expect(first.remaining).toHaveLength(7);
    const second = await consumeBackupCode(codes[0], first.remaining);
    expect(second.valid).toBe(false);
  });
});
