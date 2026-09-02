import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, apiJson, ApiError, clearToken, setToken } from "./api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("apiFetch", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, {})));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("attaches the bearer token when logged in", async () => {
    setToken("test-token");
    await apiFetch("/api/items");
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer test-token");
  });

  it("omits the Authorization header when logged out", async () => {
    clearToken();
    await apiFetch("/api/items");
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.headers as Headers).get("Authorization")).toBeNull();
  });

  it("sends the saved locale as X-Locale", async () => {
    localStorage.setItem("continuixai_locale", "en");
    await apiFetch("/api/items");
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.headers as Headers).get("X-Locale")).toBe("en");
  });

  it("defaults a brand-new client to English when no locale is stored", async () => {
    await apiFetch("/api/items");
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.headers as Headers).get("X-Locale")).toBe("en");
  });

  it("still honors an explicitly selected Korean locale", async () => {
    localStorage.setItem("continuixai_locale", "ko");
    await apiFetch("/api/items");
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.headers as Headers).get("X-Locale")).toBe("ko");
  });

  it("does not set Content-Type for FormData bodies", async () => {
    const formData = new FormData();
    formData.append("file", new Blob(["x"]));
    await apiFetch("/api/items/import.csv", { method: "POST", body: formData });
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.headers as Headers).has("Content-Type")).toBe(false);
  });

  it("includes HttpOnly challenge cookies on same-origin auth requests", async () => {
    await apiFetch("/api/auth/mfa/check", { method: "POST", body: JSON.stringify({ code: "123456" }) });

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.credentials).toBe("include");
  });
});

describe("apiJson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed body on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { ok: true })));
    await expect(apiJson("/api/items")).resolves.toEqual({ ok: true });
  });

  it("returns undefined for a 204 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(apiJson("/api/items/1")).resolves.toBeUndefined();
  });

  it("throws an ApiError carrying the status and string error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(409, { error: "이미 등록된 바코드" })));
    const err = await apiJson("/api/items").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toBe("이미 등록된 바코드");
  });

  it("stringifies a structured (zod) error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(400, { error: { fieldErrors: { name: ["Required"] } } })),
    );
    const err = await apiJson("/api/items").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain("Required");
  });

  it("carries the server Retry-After duration without reading challenge material", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Too many verification requests. Please try again later." }),
      { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "30" } },
    )));

    const err = await apiJson("/api/auth/login", { method: "POST" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).retryAfterSeconds).toBe(30);
  });

  it("carries a stable server error code for support-required accounts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(403, {
      error: "This account needs security support before phone enrollment can continue.",
      code: "security_support_required",
    })));

    const err = await apiJson("/api/auth/login", { method: "POST" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("security_support_required");
  });
});
