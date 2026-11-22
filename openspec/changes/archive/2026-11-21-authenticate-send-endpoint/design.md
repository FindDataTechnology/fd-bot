# Design

## Context

动机见 `proposal.md`。落地前有三条实读事实：

1. `src/app.js` 现有 7 组路由；`/health` 与 `/v1/platforms` 是纯读，`/v1/media/:ticket`
   与 `/v1/callbacks/:platform/:secret` **已经有自己的准入**（HMAC 票据 / 平台验签 + 
   per-binding secret）。真正裸奔的是 `/v1/bindings*` 与 `/v1/send`。
2. 服务目前**没有任何"谁在调用"的概念**——没有用户、没有会话，只有连接。
   现有唯一的凭据比较工具是 `src/ids.js` 的 `tokenMatches`（常量时间）。
3. `config.js` 的 `configProblems()` 已经确立了「缺关键配置就拒绝启动」的先例
   （mediaSecret / credentialKey 短于 16 字符即 exit 2）。

## Goals / Non-Goals

Goals：
- 让「能改投递目的地」与「能发消息」这两件事需要凭据。
- 未配置凭据时**不通**，而不是放行——且这个选择要能被运维看见（503 + 点名）。
- 「哪些端点不鉴权」写成表，谁看都知道不是漏了。

Non-Goals：
- 不做用户级鉴权 / 多租户。fd-bot 是单租户基础设施，一个部署 token 足够；
  多租户在 `im-transport-service` 里是明确非目标。
- 不动 paas 的 `BOTS_RELAY_TOKEN`。那是「谁调 paas」，与「谁调 fd-bot」是两件事。
- 不给 `/health` 加鉴权（会打断探针）。

## Decisions

### D1 · 一个部署级 bearer，不是每 binding 一个

```
FD_BOT_API_TOKEN=<32+ 字节随机>
Authorization: Bearer <token>
```

**为什么不 per-binding**：调用方是「我们的运维/告警系统」，不是一个 binding 的
所有者。per-binding token 会让「给告警线发消息」变成「先创建 binding 再拿它的 token」，
而 binding 是平台连接单元，不该兼任 API 凭据。

**为什么不复用 `deliveryToken`**：那个是**服务 → 订阅者**方向的凭据，方向相反。
混用会让「能收信封的人」自动获得「能发消息」的权限。

**替代（否决）**：mTLS。集群内没铺证书体系，为两个端点引一套 PKI 不划算。

### D2 · 未配置时 503，不是放行，也不是拒绝启动

```js
if (!token) return res.status(503).json({ error: "…requires FD_BOT_API_TOKEN…" });
```

**为什么不拒绝启动**（像 mediaSecret 那样）：`/health` 必须能答，否则探针
会把一个「只差一个 token」的部署判成完全挂掉，运维拿不到任何信息。
503 + 点名让故障**可诊断**。

**为什么不是放行**：一个默认放行的鉴权等于没有鉴权——这正好是本 change 要消灭的
那种「声明了但没兑现」。paas 的 `bot-relay` 用的是同一套取向（无 token 时路由 404）。

### D3 · 常量时间比较，在解析 body 之前

复用 `src/ids.js` 的 `tokenMatches`。中间件挂在 **JSON 解析器之前**：

```js
const apiAuth = (req, res, next) => { … };            // 先验 token
app.post("/v1/bindings", apiAuth, json, handler);     // 再解析
app.post("/v1/send",     apiAuth, json, handler);
```

**为什么顺序要紧**：body 里是告警正文与 binding 凭据。先解析再验，等于让
未鉴权的请求把内容送进内存与可能的日志路径。`bot-relay` 在 paas 里为同一理由
让 `server.js` 对该前缀跳过全局 JSON 解析。

### D4 · 受保护端点的定义写成一处常量

```js
const PROTECTED = ["/v1/bindings", "/v1/send"];   // 前缀匹配
```

**为什么不是逐路由 `apiAuth`**：漏挂一个就是新的裸奔端点，而漏挂不会红。
一处常量 + 一个测试（遍历 `app._router` 断言这两个前缀下的所有路由都挂了中间件）
让「新增端点忘了保护」变成红灯。

**注**：`app._router` 是 Express 内部结构，测试里用它属于稳定的实用做法；
若将来 Express 换版本导致不可用，该测试应显式失败而不是静默跳过。

### D5 · 测试用真实 HTTP，不是 mock 中间件

每条 scenario 都经一次真实的 `fetch`：无 token → 401、错 token → 401、
对 token → 原行为、未配置 → 503、探针不受影响。**不注入假鉴权器**——
那会让「生产没挂上」这种故障在测试里看不出来。

## Risks / Trade-offs

- **[未配置就 503 会打断现有调用方]** 部署更新时若 secret 没同步注入，`/v1/send`
  会拒绝。→ 缓解：这是**有意的**（见 D2）；顺序上先加 secret 再加代码，tasks 里写明。
  当前唯一活着的调用方是告警线走 cell 路径，不调 fd-bot，所以实际无影响。
- **[单 token 无轮换机制]** 轮换要改部署并重启。→ 缓解：token 从 env 读，改 env 即轮换；
  fd-bot 已接受「配置变更需重启」（binding 也一样）。不引入热轮换。
- **[测试依赖 Express 内部结构]** D4 的遍历用了 `app._router`。
  → 缓解：测试在该结构不存在时显式失败，且另有 D5 的真实 HTTP 用例兜底——
  即使遍历失效，401/503 的行为仍被验证。

## Migration Plan

1. **先加 secret**：`fd-bot-secrets` 里新增 `apiToken`（`openssl rand -base64 32`）。
2. 部署清单加 `FD_BOT_API_TOKEN` 的 secretKeyRef。
3. 上代码（本文的两组端点开始要求 Bearer）。
4. 验：无 token 打 `/v1/send` → 401；带 token → 原行为；`/health` 不受影响。
5. **回滚**：撤掉代码即可（老版本不读这个 env，行为回到「裸奔」）。

## Open Questions

无。
