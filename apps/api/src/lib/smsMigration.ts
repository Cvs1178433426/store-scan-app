export function isSmsEnrollmentRequired(
  phoneVerifiedAt: Date | null | undefined,
  environment: Record<string, string | undefined> = process.env,
  now = Date.now(),
): boolean {
  if (environment.SMS_MFA_ENABLED !== "true" || phoneVerifiedAt) return false;
  const configured = environment.SMS_MFA_MIGRATION_DEADLINE?.trim();
  if (!configured) return false;
  const deadline = Date.parse(configured);
  return Number.isFinite(deadline) && now >= deadline;
}
