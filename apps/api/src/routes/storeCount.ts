import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { isUniqueConstraintError } from "../lib/prismaErrors.js";
import { resolveProduct } from "../lib/barcodeLookup/index.js";
import { matchExistingCategory } from "../lib/barcodeLookup/categoryMatch.js";

const createSessionSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
});

const scanSchema = z.object({
  barcodeValue: z.string().trim().min(1).max(128),
  locationId: z.string().trim().min(1),
  quantityDelta: z.number().int().min(1).max(999).default(1),
  clientScanId: z.string().trim().min(1).max(160).optional(),
});

const setQuantitySchema = z.object({
  quantity: z.number().int().min(0).max(999999),
});

type SessionRow = Awaited<ReturnType<typeof prisma.storeCountSession.findUnique>>;

export type SummaryEntryInput = {
  productId: string | null;
  barcodeValue: string;
  quantity: number;
  locationId: string;
  location: { code: string };
  product: { name: string; packageSize: string | null } | null;
};

export type SummaryRow = {
  key: string;
  productId: string | null;
  barcodeValue: string;
  productName: string | null;
  packageSize: string | null;
  total: number;
  byLocation: Record<string, { locationCode: string; quantity: number }>;
};

export function buildSummaryRows(entries: SummaryEntryInput[]): SummaryRow[] {
  const byKey = new Map<string, SummaryRow>();
  for (const entry of entries) {
    const key = entry.productId ?? `barcode:${entry.barcodeValue}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        productId: entry.productId,
        barcodeValue: entry.barcodeValue,
        productName: entry.product?.name ?? null,
        packageSize: entry.product?.packageSize ?? null,
        total: 0,
        byLocation: {},
      };
      byKey.set(key, row);
    }
    row.total += entry.quantity;
    const existingLoc = row.byLocation[entry.locationId];
    row.byLocation[entry.locationId] = {
      locationCode: entry.location.code,
      quantity: (existingLoc?.quantity ?? 0) + entry.quantity,
    };
  }
  return [...byKey.values()].sort((a, b) =>
    (a.productName || a.barcodeValue).localeCompare(b.productName || b.barcodeValue),
  );
}

async function assertSessionAccess(
  sessionId: string,
  userId: string,
  role: string,
): Promise<{ ok: true; session: NonNullable<SessionRow> } | { ok: false; code: number; error: string }> {
  const session = await prisma.storeCountSession.findUnique({ where: { id: sessionId } });
  if (!session) return { ok: false, code: 404, error: "count session not found" };
  if (session.startedById !== userId && role !== "ADMIN") {
    return { ok: false, code: 403, error: "you do not have access to this count session" };
  }
  return { ok: true, session };
}

async function findOrEnrichProduct(barcodeValue: string) {
  const existing = await prisma.product.findUnique({ where: { barcodeValue } });
  if (existing) return existing;

  const lookup = await resolveProduct(barcodeValue);
  if (!lookup.found || !lookup.name?.trim()) return null;

  const categories = await prisma.category.findMany({
    where: { isActive: true },
    select: { id: true, name: true, isActive: true },
  });
  const matchedCategory = matchExistingCategory(lookup.category, categories);

  return prisma.product.upsert({
    where: { barcodeValue },
    update: {},
    create: {
      barcodeValue,
      name: lookup.name.trim(),
      manufacturer: lookup.brand?.trim() || null,
      description: lookup.description?.trim() || null,
      packageSize: lookup.size?.trim() || null,
      imageUrl: lookup.imageUrl?.trim() || null,
      categoryId: matchedCategory?.id ?? null,
      isActive: true,
    },
  });
}

async function findIdempotentEntry(clientScanId: string, sessionId: string) {
  const log = await prisma.storeCountScanLog.findUnique({
    where: { idempotencyKey: clientScanId },
    include: { entry: { include: { product: true, location: true } } },
  });
  if (!log) return null;
  if (log.sessionId !== sessionId) return "conflict" as const;
  return log.entry;
}

export async function storeCountRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/sessions", async (request, reply) => {
    const parsed = createSessionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const userId = request.user.sub;
    if (!userId) return reply.code(401).send({ error: "invalid authenticated user" });

    const result = await prisma.$transaction(async (tx) => {
      // Serialize session creation for this user across browser tabs/devices.
      // This avoids duplicate ACTIVE sessions without adding a partial unique
      // index that Prisma cannot represent cleanly in schema.prisma.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
      const existing = await tx.storeCountSession.findFirst({
        where: { status: "ACTIVE", startedById: userId },
        orderBy: { startedAt: "desc" },
      });
      if (existing) return { created: false, session: existing };
      const session = await tx.storeCountSession.create({
        data: { name: parsed.data.name ?? null, startedById: userId },
      });
      return { created: true, session };
    });

    return reply.code(result.created ? 201 : 200).send(result.session);
  });

  app.get("/sessions/active", async (request) => {
    const userId = request.user.sub;
    return prisma.storeCountSession.findFirst({
      where: { status: "ACTIVE", startedById: userId },
      orderBy: { startedAt: "desc" },
      include: {
        entries: {
          orderBy: { updatedAt: "desc" },
          include: { product: true, location: true },
        },
      },
    });
  });

  app.get("/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });
    const access = await assertSessionAccess(id, userId, role);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });

    const session = await prisma.storeCountSession.findUnique({
      where: { id },
      include: {
        entries: {
          orderBy: [{ locationId: "asc" }, { updatedAt: "desc" }],
          include: { product: { include: { category: true } }, location: true },
        },
      },
    });
    if (!session) return reply.code(404).send({ error: "count session not found" });
    return session;
  });

  app.post("/sessions/:id/scan", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = scanSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });

    const access = await assertSessionAccess(id, userId, role);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });
    if (access.session.status !== "ACTIVE") return reply.code(409).send({ error: "count session is not active" });

    const { barcodeValue, locationId, quantityDelta, clientScanId } = parsed.data;
    const location = await prisma.storeLocation.findUnique({ where: { id: locationId } });
    if (!location) return reply.code(400).send({ error: "unknown locationId" });
    if (!location.isActive) return reply.code(400).send({ error: "this location is inactive" });

    if (clientScanId) {
      const prior = await findIdempotentEntry(clientScanId, id);
      if (prior === "conflict") return reply.code(409).send({ error: "clientScanId was already used for another count session" });
      if (prior) return reply.send(prior);
    }

    let product = await prisma.product.findUnique({ where: { barcodeValue } });
    if (!product) {
      try {
        product = await findOrEnrichProduct(barcodeValue);
      } catch {
        product = null;
      }
    }

    try {
      const entry = await prisma.$transaction(async (tx) => {
        // Lock the parent session for the duration of the write. This closes the
        // race where a request passes the ACTIVE check, a supervisor completes
        // the count, and the scan otherwise lands after completion.
        const lockedSession = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT "status" FROM "StoreCountSession" WHERE "id" = ${id} FOR UPDATE
        `;
        if (lockedSession[0]?.status !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");

        if (clientScanId) {
          const prior = await tx.storeCountScanLog.findUnique({ where: { idempotencyKey: clientScanId } });
          if (prior) {
            if (prior.sessionId !== id) throw new Error("IDEMPOTENCY_SESSION_CONFLICT");
            return tx.storeCountEntry.findUniqueOrThrow({
              where: { id: prior.entryId },
              include: { product: true, location: true },
            });
          }
        }

        // Prisma upsert can race on the initial INSERT when multiple HTTP requests
        // create the same compound key at once. Use PostgreSQL's native ON CONFLICT
        // so creation and increment are one atomic statement under real contention.
        const now = new Date();
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO "StoreCountEntry"
            ("id", "sessionId", "productId", "barcodeValue", "locationId", "quantity", "scannedAt", "updatedAt")
          VALUES
            (${randomUUID()}, ${id}, ${product?.id ?? null}, ${barcodeValue}, ${locationId}, ${quantityDelta}, ${now}, ${now})
          ON CONFLICT ("sessionId", "locationId", "barcodeValue")
          DO UPDATE SET
            "quantity" = "StoreCountEntry"."quantity" + EXCLUDED."quantity",
            "productId" = COALESCE(EXCLUDED."productId", "StoreCountEntry"."productId"),
            "scannedAt" = EXCLUDED."scannedAt",
            "updatedAt" = EXCLUDED."updatedAt"
          RETURNING "id"
        `;
        const countedId = rows[0]?.id;
        if (!countedId) throw new Error("STORE_COUNT_ENTRY_WRITE_FAILED");
        const counted = await tx.storeCountEntry.findUniqueOrThrow({
          where: { id: countedId },
          include: { product: true, location: true },
        });

        if (clientScanId) {
          await tx.storeCountScanLog.create({
            data: {
              idempotencyKey: clientScanId,
              entryId: counted.id,
              sessionId: id,
              quantityDelta,
            },
          });
        }
        return counted;
      });
      return reply.send(entry);
    } catch (error) {
      if (error instanceof Error && error.message === "SESSION_NOT_ACTIVE") {
        return reply.code(409).send({ error: "count session is not active" });
      }
      if (error instanceof Error && error.message === "IDEMPOTENCY_SESSION_CONFLICT") {
        return reply.code(409).send({ error: "clientScanId was already used for another count session" });
      }
      if (clientScanId && isUniqueConstraintError(error)) {
        const prior = await findIdempotentEntry(clientScanId, id);
        if (prior === "conflict") return reply.code(409).send({ error: "clientScanId was already used for another count session" });
        if (prior) return reply.send(prior);
      }
      throw error;
    }
  });

  app.patch("/sessions/:sessionId/entries/:entryId", async (request, reply) => {
    const { sessionId, entryId } = request.params as { sessionId: string; entryId: string };
    const parsed = setQuantitySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });

    const access = await assertSessionAccess(sessionId, userId, role);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });
    if (access.session.status !== "ACTIVE") return reply.code(409).send({ error: "count session is not active" });

    try {
      const result = await prisma.$transaction(async (tx) => {
        const lockedSession = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT "status" FROM "StoreCountSession" WHERE "id" = ${sessionId} FOR UPDATE
        `;
        if (lockedSession[0]?.status !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE");

        const entry = await tx.storeCountEntry.findFirst({ where: { id: entryId, sessionId } });
        if (!entry) throw new Error("ENTRY_NOT_FOUND");

        if (parsed.data.quantity === 0) {
          await tx.storeCountEntry.delete({ where: { id: entryId } });
          return null;
        }

        return tx.storeCountEntry.update({
          where: { id: entryId },
          data: { quantity: parsed.data.quantity },
          include: { product: true, location: true },
        });
      });

      if (!result) return reply.code(204).send();
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === "SESSION_NOT_ACTIVE") {
        return reply.code(409).send({ error: "count session is not active" });
      }
      if (error instanceof Error && error.message === "ENTRY_NOT_FOUND") {
        return reply.code(404).send({ error: "count entry not found" });
      }
      throw error;
    }
  });

  app.get("/sessions/:id/summary", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });
    const access = await assertSessionAccess(id, userId, role);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });

    const session = await prisma.storeCountSession.findUnique({
      where: { id },
      include: { entries: { include: { product: true, location: true } } },
    });
    if (!session) return reply.code(404).send({ error: "count session not found" });

    const rows = buildSummaryRows(session.entries);
    const totalUnits = rows.reduce((sum, row) => sum + row.total, 0);
    const locations = [...new Set(session.entries.map((entry) => entry.location.code))].sort();

    return {
      session: {
        id: session.id,
        name: session.name,
        status: session.status,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
      },
      distinctProducts: rows.length,
      totalUnits,
      locations,
      rows,
    };
  });

  app.post("/sessions/:id/complete", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });
    const access = await assertSessionAccess(id, userId, role);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });
    if (access.session.status !== "ACTIVE") return reply.code(409).send({ error: "count session is not active" });

    return prisma.storeCountSession.update({
      where: { id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
  });

  app.post("/sessions/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.sub;
    const role = request.user.role;
    if (!userId || !role) return reply.code(401).send({ error: "invalid authenticated user" });
    const access = await assertSessionAccess(id, userId, role);
    if (!access.ok) return reply.code(access.code).send({ error: access.error });
    if (access.session.status !== "ACTIVE") return reply.code(409).send({ error: "count session is not active" });

    return prisma.storeCountSession.update({
      where: { id },
      data: { status: "CANCELLED", completedAt: new Date() },
    });
  });
}
