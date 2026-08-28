import { randomUUID } from "node:crypto";
import { prisma } from "./prisma.js";

export type PilotSite = { id: string; organizationId: string; timeZone: string; name: string; code: string };

export async function ensurePilotSiteForUser(userId: string, role?: string): Promise<PilotSite | null> {
  const existing = await prisma.site.findMany({
    where: {
      isActive: true,
      organization: {
        isActive: true,
        memberships: { some: { userId, isActive: true } },
      },
    },
    take: 2,
    orderBy: [{ code: "asc" }, { id: "asc" }],
    select: { id: true, organizationId: true, timeZone: true, name: true, code: true },
  });
  if (existing.length === 1) return existing[0];
  if (existing.length > 1) return null;

  if (role !== "ADMIN") {
    const organizations = await prisma.organization.findMany({
      where: { isActive: true },
      take: 2,
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        sites: {
          where: { isActive: true },
          take: 1,
          orderBy: [{ code: "asc" }, { id: "asc" }],
          select: { id: true, organizationId: true, timeZone: true, name: true, code: true },
        },
      },
    });
    if (organizations.length !== 1 || organizations[0].sites.length !== 1) return null;

    const organization = organizations[0];
    await prisma.organizationMembership.upsert({
      where: { organizationId_userId: { organizationId: organization.id, userId } },
      update: { isActive: true, role: "INVENTORY" },
      create: { organizationId: organization.id, userId, role: "INVENTORY" },
    });
    return organization.sites[0];
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pilot-site:${userId}`}))`;

    const sitesAfterLock = await tx.site.findMany({
      where: {
        isActive: true,
        organization: {
          isActive: true,
          memberships: { some: { userId, isActive: true } },
        },
      },
      take: 2,
      orderBy: [{ code: "asc" }, { id: "asc" }],
      select: { id: true, organizationId: true, timeZone: true, name: true, code: true },
    });
    if (sitesAfterLock.length === 1) return sitesAfterLock[0];
    if (sitesAfterLock.length > 1) return null;

    let membership = await tx.organizationMembership.findFirst({
      where: { userId, isActive: true, organization: { isActive: true } },
      orderBy: { createdAt: "asc" },
      select: { organizationId: true },
    });

    if (!membership) {
      const organization = await tx.organization.create({
        data: {
          name: "Continuixai",
          slug: `continuixai-${randomUUID().slice(0, 12)}`,
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
      select: { id: true, organizationId: true, timeZone: true, name: true, code: true },
    });

    await tx.storeLocation.updateMany({ where: { siteId: null }, data: { siteId: site.id } });
    await tx.product.updateMany({
      where: { organizationId: null },
      data: { organizationId: membership.organizationId },
    });

    return site;
  });
}
