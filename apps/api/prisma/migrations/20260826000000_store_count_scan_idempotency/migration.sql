-- Prevent a successfully processed scan from being counted twice when the client
-- retries after losing the original response on a weak or interrupted network.
CREATE TABLE "StoreCountScanLog" (
    "idempotencyKey" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "quantityDelta" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreCountScanLog_pkey" PRIMARY KEY ("idempotencyKey")
);

CREATE INDEX "StoreCountScanLog_sessionId_idx" ON "StoreCountScanLog"("sessionId");
CREATE INDEX "StoreCountScanLog_entryId_idx" ON "StoreCountScanLog"("entryId");

ALTER TABLE "StoreCountScanLog"
ADD CONSTRAINT "StoreCountScanLog_entryId_fkey"
FOREIGN KEY ("entryId") REFERENCES "StoreCountEntry"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
