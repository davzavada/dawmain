/**
 * Storage blocks: the DMD is stored ONCE, compressed in ~12k-char blocks
 * (doc_blocks); pages, sections, footnotes and chunks are only offsets into
 * it, so a read loads just the blocks overlapping the requested range.
 * Blocks are cut at a paragraph break where one is near the target, so a
 * typical read window touches few blocks. Isomorphic and pure — unit-tested.
 */

export const STORAGE_BLOCK_CHARS = 12_000;

/**
 * Split `text` into contiguous blocks covering [0, text.length), each about
 * `target` chars: cut right after a "\n\n" in the window [target/2, target]
 * (else up to 1.5 × target), then after a "\n", then a hard cut that never
 * splits a surrogate pair. `ord` is 0-based. Empty text → no blocks. Pure.
 */
export function splitStorageBlocks(text: string, target = STORAGE_BLOCK_CHARS): Array<{ ord: number; start: number; end: number }> {
  const size = Math.max(16, Math.floor(Number.isFinite(target) ? target : STORAGE_BLOCK_CHARS));
  const blocks: Array<{ ord: number; start: number; end: number }> = [];
  const n = text.length;
  let start = 0;
  while (start < n) {
    const end = n - start <= size ? n : cutPoint(text, start, size);
    blocks.push({ ord: blocks.length, start, end });
    start = end;
  }
  return blocks;
}

/** End (exclusive) of the block starting at `start`; always in (start, n). */
function cutPoint(text: string, start: number, size: number): number {
  const min = start + Math.floor(size / 2);
  const ideal = start + size;
  const max = Math.min(text.length - 1, start + Math.floor(size * 1.5));
  // Both searches run on bounded slices: an unbounded lastIndexOf / indexOf
  // would rescan the whole text for every block of a text without breaks.
  const before = text.slice(min, ideal);
  const after = text.slice(ideal - 1, max);
  for (const sep of ["\n\n", "\n"]) {
    // Backwards from the target: the separator must END by `ideal`.
    const back = before.lastIndexOf(sep);
    if (back !== -1) return min + back + sep.length;
    // Forwards: the first separator that ends after `ideal`.
    const fwd = after.indexOf(sep, sep.length === 2 ? 0 : 1);
    if (fwd !== -1) return ideal - 1 + fwd + sep.length;
  }
  const code = text.charCodeAt(ideal - 1);
  // Never end a block between a high and a low surrogate.
  return code >= 0xd800 && code <= 0xdbff ? ideal + 1 : ideal;
}
