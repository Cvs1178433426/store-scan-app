-- Barcode identity belongs to an organization. Keeping organizationId nullable
-- preserves legacy rows while preventing newly scoped products from colliding
-- with another tenant's catalog.
DROP INDEX IF EXISTS "Product_barcodeValue_key";
CREATE UNIQUE INDEX "Product_organizationId_barcodeValue_key"
  ON "Product"("organizationId", "barcodeValue");
