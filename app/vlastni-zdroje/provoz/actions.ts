"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { isOperator, recordReindex, writeModeOverride } from "@/src/files/operator";
import { reindexBatch } from "@/src/files/reindex";

/**
 * Server Functions of the operator page. Each re-authenticates with Clerk
 * and re-checks the operator list itself — a Server Function is a public
 * endpoint, reachable without ever rendering the page.
 */

const PAGE = "/vlastni-zdroje/provoz";

async function operator(): Promise<string> {
  let userId: string | null = null;
  try {
    ({ userId } = await auth());
  } catch {
    userId = null;
  }
  if (!isOperator(userId)) throw new Error("Not allowed.");
  return userId;
}

/** Mode override: "on" | "readonly" | "off" restrict; "auto" leaves it to env and the guards. */
export async function setModeOverride(formData: FormData): Promise<void> {
  const actor = await operator();
  const value = String(formData.get("mode") ?? "");
  if (!["on", "readonly", "off", "auto"].includes(value)) throw new Error("Invalid mode.");
  await writeModeOverride(actor, value);
  revalidatePath(PAGE);
}

/** "Přeindexovat dávku": re-derive up to 200 documents built by an older analyzer. */
export async function reindexBatchAction(): Promise<void> {
  const actor = await operator();
  const report = await reindexBatch();
  await recordReindex(actor, report);
  revalidatePath(PAGE);
}
