import type {DashboardAccess} from './dashboard-access.ts';
export async function dashboardCommand(access:Pick<DashboardAccess,'handle'>|null,chat:string,text:string,messageId:string):Promise<string|null>{
 if(!/^(dashboard code|connect dashboard|disconnect dashboard)[.!?]*$/i.test(text.trim()))return null;
 if(!access)return 'Dashboard connection is not configured. Ask the team to check the bot’s Supabase settings.';
 try{return await access.handle(chat,text,messageId);}
 catch{return 'I could not connect the dashboard just now. Please retry dashboard code; your study history is unchanged.';}
}
