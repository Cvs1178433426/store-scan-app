import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

function key(): Buffer {
  const source = process.env.MFA_ENCRYPTION_KEY || "dev-mfa-encryption-key-change-me";
  return createHash("sha256").update(source).digest();
}

export function assertMfaEncryptionConfig(): void {
  if (process.env.NODE_ENV !== "production") return;
  const source = process.env.MFA_ENCRYPTION_KEY?.trim() ?? "";
  if (source.length < 32) {
    throw new Error("MFA_ENCRYPTION_KEY must be an independent random value of at least 32 characters in production.");
  }
  if (source === process.env.JWT_SECRET) {
    throw new Error("MFA_ENCRYPTION_KEY must not equal JWT_SECRET.");
  }
}

export function generateTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += BASE32[Number.parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
}

function decodeBase32(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/g, "").replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const c of clean) bits += BASE32.indexOf(c).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function codeFor(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(value % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  const normalized = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  for (let drift = -1; drift <= 1; drift += 1) {
    const expected = codeFor(secret, counter + drift);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))) return true;
  }
  return false;
}

export function encryptSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptSecret(payload: string): string {
  const [ivText, tagText, cipherText] = payload.split(".");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(cipherText, "base64url")), decipher.final()]).toString("utf8");
}

export function otpauthUri(secret: string, account: string): string {
  const issuer = "Store Scan";
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function generateBackupCodes(): string[] {
  return Array.from({ length: 8 }, () => randomBytes(5).toString("hex").toUpperCase());
}

export async function hashBackupCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map((code) => bcrypt.hash(code, 10)));
}

export async function consumeBackupCode(code: string, hashes: string[]): Promise<{ valid: boolean; remaining: string[] }> {
  const normalized = code.trim().toUpperCase();
  for (let i = 0; i < hashes.length; i += 1) {
    if (await bcrypt.compare(normalized, hashes[i])) return { valid: true, remaining: hashes.filter((_, index) => index !== i) };
  }
  return { valid: false, remaining: hashes };
}
