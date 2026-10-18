import {GeminiHttpError} from './gemini.ts';
export class ModelCooldown {
 private until=new Map<string,number>();constructor(private now=Date.now){}
 record(provider:string,error:unknown){const e=error as {status?:number;retryMs?:number};if(e?.status===429)this.until.set(provider,Math.max(this.until.get(provider)??0,this.now()+Math.max(60000,Math.min(e.retryMs??60000,86400000))));}
 assertReady(provider:string){const retry=(this.until.get(provider)??0)-this.now();if(retry>0)throw new GeminiHttpError(429,retry,provider==='gemini'?'Gemini':'xAI');}
}
export function textModelFailureReply(error:unknown):string|null{
 const e=error as {status?:number;retryMs?:number;provider?:string};const provider=e?.provider==='xAI'?'Grok':e?.provider==='Gemini'?'Gemini':'The AI provider';
 if(e?.status===429)return `${provider} is limiting API requests (429). ${e.retryMs?`Please wait about ${Math.max(1,Math.ceil(e.retryMs/1000))} seconds before trying again.`:'Please try again shortly; if it continues, check the provider’s usage limits.'} I have not confirmed this request complete.`;
 if(e?.status===402)return `${provider} rejected the request because its billing or credit balance needs attention. I have not confirmed this request complete.`;
 return null;
}
