import {createHash} from "node:crypto";
export type CoordinatorSignals={place:string;calendar:string;learning:string;session:string;preferences:string};
export type CoordinatorMemory={signals?:CoordinatorSignals;at?:number;retryAfter?:number;failures?:number;day?:string;calls?:number};
export function signalDigest(value:unknown):string{return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
export function decisionTrigger(memory:CoordinatorMemory,signals:CoordinatorSignals,now:number,day:string):{allow:boolean;reason:string;triggers:string[]}{
 if(now<(memory.retryAfter??0))return {allow:false,reason:"coordinator_retry_backoff",triggers:[]};
 if(memory.day===day&&(memory.calls??0)>=48)return {allow:false,reason:"daily_model_budget",triggers:[]};
 if(memory.at!==undefined&&now-memory.at<60000)return {allow:false,reason:"coordinator_settling",triggers:[]};
 const triggers=memory.signals?(Object.keys(signals) as (keyof CoordinatorSignals)[]).filter(k=>signals[k]!==memory.signals![k]).map(k=>k+"_changed"):["first_stable_context"];
 if(memory.failures)triggers.push("retry_due");
 if(!triggers.length&&memory.at!==undefined&&now-memory.at>=30*60000)triggers.push("scheduled_review");
 return {allow:triggers.length>0,reason:triggers.length?"context_changed":"no_meaningful_change",triggers};
}
export function reserveDecision(memory:CoordinatorMemory,signals:CoordinatorSignals,now:number,day:string):void{
 memory.calls=memory.day===day?(memory.calls??0)+1:1;memory.day=day;memory.at=now;memory.signals=signals;
}
export function failedDecision(memory:CoordinatorMemory,now:number,retryMs?:number):void{
 memory.failures=(memory.failures??0)+1;
 memory.retryAfter=now+(retryMs??Math.min(30*60000,60000*2**Math.min(memory.failures,5)));
}
