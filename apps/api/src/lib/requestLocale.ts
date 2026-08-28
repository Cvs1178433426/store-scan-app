import type { FastifyRequest } from "fastify";
import type { ApiLocale } from "./i18n.js";

export function requestLocaleFromHeaders(headers: FastifyRequest["headers"]): ApiLocale {
  const header = headers["x-locale"];
  const value = Array.isArray(header) ? header[0] : header;
  return value === "ko" ? "ko" : "en";
}
