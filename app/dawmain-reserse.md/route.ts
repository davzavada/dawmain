import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * The dawmain-reserse skill, downloadable from the home page. Served from
 * the repository's skills/ tree, so the page always hands out exactly what
 * the repo versions - no copy in public/ to drift. force-static makes Next
 * run this at build time and serve the result as a static file, so the
 * skills/ directory never needs to exist in the deployed function.
 */
export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  const file = path.join(process.cwd(), "skills", "dawmain-reserse", "SKILL.md");
  const body = await fs.readFile(file, "utf8");
  return new Response(body, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": 'attachment; filename="SKILL.md"',
    },
  });
}
