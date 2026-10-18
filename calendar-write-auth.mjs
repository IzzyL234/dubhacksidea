import { authenticate } from '@google-cloud/local-auth';
import { readFile,writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

try {
  console.log('Opening Google authorization for calendar event editing. Choose the account that owns Hackathon Demo.');
  const auth=await authenticate({scopes:['https://www.googleapis.com/auth/calendar.events'],keyfilePath:fileURLToPath(new URL('./credentials.json',import.meta.url))});
  if(!auth.credentials.refresh_token)throw Error('NO_OFFLINE_TOKEN');
  const credentials=JSON.parse(await readFile(new URL('./credentials.json',import.meta.url),'utf8'));
  const client=credentials.installed;
  if(!client)throw Error('DESKTOP_CLIENT_REQUIRED');
  await writeFile(new URL('./.google-calendar-write-token.json',import.meta.url),JSON.stringify({type:'authorized_user',client_id:client.client_id,client_secret:client.client_secret,refresh_token:auth.credentials.refresh_token}),{mode:0o600});
  console.log('Calendar editing is authorized. The app writes only to Hackathon Demo. Your original read-only token is unchanged.');
  console.log('To populate the fictional schedule: bun scripts/seed-demo-calendar.ts');
} catch {
  console.error('Calendar authorization did not finish. Check Google consent and that credentials.json is a Desktop client. No credentials were logged.');
  process.exitCode=1;
}
