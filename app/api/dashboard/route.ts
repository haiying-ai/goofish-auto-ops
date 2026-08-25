import { desc, eq, or, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { inventory, orders, products } from "../../../db/schema";
import { decryptSecret } from "../../../lib/secrets";
import { requireOwnerAccess } from "../../../lib/access";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireOwnerAccess(request);
  if (denied) return denied;
  try {
    const db = getDb();
    const [rows, counts, stock, delivered, needsAttention] = await Promise.all([
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
      db
        .select({ count: sql<number>`count(*)` })
        .from(orders)
        .where(
          or(
            eq(orders.status, "failed"),
            eq(orders.status, "needs_configuration"),
          ),
        ),
    ]);
    const byStatus = Object.fromEntries(
      counts.map((row) => [row.status, Number(row.count)]),
    );
    return Response.json({
      products: await Promise.all(
        rows.map(async (row) => ({
          ...row,
          deliveryContent: await decryptSecret(
            "product-delivery",
            row.id,
            row.deliveryContent,
          ),
        })),
      ),
      summary: {
        products: Object.values(byStatus).reduce(
          (total, count) => total + count,
          0,
        ),
        queued: (byStatus.draft || 0) + (byStatus.queued || 0),
        published: byStatus.published || 0,
        inventory: Number(stock[0]?.count || 0),
        delivered: Number(delivered[0]?.count || 0),
        needsAttention: Number(needsAttention[0]?.count || 0),
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "数据库读取失败" },
      { status: 500 },
    );
  }
}
