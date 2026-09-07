import { prisma } from "./prisma.js";

export type AuthoritativeAccessState = {
  tokenVersion: number;
  isActive: boolean;
  accountStatus: string;
  phoneVerifiedAt: Date | null;
};

export async function getAuthoritativeAccessState(userId: string): Promise<AuthoritativeAccessState | null> {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { tokenVersion: true, isActive: true, accountStatus: true, phoneVerifiedAt: true },
  });
}

export async function isCurrentActiveAccess(userId: string, tokenVersion: number): Promise<boolean> {
  const state = await getAuthoritativeAccessState(userId);
  return state !== null
    && state.isActive
    && state.accountStatus === "ACTIVE"
    && state.tokenVersion === tokenVersion;
}

// Compatibility cache for existing non-authorization callers. Protected access decisions must use
// getAuthoritativeAccessState/isCurrentActiveAccess so revocation is authoritative across processes.
const CACHE_TTL_MS = 60_000;

const cache = new Map<string, { version: number; expiresAt: number }>();

export async function getCachedTokenVersion(userId: string): Promise<number | null> {
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > Date.now()) return hit.version;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tokenVersion: true },
  });
  if (!user) {
    cache.delete(userId);
    return null;
  }
  cache.set(userId, { version: user.tokenVersion, expiresAt: Date.now() + CACHE_TTL_MS });
  return user.tokenVersion;
}

export function invalidateTokenVersionCache(userId: string): void {
  cache.delete(userId);
}

export async function bumpTokenVersion(userId: string): Promise<number> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
    select: { tokenVersion: true },
  });
  invalidateTokenVersionCache(userId);
  return user.tokenVersion;
}
