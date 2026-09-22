# 文档
README 是入口文档——介绍 Microduck 是什么，以及该去哪里查阅更多内容。如果你手边有一台设备并想要操控它，请从速查表开始。

faq.md 是另一个入口文档：面向基于 Microduck 做二次开发（而非修改设备底层）的开发者，收录各类任务相关问题，例如：在开发板上运行超出硬件负载的模型、在自研程序中接入摄像头、Space 无法连接等问题。

它同时也是发布方的起始参考文档：`policy-manifest.md` 是 Microduck 的 ONNX 模型配套 `manifest.json` 的规范契约，定义了全部字段。设计文档会说明背后的原理，并引用该文件。

## robot/ — 你拥有一台机器人
- cheatsheet.md 所有 robotctl 命令
- pair-a-gamepad.md 游戏手柄配对：每个手柄只需执行一次，包含配对模式、配对操作，以及配对失败时的处理方案
- cheatsheet-dev.md 开发板专用命令：分支构建、候选版本、开发推送
- dev-push.md 在本地电脑构建程序，通过 SSH 安装到开发板，无需执行 CI 流水线
- simulation.md 仿真 Microduck：`scripts/duck-sim`，在 MuJoCo 物理实体上运行真实守护进程，可在容器内运行单台或多台机器人
- duckctl.md 全部 duckctl 命令——通过笔记本蓝牙操控机器人
- install-dev.md 从零开始，将开发板配置为开发环境
- install-by-hand.md 拆分为独立命令的同一份安装流程，用于分步调试

## design/ — 修改守护进程
介绍工作原理与设计思路。这类文档改动较少；若程序实际行为与设计文档冲突，**以文档为准，视为程序缺陷**。

**一份文档负责一个机制，其他文档仅做引用**下表就是职责划分：如果某项内容归属这里列出的某篇文档，其他文档只写一句话并指向该文档，不再重复解释。
同一条信息如果在多处文档重复编写，会出现多处不一致，每一处单独看又都合乎逻辑。就曾出现过这样的情况：六个文档都写着 updaterd 和 btd 会保留旧二进制文件直到下次重启，但两个版本迭代后代码早已不再这样工作，而用户排查该问题时查看的两份文档还保留着旧描述。
因此，当两份文档内容冲突时，**不属于该机制的那一份文档存在错误**。

- architecture.md 服务拆分、IPC通信契约、状态归属、安全与权限
- robotd-design.md 控制循环：Dynamixel总线、端口归属、模型、传感、观测、策略、安全机制，以及和时钟节拍绑定的其他模块
- updater-design.md 更新引擎：校验、原子替换、健康检查、回滚、发布包格式
- policy-channel-design.md ONNX策略模型来源：策略组件、加载第三方策略、重置操作的恢复内容
- restart-order.md 所有状态变更场景（含开机）中，各个组件在哪一步重启
- app-path-design.md btd 和 configd：手机如何通过低功耗蓝牙（BLE）配置机器人
- mobile-app.md 手机应用：项目构成，以及机器人端需要提供给APP的能力；代码存放于 microduck-app 仓库
- remote-webrtc.md WebRTC会话、信令、控制通道：远端节点如何操控与查看机器人
- webrtc-console.md WebRTC客户端：由机器人提供页面服务、设备发现、页面功能定义
- remote-access-design.md 局域网外访问Microduck：Hugging Face账号、设备授权流程、中继服务桥接
- boot-recovery-net.md 开机后新版本无法启动守护进程时，回退到黄金固件版本
- simulation.md 数字孪生：守护进程与物理实体之间的接口、实体通信协议、虚拟无线电、容器，以及孪生仿真的覆盖范围与局限

## project/ — 项目运行记录
属于带时间戳的记录，不是参考手册。描述某一时刻的状态，内容会随时间自然失效。

- roadmap.md 里程碑，当前可用功能与规划功能
- ci-setup.md 发布流水线一次性配置：密钥、保密信息、密钥轮换
- install-path-gap.md 4个安装路径相关bug为何会下发到开发板，以及修复方案；从中总结的规则写在 - updater-design.md §9.1
- slice-2-bringup.md Radxa Zero 3W 硬件在 slice 2 阶段的实测情况
- update-over-ble.md 手机侧触发更新流程：发现的问题，以及通过无线进行回滚的最终方案
- media-bringup.md Radxa Zero 3W 的视频处理：VPU硬件、MPP依赖项，以及必须编译的两个插件
- pad-minimal-pairing.md 游戏手柄成功配对所需的最小开发板配置，通过逐项删减硬件/服务测试得出
- idle-cpu.md 无任务时守护进程的运行状态：4项已关停模块、2项经测试保留、仍需占用开发板资源的模块
- tof-on-demand.md tofd空闲时5%CPU占用中，9成来自头部IMU、1成来自深度传感器，且IMU无消费方。解释为何保留激光与传感器单元，而给IMU增加开关

## ideas/ — 尚未落地的设计构想
待构思内容，后续需要撰写正式设计文档。先记录下来，避免想法丢失，同时区分“构想”和“最终决策”。

- autonomous_behavior.md 行为栈：运行时核心需要舍弃的能力，以及chorale、theremin相关工作遗留的构想

## 其他文档
- ../CONTRIBUTING.md 编译、测试、仓库结构、代码规范、版本发布
- project/npu-bringup.md RK3566 NPU上的Microduck目标检测器：运行内容、基准测试方法，以及尚缺失的帧传输链路
- ../deploy/README.md 机器人镜像的配置项，以及设备初始化（provisioning）的实际工作内容

> 术语注释（便于你阅读源码）
> daemon：守护进程
> atomic swap：原子替换
> IPC：进程间通信
> BLE：蓝牙低功耗
> WebRTC：网页实时通信
> MuJoCo：物理仿真引擎
> ONNX：神经网络模型格式
> NPU：神经网络处理器
> VPU：视频处理单元
> Tof：飞行时间深度传感器
> IMU：惯性测量单元
> CI：持续集成
> SSH：远程安全登录协议
