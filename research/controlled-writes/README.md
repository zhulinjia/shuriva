# 受控写入的现成能力评估

2026-11-01；[G2 隔离实验](g2/README.md) 的根因修订已获用户批准。[G3](../../docs/21-第八阶段G3实现与审核记录.md) 正式复用 mysql 驱动、TiDB AST、keyring、AI SDK、Base UI，并将已研究的 bbolt 1.4.3 加入正式 Connector，Windows 计时使用已锁定的 x/sys/windows；不依赖研究模块内部实现。版本来自锁文件，原评估外部依据只用官方文档或维护仓库。[第一轮](../../docs/19-第八阶段隔离验证与准入记录.md) 保留失败，[第二轮](../../docs/20-第八阶段核验计时与恢复修订.md) 最终 45/45 通过；G3 当前环境回归不替代 G4，正式写入仍关闭。

| 能力 | 现成方案与适配结论 | 限制与验证 |
| --- | --- | --- |
| 认证、范围和输入 | 复用 Better Auth、Zod、数据源公开授权端口 | 不自行写密码验证；不能把会话有效等同本机写许可 |
| 模型规划 | 复用现有 AI SDK 的结构化候选与进度 | 不执行模型原始 DML、不让模型确认、不发送预览行 |
| 事务和驱动 | 复用 Go database/sql 和已有 mysql 驱动 1.10.1；驱动仓库声明 MPL-2.0 | 冻结 Tx/取消/行数行为；不创建第二套 ORM。MPL 文件修改和分发义务按发布流程保留审查 |
| SQL 解析 | 复用现有 TiDB parser，新增独立 MutationGuard/生成器 | 解析不代替名称绑定、授权和服务器一致性实验；不放宽只读 guard |
| 确认、表格、图标 | 复用现有 Base UI 1.3.0、Lucide，既有查询结果仍用 TanStack Table | G3 差异每页十个有限目标，采用原生语义 table；无需排序/虚拟化插件，不新造弹窗焦点管理 |
| 签名、加密、内容承诺 | Go 标准库 ed25519、HMAC-SHA256、AES-GCM；现有系统凭据库保存密钥 | 复用基础原语，不自造算法；规范化由 Connector 单方产出，跨语言验证固定字节，避免不必要的 JCS 依赖 |
| 提交许可计时 | Windows 10+/amd64 研究复用已有 x/sys/windows，安全加载官方 QueryInterruptTimePrecise API-set；挑战用 crypto/rand，API 存首次许可 | 含休眠计数、固定首次预算；commit_intent 后最终采样是单次交付资格点，不承诺网络硬实时；失败/倒退/世代改变锁闭，不用 UTC 或 Go 单调钟恢复旧许可。实际电源转换待 G4 |
| 确认与页面恢复 | 复用平台 MySQL 的唯一约束、事务和 CAS，通过当前认证/范围公开端口查询 | 项目用例明确预览唯一消费、关闭墓碑、恢复屏障和未决/终态列表，不引入通用工作流或自动重试执行库 |
| Connector 持久防重 | 正式锁定 go.etcd.io/bbolt v1.4.3，MIT、纯 Go | G3 已实现并测试独立包密钥、加密租约、固定保留与启动清理；文件锁、CAS、损坏和旧快照均有证据。断电、磁盘满、系统凭据实际配额与 G4 完整故障矩阵仍待验证 |
| 完整元数据 | 固定无参数 SQL SECURITY DEFINER procedure，锁定 definer 封装完整目录权限；运行账号仅固定 EXECUTE | 真实隐藏依赖、定义/空结果协议、角色/授权撤销及同事务 MDL 验证；不是只读 definer，须可信模板安装与停写维护，不抵抗恶意 DBA |
| 目标回执与恢复门 | MySQL 同事务 InnoDB 回执、固定范围分页、FOR SHARE/FOR UPDATE 世代门；标准库 HMAC-SHA256 承诺 | G3 已实现安装清单、当前门发现与恢复协调，并测原回执/已知别名共门；缺回执不重试、不自动解冻，不新增分布式事务框架。真正网络故障/断电与备份运维仍待 G4 |
| 现有只读重放 | 不直接复用其到期清理策略保存写入执行身份 | 目前只读重放按有效期淘汰；写入执行墓碑不能因短期缓存到期而重新执行 |
| SQLite/文件自制数据库/Redis | 本轮不引入 | 当前只需本机单写者持久状态 CAS；SQLite 可行但增加第二种 SQL 适配，Redis 增服务，自己写日志更易遗漏崩溃一致性；bbolt不通过实验时再重新评估 |

**库无法代替的规则：** 完整目标集合与执行时完整行值比较、确认内容绑定、INSERT 新行/UPDATE 前后像/DELETE 旧行授权、挑战式提交许可、未知结果和撤销线性化必须由项目实现并测试。指纹不能证明期间没有发生 A→B→A；bbolt 事务与目标 MySQL 事务不能共同提交，不构成跨系统“恰好一次”。旧日志/平台回退通过目标回执与运行世代验证替代原语，不因使用 bbolt 或 UUID 就自动授予写资格；任意代理/克隆别名与全权威回退不具备自动恢复支持结论。

第一轮已确认普通元数据权限/受限 Definer view 会漏依赖，Kernel32 直接导出加载不可用；历史失败保留。第二轮选择固定 procedure 与官方 API-set，补同事务回执/目标恢复门，最终 45/45 通过。它证明当前环境研究方案可行，不是完整产品准入；可信安装与维护、真实系统电源/断电和正式端到端验证仍不可省略。

官方依据：

- [bbolt 项目与持久事务](https://github.com/etcd-io/bbolt)、[v1.4.3 Go 要求](https://github.com/etcd-io/bbolt/blob/v1.4.3/go.mod)、[许可](https://github.com/etcd-io/bbolt/blob/v1.4.3/LICENSE)、[Windows 同步与锁实现](https://github.com/etcd-io/bbolt/blob/main/bolt_windows.go)。这些支持候选评估，不证明本项目故障实验已通过。
- [Go database/sql](https://pkg.go.dev/database/sql)、[mysql 驱动](https://github.com/go-sql-driver/mysql)。驱动说明取消可能关闭连接，clientFoundRows 改变 UPDATE 返回行数含义，因此项目必须定义自身确认/未知规则。
- [Go 单调时间](https://pkg.go.dev/time#hdr-Monotonic_Clocks)：系统时间可能调整，单调读数不跨进程序列化，部分系统休眠会暂停该时钟。据此要求本机截止不重建，并将休眠计时/失效检测列为准入实验；不是宣称标准库已提供完整的分布式许可协议。
- [MySQL 外键动作](https://dev.mysql.com/doc/refman/8.0/en/create-table-foreign-keys.html)、[元数据可见性](https://dev.mysql.com/doc/refman/8.0/en/information-schema-introduction.html)、[元数据锁](https://dev.mysql.com/doc/refman/8.0/en/metadata-locking.html)、[InnoDB 锁范围](https://dev.mysql.com/doc/refman/8.0/en/innodb-locks-set.html)。据此推导本项目的保守准入与实验门槛，不把查询不到的隐藏依赖当成不存在。

MySQL 8.0 手册作为机理参考，不作为本机 26.7.0 实测证据，也不构成 MySQL 8.0 支持声明。具体依赖版本、安全公告和部署条件在真正引入时再次核对。
