import type { XianyuSession } from "./xianyu-items";

const WS_URL = "https://wss-goofish.dingtalk.com/";
const IM_APP_KEY = "444e9908a51d1cb236a27862abc769c9";
const IM_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36 DingTalk(2.2.0) OS(Mac OS/10.15.7) Browser(Chrome/141.0.0.0) DingWeb/2.2.0 IMPaaS DingWeb/2.2.0";

type WsEnvelope = {
  lwp?: string;
  code?: number;
  headers?: Record<string, unknown>;
  body?: unknown;
};

type WorkerSocket = WebSocket & {
  accept?: (options?: { allowHalfOpen?: boolean }) => void;
};

type WorkerResponse = Response & { webSocket?: WorkerSocket };

export class XianyuImClient {
  private sequence = 0;
  private pending = new Map<
    string,
    {
      resolve: (value: WsEnvelope) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private constructor(
    private socket: WorkerSocket,
    private selfUserId: string,
  ) {
    socket.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      this.rejectPending(new Error("闲鱼 IM 连接已关闭"));
    });
    socket.addEventListener("error", () => {
      this.rejectPending(new Error("闲鱼 IM 连接异常"));
    });
  }

  static async connect(session: XianyuSession) {
    const selfUserId = session.cookieValue("unb");
    if (!selfUserId) throw new Error("Cookie 缺少闲鱼账号字段 unb");
    const deviceId = crypto.randomUUID() + "-" + Date.now();
    const tokenRaw = await session.call(
      "mtop.taobao.idlemessage.pc.login.token",
      { appKey: IM_APP_KEY, deviceId },
      { spm: "a21ybx.im.0.0" },
    );
    const accessToken = String(tokenRaw.data?.accessToken || "");
    if (!accessToken) throw new Error("闲鱼 IM 登录令牌为空");

    const response = (await fetch(WS_URL, {
      headers: {
        Upgrade: "websocket",
        Origin: "https://www.goofish.com",
        "User-Agent": IM_USER_AGENT,
      },
    })) as WorkerResponse;
    const socket = response.webSocket;
    if (!socket) {
      throw new Error("闲鱼 IM 握手失败：HTTP " + response.status);
    }
    socket.accept?.();

    const client = new XianyuImClient(socket, selfUserId);
    await client.request("/reg", undefined, {
      "cache-header": "app-key token ua wv",
      "app-key": IM_APP_KEY,
      token: accessToken,
      ua: IM_USER_AGENT,
      dt: "j",
      wv: "im:3,au:3,sy:6",
      sync: "0,0;0;0;",
      did: deviceId,
    });
    const sync = await client.request("/r/SyncStatus/getState", [
      { topic: "sync" },
    ]);
    if (sync.body && typeof sync.body === "object") {
      await client.request("/r/SyncStatus/ackDiff", [sync.body]);
    }
    return client;
  }

  async sendDeliveryMessage(input: {
    buyerId: string;
    itemId: string;
    orderId: string;
    text: string;
  }) {
    if (!input.buyerId) {
      throw new Error("订单缺少买家账号，无法发送发货内容");
    }
    const [first, second] = sortUserIds(this.selfUserId, input.buyerId).map(
      (id) => id + "@goofish",
    );
    const conversation = await this.request(
      "/r/SingleChatConversation/create",
      [
        {
          pairFirst: first,
          pairSecond: second,
          bizType: "1",
          extension: {
            itemId: input.itemId,
            orderId: input.orderId,
            source: "order",
          },
          ctx: { appVersion: "1.0", platform: "web" },
        },
      ],
    );
    const body = objectValue(conversation.body);
    const single = objectValue(body.singleChatConversation);
    const nested = objectValue(
      objectValue(body.singleChatUserConversation).singleChatConversation,
    );
    const detail = Object.keys(single).length ? single : nested;
    const cid = String(detail.cid || "");
    if (!cid) throw new Error("闲鱼 IM 未返回会话编号");
    const receivers = [
      String(detail.pairFirst || first),
      String(detail.pairSecond || second),
    ];

    await this.request("/r/MessageSend/sendByReceiverScope", [
      {
        message: {
          // Reusing the same UUID lets the IM service deduplicate an uncertain retry.
          uuid: deliveryMessageUuid(input.orderId),
          cid,
          conversationType: 1,
          content: {
            contentType: 101,
            custom: {
              type: 1,
              data: base64Utf8(
                JSON.stringify({
                  contentType: 1,
                  text: { text: input.text },
                }),
              ),
            },
          },
          redPointPolicy: 0,
          extension: { extJson: "{}" },
          ctx: { appVersion: "1.0", platform: "web" },
          mtags: {},
          msgReadStatusSetting: 1,
        },
        receivers: { actualReceivers: receivers },
      },
    ]);
  }

  close() {
    try {
      this.socket.close(1000, "cron complete");
    } finally {
      this.rejectPending(new Error("闲鱼 IM 连接已关闭"));
    }
  }

  private request(
    lwp: string,
    body?: unknown,
    headers: Record<string, unknown> = {},
  ) {
    const mid = this.nextMessageId();
    const envelope: WsEnvelope = {
      lwp,
      headers: { ...headers, mid },
      ...(body === undefined ? {} : { body }),
    };
    return new Promise<WsEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(mid);
        reject(new Error("闲鱼 IM 请求超时：" + lwp));
      }, 12_000);
      this.pending.set(mid, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify(envelope));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(mid);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async handleMessage(data: unknown) {
    try {
      const text =
        typeof data === "string"
          ? data
          : data instanceof ArrayBuffer
            ? new TextDecoder().decode(data)
            : String(data);
      const message = JSON.parse(text) as WsEnvelope;
      if (message.lwp === "/s/sync") {
        this.socket.send(
          JSON.stringify({ code: 200, headers: message.headers || {} }),
        );
      }
      const mid = String(message.headers?.mid || "");
      const pending = this.pending.get(mid);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(mid);
      if (message.code === undefined || message.code === 200) {
        pending.resolve(message);
      } else {
        pending.reject(
          new Error(
            "闲鱼 IM 请求失败：" +
              message.code +
              " " +
              JSON.stringify(message.body || {}),
          ),
        );
      }
    } catch {
      // Ignore non-JSON protocol frames such as pings.
    }
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private nextMessageId() {
    this.sequence += 1;
    return (
      Math.floor(Math.random() * 1000) +
      String(Date.now()) +
      " " +
      this.sequence
    );
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sortUserIds(first: string, second: string) {
  return [first, second].sort((left, right) => {
    if (left.length !== right.length) return left.length - right.length;
    return left.localeCompare(right);
  });
}

function base64Utf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}

function deliveryMessageUuid(orderId: string) {
  const numeric = orderId.replace(/\D/g, "").slice(-18);
  if (numeric) return `-${numeric}`;
  let hash = 0;
  for (const character of orderId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return `-${hash}`;
}
