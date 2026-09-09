import { createHmac, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { decryptPhone, encryptPhone, hashPhoneCandidates, maskPhone, normalizeUsPhone, type PhoneLookupCandidate } from "./phone.js";
import { generateBackupCodes, hashBackupCodes } from "./mfa.js";
import { VerificationLockedError, type VerificationPolicy } from "./verificationPolicy.js";
import { prisma } from "./prisma.js";
import { consumeVerificationBudget, verificationPhonePrefixHash, type VerificationBudgetInput, type VerificationBudgetResult } from "./verificationRateLimit.js";

export type PendingRegistrationUser = {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  accountStatus: "PENDING_PHONE_VERIFICATION" | "ACTIVE" | "DISABLED";
  isActive: boolean;
  tokenVersion: number;
  role: "ADMIN" | "GENERAL";
  phoneE164: string;
  phoneEncrypted: string;
  phoneEncryptionKeyVersion: number;
  phoneLookupHash: string;
  phoneLookupKeyVersion: number;
  phoneVersion: number;
  consentVersion: string;
  createdAt: Date;
  mfaBackupCodeHashes?: string[];
};

type BootstrapAdminIdentity = { email: string; phoneLookupHashes: string[] };

export interface RegistrationRepository {
  findConflicts(email: string, phoneLookupHashes: string[]): Promise<PendingRegistrationUser[]>;
  createPending(input: Omit<PendingRegistrationUser, "id" | "role">, lookupCandidates: PhoneLookupCandidate[]): Promise<PendingRegistrationUser>;
  findById(id: string): Promise<PendingRegistrationUser | null>;
  activateFromChallenge(challengeId: string, id: string, approvedAt: Date, tokenVersionAtIssue: number, backupCodeHashes: string[], bootstrapAdmin: BootstrapAdminIdentity): Promise<PendingRegistrationUser>;
  expiredCandidates(cutoff: Date): Promise<Array<{ id: string; phoneVersion: number }>>;
  deleteExpiredCandidates(candidates: Array<{ id: string; phoneVersion: number }>): Promise<void>;
}

export type RegistrationChallengePolicy = Pick<VerificationPolicy,
  "queueSmsChallenge" | "queueSmsResend" | "checkChallenge" | "completeChallenge"
>;

type StartInput = {
  name: string;
  email: string;
  phone: string;
  passwordHash: string;
  consentVersion: string;
  dimensions: string[];
};

export class RegistrationService {
  constructor(
    private readonly repository: RegistrationRepository,
    private readonly policy: RegistrationChallengePolicy,
    private readonly consumeBudget: (input: VerificationBudgetInput) => Promise<VerificationBudgetResult> = consumeVerificationBudget,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private hashAccount(email: string): string {
    const rateLimitKey = process.env.RATE_LIMIT_HMAC_KEY?.trim();
    if (!rateLimitKey) throw new Error("RATE_LIMIT_HMAC_KEY is required.");
    return createHmac("sha256", rateLimitKey).update(email.trim().toLowerCase()).digest("hex");
  }

  private ipHash(dimensions: string[]): string | undefined {
    const value = dimensions.find((dimension) => dimension.startsWith("ip:"));
    return value?.slice("ip:".length);
  }

  private bootstrapAdminIdentity(): BootstrapAdminIdentity {
    const email = process.env.SMS_MFA_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
    const phone = process.env.SMS_MFA_BOOTSTRAP_ADMIN_PHONE?.trim();
    if (!email || !phone) throw new Error("SMS MFA bootstrap administrator identity is not configured.");
    return { email, phoneLookupHashes: hashPhoneCandidates(normalizeUsPhone(phone)).map(({ hash }) => hash) };
  }

  private async reserveBudget(email: string, phoneHash: string, phoneE164: string, dimensions: string[]) {
    const result = await this.consumeBudget({
      action: "REGISTRATION",
      phoneHash,
      phonePrefixHash: verificationPhonePrefixHash(phoneE164),
      accountHash: this.hashAccount(email),
      ipHash: this.ipHash(dimensions),
      now: this.now(),
    });
    if (!result.allowed) {
      throw new VerificationLockedError(result.retryAfterSeconds, "Too many verification requests. Please try again later.");
    }
    return result.reservation;
  }

  private rateDimensions(user: PendingRegistrationUser, supplied: string[]): string[] {
    return [
      ...supplied,
      `phone:${user.phoneLookupHash}`,
      `phone-prefix:${verificationPhonePrefixHash(user.phoneE164)}`,
      `account:${this.hashAccount(user.email)}`,
    ];
  }

  async start(input: StartInput): Promise<{ dispatched: boolean; userId?: string; challengeId: string; maskedDestination?: string }> {
    const email = input.email.trim().toLowerCase();
    const phoneE164 = normalizeUsPhone(input.phone);
    const phoneLookupCandidates = hashPhoneCandidates(phoneE164);
    const { hash: phoneLookupHash, version: phoneLookupKeyVersion } = phoneLookupCandidates[0];
    const phoneLookupHashes = phoneLookupCandidates.map(({ hash }) => hash);
    const verificationBudgetReservation = await this.reserveBudget(email, phoneLookupHash, phoneE164, input.dimensions);
    const startDecoy = async () => {
      const decoy = await this.policy.queueSmsChallenge({
        userId: null,
        purpose: "REGISTRATION",
        method: "SMS",
        destination: phoneE164,
        destinationHash: phoneLookupHash,
        destinationVersion: 1,
        tokenVersionAtIssue: null,
        dimensions: [
          ...input.dimensions,
          `phone-prefix:${verificationPhonePrefixHash(phoneE164)}`,
          `account:${this.hashAccount(email)}`,
        ],
        verificationBudgetReservation,
      });
      return { dispatched: false as const, challengeId: decoy.id };
    };
    const conflicts = await this.repository.findConflicts(email, phoneLookupHashes);
    const conflict = conflicts[0] ?? null;
    if (conflicts.length > 1 || (conflict && (conflict.email !== email || !phoneLookupHashes.includes(conflict.phoneLookupHash) || conflict.accountStatus !== "PENDING_PHONE_VERIFICATION"))) {
      return startDecoy();
    }

    let user = conflict;
    if (!user) {
      const protectedPhone = encryptPhone(phoneE164);
      try {
        user = await this.repository.createPending({
          name: input.name.trim(), email, passwordHash: input.passwordHash,
          accountStatus: "PENDING_PHONE_VERIFICATION", isActive: false, tokenVersion: 0,
          phoneE164, phoneEncrypted: protectedPhone.ciphertext,
          phoneEncryptionKeyVersion: protectedPhone.keyVersion,
          phoneLookupHash, phoneLookupKeyVersion, phoneVersion: 1,
          consentVersion: input.consentVersion, createdAt: new Date(),
        }, phoneLookupCandidates);
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "P2002")) throw error;
        return startDecoy();
      }
    }

    const challenge = await this.policy.queueSmsChallenge({
      userId: user.id,
      purpose: "REGISTRATION",
      method: "SMS",
      destination: phoneE164,
      destinationHash: user.phoneLookupHash,
      destinationVersion: user.phoneVersion,
      tokenVersionAtIssue: user.tokenVersion,
      dimensions: this.rateDimensions(user, input.dimensions),
      verificationBudgetReservation,
    });
    return { dispatched: false, userId: user.id, challengeId: challenge.id, maskedDestination: maskPhone(phoneE164) };
  }

  async resend(userId: string, previousChallengeId: string, dimensions: string[]): Promise<{ challengeId: string; maskedDestination: string }> {
    const user = await this.repository.findById(userId);
    if (!user || user.accountStatus !== "PENDING_PHONE_VERIFICATION") throw new Error("Verification challenge is invalid.");
    const verificationBudgetReservation = await this.reserveBudget(user.email, user.phoneLookupHash, user.phoneE164, dimensions);
    const challenge = await this.policy.queueSmsResend({
      previousChallengeId,
      userId: user.id,
      purpose: "REGISTRATION",
      method: "SMS",
      destination: user.phoneE164,
      destinationHash: user.phoneLookupHash,
      destinationVersion: user.phoneVersion,
      tokenVersionAtIssue: user.tokenVersion,
      dimensions: this.rateDimensions(user, dimensions),
      verificationBudgetReservation,
    });
    return { challengeId: challenge.id, maskedDestination: maskPhone(user.phoneE164) };
  }

  async approve(input: { challengeId: string; userId: string; code: string }): Promise<{ user: PendingRegistrationUser; backupCodes: string[] }> {
    const user = await this.repository.findById(input.userId);
    if (!user || user.accountStatus !== "PENDING_PHONE_VERIFICATION") throw new Error("Verification challenge is invalid.");
    const destination = user.phoneE164 || decryptPhone(user.phoneEncrypted, user.phoneEncryptionKeyVersion);
    let backupCodes: string[] | null = null;
    const result = await this.policy.completeChallenge({
      challengeId: input.challengeId,
      userId: user.id,
      purpose: "REGISTRATION",
      method: "SMS",
      destination,
      destinationHash: user.phoneLookupHash,
      destinationVersion: user.phoneVersion,
      tokenVersionAtIssue: user.tokenVersion,
      code: input.code,
    }, async (challengeId, approvedAt, tokenVersionAtIssue) => {
      if (tokenVersionAtIssue === null) throw new Error("Verification challenge is invalid.");
      const generatedCodes = generateBackupCodes();
      const backupCodeHashes = await hashBackupCodes(generatedCodes);
      const activeUser = await this.repository.activateFromChallenge(
        challengeId, user.id, approvedAt, tokenVersionAtIssue, backupCodeHashes, this.bootstrapAdminIdentity(),
      );
      backupCodes = generatedCodes;
      return activeUser;
    });
    if (!result.approved) throw new Error("That verification code is not correct.");
    if (!result.value) throw new Error("Account activation failed.");
    if (!backupCodes) throw new Error("Recovery code generation failed.");
    return { user: result.value, backupCodes };
  }
}

export class InMemoryRegistrationRepository implements RegistrationRepository {
  readonly users: PendingRegistrationUser[] = [];
  private activationQueue: Promise<void> = Promise.resolve();

  async findConflicts(email: string, phoneLookupHashes: string[]): Promise<PendingRegistrationUser[]> {
    return this.users.filter((user) => user.email === email || phoneLookupHashes.includes(user.phoneLookupHash));
  }
  async createPending(input: Omit<PendingRegistrationUser, "id" | "role">, _lookupCandidates: PhoneLookupCandidate[]): Promise<PendingRegistrationUser> {
    const user = { ...input, id: randomUUID(), role: "GENERAL" as const };
    this.users.push(user);
    return user;
  }
  async findById(id: string): Promise<PendingRegistrationUser | null> { return this.users.find((user) => user.id === id) ?? null; }
  async activateFromChallenge(_challengeId: string, id: string, _approvedAt: Date, tokenVersionAtIssue: number, backupCodeHashes: string[], bootstrapAdmin: BootstrapAdminIdentity): Promise<PendingRegistrationUser> {
    let release!: () => void;
    const prior = this.activationQueue;
    this.activationQueue = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      const user = this.users.find((candidate) => candidate.id === id);
      if (!user || user.tokenVersion !== tokenVersionAtIssue) throw new Error("Pending user not found.");
      const hasAdmin = this.users.some((candidate) => candidate.role === "ADMIN" && candidate.accountStatus === "ACTIVE");
      const isDesignatedAdmin = user.email === bootstrapAdmin.email && bootstrapAdmin.phoneLookupHashes.includes(user.phoneLookupHash);
      user.role = !hasAdmin && isDesignatedAdmin ? "ADMIN" : "GENERAL";
      user.accountStatus = "ACTIVE";
      user.isActive = true;
      user.mfaBackupCodeHashes = [...backupCodeHashes];
      return user;
    } finally { release(); }
  }
  async expiredCandidates(cutoff: Date): Promise<Array<{ id: string; phoneVersion: number }>> {
    return this.users.filter((user) => user.accountStatus === "PENDING_PHONE_VERIFICATION" && user.createdAt < cutoff).map(({ id, phoneVersion }) => ({ id, phoneVersion }));
  }
  async deleteExpiredCandidates(candidates: Array<{ id: string; phoneVersion: number }>): Promise<void> {
    for (const candidate of candidates) {
      const index = this.users.findIndex((user) => user.id === candidate.id && user.phoneVersion === candidate.phoneVersion && user.accountStatus === "PENDING_PHONE_VERIFICATION");
      if (index >= 0) this.users.splice(index, 1);
    }
  }
}

type RegistrationRow = Omit<PendingRegistrationUser, "phoneE164" | "consentVersion"> & { phoneConsentVersion: string | null };

function fromRow(row: RegistrationRow): PendingRegistrationUser {
  return {
    ...row,
    phoneE164: decryptPhone(row.phoneEncrypted, row.phoneEncryptionKeyVersion),
    consentVersion: row.phoneConsentVersion ?? "",
  };
}

export class PrismaRegistrationRepository implements RegistrationRepository {
  async findConflicts(email: string, phoneLookupHashes: string[]): Promise<PendingRegistrationUser[]> {
    const rows = await prisma.$queryRaw<RegistrationRow[]>`
      SELECT DISTINCT u."id", u."name", u."email", u."passwordHash", u."accountStatus", u."isActive", u."role",
             u."phoneEncrypted", u."phoneEncryptionKeyVersion", u."phoneLookupHash", u."phoneLookupKeyVersion",
             u."phoneVersion", u."phoneConsentVersion", u."tokenVersion", u."createdAt"
      FROM "User" u
      LEFT JOIN "PhoneLookupAlias" a ON a."userId" = u."id"
      WHERE u."email" = ${email} OR a."hash" IN (${Prisma.join(phoneLookupHashes)})
      LIMIT 2
    `;
    return rows.map(fromRow);
  }

  async createPending(input: Omit<PendingRegistrationUser, "id" | "role">, lookupCandidates: PhoneLookupCandidate[]): Promise<PendingRegistrationUser> {
    const id = randomUUID();
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<RegistrationRow[]>`
        INSERT INTO "User" (
          "id", "name", "email", "passwordHash", "role", "accountStatus", "isActive", "tokenVersion",
          "phoneEncrypted", "phoneEncryptionKeyVersion", "phoneLookupHash", "phoneLookupKeyVersion",
          "phoneLast4", "phoneVersion", "phoneConsentAt", "phoneConsentVersion", "phoneConsentSource", "createdAt"
        ) VALUES (
          ${id}, ${input.name}, ${input.email}, ${input.passwordHash}, 'GENERAL'::"UserRole",
          'PENDING_PHONE_VERIFICATION'::"AccountStatus", false, 0,
          ${input.phoneEncrypted}, ${input.phoneEncryptionKeyVersion}, ${input.phoneLookupHash}, ${input.phoneLookupKeyVersion},
          ${input.phoneE164.slice(-4)}, ${input.phoneVersion}, NOW(), ${input.consentVersion}, 'self_registration', NOW()
        ) RETURNING "id", "name", "email", "passwordHash", "accountStatus", "isActive", "role",
                    "phoneEncrypted", "phoneEncryptionKeyVersion", "phoneLookupHash", "phoneLookupKeyVersion",
                    "phoneVersion", "phoneConsentVersion", "tokenVersion", "createdAt"
      `;
      for (const candidate of lookupCandidates.slice(1)) {
        await tx.$executeRaw`
          INSERT INTO "PhoneLookupAlias" ("hash", "keyVersion", "userId")
          VALUES (${candidate.hash}, ${candidate.version}, ${id})
        `;
      }
      return fromRow(rows[0]);
    });
  }

  async findById(id: string): Promise<PendingRegistrationUser | null> {
    const rows = await prisma.$queryRaw<RegistrationRow[]>`
      SELECT "id", "name", "email", "passwordHash", "accountStatus", "isActive", "role",
             "phoneEncrypted", "phoneEncryptionKeyVersion", "phoneLookupHash", "phoneLookupKeyVersion",
             "phoneVersion", "phoneConsentVersion", "tokenVersion", "createdAt"
      FROM "User" WHERE "id" = ${id} LIMIT 1
    `;
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async activateFromChallenge(challengeId: string, id: string, approvedAt: Date, tokenVersionAtIssue: number, backupCodeHashes: string[], bootstrapAdmin: BootstrapAdminIdentity): Promise<PendingRegistrationUser> {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('continuixai-pilot-bootstrap'))`;
      const pending = await tx.$queryRaw<Array<{ id: string; email: string; phoneLookupHash: string | null; tokenVersion: number }>>`
        SELECT "id", "email", "phoneLookupHash", "tokenVersion" FROM "User"
        WHERE "id" = ${id} AND "accountStatus" = 'PENDING_PHONE_VERIFICATION' FOR UPDATE
      `;
      if (!pending[0] || pending[0].tokenVersion !== tokenVersionAtIssue) throw new Error("Pending user not found.");
      const consumed = await tx.$executeRaw`
        UPDATE "MfaChallenge" SET "consumedAt" = ${approvedAt}
        WHERE "id" = ${challengeId} AND "userId" = ${id} AND "purpose" = 'REGISTRATION'
          AND "tokenVersionAtIssue" = ${tokenVersionAtIssue}
          AND "consumedAt" IS NULL AND "invalidatedAt" IS NULL AND "expiresAt" > ${approvedAt}
      `;
      if (consumed !== 1) throw new Error("Verification challenge is invalid.");
      const admin = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "User" WHERE "role" = 'ADMIN' AND "accountStatus" = 'ACTIVE' AND "isActive" = true LIMIT 1
      `;
      const isDesignatedAdmin = pending[0].email === bootstrapAdmin.email
        && pending[0].phoneLookupHash !== null
        && bootstrapAdmin.phoneLookupHashes.includes(pending[0].phoneLookupHash);
      const role = !admin[0] && isDesignatedAdmin ? "ADMIN" : "GENERAL";
      const employeeNumber = `EMP-${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
      await tx.$executeRaw`
        UPDATE "User" SET "accountStatus" = 'ACTIVE', "isActive" = true,
          "role" = ${role}::"UserRole", "phoneVerifiedAt" = ${approvedAt}, "employeeNumber" = ${employeeNumber},
          "mfaBackupCodeHashes" = ${JSON.stringify(backupCodeHashes)}::jsonb, "recoveryPinHash" = NULL
        WHERE "id" = ${id}
      `;
      await tx.securityAuditEvent.createMany({ data: [
        {
          eventType: "registration_approved", outcome: "succeeded", method: "SMS",
          actorUserId: id, targetUserId: id, safeReasonCode: "phone_verified", correlationId: challengeId,
        },
        {
          eventType: "recovery_codes_generated", outcome: "succeeded", method: "SMS",
          actorUserId: id, targetUserId: id, safeReasonCode: "initial_registration", correlationId: challengeId,
        },
      ] });
    });
    const active = await this.findById(id);
    if (!active) throw new Error("Activated user not found.");
    return active;
  }

  async expiredCandidates(cutoff: Date): Promise<Array<{ id: string; phoneVersion: number }>> {
    return prisma.$queryRaw<Array<{ id: string; phoneVersion: number }>>`
      SELECT "id", "phoneVersion" FROM "User"
      WHERE "accountStatus" = 'PENDING_PHONE_VERIFICATION' AND "createdAt" < ${cutoff}
    `;
  }

  async deleteExpiredCandidates(candidates: Array<{ id: string; phoneVersion: number }>): Promise<void> {
    for (const candidate of candidates) {
      await prisma.$executeRaw`
        DELETE FROM "User" WHERE "id" = ${candidate.id} AND "phoneVersion" = ${candidate.phoneVersion}
          AND "accountStatus" = 'PENDING_PHONE_VERIFICATION'
      `;
    }
  }
}
