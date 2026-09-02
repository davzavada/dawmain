import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { SourceError } from "./errors";

/**
 * The one rule every outbound document fetch obeys: public sites only.
 * A fetcher that follows links out of catalogue records and login
 * redirects is otherwise a proxy into the deployment's own network, so
 * every hop — the first URL and every redirect and form action after it —
 * passes through here.
 */

/** RFC 1918/4193/3927 and friends — nothing there is a publisher. Pure. */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a >= 224) return false;
    return true;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return false;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return false; // fc00::/7
    if (/^fe[89ab]/.test(lower)) return false; // fe80::/10
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]);
    return true;
  }
  return false;
}

/** HTTPS, a real hostname, every resolved address public. Throws otherwise. */
export async function assertPublicUrl(source: string, raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceError(source, "INPUT_INVALID", `"${raw}" is not a valid absolute URL.`, "Pass the access link of a hit, or a DOI.");
  }
  if (url.protocol !== "https:") {
    throw new SourceError(source, "INPUT_INVALID", `Only https URLs are fetched (got ${url.protocol}).`, "Use the https link of the record.");
  }
  const host = url.hostname.toLowerCase();
  if (isIP(host) || !host.includes(".") || /\.(local|localhost|internal|arpa|home)$/.test(host) || host === "localhost") {
    throw new SourceError(source, "INPUT_INVALID", `Host ${host} is not a public site.`, "Only public publisher, repository and library sites are fetched.");
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new SourceError(source, "UPSTREAM_UNREACHABLE", `Host ${host} does not resolve.`, "The link may be dead — open the record and try another access link.");
  }
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new SourceError(source, "INPUT_INVALID", `Host ${host} resolves to a non-public address.`, "Only public publisher, repository and library sites are fetched.");
  }
  return url;
}
