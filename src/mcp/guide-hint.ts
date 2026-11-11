/**
 * The pointer to dawmain_guide in the search tools' own descriptions.
 *
 * The research manual (dawmain_guide, the dawmain-reserse skill) is what
 * makes the model research well: the brief, query craft, reading decisions
 * whole, citing. Claude follows the server instructions that tell it to read
 * the manual first; ChatGPT follows them far less reliably, which is why the
 * website used to ask ChatGPT users to upload the skill by hand. A tool's
 * description is what every client puts in front of the model whenever it
 * considers calling the tool, so the pointer goes there: in front of the
 * description of every tool that starts a search, never on the ones that only
 * read a hit (they come after a search) or on dawmain_guide itself.
 *
 * Applied once, at the registration boundary (textOnly in ./tools/index.ts),
 * so a new `*_search` tool is covered without anyone remembering it.
 */

const GUIDE_FIRST =
  "FIRST, once per conversation: call dawmain_guide (the research manual) before the first search; searching without it gives worse results. ";

/** Whether `name` is a tool that starts a search. */
export function isSearchTool(name: string): boolean {
  return /_search$/.test(name);
}

/** The config with the pointer in front of its description, for a search tool; anything else is returned as it is. Pure. */
export function withGuideHint<T extends { description?: unknown }>(name: string, config: T): T {
  if (!isSearchTool(name) || typeof config.description !== "string" || config.description.startsWith(GUIDE_FIRST)) return config;
  return { ...config, description: GUIDE_FIRST + config.description };
}
