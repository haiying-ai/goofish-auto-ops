import {
  configuredOwnerEmail,
  trustedChatGPTEmail,
} from "../../../lib/oauth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const owner = configuredOwnerEmail();
  const email = trustedChatGPTEmail(request);
  const authorized = Boolean(owner && email && owner === email);
  return Response.json(
    {
      authenticated: Boolean(email),
      authorized,
      configured: Boolean(owner),
      user: authorized ? { email } : null,
      signInPath: "/signin-with-chatgpt?return_to=%2F",
      signOutPath: "/signout-with-chatgpt?return_to=%2F",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
