import { authenticate } from '@google-cloud/local-auth';
import { google } from 'googleapis';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const calendarId = 'c_8a3f88a63add1862899e38c8eb168366805a752ed4bc3283303e5a68823964bf@group.calendar.google.com';
const credentialsPath = fileURLToPath(new URL('./credentials.json', import.meta.url));
const tokenPath = fileURLToPath(new URL('./.google-calendar-token.json', import.meta.url));

async function authorize() {
  try {
    const token = JSON.parse(await readFile(tokenPath, 'utf8'));
    return google.auth.fromJSON(token);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  console.log('Opening Google sign-in. Choose the account that owns Hackathon Demo.');
  const auth = await authenticate({
    scopes: ['https://www.googleapis.com/auth/calendar.events.readonly'],
    keyfilePath: credentialsPath,
  });

  if (!auth.credentials.refresh_token) {
    throw new Error('Google did not return an offline token. Reauthorize with consent before continuing.');
  }

  const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
  const client = credentials.installed;
  if (!client) throw new Error('Use the downloaded Desktop app credentials.');

  await writeFile(tokenPath, JSON.stringify({
    type: 'authorized_user',
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: auth.credentials.refresh_token,
  }), { mode: 0o600 });

  return auth;
}

try {
  const auth = await authorize();
  const calendar = google.calendar({ version: 'v3', auth });
  const { data } = await calendar.events.list({
    calendarId,
    timeMin: new Date().toISOString(),
    maxResults: 10,
    singleEvents: true,
    orderBy: 'startTime',
  });

  console.log('\nConnected to your demo calendar. Upcoming events:');
  if (!data.items?.length) console.log('No upcoming events. Add a future event to Hackathon Demo and run this again.');
  for (const event of data.items ?? []) {
    const start = event.start?.dateTime
      ? new Date(event.start.dateTime).toLocaleString('en-US', {
          timeZone: data.timeZone || 'America/Los_Angeles',
          dateStyle: 'medium', timeStyle: 'short',
        })
      : `${event.start?.date ?? 'Unknown date'} (all day)`;
    console.log(`${start} — ${event.summary ?? 'Untitled event'}`);
  }
} catch (error) {
  // Avoid logging request objects, which can include authentication headers.
  const status = error.response?.status ?? error.code;
  const googleError = error.response?.data?.error;
  if (googleError && typeof googleError === 'object') {
    console.error('Google reason:', googleError.errors?.[0]?.reason ?? googleError.status ?? 'unknown');
    console.error('Google message:', String(googleError.message ?? 'No detail provided').slice(0, 1500));
  }
  console.error(`Calendar test failed${status ? ` (${status})` : ''}.`);
  if (status === 404) console.error('Check the calendar ID and sign in with the account that owns the demo calendar.');
  else if (status === 403) console.error('Check Calendar API is enabled, your account is a test user, and read access was approved.');
  else if (status === 'ENOENT') console.error('Place credentials.json beside calendar-test.mjs.');
  else console.error('Check the Google sign-in result, Desktop app credentials, and network connection.');
  process.exitCode = 1;
}
