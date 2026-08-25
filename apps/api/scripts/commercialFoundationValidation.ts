import { prisma } from "../src/lib/prisma.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectReject(label: string, action: () => Promise<unknown>) {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  assert(rejected, `${label} unexpectedly succeeded`);
}

async function main() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const userA = await prisma.user.create({
    data: {
      name: "Commercial Validation A",
      email: `commercial-a-${suffix}@example.test`,
      passwordHash: "unused",
      role: "GENERAL",
    },
  });
  const userB = await prisma.user.create({
    data: {
      name: "Commercial Validation B",
      email: `commercial-b-${suffix}@example.test`,
      passwordHash: "unused",
      role: "GENERAL",
    },
  });

  const orgA = await prisma.organization.create({ data: { name: "Org A", slug: `org-a-${suffix}` } });
  const orgB = await prisma.organization.create({ data: { name: "Org B", slug: `org-b-${suffix}` } });

  await prisma.organizationMembership.create({
    data: { organizationId: orgA.id, userId: userA.id, role: "OWNER" },
  });
  await prisma.organizationMembership.create({
    data: { organizationId: orgB.id, userId: userB.id, role: "OWNER" },
  });

  const siteA = await prisma.site.create({
    data: { organizationId: orgA.id, code: "MAIN", name: "Org A Main", type: "WAREHOUSE" },
  });
  const siteB = await prisma.site.create({
    data: { organizationId: orgB.id, code: "MAIN", name: "Org B Main", type: "WAREHOUSE" },
  });
  assert(siteA.code === siteB.code, "same site code should be usable in different organizations");

  const locationA = await prisma.storeLocation.create({
    data: { siteId: siteA.id, code: `A-${suffix}`, name: "A Receiving" },
  });
  const locationB = await prisma.storeLocation.create({
    data: { siteId: siteB.id, code: `B-${suffix}`, name: "B Receiving" },
  });

  const productA = await prisma.product.create({
    data: { organizationId: orgA.id, barcodeValue: `A-${suffix}`, name: "Org A Product" },
  });
  const productB = await prisma.product.create({
    data: { organizationId: orgB.id, barcodeValue: `B-${suffix}`, name: "Org B Product" },
  });

  const eachA = await prisma.productPackaging.create({
    data: { productId: productA.id, level: "EACH", unitsOfEach: 1, isSellable: true },
  });
  const caseA = await prisma.productPackaging.create({
    data: { productId: productA.id, level: "CASE", unitsOfEach: 12, isOrderable: true, isReceivable: true },
  });
  const eachB = await prisma.productPackaging.create({
    data: { productId: productB.id, level: "EACH", unitsOfEach: 1, isSellable: true },
  });

  const unitIdentifier = await prisma.productIdentifier.create({
    data: {
      organizationId: orgA.id,
      productId: productA.id,
      packagingId: eachA.id,
      type: "UPC",
      value: `0123${suffix}`,
      isPrimary: true,
      source: "commercial-foundation-validation",
    },
  });
  const caseIdentifier = await prisma.productIdentifier.create({
    data: {
      organizationId: orgA.id,
      productId: productA.id,
      packagingId: caseA.id,
      type: "GTIN",
      value: `CASE-${suffix}`,
      source: "commercial-foundation-validation",
    },
  });
  assert(unitIdentifier.value !== caseIdentifier.value, "case and each identifiers must remain independent values");

  await expectReject("cross-organization ProductIdentifier", () =>
    prisma.productIdentifier.create({
      data: {
        organizationId: orgA.id,
        productId: productB.id,
        packagingId: eachB.id,
        type: "UPC",
        value: `WRONG-ORG-${suffix}`,
      },
    }),
  );

  await expectReject("cross-product packaging on ProductIdentifier", () =>
    prisma.productIdentifier.create({
      data: {
        organizationId: orgA.id,
        productId: productA.id,
        packagingId: eachB.id,
        type: "GTIN",
        value: `WRONG-PACK-${suffix}`,
      },
    }),
  );

  const receive = await prisma.inventoryTransaction.create({
    data: {
      organizationId: orgA.id,
      siteId: siteA.id,
      locationId: locationA.id,
      productId: productA.id,
      packagingId: caseA.id,
      type: "RECEIVE",
      quantity: "24",
      unitOfMeasure: "EACH",
      referenceType: "RECEIPT",
      referenceId: `RCV-${suffix}`,
      actorUserId: userA.id,
    },
  });
  const ship = await prisma.inventoryTransaction.create({
    data: {
      organizationId: orgA.id,
      siteId: siteA.id,
      locationId: locationA.id,
      productId: productA.id,
      packagingId: eachA.id,
      type: "SHIP",
      quantity: "-5",
      unitOfMeasure: "EACH",
      referenceType: "SHIPMENT",
      referenceId: `SHP-${suffix}`,
      actorUserId: userA.id,
    },
  });
  const adjustment = await prisma.inventoryTransaction.create({
    data: {
      organizationId: orgA.id,
      siteId: siteA.id,
      locationId: locationA.id,
      productId: productA.id,
      packagingId: eachA.id,
      type: "COUNT_ADJUSTMENT",
      quantity: "-1",
      unitOfMeasure: "EACH",
      referenceType: "COUNT",
      referenceId: `CNT-${suffix}`,
      actorUserId: userA.id,
      reason: "Physical count reconciliation",
    },
  });

  const balance = await prisma.inventoryTransaction.aggregate({
    where: { organizationId: orgA.id, siteId: siteA.id, locationId: locationA.id, productId: productA.id },
    _sum: { quantity: true },
  });
  assert(balance._sum.quantity?.toString() === "18", `ledger balance was ${balance._sum.quantity?.toString()}, expected 18`);

  await expectReject("cross-organization site transaction", () =>
    prisma.inventoryTransaction.create({
      data: {
        organizationId: orgA.id,
        siteId: siteB.id,
        locationId: locationB.id,
        productId: productA.id,
        type: "RECEIVE",
        quantity: "1",
        actorUserId: userA.id,
      },
    }),
  );

  await expectReject("cross-site location transaction", () =>
    prisma.inventoryTransaction.create({
      data: {
        organizationId: orgA.id,
        siteId: siteA.id,
        locationId: locationB.id,
        productId: productA.id,
        type: "RECEIVE",
        quantity: "1",
        actorUserId: userA.id,
      },
    }),
  );

  await expectReject("cross-organization product transaction", () =>
    prisma.inventoryTransaction.create({
      data: {
        organizationId: orgA.id,
        siteId: siteA.id,
        locationId: locationA.id,
        productId: productB.id,
        type: "RECEIVE",
        quantity: "1",
        actorUserId: userA.id,
      },
    }),
  );

  await expectReject("non-member actor transaction", () =>
    prisma.inventoryTransaction.create({
      data: {
        organizationId: orgA.id,
        siteId: siteA.id,
        locationId: locationA.id,
        productId: productA.id,
        type: "RECEIVE",
        quantity: "1",
        actorUserId: userB.id,
      },
    }),
  );

  await expectReject("wrong RECEIVE sign", () =>
    prisma.inventoryTransaction.create({
      data: {
        organizationId: orgA.id,
        siteId: siteA.id,
        locationId: locationA.id,
        productId: productA.id,
        type: "RECEIVE",
        quantity: "-1",
        actorUserId: userA.id,
      },
    }),
  );

  await expectReject("wrong SHIP sign", () =>
    prisma.inventoryTransaction.create({
      data: {
        organizationId: orgA.id,
        siteId: siteA.id,
        locationId: locationA.id,
        productId: productA.id,
        type: "SHIP",
        quantity: "1",
        actorUserId: userA.id,
      },
    }),
  );

  await expectReject("zero ledger transaction", () =>
    prisma.inventoryTransaction.create({
      data: {
        organizationId: orgA.id,
        siteId: siteA.id,
        locationId: locationA.id,
        productId: productA.id,
        type: "MANUAL_ADJUSTMENT",
        quantity: "0",
        actorUserId: userA.id,
      },
    }),
  );

  await expectReject("InventoryTransaction update", () =>
    prisma.inventoryTransaction.update({ where: { id: receive.id }, data: { quantity: "999" } }),
  );
  await expectReject("InventoryTransaction delete", () =>
    prisma.inventoryTransaction.delete({ where: { id: ship.id } }),
  );

  const stillThere = await prisma.inventoryTransaction.findMany({
    where: { id: { in: [receive.id, ship.id, adjustment.id] } },
  });
  assert(stillThere.length === 3, "append-only ledger lost a committed transaction");

  console.log("Commercial foundation validation passed:");
  console.log("- same Site code can exist in separate Organizations");
  console.log("- EACH and CASE identifiers remain explicit and independent");
  console.log("- cross-organization ProductIdentifier relationships are rejected");
  console.log("- inventory ledger rejects mismatched Organization/Site/Location/Product relationships");
  console.log("- ledger requires active organization membership for actor accountability");
  console.log("- RECEIVE/SHIP direction and zero-quantity rules are enforced");
  console.log("- ledger is append-only: UPDATE and DELETE are rejected");
  console.log("- RECEIVE 24, SHIP 5, COUNT_ADJUSTMENT -1 => on-hand 18");

  // The ledger is intentionally append-only, so test cleanup cannot delete its
  // transaction rows. This disposable CI database is destroyed with the job.
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
