import {createDashboardHandler} from './handler.ts';
Deno.serve(createDashboardHandler({url:Deno.env.get('SUPABASE_URL')??'',serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'',allowedOrigins:(Deno.env.get('DASHBOARD_ALLOWED_ORIGINS')??'').split(',').map(s=>s.trim()).filter(Boolean)}));
