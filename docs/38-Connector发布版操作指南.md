# Connector 发布版操作指南

本指南随 Community 包以 `CONNECTOR.md` 分发，命令使用包内 `connector.exe`，无需安装 Go、Rust 或桌面开发工具。当前仅验证 Windows/amd64；平台安装、显式迁移与恢复见同包 `OPERATIONS.md`。普通运行入口只提供已开放的只读能力，受控写入执行仍关闭。

## 准备与配对

1. 先核验完整发布包，在 PowerShell 中进入解压目录，执行 ` .\connector.exe version` 和 `.\connector.exe help`。候选包不是正式发布版，不能把 `dev` 或 HEAD 基准当作完整候选源码版本标识。
2. 由本机管理员准备仅运行账号可访问的数据目录，将其放在发布包目录之外。下面的 `C:\ShurivaData\connector` 只是示例，需预先创建并设置 Windows ACL。每次打开新终端都要设置同一个真实配置路径：

   ```powershell
   $env:CONNECTOR_CONFIG_PATH = 'C:\ShurivaData\connector\identity.json'
   .\connector.exe pair --server http://127.0.0.1:3000 --name 本机连接器
   ```

3. `--server` 填实际平台地址，与平台部署配置一致；当前本机 HTTP 只接受回环地址。在管理员登录后的“连接器”页面生成一次性配对码，按终端提示粘贴，输入不回显；不要把配对码放在命令参数、截图、日志或问题单中。
4. 成功后执行：

   ```powershell
   .\connector.exe status
   .\connector.exe run
   ```

保持 `run` 终端打开，平台应显示在线，可发起不读取数据库的连接诊断。按 Ctrl+C 停止，等待退出后再执行其他修改命令；同一身份不能并发运行多个进程。配对失败或响应丢失时从同一个平台重新取得配对码再配对，程序先核对现有身份，不用删除文件来强行重试。

## 登记本机只读数据源

请 DBA 提供仅允许目标库 `SELECT` 和按需 `SHOW VIEW` 的专用账号，不使用 root。未知权限、全局读权限、角色或写权限会被拒绝；本指南不会创建或修改数据库、账号或授权。

**先开启平台数据源模块，再登记 Connector 数据源。** 包内 `OPERATIONS.md` 的默认配置为 `ENABLE_STAGE3_DATASOURCES=0`，此时没有数据源管理接口，页面也不能加载工作区 ID。部署管理员先确认受保护配置指向已完成 001、002 基础初始化的专用平台库，停止平台进程，然后从发布包目录执行显式第三阶段迁移：

```powershell
node --env-file=C:\ShurivaData\platform.env .\platform\dist\src\migrations.js --stage3
```

路径须替换为实际配置文件；此命令只用于经授权的平台专用库，不用于 Connector 将要读取的业务库或其他原有数据库。迁移成功并核验记录后，在同一受保护配置文件将 `ENABLE_STAGE3_DATASOURCES=1`，其他未启用模块保持原值，再按 `OPERATIONS.md` 重启平台。管理员登录并打开“数据源”页面，确认页面能加载数据源和工作区列表；不以刷新页面代替平台重启。

停止 Connector 的 `run` 后，将以下占位值替换为真实非敏感连接资料；工作区 ID 从上述已启用的平台数据源页面取得：

```powershell
.\connector.exe source add --host 127.0.0.1 --port 3306 --database YOUR_DB --user READ_ONLY_USER --workspaces WORKSPACE_ID --tls local
```

数据库密码由终端交互输入，不回显。检查通过后连接配置保存在当前 Windows 用户的系统凭据库中，终端显示数据源 ID。在平台选择对应 Connector，登记这个数据源 ID、绑定工作区，再发起连接测试与结构扫描。多工作区用逗号分隔，不能把平台绑定当作本机授权。

`--tls local` 仅用于本机回环数据库，连接不加密；远程数据库必须 `--tls required` 并有系统信任的有效证书，不能跳过校验。MySQL 8.0 尚未独立验证，不以安装成功代替数据库支持验收。

如需受限只读查询，停止 `run` 后明确允许真实表与字段：

```powershell
.\connector.exe source read-allow --id SOURCE_ID --workspace WORKSPACE_ID --table TABLE_NAME --columns COLUMN_A,COLUMN_B
.\connector.exe source check --id SOURCE_ID --workspace WORKSPACE_ID
.\connector.exe run
```

登记与结构扫描只要求上述第三阶段模块。执行只读查询还需部署管理员按 `OPERATIONS.md` 核验对应模块结构，将平台 `ENABLE_STAGE4_READS=1` 并重启；数据源开关仍须为 `1`。这与 Connector 的 `source read-allow` 是两项独立准入。查询仍经过 SQL、会话、工作区、数据源、本机表字段和数据库账号的共同校验；模型建议或前端状态不能授权执行。取消不保证数据库线程立即停止；响应丢失时先核对原任务，不自动重复提交。

## 维护、日志与退出

停止 `run` 后可执行：

```powershell
.\connector.exe source list
.\connector.exe source update --id SOURCE_ID --password
.\connector.exe source read-revoke --id SOURCE_ID --workspace WORKSPACE_ID --table TABLE_NAME
.\connector.exe source disallow --id SOURCE_ID --workspace WORKSPACE_ID
.\connector.exe rotate
```

换密使用终端交互输入；轮换后重新运行 `run`。更换数据库目标不能通过复用原数据源 ID 混用历史，迁移与恢复应先按运维方案核验。系统凭据属于当前电脑和用户，复制可执行文件或身份配置不会迁移这些凭据。

诊断默认输出到标准错误。需要文件日志时，在有明确 ACL 的绝对目录中设置：

```powershell
$env:CONNECTOR_LOG_OUTPUT = 'file'
$env:CONNECTOR_LOG_FILE = 'C:\ShurivaData\logs\connector.log'
$env:CONNECTOR_LOG_LEVEL = 'info'
.\connector.exe run
```

日志采用固定结构和脱敏字段；按请求/任务编号关联排查，诊断日志不能作为数据库提交证明。日志器不可用时检查标准错误中的固定告警和运行状态，不删除审计、回执或恢复材料以消除问题。

需要撤销并清理时，先在平台撤销该连接，停止进程，核对本机登记后逐个明确移除凭据，再重置身份：

```powershell
.\connector.exe source remove --id SOURCE_ID --confirm-local-remove
.\connector.exe reset --confirm-local-reset
```

这是删除本机凭据与身份的操作，执行前应确认不再需要；不会删除业务数据库。清理中断时重跑同一重置完成清理，不恢复运行失效身份。普通 `run` 未装配受控写入处理器，包内的离线 `write` 辅助命令不构成开放写入授权，不要修改门禁用于原数据库。
