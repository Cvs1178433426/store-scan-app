import Fastify from "fastify";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { authRoutes } from "./routes/auth.js";
import { mfaRoutes } from "./routes/mfa.js";
import { registrationRoutes } from "./routes/registration.js";
import { locationRoutes } from "./routes/locations.js";
import { categoryRoutes } from "./routes/categories.js";
import { itemRoutes } from "./routes/items.js";
import { barcodeRoutes, publicBarcodeRoutes } from "./routes/barcodes.js";
import { lookupRoutes } from "./routes/lookup.js";
import { attachmentRoutes, mediaAttachmentRoutes } from "./routes/attachments.js";
import { settingsRoutes } from "./routes/settings.js";
import { backupRoutes } from "./routes/backup.js";
import { labelRoutes } from "./routes/labels.js";
import { movementRoutes } from "./routes/movements.js";
import { maintenanceRoutes } from "./routes/maintenance.js";
import { pushRoutes } from "./routes/push.js";
import { auditRoutes } from "./routes/audit.js";
import { xpRoutes } from "./routes/xp.js";
import { insightsRoutes } from "./routes/insights.js";
import { storeCountRoutes } from "./routes/storeCount.js";
import { storeCountExportRoutes } from "./routes/storeCountExport.js";
import { storeLocationRoutes } from "./routes/storeLocations.js";
import { productRoutes } from "./routes/products.js";
import { taskRoutes } from "./routes/tasks.js";
import { startExpiryNotificationJob } from "./jobs/expiryNotifications.js";
import { startTrashPurgeJob } from "./jobs/trashPurge.js";
import { startLowStockSummaryJob } from "./jobs/lowStockSummary.js";
import { requestLocaleFromHeaders } from "./lib/requestLocale.js";
import { getAuthoritativeAccessState } from "./lib/tokenVersion.js";
import { prisma } from "./lib/prisma.js";
import { assertMfaEncryptionConfig } from "./lib/mfa.js";
import { assertSmsMfaConfig } from "./lib/verificationProvider.js";
import { isSmsEnrollmentRequired } from "./lib/smsMigration.js";

const INSECURE_JWT_SECRETS = new Set(["", "changeme", "dev-secret-change-me"]);
const SMS_ENROLLMENT_ROUTES = new Set([
  "/api/auth/logout",
  "/api/auth/me",
  "/api/auth/mfa/phone/enroll/start",
]);

function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET ?? "";
  const isProd = process.env.NODE_ENV === "production";
  if (isProd && INSECURE_JWT_SECRETS.has(secret)) {
    console.error("FATAL: JWT_SECRET must be set to a strong random value in production.");
    process.exit(1);
  }
  if (!secret) {
    console.warn("JWT_SECRET is not set. Using development fallback.");
    return "dev-secret-change-me";
  }
  return secret;
}

export async function buildApp() {
  const jwtSecret = resolveJwtSecret();
  const legacyInventoryFeaturesEnabled = process.env.ENABLE_LEGACY_INVENTORY_FEATURES === "true";
  assertMfaEncryptionConfig();
  assertSmsMfaConfig();

  const app = Fastify({
    trustProxy: process.env.TRUST_PROXY === "true" ? "loopback, linklocal, uniquelocal" : false,
    logger: {
      serializers: {
        req(request) {
          const rawUrl = request.raw?.url ?? request.url;
          const safeUrl = typeof rawUrl === "string" ? rawUrl.replace(/([?&](?:token|sig|ticket)=)[^&]*/gi, "$1[REDACTED]") : rawUrl;
          return { method: request.method, url: safeUrl, hostname: request.hostname, remoteAddress: request.ip };
        },
      },
    },
  });

  const configuredOrigin = process.env.APP_PUBLIC_URL?.trim();
  await app.register(cors, { origin: configuredOrigin || true });
  await app.register(cookie);
  await app.register(jwt, { secret: jwtSecret });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  await app.register(rateLimit, { global: false });

  app.decorateRequest("locale", "en");
  app.addHook("onRequest", async (request) => { request.locale = requestLocaleFromHeaders(request.headers); });

  app.decorate("authenticate", async (request, reply) => {
    try {
      await request.jwtVerify();
      // Any purpose-scoped JWT (MFA challenge, media, backup) is not a normal API session.
      if (request.user.purpose !== undefined
        || typeof request.user.sub !== "string"
        || request.user.sub.length === 0
        || typeof request.user.tv !== "number") throw new Error("unauthorized");
      const state = await getAuthoritativeAccessState(request.user.sub);
      if (!state || !state.isActive || state.accountStatus !== "ACTIVE" || state.tokenVersion !== request.user.tv) {
        throw new Error("unauthorized");
      }
      const routePath = request.url.split("?", 1)[0];
      if (isSmsEnrollmentRequired(state.phoneVerifiedAt) && !SMS_ENROLLMENT_ROUTES.has(routePath)) {
        reply.code(403).send({ error: "Verify a mobile number to continue.", code: "sms_enrollment_required" });
      }
    } catch {
      reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.decorate("requireAdmin", async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.user.sub }, select: { role: true, isActive: true } });
    if (!user || !user.isActive) { reply.code(401).send({ error: "unauthorized" }); return; }
    if (user.role !== "ADMIN") { reply.code(403).send({ error: "admin only" }); return; }
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/api/health/version", async () => ({
    sha: process.env.BUILD_SHA?.trim() || process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || "unknown",
  }));

  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(mfaRoutes, { prefix: "/api/auth" });
  await app.register(registrationRoutes, { prefix: "/api/auth" });
  await app.register(barcodeRoutes, { prefix: "/api" });
  await app.register(publicBarcodeRoutes, { prefix: "/api/barcodes" });
  await app.register(lookupRoutes, { prefix: "/api/lookup" });
  await app.register(productRoutes, { prefix: "/api/products" });
  await app.register(storeLocationRoutes, { prefix: "/api/store-locations" });
  await app.register(storeCountRoutes, { prefix: "/api/store-count" });
  await app.register(storeCountExportRoutes, { prefix: "/api/store-count" });
  await app.register(taskRoutes, { prefix: "/api/tasks" });
  await app.register(attachmentRoutes, { prefix: "/api/attachments" });
  await app.register(mediaAttachmentRoutes, { prefix: "/api/attachments" });

  if (legacyInventoryFeaturesEnabled) {
    app.log.warn("ENABLE_LEGACY_INVENTORY_FEATURES=true: inherited non-pilot inventory features are enabled.");
    await app.register(locationRoutes, { prefix: "/api/locations" });
    await app.register(categoryRoutes, { prefix: "/api/categories" });
    await app.register(itemRoutes, { prefix: "/api/items" });
    await app.register(settingsRoutes, { prefix: "/api/settings" });
    await app.register(backupRoutes, { prefix: "/api/backup" });
    await app.register(labelRoutes, { prefix: "/api/labels" });
    await app.register(movementRoutes, { prefix: "/api/movements" });
    await app.register(maintenanceRoutes, { prefix: "/api" });
    await app.register(pushRoutes, { prefix: "/api/push" });
    await app.register(auditRoutes, { prefix: "/api/audit" });
    await app.register(xpRoutes, { prefix: "/api/xp" });
    await app.register(insightsRoutes, { prefix: "/api/insights" });
  }

  return app;
}

export async function startServer() {
  const app = await buildApp();
  if (process.env.ENABLE_LEGACY_INVENTORY_FEATURES === "true") {
    startExpiryNotificationJob();
    startTrashPurgeJob();
    startLowStockSummaryJob();
  }
  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ port, host: "0.0.0.0" });
  return app;
}

const entryPath = process.argv[1];
if (entryPath && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  startServer().catch((err) => { console.error(err); process.exit(1); });
}
