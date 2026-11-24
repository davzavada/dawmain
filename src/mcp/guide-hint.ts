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
  "FIRST, once per conversation: call dawmain_guide (the research manual) in the same turn as your first searches — not as a separate step before them; searching without it gives worse results. ";

/** Whether `name` is a tool that starts a search. */
export function isSearchTool(name: string): boolean {
  return /_search$/.test(name);
}

/** The config with the pointer in front of its description, for a search tool; anything else is returned as it is. Pure. */
export function withGuideHint<T extends { description?: unknown }>(name: string, config: T): T {
  if (!isSearchTool(name) || typeof config.description !== "string" || config.description.startsWith(GUIDE_FIRST)) return config;
  return { ...config, description: GUIDE_FIRST + config.description };
}

/**
 * Which wording of the tool descriptions a client gets.
 *
 * "plain" — every client but ChatGPT, Claude among them: the descriptions
 * say what a tool does and nothing about how the model should behave or
 * which other tool to call first. The Claude connector directory requires
 * exactly that ("Tool descriptions contain no instructions about model
 * behavior, other tools, or external instruction sources"); that guidance
 * lives in the server instructions, which Claude follows.
 *
 * "hinted" — ChatGPT, which follows the server instructions far less
 * reliably: the descriptions as the tool files write them, plus the pointer
 * to dawmain_guide in front of every search tool (withGuideHint).
 */
export type DescriptionStyle = "plain" | "hinted";

/**
 * The sentences that tell the model how to behave, as the tool files write
 * them, and what the plain wording puts in their place. Each one must occur
 * in some description (a test checks it), so a reworded source cannot slip
 * past this list unnoticed.
 */
export const MODEL_INSTRUCTIONS: ReadonlyArray<readonly [string, string]> = [
  [" A decision you rely on (quote it, cite it as authority) you read WHOLE: page 1, then every page to the last. Continue on your own — never ask the user whether to keep reading.", ""],
  [" — follow it without asking, and it stops where the requested range ends.", "; it stops where the requested range ends."],
  ["follow the continuation line without asking the user; ", ""],
  [
    " Call it ONCE at the start of every legal research — whenever the user asks what the law, the courts or the doctrine say ('právní rešerše', 'rešerše k', 'co na to judikatura', 'najdi judikaturu k § X', 'jak to soudy vykládají', 'je na to nějaký rozsudek', 'platí ještě', 'co říká zákon o', 'najdi mi rozhodnutí', 'co na to doktrína', 'najdi důvodovou zprávu', 'co chtěl zákonodárce') or describes a legal problem expecting an answer grounded in statute, case law and literature, including everyday practical questions that name no statute ('je možné / lze / smím / musím…', 'je to platné' about a smlouva, podpis, výpověď, lhůta…), questions about Slovak law ('na Slovensku', 'slovenský zákon', 'Z. z.', 'NS SR', CZ/SK comparison) and EU transposition ('který zákon transponuje směrnici 2004/48') — in the SAME turn as your first searches, not as a step before them.",
    " It covers Czech and EU law, and Slovak law on request.",
  ],
  [" — ask for it in the same turn as your first in-depth search of that source", ""],
];

/** The plain wording of one description: the model instructions taken out. Pure. */
export function plainDescription(description: string): string {
  let text = description;
  for (const [from, to] of MODEL_INSTRUCTIONS) text = text.split(from).join(to);
  return text;
}

/** The config in the given style. Pure. */
export function styled<T extends { description?: unknown }>(name: string, config: T, style: DescriptionStyle): T {
  if (style === "hinted") return withGuideHint(name, config);
  if (typeof config.description !== "string") return config;
  return { ...config, description: plainDescription(config.description) };
}
