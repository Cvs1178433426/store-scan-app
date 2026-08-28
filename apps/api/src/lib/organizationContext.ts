import { prisma } from "./prisma.js";

export type OrganizationContext = { organizationId: string };

/**
 * Resolve an organization without ever guessing between multiple memberships.
 * Platform administrators may select an organization explicitly; ordinary users
 * must hold an active membership in the selected organization.
 */
export async function resolveOrganizationContext(
  userId: string,
  role: string | undefined,
  requestedOrganizationId?: string,
): Promise<OrganizationContext | null> {
  if (requestedOrganizationId) {
    const organization = await prisma.organization.findFirst({
      where: {
        id: requestedOrganizationId,
        isActive: true,
        ...(role === "ADMIN"
          ? {}
          : { memberships: { some: { userId, isActive: true } } }),
      },
      select: { id: true },
    });
    return organization ? { organizationId: organization.id } : null;
  }

  const memberships = await prisma.organizationMembership.findMany({
    where: { userId, isActive: true, organization: { isActive: true } },
    take: 2,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { organizationId: true },
  });
  return memberships.length === 1 ? { organizationId: memberships[0].organizationId } : null;
}
