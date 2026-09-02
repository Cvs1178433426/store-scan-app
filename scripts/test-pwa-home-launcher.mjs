import fs from "node:fs";

const home = fs.readFileSync(new URL("../apps/web/app/page.tsx", import.meta.url), "utf8");
const login = fs.readFileSync(new URL("../apps/web/app/login/page.tsx", import.meta.url), "utf8");
const registration = fs.readFileSync(new URL("../apps/web/app/register/page.tsx", import.meta.url), "utf8");
const manifest = fs.readFileSync(new URL("../apps/web/app/manifest.ts", import.meta.url), "utf8");
const serviceWorker = fs.readFileSync(new URL("../apps/web/public/sw.js", import.meta.url), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(!home.includes('redirect("/my-work")'), "Home must not redirect directly to My Work");
for (const route of ["/store-count", "/my-work", "/store-products", "/store-locations"]) {
  assert(home.includes(route), `Home launcher must include ${route}`);
}
for (const label of ["Start or resume Count", "My Work", "Products", "Locations"]) {
  assert(home.includes(`title: "${label}"`), `Home launcher must include the ${label} application button`);
}
assert(home.includes("styles.primaryAction"), "Count must remain the prominent primary Home action");
assert(home.includes("user.name"), "Home greeting must derive the user's name from authenticated user data");
assert(home.includes("getHours()"), "Home greeting must derive its daypart from local browser time");
assert(home.includes("Everything you need to keep work moving and inventory accurate."), "Home must explain the purpose of the operations workspace");
assert(!home.includes("Mitchell"), "Home must never hard-code a user's name");
assert(home.includes("Inventory confidence starts here."), "Unauthenticated Home must present the approved ContinuiXai opening statement");
assert(home.includes('href="/login"'), "Unauthenticated Home must provide a direct Sign In action");
assert(home.includes(">Sign In</span>"), "Unauthenticated Home must label the primary action Sign In");

assert(login.includes('router.push("/")'), "Successful SMS login must route to Home");
assert(registration.includes('router.push("/")'), "Successful SMS registration must route to Home");
assert(!login.includes('router.push("/store-count")'), "Successful MFA must not bypass Home and route directly to Count");

assert(manifest.includes('start_url: "/"'), "Installed PWA must launch through Home");
assert(manifest.includes('scope: "/"'), "Installed PWA must remain scoped to the ContinuiXai application");
assert(manifest.includes('display: "standalone"'), "Installed PWA must use standalone display mode");

assert(fs.existsSync(new URL("../apps/web/public/apple-touch-icon.png", import.meta.url)), "iOS must have the conventional root /apple-touch-icon.png fallback");
assert(serviceWorker.includes('request.destination === "manifest"'), "Service worker must bypass manifest requests used by installation");
assert(serviceWorker.includes('request.destination === "image"'), "Service worker must bypass PWA icon/image requests used by installation");

console.log("PWA Home launcher regression checks passed.");
