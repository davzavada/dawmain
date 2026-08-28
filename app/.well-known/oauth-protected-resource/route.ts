import { metadataCorsOptionsRequestHandler } from "mcp-handler";
import { protectedResourceMetadata } from "@/src/mcp/auth";

// The metadata embeds the request's public origin, so it can't be static.
export const dynamic = "force-dynamic";

export const GET = protectedResourceMetadata;
export const OPTIONS = metadataCorsOptionsRequestHandler();
