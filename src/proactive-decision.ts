import type {LearningSummary} from "./study-options.ts";
export type DecisionFacts = {
 place:"library"|"cafe"|"home"|"dorm_room"|"classroom"|"campus_building";
 stableMinutes:number;locationAgeSeconds:number;accuracyMeters:number;freeMinutes:number;plannedMinutes:number;acceptedRecently:number;skippedRecently:number;
 learning?:LearningSummary;
};
export type PromptDecision={action:"stay_quiet"|"offer_study";reason:"useful_window"|"uncertain_context"|"poor_timing"|"recent_decline";confidence:number;optionId?:string|null};
export function validateDecision(value:unknown):PromptDecision{
 const v=value as Record<string,unknown>|null;
 const keys=v?Object.keys(v).sort().join(","):"";
 if(!v||!["action,confidence,reason","action,confidence,optionId,reason"].includes(keys)
  ||!["stay_quiet","offer_study"].includes(String(v.action))||!["useful_window","uncertain_context","poor_timing","recent_decline"].includes(String(v.reason))
  ||typeof v.confidence!=="number"||!Number.isFinite(v.confidence)||v.confidence<0||v.confidence>1
  ||(v.action==="offer_study"&&v.reason!=="useful_window")
  ||(v.optionId!==undefined&&v.optionId!==null&&(typeof v.optionId!=="string"||v.optionId.length>80))
  ||(v.action==="stay_quiet"&&v.optionId!=null))throw Error("Invalid proactive decision");
 return v as PromptDecision;
}
export function validateSelectedOption(decision:PromptDecision,facts:DecisionFacts):PromptDecision{
 if(decision.action==="offer_study"&&facts.learning){
  const option=facts.learning.options.find(o=>o.id===decision.optionId);
  if(!option||!Number.isInteger(option.minutes)||option.minutes<25||option.minutes>45||option.minutes>facts.freeMinutes)throw Error("Invalid study option");
 }
 return decision;
}
const instructions="You coordinate a personal study assistant. Rules already checked fresh stable location, calendar availability, quiet hours and notification limits. Choose whether one study invitation is useful now. Prefer staying quiet over weak or repetitive offers. If learning.options are supplied, choose exactly one existing optionId or stay_quiet with optionId:null. Options are already ranked by a shared-feature LinUCB model using productivity (70%) and mood (30%) plus an exploration bonus. Use learned outcomes and uncertainty to compare options, but consider shorter sessions after recent declines. Low predicted outcomes are evidence to reconsider, not proof of causation. Historical workspace profiles are NOT observations of current seating/lighting/comfort, and predictions are category-level associations, not named-building effects. Never invent current context, sample counts or benefits; unknown options have no personal predictions. Sparse history, old profiles, and cloudUnavailable weaken evidence. An empty calendar is not proof the user is available. Do not treat a skipped invitation as a bad productivity rating. You cannot create events, send texts or change stored feedback. offer_study must have reason useful_window. Output only the decision schema. Confidence is subjective, not calibrated.";
const schema={type:"object",properties:{action:{type:"string",enum:["stay_quiet","offer_study"]},reason:{type:"string",enum:["useful_window","uncertain_context","poor_timing","recent_decline"]},confidence:{type:"number",minimum:0,maximum:1},optionId:{type:["string","null"]}},required:["action","reason","confidence","optionId"],additionalProperties:false};
export function coordinatorProvider():"gemini"|"grok"{
 const requested=process.env.STUDY_COORDINATOR_PROVIDER;
 const selected=requested??(process.env.GEMINI_API_KEY&&process.env.GEMINI_MODEL?"gemini":"grok");
 if(selected!=="gemini"&&selected!=="grok")throw Error("Invalid coordinator provider");
 return selected;
}
export async function decidePrompt(facts:DecisionFacts,request:typeof fetch=fetch):Promise<PromptDecision>{
 let output:string;
 if(coordinatorProvider()==="gemini"){
  const key=process.env.GEMINI_API_KEY,model=process.env.GEMINI_MODEL;
  if(!key||!model||!/^[a-zA-Z0-9._-]+$/.test(model))throw Error("Configure GEMINI_API_KEY and GEMINI_MODEL for the coordinator");
  const r=await request(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,{
   method:"POST",headers:{"x-goog-api-key":key,"Content-Type":"application/json"},redirect:"error",signal:AbortSignal.timeout(20000),
   body:JSON.stringify({systemInstruction:{parts:[{text:instructions}]},contents:[{role:"user",parts:[{text:JSON.stringify(facts)}]}],generationConfig:{responseMimeType:"application/json",responseJsonSchema:schema,maxOutputTokens:2048}}),
  });
  if(!r.ok)throw Error("Gemini coordinator request failed");
  const data=await r.json() as {candidates?:{finishReason?:string;content?:{parts?:{text?:string;thought?:boolean}[]}}[]};
  const candidate=data.candidates?.[0];
  if(candidate?.finishReason!=="STOP")throw Error("Incomplete Gemini decision");
  output=candidate.content?.parts?.filter(p=>!p.thought).map(p=>p.text??"").join("")??"";
 }else{
  if(!process.env.XAI_API_KEY)throw Error("Decision model unavailable");
  const r=await request("https://api.x.ai/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${process.env.XAI_API_KEY}`,"Content-Type":"application/json"},redirect:"error",signal:AbortSignal.timeout(20000),body:JSON.stringify({model:process.env.XAI_MODEL??"grok-4.7",store:false,instructions,input:JSON.stringify(facts),text:{format:{type:"json_schema",name:"study_invitation",strict:true,schema}}})});
  if(!r.ok)throw Error("Grok coordinator request failed");
  const data=await r.json() as {status?:string;output?:{type:string;content?:{type:string;text?:string}[]}[]};
  if(data.status!=="completed")throw Error("Incomplete Grok decision");
  output=data.output?.filter(o=>o.type==="message").flatMap(o=>o.content??[]).filter(c=>c.type==="output_text").map(c=>c.text??"").join("")??"";
 }
 if(!output)throw Error("Empty coordinator decision");
 return validateSelectedOption(validateDecision(JSON.parse(output)),facts);
}
