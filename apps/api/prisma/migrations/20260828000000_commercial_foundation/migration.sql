-- Commercial foundation: organizations, sites, roles, product identifiers/packaging,
-- and an append-only inventory transaction ledger. Existing Store Count behavior
-- remains backward compatible during this first migration phase.

CREATE TYPE "OrganizationRole" AS ENUM (
  'OWNER', 'ADMIN', 'MANAGER', 'BUYER', 'RECEIVER', 'INVENTORY',
  'PICKER', 'CHECKER', 'SHIPPING', 'ACCOUNTING', 'VIEWER'
);

CREATE TYPE "SiteType" AS ENUM (
  'STORE', 'WAREHOUSE', 'DISTRIBUTION_CENTER', 'OFFICE', 'OTHER'
);

CREATE TYPE "ProductIdentifierType" AS ENUM (
  'UPC', 'EAN', 'GTIN', 'NDC', 'CUSTOMER_SKU', 'MANUFACTURER_ITEM', 'OTHER'
);

CREATE TYPE "ProductPackagingLevel" AS ENUM ('EACH', 'INNER', 'CASE', 'PALLET', 'OTHER');

CREATE TYPE "InventoryTransactionType" AS ENUM (
  'RECEIVE', 'SHIP', 'TRANSFER_IN', 'TRANSFER_OUT', 'DAMAGE',
  'RETURN_TO_VENDOR', 'COUNT_ADJUSTMENT', 'MANUAL_ADJUSTMENT'
);

CREATE TABLE "Organization" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrganizationMembership" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "OrganizationRole" NOT NULL DEFAULT 'VIEWER',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Site" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" "SiteType" NOT NULL DEFAULT 'STORE',
  "address1" TEXT,
  "address2" TEXT,
  "city" TEXT,
  "region" TEXT,
  "postalCode" TEXT,
  "countryCode" TEXT NOT NULL DEFAULT 'US',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "StoreLocation" ADD COLUMN "siteId" TEXT;
ALTER TABLE "Product" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "StoreCountSession" ADD COLUMN "siteId" TEXT;

CREATE TABLE "ProductPackaging" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "level" "ProductPackagingLevel" NOT NULL,
  "name" TEXT,
  "unitsOfEach" INTEGER NOT NULL DEFAULT 1,
  "length" DECIMAL(12,4),
  "width" DECIMAL(12,4),
  "height" DECIMAL(12,4),
  "dimensionUnit" TEXT,
  "weight" DECIMAL(12,4),
  "weightUnit" TEXT,
  "isOrderable" BOOLEAN NOT NULL DEFAULT false,
  "isReceivable" BOOLEAN NOT NULL DEFAULT true,
  "isSellable" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductPackaging_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductIdentifier" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "packagingId" TEXT,
  "type" "ProductIdentifierType" NOT NULL,
  "value" TEXT NOT NULL,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "source" TEXT,
  "sourceUpdatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductIdentifier_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InventoryTransaction" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "packagingId" TEXT,
  "type" "InventoryTransactionType" NOT NULL,
  "quantity" DECIMAL(18,4) NOT NULL,
  "unitOfMeasure" TEXT NOT NULL DEFAULT 'EACH',
  "referenceType" TEXT,
  "referenceId" TEXT,
  "actorUserId" TEXT,
  "reason" TEXT,
  "metadata" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");
CREATE INDEX "Organization_isActive_idx" ON "Organization"("isActive");

CREATE UNIQUE INDEX "OrganizationMembership_organizationId_userId_key"
  ON "OrganizationMembership"("organizationId", "userId");
CREATE INDEX "OrganizationMembership_userId_isActive_idx"
  ON "OrganizationMembership"("userId", "isActive");
CREATE INDEX "OrganizationMembership_organizationId_role_isActive_idx"
  ON "OrganizationMembership"("organizationId", "role", "isActive");

CREATE UNIQUE INDEX "Site_organizationId_code_key" ON "Site"("organizationId", "code");
CREATE INDEX "Site_organizationId_isActive_idx" ON "Site"("organizationId", "isActive");

CREATE INDEX "StoreLocation_siteId_isActive_sortOrder_idx"
  ON "StoreLocation"("siteId", "isActive", "sortOrder");
CREATE INDEX "Product_organizationId_isActive_idx" ON "Product"("organizationId", "isActive");
CREATE INDEX "StoreCountSession_siteId_status_startedAt_idx"
  ON "StoreCountSession"("siteId", "status", "startedAt");

CREATE UNIQUE INDEX "ProductPackaging_productId_level_unitsOfEach_key"
  ON "ProductPackaging"("productId", "level", "unitsOfEach");
CREATE INDEX "ProductPackaging_productId_isActive_idx"
  ON "ProductPackaging"("productId", "isActive");

CREATE UNIQUE INDEX "ProductIdentifier_organizationId_type_value_key"
  ON "ProductIdentifier"("organizationId", "type", "value");
CREATE INDEX "ProductIdentifier_productId_isPrimary_idx"
  ON "ProductIdentifier"("productId", "isPrimary");
CREATE INDEX "ProductIdentifier_packagingId_idx" ON "ProductIdentifier"("packagingId");

CREATE INDEX "InventoryTransaction_organizationId_siteId_occurredAt_idx"
  ON "InventoryTransaction"("organizationId", "siteId", "occurredAt");
CREATE INDEX "InventoryTransaction_locationId_productId_occurredAt_idx"
  ON "InventoryTransaction"("locationId", "productId", "occurredAt");
CREATE INDEX "InventoryTransaction_productId_occurredAt_idx"
  ON "InventoryTransaction"("productId", "occurredAt");
CREATE INDEX "InventoryTransaction_referenceType_referenceId_idx"
  ON "InventoryTransaction"("referenceType", "referenceId");
CREATE INDEX "InventoryTransaction_actorUserId_occurredAt_idx"
  ON "InventoryTransaction"("actorUserId", "occurredAt");

ALTER TABLE "OrganizationMembership"
  ADD CONSTRAINT "OrganizationMembership_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationMembership"
  ADD CONSTRAINT "OrganizationMembership_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Site"
  ADD CONSTRAINT "Site_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoreLocation"
  ADD CONSTRAINT "StoreLocation_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Product"
  ADD CONSTRAINT "Product_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StoreCountSession"
  ADD CONSTRAINT "StoreCountSession_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductPackaging"
  ADD CONSTRAINT "ProductPackaging_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductIdentifier"
  ADD CONSTRAINT "ProductIdentifier_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductIdentifier"
  ADD CONSTRAINT "ProductIdentifier_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductIdentifier"
  ADD CONSTRAINT "ProductIdentifier_packagingId_fkey"
  FOREIGN KEY ("packagingId") REFERENCES "ProductPackaging"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryTransaction"
  ADD CONSTRAINT "InventoryTransaction_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransaction"
  ADD CONSTRAINT "InventoryTransaction_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransaction"
  ADD CONSTRAINT "InventoryTransaction_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "StoreLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransaction"
  ADD CONSTRAINT "InventoryTransaction_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransaction"
  ADD CONSTRAINT "InventoryTransaction_packagingId_fkey"
  FOREIGN KEY ("packagingId") REFERENCES "ProductPackaging"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryTransaction"
  ADD CONSTRAINT "InventoryTransaction_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
