import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { inventory, products } from "../../../db/schema";
export const dynamic="force-dynamic";
export async function GET(){try{const db=getDb();const rows=await db.select({id:products.id,title:products.title,xianyuItemId:products.xianyuItemId,status:products.status,deliveryType:products.deliveryType,deliveryContent:products.deliveryContent,available:sql<number>`sum(case when ${inventory.status} = 'available' then 1 else 0 end)`,used:sql<number>`sum(case when ${inventory.status} = 'used' then 1 else 0 end)`}).from(products).leftJoin(inventory,eq(inventory.productId,products.id)).where(eq(products.status,"published")).groupBy(products.id).orderBy(asc(products.title));return Response.json({rules:rows.map(r=>({...r,available:Number(r.available||0),used:Number(r.used||0)}))})}catch(e){return Response.json({error:e instanceof Error?e.message:"读取发货规则失败"},{status:500})}}
