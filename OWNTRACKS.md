# Automatic iPhone arrivals with OwnTracks

Status: receiver implemented and tested locally. Deploy it and connect the phone before expecting real events. Calendar matching, conversation pairing, automatic study-session creation, and proactive texts are not connected yet. An arrival is evidence of presence, not proof of studying. This initial receiver is for one phone, configured with one username/password pair.

## 1. Create the table

In your existing Supabase project's SQL Editor, run `supabase/003_location_events.sql`.

## 2. Deploy the receiver

In Supabase, open Edge Functions → Deploy a new function → Via Editor. Name it `owntracks`. Replace the sample code with the supplied single-file `owntracks-dashboard.ts` (also available as `supabase/functions/owntracks/dashboard-source.ts` in GitHub), then deploy. Alternatively, deploy the repository's `supabase/functions/owntracks` directory using the Supabase CLI.

Under Edge Functions → Secrets, add:

- `OWNTRACKS_USERNAME`: choose a short identifier such as `study-phone` (one phone for this MVP).
- `OWNTRACKS_PASSWORD`: generate a new random password of at least 24 characters. Keep it private; use this same password only in OwnTracks. Do not paste it into chat or GitHub.

Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to hosted Edge Functions automatically. Do not enter your Supabase backend key into the phone app.

For this function, turn OFF the platform's JWT verification (sometimes labeled Verify JWT with legacy secret). OwnTracks sends Basic authentication rather than a Supabase JWT. The receiver checks the OwnTracks username/password itself before accepting data. CLI deployments use the function-specific setting in `supabase/config.toml`.

Copy the function URL: `https://YOUR_PROJECT_REF.supabase.co/functions/v1/owntracks`.

## 3. Connect your iPhone

Install OwnTracks from the App Store using the link on https://owntracks.org/ . Allow background location access (Always) and Precise Location in iPhone Settings → Privacy & Security → Location Services → OwnTracks, if offered. Keep location services enabled.

In OwnTracks connection settings:

- Mode: HTTP.
- URL: the HTTPS function URL above.
- Authentication: enabled.
- Username/password: the values you created in Supabase function Secrets.
- Device identifier: `iphone`; tracker ID: a short identifier, for example `IP`.
- Use Significant monitoring mode initially, rather than Quiet. Configure a named region with a nonzero radius, such as `Library` with 150 meters, then adjust after testing. This is a starting test radius, not a claim of building-level accuracy.
- Leave payload encryption disabled for this first receiver; transport is encrypted by HTTPS. The receiver does not implement OwnTracks encrypted-payload decryption.

Exact setting names can vary by app version. No MQTT broker is required. Do not enable insecure/invalid TLS certificates.

## 4. Test an actual boundary crossing

Create a region near you, move outside its boundary, then return inside with the phone. Creating a region while already inside may not generate an arrival immediately. Keep the app running normally; background events can be delayed by iOS.

In Supabase Table Editor, refresh `location_events`. Expect region_name, event (`enter` or `leave`), occurred_at, and received_at. Duplicate deliveries do not create extra rows. Exact coordinates, phone account details, and raw payloads are not stored by the receiver. Routine location updates are acknowledged but discarded, so tapping publish without crossing a region does not create a row.

Troubleshooting: 401 means Basic credentials or JWT gateway settings need checking; 503 means missing secrets or table/database access; 400 means a malformed transition; 422 means payload encryption is enabled. Compare occurred_at with received_at to see delayed uploads. Do not treat late historical arrivals as current presence or immediately send prompts from them.

## Next stage

Pair the device with the bot conversation, match fresh arrivals to calendar study blocks, and create candidate sessions. A worker should reconcile event timestamps, duplicate/repeated arrivals, departures, dwell time, quiet hours, and prompt cooldowns before sending texts. Link confirmed sessions and their feedback to LinUCB. Location events alone must never fabricate productivity ratings or training labels.

## References

- https://owntracks.org/booklet/features/ios/
- https://owntracks.org/booklet/tech/http/
- https://owntracks.org/booklet/tech/json/
- https://supabase.com/docs/guides/functions/quickstart-dashboard
- https://supabase.com/docs/guides/functions/auth
