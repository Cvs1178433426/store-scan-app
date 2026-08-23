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

export function enqueueCountScan(entry: Omit<QueuedCountScan, "id" | "queuedAt">): void {
  saveCountQueue([...getCountQueue(), { id: newId(), queuedAt: Date.now(), ...entry }]);
}

export function removeFromCountQueue(id: string): void {
  saveCountQueue(getCountQueue().filter((entry) => entry.id !== id));
}

export function clearCountQueueForSession(sessionId: string): void {
  saveCountQueue(getCountQueue().filter((entry) => entry.sessionId !== sessionId));
}
