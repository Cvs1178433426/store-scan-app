CREATE TYPE "AccountStatus" AS ENUM ('PENDING_PHONE_VERIFICATION', 'ACTIVE', 'DISABLED');
CREATE TYPE "MfaMethod" AS ENUM ('SMS', 'TOTP', 'RECOVERY_CODE');
CREATE TYPE "MfaChallengePurpose" AS ENUM ('REGISTRATION', 'LOGIN', 'PASSWORD_RESET', 'PHONE_CHANGE', 'FACTOR_REMOVAL');

ALTER TABLE "User"
  ADD COLUMN "accountStatus" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "phoneEncrypted" TEXT,
  ADD COLUMN "phoneEncryptionKeyVersion" INTEGER,
  ADD COLUMN "phoneLookupHash" TEXT,
  ADD COLUMN "phoneLookupKeyVersion" INTEGER,
  ADD COLUMN "phoneLast4" TEXT,
  ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "phoneVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "phoneConsentAt" TIMESTAMP(3),
  ADD COLUMN "phoneConsentVersion" TEXT,
  ADD COLUMN "phoneConsentSource" TEXT;

UPDATE "User"
SET "accountStatus" = 'DISABLED'
WHERE "isActive" = false;

ALTER TABLE "User" ADD CONSTRAINT "User_account_status_active_consistency"
CHECK (("accountStatus" = 'ACTIVE' AND "isActive" = true) OR
       ("accountStatus" <> 'ACTIVE' AND "isActive" = false));

CREATE UNIQUE INDEX "User_phoneLookupHash_key" ON "User"("phoneLookupHash");
CREATE INDEX "User_accountStatus_idx" ON "User"("accountStatus");

CREATE TABLE "MfaChallenge" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "pendingEmail" TEXT,
  "phoneLookupHash" TEXT,
  "purpose" "MfaChallengePurpose" NOT NULL,
  "method" "MfaMethod" NOT NULL,
  "destinationVersion" INTEGER,
  "providerRef" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "incorrectAttempts" INTEGER NOT NULL DEFAULT 0,
  "consumedAt" TIMESTAMP(3),
  "invalidatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MfaChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MfaChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "MfaChallenge_userId_purpose_createdAt_idx" ON "MfaChallenge"("userId", "purpose", "createdAt");
CREATE INDEX "MfaChallenge_expiresAt_idx" ON "MfaChallenge"("expiresAt");
CREATE INDEX "MfaChallenge_phoneLookupHash_createdAt_idx" ON "MfaChallenge"("phoneLookupHash", "createdAt");

CREATE TABLE "VerificationSendBucket" (
  "id" TEXT NOT NULL,
  "dimension" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "sendCount" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VerificationSendBucket_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VerificationSendBucket_dimension_keyHash_windowStart_key" ON "VerificationSendBucket"("dimension", "keyHash", "windowStart");
CREATE INDEX "VerificationSendBucket_lockedUntil_idx" ON "VerificationSendBucket"("lockedUntil");

CREATE TABLE "SecurityAuditEvent" (
  "id" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "method" "MfaMethod",
  "actorUserId" TEXT,
  "targetUserId" TEXT,
  "safeReasonCode" TEXT,
  "correlationId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecurityAuditEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SecurityAuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "SecurityAuditEvent_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "SecurityAuditEvent_actorUserId_createdAt_idx" ON "SecurityAuditEvent"("actorUserId", "createdAt");
CREATE INDEX "SecurityAuditEvent_targetUserId_createdAt_idx" ON "SecurityAuditEvent"("targetUserId", "createdAt");
CREATE INDEX "SecurityAuditEvent_eventType_createdAt_idx" ON "SecurityAuditEvent"("eventType", "createdAt");
