import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ensurePilotSiteForUser } from "../lib/pilotSite.js";
import { canManageTasks, dateOnly, dueAtForDate, isTemplateDue } from "../lib/taskSchedule.js";

const jobTitleSchema = z.enum([
  "STORE_MANAGER",
  "INVENTORY_MANAGER",
  "STOCK_COUNT_ASSOCIATE",
  "RECEIVER",
  "CASHIER_CUSTOMER_SERVICE",
  "PHARMACY_TEAM",
]);
const recurrenceSchema = z.enum(["ONCE", "DAILY", "WEEKLY", "MONTHLY"]);
const prioritySchema = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]);
const rolloverSchema = z.enum(["REMAIN_OVERDUE", "ROLL_FORWARD", "SKIP"]);
const employeeStatusSchema = z.enum(["OPEN", "IN_PROGRESS", "COMPLETED"]);

const templateInputSchema = z.object({
  jobTitle: jobTitleSchema,
  title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().max(2000).nullable().optional(),
  recurrence: recurrenceSchema,
  startDate: z.string(),
  endDate: z.string().nullable().optional(),
  weeklyDay: z.number().int().min(0).max(6).nullable().optional(),
  monthlyDay: z.number().int().min(1).max(31).nullable().optional(),
  dueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  priority: prioritySchema.default("NORMAL"),
  rolloverPolicy: rolloverSchema.default("REMAIN_OVERDUE"),
}).superRefine((value, ctx) => {
  if (!dateOnly(value.startDate)) ctx.addIssue({ code: "custom", path: ["startDate"], message: "Start date must be YYYY-MM-DD." });
  if (value.endDate && !dateOnly(value.endDate)) ctx.addIssue({ code: "custom", path: ["endDate"], message: "End date must be YYYY-MM-DD." });
  if (value.recurrence === "WEEKLY" && value.weeklyDay == null) ctx.addIssue({ code: "custom", path: ["weeklyDay"], message: "Weekly tasks require a weekday." });
  if (value.recurrence === "MONTHLY" && value.monthlyDay == null) ctx.addIssue({ code: "custom", path: ["monthlyDay"], message: "Monthly tasks require a day of month." });
});

const assignmentUpdateSchema = z.object({
  status: employeeStatusSchema.optional(),
  employeeNote: z.string().trim().max(2000).nullable().optional(),
});

type TaskContext = {
  site: { id: string; organizationId: string; timeZone: string };
  platformRole: string;
  membershipRole: string;
};

async function taskContext(userId: string, platformRole: string): Promise<TaskContext | null> {
  const site = await ensurePilotSiteForUser(userId, platformRole);
  if (!site) return null;
  const membership = await prisma.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: site.organizationId, userId } },
    select: { role: true, isActive: true },
  });
  if (!membership?.isActive) return null;
  return { site, platformRole, membershipRole: membership.role };
}

async function generateAssignmentsForUser(userId: string, context: TaskContext, scheduledDate: Date) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { jobTitle: true, isActive: true } });
  if (!user?.isActive || !user.jobTitle) return;

  const templates = await prisma.taskTemplate.findMany({
    where: {
      organizationId: context.site.organizationId,
      OR: [{ siteId: null }, { siteId: context.site.id }],
      jobTitle: user.jobTitle,
      isActive: true,
    },
  });
  const due = templates.filter((template) => isTemplateDue(template, scheduledDate));
  if (!due.length) return;

  await prisma.taskAssignment.createMany({
    data: due.map((template) => ({
      templateId: template.id,
      organizationId: template.organizationId,
      siteId: template.siteId ?? context.site.id,
      assignedToId: userId,
      title: template.title,
      instructions: template.instructions,
      scheduledDate,
      dueAt: dueAtForDate(scheduledDate, template.dueTime, context.site.timeZone),
      priority: template.priority,
    })),
    skipDuplicates: true,
  });
}

export async function taskRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/me", async (request, reply) => {
    const query = z.object({ date: z.string().optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    const scheduledDate = dateOnly(query.data.date ?? new Date().toISOString().slice(0, 10));
    if (!scheduledDate) return reply.code(400).send({ error: "Date must be YYYY-MM-DD." });
    const context = await taskContext(request.user.sub, request.user.role ?? "");
    if (!context) return reply.code(403).send({ error: "No authorized task site is available." });

    await generateAssignmentsForUser(request.user.sub, context, scheduledDate);
    const assignments = await prisma.taskAssignment.findMany({
      where: {
        assignedToId: request.user.sub,
        organizationId: context.site.organizationId,
        siteId: context.site.id,
        OR: [
          { scheduledDate: { lte: scheduledDate }, status: { in: ["OPEN", "IN_PROGRESS"] } },
          { scheduledDate, status: { in: ["COMPLETED", "SKIPPED"] } },
        ],
      },
      orderBy: [{ status: "asc" }, { priority: "desc" }, { dueAt: "asc" }, { createdAt: "asc" }],
    });
    return { date: scheduledDate.toISOString().slice(0, 10), assignments };
  });

  app.patch("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = assignmentUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const assignment = await prisma.taskAssignment.findFirst({ where: { id, assignedToId: request.user.sub } });
    if (!assignment) return reply.code(404).send({ error: "Task not found." });
    if (assignment.status === "CANCELLED") return reply.code(409).send({ error: "Cancelled tasks cannot be changed." });

    const status = parsed.data.status ?? assignment.status;
    return prisma.taskAssignment.update({
      where: { id },
      data: {
        status,
        employeeNote: parsed.data.employeeNote,
        completedAt: status === "COMPLETED" ? new Date() : null,
        completedById: status === "COMPLETED" ? request.user.sub : null,
      },
    });
  });

  app.get("/templates", async (request, reply) => {
    const context = await taskContext(request.user.sub, request.user.role ?? "");
    if (!context || !canManageTasks(context.platformRole, context.membershipRole)) return reply.code(403).send({ error: "Manager access required." });
    return prisma.taskTemplate.findMany({
      where: { organizationId: context.site.organizationId, OR: [{ siteId: null }, { siteId: context.site.id }] },
      orderBy: [{ jobTitle: "asc" }, { priority: "desc" }, { title: "asc" }],
    });
  });

  app.post("/templates", async (request, reply) => {
    const parsed = templateInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const context = await taskContext(request.user.sub, request.user.role ?? "");
    if (!context || !canManageTasks(context.platformRole, context.membershipRole)) return reply.code(403).send({ error: "Manager access required." });
    const startDate = dateOnly(parsed.data.startDate)!;
    const endDate = parsed.data.endDate ? dateOnly(parsed.data.endDate) : null;
    if (endDate && endDate < startDate) return reply.code(400).send({ error: "End date cannot be before start date." });

    const template = await prisma.taskTemplate.create({
      data: {
        organizationId: context.site.organizationId,
        siteId: context.site.id,
        jobTitle: parsed.data.jobTitle,
        title: parsed.data.title,
        instructions: parsed.data.instructions,
        recurrence: parsed.data.recurrence,
        startDate,
        endDate,
        weeklyDay: parsed.data.recurrence === "WEEKLY" ? parsed.data.weeklyDay : null,
        monthlyDay: parsed.data.recurrence === "MONTHLY" ? parsed.data.monthlyDay : null,
        dueTime: parsed.data.dueTime,
        priority: parsed.data.priority,
        rolloverPolicy: parsed.data.rolloverPolicy,
        createdById: request.user.sub,
        updatedById: request.user.sub,
      },
    });
    return reply.code(201).send(template);
  });

  app.patch("/users/:id/job-title", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z.object({ jobTitle: jobTitleSchema.nullable() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const context = await taskContext(request.user.sub, request.user.role ?? "");
    if (!context || !canManageTasks(context.platformRole, context.membershipRole)) return reply.code(403).send({ error: "Manager access required." });
    const target = await prisma.organizationMembership.findUnique({
      where: { organizationId_userId: { organizationId: context.site.organizationId, userId: id } },
      select: { user: { select: { id: true, isActive: true } }, isActive: true },
    });
    if (!target?.isActive || !target.user.isActive) return reply.code(404).send({ error: "Active employee not found." });
    const user = await prisma.user.update({ where: { id }, data: { jobTitle: parsed.data.jobTitle }, select: { id: true, name: true, employeeNumber: true, jobTitle: true } });
    return user;
  });
}
