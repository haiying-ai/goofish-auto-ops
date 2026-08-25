export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    ok: true,
    name: "闲鱼自动运营 Codex API",
    version: "1.1",
    authentication: {
      type: "Sites SIWC bypass token",
      header: "OAI-Sites-Authorization",
      scheme: "Bearer",
      note: "通过 Sites get_site 获取当前令牌；不要使用云端浏览器登录，也不要在聊天或代码中输出令牌。",
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
