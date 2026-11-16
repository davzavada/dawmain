import { beforeEach, describe, expect, it, vi } from "vitest";

/** GET /api/status/mirror: the decision counts per mirrored court for the home page. */

const mirror = vi.hoisted(() => ({ configured: true, status: vi.fn() }));
vi.mock("@/src/sources/mirror", () => ({
  mirrorConfigured: () => mirror.configured,
  mirrorApiStatus: mirror.status,
}));

import { GET } from "@/app/api/status/mirror/route";

describe("GET /api/status/mirror", () => {
  beforeEach(() => {
    mirror.configured = true;
    mirror.status.mockReset();
  });

  it("answers the four mirrored courts' counts and nothing else", async () => {
    mirror.status.mockResolvedValue({
      asOf: "2026-11-16T05:00:00Z",
      sources: [
        { source: "ns", decisions: 120 },
        { source: "nss", decisions: 80 },
        { source: "us", decisions: 40 },
        { source: "justice", decisions: 10 },
        { source: "sdeu", decisions: 5 },
        { source: "ns-extra" },
      ],
    });
    expect(await (await GET()).json()).toEqual({ ns: 120, nss: 80, us: 40, justice: 10 });
  });

  it("is empty without a mirror, or when it fails", async () => {
    mirror.configured = false;
    expect(await (await GET()).json()).toEqual({});
    expect(mirror.status).not.toHaveBeenCalled();
    mirror.configured = true;
    mirror.status.mockRejectedValue(new Error("down"));
    expect(await (await GET()).json()).toEqual({});
  });
});
