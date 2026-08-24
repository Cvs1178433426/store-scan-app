const QUEUE_KEY = "store_scan_count_queue";

export interface QueuedCountScan {
  id: string;
  sessionId: string;
  locationId: string;
  barcodeValue: string;
  quantityDelta: number;
  queuedAt: number;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createCountScanId(): string {
  return newId();
}

export function getCountQueue(): QueuedCountScan[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveCountQueue(queue: QueuedCountScan[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function enqueueCountScan(
  entry: Omit<QueuedCountScan, "id" | "queuedAt">,
  id: string = newId(),
): string {
  const queue = getCountQueue();
  // A physical scan owns one stable clientScanId for its entire lifecycle.
  // If the same failed attempt reaches enqueue more than once, keep one local
  // record rather than creating duplicate retry work. The server enforces the
  // same idempotency key independently, so this is defense in depth.
  if (!queue.some((queued) => queued.id === id)) {
    saveCountQueue([...queue, { id, queuedAt: Date.now(), ...entry }]);
  }
  return id;
}

export function removeFromCountQueue(id: string): void {
  saveCountQueue(getCountQueue().filter((entry) => entry.id !== id));
}

export function clearCountQueueForSession(sessionId: string): void {
  saveCountQueue(getCountQueue().filter((entry) => entry.sessionId !== sessionId));
}
