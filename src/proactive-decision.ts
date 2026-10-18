import {generateText,textProvider} from "./text-model.ts";
import type {LearningSummary} from "./study-options.ts";
export type DecisionFacts = {triggers?:string[];sessionState?:unknown;
 place:"library"|"cafe"|"home"|"dorm_room"|"classroom"|"campus_building"|"unknown";
 stableMinutes:number;locationAgeSeconds:number;accuracyMeters:number;freeMinutes:number;plannedMinutes:number;acceptedRecently:number;skippedRecently:number;
 placeEvidence?:{confirmed:boolean;homeStatus:"at_saved_home"|"away_from_saved_home"|"unknown";canSave:boolean;calendarAvailable:boolean;matchedBuilding:boolean;arrivalCheckInEligible?:boolean};
 learning?:LearningSummary;
};
export type PromptDecision={action:"stay_quiet"|"offer_study"|"ask_place"|"check_in";reason:"useful_window"|"uncertain_context"|"poor_timing"|"recent_decline";confidence:number;optionId?:string|null};
export function validateDecision(value:unknown):PromptDecision{
 const v=value as Record<string,unknown>|null;
 const keys=v?Object.keys(v).sort().join(","):"";
 if(!v||!["action,confidence,reason","action,confidence,optionId,reason"].includes(keys)
  ||!["stay_quiet","offer_study","ask_place","check_in"].includes(String(v.action))||!["useful_window","uncertain_context","poor_timing","recent_decline"].includes(String(v.reason))
  ||typeof v.confidence!=="number"||!Number.isFinite(v.confidence)||v.confidence<0||v.confidence>1
  ||(v.action==="offer_study"&&v.reason!=="useful_window")
  ||(v.optionId!==undefined&&v.optionId!==null&&(typeof v.optionId!=="string"||v.optionId.length>80))
  ||(v.action!=="offer_study"&&v.optionId!=null)
  ||(v.action==="ask_place"&&v.reason!=="uncertain_context"))throw Error("Invalid proactive decision");
 return v as PromptDecision;
}
export function validateSelectedOption(decision:PromptDecision,facts:DecisionFacts):PromptDecision{
 if(decision.action==="check_in"&&!facts.placeEvidence?.arrivalCheckInEligible)throw Error("Arrival already checked in or home");
 if(decision.action==="offer_study"&&facts.freeMinutes<30)throw Error("No current study opening");
 if(decision.action==="ask_place"&&!facts.placeEvidence?.canSave)throw Error("No place candidate to save");
 if(decision.action==="offer_study"&&facts.learning){
  const option=facts.learning.options.find(o=>o.id===decision.optionId);
  if(!option||!Number.isInteger(option.minutes)||option.minutes<25||option.minutes>45||option.minutes>facts.freeMinutes)throw Error("Invalid study option");
 }
 return decision;
}
const instructions="You are the event-triggered coordinator of an always-running personal study assistant. Each call is a fresh review, not an instruction to send a text. triggers explains meaningful changes since your last review. sessionState is authoritative: never offer a second session when one is active or awaiting feedback. Persistent confirmed memory and real learned outcomes must inform your decision. learning.observations counts real feedback only; demoObservations counts synthetic starter examples with equal base weight. Partial real sessions inform overall predictions but do not prove a specific location or setup works. Synthetic examples are not this user’s experience; be cautious when personal evidence is sparse. Ask about a new stable arrival before assuming the user is studying. Remain quiet when nothing useful is needed. You coordinate a personal study assistant. learning.sessionContext contains optional user-confirmed sentiment and social tags from completed sessions. Use the linked actual ratings and explicit social effects to tailor timing and ask useful follow-up questions. These notes are associations across sessions, not location-specific causal effects or current observations. Do not penalize a library for session-specific social interruptions. Sentiment does not replace numerical ratings. Sparse notes are uncertain; never assume studying with friends was distracting. Rules checked fresh stable location, quiet-hour preferences and notification limits. Calendar availability is supplied as facts; it may be unavailable or have no current opening. A confirmed or saved study spot is NOT required. You manage whether to offer studying, optionally ask to save a detected place, or stay quiet. Do not force saving a place before studying. Prefer a useful study offer when a current opening exists. Use ask_place only when placeEvidence.canSave is true, with reason uncertain_context and optionId:null; this asks only to save the place, never to start a session. offer_study requires at least 30 free minutes in a known current opening. homeStatus distinguishes proximity to user-labeled home/dorm anchors; unknown does not mean away from home. Prefer opportunities away from home, but do not invent a home location. Unknown building/category is permissible evidence for a cautious generic study offer, not a reason to claim the place is a library or suitable workspace. Choose whether one study invitation is useful now. Prefer staying quiet over weak or repetitive offers. For check_in use reason uncertain_context and optionId:null. When placeEvidence.arrivalCheckInEligible is true, prefer a brief arrival check-in to learn what the user is doing before offering study. check_in does not require calendar availability. For offer_study with learning.options, choose exactly one existing optionId; other actions use optionId:null. Options are already ranked by a shared-feature LinUCB model using productivity (70%) and mood (30%) plus an exploration bonus. Use learned outcomes and uncertainty to compare options, but consider shorter sessions after recent declines. Low predicted outcomes are evidence to reconsider, not proof of causation. Historical workspace profiles are NOT observations of current seating/lighting/comfort, and predictions are category-level associations, not named-building effects. Never invent current context, sample counts or benefits; unknown options have no personal predictions. Sparse history, old profiles, and cloudUnavailable weaken evidence. An empty calendar is not proof the user is available. Do not treat a skipped invitation as a bad productivity rating. You cannot create events, send texts or change stored feedback. offer_study must have reason useful_window. Output only the decision schema. Confidence is subjective, not calibrated.";
const schema={type:"object",properties:{action:{type:"string",enum:["stay_quiet","offer_study","ask_place","check_in"]},reason:{type:"string",enum:["useful_window","uncertain_context","poor_timing","recent_decline"]},confidence:{type:"number",minimum:0,maximum:1},optionId:{type:["string","null"]}},required:["action","reason","confidence","optionId"],additionalProperties:false};
export function coordinatorProvider():"gemini"|"xai"{return textProvider();}
export async function decidePrompt(facts:DecisionFacts,request:typeof fetch=fetch):Promise<PromptDecision>{
 const output=await generateText(instructions,[{role:"user",parts:[{text:JSON.stringify(facts)}]}],schema,request);
 return validateSelectedOption(validateDecision(JSON.parse(output)),facts);
}
