import { createHmac, randomUUID } from "node:crypto";
import { decryptPhone, encryptPhone, hashPhone, maskPhone, normalizeUsPhone } from "./phone.js";
import { VerificationLockedError, type VerificationPolicy } from "./verificationPolicy.js";
import { prisma } from "./prisma.js";
import { consumeVerificationBudget, type VerificationBudgetInput, type VerificationBudgetResult } from "./verificationRateLimit.js";

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
};

export interface RegistrationRepository {
  findConflict(email: string, phoneLookupHash: string): Promise<PendingRegistrationUser | null>;
  createPending(input: Omit<PendingRegistrationUser, "id" | "role">): Promise<PendingRegistrationUser>;
  findById(id: string): Promise<PendingRegistrationUser | null>;
  activateFromChallenge(challengeId: string, id: string, approvedAt: Date): Promise<PendingRegistrationUser>;
  expiredCandidates(cutoff: Date): Promise<Array<{ id: string; phoneVersion: number }>>;
  deleteExpiredCandidates(candidates: Array<{ id: string; phoneVersion: number }>): Promise<void>;
}

export type RegistrationChallengePolicy = Pick<VerificationPolicy,
  "startChallenge" | "startDecoySmsChallenge" | "resendChallenge" | "checkChallenge" | "completeChallenge"
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

  private async reserveBudget(email: string, phoneHash: string, dimensions: string[]) {
    const result = await this.consumeBudget({
      action: "REGISTRATION",
      phoneHash,
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
      `account:${this.hashAccount(user.email)}`,
    ];
  }

  async start(input: StartInput): Promise<{ dispatched: boolean; userId?: string; challengeId: string; maskedDestination?: string }> {
    const email = input.email.trim().toLowerCase();
    const phoneE164 = normalizeUsPhone(input.phone);
    const phoneLookupHash = hashPhone(phoneE164);
    const phoneLookupKeyVersion = Number((process.env.PHONE_LOOKUP_HMAC_KEYS ?? "").split(",")[0]?.split(":")[0]);
    const verificationBudgetReservation = await this.reserveBudget(email, phoneLookupHash, input.dimensions);
    const conflict = await this.repository.findConflict(email, phoneLookupHash);
    if (conflict && (conflict.email !== email || conflict.phoneLookupHash !== phoneLookupHash || conflict.accountStatus !== "PENDING_PHONE_VERIFICATION")) {
      const decoy = await this.policy.startDecoySmsChallenge({
        userId: null,
        purpose: "REGISTRATION",
        method: "SMS",
        destination: phoneE164,
        destinationHash: phoneLookupHash,
        destinationVersion: 1,
        dimensions: input.dimensions,
        verificationBudgetReservation,
      });
      return { dispatched: false, challengeId: decoy.id };
    }

    let user = conflict;
    if (!user) {
      const protectedPhone = encryptPhone(phoneE164);
      user = await this.repository.createPending({
        name: input.name.trim(), email, passwordHash: input.passwordHash,
        accountStatus: "PENDING_PHONE_VERIFICATION", isActive: false, tokenVersion: 0,
        phoneE164, phoneEncrypted: protectedPhone.ciphertext,
        phoneEncryptionKeyVersion: protectedPhone.keyVersion,
        phoneLookupHash, phoneLookupKeyVersion, phoneVersion: 1,
        consentVersion: input.consentVersion, createdAt: new Date(),
      });
    }

    const challenge = await this.policy.startChallenge({
      userId: user.id,
      purpose: "REGISTRATION",
      method: "SMS",
      destination: phoneE164,
      destinationHash: phoneLookupHash,
      destinationVersion: user.phoneVersion,
      dimensions: this.rateDimensions(user, input.dimensions),
      verificationBudgetReservation,
    });
    return { dispatched: true, userId: user.id, challengeId: challenge.id, maskedDestination: maskPhone(phoneE164) };
  }

  async resend(userId: string, previousChallengeId: string, dimensions: string[]): Promise<{ challengeId: string; maskedDestination: string }> {
    const user = await this.repository.findById(userId);
    if (!user || user.accountStatus !== "PENDING_PHONE_VERIFICATION") throw new Error("Verification challenge is invalid.");
    const verificationBudgetReservation = await this.reserveBudget(user.email, user.phoneLookupHash, dimensions);
    const challenge = await this.policy.resendChallenge({
      previousChallengeId,
      userId: user.id,
      purpose: "REGISTRATION",
      method: "SMS",
      destination: user.phoneE164,
      destinationHash: user.phoneLookupHash,
      destinationVersion: user.phoneVersion,
      dimensions: this.rateDimensions(user, dimensions),
      verificationBudgetReservation,
    });
    return { challengeId: challenge.id, maskedDestination: maskPhone(user.phoneE164) };
  }

  async approve(input: { challengeId: string; userId: string; code: string }): Promise<PendingRegistrationUser> {
    const user = await this.repository.findById(input.userId);
    if (!user || user.accountStatus !== "PENDING_PHONE_VERIFICATION") throw new Error("Verification challenge is invalid.");
    const destination = user.phoneE164 || decryptPhone(user.phoneEncrypted, user.phoneEncryptionKeyVersion);
    const result = await this.policy.completeChallenge({
      challengeId: input.challengeId,
      userId: user.id,
      method: "SMS",
      destination,
      destinationHash: user.phoneLookupHash,
      destinationVersion: user.phoneVersion,
      code: input.code,
    }, (challengeId, approvedAt) => this.repository.activateFromChallenge(challengeId, user.id, approvedAt));
    if (!result.approved) throw new Error("That verification code is not correct.");
    if (!result.value) throw new Error("Account activation failed.");
    return result.value;
  }
}

export class InMemoryRegistrationRepository implements RegistrationRepository {
  readonly users: PendingRegistrationUser[] = [];
  private activationQueue: Promise<void> = Promise.resolve();

  async findConflict(email: string, phoneLookupHash: string): Promise<PendingRegistrationUser | null> {
    return this.users.find((user) => user.email === email || user.phoneLookupHash === phoneLookupHash) ?? null;
  }
  async createPending(input: Omit<PendingRegistrationUser, "id" | "role">): Promise<PendingRegistrationUser> {
    const user = { ...input, id: randomUUID(), role: "GENERAL" as const };
    this.users.push(user);
    return user;
  }
  async findById(id: string): Promise<PendingRegistrationUser | null> { return this.users.find((user) => user.id === id) ?? null; }
  async activateFromChallenge(_challengeId: string, id: string, _approvedAt: Date): Promise<PendingRegistrationUser> {
    let release!: () => void;
    const prior = this.activationQueue;
    this.activationQueue = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      const user = this.users.find((candidate) => candidate.id === id);
      if (!user) throw new Error("Pending user not found.");
      const hasAdmin = this.users.some((candidate) => candidate.role === "ADMIN" && candidate.accountStatus === "ACTIVE");
      user.role = hasAdmin ? "GENERAL" : "ADMIN";
      user.accountStatus = "ACTIVE";
      user.isActive = true;
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
  async findConflict(email: string, phoneLookupHash: string): Promise<PendingRegistrationUser | null> {
    const rows = await prisma.$queryRaw<RegistrationRow[]>`
      SELECT "id", "name", "email", "passwordHash", "accountStatus", "isActive", "role",
             "phoneEncrypted", "phoneEncryptionKeyVersion", "phoneLookupHash", "phoneLookupKeyVersion",
             "phoneVersion", "phoneConsentVersion", "tokenVersion", "createdAt"
      FROM "User" WHERE "email" = ${email} OR "phoneLookupHash" = ${phoneLookupHash} LIMIT 1
    `;
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async createPending(input: Omit<PendingRegistrationUser, "id" | "role">): Promise<PendingRegistrationUser> {
    const id = randomUUID();
    const rows = await prisma.$queryRaw<RegistrationRow[]>`
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
    return fromRow(rows[0]);
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

  async activateFromChallenge(challengeId: string, id: string, approvedAt: Date): Promise<PendingRegistrationUser> {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('continuixai-pilot-bootstrap'))`;
      const pending = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "User" WHERE "id" = ${id} AND "accountStatus" = 'PENDING_PHONE_VERIFICATION' FOR UPDATE
      `;
      if (!pending[0]) throw new Error("Pending user not found.");
      const consumed = await tx.$executeRaw`
        UPDATE "MfaChallenge" SET "consumedAt" = ${approvedAt}
        WHERE "id" = ${challengeId} AND "userId" = ${id} AND "purpose" = 'REGISTRATION'
          AND "consumedAt" IS NULL AND "invalidatedAt" IS NULL
      `;
      if (consumed !== 1) throw new Error("Verification challenge is invalid.");
      const admin = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "User" WHERE "role" = 'ADMIN' AND "accountStatus" = 'ACTIVE' AND "isActive" = true LIMIT 1
      `;
      const role = admin[0] ? "GENERAL" : "ADMIN";
      const employeeNumber = `EMP-${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
      await tx.$executeRaw`
        UPDATE "User" SET "accountStatus" = 'ACTIVE', "isActive" = true,
          "role" = ${role}::"UserRole", "phoneVerifiedAt" = NOW(), "employeeNumber" = ${employeeNumber}
        WHERE "id" = ${id}
      `;
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
