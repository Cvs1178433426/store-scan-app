export const RESEND_COOLDOWN_SECONDS = 30;
export const LOCKOUT_MESSAGE = "Too many verification attempts. Please try again in 15 minutes.";

export type AuthEntry = "phone" | "password" | "email";
export type VerificationMethod = "SMS" | "TOTP" | "RECOVERY_CODE";
export type AuthFlowProblem = "invalid_code" | "expired" | "locked" | "outage" | null;

export type AuthFlowState = {
  step: "entry" | "verification" | "complete";
  entry: AuthEntry;
  method: VerificationMethod;
  maskedDestination: string | null;
  resendAvailableAt: number | null;
  lockedUntil: number | null;
  problem: AuthFlowProblem;
};

export type AuthFlowEvent =
  | { type: "CODE_SENT"; method?: VerificationMethod; maskedDestination?: string; now: number }
  | { type: "CODE_REJECTED" }
  | { type: "CHALLENGE_EXPIRED" }
  | { type: "LOCKED"; retryAfterSeconds: number; now: number }
  | { type: "RETRY_AFTER"; retryAfterSeconds: number; now: number }
  | { type: "PROVIDER_OUTAGE" }
  | { type: "VERIFIED" }
  | { type: "METHOD_SELECTED"; method: VerificationMethod }
  | { type: "RESTART" };

export function createAuthFlow(entry: AuthEntry): AuthFlowState {
  return {
    step: "entry",
    entry,
    method: "SMS",
    maskedDestination: null,
    resendAvailableAt: null,
    lockedUntil: null,
    problem: null,
  };
}

export function remainingSeconds(until: number | null, now: number): number {
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1_000));
}

export function formatWaitTime(seconds: number): string {
  const safeSeconds = Math.max(1, Math.ceil(seconds));
  if (safeSeconds < 60) return `${safeSeconds} ${safeSeconds === 1 ? "second" : "seconds"}`;
  const minutes = Math.ceil(safeSeconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export function normalizeVerificationCode(value: string, method: VerificationMethod): string {
  if (method === "RECOVERY_CODE") return value.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 10);
  return value.replace(/\D/g, "").slice(0, 6);
}

export function reduceAuthFlow(state: AuthFlowState, event: AuthFlowEvent): AuthFlowState {
  switch (event.type) {
    case "CODE_SENT":
      return {
        ...state,
        step: "verification",
        method: event.method ?? "SMS",
        maskedDestination: event.maskedDestination ?? null,
        resendAvailableAt: event.now + RESEND_COOLDOWN_SECONDS * 1_000,
        lockedUntil: null,
        problem: null,
      };
    case "CODE_REJECTED":
      return { ...state, problem: "invalid_code" };
    case "CHALLENGE_EXPIRED":
      return { ...state, problem: "expired" };
    case "LOCKED":
      return {
        ...state,
        problem: "locked",
        lockedUntil: event.now + event.retryAfterSeconds * 1_000,
      };
    case "RETRY_AFTER":
      return {
        ...state,
        resendAvailableAt: event.now + event.retryAfterSeconds * 1_000,
        problem: null,
      };
    case "PROVIDER_OUTAGE":
      return { ...state, problem: "outage" };
    case "VERIFIED":
      return { ...state, step: "complete", problem: null };
    case "METHOD_SELECTED":
      return {
        ...state,
        method: event.method,
        maskedDestination: event.method === "SMS" ? state.maskedDestination : null,
        resendAvailableAt: event.method === "SMS" ? state.resendAvailableAt : null,
        lockedUntil: null,
        problem: null,
      };
    case "RESTART":
      return createAuthFlow(state.entry);
  }
}
