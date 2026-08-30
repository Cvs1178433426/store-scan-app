import type { JobTitle } from "@prisma/client";

export type TaskSnapshotTemplate = {
  id: string;
  organizationId: string;
  siteId: string | null;
  jobTitle: JobTitle;
  title: string;
  instructions: string | null;
  recurrence: "ONCE" | "DAILY" | "WEEKLY" | "MONTHLY";
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  rolloverPolicy: "REMAIN_OVERDUE" | "ROLL_FORWARD" | "SKIP";
  dueTime: string | null;
};

export function taskSnapshotData(
  template: TaskSnapshotTemplate,
  fallbackSiteId: string,
  assignedToId: string,
  scheduledDate: Date,
  dueAt: Date | null,
) {
  return {
    templateId: template.id,
    organizationId: template.organizationId,
    siteId: template.siteId ?? fallbackSiteId,
    assignedToId,
    jobTitle: template.jobTitle,
    title: template.title,
    instructions: template.instructions,
    recurrence: template.recurrence,
    scheduledDate,
    dueAt,
    priority: template.priority,
    rolloverPolicy: template.rolloverPolicy,
  };
}

export function isScheduledBefore(value: Date, boundary: Date): boolean {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
    < Date.UTC(boundary.getUTCFullYear(), boundary.getUTCMonth(), boundary.getUTCDate());
}

export type ReportPeriod = "DAILY" | "WEEKLY" | "MONTHLY";

export function reportDateRange(period: ReportPeriod, anchor: Date): { start: Date; end: Date } {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  const d = anchor.getUTCDate();
  if (period === "DAILY") {
    const day = new Date(Date.UTC(y, m, d));
    return { start: day, end: day };
  }
  if (period === "MONTHLY") {
    return {
      start: new Date(Date.UTC(y, m, 1)),
      end: new Date(Date.UTC(y, m + 1, 0)),
    };
  }
  const weekday = anchor.getUTCDay();
  const daysFromMonday = (weekday + 6) % 7;
  const start = new Date(Date.UTC(y, m, d - daysFromMonday));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 6));
  return { start, end };
}

export function taskEventAction(fromStatus: string, toStatus: string): string {
  if (fromStatus === toStatus) return "NOTE_UPDATED";
  if (fromStatus === "COMPLETED" && toStatus !== "COMPLETED") return "REOPENED";
  if (toStatus === "COMPLETED") return "COMPLETED";
  if (toStatus === "SKIPPED") return "SKIPPED";
  if (toStatus === "CANCELLED") return "CANCELLED";
  return "STATUS_CHANGED";
}
