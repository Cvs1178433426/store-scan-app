-- Commercial integrity guards.
-- These database-level protections make the new inventory ledger append-only and
-- prevent cross-organization/site/product relationships even if an API bug ever
-- passes mismatched foreign keys. Application authorization is still required;
-- these constraints are defense in depth.

CREATE OR REPLACE FUNCTION "validate_product_identifier_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  product_org TEXT;
  packaging_product TEXT;
BEGIN
  SELECT "organizationId" INTO product_org
  FROM "Product"
  WHERE "id" = NEW."productId";

  IF product_org IS NULL OR product_org <> NEW."organizationId" THEN
    RAISE EXCEPTION 'ProductIdentifier organization must match Product organization';
  END IF;

  IF NEW."packagingId" IS NOT NULL THEN
    SELECT "productId" INTO packaging_product
    FROM "ProductPackaging"
    WHERE "id" = NEW."packagingId";

    IF packaging_product IS NULL OR packaging_product <> NEW."productId" THEN
      RAISE EXCEPTION 'ProductIdentifier packaging must belong to the same Product';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProductIdentifier_scope_guard"
BEFORE INSERT OR UPDATE ON "ProductIdentifier"
FOR EACH ROW EXECUTE FUNCTION "validate_product_identifier_scope"();

CREATE OR REPLACE FUNCTION "validate_inventory_transaction_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  site_org TEXT;
  location_site TEXT;
  product_org TEXT;
  packaging_product TEXT;
  actor_is_member BOOLEAN;
BEGIN
  SELECT "organizationId" INTO site_org
  FROM "Site"
  WHERE "id" = NEW."siteId";

  IF site_org IS NULL OR site_org <> NEW."organizationId" THEN
    RAISE EXCEPTION 'InventoryTransaction Site must belong to Organization';
  END IF;

  SELECT "siteId" INTO location_site
  FROM "StoreLocation"
  WHERE "id" = NEW."locationId";

  IF location_site IS NULL OR location_site <> NEW."siteId" THEN
    RAISE EXCEPTION 'InventoryTransaction Location must belong to Site';
  END IF;

  SELECT "organizationId" INTO product_org
  FROM "Product"
  WHERE "id" = NEW."productId";

  IF product_org IS NULL OR product_org <> NEW."organizationId" THEN
    RAISE EXCEPTION 'InventoryTransaction Product must belong to Organization';
  END IF;

  IF NEW."packagingId" IS NOT NULL THEN
    SELECT "productId" INTO packaging_product
    FROM "ProductPackaging"
    WHERE "id" = NEW."packagingId";

    IF packaging_product IS NULL OR packaging_product <> NEW."productId" THEN
      RAISE EXCEPTION 'InventoryTransaction Packaging must belong to Product';
    END IF;
  END IF;

  IF NEW."actorUserId" IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM "OrganizationMembership"
      WHERE "organizationId" = NEW."organizationId"
        AND "userId" = NEW."actorUserId"
        AND "isActive" = true
    ) INTO actor_is_member;

    IF NOT actor_is_member THEN
      RAISE EXCEPTION 'InventoryTransaction actor must be an active Organization member';
    END IF;
  END IF;

  IF NEW."quantity" = 0 THEN
    RAISE EXCEPTION 'InventoryTransaction quantity cannot be zero';
  END IF;

  IF NEW."type" IN ('RECEIVE', 'TRANSFER_IN') AND NEW."quantity" <= 0 THEN
    RAISE EXCEPTION 'Inbound InventoryTransaction quantity must be positive';
  END IF;

  IF NEW."type" IN ('SHIP', 'TRANSFER_OUT', 'DAMAGE', 'RETURN_TO_VENDOR') AND NEW."quantity" >= 0 THEN
    RAISE EXCEPTION 'Outbound InventoryTransaction quantity must be negative';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "InventoryTransaction_scope_guard"
BEFORE INSERT ON "InventoryTransaction"
FOR EACH ROW EXECUTE FUNCTION "validate_inventory_transaction_scope"();

CREATE OR REPLACE FUNCTION "prevent_inventory_transaction_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'InventoryTransaction is append-only; post a reversing/correcting transaction instead';
END;
$$;

CREATE TRIGGER "InventoryTransaction_no_update"
BEFORE UPDATE ON "InventoryTransaction"
FOR EACH ROW EXECUTE FUNCTION "prevent_inventory_transaction_mutation"();

CREATE TRIGGER "InventoryTransaction_no_delete"
BEFORE DELETE ON "InventoryTransaction"
FOR EACH ROW EXECUTE FUNCTION "prevent_inventory_transaction_mutation"();
