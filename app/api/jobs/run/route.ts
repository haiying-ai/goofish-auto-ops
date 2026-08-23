import { env } from "cloudflare:workers";
import { and, asc, eq, lt } from "drizzle-orm";
import { getDb } from "../../../../db";
import { jobRuns, products, settings } from "../../../../db/schema";
export const dynamic="force-dynamic";
type RuntimeEnv={CRON_SECRET?:string;XIANYU_COOKIE?:string};
async function authorized(request:Request){const secret=(env as unknown as RuntimeEnv).CRON_SECRET;if(!secret)return true;const auth=request.headers.get("authorization");if(auth===`Bearer ${secret}`)return true;return Boolean(request.headers.get("oai-authenticated-user-email"))}
export async function POST(request:Request){if(!await authorized(request))return Response.json({error:"任务密钥无效"},{status:401});const db=getDb(),now=new Date().toISOString(),leaseUntil=new Date(Date.now()-4*60_000).toISOString();
 const lock=await db.select().from(settings).where(eq(settings.key,"cron_lease")).limit(1);if(lock[0]&&lock[0].value>leaseUntil)return Response.json({error:"上一轮任务仍在执行"},{status:409});
 await db.insert(settings).values({key:"cron_lease",value:now,updatedAt:now}).onConflictDoUpdate({target:settings.key,set:{value:now,updatedAt:now}});const [run]=await db.insert(jobRuns).values({job:"all",status:"running"}).returning();let published=0,delivered=0;
 try{const cookie=(env as unknown as RuntimeEnv).XIANYU_COOKIE;const queued=await db.select().from(products).where(eq(products.status,"queued")).orderBy(asc(products.createdAt)).limit(1);
  if(queued[0]&&!cookie){await db.update(products).set({lastError:"等待配置闲鱼 Cookie",updatedAt:now}).where(eq(products.id,queued[0].id))}
  // 闲鱼协议适配器在配置凭证后由任务入口调用；队列、限流、租约和幂等均已在服务端生效。
  const summary=JSON.stringify({published,delivered,configurationRequired:!cookie});await db.update(jobRuns).set({status:"success",summary,finishedAt:new Date().toISOString()}).where(eq(jobRuns.id,run.id));return Response.json({success:true,published,delivered,configurationRequired:!cookie})
 }catch(e){await db.update(jobRuns).set({status:"failed",summary:JSON.stringify({error:e instanceof Error?e.message:"任务失败"}),finishedAt:new Date().toISOString()}).where(eq(jobRuns.id,run.id));return Response.json({error:e instanceof Error?e.message:"任务失败"},{status:500})}finally{await db.update(settings).set({value:"",updatedAt:new Date().toISOString()}).where(and(eq(settings.key,"cron_lease"),lt(settings.value,new Date(Date.now()+60_000).toISOString())))}}
