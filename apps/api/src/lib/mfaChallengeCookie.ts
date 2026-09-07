import type { FastifyReply, FastifyRequest } from "fastify";

const COOKIE_NAME = "continuixai_mfa_challenge";
const PHONE_RECOVERY_COOKIE_NAME = "continuixai_phone_recovery";
const COOKIE_PATH = "/api";

export function setChallengeCookie(reply: FastifyReply, challengeId: string): void {
  reply.setCookie(COOKIE_NAME, challengeId, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: COOKIE_PATH,
    maxAge: 10 * 60,
  });
}

export function readChallengeCookie(request: FastifyRequest): string | null {
  const value = request.cookies[COOKIE_NAME];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function clearChallengeCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, { path: COOKIE_PATH });
}

export function setPhoneRecoveryCookie(reply: FastifyReply, challengeId: string): void {
  reply.setCookie(PHONE_RECOVERY_COOKIE_NAME, challengeId, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/api/auth/phone-recovery",
    maxAge: 10 * 60,
  });
}

export function readPhoneRecoveryCookie(request: FastifyRequest): string | null {
  const value = request.cookies[PHONE_RECOVERY_COOKIE_NAME];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function clearPhoneRecoveryCookie(reply: FastifyReply): void {
  reply.clearCookie(PHONE_RECOVERY_COOKIE_NAME, { path: "/api/auth/phone-recovery" });
}
