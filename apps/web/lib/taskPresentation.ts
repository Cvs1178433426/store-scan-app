export type PresentableTask = {
  id: string;
  title: string;
  instructions?: string | null;
  status: string;
  scheduledDate: string;
  completedAt?: string | null;
  priority: string;
  dueAt?: string | null;
};

const PRIORITY_ORDER: Record<string, number> = { URGENT: 4, HIGH: 3, NORMAL: 2, LOW: 1 };

export function greetingForHour(hour: number, firstName: string): string {
  if (hour < 12) return `Good morning, ${firstName}!`;
  if (hour < 17) return `Good afternoon, ${firstName}!`;
  return `Good evening, ${firstName}!`;
}

export function greetingForTimeZone(name: string, now: Date, timeZone: string): string {
  const firstName = name.trim().split(/\s+/)[0] || name;
  try {
    const hour = Number(new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now));
    return greetingForHour(hour, firstName);
  } catch {
    return greetingForHour(now.getHours(), firstName);
  }
}

function dateKey(value: string): string {
  return value.slice(0, 10);
}

function taskSort(a: PresentableTask, b: PresentableTask): number {
  const priorityDelta = (PRIORITY_ORDER[b.priority] ?? 0) - (PRIORITY_ORDER[a.priority] ?? 0);
  if (priorityDelta) return priorityDelta;
  if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt);
  if (a.dueAt) return -1;
  if (b.dueAt) return 1;
  return a.title.localeCompare(b.title);
}

export function groupAssignments<T extends PresentableTask>(assignments: T[], today: string) {
  const overdue: T[] = [];
  const current: T[] = [];
  const thisWeek: T[] = [];
  const completedToday: T[] = [];
  const skippedToday: T[] = [];
  const todayDate = new Date(`${today}T00:00:00.000Z`);
  const weekEnd = new Date(Date.UTC(todayDate.getUTCFullYear(), todayDate.getUTCMonth(), todayDate.getUTCDate() + 6)).toISOString().slice(0, 10);

  for (const task of assignments) {
    const scheduled = dateKey(task.scheduledDate);
    if (task.status === "COMPLETED") {
      // The API only returns completions inside the site-local day window.
      // Do not reinterpret completedAt in UTC here or late local completions disappear.
      completedToday.push(task);
      continue;
    }
    if (task.status === "SKIPPED") {
      skippedToday.push(task);
      continue;
    }
    if (task.status !== "OPEN" && task.status !== "IN_PROGRESS") continue;
    if (scheduled < today) overdue.push(task);
    else if (scheduled === today) current.push(task);
    else if (scheduled <= weekEnd) thisWeek.push(task);
  }
  overdue.sort(taskSort);
  current.sort(taskSort);
  thisWeek.sort((a, b) => dateKey(a.scheduledDate).localeCompare(dateKey(b.scheduledDate)) || taskSort(a, b));
  completedToday.sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""));
  skippedToday.sort(taskSort);
  return { overdue, today: current, thisWeek, completedToday, skippedToday };
}

export function isCountTask(task: Pick<PresentableTask, "title" | "instructions">): boolean {
  const text = `${task.title} ${task.instructions ?? ""}`.toLowerCase();
  return /\b(store\s+scan|store\s+count|inventory\s+count|cycle\s+count|recount)\b/.test(text);
}

export function countTaskActionLabel(_task: Pick<PresentableTask, "title" | "instructions">): string {
  return "Start Count";
}

export function humanizeEnum(value: string | null | undefined): string {
  if (!value) return "—";
  return value.toLowerCase().split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
