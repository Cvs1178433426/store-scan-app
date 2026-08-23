import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

const createSessionSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
});

const scanSchema = z.object({
  barcodeValue: z.string().trim().min(1).max(128),
  locationCode: z.string().trim().min(1).max(120),
  quantityDelta: z.number().int().min(1).max(999).default(1),
  itemId: z.string().nullable().optional(),
  productName: z.string().trim().max(300).nullable().optional(),
  packageSize: z.string().trim().max(120).nullable().optional(),
});

const setQuantitySchema = z.object({
  quantity: z.number().int().min(0).max(999999),
});

function normalizeLocationCode(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

export async function storeCountRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  async function findOwnedSession(id: string, userId: string) {
    return prisma.storeCountSession.findFirst({ where: { id, startedById: userId } });
  }

  app.post("/sessions", async (request, reply) => {
    const parsed = createSessionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const existing = await prisma.storeCountSession.findFirst({
      where: { status: "ACTIVE", startedById: request.user.sub },
      orderBy: { startedAt: "desc" },
      include: { entries: { orderBy: { updatedAt: "desc" } } },
    });
    if (existing) return reply.send(existing);

    const session = await prisma.storeCountSession.create({
      data: {
        name: parsed.data.name ?? null,
        startedById: request.user.sub,
      },
    });
    return reply.code(201).send(session);
  });

  app.get("/sessions/active", async (request) => {
    return prisma.storeCountSession.findFirst({
      where: { status: "ACTIVE", startedById: request.user.sub },
      orderBy: { startedAt: "desc" },
      include: { entries: { orderBy: { updatedAt: "desc" } } },
    });
  });

  app.get("/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const owned = await findOwnedSession(id, request.user.sub);
    if (!owned) return reply.code(404).send({ error: "count session not found" });

    const session = await prisma.storeCountSession.findUnique({
      where: { id },
      include: {
        entries: {
          orderBy: [{ locationCode: "asc" }, { updatedAt: "desc" }],
          include: {
            item: {
              select: {
                id: true,
                name: true,
                manufacturer: true,
                packageSize: true,
                photoUrl: true,
                categoryId: true,
                isActive: true,
              },
            },
          },
        },
      },
    });
    return session;
  });

  app.post("/sessions/:id/scan", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = scanSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const session = await findOwnedSession(id, request.user.sub);
    if (!session) return reply.code(404).send({ error: "count session not found" });
    if (session.status !== "ACTIVE") return reply.code(409).send({ error: "count session is not active" });

    const barcodeValue = parsed.data.barcodeValue.trim();
    const locationCode = normalizeLocationCode(parsed.data.locationCode);
    const { quantityDelta } = parsed.data;
    let itemId = parsed.data.itemId ?? null;
    let productName = parsed.data.productName ?? null;
    let packageSize = parsed.data.packageSize ?? null;

    if (!itemId) {
      const barcode = await prisma.barcode.findUnique({
        where: { value: barcodeValue },
        include: { item: true },
      });
      if (barcode?.item) {
        itemId = barcode.item.id;
        productName = productName || barcode.item.name;
        packageSize = packageSize || barcode.item.packageSize;
      }
    }

    const entry = await prisma.storeCountEntry.upsert({
      where: {
        sessionId_locationCode_barcodeValue: {
          sessionId: id,
          locationCode,
          barcodeValue,
        },
      },
      update: {
        quantity: { increment: quantityDelta },
        ...(itemId ? { itemId } : {}),
        ...(productName ? { productName } : {}),
        ...(packageSize ? { packageSize } : {}),
        scannedAt: new Date(),
      },
      create: {
        sessionId: id,
        itemId,
        barcodeValue,
        locationCode,
        quantity: quantityDelta,
        productName,
        packageSize,
      },
    });

    return reply.send(entry);
  });

  app.patch("/sessions/:sessionId/entries/:entryId", async (request, reply) => {
    const { sessionId, entryId } = request.params as { sessionId: string; entryId: string };
    const parsed = setQuantitySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const session = await findOwnedSession(sessionId, request.user.sub);
    if (!session) return reply.code(404).send({ error: "count session not found" });

    const entry = await prisma.storeCountEntry.findFirst({ where: { id: entryId, sessionId } });
    if (!entry) return reply.code(404).send({ error: "count entry not found" });

    if (parsed.data.quantity === 0) {
      await prisma.storeCountEntry.delete({ where: { id: entryId } });
      return reply.code(204).send();
    }

    return prisma.storeCountEntry.update({
      where: { id: entryId },
      data: { quantity: parsed.data.quantity },
    });
  });

  app.get("/sessions/:id/summary", async (request, reply) => {
    const { id } = request.params as { id: string };
    const owned = await findOwnedSession(id, request.user.sub);
    if (!owned) return reply.code(404).send({ error: "count session not found" });

    const session = await prisma.storeCountSession.findUnique({
      where: { id },
      include: { entries: true },
    });
    if (!session) return reply.code(404).send({ error: "count session not found" });

    const rowsByProduct = new Map<string, {
      barcodeValue: string;
      itemId: string | null;
      productName: string | null;
      packageSize: string | null;
      total: number;
      byLocation: Record<string, number>;
    }>();

    for (const entry of session.entries) {
      const key = entry.itemId ? `item:${entry.itemId}` : `barcode:${entry.barcodeValue}`;
      let row = rowsByProduct.get(key);
      if (!row) {
        row = {
          barcodeValue: entry.barcodeValue,
          itemId: entry.itemId,
          productName: entry.productName,
          packageSize: entry.packageSize,
          total: 0,
          byLocation: {},
        };
        rowsByProduct.set(key, row);
      }
      row.total += entry.quantity;
      row.byLocation[entry.locationCode] = (row.byLocation[entry.locationCode] ?? 0) + entry.quantity;
    }

    const rows = [...rowsByProduct.values()].sort((a, b) =>
      (a.productName || a.barcodeValue).localeCompare(b.productName || b.barcodeValue),
    );
    const totalUnits = rows.reduce((sum, row) => sum + row.total, 0);
    const locations = [...new Set(session.entries.map((entry) => entry.locationCode))].sort();

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
    const existing = await findOwnedSession(id, request.user.sub);
    if (!existing) return reply.code(404).send({ error: "count session not found" });
    if (existing.status !== "ACTIVE") return reply.code(409).send({ error: "count session is not active" });

    return prisma.storeCountSession.update({
      where: { id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
  });
}
