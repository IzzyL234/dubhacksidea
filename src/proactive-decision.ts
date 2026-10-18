export type DecisionFacts = {
  place: "library"|"cafe"|"home"|"dorm_room"|"classroom";
  stableMinutes:number; locationAgeSeconds:number; accuracyMeters:number;
  freeMinutes:number; plannedMinutes:number; acceptedRecently:number; skippedRecently:number;
};
export type PromptDecision = {action:"stay_quiet"|"offer_study";reason:"useful_window"|"uncertain_context"|"poor_timing"|"recent_decline";confidence:number};
export function validateDecision(value:unknown):PromptDecision {
  const v=value as Record<string,unknown>|null;
  if(!v||Object.keys(v).sort().join(",")!=="action,confidence,reason"
    ||!["stay_quiet","offer_study"].includes(String(v.action))
    ||!["useful_window","uncertain_context","poor_timing","recent_decline"].includes(String(v.reason))
    ||typeof v.confidence!=="number"||!Number.isFinite(v.confidence)||v.confidence<0||v.confidence>1
    ||(v.action==="offer_study"&&v.reason!=="useful_window"))throw Error("Invalid proactive decision");
  return v as PromptDecision;
}
export async function decidePrompt(facts:DecisionFacts,request:(url:string,init?:RequestInit)=>Promise<Response>=fetch):Promise<PromptDecision> {
  if(!process.env.XAI_API_KEY)throw Error("Decision model unavailable");
  const response=await request("https://api.x.ai/v1/responses",{
    method:"POST",headers:{Authorization:`Bearer ${process.env.XAI_API_KEY}`,"Content-Type":"application/json"},
    signal:AbortSignal.timeout(20000),redirect:"error",
    body:JSON.stringify({model:process.env.XAI_MODEL??"grok-4.7",store:false,
      instructions:"You decide whether a brief study invitation would be useful right now. All supplied facts have passed deterministic freshness, place, calendar, quiet-hours, session, and prompt-budget gates. Be conservative: prefer stay_quiet when evidence is weak, recent invitations were declined, or the remaining window is marginal. An empty calendar isn't proof of availability, and a saved place isn't proof of studying. Return only the decision schema. You cannot create events or send messages. Use offer_study only with reason useful_window. Confidence is your subjective assessment, not a calibrated probability.",
      input:JSON.stringify(facts),text:{format:{type:"json_schema",name:"study_invitation",strict:true,schema:{
        type:"object",properties:{action:{type:"string",enum:["stay_quiet","offer_study"]},reason:{type:"string",enum:["useful_window","uncertain_context","poor_timing","recent_decline"]},confidence:{type:"number",minimum:0,maximum:1}},
        required:["action","reason","confidence"],additionalProperties:false,
      }}},
    }),
  });
  if(!response.ok)throw Error("Decision model request failed");
  const data=await response.json() as {status?:string;output?:{type:string;content?:{type:string;text?:string}[]}[]};
  const output=data.output?.filter(o=>o.type==="message").flatMap(o=>o.content??[]).filter(c=>c.type==="output_text").map(c=>c.text??"").join("");
  if(data.status!=="completed"||!output)throw Error("Incomplete proactive decision");
  return validateDecision(JSON.parse(output));
}
