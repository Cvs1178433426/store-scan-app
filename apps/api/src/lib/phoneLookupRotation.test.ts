import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptPhone } from "./phone.js";
import { backfillPhoneLookupAliases, type PhoneLookupRotationRepository, type PhoneLookupRotationRow } from "./phoneLookupRotation.js";

function repositoryFor(rows: PhoneLookupRotationRow[]): PhoneLookupRotationRepository & {
  assertClaimable: ReturnType<typeof vi.fn>;
  claimBatch: ReturnType<typeof vi.fn>;
  promoteBatch: ReturnType<typeof vi.fn>;
} {
  return {
    async nextBatch(afterId, limit) {
      const start = afterId ? rows.findIndex(({ id }) => id === afterId) + 1 : 0;
      return rows.slice(start, start + limit);
    },
    assertClaimable: vi.fn(async () => {}),
    claimBatch: vi.fn(async () => {}),
    promoteBatch: vi.fn(async () => {}),
  };
}

describe("phone lookup alias rotation", () => {
  beforeEach(() => {
    process.env.PHONE_ENCRYPTION_KEYS = `1:${"11".repeat(32)}`;
    process.env.PHONE_LOOKUP_HMAC_KEYS = `2:${"33".repeat(32)},1:${"22".repeat(32)}`;
  });

  it("preflights every user before claiming current and previous aliases in batches", async () => {
    const first = encryptPhone("+16317423355");
    const second = encryptPhone("+15615551234");
    const repository = repositoryFor([
      { id: "a", phoneEncrypted: first.ciphertext, phoneEncryptionKeyVersion: first.keyVersion, phoneVersion: 1 },
      { id: "b", phoneEncrypted: second.ciphertext, phoneEncryptionKeyVersion: second.keyVersion, phoneVersion: 1 },
    ]);

    await expect(backfillPhoneLookupAliases(repository, 2)).resolves.toEqual({ users: 2, aliases: 4 });
    expect(repository.claimBatch).toHaveBeenCalledTimes(2);
    expect(repository.claimBatch.mock.calls.flatMap(([claims]) => claims)).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: "a", version: 2 }),
      expect.objectContaining({ userId: "a", version: 1 }),
      expect.objectContaining({ userId: "b", version: 2 }),
      expect.objectContaining({ userId: "b", version: 1 }),
    ]));
    expect(repository.promoteBatch.mock.calls.flatMap(([promotions]) => promotions)).toEqual([
      expect.objectContaining({ userId: "a", version: 2 }),
      expect.objectContaining({ userId: "b", version: 2 }),
    ]);
  });

  it("binds every alias claim and promotion to the observed phone version", async () => {
    const encrypted = encryptPhone("+16317423355");
    const repository = repositoryFor([
      {
        id: "a",
        phoneEncrypted: encrypted.ciphertext,
        phoneEncryptionKeyVersion: encrypted.keyVersion,
        phoneVersion: 7,
      },
    ]);

    await backfillPhoneLookupAliases(repository, 1);

    expect(repository.claimBatch.mock.calls.flatMap(([claims]) => claims)).toEqual([
      expect.objectContaining({ userId: "a", version: 2, phoneVersion: 7 }),
      expect.objectContaining({ userId: "a", version: 1, phoneVersion: 7 }),
    ]);
    expect(repository.promoteBatch.mock.calls.flatMap(([promotions]) => promotions)).toEqual([
      expect.objectContaining({ userId: "a", version: 2, phoneVersion: 7 }),
    ]);
  });

  it("makes no writes when two users resolve to the same phone across the key ring", async () => {
    const first = encryptPhone("+16317423355");
    const second = encryptPhone("+16317423355");
    const repository = repositoryFor([
      { id: "a", phoneEncrypted: first.ciphertext, phoneEncryptionKeyVersion: first.keyVersion, phoneVersion: 1 },
      { id: "b", phoneEncrypted: second.ciphertext, phoneEncryptionKeyVersion: second.keyVersion, phoneVersion: 1 },
    ]);

    await expect(backfillPhoneLookupAliases(repository, 2)).rejects.toThrow("Cross-key phone lookup collision detected");
    expect(repository.claimBatch).not.toHaveBeenCalled();
    expect(repository.promoteBatch).not.toHaveBeenCalled();
  });

  it("makes no writes when a derived hash is already claimed by another database user", async () => {
    const encrypted = encryptPhone("+16317423355");
    const repository = repositoryFor([
      { id: "a", phoneEncrypted: encrypted.ciphertext, phoneEncryptionKeyVersion: encrypted.keyVersion, phoneVersion: 1 },
    ]);
    repository.assertClaimable.mockRejectedValueOnce(new Error("alias belongs to another user"));

    await expect(backfillPhoneLookupAliases(repository, 2)).rejects.toThrow("alias belongs to another user");
    expect(repository.claimBatch).not.toHaveBeenCalled();
    expect(repository.promoteBatch).not.toHaveBeenCalled();
  });

  it("rejects a stored phone without a positive identity version before writing aliases", async () => {
    const encrypted = encryptPhone("+16317423355");
    const repository = repositoryFor([
      { id: "a", phoneEncrypted: encrypted.ciphertext, phoneEncryptionKeyVersion: encrypted.keyVersion, phoneVersion: 0 },
    ]);

    await expect(backfillPhoneLookupAliases(repository, 1)).rejects.toThrow(
      "A stored phone has an invalid phone identity version.",
    );
    expect(repository.assertClaimable).not.toHaveBeenCalled();
    expect(repository.claimBatch).not.toHaveBeenCalled();
    expect(repository.promoteBatch).not.toHaveBeenCalled();
  });
});
