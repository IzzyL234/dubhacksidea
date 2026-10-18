export type Turn={role:"user"|"model";parts:{text:string}[]};
export class GeminiHttpError extends Error {constructor(public status:number,public retryMs?:number,public provider="Gemini"){super(`${provider} request failed: HTTP ${status}`);}}
export async function generateGemini(instructions:string,contents:Turn[],schema?:unknown,request:typeof fetch=fetch,pause:(ms:number)=>Promise<void>=ms=>new Promise(resolve=>setTimeout(resolve,ms))):Promise<string>{
 const key=process.env.GEMINI_API_KEY;
 const model=process.env.GEMINI_MODEL??"gemini-3.5-flash";
 if(!key)throw Error("Configure GEMINI_API_KEY");
 if(!/^[a-zA-Z0-9._-]+$/.test(model))throw Error("Invalid GEMINI_MODEL");
 let response:Response;
 for(let attempt=0;;attempt++){
 response=await request(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,{
  method:"POST",headers:{"x-goog-api-key":key,"Content-Type":"application/json"},redirect:"error",signal:AbortSignal.timeout(20000),
  body:JSON.stringify({systemInstruction:{parts:[{text:instructions}]},contents,generationConfig:{maxOutputTokens:4096,...(schema?{responseMimeType:"application/json",responseJsonSchema:schema}:{})}}),
 });
 if(response.ok)break;
 if(![502,503,504].includes(response.status)||attempt===2){
  let retryMs:number|undefined;
  if(response.status===429){try{const data=await response.json() as {error?:{details?:{retryDelay?:string}[]}};const delay=data.error?.details?.find(d=>d.retryDelay)?.retryDelay;if(delay&&/^\d+(?:\.\d+)?s$/.test(delay))retryMs=Math.min(86400000,Math.max(60000,Number(delay.slice(0,-1))*1000));}catch{}}
  throw new GeminiHttpError(response.status,retryMs);
 }
 await response.body?.cancel();
 await pause(1000*2**attempt);
 }
 const data=await response.json() as {candidates?:{finishReason?:string;content?:{parts?:{text?:string;thought?:boolean}[]}}[]};
 const candidate=data.candidates?.[0];
 const text=candidate?.content?.parts?.filter(p=>!p.thought).map(p=>p.text??"").join("").trim();
 if(candidate?.finishReason!=="STOP"||!text)throw Error("Gemini did not return a complete reply");
 return text;
}
