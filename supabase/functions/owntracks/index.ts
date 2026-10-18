import { createHandler } from "./handler.ts";

Deno.serve(createHandler({
  username: Deno.env.get("OWNTRACKS_USERNAME") ?? "",
  password: Deno.env.get("OWNTRACKS_PASSWORD") ?? "",
  url: Deno.env.get("SUPABASE_URL") ?? "",
  serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
}));
