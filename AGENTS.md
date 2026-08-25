# Codex operations for this repository

## Cross-session access

- Never use a cloud browser to operate the deployed admin site. Browser cookies and ChatGPT page sessions are isolated and are not the supported automation path.
- Use the installed Auto Ops MCP tools. The public Streamable HTTP endpoint is `https://xianyu-auto-ops.sunbingbing-cn.chatgpt.site/api/mcp` and it requires OAuth 2.1 authorization code + PKCE.
- If the tools are absent in a conversation, ask the user to enable the already-connected Auto Ops plugin for that conversation. Do not ask for a Cookie, OAuth token, password, email verification code, or Sites bypass token in chat.
- The browser admin uses Sign in with ChatGPT plus an explicit server-side owner email allowlist. Public Site reachability does not make its data APIs public.
- Resolve the existing Sites project with `sites_get_site` using project ID `appgprj_6a8ae3485e5c819193abe9c9c04a2abb` only for source/deployment maintenance, not as the normal operations API.
- Never print, commit, persist, or relay Sites or OAuth bearer tokens. Do not rotate either authorization unless the user explicitly asks.
- The production origin is `https://xianyu-auto-ops.sunbingbing-cn.chatgpt.site`.
- Read `GET /api/agent` first for the current machine-readable API workflow.

## Safe listing workflow

1. Check `GET /api/health` and `GET /api/dashboard` through the Sites authorization header.
2. Upload each image with `POST /api/xianyu/upload`.
3. Create a non-publishing draft with `POST /api/products` and include `"publishMode":"draft"`.
4. Read the draft back from `GET /api/dashboard` and verify title, price, original price, inventory, shipping, category mode, delivery mode, description, and image order.
5. Do not publish without explicit confirmation in the current user conversation.
6. After confirmation, call `PATCH /api/products` with `{"id":<draft id>,"action":"publish_listing"}`.
7. Verify the returned Xianyu item through `GET /api/xianyu/item?id=<item id>`; require `itemStatus` to be `0` and confirm every image is readable.

Drafts are deliberately excluded from the Cron publish queue. Existing `queued` records retain their scheduled-publish behavior.
