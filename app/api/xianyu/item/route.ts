import { createConfiguredXianyuSession } from "../../../../lib/xianyu-session";
import { getListingDetails } from "../../../../lib/xianyu-items";
import { requireOwnerAccess } from "../../../../lib/access";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const denied = await requireOwnerAccess(request);
  if (denied) return denied;
  const itemId = new URL(request.url).searchParams.get("id")?.trim();
  if (!itemId) {
    return Response.json({ error: "缺少闲鱼商品编号" }, { status: 400 });
  }
  try {
    const session = await createConfiguredXianyuSession();
    const item = await getListingDetails(session, itemId);
    return Response.json({ item });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "读取商品详情失败" },
      { status: 502 },
    );
  }
}
