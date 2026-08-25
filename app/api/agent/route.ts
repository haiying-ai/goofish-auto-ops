export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return Response.json({
    ok: true,
    name: "闲鱼自动运营 Codex API",
    version: "3.0",
    mcp: {
      enabled: true,
      transport: "streamable-http",
      url: `${origin}/api/mcp`,
      oauthResource: `${origin}/api/mcp`,
      protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource/api/mcp`,
      note: "通过 ChatGPT 插件连接后，各会话可直接发现并调用 Auto Ops 工具，不依赖浏览器 Cookie。",
    },
    authentication: {
      type: "OAuth 2.1 authorization code with PKCE S256",
      authorizationServerMetadata: `${origin}/.well-known/oauth-authorization-server`,
      browserAdmin: "Sign in with ChatGPT + owner email allowlist",
      mcp: "OAuth Bearer token scoped to auto_ops.manage",
      note: "每个 ChatGPT 会话连接同一个已安装插件；令牌由站点签发和刷新，不共享浏览器 Cookie，也不得在聊天中粘贴令牌。",
    },
    workflow: [
      {
        step: "upload_images",
        method: "POST",
        path: "/api/xianyu/upload",
        contentType: "multipart/form-data",
        field: "file",
      },
      {
        step: "create_draft",
        method: "POST",
        path: "/api/products",
        requiredBodyFields: [
          "title",
          "price",
          "quantity",
          "description",
          "images",
          "publishMode",
        ],
        fixedBody: { publishMode: "draft" },
        guarantee: "draft 状态不会被 Cron 发布",
      },
      {
        step: "verify_draft",
        method: "GET",
        path: "/api/dashboard",
      },
      {
        step: "confirm_publish",
        method: "PATCH",
        path: "/api/products",
        body: { id: "<draft id>", action: "publish_listing" },
        requirement: "仅在当前会话获得用户明确确认后调用",
      },
      {
        step: "verify_remote",
        method: "GET",
        path: "/api/xianyu/item?id=<xianyu item id>",
        successCondition: "itemStatus=0，且标题、价格、库存与图片均与草稿一致",
      },
      {
        step: "configure_delivery",
        method: "POST",
        path: "/api/delivery-rules",
        note: "支持默认或规格级固定文本、卡密库存和 API 动态发卡规则",
      },
      {
        step: "inspect_orders",
        method: "GET",
        path: "/api/orders",
        note: "返回订单、加密内容的授权视图、自动化运行和步骤状态",
      },
      {
        step: "compensate_order",
        method: "PATCH",
        path: "/api/orders",
        actions: ["retry", "resend", "confirm_shipment", "mark_resolved"],
      },
    ],
  });
}
