import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { inventory, orders, products } from "../../../db/schema";
export const dynamic="force-dynamic";
export async function GET(){try{const db=getDb();const [rows,counts,stock,delivered]=await Promise.all([
 db.select().from(products).orderBy(desc(products.createdAt)).limit(12),
 db.select({status:products.status,count:sql<number>`count(*)`}).from(products).groupBy(products.status),
 db.select({count:sql<number>`count(*)`}).from(inventory).where(eq(inventory.status,"available")),
 db.select({count:sql<number>`count(*)`}).from(orders).where(eq(orders.status,"delivered"))]);
 const by=Object.fromEntries(counts.map(x=>[x.status,Number(x.count)]));return Response.json({products:rows,summary:{products:Object.values(by).reduce((a,b)=>a+b,0),queued:by.queued||0,published:by.published||0,inventory:Number(stock[0]?.count||0),delivered:Number(delivered[0]?.count||0)}})}catch(e){return Response.json({error:e instanceof Error?e.message:"数据库读取失败"},{status:500})}}
