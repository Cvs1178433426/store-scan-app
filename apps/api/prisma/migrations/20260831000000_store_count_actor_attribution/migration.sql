ALTER TABLE "StoreCountEntry"
  ADD COLUMN "countedByUserId" TEXT;

ALTER TABLE "StoreCountScanLog"
  ADD COLUMN "userId" TEXT;

CREATE INDEX "StoreCountEntry_countedByUserId_idx"
  ON "StoreCountEntry"("countedByUserId");

CREATE INDEX "StoreCountScanLog_userId_idx"
  ON "StoreCountScanLog"("userId");

ALTER TABLE "StoreCountEntry"
  ADD CONSTRAINT "StoreCountEntry_countedByUserId_fkey"
  FOREIGN KEY ("countedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StoreCountScanLog"
  ADD CONSTRAINT "StoreCountScanLog_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
