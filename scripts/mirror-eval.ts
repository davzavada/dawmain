#!/usr/bin/env -S npx tsx
/**
 * Search evaluation of the case-law mirror before Dawmain switches to it:
 * runs a set of Czech queries per court through the mirror and compares
 * them with what the live sources answer (the lanes of caselaw_search).
 *
 *   npx tsx scripts/mirror-eval.ts                          # mirror DB through the tunnel (ssh -fN mirror-db)
 *   npx tsx scripts/mirror-eval.ts --api                    # the deployed API instead (tunnel URL, tokens in ~/.config/dawmain)
 *   npx tsx scripts/mirror-eval.ts --refresh-live           # ask the live sources again, rewrite the baseline
 *   npx tsx scripts/mirror-eval.ts --verbose                # + the top hits per query and court
 *   npx tsx scripts/mirror-eval.ts --json                   # machine-readable result
 *   npx tsx scripts/mirror-eval.ts --k 5                    # another cutoff (1–20)
 *
 * The DB mode runs this checkout's searchDecisions, so a ranking change is
 * measured before it is deployed. MIRROR_READER_URL overrides the default
 * postgres://mirror_reader@localhost:5433/mirror (password from ~/.pgpass).
 *
 * Two measures per court:
 *
 * - parity: of the live top k, how many the mirror has in its top k
 *   (strict) and top 2k (loose). NS and ÚS only: the live NSS search orders
 *   by date, not relevance, so its top k says nothing about ranking.
 * - expect: decisions a lawyer named as the key ones for the query
 *   (`expect` in the query file, case numbers), recall@k and MRR.
 *
 * The live answers are kept in the baseline file, so a run asks the courts
 * nothing unless --refresh-live; the courts' search changes over time, the
 * file says when it was taken. Exit code 0 whatever the scores (it measures,
 * it does not gate); 1 on an error, 2 on bad arguments.
 *
 * Query file (JSON):
 *
 *   { "queries": [ { "id": "pozustali", "q": "náhrada nemajetkové újmy pozůstalým",
 *                    "courts": ["ns", "nss", "us"],
 *                    "expect": { "ns": ["25 Cdo 894/2018"] } } ] }
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import pg from "pg";
import { poolDb } from "../src/mirror/db/client";
import { searchDecisions } from "../src/mirror/api/queries";
import { searchNs } from "../src/sources/ns";
import { searchNss } from "../src/sources/nss";
import { searchNalus } from "../src/sources/nalus";

type Court = "ns" | "nss" | "us";
const COURTS: readonly Court[] = ["ns", "nss", "us"];
/** The live NSS lane orders by date: no ranking to compare with. */
const PARITY_COURTS: readonly Court[] = ["ns", "us"];
/** Mirror NSS holds the regional administrative courts too; caselaw_search's lane does not. */
const NSS_COURT = "Nejvyšší správní soud";
const API_URL = process.env.MIRROR_API_URL ?? "https://dawmain-databaze.davidzavada.cz";

interface Query {
  id: string;
  q: string;
  courts?: Court[];
  expect?: Partial<Record<Court, string[]>>;
}
interface Hit {
  id: string;
  caseNumber: string;
}
interface Lane {
  ms: number;
  total?: number | null;
  hits: Hit[];
  error?: string;
}
interface CourtRow {
  ms: number;
  liveMs: number | null;
  error: string | null;
  /** Of the live top k, the share in the mirror's top k / top 2k (null where not compared). */
  strict: number | null;
  loose: number | null;
  recall: number | null;
  mrr: number | null;
  top: string[];
  liveTop: string[];
  missed: string[];
}
interface Baseline {
  takenAt: string;
  k: number;
  results: Record<string, Partial<Record<Court, Lane>>>;
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** "8 Ads 53/2024-29, č. 4644/2024 Sb. NSS", "Pl.ÚS 24/07 #3" and "Pl. ÚS 24/07" are one case. */
function caseKey(caseNumber: string): string {
  return caseNumber
    .split(/[,;]/)[0]
    .replace(/#\d+$/, "")
    .replace(/-\s*\d+\s*$/, "")
    .replace(/[\s.]/g, "")
    .toLowerCase();
}

async function lane(run: () => Promise<Omit<Lane, "ms">>): Promise<Lane> {
  const started = performance.now();
  try {
    return { ...(await run()), ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { ms: Math.round(performance.now() - started), hits: [], error: String((error as Error).message).slice(0, 120) };
  }
}

/** The lanes of caselaw_search (src/mcp/tools/cz-caselaw.ts), asked the same way. */
function live(court: Court, q: string, k: number): Promise<Lane> {
  const deadlineAt = Date.now() + 20_000;
  if (court === "ns")
    return lane(async () => {
      const r = await searchNs({ query: q }, 0, k, { deadlineAt });
      return { total: r.matched ?? r.total, hits: r.hits.slice(0, k).map((h) => ({ id: h.unid.toUpperCase(), caseNumber: h.caseNumbers[0] ?? "?" })) };
    });
  if (court === "nss")
    return lane(async () => {
      const r = await searchNss({ query: q, court: "nss" }, 1);
      return { total: r.total, hits: r.hits.slice(0, k).map((h) => ({ id: String(h.id), caseNumber: h.caseNumber ?? "?" })) };
    });
  return lane(async () => {
    const r = await searchNalus({ query: q, sort: "relevance" }, 0, 20, { deadlineAt });
    return { total: r.total, hits: r.hits.filter((h) => h.sz).slice(0, k).map((h) => ({ id: h.sz as string, caseNumber: h.caseNumber })) };
  });
}

type MirrorSearch = (court: Court, q: string, limit: number) => Promise<Lane>;

function dbSearch(): { search: MirrorSearch; close: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString: process.env.MIRROR_READER_URL ?? "postgres://mirror_reader@localhost:5433/mirror", max: 4 });
  const db = poolDb(pool);
  return {
    search: (court, q, limit) =>
      lane(async () => {
        const r = await searchDecisions(db, { q, sources: [court], court: court === "nss" ? NSS_COURT : undefined, limit, bm25: true });
        return { hits: r.hits.map((h) => ({ id: h.id, caseNumber: h.caseNumber ?? "?" })) };
      }),
    close: () => pool.end(),
  };
}

function apiSearch(): { search: MirrorSearch; close: () => Promise<void> } {
  const dir = `${homedir()}/.config/dawmain`;
  const env = Object.fromEntries(
    readFileSync(`${dir}/cf-access.env`, "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]),
  );
  const headers = {
    Authorization: `Bearer ${readFileSync(`${dir}/mirror-api-token`, "utf8").trim()}`,
    "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID ?? "",
    "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET ?? "",
  };
  return {
    search: (court, q, limit) =>
      lane(async () => {
        const url = new URL("/v1/search", API_URL);
        url.searchParams.set("q", q);
        url.searchParams.set("source", court);
        url.searchParams.set("limit", String(limit));
        if (court === "nss") url.searchParams.set("court", NSS_COURT);
        const response = await fetch(url, { headers });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { hits: { id: string; caseNumber: string | null }[] };
        return { hits: body.hits.map((h) => ({ id: h.id, caseNumber: h.caseNumber ?? "?" })) };
      }),
    close: async () => undefined,
  };
}

const ratio = (n: number, d: number) => (d === 0 ? null : n / d);
const mean = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const pct = (x: number | null) => (x === null ? "  – " : `${Math.round(x * 100)} %`.padStart(4));
const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? 0;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const k = Number(option(args, "--k") ?? 10);
  if (!(Number.isInteger(k) && k >= 1 && k <= 20)) {
    console.error("--k must be 1–20");
    return 2;
  }
  const queryFile = option(args, "--queries") ?? "scripts/mirror-eval.json";
  const baselineFile = option(args, "--baseline") ?? "scripts/mirror-eval.baseline.json";
  const queries = (JSON.parse(readFileSync(queryFile, "utf8")) as { queries: Query[] }).queries;
  if (!Array.isArray(queries) || queries.some((q) => !q.id || !q.q)) {
    console.error(`${queryFile}: every query needs id and q`);
    return 2;
  }

  let baseline: Baseline | null = null;
  if (!args.includes("--refresh-live")) {
    try {
      baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as Baseline;
    } catch {
      baseline = null;
    }
  }
  if (!baseline || baseline.k < k || queries.some((q) => !baseline!.results[q.id])) {
    const kept = baseline?.k && baseline.k >= k ? baseline.results : {};
    const results: Baseline["results"] = { ...kept };
    for (const query of queries) {
      if (results[query.id]) continue;
      const courts = query.courts ?? COURTS;
      const lanes = await Promise.all(courts.map((c) => live(c, query.q, Math.max(k, 10))));
      results[query.id] = Object.fromEntries(courts.map((c, i) => [c, lanes[i]]));
      if (!args.includes("--json")) console.error(`live: ${query.id} ${lanes.map((l, i) => `${courts[i]} ${l.ms} ms${l.error ? ` (${l.error})` : ""}`).join(", ")}`);
    }
    baseline = { takenAt: new Date().toISOString(), k: Math.max(k, 10), results };
    writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 1)}\n`);
  }

  const target = args.includes("--api") ? apiSearch() : dbSearch();
  const rows: { id: string; q: string; courts: Partial<Record<Court, CourtRow>> }[] = [];
  try {
    for (const query of queries) {
      const courts = query.courts ?? COURTS;
      const lanes = await Promise.all(courts.map((c) => target.search(c, query.q, 2 * k)));
      const perCourt: Partial<Record<Court, CourtRow>> = {};
      courts.forEach((court, i) => {
        const mirror = lanes[i];
        const liveLane = baseline!.results[query.id]?.[court];
        const ids = mirror.hits.map((h) => h.id.toUpperCase());
        const liveIds = (liveLane?.hits ?? []).slice(0, k).map((h) => h.id.toUpperCase());
        const parity = PARITY_COURTS.includes(court) && liveIds.length > 0;
        const keys = mirror.hits.map((h) => caseKey(h.caseNumber));
        const expected = (query.expect?.[court] ?? []).map(caseKey);
        const ranks = expected.map((e) => keys.indexOf(e));
        perCourt[court] = {
          ms: mirror.ms,
          liveMs: liveLane?.ms ?? null,
          error: mirror.error ?? null,
          strict: parity ? ratio(liveIds.filter((id) => ids.slice(0, k).includes(id)).length, liveIds.length) : null,
          loose: parity ? ratio(liveIds.filter((id) => ids.includes(id)).length, liveIds.length) : null,
          recall: expected.length ? ratio(ranks.filter((r) => r >= 0 && r < k).length, expected.length) : null,
          mrr: expected.length ? mean(ranks.map((r) => (r >= 0 && r < k ? 1 / (r + 1) : 0))) : null,
          top: mirror.hits.slice(0, k).map((h) => h.caseNumber),
          liveTop: (liveLane?.hits ?? []).slice(0, k).map((h) => h.caseNumber),
          missed: parity ? (liveLane?.hits ?? []).slice(0, k).filter((h) => !ids.includes(h.id.toUpperCase())).map((h) => h.caseNumber) : [],
        };
      });
      rows.push({ id: query.id, q: query.q, courts: perCourt });
    }
  } finally {
    await target.close();
  }

  const of = (court: Court) => rows.map((r) => r.courts[court]).filter((c): c is CourtRow => Boolean(c));
  const summary = Object.fromEntries(
    COURTS.map((court) => {
      const cs = of(court);
      return [
        court,
        {
          queries: cs.length,
          errors: cs.filter((c) => c.error).length,
          strict: mean(cs.map((c) => c.strict)),
          loose: mean(cs.map((c) => c.loose)),
          recall: mean(cs.map((c) => c.recall)),
          mrr: mean(cs.map((c) => c.mrr)),
          msMedian: quantile(cs.map((c) => c.ms), 0.5),
          msP95: quantile(cs.map((c) => c.ms), 0.95),
          liveMsMedian: quantile(cs.map((c) => c.liveMs ?? 0), 0.5),
        },
      ];
    }),
  );

  if (args.includes("--json")) {
    console.log(JSON.stringify({ k, target: args.includes("--api") ? "api" : "db", baselineTakenAt: baseline.takenAt, summary, rows }, null, 2));
    return 0;
  }
  if (args.includes("--verbose")) {
    for (const row of rows) {
      console.log(`\n${row.id}: ${row.q}`);
      for (const [court, c] of Object.entries(row.courts) as [Court, CourtRow][]) {
        console.log(`  ${court.padEnd(3)} ${c.ms} ms  parity ${pct(c.strict)} / ${pct(c.loose)}${c.error ? `  ERROR ${c.error}` : ""}`);
        console.log(`      mirror: ${c.top.slice(0, 5).join(" · ")}`);
        console.log(`      live:   ${c.liveTop.slice(0, 5).join(" · ")}`);
        if (c.missed.length) console.log(`      missed: ${c.missed.join(" · ")}`);
      }
    }
    console.log("");
  }
  console.log(`k = ${k} · ${args.includes("--api") ? "API" : "DB"} · live baseline ${baseline.takenAt.slice(0, 16)}`);
  console.log("court  queries  parity@k  parity@2k  recall  MRR    mirror ms (med/p95)  live ms (med)");
  for (const court of COURTS) {
    const s = summary[court] as Record<string, number | null>;
    console.log(
      `${court.padEnd(5)}  ${String(s.queries).padStart(7)}  ${pct(s.strict).padStart(8)}  ${pct(s.loose).padStart(9)}  ${pct(s.recall).padStart(6)}  ${s.mrr === null ? "  – " : s.mrr.toFixed(2)}   ${`${s.msMedian}/${s.msP95}`.padStart(19)}  ${String(s.liveMsMedian).padStart(13)}${s.errors ? `  (${s.errors} errors)` : ""}`,
    );
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
