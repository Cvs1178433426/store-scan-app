import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { prisma } from "../src/lib/prisma.js";
import { productRoutes } from "../src/routes/products.js";
import { storeCountRoutes } from "../src/routes/storeCount.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseJson<T>(body: string): T {
  return JSON.parse(body) as T;
}

async function main() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const adminEmail = `route-admin-${suffix}@example.test`;
  const userEmail = `route-user-${suffix}@example.test`;
  const organizationSlug = `route-org-${suffix}`;
  const siteCode = `SITE-${suffix}`;
  const locationCode = `ROUTE-${suffix}`;
  const barcodeAtomic = `route-atomic-${suffix}`;
  const barcodeRetry = `route-retry-${suffix}`;
  const barcodeConflict = `route-conflict-${suffix}`;
  const barcodeCatalog = `route-catalog-${suffix}`;
  const catalogName = `Catalog Product ${suffix}`;

  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: "store-count-route-validation-secret" });
  app.decorate("authenticate", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });
  await app.register(productRoutes, { prefix: "/api/products" });
  await app.register(storeCountRoutes, { prefix: "/api/store-count" });
  await app.ready();

  let adminId: string | null = null;
  let userId: string | null = null;
  let organizationId: string | null = null;
  let locationId: string | null = null;

  try {
    const [admin, user] = await Promise.all([
      prisma.user.create({
        data: {
          name: "Route Validation Admin",
          email: adminEmail,
          passwordHash: "not-used-in-route-validation",
          role: "ADMIN",
        },
      }),
      prisma.user.create({
        data: {
          name: "Route Validation User",
          email: userEmail,
          passwordHash: "not-used-in-route-validation",
          role: "GENERAL",
        },
      }),
    ]);
    adminId = admin.id;
    userId = user.id;

    const organization = await prisma.organization.create({
      data: {
        name: "Route Validation Organization",
        slug: organizationSlug,
      },
    });
    organizationId = organization.id;

    await prisma.organizationMembership.createMany({
      data: [
        { organizationId: organization.id, userId: admin.id, role: "ADMIN", isActive: true },
        { organizationId: organization.id, userId: user.id, role: "INVENTORY", isActive: true },
      ],
    });

    const site = await prisma.site.create({
      data: {
        organizationId: organization.id,
        code: siteCode,
        name: "Route validation site",
        type: "STORE",
        isActive: true,
      },
    });

    const location = await prisma.storeLocation.create({
      data: {
        siteId: site.id,
        code: locationCode,
        name: "Route validation location",
        isActive: true,
      },
    });
    locationId = location.id;

    await prisma.product.createMany({
      data: [
        { barcodeValue: barcodeAtomic, name: "Atomic route product", isActive: true },
        { barcodeValue: barcodeRetry, name: "Retry route product", isActive: true },
        { barcodeValue: barcodeConflict, name: "Conflict route product", isActive: true },
      ],
    });

    const adminToken = app.jwt.sign({ sub: admin.id, role: "ADMIN", tv: 0 });
    const userToken = app.jwt.sign({ sub: user.id, role: "GENERAL", tv: 0 });
    const auth = (token: string) => ({ authorization: `Bearer ${token}` });

    // Exercise the actual POST /sessions route concurrently. The advisory lock
    // must collapse all requests for one user onto the same ACTIVE session.
    const startResponses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: "POST",
          url: "/api/store-count/sessions",
          headers: auth(adminToken),
          payload: { name: "Route concurrency validation", siteId: site.id },
        }),
      ),
    );
    for (const response of startResponses) {
      assert(response.statusCode === 200 || response.statusCode === 201, `session creation returned ${response.statusCode}: ${response.body}`);
    }
    const sessionIds = new Set(startResponses.map((response) => parseJson<{ id: string }>(response.body).id));
    assert(sessionIds.size === 1, `concurrent session creation produced ${sessionIds.size} ACTIVE sessions`);
    const sessionId = [...sessionIds][0]!;
    const activeSessionCount = await prisma.storeCountSession.count({
      where: { startedById: admin.id, status: "ACTIVE", siteId: site.id },
    });
    assert(activeSessionCount === 1, `database contains ${activeSessionCount} ACTIVE sessions for one user/site`);

    // Prove the public Product API and Store Count share one catalog. This is a
    // regression guard for the historical /api/items vs /api/products split:
    // save a product through the real Product route, scan it through the real
    // Store Count route, then verify both the count entry and summary resolve it.
    const createCatalogProduct = await app.inject({
      method: "POST",
      url: "/api/products",
      headers: auth(adminToken),
      payload: {
        barcodeValue: barcodeCatalog,
        name: catalogName,
        manufacturer: "Route Validation Co",
        packageSize: "12 ct",
        isActive: true,
      },
    });
    assert(createCatalogProduct.statusCode === 201, `Product API create returned ${createCatalogProduct.statusCode}: ${createCatalogProduct.body}`);
    const createdCatalogProduct = parseJson<{ id: string; barcodeValue: string; name: string }>(createCatalogProduct.body);
    assert(createdCatalogProduct.barcodeValue === barcodeCatalog, "Product API returned the wrong barcode");

    const catalogLookup = await app.inject({
      method: "GET",
      url: `/api/products/by-barcode/${encodeURIComponent(barcodeCatalog)}`,
      headers: auth(adminToken),
    });
    assert(catalogLookup.statusCode === 200, `Product API barcode lookup returned ${catalogLookup.statusCode}: ${catalogLookup.body}`);
    const lookedUpCatalogProduct = parseJson<{ id: string; name: string }>(catalogLookup.body);
    assert(lookedUpCatalogProduct.id === createdCatalogProduct.id, "Product API barcode lookup did not return the newly-created Product");

    const catalogScan = await app.inject({
      method: "POST",
      url: `/api/store-count/sessions/${sessionId}/scan`,
      headers: auth(adminToken),
      payload: {
        barcodeValue: barcodeCatalog,
        locationId: location.id,
        quantityDelta: 1,
        clientScanId: `route-catalog-scan-${suffix}`,
      },
    });
    assert(catalogScan.statusCode === 200, `newly cataloged Product scan returned ${catalogScan.statusCode}: ${catalogScan.body}`);
    const catalogEntry = parseJson<{ productId: string | null; barcodeValue: string; quantity: number; product: { id: string; name: string } | null }>(catalogScan.body);
    assert(catalogEntry.productId === createdCatalogProduct.id, "Store Count entry did not reference the Product created through /api/products");
    assert(catalogEntry.product?.name === catalogName, "Store Count scan did not resolve the newly-created Product name");
    assert(catalogEntry.quantity === 1, `newly cataloged Product scan produced quantity ${catalogEntry.quantity}, expected 1`);

    const catalogSummaryResponse = await app.inject({
      method: "GET",
      url: `/api/store-count/sessions/${sessionId}/summary`,
      headers: auth(adminToken),
    });
    assert(catalogSummaryResponse.statusCode === 200, `summary after catalog scan returned ${catalogSummaryResponse.statusCode}: ${catalogSummaryResponse.body}`);
    const catalogSummary = parseJson<{ rows: Array<{ productId: string | null; barcodeValue: string; productName: string | null; total: number }> }>(catalogSummaryResponse.body);
    const catalogSummaryRow = catalogSummary.rows.find((row) => row.barcodeValue === barcodeCatalog);
    assert(Boolean(catalogSummaryRow), "summary omitted the Product created through /api/products");
    assert(catalogSummaryRow!.productId === createdCatalogProduct.id, "summary referenced the wrong Product id");
    assert(catalogSummaryRow!.productName === catalogName, "summary did not display the newly-created Product name");
    assert(catalogSummaryRow!.total === 1, `summary total for newly-created Product was ${catalogSummaryRow!.total}, expected 1`);

    // Exercise the real HTTP scan endpoint with 20 separate physical scans.
    const atomicResponses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        app.inject({
          method: "POST",
          url: `/api/store-count/sessions/${sessionId}/scan`,
          headers: auth(adminToken),
          payload: {
            barcodeValue: barcodeAtomic,
            locationId: location.id,
            quantityDelta: 1,
            clientScanId: `route-atomic-${suffix}-${index}`,
          },
        }),
      ),
    );
    for (const response of atomicResponses) {
      assert(response.statusCode === 200, `unique scan returned ${response.statusCode}: ${response.body}`);
    }
    const atomicEntry = await prisma.storeCountEntry.findUniqueOrThrow({
      where: {
        sessionId_locationId_barcodeValue: {
          sessionId,
          locationId: location.id,
          barcodeValue: barcodeAtomic,
        },
      },
    });
    assert(atomicEntry.quantity === 20, `20 HTTP scans produced quantity ${atomicEntry.quantity}, expected 20`);

    // Exercise the real HTTP endpoint with ten retries of one physical scan.
    const retryKey = `route-single-physical-scan-${suffix}`;
    const retryResponses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: "POST",
          url: `/api/store-count/sessions/${sessionId}/scan`,
          headers: auth(adminToken),
          payload: {
            barcodeValue: barcodeRetry,
            locationId: location.id,
            quantityDelta: 1,
            clientScanId: retryKey,
          },
        }),
      ),
    );
    for (const response of retryResponses) {
      assert(response.statusCode === 200, `idempotent retry returned ${response.statusCode}: ${response.body}`);
    }
    const retryEntry = await prisma.storeCountEntry.findUniqueOrThrow({
      where: {
        sessionId_locationId_barcodeValue: {
          sessionId,
          locationId: location.id,
          barcodeValue: barcodeRetry,
        },
      },
    });
    assert(retryEntry.quantity === 1, `10 HTTP retries produced quantity ${retryEntry.quantity}, expected 1`);

    // A non-owner must not be able to scan another user's session.
    const forbidden = await app.inject({
      method: "POST",
      url: `/api/store-count/sessions/${sessionId}/scan`,
      headers: auth(userToken),
      payload: {
        barcodeValue: barcodeConflict,
        locationId: location.id,
        quantityDelta: 1,
        clientScanId: `route-forbidden-${suffix}`,
      },
    });
    assert(forbidden.statusCode === 403, `non-owner scan returned ${forbidden.statusCode}, expected 403`);

    // Create a second user's session and prove a reused idempotency key cannot
    // cross session boundaries, even when an ADMIN is authorized for both.
    const userSessionResponse = await app.inject({
      method: "POST",
      url: "/api/store-count/sessions",
      headers: auth(userToken),
      payload: { name: "Second-user session", siteId: site.id },
    });
    assert(userSessionResponse.statusCode === 201, `second user session returned ${userSessionResponse.statusCode}: ${userSessionResponse.body}`);
    const userSessionId = parseJson<{ id: string }>(userSessionResponse.body).id;
    const conflictKey = `route-cross-session-${suffix}`;

    const firstConflictKeyUse = await app.inject({
      method: "POST",
      url: `/api/store-count/sessions/${sessionId}/scan`,
      headers: auth(adminToken),
      payload: {
        barcodeValue: barcodeConflict,
        locationId: location.id,
        quantityDelta: 1,
        clientScanId: conflictKey,
      },
    });
    assert(firstConflictKeyUse.statusCode === 200, `first idempotency-key use returned ${firstConflictKeyUse.statusCode}`);

    const crossSessionReuse = await app.inject({
      method: "POST",
      url: `/api/store-count/sessions/${userSessionId}/scan`,
      headers: auth(adminToken),
      payload: {
        barcodeValue: barcodeConflict,
        locationId: location.id,
        quantityDelta: 1,
        clientScanId: conflictKey,
      },
    });
    assert(crossSessionReuse.statusCode === 409, `cross-session idempotency reuse returned ${crossSessionReuse.statusCode}, expected 409`);

    const complete = await app.inject({
      method: "POST",
      url: `/api/store-count/sessions/${userSessionId}/complete`,
      headers: auth(adminToken),
    });
    assert(complete.statusCode === 200, `complete returned ${complete.statusCode}: ${complete.body}`);

    const scanCompleted = await app.inject({
      method: "POST",
      url: `/api/store-count/sessions/${userSessionId}/scan`,
      headers: auth(adminToken),
      payload: {
        barcodeValue: barcodeConflict,
        locationId: location.id,
        quantityDelta: 1,
        clientScanId: `route-after-complete-${suffix}`,
      },
    });
    assert(scanCompleted.statusCode === 409, `scan into completed session returned ${scanCompleted.statusCode}, expected 409`);

    console.log("Store Count HTTP route validation passed:");
    console.log("- authorized organization/site membership is enforced for session creation");
    console.log("- Product API create -> barcode lookup -> Store Count scan -> summary uses the same Product");
    console.log("- 10 concurrent session starts => exactly one ACTIVE session per user/site");
    console.log("- 20 concurrent unique HTTP scans => quantity 20");
    console.log("- 10 concurrent HTTP retries with one clientScanId => quantity 1");
    console.log("- non-owner scan => 403");
    console.log("- cross-session clientScanId reuse => 409");
    console.log("- scan after completion => 409");
  } finally {
    await app.close();
    if (adminId || userId) {
      await prisma.storeCountSession.deleteMany({
        where: { startedById: { in: [adminId, userId].filter((value): value is string => Boolean(value)) } },
      });
    }
    await prisma.product.deleteMany({
      where: { barcodeValue: { in: [barcodeAtomic, barcodeRetry, barcodeConflict, barcodeCatalog] } },
    });
    if (locationId) await prisma.storeLocation.deleteMany({ where: { id: locationId } });
    if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});