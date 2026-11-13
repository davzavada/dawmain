import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The small Markdown the site's editable texts are written in (src/content/
 * texts.ts): paragraphs, `## headings`, `- lists`, **bold**, *italic* and
 * [links](…). Rendered to React elements, never to an HTML string — whatever
 * an admin types is text or one of these few elements, so no markup of
 * theirs can reach the page.
 *
 * Deliberately not CommonMark:
 *   - a blank line separates blocks; a single line break inside a paragraph
 *     or a list item is a line break on the page (nobody has to know about
 *     trailing spaces);
 *   - a link goes to http(s), mailto or a path of this site ("/soukromi",
 *     "/#zdroje"); anything else (javascript:, data:) stays plain text;
 *   - what is not recognised is shown as it was typed.
 */

export type Block =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] };

/** Where a link may lead. Pure. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^https?:\/\/[^\s]+$/i.test(href)) return href;
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(href)) return href;
  // A path of this site — one leading slash only ("//host" would leave it).
  if (/^\/(?!\/)[^\s]*$/.test(href)) return href;
  return null;
}

/** The blocks of a text. Pure — unit-tested. */
export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const chunks = source.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n+/);
  for (const chunk of chunks) {
    const lines = chunk.split("\n").map((line) => line.trimEnd());
    while (lines.length && !lines[0].trim()) lines.shift();
    if (!lines.length) continue;
    const heading = /^##\s+(.+)$/.exec(lines[0]);
    if (heading) {
      blocks.push({ kind: "heading", text: heading[1].trim() });
      lines.shift();
      if (!lines.length) continue;
    }
    if (/^[-*]\s+/.test(lines[0])) {
      // A line that does not start an item continues the one above it.
      const items: string[] = [];
      for (const line of lines) {
        const item = /^[-*]\s+(.*)$/.exec(line);
        if (item) items.push(item[1]);
        else items[items.length - 1] += `\n${line.trim()}`;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    blocks.push({ kind: "paragraph", text: lines.join("\n") });
  }
  return blocks;
}

const INLINE = /\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)|\n/g;

/** One line of text with its bold, italic, links and line breaks. */
export function Inline({ text }: { text: string }): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index;
    if (at > last) out.push(text.slice(last, at));
    last = at + match[0].length;
    if (match[0] === "\n") out.push(<br key={key++} />);
    else if (match[1] !== undefined) out.push(<strong key={key++}>{match[1]}</strong>);
    else if (match[2] !== undefined) out.push(<em key={key++}>{match[2]}</em>);
    else {
      const href = safeHref(match[4]);
      if (!href) out.push(match[0]);
      else if (href.startsWith("/")) {
        out.push(
          <Link key={key++} href={href}>
            {match[3]}
          </Link>,
        );
      } else {
        out.push(
          <a key={key++} href={href}>
            {match[3]}
          </a>,
        );
      }
    }
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function BlockView({ block, paragraphClass }: { block: Block; paragraphClass?: string }) {
  if (block.kind === "heading") return <h2>{block.text}</h2>;
  if (block.kind === "list") {
    return (
      <ul>
        {block.items.map((item, i) => (
          <li key={i}>
            <Inline text={item} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <p className={paragraphClass}>
      <Inline text={block.text} />
    </p>
  );
}

/**
 * A text as blocks. With `sections`, every `## heading` opens a <section>
 * that runs to the next one (the legal pages' layout); what stands before
 * the first heading stays outside.
 */
export function Markdown({ source, sections = false, paragraphClass }: { source: string; sections?: boolean; paragraphClass?: string }) {
  const blocks = parseBlocks(source);
  if (!sections) return blocks.map((block, i) => <BlockView key={i} block={block} paragraphClass={paragraphClass} />);
  const groups: Block[][] = [];
  for (const block of blocks) {
    if (block.kind === "heading" || !groups.length) groups.push([block]);
    else groups[groups.length - 1].push(block);
  }
  return groups.map((group, g) =>
    group[0].kind === "heading" ? (
      <section key={g}>
        {group.map((block, i) => (
          <BlockView key={i} block={block} paragraphClass={paragraphClass} />
        ))}
      </section>
    ) : (
      group.map((block, i) => <BlockView key={`${g}-${i}`} block={block} paragraphClass={paragraphClass} />)
    ),
  );
}
