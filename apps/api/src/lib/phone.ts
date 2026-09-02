import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export type EncryptedPhone = { ciphertext: string; keyVersion: number };

const PHONE_ERROR = "Enter a valid United States mobile number.";
const DECRYPTION_ERROR = "Unable to decrypt phone number.";

type VersionedKey = { version: number; key: Buffer };

function keyRing(name: "PHONE_ENCRYPTION_KEYS" | "PHONE_LOOKUP_HMAC_KEYS"): VersionedKey[] {
  const values = (process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`${name} is required.`);
  return values.map((value) => {
    const match = /^(\d+):([a-fA-F0-9]{64})$/.exec(value);
    if (!match || Number(match[1]) < 1) throw new Error(`${name} entries must use version:32-byte-hex format.`);
    return { version: Number(match[1]), key: Buffer.from(match[2], "hex") };
  });
}

function keyAt(name: "PHONE_ENCRYPTION_KEYS" | "PHONE_LOOKUP_HMAC_KEYS", version: number): Buffer {
  if (!Number.isInteger(version) || version < 1) throw new Error(`${name} key version is unavailable.`);
  const entry = keyRing(name).find((candidate) => candidate.version === version);
  if (!entry) throw new Error(`${name} key version is unavailable.`);
  return entry.key;
}

export function normalizeUsPhone(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("+") && !trimmed.startsWith("+1")) throw new Error(PHONE_ERROR);
  const digits = trimmed.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) throw new Error(PHONE_ERROR);
  return `+1${national}`;
}

export function encryptPhone(e164: string): EncryptedPhone {
  const keyVersion = keyRing("PHONE_ENCRYPTION_KEYS")[0].version;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyAt("PHONE_ENCRYPTION_KEYS", keyVersion), iv);
  const encrypted = Buffer.concat([cipher.update(e164, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`, keyVersion };
}

export function decryptPhone(ciphertext: string, keyVersion: number): string {
  try {
    const [ivText, tagText, encryptedText, extra] = ciphertext.split(".");
    if (!ivText || !tagText || !encryptedText || extra !== undefined) throw new Error(DECRYPTION_ERROR);
    const decipher = createDecipheriv("aes-256-gcm", keyAt("PHONE_ENCRYPTION_KEYS", keyVersion), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(DECRYPTION_ERROR);
  }
}

export function hashPhone(e164: string, keyVersion?: number): string {
  const selectedVersion = keyVersion ?? keyRing("PHONE_LOOKUP_HMAC_KEYS")[0].version;
  return createHmac("sha256", keyAt("PHONE_LOOKUP_HMAC_KEYS", selectedVersion)).update(e164, "utf8").digest("hex");
}

export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (digits.length !== 11 || !digits.startsWith("1")) throw new Error(PHONE_ERROR);
  return `(***) ***-${digits.slice(-4)}`;
}
