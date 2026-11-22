# Proposal

## Why

`POST /v1/send` 从服务建立起就没有鉴权。当时的理由是「只在集群内被调用」——
这个理由在 2026-11-21 第一次被动摇：告警线开始经它投递，而告警 CronJob 跑在
**另一个 namespace** 的 pod 里。

现在的暴露面比一句话更大：

```
能打到 fd-bot:8791 的任何东西
  ├─ /health          只读，无需鉴权（探针要它）
  ├── /v1/platforms   只读，无需鉴权（能力清单，非敏感）
  ├── /v1/bindings *  ← 能建/删/读 binding，等于能改投递目的地、能读凭据「已配置」清单
  ├── /v1/send        ← 能以任意 binding 向任意 chatKey 发任意文本
  ├── /v1/media/:t   ← 有票据才够（票据是 HMAC 签名，这一层已经自洽）
  └── /v1/callbacks/  ← 平台回调，已用 per-binding callbackSecret 验
```

**`/v1/bindings` 和 `/v1/send` 是真正的问题**：前者能改、后者能发。
任何能在集群里起一个 pod 的人，都能以我们的平台身份向任意群发消息。

同一份 `im-transport-service` 规格里已经有一条要求叫「凭据不出服务边界」——
它守的是凭据**值**不外泄；而「谁能调用」这件事从来没写过。

## What Changes

- **加 Bearer 鉴权**：一个部署级 secret（`FD_BOT_API_TOKEN`），保护
  `/v1/bindings*`（含 GET/POST/DELETE）与 `/v1/send`。
- **明确不保护的**：`/health`（探针）、`/v1/platforms`（能力清单，非敏感）、
  `/v1/media/:ticket`（票据自证）、`/v1/callbacks/*`（平台侧 secret 自证）。
  这四个各有自己的准入方式，套 Bearer 要么打断探针，要么重复一层。
- **未配置 token 时的行为**：`/v1/bindings*` 与 `/v1/send` **返回 503 并不通**，
  不是「放行」。一个「没配密码就开门」的鉴权等于没做——这条与
  `bot-relay` 在 paas 里的先例同形（无 token 时路由不存在）。
- **调用方同步**：告警线（`relay-alert-channel` 的 cell 路径不受影响，它走 paas；
  fd-bot 路径需要带 token）、以及 `paas` 侧若将来切到 fd-bot 也要带。
- **本 change 不改 paas**：paas 侧的 bot relay 有自己的 token（`BOTS_RELAY_TOKEN`），
  与 fd-bot 的 token 是两件事。fd-bot 的 token 只服务「谁调 fd-bot」。

## Capabilities

### New Capabilities

无。这是对既有能力的补齐。

### Modified Capabilities

- `im-transport-service`：「凭据不出服务边界」之外，新增一条**调用面准入**要求——
  能改投递目的地与能发消息的端点必须鉴权，未配置凭据时不通，且
  「不保护的端点」必须逐个说清各自的准入方式（否则下一个人会以为漏了）。

## Impact

- **代码**：`fd-bot/src/app.js`（一个中间件 + 挂到两个端点组）、`src/config.js`
  （新环境变量）。
- **契约**：`fd-bot/openspec/specs/im-transport-service/spec.md`（新增 requirement）。
- **部署**：`fd-infra-deploy/all-services/fd-bot/fd-bot.yaml` 加 `FD_BOT_API_TOKEN`
  （secret 里加一个 key）。
- **调用方**：告警线若走 fd-bot（当前走 cell，不受影响）；`fd-bot-web` 是静态站，
  不调 `/v1/*`，不受影响。
- **不做**：
  - 不给 `/health`、`/v1/platforms` 加鉴权（探针与公开能力清单）。
  - 不引入用户级鉴权/多租户（fd-bot 是单租户基础设施，一个部署级 token 足够；
    多租户是 `im-transport-service` 明确非目标）。
  - 不动 paas 的 `BOTS_RELAY_TOKEN`。

## 附带的发现（不在本 change 处理）

`im-transport-service` 现在有**两份 spec 副本**：`fd-bot/openspec/specs/`（182 行，正本，
随 `unify-im-solution C0` 搬到服务仓）与工作区根 `openspec/specs/`（152 行，已过期）。
根目录那份缺 `assignee` / `conversationStatus` 等要求。删它属于那个 change 的收尾范围，
本 change 只在 Impact 里记一笔，不动它。
