# goofish-auto-ops

一个可完整部署到 OpenAI Sites / Cloudflare Workers 的免费闲鱼商品运营面板。本地电脑无需常驻运行。

[![CI](https://github.com/haiying-ai/goofish-auto-ops/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/haiying-ai/goofish-auto-ops/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=nodedotjs&logoColor=white)
![Deploy](https://img.shields.io/badge/Deploy-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)

## 为什么做这个

闲鱼卖家的自动化脚本通常有三个绕不过去的问题：

- **本地必须常驻**。电脑一关，队列就停，Cron 形同虚设。
- **登录态会过期**。MTop 临时令牌有效期内可以续，但长期 Cookie 一旦失效就得回浏览器重抓，脚本往往在最需要的时候报错。
- **发货怕重复**。卡密先扣后用，如果"发内容"和"确认发货"之间断掉，重试很容易把同一份卡密发两次，或者钱货两空。

这个项目把这三件事放到 Worker 上跑：Cron 触发发布与发货，令牌到期自动续期，写操作之间强制 60 秒间隔；发货采用"先发内容、再确认"的两步幂等记录，第二步失败只重试确认，不重发内容。

## 当前能力

**商品**

- 同步闲鱼账号商品，并对账在售 / 已下架状态
- 创建发布队列，由 Cron 或"立即执行"真实发布商品
- 直接上传 PNG、JPG、WEBP、HEIC 商品图，或填写远程图片链接
- 修改在售商品的标题、售价 / 原价、库存、运费、自提、类目、规格、属性、描述和图片
- 下架在售商品
- 按关键词、状态和来源筛选商品

**订单与交付**

- Cron 扫描卖家待发货订单；固定文本和卡密库存自动发消息并确认发货
- 未配置固定文本或卡密不足时，仅发送一次邮件提醒，不会误确认发货
- 为商品配置并查看固定文本、卡密库存、预留状态和使用明细

**运行保障**

- 闲鱼 MTop 临时令牌自动续期；长期登录失效时才需重新采集 Cookie
- D1 持久化、任务租约、幂等记录和每分钟一次写操作的风控保护
- 健康检查接口汇总最近 20 轮任务、令牌有效期与告警状态

**给 AI 用**

- 内置 MCP 服务器（`/api/mcp`），把上面的能力暴露成工具，可直接接入 ChatGPT 连接器或其他 MCP 客户端
- OAuth 授权 + 所有者邮箱白名单，只有账号本人能操作

## 架构

```text
浏览器 / ChatGPT 连接器 / MCP 客户端
              │  OAuth（所有者邮箱白名单）或 MCP_SHARED_SECRET
              ▼
   Worker（Next.js App Router，经 vinext 编译）
     ├── /api/products   /api/orders   /api/inventory   → 业务动作
     ├── /api/jobs/run   ← Cron（Bearer CRON_SECRET）
     ├── /api/mcp        → MCP 工具层（复用同一批路由）
     └── /api/health     → 运行状况
              │
              ├── D1（13 张表：商品 / 订单 / 卡密 / 投放规则 / 任务租约 / OAuth）
              └── 闲鱼网页端接口（MTop），写操作 ≥60s 间隔
```

## 部署要求

- Node.js `>=22.13.0`
- OpenAI Sites 项目，绑定 D1 为 `DB`
- Sites 加密环境变量：

| 变量 | 必需 | 作用 |
| --- | --- | --- |
| `XIANYU_COOKIE` | 是 | 闲鱼网页端完整 Cookie，首次同步用 |
| `CRON_SECRET` | 是 | Cron 调用 `/api/jobs/run` 的 Bearer 密钥 |
| `DATA_ENCRYPTION_KEY` | 是 | AES-GCM 加密落库的 Cookie 与卡密；缺失时保存动作直接报错，不会降级为明文 |
| `AUTO_OPS_OWNER_EMAIL` | 建议 | 允许操作的所有者邮箱，配合 OAuth 使用 |
| `MCP_SHARED_SECRET` | 可选 | 无 OAuth 时用固定密钥访问 `/api/mcp` |
| `RESEND_API_KEY` | 可选 | Resend 邮件 API 密钥，用于缺配置告警 |
| `ALERT_EMAIL` | 可选 | 告警收件人；未配置时不发送告警邮件（日志提示 `尚未配置 ALERT_EMAIL`） |
| `ALERT_FROM_EMAIL` | 可选 | 已验证的发件地址；默认用 Resend 测试发件人 |

构建：

```bash
npm ci
npm run build
```

定时任务入口：

```http
POST /api/jobs/run
Authorization: Bearer <CRON_SECRET>
```

建议每 5 分钟触发一次。每轮最多处理一个待发布商品和 25 笔待发货订单；发布、修改和下架操作之间强制至少间隔 60 秒。订单先发送交付内容，再调用闲鱼确认发货；若第二步失败，下轮只重试确认发货，不重复发送内容。

## 目录结构

```text
app/            页面与 API 路由（products / orders / inventory / jobs / mcp / health）
lib/            闲鱼接口、会话续期、幂等发货、邮件告警、密钥加解密
db/             Drizzle schema（13 张表）与连接
worker/         Worker 入口
drizzle/        生成的迁移
scripts/        受限环境下的安装与构建脚本
tests/          渲染产物断言（npm test）
```

## 本地开发说明

这个项目依赖 Sites 运行时（`vinext`、`wrangler`、D1 绑定），并且 `scripts/install-ci.sh` 与 `scripts/build-verified.sh` 用到了 `flock`、GNU `timeout`、`sha256sum`，因此：

- **Linux / WSL 可直接跑**：`npm run install:ci` → `npm run dev`
- **macOS** 需先装 `flock`（`brew install flock`）与 GNU `timeout`（`brew install coreutils`）
- **原生 Windows 不适用**：缺少 `flock`，请走 WSL
- 没有 D1 绑定时页面能起，但任何读写都会失败

## 安全模型

- **所有入口只认所有者**：OAuth 邮箱必须等于 `AUTO_OPS_OWNER_EMAIL`，或提供 `MCP_SHARED_SECRET`；没有"注册"概念
- **Cookie 与卡密加密落库**：AES-GCM 加密，附加数据绑定作用域与所有者，换账号解不开；`DATA_ENCRYPTION_KEY` 缺失时保存直接失败，代码里没有明文兜底分支
- **写操作限速**：每分钟最多一次上架/修改/下架，避免触发风控
- **幂等优先**：发货记录先落库再执行，重试只补未完成的一步

漏洞报告方式见 [SECURITY.md](SECURITY.md)，请勿用公开 Issue 提交敏感问题。

## 常见问题

**会不会封号？**
项目只调用网页端自身接口并主动限速，但平台规则随时会变。频率、品类、账号历史都会影响风险，请自行评估并遵守闲鱼规则。

**Cookie 多久失效？**
MTop 令牌会在有效期内自动续期；长期 Cookie 失效后需重新采集一次 `XIANYU_COOKIE`。健康检查页会显示当前令牌剩余时间。

**卡密会不会发重？**
不会。订单先写入交付记录并扣减库存，再调用确认发货；若确认失败，下轮只重试确认这一步。

**为什么必须用 Sites / Workers？**
因为核心诉求是"本地不用开机"。Cron、D1 和常驻 HTTP 入口都由平台提供，搬到自己的服务器同样可行，但要自己实现定时与存储。

## 合规与免责

本项目调用闲鱼当前网页端使用的接口，接口字段可能随平台更新而变化。请控制操作频率，并遵守闲鱼平台规则。Cookie 只应放在 Sites 的加密环境变量中，禁止提交到 Git。因使用本项目导致的账号风险、交易纠纷或数据损失由使用者自行承担。

## 参与贡献

- 提交前请跑 `npm test`（会先 `npm run build`）
- 涉及数据库或写操作的改动，请在 PR 模板中说明幂等与回滚方式
- 功能建议走 Issue 模板，附上复现步骤

## License

[MIT](LICENSE)
