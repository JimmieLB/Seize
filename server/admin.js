// Admin login: a shared password unlocks editing of maps, units and buildings.
//
// The password comes from the ADMIN_PASSWORD environment variable (set it on Railway); the
// fallback below is for local development. Logging in returns a signed token
// ("<issuedAt>.<signature>") that the client sends back in the X-Admin-Token header. Tokens are
// stateless (they survive server restarts), expire after 30 days, and stop working if the
// password changes.

import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";

const password = process.env.ADMIN_PASSWORD || "trumpsucks";
const signingKey = scryptSync(password, "seize-admin-token", 32);
const tokenLifetimeMs = 30 * 24 * 60 * 60 * 1000;

// Basic brute-force protection: at most 10 failed logins per address per 10 minutes.
const maxFailures = 10;
const failureWindowMs = 10 * 60 * 1000;
const failures = new Map(); // address -> [timestamps]

function sign(issuedAt) {
  return createHmac("sha256", signingKey).update(String(issuedAt)).digest("hex");
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function clientAddress(request) {
  // Railway (and most hosts) put the real client address first in X-Forwarded-For.
  return String(request.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || request.socket.remoteAddress || "unknown";
}

/** Returns a token for a correct password; throws (401 / 429) otherwise. */
export function login(request, attempt) {
  const address = clientAddress(request);
  const now = Date.now();
  const recent = (failures.get(address) ?? []).filter((time) => now - time < failureWindowMs);
  if (recent.length >= maxFailures) {
    throw Object.assign(new Error("Too many attempts. Try again in a few minutes."), { status: 429 });
  }
  if (typeof attempt !== "string" || !safeEqual(attempt, password)) {
    recent.push(now);
    failures.set(address, recent);
    throw Object.assign(new Error("Wrong admin password."), { status: 401 });
  }
  failures.delete(address);
  return `${now}.${sign(now)}`;
}

export function isAdmin(request) {
  const token = request.headers["x-admin-token"];
  if (typeof token !== "string") return false;
  const [issuedAt, signature] = token.split(".");
  if (!issuedAt || !signature || Date.now() - Number(issuedAt) > tokenLifetimeMs) return false;
  return safeEqual(signature, sign(issuedAt));
}

/** Throws 403 unless the request carries a valid admin token. */
export function requireAdmin(request) {
  if (!isAdmin(request)) {
    throw Object.assign(new Error("Only admins can change this. Log in as admin from the lobby."), { status: 403 });
  }
}
