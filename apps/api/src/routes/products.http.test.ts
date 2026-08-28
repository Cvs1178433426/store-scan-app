import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberships: vi.fn(),
  organizations: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    organizationMembership: { findMany: mocks.memberships },
    organization: { findFirst: mocks.organizations },
    product: {
      findMany: mocks.findMany,
      findFirst: mocks.findFirst,
      create: mocks.create,
      update: mocks.update,
    },
  },
}));

import { productRoutes } from "./products.js";

async function testApp() {
  const app = Fastify();
  app.decorate("authenticate", async (request) => {
    Object.assign(request, { user: { sub: "user-a", role: "GENERAL", tv: 0 } });
  });
  await app.register(productRoutes, { prefix: "/api/products" });
  return app;
}

describe("product routes tenant isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memberships.mockResolvedValue([{ organizationId: "org-a" }]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("always scopes catalog lists to the user's only active organization", async () => {
    mocks.findMany.mockResolvedValue([]);
    const app = await testApp();
    const response = await app.inject({ method: "GET", url: "/api/products?includeInactive=true" });
    expect(response.statusCode).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ organizationId: "org-a" }),
    }));
    await app.close();
  });

  it("does not read or update a product outside that organization", async () => {
    mocks.findFirst.mockResolvedValue(null);
    const app = await testApp();
    const read = await app.inject({ method: "GET", url: "/api/products/product-in-org-b" });
    const update = await app.inject({
      method: "PATCH",
      url: "/api/products/product-in-org-b",
      payload: { name: "Changed" },
    });
    expect(read.statusCode).toBe(404);
    expect(update.statusCode).toBe(404);
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "product-in-org-b", organizationId: "org-a" },
    }));
    expect(mocks.update).not.toHaveBeenCalled();
    await app.close();
  });

  it("writes the resolved organization instead of accepting global products", async () => {
    mocks.create.mockResolvedValue({ id: "product-a", organizationId: "org-a", name: "Milk" });
    const app = await testApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/products",
      payload: { name: "Milk", barcodeValue: "123" },
    });
    expect(response.statusCode).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: "org-a", barcodeValue: "123" }),
    });
    await app.close();
  });

  it("requires an explicit selection instead of guessing across memberships", async () => {
    mocks.memberships.mockResolvedValue([{ organizationId: "org-a" }, { organizationId: "org-b" }]);
    const app = await testApp();
    const response = await app.inject({ method: "GET", url: "/api/products" });
    expect(response.statusCode).toBe(400);
    expect(mocks.findMany).not.toHaveBeenCalled();
    await app.close();
  });
});
