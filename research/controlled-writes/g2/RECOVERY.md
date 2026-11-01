# G2 恢复：目标事务回执、双端启动世代与排空屏障

2026-11-01。实验代码：[recovery_test.go](recovery_test.go)。本轮在新建 `127.0.0.1:13308` / MySQL 26.7.0 实例验证；未连接原 3306 或已有演示 13307。这里是独立研究实验，没有生产写入端点、认证授权服务或 Connector WriteRunner。

## 根因与设计取舍

bbolt 的合法旧备份会同时回退墓碑和序号。平台检查点也从旧备份恢复时，两份数据“相等”不能证明历史完整；增加签名或哈希仍无法凭空发现两份合法旧快照。平台、日志和用户数据库事务也不属于同一个原子提交。

因此不用检查点一致性恢复旧执行资格，采用以下职责：

1. **启动世代只约束当前执行资格。** API 和 Connector 每次启动生成新的随机内存世代；旧任务绑定的两个世代不能从日志、任务或 UTC 时间重建为当前世代。旧任务只能核对，永不重新派发 DML。本实验子进程先在内存生成新 boot，父进程模拟平台据此登记 grant，再完成本机同步日志和双存储消费；子进程不从备份配置恢复 current boot。
2. **登记与消费交叉核对。** 真实平台 SQL 锁住登记行，比较 ID、承诺、scope、incarnation、双端 boot 和 target epoch；bbolt 同步 CAS 比较全部不可变字段并消费 attempt；随后平台提交 `attempt_started`。两次持久化不假装原子：中间失败、应答不确定或证据不一致均损失这一次执行机会，不能把消费改回未执行。
3. **确定提交依赖目标事务回执。** 受信 DBA 一次安装专用控制 schema；业务表不加列或触发器。固定 `put_receipt` 在业务 DML 的同一个 InnoDB 事务中插入唯一 execution ID、32 字节不透明 HMAC 承诺、固定认证 scope、目标 incarnation 和 target epoch。先写回执再写业务；重复 execution ID 在业务语句之前拒绝。事务回滚时两者一起消失，提交时一起可见。回执只有元数据，没有参数、SQL 或原始行。
4. **缺失回执只表示未知。** 查不到回执、目标不可达、提交结果丢失或已有证据冲突，都不证明回滚，也不授予重跑资格。可证明的提交结果与“该来源是否可再写”分开处理；发现一条已提交回执不会自动解除来源冻结。
5. **丢失编号可以从目标对账。** 固定 `list_receipts` 只枚举安装时绑定的 scope/incarnation，用 execution ID 游标，每页最多 100 条。恢复不依赖浏览器或旧本机日志保留 ID；重新发现的元数据只用于核对历史，不补发确认或许可。
6. **恢复先排空旧目标事务。** 每个已唯一认定的物理 catalog 使用一个 canonical gate；业务事务在插入回执前，以 `FOR SHARE` 取得 gate 并核对 target epoch，锁持有到目标事务结束。独立恢复身份只可执行固定 `rotate_gate`，通过 `FOR UPDATE` 排空持有旧门的事务，再原子轮换 epoch。轮换后迟到的旧 epoch 在业务 DML 前拒绝；已提交旧回执仍保留。普通 writer 没有旋转权限。

生产恢复顺序固定为：冻结所有等价来源 → 成功排空并轮换目标 gate → 完整分页核对旧回执与双端元数据 → 对未解决项保持冻结 → 仅在满足恢复准入后允许当前权限下的新预览。完整枚举必须在排空之后，否则旧事务可能在枚举结束后才提交。本轮分别验证了各原语，没有把它们描述为已经接入生产的恢复服务。

MySQL 的 [锁定读取](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html) 提供该共享/独占事务锁原语；固定存储过程不能包含事务控制或隐式提交语句，本实验同时检查回滚行为。[隐式提交规则](https://dev.mysql.com/doc/refman/26.7/en/implicit-commit.html)是安装及代码审核的一部分。锁定 Definer 的最小权限与普通 Invoker 的 EXECUTE 权限按 [存储对象安全模型](https://dev.mysql.com/doc/refman/8.0/en/stored-objects-security.html)拆分。复用现有 MySQL 与 bbolt，不新增恢复框架或分布式事务依赖。

## 实际权限

- 普通实验 writer：业务表 SELECT/UPDATE；仅 `put_receipt`、`get_receipt`、`list_receipts` 的 EXECUTE。无控制表直接 SELECT/INSERT/UPDATE/DELETE、DDL、替换 helper 或旋转 gate 权限。
- 锁定、不可登录的实验 Definer：receipt 表 INSERT/SELECT，gate 表 SELECT/UPDATE，以及固定 helper 必需的 EXECUTE；无业务行读写权限、无动态 SQL。
- 独立实验 recovery 身份：仅 `rotate_gate` 的 EXECUTE，无 gate 直接读取、业务更新或 DDL 权限。真实产品凭据仍必须仅在 Connector 环境的安全凭据库中保存，不能放平台数据库。
- 平台 SQL 与 bbolt 在实验中由同一测试程序协调；真实产品必须经过各模块公开端口，不授权 mutations 模块直接操作其他模块表。实验 fixture 的管理连接只用于安装、平台 SQL 模拟和断言，不是 Connector 业务连接。

本轮固定 helper 使用安装时写入的 scope/incarnation，不接受调用方选择 schema、scope 或任意 SQL。`rotate_gate` 明确拒绝 NULL、错误 expected、非法 next 及同 epoch；`put_receipt` 明确拒绝 NULL 和非规范元数据，防止 SQL 三值逻辑将 NULL 比较当作有效 CAS。

## 重测证据

命令：`go test -mod=readonly -count=1 -timeout=90s -run '^TestRecovery' -v .`。按模块 README 设置新清单和 amd64 目标。

最终运行 **8 个顶层实验全部通过，8.659 秒**；另含 9 个命名子用例及函数内多项负向断言。日志为本轮私有实验目录中的 `recovery-final.log`，不含口令。

| 实验 | 可观察结果 |
| --- | --- |
| TargetReceiptAtomicityAndLeastPrivilege | CALL 与业务一起回滚；成功只有一次 effect/receipt；重复 ID、换承诺、换 scope、未登记任务、直接控制表访问和 DDL 均拒绝 |
| AbruptChildBeforeCommitAndLostAcknowledgement | 真实 owned helper `os.Exit(31)` 在 Commit 前退出：业务 0、回执缺失，仍报告 unknown/frozen；`os.Exit(32)` 在 Commit 后丢应答：业务 1、平台/日志无终态，目标回执证明 committed；两条均不重跑 |
| RestoredCoordinatorsDoNotReplayAndTargetProvesCommit | 真实 SQL 平台表和 bbolt 一起恢复登记前备份，均丢执行 ID；固定目标枚举找回原 ID，旧任一端 boot 不可执行，原业务 effect 仍为 1 |
| MissingOrTamperedEvidenceNeverGrantsRetry | 当前 boot 的缺本机日志、同记录数 local/platform 不可变字段篡改、目标不可达均拒绝执行或保持未知，业务不变 |
| ConcurrentCrossStoreClaimExecutesOnce | 16 个并发当前进程 claim，仅一个 MySQL+bbolt 消费、一次业务递增及一个回执 |
| PartialCrossStoreClaimNeverReauthorizes | 本机同步消费后注入 SQL 失败，平台事务回滚；修复实验注入后原任务仍被本机消费挡住，业务和回执均为 0 |
| TargetBarrierDrainsOldTransactionsAndFencesAliases | 旧事务持共享门时旋转锁超时 1205；旧事务结束后旋转成功；两个不同受限账号共用同一控制门，旧 epoch 均拒绝，新 epoch 已登记任务才成功；5 个旋转及 3 个回执 NULL/错误参数返回 1644 |
| ReceiptDiscoveryBoundedAndScoped | 101 条已提交回执按 100/1/0 分页，无重复/遗漏，排除其他 scope 的控制记录 |

所有目标业务与控制表均为 InnoDB；每个 fixture 确认 `innodb_flush_log_at_trx_commit=1`，没有改服务器配置。官方说明该设置在提交时写入并刷出日志，但 [实际硬件刷新可靠性](https://dev.mysql.com/doc/refman/8.0/en/innodb-parameters.html#sysvar_innodb_flush_log_at_trx_commit)仍是部署前提。本轮骤退的是实验子进程，未杀数据库、未断电、未制造磁盘满。此前 bbolt 文件锁、同步提交后骤退与损坏实验继续保留；[bbolt 的同步事务与备份能力](https://github.com/etcd-io/bbolt)不等于跨存储原子事务。

## 可信边界与未完成事项

- 本方案信任验证后的 Connector 编排及受信 DBA/helper 安装。固定 receipt CALL 自身不能证明同事务执行了哪一条业务 DML；已攻陷且持有业务 UPDATE 权限的 writer 可伪造元数据标记。生产需审核同连接事务编排、不可变计划承诺与最终授权；不把 receipt 视为抵抗已攻陷 Connector 的独立证明。
- 真实 HTTP/Better Auth、签名任务与回执、系统凭据库存储、持久化进程会话、所有失败状态的 UI、生产 outbox 等尚未实现。此处 HMAC 使用标准库和 fixture 内存随机 key，签名授权/密钥管理仍属 G3/G4。
- 真实 SQL 证明两个已知账号共享同一 gate 时的冻结；不证明自动发现别名。生产要先唯一认定 instance/catalog/incarnation/control manifest，让所有 workspace/source 别名共享 canonical gate；不同 helper、代理、克隆 UUID 或身份有歧义时默认不开写，不能每个 sourceId 自建一把互不相干的门。
- 双协调器旧备份能由未回退的目标回执提供独立事实。若**平台、本机日志与目标控制 schema 同时回退**，或者 DBA 删除/篡改目标回执，软件不能自动证明已被抹掉的历史。数据库灾难恢复、整机/RAM 快照回退、控制 schema 重建必须在离线维护中停止旧执行者、核对备份并重新登记 incarnation；所有旧确认永久只读，不能自动解冻或重放。该边界不借“检查点相等”掩盖。
- 没有可靠目标回执的执行仍为未知；空分页不证明安全，无论双端是否一致都不能解除冻结。人工维护决定新 incarnation 后仍须新的预览、当前权限和人工确认，不能把旧任务换个编号当作自动恢复。
- 本轮只验证 MySQL 26.7.0 的指定原语。MySQL 8.0、断电/磁盘满、数据库进程崩溃、真实多主机协调和正式 W01–W64 全矩阵仍须后续验证，不能据此开放产品真实写入。
