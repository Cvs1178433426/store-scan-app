import cron from "node-cron";
import { PrismaPhoneRecoveryRepository, type PhoneRecoveryRepository } from "../lib/phoneRecoveryRepository.js";

type PhoneRecoveryCleanupRepository = Pick<PhoneRecoveryRepository, "expireOpenCases">;

export async function cleanupExpiredPhoneRecoveries(
  repository: PhoneRecoveryCleanupRepository = new PrismaPhoneRecoveryRepository(),
  now = new Date(),
): Promise<number> {
  return repository.expireOpenCases(now);
}

export function startPhoneRecoveryCleanupJob(): void {
  const run = () => cleanupExpiredPhoneRecoveries()
    .catch((error) => console.error("[phone-recovery-cleanup] run failed", error instanceof Error ? error.name : "unknown"));
  void run();
  cron.schedule("7 * * * *", run);
}
