import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { inventory, products } from "../../../db/schema";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await getDb()
      .select({
        id: products.id,
        title: products.title,
        xianyuItemId: products.xianyuItemId,
        status: products.status,
        deliveryType: products.deliveryType,
        deliveryContent: products.deliveryContent,
        available: sql<number>`sum(case when ${inventory.status} = 'available' then 1 else 0 end)`,
        reserved: sql<number>`sum(case when ${inventory.status} = 'reserved' then 1 else 0 end)`,
        used: sql<number>`sum(case when ${inventory.status} = 'used' then 1 else 0 end)`,
      })
      .from(products)
      .leftJoin(inventory, eq(inventory.productId, products.id))
      .groupBy(products.id)
      .orderBy(asc(products.title));
    return Response.json({
      rules: rows.map((row) => ({
        ...row,
        available: Number(row.available || 0),
        reserved: Number(row.reserved || 0),
        used: Number(row.used || 0),
      })),
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "读取发货规则失败",
      },
      { status: 500 },
    );
  }
}
