/**
 * OpenAI's domain check for the ChatGPT plugin listing: the submission portal
 * shows a token and fetches it back from this path, as plain text with
 * nothing else in the body. The token lives in OPENAI_APPS_CHALLENGE (set it
 * on the server, not in the repository); 404 while it is unset.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  const token = process.env.OPENAI_APPS_CHALLENGE?.trim();
  if (!token) return new Response("Not found", { status: 404 });
  return new Response(token, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
