export type Settings = { username: string; password: string; url: string; serviceKey: string };
const response = (status: number, message?: string) => new Response(
  message ? JSON.stringify({ error: message }) : "[]",
  { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
);
async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
async function equal(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let different = 0;
  for (let i = 0; i < x.length; i++) different |= x[i]! ^ y[i]!;
  return different === 0;
}
async function hex(value: string): Promise<string> {
  return [...await digest(value)].map(n => n.toString(16).padStart(2, "0")).join("");
}

export function createHandler(settings: Settings, request: (url: string, init?: RequestInit) => Promise<Response> = fetch) {
  return async (req: Request): Promise<Response> => {
    if (!settings.username || settings.password.length < 24 || !settings.url || !settings.serviceKey)
      return response(503, "Receiver needs configuration");
    const authorization = req.headers.get("authorization") ?? "";
    let credentials = "";
    try { if (/^Basic /i.test(authorization)) credentials = atob(authorization.slice(6)); } catch { /* invalid authentication */ }
    if (!await equal(credentials, `${settings.username}:${settings.password}`)) return response(401, "Unauthorized");
    if (req.method !== "POST") return response(405, "Use POST");
    try {
      // OwnTracks can send empty deletion messages. Accept these without storing anything.
      const reader = req.body?.getReader();
      if (!reader) return response(200);
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > 16_384) { await reader.cancel(); return response(413, "Payload too large"); }
        chunks.push(part.value);
      }
      if (!length) return response(200);
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { return response(400, "Invalid JSON"); }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return response(400, "Invalid payload");
      const p = payload as Record<string, unknown>;
      // Accept routine location/status/waypoint updates but retain only named-region transitions.
      if (p._type !== "transition") {
        if (p._type === "encrypted") return response(422, "Use unencrypted payloads over HTTPS for this receiver");
        return response(200);
      }
      if ((p.event !== "enter" && p.event !== "leave") || typeof p.desc !== "string" || !p.desc.trim()
          || p.desc.length > 100 || /[\r\n\u0000]/.test(p.desc)
          || typeof p.tst !== "number" || !Number.isInteger(p.tst) || p.tst < 0
          || p.tst > Date.now() / 1000 + 300) return response(400, "Invalid transition");
      const region = p.desc.trim();
      // Identity comes from authenticated configuration, never from caller-provided topic/username.
      const deviceKey = await hex(settings.username);
      const eventKey = await hex(JSON.stringify([deviceKey, region, p.event, p.tst, p.wtst ?? null]));
      const result = await request(`${settings.url.replace(/\/$/, "")}/rest/v1/location_events?on_conflict=id`, {
        method: "POST", headers: { apikey: settings.serviceKey, Authorization: `Bearer ${settings.serviceKey}`,
          "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify({ id: eventKey, device_key: deviceKey, region_name: region,
          event: p.event, occurred_at: new Date(p.tst * 1000).toISOString() }),
        signal: AbortSignal.timeout(8000), redirect: "error",
      });
      // Non-success lets OwnTracks retry later; never acknowledge a failed database write.
      return result.ok ? response(200) : response(503, "Storage unavailable; retry later");
    } catch { return response(503, "Receiver unavailable; retry later"); }
  };
}



Deno.serve(createHandler({
  username: Deno.env.get("OWNTRACKS_USERNAME") ?? "",
  password: Deno.env.get("OWNTRACKS_PASSWORD") ?? "",
  url: Deno.env.get("SUPABASE_URL") ?? "",
  serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
}));
