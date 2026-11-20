# fd-bot 运维手册

面向接手的人。三件事：**加一个平台**、**能力声明规则**、**出事时看哪里**。

## 1. 加一个平台（目标 30 分钟）

一个平台 = **一个模块 + 一次重启**。不需要出片（除非依赖变了），不需要改 paas。

### 1.1 写适配器

新建 `src/adapters/<platform>.js`，默认导出：

```js
export default {
  platform: "my-platform",                       // 稳定标识，进 binding 行
  outbound: { mode: "url-keyed", inbound: true }, // 四值枚举，见 §2
  inboundModes: ["callback"],                     // 或 ["poll"] / ["long-connection"]
  credentialFields: [{ key: "token", label: "Token", secret: true }],
  createTransport(binding, { fetchImpl } = {}) {
    return {
      inboundMode: "callback",
      async start(onMessage) {},   // 长连接/轮询腿在这里拨号；回调腿留空
      async stop() {},
      async sendText(chatKey, text) {},   // 失败必须 throw
      async downloadMedia({ platformMessageId, index }) {}, // 可选
    };
  },
  parseCallback({ raw, headers, query, method, credentials }) {
    // 验签失败 → throw（路由回 403，不落盘、不记内容）
    // 握手 → return { handshake: "原文" }
    // 消息 → return { message: { chatKey, senderId, senderName, text, media, platformMessageId } }
    // 无关载荷 → return { message: null }
  },
};
```

注册进 `src/adapters/index.js` 的 `adapters` 数组。

### 1.2 让闸告诉你缺了什么

```bash
npm test        # 能力闸遍历注册表本身
```

没有 `outbound`、`mode` 越界、`mode:"none"` 却 `inbound:true` → **红**。
**这不是警告**：进程启动时同样的检查会直接退出（exit 3）。一个能收不能寄的平台
如果安静地跑起来，就会变成一个面板上写错的字。

### 1.3 写测试

最低三条（照 `test/ported-adapters.test.mjs`）：
1. 一条真实形状的载荷 → 我们的信封（字段逐个断言）
2. 一条伪造/篡改的载荷 → 拒绝
3. `sendText` 的请求形状（URL、body）与被拒时的 throw

还要一条**声明**断言：`assert.deepEqual(adapter.outbound, {...})`。它是防止
「实现变了、声明没变」的唯一低成本手段。

### 1.4 真机判据（不能省）

单测证明的是**我们的接线**，证明不了**平台接受我们**。每个平台落地都要在真实出口上
跑一次：真发一条、真收一条。证据写进 change 的 tasks.md 对应任务。

> 能力声明只能保证「声明存在」，保证不了「声明为真」。`outbound.mode` 写错的方向
> 是**报喜**（写成 `url-keyed` 实为 IP 限制），面板会告诉操作员这条路没问题。

## 2. 能力声明规则

| `outbound.mode` | 含义 | 典型 |
|---|---|---|
| `url-keyed` | 凭据在 URL/body/header 里，**无调用方 IP 白名单** | telegram / slack / feishu / 企微群机器人 |
| `proactive-ip-gated` | 能主动发，但只从白名单 IP | 企微自建应用 / 公众号客服消息 |
| `passive-window` | 只能在近期入站打开的窗口内回复 | 企微智能机器人（回调腿） |
| `none` | 没有出流路径（此时 `inbound` 必须为 false） | — |

**为什么必须在这里声明**：`add-mattermost-channel` 的实测——Slack 落地时漏声明，
`outboundCapabilityFor("slack")` 返回 `{mode:"none"}`，面板说它「寄不回去」，
而它明明有 `chat.postMessage`。契约、实现、闸分处三地，就是新平台从旁边走过去的原因。

## 3. 出事时看哪里

### 3.1 「群里没反应」

按这个顺序查，每一层都有不同的判据：

```
① fd-bot 活着吗          curl $FD_BOT_URL/health
② 这条 binding 连着吗     GET /v1/bindings/:id → health.connected
③ 平台那边发出来了吗      平台后台的回调/长连接日志
④ 到了 fd-bot 却发不出去   POST /v1/send 的 failure 字段（三类，见 §3.2）
⑤ 投给订阅者了吗          fd-bot 日志 [deliver] giving up after N attempts
⑥ 订阅者收了吗           paas 日志 [bot-events] / [ingest]
```

**「transport-unreachable」≠「no-outbound-path」**：前者是服务挂了，后者是平台没这条路。
把前者读成后者，会让人去重新绑定一个配置正确的 bot。

### 3.2 发送失败三类

| `failure` | 含义 | 该做什么 |
|---|---|---|
| `ip-not-allowed` | 出口地址不被平台接受 | 换出口，或改用 `url-keyed` 的腿 |
| `reply-window-closed` | 被动回复窗口关了 | 等群里再说一句，或改用可主动发送的腿 |
| `other` | 其它（含凭据失效） | 看 `detail` |

分类**不是**对平台措辞做子串匹配（「not allow to access from your ip」这种句子平台
随时能改）。只信两个来源：我们自己适配器抛的稳定信号、平台 API 契约里的错误码。

### 3.3 受理队列

```bash
ls $FD_BOT_DATA_DIR/acceptance/*.json | wc -l    # 待处理 + 已处理（24h 内）
```

三态：`pending`（未投递 → 重启会补投）、`dispatched`（投递已开始，结果未知）、
`done`（含 `note:"duplicate"` 与 `note:"failed: …"`）。

`dispatched` 在重启后被标成 `done` 并注明 `outcome unknown` ——重投可能造成重复信封，
而在途请求本身的丢失是诚实的缺口，和每一个被 kill 的请求一样。

### 3.4 媒体取件地址

信封里给的是**地址**不是字节：`/v1/media/<ticket>`。

- ticket = HMAC 签名的 `{bindingId, platformMessageId, index, kind, mime, exp}`，TTL 5 分钟
- **不接受调用方提供的 URL**：SSRF 面在服务内部关闭
- 过期/篡改 → 410；binding 已删 → 410；平台已回收该媒体 → 404
- 平台侧媒体 URL 本身也只有几分钟寿命，所以「三天后补看」不在本服务范围内

## 4. 部署与回滚

```bash
kubectl apply -f k8s/fd-bot.yaml
```

- **单副本 + `Recreate`**：受理队列在 local-path PVC 上，两个 pod 会抢同一目录
- **节点钉死**（`nodeSelector`）：local-path 卷跟着节点走
- Secret 里的 `<CHANGE-ME>` 是 10 个字符，短于服务的 16 字符下限 → **启动失败**。
  这是有意的：占位符不能变成生产密钥

**一条腿回滚**：把该 bot 行的 transport 切回 `legacy`（`db.setBotTransport(id, "legacy")`）。
不需要回滚 fd-bot 本身，也不需要动已迁移的其它腿。

## 5. 这个服务刻意不做的事

- **不做统一富消息模型**：信封这一层就停。再往上统一（卡片/按钮/投票）会把各家差异
  抹平成最小公倍数。
- **不做房间/席位/计费/话术**：那些在 paas，是产品本体。
- **不做插件热加载**：新平台 = 发版 + 重启，已经比出片好一个数量级。
