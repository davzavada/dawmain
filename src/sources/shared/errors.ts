/**
 * Error taxonomy shared by every source client. Tools map a SourceError to an
 * MCP error result whose text tells the model what to try differently —
 * an upstream outage, a missing document and a layout change each call for a
 * different next move, so they must stay distinguishable.
 */
export type SourceErrorKind =
  | "UPSTREAM_UNREACHABLE" // network error, DNS, timeout
  | "UPSTREAM_ERROR" // upstream answered 429/5xx after retries
  | "NOT_FOUND" // the requested document does not exist
  | "NO_RESULTS" // search succeeded but matched nothing (not an error result)
  | "PARSE_DRIFT" // expected marker/selector missing — upstream changed layout
  | "SESSION_EXPIRED" // multi-step flow lost its session and re-handshake failed
  | "INPUT_INVALID"; // input that schema validation cannot catch (e.g. bad sp. zn.)

export class SourceError extends Error {
  constructor(
    public readonly source: string,
    public readonly kind: SourceErrorKind,
    message: string,
    /** One sentence telling the model what to do next. */
    public readonly hint: string,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

/** Wrap any thrown value into a SourceError, defaulting to UPSTREAM_UNREACHABLE. */
export function asSourceError(source: string, error: unknown): SourceError {
  if (error instanceof SourceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SourceError(
    source,
    "UPSTREAM_UNREACHABLE",
    `${source}: ${message}`,
    "The upstream service did not respond. Try again in a minute; if it keeps failing, run dawmain_probe_sources to check the source's status.",
  );
}

/** Shape of the MCP tool result for a failed call. */
export function toToolError(error: SourceError): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { error: { source: string; kind: SourceErrorKind; message: string; hint: string } };
} {
  return {
    isError: true,
    content: [{ type: "text", text: `${error.message}\n\n${error.hint}` }],
    structuredContent: {
      error: { source: error.source, kind: error.kind, message: error.message, hint: error.hint },
    },
  };
}
