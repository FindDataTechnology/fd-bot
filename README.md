# fd-bot

> **Part of the [Base line (寻数·壹座)](https://www.finddatatech.cloud/products/base) of [FindData](https://www.finddatatech.cloud)** — IM transport service: platform protocols and connections, nothing else.
>
> [Product page](https://www.finddatatech.cloud/products/fd-bot) · [中文产品页](https://www.finddatatech.cloud/zh/products/fd-bot) · [Operations manual](docs/OPERATIONS.md)

外部 IM 的传输层。承接 `openspec/changes/adopt-fd-bot-transport`。

## 边界（一句话）

**fd-bot 知道「这个平台允许你做什么」，不知道「你要拿它做什么」。**

它持有平台凭据与连接、做验签与解密、把原生载荷规范化成一份信封、把发送结果分类后返回。
它**不做**：房间、席位、会话归属、计费、话术、事件白名单、消息内容的业务解释。

归属由调用方以**不透明** `bindingId` 声明；fd-bot 不解析这个标识的内部结构，也不推断它
与用户、房间或租户的关系。

## 为什么要有这一层

见 `openspec/changes/adopt-fd-bot-transport/proposal.md`。三条：

1. 协议代码在 cell 镜像里 → 改一行要走出片链。
2. 契约、实现、能力闸分处三地 → 新平台漏声明不会红（`add-mattermost-channel` 实测）。
3. 每个 cell 各自连平台 → N 条长连接、N 份凭据、N 个断线重连状态机。

## 跑起来

```bash
npm start                        # 默认 :8791
curl -s localhost:8791/health
curl -s localhost:8791/v1/platforms
```

当前是骨架：`/health`、`/v1/platforms`、`/v1/bindings`（CRUD 与能力）、`/v1/send`、
受理队列与订阅者投递。平台适配器逐条落地（见 tasks 5.x / 7.x）。

## 契约

```
POST /v1/bindings      { platform, credentials, subscriberUrl, inboundMode? }
                       → 201 { id, platform, outbound:{mode,inbound}, inboundModes, health }
GET  /v1/bindings/:id  → 200 同上 / 404
GET  /v1/platforms     → 200 [{ platform, outbound, inboundModes }]
POST /v1/send          { bindingId, chatKey, text }
                       → 200 { ok:true }
                       → 200 { ok:false, failure, detail }   ← 平台判定，不是本服务故障
                       → 404/400  ← 本服务侧的错误（未知 binding / 缺字段）
POST /v1/callbacks/:platform/:secret   ← 平台回调入口（验签/解密后落盘再应答）
GET  /v1/media/:token                  ← 短期取件地址（HMAC 票据，TTL 5 分钟）
```

事件信封（fd-bot → `subscriberUrl`，`Authorization: Bearer <deliveryToken>`）：

```json
{
  "platform": "wecom-bot",
  "bindingId": "b_...",
  "chatKey": "wr...",
  "senderId": "zhangsan",
  "senderName": "张三",
  "text": "…",
  "media": [{ "kind": "image", "url": "https://…/v1/media/…", "mime": "image/jpeg" }],
  "platformMessageId": "1234567890",
  "receivedAt": 1732000000000
}
```

调用方 2xx 即确认；非 2xx 或超时 → 退回队列重试（指数退避，上限后标记 failed）。

## Adding a platform

一个适配器是一个模块，导出五个必填字段：

```js
export default {
  platform: "wecom-bot",
  outbound: { mode: "proactive-ip-gated", inbound: true }, // 四值枚举，见下
  inboundModes: ["callback", "long-connection"],
  credentialFields: [{ key: "botId", label: "Bot ID" }, { key: "secret", label: "Secret", secret: true }],
  createTransport(binding) {
    return {
      inboundMode: "long-connection",
      async start(onEvent) { /* … */ },
      async stop() { /* … */ },
      async sendText(chatKey, text) { /* … */ },
      async downloadMedia(item) { /* → { buffer, mime, filename } */ },
    };
  },
};
```

`outbound.mode` 四值：

| 值 | 含义 |
|---|---|
| `url-keyed` | 凭据在 URL/body 里，无调用方 IP 白名单——换出口不受影响 |
| `proactive-ip-gated` | 能主动发，但只从白名单 IP |
| `passive-window` | 只能在一个近期入站打开的窗口内回复 |
| `none` | 没有出流路径 |

**声明不等于事实。** 能力闸（`npm test`）只保证「每个平台都声明了」，保证不了「声明为真」。
每个平台落地时都要在真实出口上跑一次发送，把证据写进
`openspec/changes/adopt-fd-bot-transport/tasks.md` 的对应任务。

`outbound` 缺失或取值越界 = **服务起不来**（不是警告）。理由：一个能收不能寄的平台如果不
响亮地失败，就会变成一个面板上写错的字，而没人知道。

## 媒体

信封里给的是**取件地址**，不是字节。地址由 fd-bot 签发（HMAC，绑定 bindingId +
platformMessageId，TTL 5 分钟，一次性），取件时按需从平台下载并解密。

不接受调用方提供的任意 URL —— SSRF 面在服务内部关闭。

## 测试

```bash
npm test        # node --test test/
```

按工作区纪律，**执行类验证在 CI 跑**（`.github/workflows/test.yml`），本机只做静态检查。

## 部署（cheap 集群）

清单**不在本仓**（2026-11-20 起：部署清单集中在部署仓，源仓不留副本）：

```
fd-infra-deploy/all-services/fd-bot/fd-bot.yaml    namespace + PG + Deployment + NodePort 31915
fd-infra-deploy/argocd/app-fd-bot.yaml             ArgoCD Application
```

先建 Secret（**不入仓**）：

```bash
kubectl -n fd-bot create secret generic fd-bot-secrets \
  --from-literal=databaseUrl='postgres://...' \
  --from-literal=mediaSecret="$(openssl rand -base64 32)" \
  --from-literal=credentialKey="$(openssl rand -base64 32)"
```

单副本 + `Recreate`：受理队列在 local-path PVC 上，两个 pod 会抢同一个目录。
绑定在 PG（durable）；连接状态不持久——长连接自己重连，受理队列补发期间到达的消息。
Pod 与 PG 都钉在 cheap-4（当日磁盘余量最大的一台）。

端口 31915 在 `fd-infra-deploy/PORTS.md` 是**预留**值，apply 前须重做全集群枚举 + 节点 nc 双验。

## 不做

- 不做「平台无关的统一富消息模型」。统一到信封这一层就停。
- 不做插件热加载：新平台 = 发版 + 重启，已经比出片好一个数量级。
- 不做房间/席位/计费/话术——那些在 paas。
