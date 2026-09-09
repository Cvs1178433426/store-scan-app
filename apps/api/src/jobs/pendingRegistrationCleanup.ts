import cron from "node-cron";
import { PrismaRegistrationRepository } from "../lib/registrationService.js";

const PENDING_REGISTRATION_RETENTION_MS = 24 * 60 * 60 * 1_000;

type PendingRegistrationCleanupRepository = Pick<
  PrismaRegistrationRepository,
  "expiredCandidates" | "deleteExpiredCandidates"
>;

export async function cleanupPendingRegistrations(
  repository: PendingRegistrationCleanupRepository = new PrismaRegistrationRepository(),
  now = new Date(),
): Promise<void> {
  const cutoff = new Date(now.getTime() - PENDING_REGISTRATION_RETENTION_MS);
  const candidates = await repository.expiredCandidates(cutoff);
  await repository.deleteExpiredCandidates(candidates);
}

export function startPendingRegistrationCleanupJob(): void {
  const run = () => cleanupPendingRegistrations()
    .catch((error) => console.error("[pending-registration-cleanup] run failed", error));
  void run();
  cron.schedule("0 * * * *", run);
}
