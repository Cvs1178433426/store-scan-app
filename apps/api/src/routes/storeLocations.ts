import type { FastifyInstance } from "fastify";
import { storeLocationInputSchema, storeLocationUpdateSchema } from "@stash/shared";
import { prisma } from "../lib/prisma.js";
import { isUniqueConstraintError } from "../lib/prismaErrors.js";
import { ensurePilotSiteForUser } from "../lib/pilotSite.js";

export async function storeLocationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (request, reply) => {
    const site = await ensurePilotSiteForUser(request.user.sub, request.user.role);
    if (!site) return reply.code(403).send({ error: "No authorized store site is configured for this user." });

    if (request.user.role === "ADMIN") {
      const anyLocation = await prisma.storeLocation.findFirst({ where: { siteId: site.id }, select: { id: true } });
      if (!anyLocation) {
        await prisma.storeLocation.create({
          data: { siteId: site.id, code: "TEST", name: "Pilot Test Area", isActive: true, sortOrder: 0 },
        });
      }
    }

    const query = request.query as { includeInactive?: string };
    const includeInactive = query.includeInactive === "true";
    return prisma.storeLocation.findMany({
      where: {
        siteId: site.id,
        ...(includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      include: { _count: { select: { entries: true } } },
    });
  });

  app.post("/", async (request, reply) => {
    const parsed = storeLocationInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const site = await ensurePilotSiteForUser(request.user.sub, request.user.role);
    if (!site) return reply.code(403).send({ error: "No authorized store site is configured for this user." });

    try {
      const location = await prisma.storeLocation.create({ data: { ...parsed.data, siteId: site.id } });
      return reply.code(201).send(location);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return reply.code(409).send({ error: `Location code "${parsed.data.code}" already exists.` });
      }
      throw err;
    }
  });

  app.patch("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = storeLocationUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const site = await ensurePilotSiteForUser(request.user.sub, request.user.role);
    if (!site) return reply.code(403).send({ error: "No authorized store site is configured for this user." });

    const existing = await prisma.storeLocation.findFirst({ where: { id, siteId: site.id } });
    if (!existing) return reply.code(404).send({ error: "Store location not found." });

    try {
      return await prisma.storeLocation.update({ where: { id }, data: parsed.data });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return reply.code(409).send({ error: "That location code already exists." });
      }
      throw err;
    }
  });

  app.delete("/:id", async (_request, reply) => {
    return reply.code(405).send({
      error: "Locations cannot be hard-deleted because historical counts may reference them. Mark the location inactive instead.",
    });
  });
}
