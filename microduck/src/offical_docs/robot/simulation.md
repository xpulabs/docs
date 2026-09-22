# 仿真小鸭（Simulated duck）
在MuJoCo中运行的小鸭模型，由真实后台守护进程驱动。你可以像调试实体机器人一样对它进行开发：使用完全相同的`robotd`、策略模型、50Hz控制循环、`robotctl`工具与控制台界面，**只有物理本体是虚拟的**。

本文档介绍使用方法。`design/simulation.md`会说明仿真模型的边界、它与实体机器人的异同，以及该仿真系统的设计思路。

## 仿真系统是什么
执行`robotd --sim host:port`启动守护进程，使用`duck_control::sim::RemoteIo`替代伺服总线：每一个控制周期，关节位置、速度、IMU数据通过TCP套接字从MuJoCo仿真进程传入；策略输出的目标控制指令则反向发回仿真器。
在这个接口之上的全部代码——控制循环、策略、安全逻辑、跌倒检测、运动学、里程计，整套IPC通信接口，**和实体机器人运行的代码完全一致，无法区分是真机还是仿真**。
`tofd --sim`从同一仿真器获取8×8深度相机帧；`mediad --sim-camera`读取渲染出来的头部相机图像，相机安装角度和实体机器人一样，偏转90°。
`configd`与`updaterd`也原样运行，这使得仿真小鸭拥有序列号、设备名称，还可以绑定Hugging Face账号，不在同一局域网的设备也能访问它。

MuJoCo仿真部分在`microduck_rl`仓库内，程序名为`duck-body`：单个进程、一个可视化窗口，同一个场景中可以加载N个小鸭模型，使用策略训练时对应的BAM执行器模型。

✅ 适用场景：所有守护进程及其客户端相关功能，包括IPC通信、`robotctl`、控制台、更新服务、设备广播（chorale）、站立/行走策略、建图。
❌ 无法验证：底层驱动相关问题。Dynamixel伺服总线、BLE蓝牙、相机ISP、NPU、硬件编码器**没有建模**；这类硬件相关bug只能在实体机器人上复现。

## 环境依赖
1. 本代码仓库，在本机编译（`cargo build`自动执行）。
2. 拉取`microduck_rl`并配置虚拟环境，可以放在本仓库同级目录，或`DUCK_SIM_RL`环境变量指定的路径。该仓库提供`duck-body`、仿真场景，以及笔记本电脑缺少的`libonnxruntime`。相机相关功能在其`develop`分支。
3. 非Linux系统，需要启用相机功能：执行`brew install gstreamer libnice-gstreamer`
    - gstreamer：集成`webrtcsink`、srtp与x264编码。
    - libnice-gstreamer：`webrtcbin`所需的ICE代理。gstreamer本身不依赖它；缺少该库时小鸭可正常启动，但视频流无法对外传输，浏览器请求视频时才会报错。`scripts/duck-sim`脚本会自动检测这两个依赖。
4. 仅容器模式需要：sudo、`systemd-nspawn`（包名`systemd-container`）和`mmdebstrap`。脚本会提示缺失的组件，并给出对应的安装命令。

## up 模式 还是 boot 模式？
两种模式都使用同一个`robotd`驱动MuJoCo模型，区别在于守护进程的运行环境。

| | scripts/duck-sim（up模式） | scripts/duck-sim boot N（boot容器模式） |
|---|---|---|
| 守护进程运行方式 | 普通进程，以当前用户身份运行，每个进程生成pid文件 | 每个小鸭独立`systemd-nspawn`容器，由真实systemd单元文件启动systemd服务 |
| 依赖 | 仅需要本仓库与microduck_rl | sudo权限；一次性构建Debian根文件系统 |
| 启动耗时 | 数秒 | 首次启动约1分钟，后续仅需数秒 |
| 设备身份 | 复用笔记本身份；多个小鸭属于同一个进程树 | 每个小鸭独立machine-id、语音、套接字；容器间通过`duck-ether`通信 |
| 可验证内容 | 控制循环、策略、IPC、robotctl、控制台 | 包含up模式全部能力，额外验证：`User=`/用户组/`RuntimeDirectory=`/安全加固、更新器应用、健康检查门限、回滚与服务启动顺序、journalctl日志 |

经验法则：
开发控制循环、策略、IPC通信或客户端工具，使用`up`。
需要测试systemd配置、更新器、设备部署，或者多只小鸭互相通信时，使用`boot`。
该仿真器曾经捕获两类bug：守护进程配置的运行用户不存在，导致systemd单元无法启动。这类问题`up`模式完全无法暴露。

## 单只小鸭（无容器）
```bash
scripts/duck-sim                # 弹出MuJoCo窗口，小鸭起立，可进行操控
scripts/duck-sim status         # 查看健康状态，是否处于站立
scripts/duck-sim drive          # 向前行走8秒（参数vx vyaw，默认0.15 0）
scripts/duck-sim ctl health     # 调用robotctl操作该仿真小鸭
scripts/duck-sim monitor        # robotctl monitor：关节、IMU、ToF深度、手柄
scripts/duck-sim log            # robotd日志
scripts/duck-sim simlog         # MuJoCo仿真端日志
scripts/duck-sim realtime       # 查看仿真世界运行倍速（下文说明）
scripts/duck-sim down
```
不带参数执行脚本：会基于当前分支编译守护进程，生成参数文件，加载仓库内策略，在`~/.cache/duck-sim`下启动`duck-body`、`tofd --sim`、`robotd --sim`，并启用站立策略。
`ctl`本质是指向该小鸭套接字的`robotctl`，这是和实体机器人唯一差别：实体板卡套接字在`/run`目录，仿真环境套接字放在状态目录。

自研工具连接仿真小鸭的套接字路径：
`~/.cache/duck-sim/duck-a.sock`（robotd；`duck.sock`是软链接，指向ctl当前操作的小鸭）
`~/.cache/duck-sim/duck-a-tof.sock`
模型本体TCP端口：7801

## 多只小鸭，每只作为独立可登录设备
```bash
scripts/duck-sim boot 4         # 同一仿真世界内4只小鸭，各自独立容器（需要sudo）
scripts/duck-sim shell          # 进入 duck-a 容器
scripts/duck-sim shell duck-c   # 进入其他小鸭容器
# 在容器内执行
robotctl health
journalctl -u robotd -f
scripts/duck-sim down
```
`boot`模式在`systemd-nspawn`容器中，使用真实systemd运行每个小鸭的守护进程；基于Debian13根文件系统启动（一次性构建，约3分钟，保存在状态目录，每只小鸭使用独立overlay文件系统）。
可以模拟普通模式无法复现的场景：真实单元文件的`User=`、用户组、`RuntimeDirectory=`与安全加固，在真实init系统下运行。`robotctl update apply`、健康门限、服务回滚与启动顺序表现和实体机器人完全一致。
小鸭命名为`duck-a`、`duck-b`……每只拥有独立machine-id与语音标识。

多小鸭场景下脚本额外启动`duck-ether`：虚拟无线模块，在容器之间传递chorale广播BLE信标。该虚拟无线**故意模拟较差信道**：信标丢包、延迟。完美无损耗的虚拟链路会掩盖真实硬件上会出现的bug。

首次执行`boot`会构建根文件系统，可能提示安装`mmdebstrap`。每只小鸭对应一个systemd单元，`down`本质是`systemctl stop`，不能用快捷键终止。

## 仿真场景与相机
```bash
DUCK_SIM_SCENE=apartment DUCK_SIM_CAMERAS=a scripts/duck-sim boot 2
```
默认场景为空旷地板。`apartment`是7×6米，包含6个房间，门口故意偏心设计，从小鸭45°前向相机视角可以识别自身位姿。带斜杠的路径代表自定义场景；`microduck_rl`中`scene_*.xml`是内置场景文件。

相机需要手动开启（可选：`a`、`a,c`、`all`）。渲染一帧图像耗时12ms，而4只小鸭的物理步进仅需0.3ms：1个相机占用约1/3核心，4个相机几乎占满一个CPU核心。
开启相机的小鸭会启动独立`mediad`，控制台网页按索引监听`http://127.0.0.1:8080`、`8081`……，页面内容和实体机器人完全相同。

## 公网远程访问仿真小鸭
仿真小鸭可以登录Hugging Face账号，在账号机器人列表中展示，和实体机器人行为一致。控制台、App或Hugging Face Space可以通过WebRTC跨网络访问。
```bash
DUCK_SIM_CAMERAS=a scripts/duck-sim
scripts/duck-sim ctl account login
```
打开 `hf.co/oauth/device`，输入终端打印的验证码，几秒后小鸭就会出现在设备列表。
```bash
scripts/duck-sim ctl account status # 查看绑定账号
scripts/duck-sim ctl system info    # 打印序列号与MuJoCo模型信息
```
列表中会标记`simulated`仿真标识，名称基于序列号生成（如`duck-eb55`），区分实体机器人。其余能力完全一致：同样控制链路、H.264编码、策略。

基于token的对等发现机制，两条规则：
1. 一个账号同一时间只能在线一只小鸭。同一账号再次登录会顶替前一个，不会报错，二者轮流在线；多只仿真小鸭需要多个Hugging Face账号。
2. 访问该小鸭的Space应用需要**自身token**，不是小鸭的token；公开发布的Space使用访客登录凭证。
```bash
scripts/duck-sim ctl account logout # 从列表下线
```

## 环境变量（全部可选）
| 环境变量 | 默认值 | 说明 |
|---|---|---|
| DUCK_SIM_RL | ~/Pollen/microduck_rl | duck-body、场景文件、ONNX运行库所在目录 |
| DUCK_SIM_STATE | ~/.cache/duck-sim | 套接字、日志、参数、根文件系统、小鸭overlay存储目录。路径刻意缩短，Unix套接字路径上限约108字节 |
| DUCK_SIM_DUCKS | 1 | 小鸭数量；boot N也会覆盖此值 |
| DUCK_SIM_SCENE | bare floor | 场景名（apartment）或者场景文件路径 |
| DUCK_SIM_CAMERAS | none | 开启相机的小鸭：a、a,c、all |
| DUCK_SIM_DUCK | duck-a | ctl/monitor默认操作的小鸭 |
| DUCK_SIM_KEYFRAME | SIT | 小鸭初始姿态：SIT蹲坐地面（站立策略从此姿态起立）、HOME、STAND站立、FOLD收拢 |
| DUCK_SIM_VIEWER | 1 | 0 = MuJoCo无头后台运行，不弹出可视化窗口 |
| DUCK_SIM_PORT | 7801 | 第一只小鸭模型端口；每增加一只+1 |
| DUCK_SIM_FRAME_PORT | 7901 | 第一路相机画面端口；每增加一路相机+1 |

## 重要注意事项
1. **实时倍速很关键**。守护进程循环基于墙上时钟。仿真运行速度低于1.0倍实时，不只是观看卡顿：策略预期机器人的运动幅度和实际仿真不一致，平衡控制失效。
`scripts/duck-sim realtime`输出倍速，boot模式启动时也会打印。小鸭数量过多、相机过多不会单纯变慢，会在45Hz健康门限判定为不健康；容器模式下更新器会触发版本回滚。
优化方案优先级：减少小鸭数量 → 减少相机 → 无头模式运行。

2. 小鸭**不支持热添加**。MuJoCo会预编译模型，修改小鸭数量必须重启仿真器。守护进程可以自动恢复：`RemoteIo`在下一个周期重连；模型短暂消失时，小鸭上报不健康，进程不会崩溃，和实体机器人伺服总线断电现象一致。

3. `--sim` ≠ `--fake`
`robotd --fake`是极简虚拟机器人：无物理仿真，位置直接回传，不会倾倒。仅用于单元测试、不需要物理本体的笔记本端开发。
`--sim`是带物理仿真的孪生模型，两个参数互斥，不可同时使用。

4. 仿真小鸭不能认为自己是笔记本主机。小鸭语音与chorale广播标识由硬件序列号生成；同一台机器多只小鸭会共用序列号。脚本会为每只小鸭设置独立`DUCK_IDENTITY`来区分；实体机器人不会设置这个变量。

## 不使用脚本，手动分步启动
两端都支持指定`host:port`独立运行，排错时很有用：
```bash
# 仿真本体，在RL仓库虚拟环境中执行
duck-body --ducks 1 --port 7801 --keyframe SIT

# 守护进程，在本仓库执行
target/debug/tofd --sim 127.0.0.1:7801 --socket /tmp/d/duck-a-tof.sock
DUCK_RUNTIME_DIR=/tmp/d ORT_DYLIB_PATH=<libonnxruntime.so> \
    target/debug/robotd --sim 127.0.0.1:7801 --params <params.toml> --socket /tmp/d/duck-a.sock

# 设备身份与账号配置
target/debug/configd --socket /tmp/d/duck-a-config.sock --state-dir /tmp/d/duck-a \
    --simulated sim-duck-a --fake-net --fake-pads
target/debug/updaterd --config /tmp/d/updater.toml --socket /tmp/d/duck-a-updater.sock \
    --token /tmp/d/duck-a/hf-token

# 相机（前提：duck-body启动时开启--cameras a）
printf '[media]\nquality = "360p30"\n' > /tmp/d/mediad.toml
target/debug/mediad --sim-camera 127.0.0.1:7901 --config /tmp/d/mediad.toml \
    --robot-socket /tmp/d/duck-a.sock --tof-socket /tmp/d/duck-a-tof.sock \
    --config-socket /tmp/d/duck-a-config.sock --updater-socket /tmp/d/duck-a-updater.sock \
    --token /tmp/d/duck-a/hf-token
```
非Linux系统编译`mediad`需要开启gstreamer特性：
`cargo build -p mediad --features gstreamer`
不开启该特性，程序启动后打印提示并退出。

`--token`在两个守护进程指向**同一个文件**：`updaterd`写入凭证，`mediad`读取。二者指向不同文件会导致小鸭登录成功，但无法完成注册。

相机两端分辨率必须匹配：`mediad`按`[media]`配置输出画质（360p30为640×360），仿真本体渲染分辨率必须一致。图像帧为原始裸流，没有握手协商；分辨率不匹配时`mediad`直接丢弃帧，不会显示错误画面。
`scripts/duck-sim`包含其余全部参数配置；手动修改前建议阅读脚本源码。
