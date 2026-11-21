import cluster from "node:cluster";
import { availableParallelism } from "node:os";

/**
 * The mirror API in several processes (node:cluster, the workers share one
 * listening port). One Node process tops out at one core: measured on CT 102
 * (2026-11-21) at ~55 searches+reads per second with the API process at 100 %
 * and Postgres mostly idle. Each worker has its own reader pool (max 8), so
 * N workers hold up to 8·N connections of Postgres' 100.
 */

export const MAX_API_WORKERS = 8;

/** MIRROR_API_WORKERS: unset or empty = 1 (one process, as before); a whole number 1–8, capped at the cores. */
export function apiWorkerCount(raw: string | undefined, cores = availableParallelism()): number {
  const value = raw?.trim();
  if (!value) return 1;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_API_WORKERS)
    throw new Error(`MIRROR_API_WORKERS must be a whole number 1–${MAX_API_WORKERS}, got "${raw}"`);
  return Math.min(n, Math.max(1, cores));
}

/** A worker that dies within this long of its start counts as a crash loop. */
const QUICK_DEATH_MS = 10_000;
const MAX_QUICK_DEATHS = 5;

/**
 * Runs `serveOne` in `count` worker processes and keeps them up; returns when
 * the primary gets SIGTERM / SIGINT and every worker has exited. A worker that
 * dies is replaced; if workers keep dying right after their start (bad config,
 * database down at boot), the primary gives up with exit code 1 so systemd's
 * Restart= takes over with its own back-off instead of a tight fork loop.
 * In a worker (or with count 1) it just runs `serveOne`.
 */
export async function runApiWorkers(count: number, serveOne: () => Promise<number>): Promise<number> {
  if (count <= 1 || !cluster.isPrimary) return serveOne();

  let stopping = false;
  let quickDeaths = 0;
  const started = new Map<number, number>();
  const fork = () => {
    const worker = cluster.fork();
    started.set(worker.id, Date.now());
  };

  return new Promise<number>((resolve) => {
    const finishWhenEmpty = (code: number) => {
      if (Object.keys(cluster.workers ?? {}).length === 0) resolve(code);
    };
    let exitCode = 0;
    const stop = (code: number) => {
      if (stopping) return;
      stopping = true;
      exitCode = code;
      // systemd signals the whole cgroup anyway; this covers a stop sent to the primary alone.
      for (const worker of Object.values(cluster.workers ?? {})) worker?.process.kill("SIGTERM");
      finishWhenEmpty(exitCode);
    };

    cluster.on("exit", (worker, code, signal) => {
      const lived = Date.now() - (started.get(worker.id) ?? 0);
      started.delete(worker.id);
      if (stopping) return finishWhenEmpty(exitCode);
      console.error(`mirror-api: worker ${worker.process.pid} exited (${signal ?? code}) after ${Math.round(lived / 1000)} s`);
      quickDeaths = lived < QUICK_DEATH_MS ? quickDeaths + 1 : 0;
      if (quickDeaths >= MAX_QUICK_DEATHS) {
        console.error(`mirror-api: ${MAX_QUICK_DEATHS} workers in a row died right after start, giving up`);
        return stop(1);
      }
      fork();
    });

    for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => stop(0));
    console.log(`mirror-api: primary ${process.pid} starting ${count} workers`);
    for (let i = 0; i < count; i++) fork();
  });
}
