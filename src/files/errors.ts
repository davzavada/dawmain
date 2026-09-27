import "server-only";
import { DmdLimitError } from "./dmd/types";
import { FilesUnavailableError } from "./db/client";

/**
 * Error handling of Vlastní zdroje on the server: fixed, user-facing Czech
 * messages and log lines that never carry content.
 *
 * Raw error messages are NOT safe to show or log here: a pg error quotes
 * the offending values ("Key (library_id, content_sha256)=(…)"), role and
 * host names; a zod error quotes the input; a Clerk error may carry an
 * e-mail address. So:
 *   - a user sees one of the fixed messages below (or a FilesUserError's own
 *     message, which the code wrote), never `error.message` of a foreign error;
 *   - logs get `where`, the error class and an opaque code (pg SQLSTATE,
 *     Clerk HTTP status, DMD limit name) — enough to find the failing step.
 */

export const MESSAGES = {
  unavailable: "Vlastní zdroje jsou dočasně nedostupné. Zkuste to prosím za chvíli.",
  off: "Vlastní zdroje jsou teď vypnuté.",
  readonly: "Vlastní zdroje jsou teď jen pro čtení — hledat, číst a mazat jde, nahrávat ne. Zkuste to později.",
  signIn: "Přihlaste se prosím.",
  forbidden: "K tomu nemáte oprávnění.",
  badOrigin: "Požadavek nepřišel z tohoto webu.",
  notFound: "Nenalezeno.",
  badRequest: "Neplatný požadavek.",
} as const;

/** An expected refusal with a message written for the user (Czech) and an HTTP status. */
export class FilesUserError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503,
    message: string,
  ) {
    super(message);
    this.name = "FilesUserError";
  }
}

/**
 * Opaque, content-free code of an error for logs and support: the pg
 * SQLSTATE ("pg:23505"), the Clerk HTTP status ("clerk:404"), the DMD limit
 * ("dmd:maxPages"), the FilesUnavailableError reason, else the class name.
 */
export function errorCode(error: unknown): string {
  if (error instanceof FilesUserError) return `user:${error.status}`;
  if (error instanceof DmdLimitError) return `dmd:${error.limit}`;
  if (error instanceof FilesUnavailableError) return `db:${error.reason}`;
  const clerk = clerkStatus(error);
  if (clerk !== null) return `clerk:${clerk}`;
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; name?: unknown };
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return `pg:${e.code}`;
    if (typeof e.name === "string" && /^[A-Za-z]{1,40}$/.test(e.name)) return e.name;
  }
  return "unknown";
}

/**
 * HTTP status of a Clerk Backend API error (ClerkAPIResponseError: code
 * "api_response_error" + numeric status), else null. Duck-typed so it also
 * recognises errors from a mocked client in tests.
 */
export function clerkStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const e = error as { code?: unknown; status?: unknown };
  return e.code === "api_response_error" && typeof e.status === "number" ? e.status : null;
}

/** One log line without content: where it happened and the opaque code. */
export function logFilesError(where: string, error: unknown): void {
  console.error(`files: ${where} failed (${errorCode(error)})`);
}

/** The Czech message a user may see for any error: a FilesUserError's own text, else a fixed one. */
export function userMessage(error: unknown): string {
  if (error instanceof FilesUserError) return error.message;
  return MESSAGES.unavailable;
}

/** Headers of every /api/files and webhook/cron JSON response: never cached, never sniffed. */
export const NO_STORE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
});

/** JSON response with the no-store headers. */
export function filesJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

/** `{ error }` JSON response with a fixed or FilesUserError message. */
export function filesError(status: number, message: string): Response {
  return filesJson({ error: message }, status);
}
