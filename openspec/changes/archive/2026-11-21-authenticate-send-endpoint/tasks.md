# Tasks

> 判据一律是**真实 HTTP**（`fetch`），不注入假鉴权器——那会让「生产没挂上」
> 在测试里看不出来。每条验收都写明怎么红。

## 1. 配置与凭据

- [x] 1.1 `src/config.js` 增加 `apiToken`（读 `FD_BOT_API_TOKEN`）。
      **不加进 `configProblems()`**：缺它不该阻止启动（`/health` 必须能答，
      见 design D2），而是让受保护端点回 503。
      验收：`loadConfig({})` 的 `apiToken === ""`；设了环境变量时读得到。
- [x] 1.2 `fd-infra-deploy/all-services/fd-bot/fd-bot.yaml`：Deployment 的 env 加
      `FD_BOT_API_TOKEN`（secretKeyRef `fd-bot-secrets/apiToken`）。
      验收：`kubectl get deploy -o jsonpath` 能看到该 env 的 secretKeyRef。
      **顺序**：先建 secret 再上代码，否则会有一段 503 窗口。

## 2. 中间件与挂载

- [x] 2.1 `src/app.js` 加 `apiAuth` 中间件：读 `Authorization: Bearer …`，
      用 `tokenMatches` 常量时间比较；未配置 token → 503 并点名
      `FD_BOT_API_TOKEN`；缺失/错误 → 401（两者同形）。
      验收：三个分支各一条单测。
- [x] 2.2 挂到 `PROTECTED = ["/v1/bindings", "/v1/send"]` 前缀，
      **且在 `json` 解析器之前**。
      验收：读 `app.js` 的路由注册顺序，`apiAuth` 出现在 `json` 之前。

## 3. 行为验证（真实 HTTP）

- [x] 3.1 无 token 打 `/v1/send` → 401，且响应里不含请求体内容。
      验收：单测断言状态码与「不回显 body」。
- [x] 3.2 错 token → 401，应答与 3.1 **逐字节同形**（不泄露「token 存在但错」）。
      验收：两条响应的 body 相等。
- [x] 3.3 对 token → 原行为（mock 一个能成功的 transport，断言 `{ok:true}`）。
      验收：单测。
- [x] 3.4 未配置 token（`cfg.apiToken = ""`）→ 受保护端点 503，且 body 里出现
      `FD_BOT_API_TOKEN` 字样。
      验收：单测；**另有一个反向断言**——同一服务实例上 `/health` 仍 200。
- [x] 3.5 `/v1/platforms`、`/v1/media/:ticket`、`/v1/callbacks/*` **不受影响**：
      分别在无 bearer 的情况下调用，行为与改动前一致。
      验收：三条单测。

## 4. 「漏挂」的结构性闸

- [x] 4.1 一条测试遍历 Express 路由表，断言 `PROTECTED` 前缀下的**每一条**路由都挂了
      `apiAuth`。
      验收：新建一条 `/v1/bindings/:id/whatever` 路由但不挂鉴权时该测试红
      （写一个临时的失败用例证明，然后删掉）。
- [x] 4.2 同一条测试还要断言：`PROTECTED` 之外的公开端点在**没有** bearer 时仍可达。
      验收：`/health` 与 `/v1/platforms` 各一条。

## 5. 真机

- [x] 5.1 部署后（secret 先建、代码后上）：集群内无 token 打 `/v1/send` → 401；
      带 token → 原行为；`/health` → 200。
      验收：三份真实 `wget`/`curl` 输出。
      **实测（2026-11-21，v0.1.7）**：无 token `/v1/send` → `401 Unauthorized`；无 token `/health` → `{ok:true,bindings:1}`；无 token `/v1/platforms` → 能力清单；带 token `/v1/bindings` → binding 列表。
- [x] 5.2 回滚演练：撤掉 env 里的 `FD_BOT_API_TOKEN`，确认受保护端点转 503 且
      `/health` 仍 200（证明「不通但不假死」）。
      验收：一次真实调用。
      **实测**：`kubectl set env FD_BOT_API_TOKEN=` → `/v1/send` 回 `503 Service Unavailable`，同实例 `/health` 仍 `{ok:true}`。恢复后复验 401/放行。

## Workflow follow-up

- 告警线若将来从 cell relay 切到 fd-bot（`relay-alert-channel` 的后端 B），
  需要给它注入同一个 token；那时在本仓与 fd-infra-deploy 同步一处即可。
- 工作区根 `openspec/specs/im-transport-service/spec.md` 是过期副本（152 行，
  正本在 `fd-bot/openspec/`，182 行）。删它归 `unify-im-solution` 收尾，不在本 change。
