import { randomUUID } from "node:crypto";
import { prisma } from "./prisma.js";

export type PilotSite = { id: string; organizationId: string };

export async function ensurePilotSiteForUser(userId: string, role: string): Promise<PilotSite | null> {
  const existing = await prisma.site.findFirst({
    where: {
      isActive: true,
      organization: {
        isActive: true,
        memberships: { some: { userId, isActive: true } },
      },
    },
    orderBy: [{ code: "asc" }, { id: "asc" }],
    select: { id: true, organizationId: true },
  });
  if (existing) return existing;
  if (role !== "ADMIN") return null;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pilot-site:${userId}`}))`;

    const siteAfterLock = await tx.site.findFirst({
      where: {
        isActive: true,
        organization: {
          isActive: true,
          memberships: { some: { userId, isActive: true } },
        },
      },
      orderBy: [{ code: "asc" }, { id: "asc" }],
      select: { id: true, organizationId: true },
    });
    if (siteAfterLock) return siteAfterLock;

    let membership = await tx.organizationMembership.findFirst({
      where: { userId, isActive: true, organization: { isActive: true } },
      orderBy: { createdAt: "asc" },
      select: { organizationId: true },
    });

    if (!membership) {
      const organization = await tx.organization.create({
        data: {
          name: "Store Scan",
          slug: `store-scan-${randomUUID().slice(0, 12)}`,
        },
        select: { id: true },
      });
      membership = await tx.organizationMembership.create({
        data: { organizationId: organization.id, userId, role: "OWNER" },
        select: { organizationId: true },
      });
    }

    const site = await tx.site.create({
      data: {
        organizationId: membership.organizationId,
        code: "MAIN",
        name: "Main Store",
        type: "STORE",
        countryCode: "US",
      },
      select: { id: true, organizationId: true },
    });

    await tx.storeLocation.updateMany({ where: { siteId: null }, data: { siteId: site.id } });
    await tx.product.updateMany({
      where: { organizationId: null },
      data: { organizationId: membership.organizationId },
    });

    return site;
  });
}
