BEGIN;

CREATE TABLE "PhoneLookupAlias" (
  "hash" TEXT NOT NULL,
  "keyVersion" INTEGER NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PhoneLookupAlias_pkey" PRIMARY KEY ("hash"),
  CONSTRAINT "PhoneLookupAlias_keyVersion_positive" CHECK ("keyVersion" > 0),
  CONSTRAINT "PhoneLookupAlias_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "PhoneLookupAlias_userId_idx" ON "PhoneLookupAlias"("userId");
CREATE INDEX "PhoneLookupAlias_keyVersion_idx" ON "PhoneLookupAlias"("keyVersion");

ALTER TABLE "User" ADD CONSTRAINT "User_phone_lookup_pair"
CHECK (("phoneLookupHash" IS NULL) = ("phoneLookupKeyVersion" IS NULL));

CREATE OR REPLACE FUNCTION "claim_user_phone_lookup_hash"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."phoneLookupHash" IS NULL OR NEW."phoneLookupKeyVersion" IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO "PhoneLookupAlias" ("hash", "keyVersion", "userId")
  VALUES (NEW."phoneLookupHash", NEW."phoneLookupKeyVersion", NEW."id")
  ON CONFLICT ("hash") DO UPDATE
    SET "keyVersion" = EXCLUDED."keyVersion"
    WHERE "PhoneLookupAlias"."userId" = EXCLUDED."userId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'phone lookup hash belongs to another user' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "User_claim_phone_lookup_hash"
AFTER INSERT OR UPDATE OF "phoneLookupHash", "phoneLookupKeyVersion" ON "User"
FOR EACH ROW EXECUTE FUNCTION "claim_user_phone_lookup_hash"();

INSERT INTO "PhoneLookupAlias" ("hash", "keyVersion", "userId")
SELECT "phoneLookupHash", "phoneLookupKeyVersion", "id"
FROM "User"
WHERE "phoneLookupHash" IS NOT NULL AND "phoneLookupKeyVersion" IS NOT NULL;

COMMIT;
