const QUEUE_KEY = "store_scan_count_queue";

export type QueuedCountScanStatus = "pending" | "failed";

export interface QueuedCountScan {
  id: string;
  sessionId: string;
  locationId: string;
  barcodeValue: string;
  quantityDelta: number;
  queuedAt: number;
  status: QueuedCountScanStatus;
  failureReason?: string;
  failedAt?: number;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createCountScanId(): string {
  return newId();
}

function normalizeQueuedScan(value: unknown): QueuedCountScan | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<QueuedCountScan>;
  if (
    typeof row.id !== "string" ||
    typeof row.sessionId !== "string" ||
    typeof row.locationId !== "string" ||
    typeof row.barcodeValue !== "string" ||
    typeof row.quantityDelta !== "number" ||
    typeof row.queuedAt !== "number"
  ) return null;

  return {
    id: row.id,
    sessionId: row.sessionId,
    locationId: row.locationId,
    barcodeValue: row.barcodeValue,
    quantityDelta: row.quantityDelta,
    queuedAt: row.queuedAt,
    status: row.status === "failed" ? "failed" : "pending",
    failureReason: typeof row.failureReason === "string" ? row.failureReason : undefined,
    failedAt: typeof row.failedAt === "number" ? row.failedAt : undefined,
  };
}

export function getCountQueue(): QueuedCountScan[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeQueuedScan).filter((row): row is QueuedCountScan => Boolean(row));
  } catch {
    return [];
  }
}

export function getPendingCountQueue(): QueuedCountScan[] {
  return getCountQueue().filter((entry) => entry.status === "pending");
}

export function getFailedCountQueue(): QueuedCountScan[] {
  return getCountQueue().filter((entry) => entry.status === "failed");
}

function saveCountQueue(queue: QueuedCountScan[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function enqueueCountScan(
  entry: Omit<QueuedCountScan, "id" | "queuedAt" | "status" | "failureReason" | "failedAt">,
  id: string = newId(),
): string {
  const queue = getCountQueue();
  // A physical scan owns one stable clientScanId for its entire lifecycle.
  // If the same failed attempt reaches enqueue more than once, keep one local
  // record rather than creating duplicate retry work. The server enforces the
  // same idempotency key independently, so this is defense in depth.
  if (!queue.some((queued) => queued.id === id)) {
    saveCountQueue([...queue, { id, queuedAt: Date.now(), status: "pending", ...entry }]);
  }
  return id;
}

export function markCountScanFailed(id: string, reason: string): void {
  saveCountQueue(getCountQueue().map((entry) => entry.id === id
    ? { ...entry, status: "failed", failureReason: reason, failedAt: Date.now() }
    : entry));
}

export function retryFailedCountScan(id: string): void {
  saveCountQueue(getCountQueue().map((entry) => entry.id === id
    ? { ...entry, status: "pending", failureReason: undefined, failedAt: undefined }
    : entry));
}

export function removeFromCountQueue(id: string): void {
  saveCountQueue(getCountQueue().filter((entry) => entry.id !== id));
}

export function clearCountQueueForSession(sessionId: string): void {
  saveCountQueue(getCountQueue().filter((entry) => entry.sessionId !== sessionId));
}
