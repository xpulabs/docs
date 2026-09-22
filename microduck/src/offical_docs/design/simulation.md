# 仿真：复用同一套守护进程，机器人本体由MuJoCo承载
**状态：已实现并投入使用**。`robotd --sim`、`tofd --sim` 和 `mediad --sim-camera` 均已就绪；`microduck_rl` 中的 duck-body 模块负责仿真本体另一半逻辑；容器（§8）、虚拟通信层（§5）以及每只小鸭独立相机均由 `scripts/duck-sim` 启动。实测结果：守护进程稳定维持50Hz控制周期，无丢帧；基于MuJoCo仿真本体，可通过仿真器输出的关节角度识别坐姿启动；`robotctl robot init` 会执行坐站策略，直到小鸭直立并保持姿态；容器内四只小鸭可通过虚拟通信层完成完整合唱。使用文档见 `docs/robot/simulation.md`；本文档为设计说明。

设计目标：仿真小鸭的开发方式与真机完全一致——**相同二进制程序、相同物理单位、相同robotctl、相同duckctl open命令**，只是机器人本体运行在MuJoCo中而非桌面。它不是简易mock，也不是简单测试脚手架；而是**数字孪生体**，有明确界定的边界。

## 1. 使用体验
一条命令即可拉起一只仿真小鸭。拉起之后，它就像一台真机，你可以沿用熟悉的所有命令。

当前可用功能（`scripts/duck-sim`，单只小鸭，无容器）：
```bash
scripts/duck-sim               # 弹出窗口，小鸭起立，可供操控
scripts/duck-sim drive         # 向前行走，随后停止
scripts/duck-sim ctl health    # 或执行robotctl支持的任意指令
scripts/duck-sim log
scripts/duck-sim down
```
脚本会自动构建缺失组件、写入参数文件、在强化学习仓库虚拟环境中定位ONNX Runtime，同时启动两端服务并让小鸭起立。设计该脚本的目的，就是省去三段难以手动配置的操作：真机上策略文件存放于 `/opt/robot/daemon/current`，笔记本端则在本代码仓库内；ONNX Runtime会动态加载笔记本默认没有的`libonnxruntime`；Unix域套接字路径长度上限约108字节，因此状态目录路径必须简短。

容器功能上线后的用法：
```bash
duck-sim up 4                  # 拉起4只小鸭，共用同一个MuJoCo窗口
duck-sim shell duck-a          # 进入duck-a的容器环境
```
容器内部和真机无差别：
```bash
duck-a # robotctl health
duck-a # robotctl configure
duck-a # robotctl chorale
duck-a # journalctl -u robotd -f
```
在本机shell中操作，和操控桌面真机完全一样：
```bash
duckctl open duck-a
scripts/dev-push.sh microduck@duck-a
```

脚手架遵循四条核心准则：开发工具如果需要厚厚的操作手册，就没人会用。
1. **无需记忆前置配置**：从未运行过该工具的机器执行`duck-sim up`，会一次性构建根文件系统、拉取缺失依赖并给出提示。凡是无法自动完成的操作，都会直接输出可粘贴的完整命令行，风格和仓库其余脚本保持一致。
2. **默认值覆盖常用场景**：不指定数量默认1只小鸭；不指定场景默认公寓场景；不加`--cameras`则不启用相机——大部分调试场景不需要相机，相机渲染开销最高。
3. **随时可停止**：每只小鸭以systemd单元运行，`duck-sim down`等价于`systemctl stop`，不依赖快捷键。这条规则源于一次踩坑：法语键盘上`Ctrl-]`等价于`AltGr + )`，曾导致必须新开终端强制杀死容器。
4. **按名称寻址**：`duck-a`、`duck-b`，每只拥有独立`machine-id`。因此`robotctl quack`播放的声音各不相同：小鸭的声纹由序列号生成，四只合唱不会是同一个声音的四份拷贝。

## 2. 分层接口边界
`duck_control::io::RobotIo`，一共6个方法，**仿真器仅允许在此处接入**：
```rust
fn read(&mut self) -> Result<Sensors>;          // 关节与IMU，单次事务读取
fn write(&mut self, targets: &JointTargets) -> Result<()>;
fn set_gain(&mut self, kp: u16) -> Result<()>;
fn set_torque(&mut self, on: bool) -> Result<()>;
fn slow_sensors(&mut self) -> Result<SlowSensors>;   // 电压、各关节温度
```
该接口**上层代码完全不变**：50Hz控制循环、ONNX策略、安全保护、跌倒检测、里程计、运动学、地图定位、全部IPC调用、robotctl与duckctl。
接口下层只有一个实现：`DynamixelIo`；IMU并不独立，因为本机器人的IMU属于Dynamixel总线上的节点，和15个舵机在同一次`sync_read`同步读取。

`FakeIo`已经完整实现该trait，这也是`cargo test`无需硬件的原因。`RemoteIo`是第三个实现。

如果传感器的守护进程本身就是驱动，则不替换。`tofd --fake`已经在控制循环层生成仿真帧；`tof/src/sensor.rs`明确写明：板外传感器“不是仿真传感器，永远不能改成仿真实现”。仿真深度数据送入现有循环。该逻辑同样适用于所有驱动与硬件强绑定的模块。

## 3. 本体通信协议
TCP，换行分隔JSON，每次调用一请求一应答。实现位于`duck_control::sim`，设计考量简述：
- 使用TCP：Unix套接字路径长度上限SUN_LEN（约108字节）；同时仿真器需要从守护进程所在环境外部访问（Linux容器、macOS主机上运行MuJoCo的Linux虚拟机）。
- 使用JSON：单个周期报文约1KB，带宽50KB/s；可直接用nc读取报文，另一端用20行Python即可编写。本项目曾因跨仓库、跨语言共用打包结构体浪费大量开发时间，因此不再采用。
- 开启TCP_NODELAY：不是微小性能优化。Nagle算法会将小包延迟最多约40ms，等于两倍控制周期，会造成仿真器卡顿假象。

请求格式：`{"op":"hello"|"read"|"write"|"gain"|"torque"|"slow", …}`。握手阶段携带协议版本（当前为1），双向校验。因为两端代码分属两个仓库，否则“仿真器版本旧”和“守护进程版本旧”会呈现完全相同故障现象，无法区分。

仿真器输出单位与真机保持一致：弧度、弧度/秒、毫安；IMU数据已经转换到躯干坐标系。MuJoCo维护模型的坐标系、缩放、关节顺序；如果在守护进程侧再加一层转换，会多出一处容易产生漂移的地方。

仿真器崩溃表现为单次周期失败。MuJoCo会预编译模型，修改小鸭数量需要重启仿真器；小鸭程序必须能承受该重启。连接断开时，向调用方返回错误，**下一次调用自动重连**，不单独开启退避线程；控制循环本身作为重试定时器。

## 4. 虚拟无线通信零开销
设备在线状态本身就是`robotd`套接字上的IPC契约：`chorale.subscribe`订阅、`chorale.beacon`广播内容、`chorale.heard`接收广播（携带消息时效，而非时间戳）。`btd`是`robotd`客户端，不是服务端。因此虚拟通信层不需要伪装任何设备，也不占用套接字路径。单进程为每只小鸭维护一条连接，收集各小鸭待广播信息，根据机器人之间距离计算RSSI并转发给其他小鸭。

**无需修改robotd，无需新增协议**，相比真实无线，开发上有三点优势：
1. 基于消息时效的同步链路得到真实验证；
2. 真值计算的RSSI，让距离阈值、非对称链路变成可调参数，而不是现场环境问题；
3. 消息来源ID仅用于去重，因此可以定时轮换ID，把曾耗费一天定位的地址轮换bug，转为回归测试用例。

## 5. 虚拟无线必须引入丢包与延迟，否则bug会被掩盖
完美无损耗的虚拟通信会掩盖真实无线带来的问题，这一点经过实测验证。最初数字孪生中四只小鸭每次都能同步合唱：无论同时启动还是错开启动，所有小鸭互相瞬间无丢包可见。真实场景触发bug的关键特性，正是仿真器最初缺失的。

`duck-ether --discovery <s> --loss <f> --seed <n>` 用来模拟不稳定无线：两只小鸭之间的发现延迟按配对独立计时，广播报文按比例丢包。**按配对独立**，因为非对称链路才会导致集群分裂；全局统一延迟无法复现该现象。设置随机种子，是因为不稳定链路只有可复现，才适合调试。

复现案例：四只小鸭，a、b先合唱，12秒后c、d加入：
```bash
duck-ether --discovery 90 --loss 0.3 --seed 3
```
主分支合唱模块输出：

| duck | part | bar | roster |
| ---- | ---- | --- | ------ |
| a    | 未合唱 | — | 范围内1台 |
| b    | 低音 | 4 | 3个发声 |
| c    | 中音 | 4 | 2个发声 |
| d    | 低音 | 2 | 2个发声 |

和现场故障报告一致：“有时完全无反应，有时出现两首不同歌曲”，存在成员列表不一致、声部重复。

该场景**尚不能证明修复方案有效**。合并合唱选举分支后，同样场景依然会集群分裂（小节5、12、8，三条独立时间线）。但当`--discovery 20 --loss 0.4`时集群可以收敛。90秒发现延迟比该分支设计目标更严苛，该实验不能证明真机上修复失效。值得做的实验是参数扫描：找到每个版本下集群开始无法收敛的发现延迟阈值；现在只需循环遍历参数，不再需要4台真机和实体房间。

## 6. 宿主机架构决定编译架构
项目所有产出物均为aarch64。曾设想在x86笔记本上用qemu-user直接运行板卡原生二进制：完全相同程序，来源可信。进行两次实测，结果矛盾。

仅守护进程本身运行正常：CI编译的原生aarch64产物，在x86笔记本上仿真运行：
- `robotctl health`：50.0Hz，3804周期，0丢帧
- 宿主机CPU：单核占用4.7%，加载9个ONNX会话，策略正常驱动
- 策略推理耗时：0.029ms，周期20ms（原生实测）

吞吐量从来不是风险；真机周期里最慢的Dynamixel同步读取，在仿真环境变为本地套接字调用。

**但在systemd环境下无法正常工作**。systemd-nspawn启动aarch64 systemd 257，启动耗时8.7秒，之后所有服务无法启动：
```
robotd.service:            (code=exited, status=226/NAMESPACE)
systemd-journald.service:  (code=exited, status=243/CREDENTIALS)
systemd-logind, systemd-tmpfiles, console-getty: 同样报错
```
qemu-user 8.2无法翻译systemd 257使用的新型挂载API（fsopen, move_mount, open_tree），这些API用于单元级命名空间与凭证隔离。容器启动的核心价值就是单元级安全加固；失去该特性，容器就失去意义。新版Qemu或许能修复；Debian13、Ubuntu25.04的静态包只是过渡包，真正二进制为动态链接，因此需要源码编译，无法直接apt安装。

因此数字孪生**采用宿主机原生架构**：
- x86宿主机：amd64容器 + 原生编译。完整systemd单元、安全加固、系统日志；唯一区别不是CI的原始二进制。
- arm64宿主机（Apple Silicon）：arm64容器，**原生运行机器人签名固件**，无仿真，命令完全一致。

对升级链路的影响较小，明确说明：`robotctl update apply`完整跑通全流程——预检、签名校验、产物哈希、兼容性检查、健康阈值、自动回滚，`dev-push.sh`就是以此方式部署。x86孪生环境无法安装正式发布包；`board-test.sh`已经在CI中用原生架构真机产物完成验证。

## 7. 数字孪生的覆盖范围（哪些等价、哪些不覆盖）
✅ **完全等价（复用同一段代码路径）**：控制循环、策略、安全保护、跌倒检测、运动学、里程计、地图定位、全部IPC接口与客户端、合唱选举与节拍、systemd单元（真实User、用户组、RuntimeDirectory、安全加固）、升级服务。

✅ **仿真建模（代码路径不变，输入合成）**：执行器响应（基于真实XL330舵机拟合的BAM模型）、IMU、ToF深度、RSSI、相机图像；x86宿主机上的版本溯源。

❌ **完全不覆盖，不会被仿真验证**：Dynamixel总线驱动、BLE蓝牙、相机ISP、rkaiq 3A自动曝光对焦、NPU、硬件编码器及其RGA通路、热管理、电池。

验证方法：把过往真实硬件bug放到孪生环境测试。例如：图像翻转bug破坏编码器到RGA零拷贝通路，帧率下降22fps；3A引擎丢失流启动事件；自动曝光收敛一次后卡死；INT8头部模型分数通道坍缩为两个值；舵机总线丢读。**孪生环境无法捕获这类问题**。这不是设计缺陷，而是边界限制；硬件才是驱动代码的唯一真实验证环境。

## 8. 仿真小鸭本身就是小鸭，身份标记仅声明一次
MuJoCo中的仿真小鸭会向中继服务注册，在Hugging Face机器人列表中和真机并列。价值在于：整套远程访问链路无需硬件即可验证。同时必须明确区分仿真/真机，否则客户端会操控仿真器，却疑惑桌上真机没有动作。

**身份标记仅声明一次**：`configd --simulated <serial>`是唯一声明位置。`system.info`携带该标记，`mediad`在启动时查询该信息，在注册元数据写入`simulated: true`。`robotctl system info`可以打印。不通过其他方式推断；**严禁客户端依靠sim-开头序列号判断**，这种约定需要多处同步，极易出错。

`mediad --sim-camera`也会设置该标记，不作为第二真值来源，而是兜底防护：所有守护进程瞬间并发启动，`configd`查询超时应答延迟时，防止仿真小鸭被误注册为真机。二者不能冲突：图像流来自仿真器，则对应机器人一定是仿真。

身份标记需要绑定序列号的原因：仿真小鸭没有SoC序列号，也没有独立`/etc/machine-id`；同一场景四只小鸭共用笔记本的machine-id，会互相覆盖列表；macOS本身不存在该文件，完全无法注册。`sim-duck-a`对单只小鸭稳定，重启不变，满足硬件ID的要求（remote-access-design.md §3.7）。机器人名称由该ID生成，和真机逻辑完全一致，仿真小鸭名称形如`duck-eb55`，而不是宿主机主机名。

账号登录流程和真机完全一致，不是预先下发凭证。`updaterd`在仿真环境运行，`--token`指向状态目录；`robotctl account login`使用RFC 8628设备授权流程对接Hugging Face：在手机或浏览器输入验证码，和真机完全相同。`mediad`轮询该文件，凭证就绪后自动注册，会话中途登录无需重启小鸭。凭证链路不作仿真，这正是设计目的——远程访问这部分逻辑最容易出现细微bug，最难在板卡上测试。

中继服务侧的限制：对等设备按token索引，**同一账号同一时间只能列出一台小鸭**。每只小鸭独立执行设备授权流程，该限制属于账号机制，不是仿真器限制。

## 9. GStreamer不属于Linux专属模块
`mediad`的流水线最初整体加`#[cfg(target_os = "linux")]`编译条件：只有板载相机作为源时成立；增加`Source::Sim`仿真源后不再成立。`pipeline.rs`中约230行是真正硬件相关代码：v4l2src、驱动缓冲区池、GstVideoMeta内存分配查询、从媒体拓扑读取传感器模式。其余部分（appsrc、tee、appsink、webrtcsink、编码器信号）属于GStreamer，只要GStreamer可运行即可。

因此编译条件改为：`any(target_os = "linux", feature = "gstreamer")`：机器人系统默认启用；其他平台手动开启。开发者电脑安装两个Homebrew包，就可以使用完整守护进程、控制台、WebRTC对接仿真相机；非Linux环境下使用`Source::Camera`会直接报错，而不是缺失功能。

还有一个容易踩坑的陷阱：Homebrew的gstreamer将`libgstnice.dylib`打包到独立`libnice-gstreamer`包，但该包不是gstreamer依赖。缺少该包时链接悬空，webrtcbin没有ICE代理；流水线、相机、中继注册全部正常，直到第一个消费者请求Pad，会话在GStreamer线程崩溃，提示`libnice elements are not available`。编译检查无法捕获，因此`scripts/duck-sim`校验GStreamer元素，而不是pkg-config。`exposure.rs`保持Linux独占，不是打包限制：它通过ioctl调用V4L2控制；仿真图像源背后没有真实传感器测光。

macOS上默认关闭GStreamer：Homebrew的gstreamer会连带拉取gtk4、ffmpeg；开发`robotd`不需要它执行`cargo check`。代价：CI没有编译该组合（CI全为Ubuntu），只能依靠开发者本地测试。增加macos-latest任务执行`cargo check -p mediad --features gstreamer`可以解决，但刻意不加入：CI本身已经很慢，macOS runner速度更差。

## 10. 仿真脚手架
单个MuJoCo进程，单个窗口，场景内N个小鸭本体，所有小鸭共享物理引擎，可以互相碰撞。`microduck_rl`维护这部分：场景文件、BAM执行器模型、mjlab；向守护进程提供本体状态，和它现有的sim2real逻辑互为镜像。

每只小鸭使用`systemd-nspawn`容器：无专用镜像格式，容器本质是目录。基于Debian13 Trixie根文件系统构建（mmdebstrap，非特权，238MB，三分钟内构建完成），每只小鸭独立overlay层。以systemd服务启动（`systemd-run --unit=duck-a …`），`duck-sim down`等价`systemctl stop`；不能正常关闭的仿真小鸭没有使用价值。

接入方式：`machinectl shell duck-a`进入容器；`duckctl open duck-a`查看画面；`scripts/dev-push.sh microduck@duck-a`部署编译产物。

两个限制来自物理引擎，不是管道逻辑：
1. 小鸭**不支持热插拔**：MuJoCo预编译模型，修改小鸭数量需要重启仿真器；这也是RemoteIo设计为重连的原因。
2. 相机渲染是性能瓶颈，不是双足动力学：N个30fps离屏渲染开销远大于N个15自由度机器人本体；相机需要每只小鸭手动开启。45Hz健康阈值设置硬性边界：小鸭过多不会缓慢降频，而是标记不健康，升级服务自动回滚版本。

## 11. 三种错误模型的踩坑记录
三种情况都会表现为“小鸭翻倒仰卧”，每种都耗费一小时定位。
1. `scene_walk.xml`缺少碰撞检测。该场景是强化学习训练所用模型，执行器默认类`contype="0" conaffinity="0"`。小鸭会穿透场景内的地面，躯干Z坐标一秒内从0.120降到-0.105；守护进程正确识别机器人倒地。`scene.xml`引入`robot_allcollisions.xml`，是数字孪生应当使用的场景。
2. `qpos0`不是可用位姿。所有关节置零对应的形态，机器人永远不会处于该状态。守护进程读取到距离原点0.41rad，会尝试把已经折叠的机器人起立。场景定义INIT、STAND、SIT、FOLD几组关键帧；STAND匹配`duck_control::DEFAULT_POSITION`——右腿是镜像，并非对称，不能凭直觉假设。
3. 启动时需要开启扭矩。`robotd`启动默认不开启扭矩：更新重启守护进程时，必须保证原本直立的机器人保持站立，舵机已经自锁。仿真器如果初始无扭矩，第一次读取前小鸭就会瘫倒在地。

守护进程设计的标准启动流程：`--keyframe SIT`：识别折叠坐姿，调用坐站策略将小鸭扶起。

## 12. 可复用的已有资源
`~/MISC/microduck_maploc`（其余部分已过时）包含两份可复用内容：
- 仿真VL53L5CX ToF传感器，位于`sim/tof_sensor.py`：8×8分区，45°方形视场角，4米量程，噪声随距离增大，15Hz；
- `sim/assets/apartment.xml`室内场景，包含83个几何体。相比单纯地面平面，完整房间场景对地图定位、漫游、各类隐藏问题的测试价值高得多。

> 术语说明
> MuJoCo：机器人动力学仿真引擎
> sim2real：仿真到真机迁移
> BAM：执行器动力学模型
> ToF：飞行时间深度传感器
> RSSI：接收信号强度
> systemd-nspawn：轻量容器工具
> IPC：进程间通信
> ONNX Runtime：深度学习推理运行时
> V4L2：Linux视频子系统
> RGA：硬件图像加速单元
> 15-DoF：15自由度
