CREATE TABLE "SiteMembership" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SiteMembership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SiteMembership_siteId_userId_key" ON "SiteMembership"("siteId", "userId");
CREATE INDEX "SiteMembership_userId_isActive_idx" ON "SiteMembership"("userId", "isActive");
CREATE INDEX "SiteMembership_siteId_isActive_idx" ON "SiteMembership"("siteId", "isActive");

ALTER TABLE "SiteMembership" ADD CONSTRAINT "SiteMembership_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SiteMembership" ADD CONSTRAINT "SiteMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "SiteMembership" ("id", "siteId", "userId", "isActive", "createdAt", "updatedAt")
SELECT 'sm_' || md5(random()::text || clock_timestamp()::text || s."id" || om."userId"), s."id", om."userId", om."isActive", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "OrganizationMembership" om
JOIN "Site" s ON s."organizationId" = om."organizationId" AND s."isActive" = true
JOIN (
  SELECT "organizationId"
  FROM "Site"
  WHERE "isActive" = true
  GROUP BY "organizationId"
  HAVING COUNT(*) = 1
) single_site_org ON single_site_org."organizationId" = om."organizationId"
ON CONFLICT ("siteId", "userId") DO NOTHING;
