# Framer study-suggestion review API

The optional review API lets the Framer page inspect a pending proactive study invitation and accept or decline it. It is started by `bun start` only when `FRAMER_REVIEW_URL` is configured. It binds to `127.0.0.1:8787` by default; put it behind an HTTPS reverse proxy for a hosted Framer site. Never expose the raw HTTP listener directly to the public internet.

Set `FRAMER_REVIEW_URL` to the exact Framer site origin. Set `REVIEW_API_HOST` and `REVIEW_API_PORT` for the private listener/proxy. The API allows browser requests only from that origin. The browser also needs the public HTTPS API base URL configured in its Framer Code Component; that URL is public configuration, not a secret.

When the coordinator creates a study invitation, the bot stores its suggestion ID, context, expiry, and only a hash of a random one-time token in the private `data/review-links/` directory. It appends a review URL to the iMessage invitation:

```text
https://your-framer-site.example/review?suggestion_id=<SUGGESTION_ID>#token=<ONE_TIME_APPROVAL_TOKEN>
```

The Framer static `/review` page reads `suggestion_id` from the query string and the one-time token from the URL fragment, immediately removes the fragment from browser history, and exchanges them:

```http
POST /api/v1/review-links/exchange
Content-Type: application/json
Origin: https://your-framer-site.example
```

```json
{
  "suggestion_id": "<SUGGESTION_ID>",
  "token": "<ONE_TIME_APPROVAL_TOKEN>"
}
```

The one-time token can be exchanged once, before suggestion expiry. The response is a ten-minute, suggestion-scoped bearer token:

```json
{
  "access_token": "<REVIEW_ACCESS_TOKEN>",
  "token_type": "Bearer",
  "expires_in": 600
}
```

Fetch the proposal:

```http
GET /api/v1/suggestions/<SUGGESTION_ID>
Authorization: Bearer <REVIEW_ACCESS_TOKEN>
```

```json
{
  "id": "<SUGGESTION_ID>",
  "status": "pending",
  "title": "Study session",
  "start": "2026-10-19T14:00:00.000Z",
  "end": "2026-10-19T14:45:00.000Z",
  "timezone": "America/Los_Angeles",
  "available_until": "2026-10-19T16:00:00.000Z",
  "reason": "<SUGGESTION_REASON>",
  "expires_at": "2026-10-19T14:10:00.000Z"
}
```

Accept or decline through the same decision endpoint. Each choice requires a stable random idempotency key so retries cannot make duplicate calendar changes:

```http
POST /api/v1/suggestions/<SUGGESTION_ID>/decision
Authorization: Bearer <REVIEW_ACCESS_TOKEN>
Content-Type: application/json
```

```json
{
  "decision": "accept",
  "idempotency_key": "<UUID>"
}
```

Use `"decision": "decline"` to decline. An accepted result distinguishes a verified Calendar booking from a session that started but whose booking could not be confirmed:

```json
{
  "id": "<SUGGESTION_ID>",
  "decision": "accept",
  "status": "confirmed",
  "calendar_status": "confirmed",
  "message": "<CONFIRMATION_MESSAGE>"
}
```

A decline returns `status: "declined"` and `calendar_status: "unchanged"`. Reusing the same idempotency key and decision replays the result; a different decision after completion returns HTTP 409. Expired links return HTTP 410. Invalid/reused tokens return HTTP 401/410.

The decision handler calls the existing `StudyReminders` flow with the invitation's exact ID. That flow rechecks the calendar opening, busy-session state, and location before starting. Declining creates no session. The review link is additional to the existing iMessage yes/skip control.

All token and suggestion records are local private files with restrictive permissions. A single local process is not a durable multi-instance production store; use a transactional database with hashed tokens, unique idempotency keys, and expiry before horizontally scaling. Keep Google OAuth credentials on the server; Framer receives only the scoped review token.