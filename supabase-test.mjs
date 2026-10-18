// Read-only connectivity check. Bun loads your local .env automatically.
const projectUrl = process.env.SUPABASE_URL?.trim();
const secret = process.env.SUPABASE_SECRET_KEY?.trim();

try {
  if (!projectUrl || !secret) throw new Error('Add SUPABASE_URL and SUPABASE_SECRET_KEY to .env.');
  const base = new URL(projectUrl);
  if (base.protocol !== 'https:' || !base.hostname.endsWith('.supabase.co') || base.username || base.password) {
    throw new Error('SUPABASE_URL should be the https://your-project.supabase.co URL.');
  }
  if (!secret.startsWith('sb_secret_')) throw new Error('Use your backend Secret key beginning sb_secret_.');

  const endpoint = new URL('/rest/v1/study_sessions?select=id&limit=1', base.origin);
  const response = await fetch(endpoint, {
    headers: { apikey: secret, Prefer: 'count=exact' },
    signal: AbortSignal.timeout(20000),
    redirect: 'error',
  });

  if (!response.ok) {
    console.error(`Supabase connection failed (HTTP ${response.status}).`);
    if (response.status === 401) console.error('Check that the project URL and Secret key belong to the same project.');
    else if (response.status === 403) console.error('Check that service_role has access to study_sessions.');
    else if (response.status === 404) console.error('Check that study_sessions exists and the Data API is enabled.');
    else console.error('Check the project is running and its Data API is available.');
    process.exitCode = 1;
  } else {
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Unexpected database response.');
    const count = response.headers.get('content-range')?.split('/')[1];
    console.log('Connected to Supabase. study_sessions is accessible.');
    if (count && /^\d+$/.test(count)) console.log(`Saved sessions: ${count}`);
    console.log('Read-only test complete. No data was added or changed.');
  }
} catch (error) {
  // Never log request objects, environment values, or authentication headers.
  const safeMessages = [
    'Add SUPABASE_URL and SUPABASE_SECRET_KEY to .env.',
    'SUPABASE_URL should be the https://your-project.supabase.co URL.',
    'Use your backend Secret key beginning sb_secret_.',
    'Unexpected database response.',
  ];
  console.error(safeMessages.includes(error.message) ? error.message : 'Could not reach Supabase. Check your URL and network connection, then retry.');
  process.exitCode = 1;
}
