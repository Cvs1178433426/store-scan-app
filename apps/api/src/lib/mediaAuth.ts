import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAuthoritativeAccessState } from "./tokenVersion.js";
import { isSmsEnrollmentRequired } from "./smsMigration.js";

export const MEDIA_COOKIE_NAME = "continuixai_media";
/**
 * 미디어 쿠키 수명 — /api/auth/me가 앱 부팅마다 갱신하므로 24h로 둬도 된다.
 * (JWT 7d와 별개; me가 쿠키를 슬라이딩 갱신한다.)
 */
export const MEDIA_TOKEN_EXPIRES = "24h";
const MEDIA_COOKIE_MAX_AGE_SEC = 60 * 60 * 24;

export function mediaCookieOptions() {
  return {
    path: "/api/attachments/file",
    httpOnly: true,
    sameSite: "lax" as const,
    // Proxmox 기본 배포가 HTTP라 무조건 secure를 켜면 기본 설치에서 사진이 안 뜬다.
    // HTTPS면 compose에 COOKIE_SECURE=true를 넘긴다.
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: MEDIA_COOKIE_MAX_AGE_SEC,
  };
}

export function clearMediaCookieOptions() {
  return {
    path: "/api/attachments/file",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.COOKIE_SECURE === "true",
  };
}

export function signMediaToken(app: FastifyInstance, userId: string, tokenVersion: number): string {
  return app.jwt.sign({ sub: userId, purpose: "media", tv: tokenVersion }, { expiresIn: MEDIA_TOKEN_EXPIRES });
}

export function setMediaCookie(app: FastifyInstance, reply: FastifyReply, userId: string, tokenVersion: number): void {
  reply.setCookie(MEDIA_COOKIE_NAME, signMediaToken(app, userId, tokenVersion), mediaCookieOptions());
}

export function clearMediaCookie(reply: FastifyReply): void {
  reply.clearCookie(MEDIA_COOKIE_NAME, clearMediaCookieOptions());
}

async function hasCurrentMediaAccess(userId: string, tokenVersion: number): Promise<boolean> {
  const state = await getAuthoritativeAccessState(userId);
  return state !== null
    && state.isActive
    && state.accountStatus === "ACTIVE"
    && state.tokenVersion === tokenVersion
    && !isSmsEnrollmentRequired(state.phoneVerifiedAt);
}

/**
 * 첨부 파일 라우트 인증.
 * continuixai_media 쿠키(purpose:media) 또는 Authorization Bearer(일반 API 토큰) 필수.
 */
export async function requireMediaAccess(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const cookieToken = request.cookies?.[MEDIA_COOKIE_NAME];
  if (typeof cookieToken === "string" && cookieToken.length > 0) {
    try {
      const decoded = app.jwt.verify<{ sub?: unknown; purpose?: unknown; tv?: unknown }>(cookieToken);
      if (
        decoded.purpose === "media"
        && typeof decoded.sub === "string"
        && decoded.sub.length > 0
        && typeof decoded.tv === "number"
        && await hasCurrentMediaAccess(decoded.sub, decoded.tv)
      ) return true;
    } catch {
      // fall through
    }
  }

  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    try {
      const decoded = app.jwt.verify<{ sub?: unknown; purpose?: unknown; tv?: unknown }>(auth.slice("Bearer ".length));
      const validPurpose = decoded.purpose === undefined || decoded.purpose === "media";
      if (
        validPurpose
        && typeof decoded.sub === "string"
        && decoded.sub.length > 0
        && typeof decoded.tv === "number"
        && await hasCurrentMediaAccess(decoded.sub, decoded.tv)
      ) return true;
    } catch {
      // fall through
    }
  }

  reply.code(401).send({ error: "unauthorized" });
  return false;
}
