// RFC 8414 metadata proxied from Clerk - for clients that look for the
// authorization server on the resource's own domain instead of following
// the RFC 9728 protected-resource pointer.
import { metadataCorsOptionsRequestHandler } from "mcp-handler";
import { authorizationServerMetadata } from "@/src/mcp/auth";

export const dynamic = "force-dynamic";

export const GET = authorizationServerMetadata;
export const OPTIONS = metadataCorsOptionsRequestHandler();
