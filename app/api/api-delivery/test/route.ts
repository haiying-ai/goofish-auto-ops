import {
  normalizeApiDeliveryConfig,
  testApiDeliveryConfig,
} from "../../../../lib/api-delivery";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as { config?: unknown };
    const result = await testApiDeliveryConfig(
      normalizeApiDeliveryConfig(input.config),
    );
    return Response.json({ success: true, result });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "API 发卡测试失败" },
      { status: 400 },
    );
  }
}
