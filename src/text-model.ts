import {ModelCooldown} from "./model-rate-limit.ts";
export {textModelFailureReply} from "./model-rate-limit.ts";
const modelCooldown=new ModelCooldown();
import {readFileSync} from "node:fs";
import {generateGemini,GeminiHttpError,type Turn} from "./gemini.ts";
export function selectTextProvider(environment:string|undefined,local?:unknown):"xai"|"gemini"{const provider=local===undefined?environment??"xai":(local as {provider?:unknown})?.provider;if(provider!=="xai"&&provider!=="gemini")throw Error("Text provider must be xai or gemini");return provider;}
export function textProvider():"xai"|"gemini"{let local:unknown;try{local=JSON.parse(readFileSync(new URL("../data/runtime/text-provider.json",import.meta.url),"utf8"));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}return selectTextProvider(process.env.AI_PROVIDER,local);}
export async function generateText(instructions:string,contents:Turn[],schema?:unknown,request:typeof fetch=fetch,options:{reasoningEffort?:"low"}={}):Promise<string>{
 const provider=textProvider();modelCooldown.assertReady(provider);
 if(provider==="gemini"){try{return await generateGemini(instructions,contents,schema,request);}catch(error){modelCooldown.record(provider,error);throw error;}}
 if(!process.env.XAI_API_KEY)throw Error("Configure XAI_API_KEY");
 let response:Response;
 for(let attempt=0;;attempt++){
  response=await request("https://api.x.ai/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${process.env.XAI_API_KEY}`,"Content-Type":"application/json"},redirect:"error",signal:AbortSignal.timeout(20000),body:JSON.stringify({model:process.env.XAI_MODEL??"grok-4.7",store:false,...(options.reasoningEffort&&/^grok-4\.[367](?:$|-)/.test(process.env.XAI_MODEL??"grok-4.7")?{reasoning:{effort:options.reasoningEffort}}:{}),instructions,input:contents.map(t=>({role:t.role==="model"?"assistant":"user",content:t.parts.map(p=>p.text).join("\n")})),max_output_tokens:4096,...(schema?{text:{format:{type:"json_schema",name:"assistant_result",strict:true,schema}}}:{})})});
  if(response.ok)break;
  if(![502,503,504].includes(response.status)||attempt===2){const error=new GeminiHttpError(response.status,undefined,"xAI");modelCooldown.record(provider,error);throw error;}
  await response.body?.cancel();await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));
 }
 const data=await response.json() as {status?:string;output?:{type:string;content?:{type:string;text?:string}[]}[]};
 const output=data.output?.filter(o=>o.type==="message").flatMap(o=>o.content??[]).filter(p=>p.type==="output_text").map(p=>p.text??"").join("\n").trim();
 if(data.status!=="completed"||!output)throw Error("xAI did not return a complete reply");return output;
}
