-- Dedicated Store Scan catalog + real locations.
-- IMPORTANT: this migration must be verified against a disposable Postgres database before production use.

CREATE TABLE "StoreLocation" (
  "id"        TEXT NOT NULL,
  "code"      TEXT NOT NULL,
  "name"      TEXT,
  "isActive"  BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoreLocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StoreLocation_code_key" ON "StoreLocation"("code");
CREATE INDEX "StoreLocation_isActive_sortOrder_idx" ON "StoreLocation"("isActive", "sortOrder");

CREATE TABLE "Product" (
  "id"           TEXT NOT NULL,
  "barcodeValue" TEXT,
  "name"         TEXT NOT NULL,
  "manufacturer" TEXT,
  "description"  TEXT,
  "packageSize"  TEXT,
  "imageUrl"     TEXT,
  "categoryId"   TEXT,
  "isActive"     BOOLEAN NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Product_barcodeValue_key" ON "Product"("barcodeValue");
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");
CREATE INDEX "Product_isActive_idx" ON "Product"("isActive");

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Preserve historical free-text count locations by creating one StoreLocation per distinct old code.
INSERT INTO "StoreLocation" ("id", "code", "name", "isActive", "sortOrder", "createdAt")
SELECT
  'loc_' || md5(sc."locationCode"),
  sc."locationCode",
  sc."locationCode",
  true,
  0,
  now()
FROM (SELECT DISTINCT "locationCode" FROM "StoreCountEntry") sc
ON CONFLICT ("code") DO NOTHING;

ALTER TABLE "StoreCountEntry" ADD COLUMN "locationId" TEXT;

UPDATE "StoreCountEntry" sce
SET "locationId" = sl."id"
FROM "StoreLocation" sl
WHERE sl."code" = sce."locationCode";

ALTER TABLE "StoreCountEntry" ALTER COLUMN "locationId" SET NOT NULL;
ALTER TABLE "StoreCountEntry" ADD COLUMN "productId" TEXT;

UPDATE "StoreCountEntry" sce
SET "productId" = p."id"
FROM "Product" p
WHERE p."barcodeValue" = sce."barcodeValue";

DROP INDEX IF EXISTS "StoreCountEntry_sessionId_locationCode_barcodeValue_key";
DROP INDEX IF EXISTS "StoreCountEntry_sessionId_locationCode_idx";
DROP INDEX IF EXISTS "StoreCountEntry_itemId_idx";

ALTER TABLE "StoreCountEntry" DROP CONSTRAINT IF EXISTS "StoreCountEntry_itemId_fkey";
ALTER TABLE "StoreCountEntry" DROP COLUMN "itemId";
ALTER TABLE "StoreCountEntry" DROP COLUMN "locationCode";
ALTER TABLE "StoreCountEntry" DROP COLUMN "productName";
ALTER TABLE "StoreCountEntry" DROP COLUMN "packageSize";

CREATE UNIQUE INDEX "StoreCountEntry_sessionId_locationId_barcodeValue_key" ON "StoreCountEntry"("sessionId", "locationId", "barcodeValue");
CREATE INDEX "StoreCountEntry_sessionId_locationId_idx" ON "StoreCountEntry"("sessionId", "locationId");
CREATE INDEX "StoreCountEntry_productId_idx" ON "StoreCountEntry"("productId");
CREATE INDEX "StoreCountEntry_locationId_idx" ON "StoreCountEntry"("locationId");

ALTER TABLE "StoreCountEntry"
  ADD CONSTRAINT "StoreCountEntry_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StoreCountEntry"
  ADD CONSTRAINT "StoreCountEntry_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "StoreLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "StoreCountSession_one_active_per_user"
  ON "StoreCountSession"("startedById")
  WHERE "status" = 'ACTIVE';
