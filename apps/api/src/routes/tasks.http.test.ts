import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensurePilotSiteForUser: vi.fn(),
  membershipFindUnique: vi.fn(),
  assignmentFindFirst: vi.fn(),
  assignmentUpdateMany: vi.fn(),
  assignmentFindUniqueOrThrow: vi.fn(),
  eventCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../lib/pilotSite.js", () => ({
  ensurePilotSiteForUser: mocks.ensurePilotSiteForUser,
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    organizationMembership: { findUnique: mocks.membershipFindUnique },
    taskAssignment: {
      findFirst: mocks.assignmentFindFirst,
      updateMany: mocks.assignmentUpdateMany,
      findUniqueOrThrow: mocks.assignmentFindUniqueOrThrow,
    },
    taskAssignmentEvent: { create: mocks.eventCreate },
    $transaction: mocks.transaction,
  },
}));

import { taskRoutes } from "./tasks.js";

async function testApp() {
  const app = Fastify();
  app.decorate("authenticate", async (request) => {
    Object.assign(request, { user: { sub: "user-a", role: "GENERAL", tv: 0 } });
  });
  await app.register(taskRoutes, { prefix: "/api/tasks" });
  return app;
}

describe("task route tenant and concurrency guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensurePilotSiteForUser.mockResolvedValue({
      id: "site-a",
      organizationId: "org-a",
      timeZone: "America/New_York",
      name: "Site A",
      code: "A",
    });
    mocks.membershipFindUnique.mockResolvedValue({ role: "MEMBER", isActive: true });
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({
      taskAssignment: {
        updateMany: mocks.assignmentUpdateMany,
        findUniqueOrThrow: mocks.assignmentFindUniqueOrThrow,
      },
      taskAssignmentEvent: { create: mocks.eventCreate },
    }));
  });

  it("scopes employee task lookup to the authenticated employee, organization, and site", async () => {
    mocks.assignmentFindFirst.mockResolvedValue(null);
    const app = await testApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/tasks/task-from-org-b",
      payload: { status: "COMPLETED" },
    });
    expect(response.statusCode).toBe(404);
    expect(mocks.assignmentFindFirst).toHaveBeenCalledWith({
      where: {
        id: "task-from-org-b",
        assignedToId: "user-a",
        organizationId: "org-a",
        siteId: "site-a",
      },
    });
    expect(mocks.assignmentUpdateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a stale employee write instead of overwriting a concurrent manager change", async () => {
    const updatedAt = new Date("2026-08-28T12:00:00Z");
    mocks.assignmentFindFirst.mockResolvedValue({
      id: "task-a",
      assignedToId: "user-a",
      organizationId: "org-a",
      siteId: "site-a",
      status: "OPEN",
      updatedAt,
    });
    mocks.assignmentUpdateMany.mockResolvedValue({ count: 0 });
    const app = await testApp();
    const response = await app.inject({ method: "PATCH", url: "/api/tasks/task-a", payload: { status: "COMPLETED" } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("changed while you were editing");
    expect(mocks.assignmentUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "task-a", updatedAt }),
    }));
    expect(mocks.eventCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it("scopes manager assignment lookup to the manager's organization and site", async () => {
    mocks.membershipFindUnique.mockResolvedValue({ role: "MANAGER", isActive: true });
    mocks.assignmentFindFirst.mockResolvedValue(null);
    const app = await testApp();
    const response = await app.inject({ method: "PATCH", url: "/api/tasks/assignments/task-from-org-b", payload: { status: "OPEN" } });
    expect(response.statusCode).toBe(404);
    expect(mocks.assignmentFindFirst).toHaveBeenCalledWith({
      where: { id: "task-from-org-b", organizationId: "org-a", siteId: "site-a" },
    });
    await app.close();
  });
});
