# Calendar approval through Cloudflare

Vercel hosts the website. The messaging bot and protected approval worker run on the same laptop and share private review state. Only the approval worker's loopback port 3003 is tunneled. The full development server must stay local.

## Current result

The official cloudflared Windows client was installed in the task's `work/cloudflare` folder. Cloudflare issued temporary hostnames, but both QUIC and HTTP/2 timed out connecting to its edge on port 7844. No connection was established. The unreachable URL was removed from Vercel, so public calendar approvals are still unavailable. Try a different network, such as a phone hotspot. Do not disable endpoint protection to work around this.

## Start on a working network

Keep the existing bot running. From a checkout of this branch with dependencies installed, run:

```powershell
./scripts/start-review-tunnel.ps1 -BotProject C:\Users\Isabe\my-project -CloudflaredPath cloudflared
```

If cloudflared is not on PATH, pass the absolute path to the official executable instead. The script checks that Calendar token files exist without printing them, starts the protected worker, and forwards only its port. It stops the worker it started when the tunnel command exits. If port 3003 is already occupied, stop the old approval worker or use a different `-Port`.

Wait for `Registered tunnel connection`. Receiving a hostname alone does not prove the tunnel works. An unauthenticated request to `/api/learning/reviews/0000000000000000` must return 401, and `/.env` and `/api/google-calendar/today` must return 404. Do not approve real events just to test connectivity.

Set Vercel's production `REVIEW_BACKEND_URL` to the HTTPS origin that cloudflared prints, with no path or token, then redeploy. Set the bot's `FRONTEND_URL` to `https://webapp-checkout-eight.vercel.app` when launching it, so newly generated private links open the published site. Both processes must use the same `data/schedule-reviews` directory.

Text `review schedule` to generate a new proposal, open its private link, and inspect it before deciding whether to approve. An approval intentionally changes the eligible Calendar event; denial leaves Calendar unchanged. Expiry, event version and destination checks still apply.

Quick Tunnels have temporary hostnames and no uptime guarantee. The laptop must remain awake and connected, and a new tunnel requires a new Vercel setting and redeployment. A named Cloudflare Tunnel provides a stable hostname but requires additional account/domain setup.

Official documentation: https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
