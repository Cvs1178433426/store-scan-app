import { createHash, randomUUID } from "node:crypto";
import { PrismaSmsVerificationDispatchRepository } from "../src/jobs/smsVerificationDispatch.js";
import { encryptPhone, hashPhoneCandidates } from "../src/lib/phone.js";
import { PrismaPhoneRecoveryRepository, PhoneRecoveryConflictError } from "../src/lib/phoneRecoveryRepository.js";
import { prisma } from "../src/lib/prisma.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

async function main() {
  process.env.PHONE_ENCRYPTION_KEYS ??= "1:1111111111111111111111111111111111111111111111111111111111111111";
  process.env.PHONE_LOOKUP_HMAC_KEYS ??= "1:2222222222222222222222222222222222222222222222222222222222222222";
  const suffix = randomUUID();
  const adminId = `recovery-admin-${suffix}`;
  const targetId = `recovery-user-${suffix}`;
  const caseId = `recovery-case-${suffix}`;
  const emailChallengeId = `recovery-email-${suffix}`;
  const decoyEmailChallengeId = `recovery-email-decoy-${suffix}`;
  const smsChallengeId = `recovery-sms-${suffix}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
  const replacementPhone = "+16317424455";
  const protectedPhone = encryptPhone(replacementPhone);
  const phoneCandidates = hashPhoneCandidates(replacementPhone);
  const primaryPhone = phoneCandidates[0];
  const phoneHash = primaryPhone.hash;
  const repository = new PrismaPhoneRecoveryRepository();

  try {
    await prisma.user.createMany({
      data: [
        { id: adminId, name: "Recovery Admin", email: `recovery-admin-${suffix}@example.test`, passwordHash: "unused", role: "ADMIN", accountStatus: "ACTIVE", isActive: true },
        {
          id: targetId, name: "Recovery Employee", email: `recovery-user-${suffix}@example.test`, passwordHash: "unused",
          role: "GENERAL", accountStatus: "ACTIVE", isActive: true, tokenVersion: 7,
          phoneEncrypted: "existing-encrypted-phone", phoneEncryptionKeyVersion: 1,
          phoneLookupHash: digest(`old-phone:${suffix}`), phoneLookupKeyVersion: 1,
          phoneLast4: "3355", phoneVerifiedAt: now, phoneVersion: 3,
          phoneConsentAt: now, phoneConsentVersion: "validation", phoneConsentSource: "validation",
        },
      ],
    });

    let selfInitiationRejected = false;
    try {
      await repository.createNoticePending({
        id: `self-${suffix}`, actorUserId: adminId, targetUserId: adminId,
        caseReferenceHash: digest(`self-reference:${suffix}`), expiresAt, now,
      });
    } catch (error) {
      selfInitiationRejected = error instanceof PhoneRecoveryConflictError;
    }
    assert(selfInitiationRejected, "administrator self-initiation must be rejected");

    const decoyAccountHash = digest(`decoy-email-account:${suffix}`);
    await repository.beginEmailDecoy({
      challengeId: decoyEmailChallengeId,
      codeDigest: createHash("sha256").update("decoy-email-code").digest(),
      accountRateLimitHash: decoyAccountHash,
      expiresAt: new Date(now.getTime() + 10 * 60_000),
      now,
    });
    const decoy = await repository.readEmailChallenge(decoyEmailChallengeId);
    assert(decoy?.caseId === null && decoy.accountRateLimitHash === decoyAccountHash,
      "nonmatching recovery identities must receive a durable account-bound decoy challenge");

    const created = await repository.createNoticePending({
      id: caseId, actorUserId: adminId, targetUserId: targetId,
      caseReferenceHash: digest(`reference:${suffix}`), expiresAt, now,
    });
    assert(created.tokenVersionAtIssue === 7 && created.phoneVersionAtIssue === 3, "recovery must snapshot both revocation versions");
    assert(await repository.markNoticeAccepted(caseId, new Date(now.getTime() + 1_000)), "notice acceptance must transition the case");
    await repository.beginEmailProof({
      caseId, challengeId: emailChallengeId, codeDigest: createHash("sha256").update("email-code").digest(),
      accountRateLimitHash: digest(`email-account:${suffix}`),
      expiresAt: new Date(now.getTime() + 10 * 60_000), now: new Date(now.getTime() + 2_000),
    });
    assert(await repository.recordEmailApproval({
      caseId, challengeId: emailChallengeId, approvedAt: new Date(now.getTime() + 3_000),
    }), "email approval must be single-use and case-bound");
    await repository.reservePhone({
      caseId, challengeId: smsChallengeId, providerRef: `pending:${suffix}`,
      phoneEncrypted: protectedPhone.ciphertext, phoneEncryptionKeyVersion: protectedPhone.keyVersion,
      phoneLookupHash: phoneHash, phonePrefixHash: digest(`new-prefix:${suffix}`),
      accountRateLimitHash: digest(`recovery-account:${suffix}`), phoneLookupKeyVersion: primaryPhone.version, phoneLast4: "4455",
      consentAt: new Date(now.getTime() + 4_000), consentVersion: "validation",
      aliases: phoneCandidates.map(({ hash, version }) => ({ hash, keyVersion: version })),
      expiresAt: new Date(now.getTime() + 10 * 60_000), now: new Date(now.getTime() + 4_000),
    });

    const dispatch = new PrismaSmsVerificationDispatchRepository();
    const claimed = await dispatch.claimPending();
    assert(claimed?.challengeId === smsChallengeId, "dispatcher must claim an eligible replacement-phone challenge");
    assert(claimed.destination === replacementPhone, "dispatcher must decrypt the replacement phone exactly");
    assert(await dispatch.beginSending(claimed.challengeId, claimed.leaseId), "dispatcher must start the claimed send exactly once");
    assert(await dispatch.markDelivered(claimed.challengeId, claimed.leaseId, `VE-recovery-${suffix}`), "dispatcher must record provider acceptance");
    const delivered = await repository.readPhoneChallenge(smsChallengeId);
    assert(delivered?.deliveryState === "SENT", "phone proof must remain unavailable until durable provider acceptance");

    const completions = await Promise.allSettled([
      repository.complete({ caseId, challengeId: smsChallengeId, completedAt: new Date(now.getTime() + 5_000) }),
      repository.complete({ caseId, challengeId: smsChallengeId, completedAt: new Date(now.getTime() + 5_000) }),
    ]);
    assert(completions.filter(({ status }) => status === "fulfilled").length === 1, "concurrent recovery completion must have exactly one winner");
    assert(completions.filter(({ status }) => status === "rejected").length === 1, "concurrent recovery replay must be rejected");

    const user = await prisma.user.findUniqueOrThrow({ where: { id: targetId } });
    assert(user.tokenVersion === 8 && user.phoneVersion === 4 && user.phoneLookupHash === phoneHash, "completion must replace the phone and revoke sessions");
    const audit = await prisma.securityAuditEvent.findFirst({ where: { correlationId: caseId, eventType: "phone_recovery_completed" } });
    assert(audit?.targetUserId === targetId, "completion audit must commit atomically");
    assert(await prisma.phoneRecoveryPhoneAlias.count({ where: { caseId } }) === 0, "provisional aliases must be promoted or removed");
    console.log("Phone recovery PostgreSQL validation passed: durable decoy, state transitions, queued dispatch, alias claim, concurrency, revocation, and audit.");
  } finally {
    await prisma.mfaChallenge.deleteMany({ where: { id: decoyEmailChallengeId } });
    await prisma.phoneRecoveryCase.deleteMany({ where: { id: { in: [caseId, `self-${suffix}`] } } });
    await prisma.$disconnect();
  }
}

await main();
