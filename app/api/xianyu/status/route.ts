import { env } from "cloudflare:workers";
import { cookieValue, mtop } from "../../../../lib/xianyu";
export const dynamic="force-dynamic";
type RuntimeEnv={XIANYU_COOKIE?:string};
export async function GET(){const cookie=(env as unknown as RuntimeEnv).XIANYU_COOKIE;if(!cookie)return Response.json({valid:false,error:"尚未配置闲鱼 Cookie"},{status:503});try{const raw=await mtop(cookie,"mtop.taobao.idlemessage.pc.loginuser.get",{}, {spm:"a21ybx.im.0.0"});const user=raw.data||{};return Response.json({valid:true,nick:String(user.nick||""),accountConfigured:Boolean(cookieValue(cookie,"unb"))})}catch(e){return Response.json({valid:false,error:e instanceof Error?e.message:"登录验证失败"},{status:401})}}
