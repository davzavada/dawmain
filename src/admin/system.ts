import "server-only";
import { statfs } from "node:fs/promises";
import os from "node:os";
import { withScope } from "@/src/files/db/client";
import { listAllLibraries } from "@/src/files/db/libraries";
import { dbUsage, getSystemState } from "@/src/files/db/usage";
import { GUARDS_STATE_KEY } from "@/src/files/guards";
import { appEnvironment, appRegion, gitCommit } from "@/src/runtime";
import { mirrorApiStatus, mirrorConfigured, type MirrorStatusJson } from "@/src/sources/mirror";

/**
 * What the Systém tab of the admin area shows (app/sprava/system/page.tsx):
 * this web process and its machine, the two databases and the regular jobs.
 * Every part is read on its own and comes back null when it cannot be, so
 * one missing piece (no files database, the mirror down) never blanks the
 * page. Counts and sizes only.
 */

export interface ServerInfo {
  /** Seconds this web process has been running. */
  uptimeSec: number;
  startedAt: string;
  commit: string | null;
  environment: string;
  region: string | null;
  hostname: string;
  node: string;
  /** Resident memory of the process, and the machine's total. */
  rssBytes: number;
  totalMemBytes: number;
  /** The 15-minute load average (0 where the OS has none). */
  load15: number;
  cpus: number;
}

export interface DiskInfo {
  freeBytes: number;
  totalBytes: number;
}

export interface FilesDbInfo {
  dbBytes: number;
  libraries: number;
  documents: number;
  pages: number;
  /** The daily cron's last run (its `at`), or null. */
  cronAt: string | null;
}

export interface MirrorInfo {
  configured: boolean;
  status: MirrorStatusJson | null;
  problem: string | null;
}

export interface SystemSnapshot {
  server: ServerInfo;
  disk: DiskInfo | null;
  files: FilesDbInfo | null;
  mirror: MirrorInfo;
}

function serverInfo(now: Date): ServerInfo {
  const uptimeSec = Math.round(process.uptime());
  return {
    uptimeSec,
    startedAt: new Date(now.getTime() - uptimeSec * 1000).toISOString(),
    commit: gitCommit(),
    environment: appEnvironment(),
    region: appRegion(),
    hostname: os.hostname(),
    node: process.version,
    rssBytes: process.memoryUsage().rss,
    totalMemBytes: os.totalmem(),
    load15: os.loadavg()[2] ?? 0,
    cpus: os.cpus().length,
  };
}

async function diskInfo(): Promise<DiskInfo | null> {
  try {
    const s = await statfs(process.cwd());
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

async function filesInfo(): Promise<FilesDbInfo | null> {
  try {
    return await withScope([], async (db) => {
      const size = await dbUsage(db);
      const libraries = await listAllLibraries(db);
      const cron = await getSystemState<{ at?: unknown }>(db, GUARDS_STATE_KEY);
      return {
        dbBytes: size.dbBytes,
        libraries: libraries.length,
        documents: libraries.reduce((n, l) => n + Number(l.doc_count ?? 0), 0),
        pages: libraries.reduce((n, l) => n + Number(l.page_count ?? 0), 0),
        cronAt: typeof cron?.at === "string" ? cron.at : null,
      };
    });
  } catch {
    return null;
  }
}

async function mirrorInfo(): Promise<MirrorInfo> {
  if (!mirrorConfigured()) return { configured: false, status: null, problem: "Na tomto nasazení chybí MIRROR_API_URL / MIRROR_API_TOKEN." };
  try {
    const status = await mirrorApiStatus();
    return { configured: true, status, problem: status ? null : "Zrcadlo neodpovídá (404)." };
  } catch (error) {
    return { configured: true, status: null, problem: error instanceof Error ? error.message : String(error) };
  }
}

export async function systemSnapshot(now = new Date()): Promise<SystemSnapshot> {
  const [disk, files, mirror] = await Promise.all([diskInfo(), filesInfo(), mirrorInfo()]);
  return { server: serverInfo(now), disk, files, mirror };
}
