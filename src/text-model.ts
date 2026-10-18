import {generateGemini,GeminiHttpError,type Turn} from "./gemini.ts";
export function textProvider():"xai"|"gemini"{const provider=process.env.AI_PROVIDER??"xai";if(provider!=="xai"&&provider!=="gemini")throw Error("AI_PROVIDER must be xai or gemini");return provider;}
export async function generateText(instructions:string,contents:Turn[],schema?:unknown,request:typeof fetch=fetch):Promise<string>{
 if(textProvider()==="gemini")return generateGemini(instructions,contents,schema,request);
 if(!process.env.XAI_API_KEY)throw Error("Configure XAI_API_KEY");
 let response:Response;
 for(let attempt=0;;attempt++){
  response=await request("https://api.x.ai/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${process.env.XAI_API_KEY}`,"Content-Type":"application/json"},redirect:"error",signal:AbortSignal.timeout(20000),body:JSON.stringify({model:process.env.XAI_MODEL??"grok-4.7",store:false,instructions,input:contents.map(t=>({role:t.role==="model"?"assistant":"user",content:t.parts.map(p=>p.text).join("\n")})),max_output_tokens:4096,...(schema?{text:{format:{type:"json_schema",name:"assistant_result",strict:true,schema}}}:{})})});
  if(response.ok)break;
  if(![502,503,504].includes(response.status)||attempt===2)throw new GeminiHttpError(response.status,undefined,"xAI");
  await response.body?.cancel();await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));
 }
 const data=await response.json() as {status?:string;output?:{type:string;content?:{type:string;text?:string}[]}[]};
 const output=data.output?.filter(o=>o.type==="message").flatMap(o=>o.content??[]).filter(p=>p.type==="output_text").map(p=>p.text??"").join("\n").trim();
 if(data.status!=="completed"||!output)throw Error("xAI did not return a complete reply");return output;
}
