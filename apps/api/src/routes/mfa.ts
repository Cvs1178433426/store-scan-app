import type { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import { prisma } from "../lib/prisma.js";
import { setMediaCookie } from "../lib/mediaAuth.js";
import {
  consumeBackupCode,
  decryptSecret,
  encryptSecret,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCodes,
  otpauthUri,
  verifyTotp,
} from "../lib/mfa.js";

const JWT_EXPIRES_IN = "7d";
type UserRole = "ADMIN" | "GENERAL";
type Challenge = { sub: string; role?: UserRole; tv?: number; purpose?: string };

function readChallenge(app: FastifyInstance, token: string): Challenge | null {
  try {
    return app.jwt.verify<Challenge>(token);
  } catch {
    return null;
  }
}

async function loadChallengeUser(app: FastifyInstance, token: string, purpose: "mfa-setup" | "mfa-login") {
  const challenge = readChallenge(app, token);
  if (!challenge || challenge.purpose !== purpose || typeof challenge.tv !== "number") return null;
  const user = await prisma.user.findUnique({ where: { id: challenge.sub } });
  if (!user || !user.isActive || user.tokenVersion !== challenge.tv) return null;
  return user;
}

function issueSession(app: FastifyInstance, user: { id: string; role: UserRole; tokenVersion: number }) {
  return app.jwt.sign({ sub: user.id, role: user.role, tv: user.tokenVersion }, { expiresIn: JWT_EXPIRES_IN });
}

function sessionResponse(app: FastifyInstance, reply: Parameters<typeof setMediaCookie>[1], user: { id: string; name: string; email: string; employeeNumber: string | null; role: UserRole; tokenVersion: number }) {
  const token = issueSession(app, user);
  setMediaCookie(app, reply, user.id);
  return { token, user: { id: user.id, name: user.name, email: user.email, employeeNumber: user.employeeNumber, role: user.role, mfaEnabled: true } };
}

export async function mfaRoutes(app: FastifyInstance) {
  app.post("/mfa/setup", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const { challengeToken } = (request.body ?? {}) as { challengeToken?: string };
    if (!challengeToken) return reply.code(400).send({ error: "MFA setup token is required." });
    const user = await loadChallengeUser(app, challengeToken, "mfa-setup");
    if (!user) return reply.code(401).send({ error: "MFA setup session expired. Sign in again." });

    let secret: string;
    if (user.mfaSecretEncrypted) {
      try { secret = decryptSecret(user.mfaSecretEncrypted); } catch { secret = generateTotpSecret(); }
    } else {
      secret = generateTotpSecret();
    }
    await prisma.user.update({ where: { id: user.id }, data: { mfaSecretEncrypted: encryptSecret(secret), mfaEnabled: false } });
    const uri = otpauthUri(secret, user.employeeNumber || user.email);
    const qrDataUrl = await QRCode.toDataURL(uri, { width: 240, margin: 1 });
    return { qrDataUrl, secret, account: user.employeeNumber || user.email };
  });

  app.post("/mfa/confirm", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const { challengeToken, code } = (request.body ?? {}) as { challengeToken?: string; code?: string };
    if (!challengeToken || !code) return reply.code(400).send({ error: "MFA setup token and 6-digit code are required." });
    const user = await loadChallengeUser(app, challengeToken, "mfa-setup");
    if (!user || !user.mfaSecretEncrypted) return reply.code(401).send({ error: "MFA setup session expired. Sign in again." });

    let secret: string;
    try { secret = decryptSecret(user.mfaSecretEncrypted); } catch { return reply.code(400).send({ error: "MFA setup must be restarted." }); }
    if (!verifyTotp(secret, code)) return reply.code(401).send({ error: "That verification code is not correct." });

    const backupCodes = generateBackupCodes();
    const hashes = await hashBackupCodes(backupCodes);
    const updated = await prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: true, mfaBackupCodeHashes: hashes } });
    return { ...sessionResponse(app, reply, updated), backupCodes };
  });

  app.post("/mfa/verify", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const { challengeToken, code } = (request.body ?? {}) as { challengeToken?: string; code?: string };
    if (!challengeToken || !code) return reply.code(400).send({ error: "MFA challenge and verification code are required." });
    const user = await loadChallengeUser(app, challengeToken, "mfa-login");
    if (!user || !user.mfaEnabled || !user.mfaSecretEncrypted) return reply.code(401).send({ error: "MFA verification session expired. Sign in again." });

    let totpValid = false;
    try { totpValid = verifyTotp(decryptSecret(user.mfaSecretEncrypted), code); } catch { /* invalid encrypted secret */ }
    if (totpValid) return sessionResponse(app, reply, user);

    const hashes = Array.isArray(user.mfaBackupCodeHashes) ? user.mfaBackupCodeHashes.filter((v): v is string => typeof v === "string") : [];
    const backup = await consumeBackupCode(code, hashes);
    if (!backup.valid) return reply.code(401).send({ error: "That verification code is not correct." });

    await prisma.user.update({ where: { id: user.id }, data: { mfaBackupCodeHashes: backup.remaining } });
    return sessionResponse(app, reply, user);
  });
}
