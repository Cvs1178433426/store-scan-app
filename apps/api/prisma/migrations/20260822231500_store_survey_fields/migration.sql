ALTER TABLE "Category"
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "Item"
  ADD COLUMN "manufacturer" TEXT,
  ADD COLUMN "packageSize" TEXT,
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "Item_isActive_idx" ON "Item"("isActive");
