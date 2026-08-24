import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { inventory, orders, products } from "../../../db/schema";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDb();
    const [rows, counts, stock, delivered] = await Promise.all([
      db.select().from(products).orderBy(desc(products.createdAt)),
      db
        .select({ status: products.status, count: sql<number>`count(*)` })
        .from(products)
        .groupBy(products.status),
      db
        .select({ count: sql<number>`count(*)` })
        .from(inventory)
        .where(eq(inventory.status, "available")),
      db
        .select({ count: sql<number>`count(*)` })
        .from(orders)
        .where(eq(orders.status, "delivered")),
    ]);
    const byStatus = Object.fromEntries(
      counts.map((row) => [row.status, Number(row.count)]),
    );
    return Response.json({
      products: rows,
      summary: {
        products: Object.values(byStatus).reduce(
          (total, count) => total + count,
          0,
        ),
        queued: (byStatus.draft || 0) + (byStatus.queued || 0),
        published: byStatus.published || 0,
        inventory: Number(stock[0]?.count || 0),
        delivered: Number(delivered[0]?.count || 0),
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "数据库读取失败" },
      { status: 500 },
    );
  }
}
