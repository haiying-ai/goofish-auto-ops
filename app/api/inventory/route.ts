import { and, asc, eq, isNull, or } from "drizzle-orm";
import { getDb } from "../../../db";
import { deliveryRules, inventory } from "../../../db/schema";
import {
  decryptSecret,
  encryptSecret,
  inventoryOwner,
  isEncryptedSecret,
  secretHash,
} from "../../../lib/secrets";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const productId = Number(url.searchParams.get("productId"));
    const ruleId = Number(url.searchParams.get("ruleId")) || null;
    if (!productId) {
      return Response.json({ error: "商品编号无效" }, { status: 400 });
    }
    const db = getDb();
    const rows = await db
      .select()
      .from(inventory)
      .where(await inventoryPoolCondition(productId, ruleId))
      .orderBy(asc(inventory.id));
    return Response.json({
      inventory: await Promise.all(
        rows.map(async (row) => {
          const plain = await decryptSecret(
            "inventory-secret",
            inventoryOwner(row.productId, row.ruleId),
            row.secret,
          );
          if (plain && !isEncryptedSecret(row.secret)) {
            await db
              .update(inventory)
              .set({
                secret: await encryptSecret(
                  "inventory-secret",
                  inventoryOwner(row.productId, row.ruleId),
                  plain,
                ),
                secretHash: row.secretHash || (await secretHash(plain)),
              })
              .where(eq(inventory.id, row.id));
          }
          return { ...row, secret: plain };
        }),
      ),
    });
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
      ruleId?: number | null;
      secrets?: string;
    };
    const productId = Number(input.productId);
    const ruleId = Number(input.ruleId) || null;
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
    if (ruleId) {
      const [rule] = await getDb()
        .select({ id: deliveryRules.id })
        .from(deliveryRules)
        .where(
          and(
            eq(deliveryRules.id, ruleId),
            eq(deliveryRules.productId, productId),
          ),
        )
        .limit(1);
      if (!rule) throw new Error("发货规则与商品不匹配");
    }
    const db = getDb();
    const existing = await db
      .select()
      .from(inventory)
      .where(await inventoryPoolCondition(productId, ruleId));
    const existingHashes = new Set<string>();
    for (const row of existing) {
      const plain = await decryptSecret(
        "inventory-secret",
        inventoryOwner(row.productId, row.ruleId),
        row.secret,
      );
      existingHashes.add(row.secretHash || (await secretHash(plain)));
    }
    const prepared = await Promise.all(
      secrets.map(async (secret) => ({ secret, hash: await secretHash(secret) })),
    );
    const fresh = prepared.filter((entry) => !existingHashes.has(entry.hash));
    if (fresh.length) {
      const owner = inventoryOwner(productId, ruleId);
      await db.insert(inventory).values(
        await Promise.all(
          fresh.map(async (entry) => ({
            productId,
            ruleId,
            secret: await encryptSecret("inventory-secret", owner, entry.secret),
            secretHash: entry.hash,
          })),
        ),
      );
    }
    if (ruleId) {
      await db
        .update(deliveryRules)
        .set({
          lastLowStockLevel: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(deliveryRules.id, ruleId));
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

async function inventoryPoolCondition(productId: number, ruleId: number | null) {
  if (!ruleId) {
    return and(eq(inventory.productId, productId), isNull(inventory.ruleId));
  }
  const [rule] = await getDb()
    .select({ specKey: deliveryRules.specKey })
    .from(deliveryRules)
    .where(eq(deliveryRules.id, ruleId))
    .limit(1);
  return and(
    eq(inventory.productId, productId),
    rule && !rule.specKey
      ? or(eq(inventory.ruleId, ruleId), isNull(inventory.ruleId))
      : eq(inventory.ruleId, ruleId),
  );
}
