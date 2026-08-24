import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../db";
import { inventory } from "../../../db/schema";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const productId = Number(
      new URL(request.url).searchParams.get("productId"),
    );
    if (!productId) {
      return Response.json({ error: "商品编号无效" }, { status: 400 });
    }
    const rows = await getDb()
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId))
      .orderBy(asc(inventory.id));
    return Response.json({ inventory: rows });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "读取卡密失败" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as {
      productId?: number;
      secrets?: string;
    };
    const productId = Number(input.productId);
    const secrets = [
      ...new Set(
        String(input.secrets || "")
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    if (!productId || !secrets.length) {
      return Response.json(
        { error: "商品和卡密不能为空" },
        { status: 400 },
      );
    }
    const db = getDb();
    const existing = await db
      .select({ secret: inventory.secret })
      .from(inventory)
      .where(
        and(
          eq(inventory.productId, productId),
          inArray(inventory.secret, secrets),
        ),
      );
    const seen = new Set(existing.map((row) => row.secret));
    const fresh = secrets.filter((secret) => !seen.has(secret));
    if (fresh.length) {
      await db
        .insert(inventory)
        .values(fresh.map((secret) => ({ productId, secret })));
    }
    return Response.json(
      { added: fresh.length, skipped: secrets.length - fresh.length },
      { status: 201 },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "导入失败" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const input = (await request.json()) as { id?: number };
    const id = Number(input.id);
    if (!id) return Response.json({ error: "卡密编号无效" }, { status: 400 });
    const [row] = await getDb()
      .delete(inventory)
      .where(and(eq(inventory.id, id), eq(inventory.status, "available")))
      .returning();
    if (!row) {
      return Response.json(
        { error: "只有未使用的卡密可以删除" },
        { status: 409 },
      );
    }
    return Response.json({ deleted: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "删除失败" },
      { status: 500 },
    );
  }
}
