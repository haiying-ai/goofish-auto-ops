# goofish-auto-ops

一个可完整部署到 OpenAI Sites / Cloudflare Workers 的免费闲鱼商品运营面板。本地电脑无需常驻运行。

## 当前能力

- 同步闲鱼账号商品，并对账在售 / 已下架状态
- 创建发布队列，由 Cron 或“立即执行”真实发布商品
- 直接上传 PNG、JPG、WEBP、HEIC 商品图，或填写远程图片链接
- 修改在售商品的标题、售价 / 原价、库存、运费、自提、类目、规格、属性、描述和图片
- 下架在售商品
- 按关键词、状态和来源筛选商品
- Cron 扫描卖家待发货订单；固定文本和卡密库存自动发消息并确认发货
- 未配置固定文本或卡密不足时，仅发送一次邮件提醒，不会误确认发货
- 为商品配置并查看固定文本、卡密库存、预留状态和使用明细
- 闲鱼 MTop 临时令牌自动续期；长期登录失效时才需重新采集 Cookie
- D1 持久化、任务租约、幂等记录和每分钟一次写操作的风控保护

## 部署要求

- Node.js `>=22.13.0`
- OpenAI Sites 项目，绑定 D1 为 `DB`
- Sites 加密环境变量：
  - `XIANYU_COOKIE`：闲鱼网页端完整 Cookie
  - `CRON_SECRET`：Cron 调用密钥
  - `RESEND_API_KEY`：Resend 免费邮件 API 密钥，用于缺配置告警
  - `ALERT_EMAIL`：可选，告警收件人；默认 `bingsun2020@163.com`
  - `ALERT_FROM_EMAIL`：可选，已验证的发件地址；默认使用 Resend 测试发件人

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

## 重要说明

本项目调用闲鱼当前网页端使用的接口，接口字段可能随平台更新而变化。请控制操作频率，并遵守闲鱼平台规则。Cookie 只应放在 Sites 的加密环境变量中，禁止提交到 Git。

## License

[MIT](LICENSE)
