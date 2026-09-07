import { prisma } from "../src/lib/prisma.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function approvePendingUser(userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('continuixai-pilot-bootstrap'))`;
    const activeAdmin = await tx.user.findFirst({
      where: { role: "ADMIN", accountStatus: "ACTIVE", isActive: true },
      select: { id: true },
    });
    await tx.user.update({
      where: { id: userId },
      data: {
        accountStatus: "ACTIVE",
        isActive: true,
        phoneVerifiedAt: new Date(),
        role: activeAdmin ? "GENERAL" : "ADMIN",
      },
    });
  });
}

async function main() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ids: string[] = [];

  try {
    const pending = await prisma.user.create({
      data: {
        name: "Pending SMS User",
        email: `pending-sms-${suffix}@example.test`,
        passwordHash: "not-used-in-validation",
        accountStatus: "PENDING_PHONE_VERIFICATION",
        isActive: false,
      },
    });
    ids.push(pending.id);
    assert(pending.accountStatus === "PENDING_PHONE_VERIFICATION" && !pending.isActive, "pending user must be inactive");

    let constraintRejected = false;
    try {
      await prisma.$executeRaw`UPDATE "User" SET "isActive" = true WHERE "id" = ${pending.id}`;
    } catch {
      constraintRejected = true;
    }
    assert(constraintRejected, "database must reject accountStatus/isActive disagreement");

    const first = await prisma.user.create({
      data: {
        name: "Concurrent SMS User A",
        email: `sms-a-${suffix}@example.test`,
        passwordHash: "not-used-in-validation",
        accountStatus: "PENDING_PHONE_VERIFICATION",
        isActive: false,
      },
    });
    const second = await prisma.user.create({
      data: {
        name: "Concurrent SMS User B",
        email: `sms-b-${suffix}@example.test`,
        passwordHash: "not-used-in-validation",
        accountStatus: "PENDING_PHONE_VERIFICATION",
        isActive: false,
      },
    });
    ids.push(first.id, second.id);

    const priorAdmins = await prisma.user.count({ where: { role: "ADMIN", accountStatus: "ACTIVE", isActive: true } });
    await Promise.all([approvePendingUser(first.id), approvePendingUser(second.id)]);
    const activated = await prisma.user.findMany({ where: { id: { in: [first.id, second.id] } }, select: { role: true, accountStatus: true, isActive: true } });
    const newAdmins = activated.filter((user) => user.role === "ADMIN").length;
    assert(activated.every((user) => user.accountStatus === "ACTIVE" && user.isActive), "both approvals must activate consistently");
    assert(newAdmins === (priorAdmins === 0 ? 1 : 0), "concurrent approvals must create exactly one first administrator");

    console.log("SMS MFA schema validation passed: status consistency and atomic first-admin activation are enforced.");
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
