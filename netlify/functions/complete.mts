// Vibe Forge relay — forwards BYOK requests to known cloud AI providers.
// Same handler as the Vite dev middleware (shared/src/complete.ts), so dev
// and production behave identically. Keys pass through; nothing is stored.
import { handleProxyComplete } from "../../shared/src/complete.ts";

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const raw = await req.json().catch(() => null);
  const { status, body } = await handleProxyComplete(raw);
  return Response.json(body, { status });
};

export const config = { path: "/api/complete" };
