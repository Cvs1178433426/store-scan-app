import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import {
  backfillPhoneLookupAliases,
  type PhoneLookupAliasClaim,
  type PhoneLookupPromotion,
  type PhoneLookupRotationRepository,
} from "../src/lib/phoneLookupRotation.js";
import { parsePhoneKeyRing } from "../src/lib/phone.js";

const batchSize = Number(process.env.PHONE_LOOKUP_BACKFILL_BATCH_SIZE ?? "250");

const repository: PhoneLookupRotationRepository = {
  async nextBatch(afterId, limit) {
    return prisma.user.findMany({
      where: {
        OR: [
          { phoneEncrypted: { not: null } },
          { phoneLookupHash: { not: null } },
        ],
      },
      orderBy: { id: "asc" },
      ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}),
      take: limit,
      select: { id: true, phoneEncrypted: true, phoneEncryptionKeyVersion: true, phoneVersion: true },
    });
  },

  async assertClaimable(claims: PhoneLookupAliasClaim[]) {
    const expectedOwners = new Map(claims.map(({ hash, userId }) => [hash, userId]));
    for (let offset = 0; offset < claims.length; offset += 1_000) {
      const hashes = claims.slice(offset, offset + 1_000).map(({ hash }) => hash);
      const existing = await prisma.phoneLookupAlias.findMany({
        where: { hash: { in: hashes } },
        select: { hash: true, userId: true },
      });
      if (existing.some(({ hash, userId }) => expectedOwners.get(hash) !== userId)) {
        throw new Error("A phone lookup alias is already claimed by another user; no aliases were changed.");
      }
    }
  },

  async claimBatch(claims: PhoneLookupAliasClaim[]) {
    await prisma.$transaction(async (tx) => {
      const expectedVersions = new Map<string, number>();
      for (const claim of claims) {
        const existing = expectedVersions.get(claim.userId);
        if (existing !== undefined && existing !== claim.phoneVersion) {
          throw new Error("Phone identity changed during lookup-key rotation; rerun the backfill.");
        }
        expectedVersions.set(claim.userId, claim.phoneVersion);
      }
      for (const [userId, phoneVersion] of [...expectedVersions].sort(([left], [right]) => left.localeCompare(right))) {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "User"
          WHERE "id" = ${userId} AND "phoneVersion" = ${phoneVersion}
          FOR UPDATE
        `;
        if (!locked[0]) {
          throw new Error("Phone identity changed during lookup-key rotation; rerun the backfill.");
        }
      }
      for (const claim of claims) {
        const changed = await tx.$executeRaw`
          INSERT INTO "PhoneLookupAlias" ("hash", "keyVersion", "userId")
          VALUES (${claim.hash}, ${claim.version}, ${claim.userId})
          ON CONFLICT ("hash") DO UPDATE SET "keyVersion" = EXCLUDED."keyVersion"
          WHERE "PhoneLookupAlias"."userId" = EXCLUDED."userId"
        `;
        if (changed !== 1) {
          throw new Prisma.PrismaClientKnownRequestError("Phone lookup alias belongs to another user.", {
            code: "P2002",
            clientVersion: Prisma.prismaVersion.client,
          });
        }
      }
    });
  },

  async promoteBatch(promotions: PhoneLookupPromotion[]) {
    await prisma.$transaction(async (tx) => {
      const ordered = [...promotions].sort((left, right) => left.userId.localeCompare(right.userId));
      for (const promotion of ordered) {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "User"
          WHERE "id" = ${promotion.userId} AND "phoneVersion" = ${promotion.phoneVersion}
          FOR UPDATE
        `;
        if (!locked[0]) {
          throw new Error("Phone identity changed during lookup-key rotation; rerun the backfill.");
        }
      }
      for (const promotion of ordered) {
        await tx.user.update({
          where: { id: promotion.userId },
          data: { phoneLookupHash: promotion.hash, phoneLookupKeyVersion: promotion.version },
        });
      }
    });
  },
};

try {
  const result = await backfillPhoneLookupAliases(repository, batchSize);
  const keyVersions = parsePhoneKeyRing("PHONE_LOOKUP_HMAC_KEYS", process.env.PHONE_LOOKUP_HMAC_KEYS).map(({ version }) => version);
  const missingAliasCounts = await Promise.all(keyVersions.map((keyVersion) => prisma.user.count({
    where: {
      phoneLookupHash: { not: null },
      phoneLookupAliases: { none: { keyVersion } },
    },
  })));
  const nonCurrentRows = await prisma.user.count({
    where: { phoneLookupHash: { not: null }, phoneLookupKeyVersion: { not: keyVersions[0] } },
  });
  if (missingAliasCounts.some((count) => count !== 0) || nonCurrentRows !== 0) {
    throw new Error("Phone lookup rotation coverage is incomplete.");
  }
  console.log(`Phone lookup rotation complete: ${result.users} users, ${result.aliases} aliases, full ${keyVersions.length}-version coverage.`);
} finally {
  await prisma.$disconnect();
}
