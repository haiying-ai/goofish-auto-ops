export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return Response.json({
    ok: true,
    name: "闲鱼自动运营 Codex API",
    version: "3.4",
    mcp: {
      enabled: true,
      transport: "streamable-http",
      urlTemplate: `${origin}/api/mcp?key=<MCP_SHARED_SECRET>`,
      headerAlternative: "Authorization: Bearer <MCP_SHARED_SECRET>",
      note: "把带密钥的地址作为无额外登录的 MCP 连接保存一次，各会话即可直接调用 Auto Ops。",
    },
    authentication: {
      type: "shared secret",
      browserAdmin: "Sign in with ChatGPT + owner email allowlist",
      mcp: "MCP_SHARED_SECRET in query string, Bearer header, or X-Auto-Ops-Key header",
      note: "密钥只保存在 Sites Secret 和 ChatGPT 的连接配置中；后台浏览器登录方式保持不变。",
    },
    workflow: [
      {
        step: "check_xianyu_upload_auth",
        method: "GET",
        path: "/api/xianyu/status",
        mcpTool: "get_xianyu_account_status",
        successCondition: "valid=true 且 uploadReady 不为 false",
        authFailure:
          "定时任务每次运行都会接口保活，并定期访问强鉴权页滚动完整 Cookie；鉴权失败还会自动强续期重试。仅当最终仍返回 AUTH_REQUIRED 时，才提示所有者完成一次交互式登录",
      },
      {
        step: "upload_images",
        method: "POST",
        path: "/api/xianyu/upload",
        contentType: "multipart/form-data",
        field: "file",
        mcpLargeFileWorkflow: [
          "begin_product_image_upload",
          "upload_product_image_chunk",
          "finish_product_image_upload",
        ],
        note: "MCP 中超过 160 KiB 的附件必须分片上传；分片会话保留 24 小时并可重试完成步骤。服务端会在 AUTH_REQUIRED 前自动续期并重试；最终仍失败代表需要扫码、人脸或设备确认。",
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
        step: "delete_draft",
        method: "DELETE",
        path: "/api/products",
        mcpTool: "delete_product_draft",
        body: {
          id: "<draft id>",
          action: "delete_draft",
          expectedTitle: "<exact current title>",
          confirmDelete: true,
        },
        requirement:
          "仅允许删除从未发布且无远端商品、订单或自动化记录的 draft；调用前必须回读详情并在当前会话获得明确确认",
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
