import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { afterEach, describe, expect, it } from "vitest";
import { backupRoutes } from "./backup.js";

describe("legacy backup restore with SMS MFA", () => {
  afterEach(() => {
    delete process.env.SMS_MFA_ENABLED;
  });

  it("rejects restore before reading an archive when SMS MFA is enabled", async () => {
    process.env.SMS_MFA_ENABLED = "true";
    const server = Fastify({ logger: false });
    server.decorate("authenticate", async () => {});
    server.decorate("requireAdmin", async () => {});
    server.decorateRequest("locale", "en");
    await server.register(multipart);
    await server.register(backupRoutes, { prefix: "/api/backup" });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/api/backup/restore",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "Backup restore is unavailable while SMS MFA is enabled.",
    });
    await server.close();
  });
});
