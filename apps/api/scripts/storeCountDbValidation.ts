import { prisma } from "../src/lib/prisma.js";

async function countWithIdempotency(options: {
  sessionId: string;
  locationId: string;
  barcodeValue: string;
  clientScanId: string;
}) {
  const { sessionId, locationId, barcodeValue, clientScanId } = options;

  const existingLog = await prisma.storeCountScanLog.findUnique({
    where: { idempotencyKey: clientScanId },
    include: { entry: true },
  });
  if (existingLog) return existingLog.entry;

  try {
    return await prisma.$transaction(async (tx) => {
      const prior = await tx.storeCountScanLog.findUnique({ where: { idempotencyKey: clientScanId } });
      if (prior) return tx.storeCountEntry.findUniqueOrThrow({ where: { id: prior.entryId } });

      const counted = await tx.storeCountEntry.upsert({
        where: {
          sessionId_locationId_barcodeValue: { sessionId, locationId, barcodeValue },
        },
        update: {
          quantity: { increment: 1 },
          scannedAt: new Date(),
        },
        create: {
          sessionId,
          barcodeValue,
          locationId,
          quantity: 1,
        },
      });

      await tx.storeCountScanLog.create({
        data: {
          idempotencyKey: clientScanId,
          entryId: counted.id,
          sessionId,
          quantityDelta: 1,
        },
      });
      return counted;
    });
  } catch (error) {
    // A duplicate retry can race another copy of itself. The transaction that
    // loses the unique idempotency-key insert must roll back its increment.
    const winner = await prisma.storeCountScanLog.findUnique({
      where: { idempotencyKey: clientScanId },
      include: { entry: true },
    });
    if (winner) return winner.entry;
    throw error;
  }
}

function assertEqual(actual: number, expected: number, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

async function main() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const location = await prisma.storeLocation.create({
    data: { code: `CI-${suffix}`, name: "CI validation location" },
  });
  const session = await prisma.storeCountSession.create({ data: { name: `CI-${suffix}` } });

  try {
    const uniqueBarcode = `CI-UNIQUE-${suffix}`;
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        countWithIdempotency({
          sessionId: session.id,
          locationId: location.id,
          barcodeValue: uniqueBarcode,
          clientScanId: `unique-${suffix}-${index}`,
        }),
      ),
    );

    const uniqueEntry = await prisma.storeCountEntry.findUniqueOrThrow({
      where: {
        sessionId_locationId_barcodeValue: {
          sessionId: session.id,
          locationId: location.id,
          barcodeValue: uniqueBarcode,
        },
      },
    });
    assertEqual(uniqueEntry.quantity, 20, "20 concurrent unique scans must all count exactly once");

    const retryBarcode = `CI-RETRY-${suffix}`;
    const retryId = `retry-${suffix}`;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        countWithIdempotency({
          sessionId: session.id,
          locationId: location.id,
          barcodeValue: retryBarcode,
          clientScanId: retryId,
        }),
      ),
    );

    const retryEntry = await prisma.storeCountEntry.findUniqueOrThrow({
      where: {
        sessionId_locationId_barcodeValue: {
          sessionId: session.id,
          locationId: location.id,
          barcodeValue: retryBarcode,
        },
      },
    });
    assertEqual(retryEntry.quantity, 1, "10 concurrent retries of one logical scan must count once");

    const retryLogs = await prisma.storeCountScanLog.count({ where: { idempotencyKey: retryId } });
    assertEqual(retryLogs, 1, "one logical scan must produce one idempotency log");

    console.log("Store Count PostgreSQL validation passed:");
    console.log("- 20 concurrent unique scans => quantity 20");
    console.log("- 10 concurrent retries with one clientScanId => quantity 1");
    console.log("- duplicate retry transaction increments rolled back correctly");
  } finally {
    await prisma.storeCountSession.delete({ where: { id: session.id } });
    await prisma.storeLocation.delete({ where: { id: location.id } });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
