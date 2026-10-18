import {StudyLearner,type Context} from "./learning.ts";
export type StudyOption={id:string;minutes:number;basis:"historical"|"unknown";studySpace:Context["study_space"]|null;predictedProductivity:number|null;predictedMood:number|null;uncertainty:number|null;selectionScore:number|null;relevantSessions:number;profileAgeDays:number|null};
export type LearningSummary={observations:number;cloudUnavailable:boolean;currentWorkspaceKnown:false;options:StudyOption[]};
export function studyOptions(learner:StudyLearner,contexts:Context[],place:string,freeMinutes:number,observations:number,cloudUnavailable:boolean,now:number):LearningSummary{
 const minutes=[...new Set([25,Math.min(45,Math.floor(freeMinutes))])].filter(m=>m>=25&&m<=freeMinutes);
 const matching=contexts.filter(c=>c.location===place).sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp));
 const profileKey=(c:Context)=>JSON.stringify([c.study_space,c.environment.clutter_score,c.environment.lighting,c.environment.ergonomics]);
 const profiles:Context[]=[];const seen=new Set<string>();
 for(const c of matching){const key=profileKey(c);if(!seen.has(key)){profiles.push(c);seen.add(key);}if(profiles.length===3)break;}
 const options:StudyOption[]=[];
 if(!profiles.length){for(const m of minutes)options.push({id:`unknown-${m}`,minutes:m,basis:"unknown",studySpace:null,predictedProductivity:null,predictedMood:null,uncertainty:null,selectionScore:null,relevantSessions:0,profileAgeDays:null});}
 for(const [i,c]of profiles.entries())for(const m of minutes){
  const prediction=learner.predict({...c,timestamp:new Date(now).toISOString(),duration_mins:m});
  options.push({id:`profile-${i}-${m}`,minutes:m,basis:"historical",studySpace:c.study_space,predictedProductivity:prediction.predictedProductivity,predictedMood:prediction.predictedMood,uncertainty:prediction.uncertainty,selectionScore:prediction.selectionScore,relevantSessions:matching.filter(p=>profileKey(p)===profileKey(c)).length,profileAgeDays:Math.max(0,Math.floor((now-Date.parse(c.timestamp))/86400000))});
 }
 options.sort((a,b)=>(b.selectionScore??0)-(a.selectionScore??0)||a.minutes-b.minutes||a.id.localeCompare(b.id));
 return {observations,cloudUnavailable,currentWorkspaceKnown:false,options};
}

