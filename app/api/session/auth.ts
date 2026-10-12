const COOKIE_NAME = "alice-staff-session";

const bytesToHex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

async function signature(value: string) {
  const secret = process.env.ALICE_STORE_ACCESS_CODE || (!process.env.NETLIFY ? "alice-store-local-development-only" : undefined);
  if (!secret) return "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  return bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

export async function createStaffSession(staff: string) {
  const payload = `${staff}:${Date.now() + 12 * 60 * 60 * 1000}`;
  return `${encodeURIComponent(payload)}.${await signature(payload)}`;
}

export async function verifyStaffSession(request: Request) {
  const cookie = request.headers.get("cookie")?.split(";").map(v=>v.trim()).find(v=>v.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length+1);
  if (!cookie) return false;
  const [encoded, supplied] = cookie.split(".");
  const payload = decodeURIComponent(encoded || "");
  const expires = Number(payload.split(":").at(-1));
  return Boolean(supplied && expires > Date.now() && supplied === await signature(payload));
}

// The signed-in staff member's name, taken from the same signed cookie the
// session check uses - so the stock movement log records who really made a
// change, not whatever a screen claims. Returns "" for an invalid session.
export async function staffFromSession(request: Request) {
  const cookie = request.headers.get("cookie")?.split(";").map(v=>v.trim()).find(v=>v.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length+1);
  if (!cookie) return "";
  const [encoded, supplied] = cookie.split(".");
  const payload = decodeURIComponent(encoded || "");
  const parts = payload.split(":");
  const expires = Number(parts.at(-1));
  if (!(supplied && expires > Date.now() && supplied === await signature(payload))) return "";
  return parts.slice(0, -1).join(":");
}

export const staffCookie = (value: string, maxAge = 43200) =>
  `${COOKIE_NAME}=${value}; Path=/; HttpOnly${process.env.NODE_ENV === "production" ? "; Secure" : ""}; SameSite=Strict; Max-Age=${maxAge}`;
