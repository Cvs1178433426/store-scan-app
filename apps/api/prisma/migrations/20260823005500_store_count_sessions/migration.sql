CREATE TYPE "StoreCountSessionStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

CREATE TABLE "StoreCountSession" (
  "id" TEXT NOT NULL,
  "name" TEXT,
  "status" "StoreCountSessionStatus" NOT NULL DEFAULT 'ACTIVE',
  "startedById" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StoreCountSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StoreCountEntry" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "itemId" TEXT,
  "barcodeValue" TEXT NOT NULL,
  "locationCode" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "productName" TEXT,
  "packageSize" TEXT,
  "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StoreCountEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StoreCountSession_status_startedAt_idx" ON "StoreCountSession"("status", "startedAt");
CREATE INDEX "StoreCountSession_startedById_idx" ON "StoreCountSession"("startedById");
CREATE UNIQUE INDEX "StoreCountEntry_sessionId_locationCode_barcodeValue_key" ON "StoreCountEntry"("sessionId", "locationCode", "barcodeValue");
CREATE INDEX "StoreCountEntry_sessionId_locationCode_idx" ON "StoreCountEntry"("sessionId", "locationCode");
CREATE INDEX "StoreCountEntry_sessionId_barcodeValue_idx" ON "StoreCountEntry"("sessionId", "barcodeValue");
CREATE INDEX "StoreCountEntry_itemId_idx" ON "StoreCountEntry"("itemId");

ALTER TABLE "StoreCountSession"
  ADD CONSTRAINT "StoreCountSession_startedById_fkey"
  FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StoreCountEntry"
  ADD CONSTRAINT "StoreCountEntry_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "StoreCountSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StoreCountEntry"
  ADD CONSTRAINT "StoreCountEntry_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;
