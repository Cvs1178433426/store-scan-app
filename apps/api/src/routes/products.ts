import type { FastifyInstance } from "fastify";
import { productInputSchema, productUpdateSchema } from "@stash/shared";
import { prisma } from "../lib/prisma.js";
import { isUniqueConstraintError } from "../lib/prismaErrors.js";
import { resolveOrganizationContext } from "../lib/organizationContext.js";

type ProductQuery = { q?: string; includeInactive?: string; organizationId?: string };

async function organizationForRequest(request: {
  user: { sub: string; role?: string };
  query: unknown;
}) {
  const query = request.query as ProductQuery;
  return resolveOrganizationContext(request.user.sub, request.user.role, query.organizationId?.trim() || undefined);
}

export async function productRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (request, reply) => {
    const context = await organizationForRequest(request);
    if (!context) return reply.code(400).send({ error: "select one authorized organization" });
    const query = request.query as ProductQuery;
    const includeInactive = query.includeInactive === "true";
    const q = query.q?.trim();

    return prisma.product.findMany({
      where: {
        organizationId: context.organizationId,
        ...(includeInactive ? {} : { isActive: true }),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { manufacturer: { contains: q, mode: "insensitive" } },
                { barcodeValue: { contains: q } },
              ],
            }
          : {}),
      },
      orderBy: { name: "asc" },
      include: { category: true },
    });
  });

  app.get("/by-barcode/:barcode", async (request, reply) => {
    const context = await organizationForRequest(request);
    if (!context) return reply.code(400).send({ error: "select one authorized organization" });
    const { barcode } = request.params as { barcode: string };
    const product = await prisma.product.findFirst({
      where: { organizationId: context.organizationId, barcodeValue: barcode },
      include: { category: true },
    });
    if (!product) return reply.code(404).send({ error: "product not found" });
    return product;
  });

  app.get("/:id", async (request, reply) => {
    const context = await organizationForRequest(request);
    if (!context) return reply.code(400).send({ error: "select one authorized organization" });
    const { id } = request.params as { id: string };
    const product = await prisma.product.findFirst({
      where: { id, organizationId: context.organizationId },
      include: { category: true },
    });
    if (!product) return reply.code(404).send({ error: "product not found" });
    return product;
  });

  app.post("/", async (request, reply) => {
    const context = await organizationForRequest(request);
    if (!context) return reply.code(400).send({ error: "select one authorized organization" });
    const parsed = productInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    try {
      const product = await prisma.product.create({
        data: { ...parsed.data, organizationId: context.organizationId },
      });
      return reply.code(201).send(product);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return reply.code(409).send({ error: `A product with barcode "${parsed.data.barcodeValue}" already exists.` });
      }
      throw err;
    }
  });

  app.patch("/:id", async (request, reply) => {
    const context = await organizationForRequest(request);
    if (!context) return reply.code(400).send({ error: "select one authorized organization" });
    const { id } = request.params as { id: string };
    const parsed = productUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    try {
      const existing = await prisma.product.findFirst({
        where: { id, organizationId: context.organizationId },
        select: { id: true },
      });
      if (!existing) return reply.code(404).send({ error: "product not found" });
      return await prisma.product.update({ where: { id: existing.id }, data: parsed.data });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return reply.code(409).send({ error: "That barcode is already assigned to another product." });
      }
      throw err;
    }
  });

  app.delete("/:id", async (_request, reply) => {
    return reply.code(405).send({
      error: "Products cannot be hard-deleted because historical counts may reference them. Mark the product inactive instead.",
    });
  });
}
