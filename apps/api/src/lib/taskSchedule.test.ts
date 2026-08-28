import { describe, expect, it } from "vitest";
import { canManageTasks, dateOnly, dueAtForDate, isTemplateDue } from "./taskSchedule.js";

const d = (value: string) => new Date(`${value}T00:00:00.000Z`);

describe("task scheduling", () => {
  it("parses strict calendar dates and rejects rollover dates", () => {
    expect(dateOnly("2026-08-28")?.toISOString()).toBe("2026-08-28T00:00:00.000Z");
    expect(dateOnly("2026-02-30")).toBeNull();
    expect(dateOnly("08/28/2026")).toBeNull();
  });

  it("matches one-time, daily, weekly, and monthly schedules", () => {
    const base = { startDate: d("2026-08-01"), endDate: null };
    expect(isTemplateDue({ ...base, recurrence: "ONCE", weeklyDay: null, monthlyDay: null }, d("2026-08-01"))).toBe(true);
    expect(isTemplateDue({ ...base, recurrence: "ONCE", weeklyDay: null, monthlyDay: null }, d("2026-08-02"))).toBe(false);
    expect(isTemplateDue({ ...base, recurrence: "DAILY", weeklyDay: null, monthlyDay: null }, d("2026-08-28"))).toBe(true);
    expect(isTemplateDue({ ...base, recurrence: "WEEKLY", weeklyDay: 5, monthlyDay: null }, d("2026-08-28"))).toBe(true);
    expect(isTemplateDue({ ...base, recurrence: "MONTHLY", weeklyDay: null, monthlyDay: 28 }, d("2026-08-28"))).toBe(true);
  });

  it("honors start and end boundaries", () => {
    const template = { recurrence: "DAILY" as const, startDate: d("2026-08-10"), endDate: d("2026-08-20"), weeklyDay: null, monthlyDay: null };
    expect(isTemplateDue(template, d("2026-08-09"))).toBe(false);
    expect(isTemplateDue(template, d("2026-08-20"))).toBe(true);
    expect(isTemplateDue(template, d("2026-08-21"))).toBe(false);
  });

  it("creates a deterministic UTC due time", () => {
    expect(dueAtForDate(d("2026-08-28"), "16:30")?.toISOString()).toBe("2026-08-28T16:30:00.000Z");
    expect(dueAtForDate(d("2026-08-28"), "16:30", "America/New_York")?.toISOString()).toBe("2026-08-28T20:30:00.000Z");
    expect(dueAtForDate(d("2026-08-28"), "25:00")).toBeNull();
    expect(dueAtForDate(d("2026-08-28"), "16:30", "Not/AZone")).toBeNull();
  });

  it("limits task management to platform admins and organization management roles", () => {
    expect(canManageTasks("ADMIN", "VIEWER")).toBe(true);
    expect(canManageTasks("GENERAL", "OWNER")).toBe(true);
    expect(canManageTasks("GENERAL", "MANAGER")).toBe(true);
    expect(canManageTasks("GENERAL", "INVENTORY")).toBe(false);
  });
});
