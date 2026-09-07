import { decryptPhone, hashPhoneCandidates, type PhoneLookupCandidate } from "./phone.js";

export type PhoneLookupRotationRow = {
  id: string;
  phoneEncrypted: string | null;
  phoneEncryptionKeyVersion: number | null;
  phoneVersion: number;
};

export type PhoneLookupAliasClaim = PhoneLookupCandidate & { userId: string; phoneVersion: number };
export type PhoneLookupPromotion = PhoneLookupAliasClaim;

export interface PhoneLookupRotationRepository {
  nextBatch(afterId: string | undefined, limit: number): Promise<PhoneLookupRotationRow[]>;
  assertClaimable(claims: PhoneLookupAliasClaim[]): Promise<void>;
  claimBatch(claims: PhoneLookupAliasClaim[]): Promise<void>;
  promoteBatch(promotions: PhoneLookupPromotion[]): Promise<void>;
}

export async function backfillPhoneLookupAliases(
  repository: PhoneLookupRotationRepository,
  batchSize = 250,
): Promise<{ users: number; aliases: number }> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error("Phone lookup alias batch size must be between 1 and 1000.");
  }

  const claims: PhoneLookupAliasClaim[] = [];
  const promotions: PhoneLookupPromotion[] = [];
  const owners = new Map<string, string>();
  let afterId: string | undefined;
  let users = 0;

  for (;;) {
    const rows = await repository.nextBatch(afterId, batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (!row.phoneEncrypted || row.phoneEncryptionKeyVersion === null) {
        throw new Error("A user with phone identity has incomplete encrypted phone data.");
      }
      if (!Number.isSafeInteger(row.phoneVersion) || row.phoneVersion < 1) {
        throw new Error("A stored phone has an invalid phone identity version.");
      }
      const phone = decryptPhone(row.phoneEncrypted, row.phoneEncryptionKeyVersion);
      const candidates = hashPhoneCandidates(phone);
      for (const candidate of candidates) {
        const owner = owners.get(candidate.hash);
        if (owner && owner !== row.id) {
          throw new Error("Cross-key phone lookup collision detected; no aliases were changed.");
        }
        if (!owner) {
          owners.set(candidate.hash, row.id);
          claims.push({ ...candidate, userId: row.id, phoneVersion: row.phoneVersion });
        }
      }
      promotions.push({ ...candidates[0], userId: row.id, phoneVersion: row.phoneVersion });
      users += 1;
    }
    afterId = rows.at(-1)?.id;
    if (rows.length < batchSize) break;
  }

  await repository.assertClaimable(claims);
  for (let offset = 0; offset < claims.length; offset += batchSize) {
    await repository.claimBatch(claims.slice(offset, offset + batchSize));
  }
  for (let offset = 0; offset < promotions.length; offset += batchSize) {
    await repository.promoteBatch(promotions.slice(offset, offset + batchSize));
  }
  return { users, aliases: claims.length };
}
