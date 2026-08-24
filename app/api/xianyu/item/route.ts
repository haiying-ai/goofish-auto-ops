import { env } from "cloudflare:workers";
import { createXianyuSession } from "../../../../lib/xianyu-session";
import { getListingDetails } from "../../../../lib/xianyu-items";

export const dynamic = "force-dynamic";
type RuntimeEnv = { XIANYU_COOKIE?: string };

export async function GET(request: Request) {
  const cookie = (env as unknown as RuntimeEnv).XIANYU_COOKIE;
  if (!cookie) {
    return Response.json({ error: "尚未配置闲鱼 Cookie" }, { status: 503 });
  }
  const itemId = new URL(request.url).searchParams.get("id")?.trim();
  if (!itemId) {
    return Response.json({ error: "缺少闲鱼商品编号" }, { status: 400 });
  }
  try {
    const session = await createXianyuSession(cookie);
    const item = await getListingDetails(session, itemId);
    return Response.json({ item });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "读取商品详情失败" },
      { status: 502 },
    );
  }
}
