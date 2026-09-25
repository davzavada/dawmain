import { cache } from "react";
import { databaseStatuses } from "@/src/mcp/status";

/** The source checks, once per request: the header summary and the home
 * page list share one result. */
export const getStatuses = cache(databaseStatuses);
