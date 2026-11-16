/**
 * What the deployment knows about itself, in one place. Production runs on
 * the home server (docs/infra/proxmox.md, deploy/web/), which sets these
 * variables in /etc/dawmain/env and in the systemd unit; `npm run dev` sets
 * none of them. Pure functions of `process.env`, read per call (tests stub
 * the env).
 */

type Env = Record<string, string | undefined>;

/** A plain scheme://host[:port] — nothing else is ever put into a link. */
const PLAIN_ORIGIN = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i;

/** The only values that turn a yes/no switch off. */
const OFF = ["0", "false", "off", "no"];

function trimmed(env: Env, name: string): string {
  return env[name]?.trim() ?? "";
}

/**
 * The public origin of the production site (`PUBLIC_URL`, e.g.
 * `https://dawmain.davidzavada.cz`), or null. Anything but a plain origin
 * is ignored.
 */
export function productionOrigin(env: Env = process.env): string | null {
  const url = trimmed(env, "PUBLIC_URL").replace(/\/+$/, "");
  return PLAIN_ORIGIN.test(url) ? url : null;
}

/** `production` | `preview` | … — `APP_ENV`, else "local". */
export function appEnvironment(env: Env = process.env): string {
  return trimmed(env, "APP_ENV") || "local";
}

/** Where the instance runs (`home`, …) — `APP_REGION`, or null. */
export function appRegion(env: Env = process.env): string | null {
  return trimmed(env, "APP_REGION") || null;
}

/** The first seven characters of the deployed commit (`GIT_SHA`), or null. */
export function gitCommit(env: Env = process.env): string | null {
  const sha = trimmed(env, "GIT_SHA");
  return sha ? sha.slice(0, 7) : null;
}

/**
 * Whether the deployment must refuse unauthenticated MCP requests whatever
 * else is configured. `DAWMAIN_REQUIRE_AUTH` decides; the service sets it.
 * Fail-closed both ways a slip can happen:
 *
 * - any value but an explicit 0 / false / off / no turns it on, so a
 *   misspelling cannot open the endpoint;
 * - unset, a production server (`NODE_ENV=production`: `next start`, the
 *   standalone server.js) requires auth anyway, so a unit or env file that
 *   lost the line does not publish the tools either. Only `npm run dev`
 *   (development) and the tests stay anonymous by default; a local
 *   production build can opt out with an explicit `DAWMAIN_REQUIRE_AUTH=0`.
 */
export function authForced(env: Env = process.env): boolean {
  const flag = trimmed(env, "DAWMAIN_REQUIRE_AUTH").toLowerCase();
  if (flag === "") return trimmed(env, "NODE_ENV") === "production";
  return !OFF.includes(flag);
}

/**
 * Whether `X-Forwarded-Host` / `X-Forwarded-Proto` say where the browser is.
 * Off unless `TRUST_FORWARDED_HOST` is set to something other than
 * 0 / false / off / no: a header any client can send must not decide the
 * origin, and nothing in front of the server sets it for us — Cloudflare
 * Tunnel passes the public Host header itself, `npm run dev` is reached
 * directly. Turn it on only behind a proxy that overwrites these headers.
 */
export function forwardedHostTrusted(env: Env = process.env): boolean {
  const flag = trimmed(env, "TRUST_FORWARDED_HOST").toLowerCase();
  return flag !== "" && !OFF.includes(flag);
}
