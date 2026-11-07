import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET as getAppDataInventory } from "@/app/api/app-data/inventory/route";
import { PUT as putCategory } from "@/app/api/component-categories/[id]/route";
import { GET as getExport } from "@/app/api/stack-policy/export/route";
import { GET as getPreview } from "@/app/api/stack-policy/preview/route";
import { GET as getRollup } from "@/app/api/stack-inventory/rollup/route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

const noParams = { params: Promise.resolve({}) };

beforeEach(() => {
  vi.mocked(controlPlaneUserFetch).mockReset();
  vi.mocked(controlPlaneUserFetch).mockImplementation(async () => Response.json({ ok: true }));
});

describe("governance BFF routes", () => {
  it("forwards only the preview target, encoding a nested owner as one value", async () => {
    await getPreview(
      new NextRequest(
        "http://localhost/api/stack-policy/preview?repo=group/sub/app&environmentId=env-1&extra=1"
      ),
      noParams
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/stack-policy/preview?repo=group%2Fsub%2Fapp&environmentId=env-1",
      undefined
    );
  });

  it("previews and exports the workspace-wide policy without a repository", async () => {
    await getPreview(new NextRequest("http://localhost/api/stack-policy/preview"), noParams);
    await getExport(new NextRequest("http://localhost/api/stack-policy/export"), noParams);

    expect(vi.mocked(controlPlaneUserFetch).mock.calls.map(([path]) => path)).toEqual([
      "/stack-policy/preview",
      "/stack-policy/export",
    ]);
  });

  it("relays the control plane's governance denial unchanged", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Forbidden" }, { status: 403 })
    );

    const response = await getRollup(
      new NextRequest("http://localhost/api/stack-inventory/rollup"),
      noParams
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/stack-inventory/rollup", undefined);
    expect(response.status).toBe(403);
  });

  it("addresses a category by its encoded identifier", async () => {
    await putCategory(
      new NextRequest("http://localhost/api/component-categories/web-frontend", {
        method: "PUT",
        headers: { Cookie: "openinspect.session_token=placeholder" },
        body: JSON.stringify({ enforcement: "block" }),
      }),
      { params: Promise.resolve({ id: "web-frontend" }) }
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/component-categories/web-frontend",
      expect.objectContaining({ method: "PUT" })
    );
  });

  it("forwards app data inventory filters", async () => {
    await getAppDataInventory(
      new NextRequest(
        "http://localhost/api/app-data/inventory?classification=restricted&cursor=next&secret=x"
      ),
      noParams
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/app-data/inventory?classification=restricted&cursor=next",
      undefined
    );
  });
});
