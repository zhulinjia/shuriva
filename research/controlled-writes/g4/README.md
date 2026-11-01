# G4 本机隔离验证

首轮 W01–W64 证据见 [第 23 号记录](../../../docs/23-第八阶段G4本机隔离验证记录.md)，补齐测试与当前验收结论见 [第 25 号记录](../../../docs/25-第八阶段G4补齐与验收记录.md)。测试使用正式领域用例、适配器与当前协议，隔离组合才允许 DML；产品启动门禁不变。

## 复现约束

在仓库根目录运行 `scripts/start-stage8-isolated-mysql.ps1`，仅新建一个随机目录的 13308 实例；端口被占用就停止，不能关闭已有服务来腾端口。随后将新生成 manifest 的绝对路径显式设为 `STAGE8_G3_MANIFEST`。此变量复用当前隔离 fixture 的名字，不使用默认数据库 URL，也不读取 `.env`。

测试前设置当前子进程环境：

```powershell
$env:GOARCH='amd64'
$env:STAGE8_G3_TEST='1'
# 必须填本轮新建且仍在运行的独立实例 manifest，不能指向历史目录或原数据库：
$env:STAGE8_G3_MANIFEST='I:/path/to/project/.cache/stage8-g2-NEW_RANDOM_RUN_ID/manifest.json'
$env:STAGE3_MYSQL_TEST='0'
$env:STAGE3_KEYRING_TEST='0'
$env:CONNECTOR_TEST_KEYRING='0'
$env:STAGE5_LEASE_CRASH_HELPER='0'
Remove-Item Env:TEST_DATABASE_URL -ErrorAction SilentlyContinue
```

`connector/go` 中运行 `go test -count=1 -p=1 -json ./...`。`TestG4CrashHelper` 只由持有子进程句柄的父测试启动；不要直接设置其内部标志执行。父进程在受控屏障强制终止自身子进程，不操作 MySQL 或其他现有进程。测试用数据库账号、journal key 和执行输入仅经匿名管道传递，不放到进程参数。

如明确要验证本机 Windows 凭据库，将 `STAGE8_G4_KEYRING_TEST=1` 仅设置到测试进程。该测试只创建并清理随机 UUID 对应的专有 key/index 条目，不做全局容量耗尽或任何现有凭据清理；未设置会明确跳过。

API 故障与备份验收还需要显式设置 `STAGE8_G4_ACCEPTANCE=1`。先在 `connector/go` 构建实际测试进程：`go build -o (Join-Path (Split-Path $env:STAGE8_G3_MANIFEST) 'mutation-probe.exe') ./testdata/mutation-probe`。构建目标必须是本轮拥有目录，不能覆盖用户其他可执行文件。

在 `apps/community-api` 先构建，再运行 `node --test --test-isolation=process --test-concurrency=1 dist/test/*.test.js`。逐文件进程隔离与项目正常测试脚本一致，避免 SDK、计时替身等跨文件干扰。前端回归在 `apps/community-web` 使用 `node --test --test-concurrency=1 test/*.test.mjs`。跨语言测试会创建自身 Go/API 子进程并使用同一显式 manifest。临时 API 固定使用空闲的 `43129`；冲突就失败，不能停止其他服务腾出端口。

手工浏览器验收只运行 `dist/test/g4-runtime/browser-lab.js`，前端使用 `vite.g4-acceptance.config.ts`。它使用正式产品入口、真实登录、单独的 `127.0.0.2:5193`，不会转发原产品主机的 Cookie；不要与同端口进程测试同时运行。测试控制只走父子进程私有管道，没有公开故障控制 HTTP 接口。输入 `{"action":"stop"}` 关闭并清理自身环境；使用交互终端保持输入管道打开。

结束后使用研究模块既有 `fixturectl inspect` 核验所有本轮前缀的 schema/账号为零，再用 `fixturectl shutdown` 关闭这个新实例；核对拥有进程退出和 PID 文件移除。所有连接均有身份 guard，不使用默认端口回退。保留凭据受保护的证据目录，不复制 manifest 内容到聊天或日志。

## 证明边界

TCP relay 只位于 `*_test.go`，固定转发至通过 guard 的 13308；不能用于产品代理、TLS 解析或任意目的地址。ENOSPC 是 Journal 端口故障注入，不填满宿主磁盘。Windows 计数和许可边界注入不等于实际休眠，进程强制退出不等于物理断电。用户已明确排除真实断电、实机休眠/恢复与物理磁盘故障验证：不再为这些项目等待专用环境，不将它们记为通过或作为当前 G4 阻断条件。其余安全与恢复测试继续保留，详细范围以第 23 号记录为准。
