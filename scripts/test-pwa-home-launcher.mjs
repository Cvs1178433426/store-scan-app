import fs from "node:fs";

const home = fs.readFileSync(new URL("../apps/web/app/page.tsx", import.meta.url), "utf8");
const login = fs.readFileSync(new URL("../apps/web/app/login/page.tsx", import.meta.url), "utf8");
const manifest = fs.readFileSync(new URL("../apps/web/app/manifest.ts", import.meta.url), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(!home.includes('redirect("/my-work")'), "Home must not redirect directly to My Work");
for (const route of ["/store-count", "/my-work", "/store-products", "/store-locations"]) {
  assert(home.includes(route), `Home launcher must include ${route}`);
}
for (const label of ["Count", "My Work", "Products", "Locations"]) {
  assert(home.includes(`title: "${label}"`), `Home launcher must include the ${label} application button`);
}
assert(home.includes("user.name"), "Home greeting must derive the user's name from authenticated user data");
assert(home.includes("getHours()"), "Home greeting must derive its daypart from local browser time");
assert(home.includes("ready to start working?"), "Home must present the approved ready-to-work greeting");
assert(!home.includes("Mitchell"), "Home must never hard-code a user's name");
assert(home.includes('router.replace("/login")'), "Unauthenticated Home must route to sign-in");

assert(login.includes("Welcome to"), "The sign-in experience must present a clear ContinuiXai welcome message");
assert(login.includes(">Sign In<"), "The sign-in experience must expose a clear Sign In action");
assert((login.match(/router\.push\("\/"\)/g) || []).length >= 2, "Both successful MFA paths must route to Home");
assert(!login.includes('router.push("/store-count")'), "Successful MFA must not bypass Home and route directly to Count");

assert(manifest.includes('start_url: "/"'), "Installed PWA must launch through Home");
assert(manifest.includes('scope: "/"'), "Installed PWA must remain scoped to the ContinuiXai application");
assert(manifest.includes('display: "standalone"'), "Installed PWA must use standalone display mode");

console.log("PWA Home launcher regression checks passed.");
