import { env } from "cloudflare:workers";

const DEFAULT_ALERT_EMAIL = "bingsun2020@163.com";
const DEFAULT_FROM = "闲鱼自动运营 <onboarding@resend.dev>";

type RuntimeEnv = {
  RESEND_API_KEY?: string;
  ALERT_EMAIL?: string;
  ALERT_FROM_EMAIL?: string;
};

export function emailStatus() {
  const runtime = env as unknown as RuntimeEnv;
  return {
    configured: Boolean(runtime.RESEND_API_KEY),
    recipient: runtime.ALERT_EMAIL || DEFAULT_ALERT_EMAIL,
    sender: runtime.ALERT_FROM_EMAIL || DEFAULT_FROM,
  };
}

export async function sendOperationalAlert(input: {
  eventKey: string;
  subject: string;
  lines: string[];
}) {
  const runtime = env as unknown as RuntimeEnv;
  const status = emailStatus();
  if (!runtime.RESEND_API_KEY) {
    return {
      sent: false,
      configurationRequired: true,
      error: "尚未配置 RESEND_API_KEY",
    };
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${runtime.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `xianyu-ops-${safeEventKey(input.eventKey)}`,
    },
    body: JSON.stringify({
      from: status.sender,
      to: [status.recipient],
      subject: input.subject,
      text: input.lines.join("\n"),
    }),
  });
  const raw = (await response.json().catch(() => ({}))) as {
    id?: string;
    message?: string;
    name?: string;
  };
  if (!response.ok || !raw.id) {
    throw new Error(
      `邮件发送失败：${raw.message || raw.name || `HTTP ${response.status}`}`,
    );
  }
  return {
    sent: true,
    configurationRequired: false,
    id: raw.id,
  };
}

export async function sendConfigurationAlert(input: {
  orderId: string;
  itemId: string;
  productTitle: string;
  reason: string;
}) {
  const subject = `闲鱼订单待人工处理：${input.productTitle || input.itemId || input.orderId}`;
  return sendOperationalAlert({
    eventKey: `configuration-${input.orderId}`,
    subject,
    lines: [
      "闲鱼自动运营发现一笔无法自动发货的已付款订单。",
      "",
      `原因：${input.reason}`,
      `订单号：${input.orderId}`,
      `商品：${input.productTitle || "未同步商品"}`,
      `闲鱼商品号：${input.itemId || "未知"}`,
      "",
      "请登录闲鱼自动运营后台补充发货规则；补充后下一轮定时任务会继续处理。",
    ],
  });
}

function safeEventKey(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 180);
}
