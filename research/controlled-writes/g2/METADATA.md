# G2：固定元数据核验例程

2026-11-01。仅限独立研究模块；没有向原数据库或现有演示数据库安装对象、授予权限或连接。下述候选在本轮新建的 MySQL 26.7.0 / `127.0.0.1:13308` 隔离实例验证，不代表 MySQL 8.0 支持，也不是已接入产品的写入授权器。

## 根因与方案

表级写账号无法看见完整触发器和跨库反向外键。上一轮的 SQL SECURITY DEFINER view 在本实例仍按受限调用方过滤目录，已知依赖为 1/1 而返回 0/0。新增 `TestMySQLLockedDefinerViewsCannotProveCompleteness` 保留该反例；上一轮失败证据不覆盖、不删除。

改用 **可信 DBA 安装、固定目标、无参数、SQL SECURITY DEFINER 存储过程**。同一例程只返回该目标的元数据，没有动态 SQL、目标参数、业务行 SELECT、DML、DDL 或异常吞噬。锁定且不可登录的专用 definer 仅持全局 REFERENCES/TRIGGER 及该例程 EXECUTE；这不是“只读权限账号”，而是被固定受信代码封装的高权限身份。平台及 Connector 运行账号只额外获得这一例程的 EXECUTE，不得到 definer 凭据、全局目录修改权限、任意例程执行权限或 SHOW_ROUTINE。

MySQL 的 [存储对象权限](https://dev.mysql.com/doc/refman/8.0/en/stored-objects-security.html) 和 [例程属性可见性](https://dev.mysql.com/doc/refman/8.0/en/stored-routines-privileges.html) 支持此分离。本实验已直接证实 procedure 与先前 view 的行为不同，不能只凭文档或对象名称推断安全性。

例程依次返回：

1. definer 自身 `SHOW GRANTS FOR CURRENT_USER()`；
2. 实例 UUID、精确版本、definer、固定 schema/table，以及 mandatory_roles、activate_all_roles_on_login、CURRENT_ROLE；
3. 目标全部触发器；
4. 所有 schema 指向目标的反向外键字段、顺序和动作；
5. owner 可读的 `SHOW CREATE PROCEDURE`，包含完整定义、SQL mode、字符集和排序规则；
6. 第二份自身 SHOW GRANTS；
7. 第二份 mandatory_roles、activate_all_roles_on_login、CURRENT_ROLE 环境。

接收方必须完整读到终点，逐结果集核对列名和数量（包括 0 行），拒绝截断、未知及额外空结果集；两份授权必须相同，且严格等于无过滤的全局 REFERENCES/TRIGGER 与固定例程 EXECUTE。任何 REVOKE 行、角色、额外权限或未知格式均拒绝。前后环境都必须为 mandatory_roles 空、activate_all_roles_on_login OFF、CURRENT_ROLE NONE。身份、目标、精确版本和完整例程定义/创建环境必须匹配可信安装清单。SHOW GRANTS 在 definer 上下文返回 definer 的授权，但 FOR CURRENT_USER 形式不显示 mandatory roles，见 [官方说明](https://dev.mysql.com/doc/refman/8.0/en/show-grants.html)；[部分撤销](https://dev.mysql.com/doc/refman/8.0/en/partial-revokes.html) 不允许当作完整权限。

真实角色实验发现：全局配置启用一个含 ALTER 的 mandatory role 后，旧 helper 上下文的 CURRENT_ROLE 仍为 NONE、SHOW GRANTS 仍恰好两条，但新登录的仅显式授予 EXECUTE 的账号已经能 ALTER 目标。故不能只靠当前角色名或两条授权证明最小权限；全局角色环境必须独立拒绝。设置仅发生在新隔离实例，实验结束已恢复默认并删除该随机角色。

**0 个依赖仅在完整权限和固定例程承诺均成立后才是可用证据**。有触发器、级联/未知依赖或无法证明时继续拒绝。实验目标已有隐藏触发器和跨库外键时，例程真实返回 1/1；调用者直接查询目录仍无此权限。

## 与目标定义和事务的结合

例程只解决被权限隐藏的依赖，不独自授予“表可写”结论。writer 在同一专用连接与事务先取得真实目标的行锁/MDL，然后读取完整 SHOW CREATE TABLE、完整有序 COLUMNS 与所需当前定义；接着 CALL 固定 helper。目标和 helper 的锁保持至事务结束。不得用几分钟前快照或另一个未持锁连接的结果代替。

真实隔离实验已证明：

- table 级 SELECT 的 writer 在上述锁内能读取完整主键、唯一键、CHECK、字面默认值、生成列、自动更新时间及精确类型定义。实验对五个字段和连续 ordinal 有完整断言；自动行为被发现即拒绝，不能只看“无触发器”。
- 同事务 CALL 不隐式提交已执行的候选 DML，显式 rollback 后原数据完整保留。
- 持有上述事务时，ALTER 目标、新增 trigger、新增跨库反向外键、ALTER helper 安全属性、DROP helper 均返回锁超时 1205；rollback 后相同 DDL 成功。[MDL 语义](https://dev.mysql.com/doc/refman/8.0/en/metadata-locking.html)。

完整生产准入仍需用现有 MySQL AST 及类型规则解释全部定义，覆盖表种类、InnoDB、主键、全部字段、默认值、出向/反向依赖、约束及未知语法；本实验只证明所需完整证据可取得及相关锁原语，并未实现该授权器。

## 授权与安装的可信边界

单独移除 TRIGGER 或 REFERENCES 后，目录真实变为 0/1 或 1/0，但严格授权 envelope 拒绝。给隐藏子库做 partial revoke 后出现第三条 REVOKE，目录也不完整；仍拒绝。受控 barrier 在同一次 CALL 首份授权返回后实际撤销 TRIGGER，末份授权可见变化并拒绝。MySQL 不保证所有权限变化与事务同步生效，见 [生效规则](https://dev.mysql.com/doc/refman/8.0/en/privilege-changes.html)；目标 MDL 不锁 GRANT。

**前后两次读取不能证明恶意或任意权限 ABA。** DBA、安装工具、MySQL 服务器及其权限缓存是此机制的可信计算边界。DBA 安装、改动/恢复 definer 权限、角色、partial revoke 或 helper 定义前必须先关闭并排空该物理实例的受控写入，撤销在途预览/许可，再安装并读回白名单定义和实际授权，递增安装/策略世代并重新验证；不允许在开放期间带外改授权后恢复原样而继续使用旧证明。不遵守这一维护契约的环境不具备写入准入资格。

安装清单应在 Connector 本地受保护存储，以既有签名/身份设施绑定物理实例、固定目标、安装世代、精确版本、定义和创建环境摘要。安装器必须从已审核的固定模板生成代码，先校验可信模板和实际安装定义一致，再签发清单；不能把管理员任意提交的自定义存储过程读回后直接变成可信代码。实验以自行生成的固定模板安装、再由可信安装者直接读回的不可变 Go 值表示此清单，未实现正式签名安装器或正式密钥存储。不得从例程自己的第一次返回值自动注册信任。

CALL 内 SHOW CREATE 可发现同名例程错装/意外更改（真实加入 `DO 0` 已被旧清单拒绝），并与持有的例程 MDL 结合检测固定代码。但它不能抵抗恶意 DBA 安装伪造输出的任意程序；定义检查发生在 CALL 内，也不能撤销任意错装程序已经做出的副作用。因此安装工具必须先审核与核对可信固定代码再开写，不能把“CALL 后核对定义”作为执行任意不受信存储过程的防护。READS SQL DATA 也不是单独的安全边界。

## 验证范围

`metadata_helper_test.go` 七个顶层实验（另含 5 个 MDL 子场景和 5 个错装/协议子场景）均已实际通过。`mysql_test.go` 另保留旧 view 候选的严格反例。未给正式产品新增依赖、迁移或授权，未开启真实写入口。原数据库仍未连接、未修改。

本候选的可行性结论有明确条件：受信安装与维护契约、受限运行账号、固定例程、精确版本、完整结果协议及同一事务锁均必须成立。缺少任一项时不开放写入。恶意 root、任意服务器插件/代理篡改、未验证版本、正式端到端授权器及完整 W01–W64 不在本实验的通过声明内。
