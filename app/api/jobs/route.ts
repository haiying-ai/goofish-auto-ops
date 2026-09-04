import { desc } from "drizzle-orm";
import { getDb } from "../../../db";
import { jobRuns } from "../../../db/schema";
import { requireOwnerAccess } from "../../../lib/access";
export const dynamic="force-dynamic";
export async function GET(request: Request){const denied=await requireOwnerAccess(request);if(denied)return denied;try{return Response.json({runs:await getDb().select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(50)})}catch(e){return Response.json({error:e instanceof Error?e.message:"读取失败"},{status:500})}}
