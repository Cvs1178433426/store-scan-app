function resolveApiUrl(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;
  return "http://localhost:8080";
}

export const API_URL = resolveApiUrl();

const TOKEN_KEY = "continuixai_token";
const LOCALE_KEY = "continuixai_locale";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

function currentLocale(): "en" | "ko" {
  if (typeof window === "undefined") return "en";
  return localStorage.getItem(LOCALE_KEY) === "ko" ? "ko" : "en";
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;
  if (init.body && !headers.has("Content-Type") && !isFormData) {
    headers.set("Content-Type", "application/json");
  }
  // Continuixai Ops is English by default. Always send an explicit locale so a fresh device cannot
  // accidentally inherit a server-side legacy locale fallback before localStorage is initialized.
  headers.set("X-Locale", currentLocale());
  return fetch(`${API_URL}${path}`, { ...init, headers, cache: "no-store" });
}

function requestFailedMessage(status: number): string {
  return currentLocale() === "ko" ? `요청 실패 (${status})` : `Request failed (${status})`;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message =
      typeof body?.error === "string" ? body.error : body?.error ? JSON.stringify(body.error) : requestFailedMessage(res.status);
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}
