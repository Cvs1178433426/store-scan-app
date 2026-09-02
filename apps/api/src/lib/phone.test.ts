import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptPhone, encryptPhone, hashPhone, maskPhone, normalizeUsPhone } from "./phone.js";

const originalEncryptionKeys = process.env.PHONE_ENCRYPTION_KEYS;
const originalLookupKeys = process.env.PHONE_LOOKUP_HMAC_KEYS;

describe("phone protection", () => {
  beforeEach(() => {
    process.env.PHONE_ENCRYPTION_KEYS = `2:${"11".repeat(32)},1:${"22".repeat(32)}`;
    process.env.PHONE_LOOKUP_HMAC_KEYS = `2:${"33".repeat(32)},1:${"44".repeat(32)}`;
  });

  afterEach(() => {
    if (originalEncryptionKeys === undefined) delete process.env.PHONE_ENCRYPTION_KEYS;
    else process.env.PHONE_ENCRYPTION_KEYS = originalEncryptionKeys;
    if (originalLookupKeys === undefined) delete process.env.PHONE_LOOKUP_HMAC_KEYS;
    else process.env.PHONE_LOOKUP_HMAC_KEYS = originalLookupKeys;
  });

  it("normalizes a US phone number to E.164", () => {
    expect(normalizeUsPhone("(631) 742-3355")).toBe("+16317423355");
    expect(normalizeUsPhone("1-631-742-3355")).toBe("+16317423355");
  });

  it("rejects non-US and malformed numbers without echoing the input", () => {
    const sensitive = "+44 20 7946 0958";
    expect(() => normalizeUsPhone(sensitive)).toThrow("Enter a valid United States mobile number.");
    try { normalizeUsPhone(sensitive); } catch (error) { expect(String(error)).not.toContain(sensitive); }
  });

  it("encrypts nondeterministically and decrypts with the stored key version", () => {
    const first = encryptPhone("+16317423355");
    const second = encryptPhone("+16317423355");
    expect(first.keyVersion).toBe(2);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.ciphertext).not.toContain("6317423355");
    expect(decryptPhone(first.ciphertext, first.keyVersion)).toBe("+16317423355");
  });

  it("rejects ciphertext tampering with a generic error", () => {
    const encrypted = encryptPhone("+16317423355");
    const tampered = `${encrypted.ciphertext.slice(0, -1)}${encrypted.ciphertext.endsWith("A") ? "B" : "A"}`;
    expect(() => decryptPhone(tampered, encrypted.keyVersion)).toThrow("Unable to decrypt phone number.");
  });

  it("creates deterministic versioned lookup hashes with a separate key", () => {
    const current = hashPhone("+16317423355");
    expect(hashPhone("+16317423355", 2)).toBe(current);
    expect(hashPhone("+16317423355", 1)).not.toBe(current);
    expect(current).toMatch(/^[a-f0-9]{64}$/);
  });

  it("masks all but the last four digits", () => {
    expect(maskPhone("+16317423355")).toBe("(***) ***-3355");
  });
});
