# G2 计时根因修订与证据

2026-11-01；仅研究模块，不是正式 WriteRunner。

## 根因和新的可验证契约

原候选把“Go 进程单调时间”“Windows 包含休眠的启动时间”和“数据库开始收到 COMMIT 的物理时刻”混在了一起。Go 序列化时间没有原进程单调部分；Windows 的 unbiased 时钟不计算休眠；普通进程也不能保证读取时间后立即得到 CPU 或发出网络包。增加任意毫秒裕量不能证明硬实时发送期限。

本修订明确：**固定预算限制的是持有策略/取消锁时，Connector 向 Commit 适配器移交这一执行尝试的资格。** 首次请求前读取计数，等待许可、断线重取、日志落盘和调度等待都消耗原预算。持久化 `commit_intent` 完成后再读取最终计数；预算剩余必须严格大于 100ms 保留量，并满足更短的事务期限。100ms 是保守的产品保留量，不是操作系统最大调度延迟或硬件精度的证明。

**最终计数采样是锁内资格移交的线性化点**，不是稍后的 Go 字段赋值、函数调用或网络发送指令。移交最多一次。采样后任何进程暂停、网络/应答丢失或计时耗尽均不能伪称已回滚，也不能重新调用 Commit。接口回执按真实数据库事实判断；不能确定就未知并冻结。这里没有承诺 COMMIT 网络包发出、MySQL 接收或完成发生于 3 秒之内。如果产品要求的是这种硬实时语义，必须另行设计数据库端的受控执行边界；当前普通 Connector 方案不提供它。

## 平台能力与现成库

本轮明确选择 Windows 10+ / amd64 的 `QueryInterruptTimePrecise`。计数单位为 100ns，与墙钟无关。微软文档区分包含休眠的 interrupt time 和只计算工作态的 unbiased time；精确版读取硬件计时器，适用 Windows 10 / Server 2016 及以后。[精确 API](https://learn.microsoft.com/en-us/windows/win32/api/realtimeapiset/nf-realtimeapiset-queryinterrupttimeprecise)、[时钟语义](https://learn.microsoft.com/en-us/windows/win32/sysinfo/interrupt-time)。

通过官方列出的 `api-ms-win-core-realtime-l1-1-1.dll` 模块加载；复用已有 `golang.org/x/sys/windows` 的 `NewLazySystemDLL`，仅走系统 DLL 搜索，不枚举猜测 KernelBase，不退回墙钟、Go 单调钟、粗粒度时钟或 UTC 重建期限。[官方 API-set 清单](https://github.com/MicrosoftDocs/winrt-related/blob/docs/winrt-related-src/win32-and-com/win32-apis.md)。此依赖已在研究 go.mod 中，不新增生产依赖。

每个时钟生命周期具有加密随机进程世代。读数为零/失败、计数倒退、世代改变、期限溢出及持久化错误均锁定当次尝试为不可用，后续正常读数不会使其复活。不把持久化 UTC 时间还原为期限。新进程不继承许可，仍需恢复协议核对旧执行；没有给原执行换挑战延长资格的接口。

## 本轮执行

`go test -mod=readonly -v -count=1 -run '^(TestTiming|TestProtocolWindows)' .` 在 Windows/amd64、Go 1.26.0 上通过，共 9 个顶层测试。

- 安全系统加载的真实 API 读数在普通进程等待期间推进（一次样本约 40.21ms），并完成单次资格移交；新时钟生命周期的进程世代不同。
- 向量包含保留量前一 tick、保留量边界、3 秒边界、7 秒响应延迟、模拟 30 分钟含休眠计数跳变、事务更短期限、墙钟前后跳、读失败、倒退、重启、日志失败和整数溢出。
- 32 个并发移交调用只有一个进入 Commit 回调；在回调内注入暂停/丢应答，之后仍不会产生第二次调用。它验证研究适配器边界，不是 MySQL COMMIT 的端到端网络故障实验。
- 原 Kernel32 直接导出路径在当前系统仍不可用。历史失败日志保留；该路径已退役，诊断测试明确报告其不可用，并要求新选定 API-set 适配器可用。没有把该历史候选改称成功。GetTickCount64 和 API-set 对照探针仍保留各自的观察边界。

没有调整系统时间、电源配置或让用户电脑休眠。真实 S3/S4/Modern Standby/虚拟化平台电源转换尚未实测。新契约的安全推导依赖官方受支持 Windows 计数语义，注入测试证明遇到包含休眠的读数后拒绝过期尝试；不是对所有硬件/虚拟机电源实现的独立证明。正式支持范围及 G4 系统测试应继续列出这些电源场景，异常平台不开启写入。其他操作系统没有本轮适配器或支持结论。
