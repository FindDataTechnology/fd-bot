# Spec Delta

## ADDED Requirements

### Requirement: 能改投递目的地与能发消息的端点必须鉴权

服务 SHALL 对「能改投递目的地」与「能发消息」的端点要求凭据：binding 的增删读
（`/v1/bindings` 与 `/v1/bindings/:id`）与发送（`/v1/send`）。凭据 SHALL 是部署级
bearer token，以常量时间比较，且 MUST 在读取请求体之前校验。

凭据 SHALL 由部署注入，MUST NOT 出现在任何应答、日志或错误消息中。

#### Scenario: 无凭据的调用被拒绝

- **WHEN** 一个请求不带 bearer token 打向 `/v1/send` 或 `/v1/bindings*`
- **THEN** 服务 SHALL 以 401 拒绝，且 MUST NOT 读取或记录请求体内容

#### Scenario: 凭据正确时正常放行

- **WHEN** 请求带的 bearer token 与部署注入的一致
- **THEN** 该端点 SHALL 按原行为处理，不额外要求任何其它身份

#### Scenario: 凭据错误与缺失同形

- **WHEN** 请求带的 bearer token 存在但与部署注入的不一致
- **THEN** 应答 SHALL 与「未提供凭据」同形（同为 401），MUST NOT 泄露「token 存在但错」

### Requirement: 未配置鉴权凭据时服务不通而不放行

当部署没有注入鉴权凭据时，受保护的端点 SHALL 拒绝服务（503）并如实说明「未配置」，
MUST NOT 以「没有配置密码所以不需要密码」的方式放行。一个默认放行的鉴权等于没有鉴权。

#### Scenario: 未配置凭据时受保护端点不可用

- **WHEN** 部署未注入鉴权凭据，调用方以任意 token 打向 `/v1/send`
- **THEN** 服务 SHALL 返回 503 并指明该功能不可用
- **THEN** MUST NOT 因为「未配置」而放行该请求

### Requirement: 不鉴权的端点必须逐个说明各自的准入方式

除上述受保护端点外，服务 SHALL 明确哪些端点不要求 bearer 凭据，并逐个说明其准入方式；
未被说明的端点 SHALL 被视为遗漏而非默认允许。

| 端点 | 准入方式 |
|---|---|
| `/health` | 无凭据。只回答 `{ok, bindings}`，供探针与编排使用 |
| `/v1/platforms` | 无凭据。只回能力清单（平台类型、能力声明），不含凭据也不含投递目标 |
| `/v1/media/:ticket` | 票据自证：HMAC 签名的短期票据，绑定 binding 与平台消息标识 |
| `/v1/callbacks/:platform/:secret` | 平台自身验签 + per-binding callback secret |

#### Scenario: 探针不受鉴权影响

- **WHEN** 未携带任何凭据的探针请求打向 `/health`
- **THEN** 服务 SHALL 正常应答，MUST NOT 返回 401

#### Scenario: 媒体票据本身就是准入凭据

- **WHEN** 请求打向 `/v1/media/<ticket>` 且票据签名有效、未过期
- **THEN** 服务 SHALL 返回该媒体，不额外要求 bearer token
- **AND** 票据无效或过期时应答 410，与是否带 bearer 无关
