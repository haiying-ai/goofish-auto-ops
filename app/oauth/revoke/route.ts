import { revokeRefreshToken } from "../../../lib/oauth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const form = new URLSearchParams(await request.text());
  await revokeRefreshToken(String(form.get("token") || ""));
  return new Response(null, {
    status: 200,
    headers: { "cache-control": "no-store", "access-control-allow-origin": "*" },
  });
}
