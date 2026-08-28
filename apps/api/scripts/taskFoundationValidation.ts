import { prisma } from "../src/lib/prisma.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectReject(label: string, action: () => Promise<unknown>) {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function main() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const manager = await prisma.user.create({
    data: { name: "Task Manager", email: `task-manager-${suffix}@example.test`, passwordHash: "unused", role: "GENERAL", jobTitle: "STORE_MANAGER" },
  });
  const employee = await prisma.user.create({
    data: { name: "Task Employee", email: `task-employee-${suffix}@example.test`, passwordHash: "unused", role: "GENERAL", jobTitle: "STOCK_COUNT_ASSOCIATE" },
  });
  const outsider = await prisma.user.create({
    data: { name: "Task Outsider", email: `task-outsider-${suffix}@example.test`, passwordHash: "unused", role: "GENERAL" },
  });
  const organization = await prisma.organization.create({ data: { name: "Task Org", slug: `task-org-${suffix}` } });
  const otherOrganization = await prisma.organization.create({ data: { name: "Other Task Org", slug: `other-task-org-${suffix}` } });
  await prisma.organizationMembership.createMany({
    data: [
      { organizationId: organization.id, userId: manager.id, role: "MANAGER" },
      { organizationId: organization.id, userId: employee.id, role: "INVENTORY" },
      { organizationId: otherOrganization.id, userId: outsider.id, role: "OWNER" },
    ],
  });
  const site = await prisma.site.create({ data: { organizationId: organization.id, code: "MAIN", name: "Main", timeZone: "America/New_York" } });
  const otherSite = await prisma.site.create({ data: { organizationId: otherOrganization.id, code: "MAIN", name: "Other" } });

  const template = await prisma.taskTemplate.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      jobTitle: "STOCK_COUNT_ASSOCIATE",
      title: "Count assigned aisle",
      recurrence: "DAILY",
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      priority: "HIGH",
      createdById: manager.id,
      updatedById: manager.id,
    },
  });

  const assignmentData = {
    templateId: template.id,
    organizationId: organization.id,
    siteId: site.id,
    assignedToId: employee.id,
    title: template.title,
    scheduledDate: new Date("2026-08-28T00:00:00.000Z"),
    priority: template.priority,
  } as const;
  const first = await prisma.taskAssignment.createMany({ data: [assignmentData], skipDuplicates: true });
  const retry = await prisma.taskAssignment.createMany({ data: [assignmentData], skipDuplicates: true });
  assert(first.count === 1, `first recurrence generation created ${first.count}, expected 1`);
  assert(retry.count === 0, `idempotent recurrence retry created ${retry.count}, expected 0`);

  await prisma.taskTemplate.update({ where: { id: template.id }, data: { title: "Changed template title", updatedById: manager.id } });
  const assignment = await prisma.taskAssignment.findFirstOrThrow({ where: { templateId: template.id, assignedToId: employee.id } });
  assert(assignment.title === "Count assigned aisle", "template edit rewrote assignment history");

  await expectReject("cross-organization TaskTemplate site", () => prisma.taskTemplate.create({
    data: {
      organizationId: organization.id,
      siteId: otherSite.id,
      jobTitle: "RECEIVER",
      title: "Invalid cross-organization template",
      recurrence: "DAILY",
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      createdById: manager.id,
      updatedById: manager.id,
    },
  }));
  await expectReject("non-member TaskAssignment assignee", () => prisma.taskAssignment.create({
    data: {
      organizationId: organization.id,
      siteId: site.id,
      assignedToId: outsider.id,
      title: "Invalid outsider assignment",
      scheduledDate: new Date("2026-08-28T00:00:00.000Z"),
    },
  }));

  console.log("Role-based task foundation validation passed.");
}

main().finally(() => prisma.$disconnect()).catch((error) => {
  console.error(error);
  process.exit(1);
});
