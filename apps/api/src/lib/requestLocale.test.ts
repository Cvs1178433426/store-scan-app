import { describe, expect, it } from "vitest";
import { requestLocaleFromHeaders } from "./requestLocale.js";

describe("requestLocaleFromHeaders", () => {
  it("defaults to English when X-Locale is missing", () => {
    expect(requestLocaleFromHeaders({})).toBe("en");
  });

  it("keeps explicit English", () => {
    expect(requestLocaleFromHeaders({ "x-locale": "en" })).toBe("en");
  });

  it("honors explicit Korean", () => {
    expect(requestLocaleFromHeaders({ "x-locale": "ko" })).toBe("ko");
  });

  it("falls back to English for malformed locale values", () => {
    expect(requestLocaleFromHeaders({ "x-locale": "fr" })).toBe("en");
  });
});
