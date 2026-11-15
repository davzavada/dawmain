/**
 * What the deployment knows about itself, in one place. The code runs on
 * Vercel and on the home server (docs/infra/migrace-z-vercelu.md) from the
 * same commit: each value is read from our own variable first, then from the
 * Vercel one it replaces, so nothing changes where only Vercel's are set.
 * Pure functions of `process.env`, read per call (tests stub the env).
 */

type Env = Record<string, string | undefined>;

/** A plain scheme://host[:port] — nothing else is ever put into a link. */
const PLAIN_ORIGIN = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i;
const PLAIN_HOST = /^[a-z0-9.-]+(?::\d{1,5})?$/i;

function trimmed(env: Env, name: string): string {
  return env[name]?.trim() ?? "";
}

/**
 * The public origin of the production site, or null: `PUBLIC_URL`
 * (`https://dawmain.davidzavada.cz`), else the host Vercel names in
 * `VERCEL_PROJECT_PRODUCTION_URL`. Anything but a plain origin is ignored.
 */
export function productionOrigin(env: Env = process.env): string | null {
  const url = trimmed(env, "PUBLIC_URL").replace(/\/+$/, "");
  if (PLAIN_ORIGIN.test(url)) return url;
  const host = trimmed(env, "VERCEL_PROJECT_PRODUCTION_URL");
  return PLAIN_HOST.test(host) ? `https://${host}` : null;
}

/** `production` | `preview` | … — `APP_ENV`, else `VERCEL_ENV`, else "local". */
export function appEnvironment(env: Env = process.env): string {
  return trimmed(env, "APP_ENV") || trimmed(env, "VERCEL_ENV") || "local";
}

/** Where the instance runs (`home`, `fra1`, …), or null. */
export function appRegion(env: Env = process.env): string | null {
  return trimmed(env, "APP_REGION") || trimmed(env, "VERCEL_REGION") || null;
}

/** The first seven characters of the deployed commit, or null. */
export function gitCommit(env: Env = process.env): string | null {
  const sha = trimmed(env, "GIT_SHA") || trimmed(env, "VERCEL_GIT_COMMIT_SHA");
  return sha ? sha.slice(0, 7) : null;
}

/**
 * Whether the deployment must refuse unauthenticated MCP requests whatever
 * else is configured. On Vercel always (`VERCEL`); at home when the service
 * sets `DAWMAIN_REQUIRE_AUTH`. Fail-closed: any value but an explicit
 * 0 / false / off / no turns it on, so a misspelling cannot open the endpoint.
 */
export function authForced(env: Env = process.env): boolean {
  if (trimmed(env, "VERCEL")) return true;
  const flag = trimmed(env, "DAWMAIN_REQUIRE_AUTH").toLowerCase();
  return flag !== "" && !["0", "false", "off", "no"].includes(flag);
}

/**
 * Whether `X-Forwarded-Host` / `X-Forwarded-Proto` say where the browser is.
 * On by default (Vercel sets them). The home server sets
 * `TRUST_FORWARDED_HOST=0`: Cloudflare Tunnel passes the public Host header
 * itself, and a header any client can send must not decide the origin.
 */
export function forwardedHostTrusted(env: Env = process.env): boolean {
  return !["0", "false", "off", "no"].includes(trimmed(env, "TRUST_FORWARDED_HOST").toLowerCase());
}
