# Connector 通信协议（开发中）

Community API 当前只监听本机；Connector 仅允许回环 HTTP 或使用系统证书校验的 HTTPS。配对码由管理员通过可信渠道交给 Connector，格式为 `pairingId.secret.platformPublicKey`，五分钟有效且只能使用一次。第三段固定平台公钥；Connector 验证所有平台确认消息及任务的签名。远程 HTTPS 部署尚未验收。

平台持久保存 Connector 公钥、所有者、撤销状态、加密的待配对验证密钥、近期随机数和诊断任务，不保存 Connector 私钥。配对码哈希可直接用于生成配对证明，因此属于敏感凭据；它使用由平台注册表密钥独立派生的密钥加密存储。平台注册表完整性密钥放在操作系统凭据管理器中，并派生独立的平台签名密钥；Connector 私钥也放在其运行机器的操作系统凭据管理器中。默认状态文件位于 `apps/community-api/.runtime/connectors.json`，可通过 `CONNECTOR_STATE_PATH` 指定。Windows 使用凭据管理器，Linux 需要可用的 Secret Service，不提供明文降级。状态文件和凭据管理器需要一起保护和备份；跨机器恢复尚未验证。注册表完整性或凭据状态异常时拒绝加载，不自动修改已有状态。历史备份或异常遗留文件可能包含敏感信息，应妥善保护。`BETTER_AUTH_SECRET` 仍用于登录会话，不作为新注册表的密钥。

## 版本与签名格式

项目尚未上线，仅维护当前平台与 Connector 使用的协议，不提供假想旧版本的兼容分支。配对与结构扫描消息使用各自的 `connector-v2` 签名域；心跳、探测、轮换和诊断使用 `connector-v1` 签名域。它们是当前不同消息的格式标识，不代表已发布过旧版本；不符合当前格式的消息直接拒绝。

消息字段按下列顺序以单个 LF 连接，UTF-8 编码，末尾无 LF；公钥和签名使用无填充 base64url。时间均为 Unix 秒十进制，nonce 为随机 32 字节 base64url：

- 配对证明：`proof` 为 `base64url(HMAC-SHA256(SHA256(UTF8(secret)), UTF8(message)))`，其中 `message` 依次为 `connector-v2`, `pair-proof`, `pairingId`, `connectorId`, `name`, `publicKey`, `agentVersion`, `2`。服务端使用已有的配对码哈希校验证明。**配对请求不传输原始 secret 或其可直接替代的哈希**，证明绑定本次 Connector 身份及公钥，无法被中间人改成自己的身份。
- 配对签名：`connector-v2`, `pair`, `pairingId`, `proof`, `connectorId`, `name`, `publicKey`, `agentVersion`, `2`。
- 心跳：`connector-v1`, `heartbeat`, `connectorId`, `agentVersion`, `1`, `timestamp`, `nonce`。
- 一次性身份探测：`connector-v1`, `probe`, `connectorId`, `agentVersion`, `1`, `timestamp`, `nonce`。平台验证身份、撤销、时间和重放，但不更新在线状态；用于配对及轮换恢复。
- 轮换：`connector-v1`, `rotate`, `connectorId`, `newPublicKey`, `agentVersion`, `1`, `timestamp`, `nonce`，由旧私钥签名。
- 诊断任务：`connector-v1`, `task`, `id`, `connectorId`, `actorId`, `diagnostic`, `issuedAt`, `expiresAt`, `nonce`, `1`，由平台签名。
- 诊断结果：`connector-v1`, `result`, `connectorId`, `taskId`, `ok`, `agentVersion`, `1`, `timestamp`, `nonce`，由 Connector 签名。
- 结构扫描任务：`connector-v2`, `schema-scan`, `id`, `connectorId`, `actorId`, `workspaceId`, `sourceId`, `issuedAt`, `expiresAt`, `nonce`, `2`，由平台签名；Connector 独立核对本机数据源所属连接器及允许的工作区。
- 结构扫描结果：`connector-v2`, `scan-result`, `connectorId`, `taskId`, `workspaceId`, `sourceId`, `outcome`, `sha256(payload)`（小写十六进制）, `agentVersion`, `2`, `timestamp`, `nonce`，由 Connector 签名。成功的 payload 是结构 JSON 的无填充 base64url；失败时仅允许固定错误码，不携带密码或原始异常。
- 只读查询任务：`connector-read-v1`, `read-query`, `id`, `connectorId`, `actorId`, `workspaceId`, `sourceId`, `sha256(payload)`（小写十六进制）, `issuedAt`, `expiresAt`, `nonce`, `1`；payload 为查询与参数 JSON 的无填充 base64url，由平台签名。Connector 独立验证本机连接、工作空间、表和字段权限，再重建允许的参数化 SQL。
- 模型结构任务：签名字段与只读查询相同，但第二项为 `model-schema`，操作类型为 `model_schema`。管理员常规请求的 payload 为 `{}`；委托结构请求的 payload 为仅含 `delegatedScope` 的对象，列出授权的表和字段，二者均使用无填充 base64url。Connector 在验签后将委托范围与本机当前工作区表、字段授权取交集，再现场采集；返回基础表名、获授权字段名、简化后的字段类型和各表的结构版本摘要。平台只向模型发送库名、表名、字段名及类型，不发送摘要、数据库行、视图、结构注释或枚举值。任务和返回仍由原任务 nonce、身份、来源和有效期绑定。
- 模型授权确认：用户确认发送后，平台另发 `model_authorize` 任务，签名第二项为 `model-authorize`，payload 为 `{}`。首次派发时有效期 30 秒，Connector 验签并核对发放时间与本机时钟相差不超过 2 秒，将数据源短租约持久写入系统凭据库至任务截止后 3 秒，再采集与预览同样的授权结构及版本。成功结果还包含 `leaseExpiresAt`，须等于签名任务截止时间。平台核对预览和新结果，至少剩余 5 秒才发起模型请求；请求体须在截止前 2 秒交给本地网络栈，否则中止。已发送后的模型响应可继续等待，超时或失败按模型调用错误处理。

模型结构和授权结果的每张表必须包含 `version` 与 `structureHash`（64 位小写十六进制）。后者用于平台核对语义快照与实时物理结构；按列序号排列，依次对 `semantic-structure-v1`、数据库名、表名、`BASE TABLE` 以及每列的名称、完整类型、可空标记（`1`/`0`）、序号十进制做 SHA-256，每项为 8 字节大端无符号 UTF-8 字节长度和内容。Connector 在持有元数据锁的同一只读事务中读取列并计算两类摘要；缺少或不一致即拒绝。完整类型、摘要、枚举值不发送给模型。未发布项目仅维护此当前格式，平台和 Connector 应一同构建。

短租约期间，项目提供的数据源修改、撤权、删除及身份转移操作会提示稍后重试，Connector 异常退出后仍生效，到期自动解除。普通预览不申请租约。此约束依赖两端正常同步的系统时钟及项目支持的本机操作，无法阻止本机管理员直接修改凭据、数据库或系统时钟，也无法撤回已发出的数据。

只读查询 payload 必须包含 `schemaVersion`：人工 SQL 为 `null`，模型生成查询为 64 位小写十六进制摘要。Connector 在同一只读事务持有表元数据锁时重新检查完整表定义，摘要不一致则返回 `schema_changed`，不执行 SQL；模型结构采集和执行均先检查已验证的服务器版本、SQL mode、表名大小写配置及访问权限。摘要绑定本机数据源标识、工作区、连接目标、服务器的 `@@server_uuid` 及配置代次；每次官方配置更新或转移都生成新代次，不将密码用于摘要。数据库克隆若保留相同 server_uuid，仍无法依此区分实例；此变量在隔离的 26.7.0 上验证，MySQL 8.0 尚待独立验证。摘要包含 `SHOW CREATE TABLE` 和建表时间，无法保证识别同一秒内按相同 DDL 原样重建；自增计数改变可能造成保守拒绝。结构变化后需要重新生成计划。

只读查询 payload 还必须包含 `delegatedScope`，由现有 payload 摘要和平台签名共同保护。普通管理员查询为 `null`；经审批的外部委托查询为明确的表名到字段名数组映射，空或无效委托拒绝。Connector 验签并加载当前本机策略后，对委托范围与对应工作区本机表、字段权限取交集，再用于 SQL 解析和锁定元数据下的最终校验；不得修改本机保存的策略。此项只提供签名任务的范围收紧，不能代替平台的 MCP 身份认证、真实管理员审批、撤销或结果披露校验；当前 MCP 入口尚未开放。
- 查询取消：`connector-read-v1`, `cancel-read`, `taskId`, `connectorId`, `actorId`, `workspaceId`, `sourceId`, `issuedAt`, `expiresAt`, `nonce`, `1`，由平台签名，仅作用于匹配的查询或模型结构任务。
- 查询结果：`connector-read-v1`, `read-result`, `taskId`, `connectorId`, `actorId`, `workspaceId`, `sourceId`, `taskNonce`, `outcome`, `sha256(payload)`（小写十六进制）, `timestamp`, `nonce`, `1`，由 Connector 签名。`taskNonce` 为原任务 nonce，空闲连接器对取消任务的确认使用该取消任务 nonce；平台按当前任务状态核对，防止重启后复用任务 ID 时接受旧结果。成功 payload 是受限查询结果或授权结构 JSON 的无填充 base64url；失败仅包含固定错误码。确认依次为 `connector-read-v1`, `read-result-ack`, `connectorId`, `taskId`, `nonce`, `1`。

平台的成功确认也必须验签：配对确认依次包含 `connector-v2`, `pair-ack`, `pairingId`, `connectorId`, `publicKey`, `proof`, `2`；心跳确认包含 `connector-v1`, `heartbeat-ack`, `connectorId`, `nonce`, `1`；探测确认包含 `connector-v1`, `probe-ack`, `connectorId`, `nonce`, `1`；轮换确认包含 `connector-v1`, `rotate-ack`, `connectorId`, `newPublicKey`, `nonce`, `1`；诊断结果确认包含 `connector-v1`, `result-ack`, `connectorId`, `taskId`, `nonce`, `1`；扫描结果确认包含 `connector-v2`, `scan-result-ack`, `connectorId`, `taskId`, `nonce`, `2`。

正常在线空闲心跳间隔为 2 秒，活动读任务期间为 1 秒；通信异常后按 15 秒间隔重试，身份被拒绝仍立即退出。更短在线间隔用于减少交互任务等待，正常心跳频率随之增加；不改变任务授权或签名规则。

平台校验 Connector 身份、签名、时间（容差 60 秒）与 nonce，并持久保存近期 nonce；重启后有效窗口内的重放仍被拒绝。任务有效期不超过 60 秒，Connector 检查平台签名、操作类型、目标身份和有效期，并在安全存储中记录已处理任务。扫描结果丢失后不会自动重复扫描，任务到期后可以由用户重新发起；平台提交前再次核对授权与绑定。诊断只验证通信；扫描只读取范围内的数据库结构。只读查询默认关闭，显式启用后也只允许已验证的 SQL 子集，写入和其他语法仍被拒绝。

只读查询任务和结果仅保存在进程内存中，平台处理前再次检查当前绑定和 Connector 身份。心跳响应丢失时，平台在任务有效期内重复下发同一签名任务；Connector 忽略正在执行或投递结果的相同任务。Connector 在任务期限内对暂时的网络故障或丢失的确认使用新的结果 nonce 重新发送同一结果，不重新执行 SQL；已收到的重复结果不会重新发布。Connector 在执行前持久记录任务：若进程重启后收到已处理任务，返回 `outcome_unknown` 而不再执行。平台重启后内存任务及结果丢失，无法自动恢复或确认其结果。取消会丢弃迟到结果，撤销身份会停止投递。查询内容、参数和结果不写入普通日志或持久注册表；信任的主机、数据库及操作系统仍可能在内存或自身日志中处理这些数据。

Connector 使用本机身份中的独立随机密钥对完整任务 ID 计算 HMAC，选择四个不同的候选凭据分片；依次检查所有候选后，放入有空间的分片。每片最多保存 8 条未过期记录，四片均满时拒绝新任务，不提前删除未过期记录。查询、扫描和诊断共用此防重放机制，密钥轮换保留分片密钥。身份凭据缺失或分片损坏时失败关闭；当前实现已在 Windows 凭据管理器验证，其他系统尚待验证。

已验证身份的扫描结果如果对应任务已取消、失效或不再授权，平台返回 HTTP 409；Connector 丢弃该结果并继续心跳。身份验证被拒绝仍返回 403，不能将单次任务失效当作 Connector 身份撤销。每个 Connector 的结果发布与自身撤销、轮换按顺序执行，不因某个结果等待数据库而阻塞其他 Connector。

轮换时先把待换密钥保存在本机凭据管理器中，再使用旧密钥签名；响应丢失后根据已保存的两个身份恢复。一个身份同一时间只允许运行一个 Connector 操作，轮换前需停止 `run`。撤销后所有新请求被拒绝，重新配对前需先撤销平台身份再清理本地身份。重置先持久标记身份不可用并清除私钥，再清理该身份的防重放分片；中途中断或存储失败后应再次执行重置继续清理，不能以原身份重新运行。

注册表目前是单进程独占的本地状态文件，不改动 MySQL；并非多实例或生产部署方案。重复请求限流不会消耗其他设备的共享额度，但大量各不相同的无效请求仍可能消耗资源，远程部署需要额外防护。异常退出后可能遗留锁，必须确认对应进程已停止后才可手工处理。签名和 TLS 不消除主机失陷风险，心跳身份也不代表数据库访问授权。

## G3 受控变更的独立签名通道

本节对应 [G3 实现记录](../docs/21-第八阶段G3实现与审核记录.md)。普通 Connector `run` 尚未挂接该通道，正常平台不开放写入；只有隔离测试显式装配执行器。此前只读通道继续拒绝写入，不能把写计划放入只读查询 payload。

`POST /api/connector-agent/mutations/{poll,result,claim,permit}` 使用独立严格信封，不接受浏览器 Cookie 作为 Connector 身份。字段为 `id,connectorId,ownerId,workspaceId,sourceId,kind,operation,payload,issuedAt,expiresAt,nonce,replyTo,protocol,signature`；未知字段拒绝。`id` 与范围标识为当前领域编号；仅 `poll/poll_reply` 的 owner/workspace/source/operation 为空。operation 为 `capability/preview/execute/status/cancel/recover`，protocol 固定为 1。

签名使用既有双方 Ed25519 身份，以下 UTF-8 字段以单个换行连接，不附尾换行：

```text
connector-mutation-v1
kind
operation
id
connectorId
ownerId
workspaceId
sourceId
sha256(payload)
issuedAt
expiresAt
nonce
replyTo
1
```

`sha256(payload)` 是信封中无填充 base64url 字符串的 SHA-256 小写十六进制，不能改为解码后的 JSON 摘要。签名为 64 字节、nonce 为 32 字节的规范无填充 base64url。时间为 UTC 整数秒，有效期最多 30 秒，未来签发容差 2 秒，过期拒绝。跨语言固定字节向量为 `go/testdata/mutation-vector.json`。

kind 分为 Connector 的 `poll/result/claim/permit` 与平台的 `poll_reply/task/result_reply/claim_reply/permit_reply`。新 poll/task/claim/permit 的 replyTo 为空；其他回包必须绑定原消息 nonce。结果还保持原 task id、operation 及完整范围，晚到结果只核对或丢弃，不产生新的写任务。平台持久保存近期 nonce 哈希以拒绝重放，不保存敏感 payload。领取资格和许可在当前工作区/Connector 身份锁内重核签名，并持锁至数据库授权事务完成，防止预认证与身份轮换之间的竞态。

payload 为严格 UTF-8 JSON 的规范无填充 base64url，解码上限 1 MiB + 64 KiB，额外空间只用于范围/摘要等信封元数据，完整预览原值仍限 1 MiB。poll_reply 内含已签名 task，存在第二层编码；平台入队前检查完整嵌套回包容量，不能先接受无法派发的大任务。任务箱总量 32、每个 Connector 8，30 秒后清理；取消优先，其余未派发任务公平排队，状态轮询不能无限推迟已确认执行。关闭后不能重新入队。

poll 的 payload 为 `{active:[taskId...]}`（最多 8 项），回包为当前内存 `apiBoot` 及 task 或 null。preview 仅携带结构化带类型计划及当前启动世代；模型 SQL 不能成为计划。execute/status/cancel 绑定原 executionId、previewId、commitment、revision、四项范围、双端内存启动世代、规范目标身份/门世代、本机策略和安装代次。所有返回必须匹配完整绑定，不能仅比执行编号。

claim 原子消费原执行资格；permit 在业务事务已准备后使用固定挑战请求首次许可。许可包含原完整绑定、挑战、permitId 和固定 3000ms 预算，外层信封验签覆盖整个对象，内层平台签名作为持久记录保存；重复领取不续期。Connector 从首次请求前计时，等待、持久化和最终采样均消耗同一个预算。该预算不是网络到达的硬实时承诺。

execute 失败若有确定的原执行事实仍返回原编号及真实终态/未知；无事实的拒绝不包装成成功预览。受限结果包区分 registered/running/commit_intent/committed/rolled_back/rejected/outcome_unknown。未知不能被换编号重提，恢复只查原记录和同事务目标回执；按当前范围最多每页 100 项，不返回原值。原许可、计时、分页回执和本机持久防重的完整约束见第 17、20、21 号文档，不能用通道重派替代这些业务不变量。


