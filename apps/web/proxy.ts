import { NextResponse, type NextRequest } from "next/server";

const LEGACY_PATHS = [
  "/audit",
  "/backup",
  "/categories",
  "/history",
  "/insights",
  "/items",
  "/labels",
  "/locations",
  "/scan",
  "/shopping",
  "/store-categories",
  "/trash",
  "/users",
  "/settings/integrations",
];

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (LEGACY_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return NextResponse.redirect(new URL("/my-work", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
