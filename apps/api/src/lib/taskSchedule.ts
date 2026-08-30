export type Recurrence = "ONCE" | "DAILY" | "WEEKLY" | "MONTHLY";

export type ScheduleTemplate = {
  recurrence: Recurrence;
  startDate: Date;
  endDate: Date | null;
  weeklyDay: number | null;
  monthlyDay: number | null;
};

export function dateOnly(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : parsed;
}

export function isTemplateDue(template: ScheduleTemplate, scheduledDate: Date): boolean {
  const day = Date.UTC(scheduledDate.getUTCFullYear(), scheduledDate.getUTCMonth(), scheduledDate.getUTCDate());
  const start = Date.UTC(template.startDate.getUTCFullYear(), template.startDate.getUTCMonth(), template.startDate.getUTCDate());
  const end = template.endDate
    ? Date.UTC(template.endDate.getUTCFullYear(), template.endDate.getUTCMonth(), template.endDate.getUTCDate())
    : null;

  if (day < start || (end !== null && day > end)) return false;
  if (template.recurrence === "ONCE") return day === start;
  if (template.recurrence === "DAILY") return true;
  if (template.recurrence === "WEEKLY") return template.weeklyDay === scheduledDate.getUTCDay();
  if (template.monthlyDay == null) return false;
  const lastDayOfMonth = new Date(Date.UTC(
    scheduledDate.getUTCFullYear(), scheduledDate.getUTCMonth() + 1, 0,
  )).getUTCDate();
  return Math.min(template.monthlyDay, lastDayOfMonth) === scheduledDate.getUTCDate();
}

export function localDateInTimeZone(now: Date, timeZone: string): Date | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return dateOnly(`${values.year}-${values.month}-${values.day}`);
  } catch {
    return null;
  }
}

function timeZoneOffsetMillis(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const representedAsUtc = Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second),
  );
  return representedAsUtc - instant.getTime();
}

export function dueAtForDate(scheduledDate: Date, dueTime: string | null, timeZone = "UTC"): Date | null {
  if (!dueTime) return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(dueTime);
  if (!match) return null;
  const localAsUtc = Date.UTC(
    scheduledDate.getUTCFullYear(),
    scheduledDate.getUTCMonth(),
    scheduledDate.getUTCDate(),
    Number(match[1]),
    Number(match[2]),
  );
  try {
    let instant = new Date(localAsUtc);
    instant = new Date(localAsUtc - timeZoneOffsetMillis(instant, timeZone));
    instant = new Date(localAsUtc - timeZoneOffsetMillis(instant, timeZone));

    // A DST spring-forward can make a requested wall-clock time nonexistent.
    // Validate the round trip so 02:30 never silently turns into 01:30/03:30.
    const rendered = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    const parts = Object.fromEntries(rendered.map((part) => [part.type, part.value]));
    if (
      Number(parts.year) !== scheduledDate.getUTCFullYear() ||
      Number(parts.month) !== scheduledDate.getUTCMonth() + 1 ||
      Number(parts.day) !== scheduledDate.getUTCDate() ||
      Number(parts.hour) !== Number(match[1]) ||
      Number(parts.minute) !== Number(match[2])
    ) return null;
    return instant;
  } catch {
    return null;
  }
}

export function canManageTasks(platformRole: string, membershipRole: string | null | undefined): boolean {
  return platformRole === "ADMIN" || membershipRole === "OWNER" || membershipRole === "ADMIN" || membershipRole === "MANAGER";
}
