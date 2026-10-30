import type { Db } from "../db/client";
import { dequeue, enqueue, idsWithText, saveDecision, type RunCounts } from "../db/store";
import { Pacer, SourceStopped } from "../http";
import type { DecisionRecord, MirrorSource } from "../types";

/**
 * The fetch-and-store loop every source shares: skip what is stored by the
 * current parser, run `concurrency` workers over the rest through one
 * pacer, store each record, queue each failure (fetch_queue). A 429/403
 * (SourceStopped) stops every worker and is rethrown; SIGTERM (shouldStop)
 * lets each finish the decision in hand.
 *
 * A server that answers a burst with 5xx for minutes (NS's Domino does)
 * would otherwise fill the queue with healthy documents: after
 * COOL_DOWN_AFTER failures in a row every worker pauses COOL_DOWN_MS, then
 * carries on.
 */

export interface CrawlContext {
  db: Db;
  pacer: Pacer;
  log: (line: string) => void;
  /** Called after every stored or failed decision (the CLI writes counts every 50). */
  progress?: (counts: RunCounts) => Promise<void>;
  /** True once a stop was asked for (SIGTERM): workers finish the decision in hand and return. */
  shouldStop?: () => boolean;
  /** Test hook: how a cool-down waits. */
  sleep?: (ms: number) => Promise<void>;
}

export const COOL_DOWN_AFTER = 5;
export const COOL_DOWN_MS = 5 * 60_000;

export interface FetchJob<T> {
  source: MirrorSource;
  parserVersion: number;
  items: T[];
  id: (item: T) => string;
  fetch: (item: T) => Promise<DecisionRecord>;
  concurrency: number;
  /** Fetch every item, also those already done (daily sync: changes at the source). */
  refresh?: boolean;
}

export async function fetchAndStore<T>(ctx: CrawlContext, job: FetchJob<T>, counts: RunCounts): Promise<void> {
  const done = job.refresh ? new Set<string>() : await idsWithText(ctx.db, job.source, job.items.map(job.id), job.parserVersion);
  const todo = job.items.filter((item) => !done.has(job.id(item)));
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let next = 0;
  let stopped: SourceStopped | null = null;
  let failedInRow = 0;
  let coolingUntil = 0;

  const worker = async () => {
    let cooled = 0; // the cool-down this worker already slept through
    while (stopped === null && next < todo.length && !ctx.shouldStop?.()) {
      if (coolingUntil > cooled && Date.now() < coolingUntil) {
        cooled = coolingUntil;
        await sleep(coolingUntil - Date.now());
      }
      const item = todo[next++];
      const id = job.id(item);
      try {
        const record = await job.fetch(item);
        const saved = await saveDecision(ctx.db, record);
        failedInRow = 0;
        counts.fetched++;
        if (saved.inserted || saved.textChanged) counts.changed++;
        if (record.text || record.textAbsent) {
          await dequeue(ctx.db, job.source, id);
        } else {
          // The source gave the record but no text: stored, not done (v1-plan) — retried later.
          // Not a failure of the run: the source has nothing (yet); the queue backs off.
          ctx.log(`${job.source}: ${id}: zdroj nevrátil text rozhodnutí`);
          await enqueue(ctx.db, job.source, id, "text", "zdroj nevrátil text rozhodnutí");
        }
      } catch (error) {
        if (error instanceof SourceStopped) {
          stopped = error;
          return;
        }
        counts.failed++;
        const message = error instanceof Error ? error.message : String(error);
        ctx.log(`${job.source}: ${id}: ${message}`);
        await enqueue(ctx.db, job.source, id, "decision", message);
        if (++failedInRow >= COOL_DOWN_AFTER && Date.now() >= coolingUntil) {
          coolingUntil = Date.now() + COOL_DOWN_MS;
          failedInRow = 0;
          ctx.log(`${job.source}: ${COOL_DOWN_AFTER} chyb za sebou — pauza ${COOL_DOWN_MS / 60_000} min`);
        }
      }
      await ctx.progress?.(counts);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, job.concurrency) }, worker));
  if (stopped) throw stopped;
}

/** Every k-th item so a sample spans the whole list. */
export function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}

export function newPacer(rps: number): Pacer {
  if (!(rps > 0 && rps <= 10)) throw new Error(`requests per second must be in (0, 10], got ${rps}`);
  return new Pacer(1_000 / rps);
}
