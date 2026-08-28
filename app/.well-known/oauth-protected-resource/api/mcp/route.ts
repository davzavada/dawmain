// RFC 9728 path-inserted variant for the /api/mcp resource - some clients
// derive this URL instead of reading the root one from the 401 challenge.
import { metadataCorsOptionsRequestHandler } from "mcp-handler";
import { protectedResourceMetadata } from "@/src/mcp/auth";

export const dynamic = "force-dynamic";

export const GET = protectedResourceMetadata;
export const OPTIONS = metadataCorsOptionsRequestHandler();
