import SparkMD5 from "spark-md5";

const APP_KEY="34839810", HOST="https://h5api.m.goofish.com";
export function cookieValue(cookie:string,name:string){const part=cookie.split(";").map(x=>x.trim()).find(x=>x.startsWith(`${name}=`));return part?.slice(name.length+1)||""}
export async function mtop(cookie:string,api:string,data:unknown,options:{version?:string;spm?:string}={}){
 const token=cookieValue(cookie,"_m_h5_tk").split("_")[0];if(!token)throw new Error("Cookie 缺少 _m_h5_tk");
 const t=Date.now().toString(),body=JSON.stringify(data),sign=SparkMD5.hash(`${token}&${t}&${APP_KEY}&${body}`),version=options.version||"1.0";
 const query=new URLSearchParams({jsv:"2.7.2",appKey:APP_KEY,t,sign,v:version,type:"originaljson",accountSite:"xianyu",dataType:"json",timeout:"20000",api,sessionOption:"AutoLoginOnly",spm_cnt:options.spm||"a21ybx.home.0.0"});
 const response=await fetch(`${HOST}/h5/${api}/${version}/?${query}`,{method:"POST",headers:{accept:"application/json","content-type":"application/x-www-form-urlencoded",origin:"https://www.goofish.com",referer:"https://www.goofish.com/",cookie,"user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0 Safari/537.36"},body:new URLSearchParams({data:body})});
 if(!response.ok)throw new Error(`闲鱼接口 HTTP ${response.status}`);const raw=await response.json() as {ret?:string[];data?:Record<string,unknown>};const ret=(raw.ret||[]).join(" | ");if(ret&&!ret.includes("SUCCESS"))throw new Error(ret);return raw;
}
