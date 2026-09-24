# `robotd` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> 每一个机制的权威描述都在 [`design/robotd-design.md`](design/robotd-design.md)（英文）。本文只做一件事：
> 带你按正确的顺序把 `robotd/` 这份代码读一遍，并且在每个路口告诉你"这个设计为什么是这样"。
> 两者若有不一致，以设计文档为准 —— 那是仓库的规矩（见根目录 `CLAUDE.md`）。
>
> 读完之后想找具体命令，去 [`robot/cheatsheet.md`](robot/cheatsheet.md)；想找"我该怎么调用它"，去 [`faq.md`](faq.md)。

## 目录

1. [一分钟版](#1-一分钟版)
2. [它在整个系统里的位置](#2-它在整个系统里的位置)
3. [硬件长什么样，代码就长什么样](#3-硬件长什么样代码就长什么样)
4. [目录导览：先读哪个文件](#4-目录导览先读哪个文件)
5. [核心：一个 tick 的完整旅程](#5-核心一个-tick-的完整旅程)
6. [三条看不见的规矩](#6-三条看不见的规矩)
7. [三个状态机](#7-三个状态机)
8. [挂在 tick 上的附加功能](#8-挂在-tick-上的附加功能)
9. [对外接口：robot.* API](#9-对外接口robot-api)
10. [配置与部署](#10-配置与部署)
11. [测试](#11-测试)
12. [给新手的阅读路线](#12-给新手的阅读路线)
13. [术语表](#13-术语表)

---

## 1. 一分钟版

`robotd` 是一个**守护进程**（daemon，就是"在后台一直跑着的程序"）。它是整个机器人上**唯一碰电机的程序**，做的事只有一件：

> **每 20 毫秒（每秒 50 次）读一次所有传感器，算一次 15 个关节的目标角度，写回去。**

就这样，循环往复，直到关机。这个循环叫**控制循环**（control loop），每一次循环叫一个 **tick**（滴答）。

其他所有东西 —— 手柄、手机 App、命令行工具、更新器 —— 都只能通过一个 Unix socket（`/run/robotd.sock`）**发意图**（intent，比如"往前走"、"头抬起来"、"站起来"），由 `robotd` 内部的**安全层**决定这个意图能不能执行、要不要打折扣。

> [!IMPORTANT]
> 这是全文最重要的一句话：**除了 `robotd`，谁都不能直接命令电机。** 这不是靠代码规范约束的，是靠 Rust 的**借用检查器**（borrow checker）在编译期强制的 —— 详见 [第 6.1 节](#61-规矩一safety-独占-io)。

---

## 2. 它在整个系统里的位置

机器人上一共有七个 daemon，都通过 Unix socket 说话，协议是 JSON-RPC 2.0（每行一个 JSON 对象）：

```text
  游戏手柄          手机          你，在笔记本上        远端 peer        GitHub 发布
      │ BLE/USB       │ BLE            │ ssh                 │ WebRTC          │ https
      ▼                ▼                ▼                     ▼                 │
  ┌────────┐      ┌────────┐      ┌──────────┐          ┌──────────┐          │
  │  padd  │      │  btd   │      │ robotctl │          │  mediad  │          │
  └───┬────┘      └───┬────┘      └────┬─────┘          └────┬─────┘          │
      │               │                │                     │                │
      └───────────────┴────────────────┴─────────────────────┘                │
                              │ 每个服务一个 socket，JSON-RPC 2.0               │
                              ▼                                               │
  ┌───────────┐        ┌─────────────┐        ┌─────────────┐                 │
  │  robotd   │        │  configd    │        │  updaterd   │◄────────────────┘
  │  robot.*  │        │ net.* pad.* │        │  update.*   │
  │  50 Hz    │        │ system.*    │        │ 校验/换版/  │
  │  循环     │        │ wifi/配对   │        │ 健康门/回滚 │
  │  安全     │        │             │        │             │
  └─────┬─────┘        └──────┬──────┘        └──────┬──────┘
        │ Dynamixel 串口       │ D-Bus                │ systemctl restart
        ▼                     ▼                      │ 然后问 robot.health
  15 个舵机 + IMU                                    ▼
  共用一条 UART                              /opt/robot/daemon/current
```

对新手来说，从这张图里要记住两件事：

**一、`robotd` 是"干活的那个"。** 其他六个要么是**传输层**（`padd` 手柄、`btd` 蓝牙、`mediad` 视频），要么是**恢复路径**（`configd` 配置、`updaterd` 更新）。传输层本身不拥有机器人的任何东西 —— 把 `padd` 整个删掉，机器人还是能走路，只是没手柄了。

**二、`configd` / `updaterd` / `btd` 故意不依赖 `robotd`。** 因为它们就是"`robotd` 起不来时你要用的东西"。一个控制循环崩了的机器人，恰恰是最需要被重新配置、被更新、被回滚的机器人。`robotd` 不能成为它们的前提。

> 设计文档：[`design/architecture.md`](design/architecture.md)

---

## 3. 硬件长什么样，代码就长什么样

理解 `robotd` 的代码之前，先理解这台机器人的一个硬件事实，因为它解释了代码里一大半的"奇怪"设计：

> **15 个舵机和一个 IMU 板子，共用同一条串口总线。**

```text
                     robotd —— 控制线程
                              │
                              │  duck_control::bus::DynamixelIo
                              │  serialport 库 · TIOCEXCL
                              ▼
         /dev/ttyS2 · 1 Mbps · Dynamixel 协议 v2
                              │
    ┌────────────┬────────────┴───────┬──────────────────┐
    │            │                    │                  │
  id 200       20–24                30–34             10–14
 imu_to_dxl   左腿 5 个        脖子·头·嘴 5 个       右腿 5 个
  v2 板子
```

三个直接后果：

**（1）只有一个主人。** 一条总线不能两个人同时说话。所以 `robotd` 启动时要用文件锁（`/run/robotd.sock.lock`）抢占端点，抢不到就直接退出。**两个控制循环同时向同一条总线写指令是物理危险** —— 两个程序都以为自己拥有这台机器人。这就是 `tests/single_instance.rs` 存在的全部理由。

**（2）一次读取要"一网打尽"。** 总线很贵（每次事务要几毫秒），所以每个 tick 用**一次** `sync_read` 把 IMU 和 15 个舵机全读回来，再用**一次** `sync_write` 把 15 个目标角度全写下去。电压和温度寄存器在更远的地方（144–146），所以它们**每秒才读一次**，单独一次事务（约 1 ms）。50 Hz 下每 tick 都读的话会吃掉 5% 的预算。

**（3）IMU 就是总线上的一个设备，没有抽象层。** 它是 `id 200`，跟舵机在同一个寄存器块上应答，所以就跟着舵机一起读。代码里没有 `trait Imu` 这种东西 —— 硬件没有这个边界，代码就不该造一个。

### 关节索引表

这张表要背下来，因为**接口上是按位置（下标）传关节的**：

| 索引 | 关节名 | Dynamixel ID | 位置 |
|---:|---|---:|---|
| 0 | `left_hip_yaw` | 20 | 左腿 |
| 1 | `left_hip_roll` | 21 | 左腿 |
| 2 | `left_hip_pitch` | 22 | 左腿 |
| 3 | `left_knee` | 23 | 左腿 |
| 4 | `left_ankle` | 24 | 左腿 |
| 5 | `neck_pitch` | 30 | 脖子 |
| 6 | `head_pitch` | 31 | 头 |
| 7 | `head_yaw` | 32 | 头 |
| 8 | `head_roll` | 33 | 头 |
| **9** | **`mouth`** | **34** | **嘴** |
| 10 | `right_hip_yaw` | 10 | 右腿 |
| 11 | `right_hip_roll` | 11 | 右腿 |
| 12 | `right_hip_pitch` | 12 | 右腿 |
| 13 | `right_knee` | 13 | 右腿 |
| 14 | `right_ankle` | 14 | 右腿 |

**索引 9（嘴）是特殊的**：所有 alpha 策略都是 **61 个输入 → 14 个输出**，那 14 个输出**恰好跳过嘴**。嘴不属于任何神经网络，它只由"意图"或"特雷门琴/合唱"来动。代码里它叫 `MOUTH_INDEX`（`duck-control/src/model.rs:31`），名字起出来就是为了让这个"跳过"是**故意的**，而不是某个人写错的 off-by-one。

**舵机是位置控制的。** 你给它一个目标角度，它自己转过去。所以"控制机器人" = 每 20 ms 算 15 个目标角度。这就是全部。

> 设计文档：[`design/robotd-design.md`](design/robotd-design.md) §1.1、§2.1、§2.5

---

## 4. 目录导览：先读哪个文件

```text
robotd/
├── Cargo.toml          依赖清单（注释写得很详细，值得一读）
├── src/
│   ├── main.rs         8781 行 —— 进程本身：控制循环 + IPC + 健康
│   ├── control.rs       747 行 —— 策略调度：哪张网络在驱动
│   ├── intents.rs       703 行 —— 客户端的意图，无锁槽
│   ├── sound.rs         947 行 —— 嗓子（播放 + 合成）
│   ├── chorale.rs      1320 行 —— 多只鸭子合唱一首曲子
│   ├── theremin.rs      489 行 —— ToF 深度传感器当特雷门琴
│   ├── soc.rs           341 行 —— 读板子的温度和降频状态
│   └── params.rs          7 行 —— 只是 re-export
├── tests/
│   ├── single_instance.rs  337 行 —— "同一时刻只能有一个 robotd"
│   └── updater_gate.rs     483 行 —— "更新器的健康门对真实进程有效"
└── systemd/
    └── robotd.service       91 行 —— 怎么被 systemd 拉起来
```

**`main.rs` 有 8781 行，别从头读。** 它内部是这样一个顺序（左边是行号）：

| 行号 | 内容 |
|---:|---|
| 1–150 | 模块文档 + 一堆**常量**，每个常量的注释都在讲"为什么是这个数" |
| 158–221 | `LimpFall` 状态机（摔倒时变软） |
| 223–303 | `Args` —— 命令行参数（含 `--fake` / `--sim` / `--no-policy`） |
| 305–523 | `PolicyNames` / `SlotErrors` —— 策略文件的报告 |
| **525–921** | **`RobotState`** —— 循环向外发布的全部状态（原子变量） |
| 924–1046 | `main()` —— 进程入口 |
| 1094–1171 | `spawn_control_thread()` —— 把控制循环扔到独立线程 |
| 1186–1320 | `open_bus_waiting()` / `open_bus()` —— 打开并检查总线 |
| 1359–1448 | `Bringup` 状态机 + `adopt_startup_pose()` |
| 1481–1620 | `PendingSwap` —— 策略换版（后台线程加载） |
| **1761–3295** | **`control_loop()` —— 心脏，一个 tick 的全过程** |
| 3316–3450 | `Coast`（总线掉线时滑行）+ 慢传感器采样 |
| 3453–3560 | `claim_lock` / `claim_socket` —— 单实例锁 + socket 绑定 |
| 3562–3730 | `handle()` —— 一条连接的读循环（请求 + 状态流） |
| 4279–4712 | `dispatch()` —— 每个 `robot.*` 方法干什么 |
| 4746–4902 | `mod mapping` —— 给上位机算骨架位姿 |

---

## 5. 核心：一个 tick 的完整旅程

这是全文最该看懂的一节。下面是 `control_loop()` 里 `while` 循环体（`main.rs:2008`–`3293`）干的事，按代码顺序：

```text
┌─ 每个 tick ─────────────────────────────────────────────────────────────┐
│                                                                         │
│  1. ticker.tick().await        等到下一个 20 ms 时刻（Skip 策略）        │
│                                                                         │
│  2. safety.read()              一次 sync_read：IMU + 15 舵机            │
│        ├─ 成功 → consecutive_errors = 0，记下读取时刻                    │
│        └─ 失败 → errors++，记日志（限流），fresh = None                  │
│                                                                         │
│  3. coast.sample(fresh)        掉线时沿用上一条样本，最多 3 个 tick      │
│                                                                         │
│  4. safety.observe(fresh)      更新"摔倒了没"判定（防抖 0.2 s）          │
│     odometry.update(...)       接触式里程计：机器人在哪、朝哪            │
│                                                                         │
│  5. intents.snapshot()         原子读一次客户端意图（瞬时，不加锁）      │
│     safety.gate(cmd, age)      死区开关：意图太久没来 → 速度归零         │
│                                                                         │
│  6. 处理各种"离散请求"（每个 tick 取一次，取完即清）                     │
│     ├─ robot.init / robot.relax      上电/断电，开始 homing              │
│     ├─ robot.rebootMotors            重启指定舵机                        │
│     ├─ 技能请求（ground_pick / sit / 配置的一次性技能）                  │
│     ├─ 声音请求（wheee / alarm / greet ...）                            │
│     ├─ robot.setMode                 换行走模式（walk ↔ roller）         │
│     ├─ 策略换版请求（robot.loadPolicy）                                  │
│     └─ 关机请求 / 电池空 → 坐下再关机                                   │
│                                                                         │
│  7. limp-fall 检查             预测到要摔 → 变软 → 落地 → 摆回站姿      │
│                                                                         │
│  8. 指令平滑                   cmd += α·(target − cmd)，50 Hz 下 slew    │
│                                                                         │
│  9. bring-up                  还没上电？有人要求驱动 → 上电 + 2 s ramp   │
│                               ramp 完成 → Bringup::Ready                 │
│                                                                         │
│ 10. driving = ?                六个条件全满足才算"策略在驱动"           │
│                                                                         │
│ 11. controller.step()          观测 → 神经网络 → 目标角度 + 增益        │
│                                                                         │
│ 12. 特雷门 / 合唱              谁在唱歌，嘴就归谁                        │
│                                                                         │
│ 13. safety.apply(targets)      ★ 唯一写总线的地方 ★                     │
│                                  拒绝 NaN / 夹到舵机行程内               │
│                                                                         │
│ 14. publish                    原子量总是更新；状态帧只在有人订阅时组装  │
│                                                                         │
│ 15. 统计                        tick 计数、是否超时、每秒算一次实际频率  │
└─────────────────────────────────────────────────────────────────────────┘
```

下面挑几个**新手最容易看错**的点展开。

### 5.1 第 1 步：为什么是 `Skip`

```rust
ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
```

tokio 的定时器有三种"错过时间点之后怎么办"的策略：

- `Burst`：把欠下的 tick 一次性连着补上 → **电机会被指令堆叠**，显然错。
- `Delay`：下一次 tick 排在"现在 + 周期" → 每次唤醒延迟都被**累加**进周期里，循环会永久性地慢下去。
- `Skip`：保持原本的时间表，丢掉错过的 tick → 无堆积、无漂移。**控制循环要的就是这个。**

代码注释里有一段实测记录（`main.rs:1835–1848`）：用 `Delay` 时循环报告 43.1 Hz 而目标是 50 Hz，并且 `missed = 0` —— 它没有超时，只是每次都被推迟。真实总线上读一次要 3–8 ms，那时会更接近 35 Hz，而且看起来**像硬件问题**。这是一个"如果不写下来，下一个人会重新踩"的坑。

### 5.2 第 3 步：`Coast` —— 掉线时"滑行"

串口总线偶尔会掉一次事务，这是**正常的**。但早期版本一掉线就跳过策略一拍，于是输出 `hold`（保持姿态），而 `hold` 只在"停止驱动"时才赋值、赋值又需要一个样本 —— 一个失败的读恰恰没有样本。结果：以大约每分钟 8 次的频率，机器人会在行走中途**突然抽搐一下**（一 tick 的"啪"地回到待机姿态，全增益）。

现在的做法（`main.rs:3316`，`struct Coast`）：

- 掉线时，**沿用上一条好样本**，最多 `COAST_TICKS = 3` 个 tick（60 ms）。
- 为什么安全？因为**观测数据本来就"旧一拍"**：50 Hz 下策略训练时看到的数据就是 20 ms 前的，多一拍还在这个范围内。
- 超过 3 拍（60 ms）就真的看不见了，这时**保持不动**才是诚实的答案。

### 5.3 第 5 步：意图是"原子读"，循环永不阻塞

`intents.rs` 里每个意图槽都是一个 `ArcSwap`（一种无锁的单值容器）：写的人一次原子 store，读的人一次原子 load，**谁都不用等谁**。

为什么这么较真？因为控制循环有 20 ms 的预算，一旦它需要等一个客户端（哪怕只是拿一把锁），这个 tick 就可能超时。而超时的控制循环 = 走不稳的机器人。

> 有意思的细节：**速度（twist）和头部（head）是分开两个槽的**。如果合成一个槽，改其中一个字段就要"读-改-写"，那么"手柄在控身体、另一个客户端在控头"的场景下，两边会互相覆盖。分开之后各槽实际是单写者，last-writer-wins 才是名副其实的。

### 5.4 第 9–10 步：`bringup` 与 `driving`

新手最困惑的地方之一：**为什么我按了 Start，机器人还是不动？**

因为"策略在驱动"需要**六个条件同时成立**（`main.rs:2889`）：

```rust
let driving = snapshot.enabled            // 客户端要求驱动（按了 Start）
    && bringup == Bringup::Ready          // 上电并已回到 home 姿态
    && controller.is_some()               // 策略确实加载成功了
    && !in_limp_fall                      // 不在"摔倒保护"序列里
    && sensors.is_some()                  // 这一 tick 真的有传感器数据
    && imu_warm                           // IMU 滤波器已收敛
    && !powered_off;                      // 没有正在关机
```

每一个条件都是**承重的**。最容易忽略的是 `sensors.is_some()`：一次失败的读没有东西可以构造观测，**编一个出来等于给策略喂一个不存在的机器人**。

还有 `imu_warm`：IMU 的朝向滤波器刚上电的几秒内还没有收敛，此时"投影重力"是滤波器中途随便某个值。策略踩在这样一个地平线上，就是原型时代那个著名的"疯狂启动"。所以代码会等你，并且只警告一次（`main.rs:2876`）。

### 5.5 第 11 步：`control.rs` 里的优先级链

`controller.step()`（`control.rs:427`）选哪张神经网络，按这个优先级：

```text
一次性技能（配置的）  >  ground_pick（捡地上的东西）  >  sit/rise（坐/起）
        >  stand（站立，按速度大小判断）  >  walk（走路）
```

每一步都是"**策略输出 × 缩放 + home 姿态**"，然后头部和腿部各过一个**一阶低通滤波器**：

```rust
let head_lowpass = 0.5;   // 头部，训练时就是这个值
let legs_lowpass = 0.7;   // 腿部，同理
```

⚠️ **这两个数字不能随便改**。它们是 alpha 策略**训练时就在用的值** —— 改了，就等于让策略面对一个它没见过的世界，效果会变差，而且不会报错。`control.rs:697` 有一个测试专门钉住这些默认值。

`control.rs` 里还藏着两个"看起来像 bug、其实是故意的"行为，注释专门解释了为什么不能"修"：

- **踢腿（kick）窗口跑在站立调参下**。因为踢腿的观测里速度指令是全零，而"站立切换"恰好就是在全零时触发的 —— 所以踢腿用的是 `standing_action_scale` 和软化后的增益。保留，因为踢腿就是照着这个调出来的。
- **坐→站的"起"也跑在站立增益下**（它的指令是全零），但"坐"不是（它的姿态标志让速度大小变成 1）。同一个机制，同一个理由。

### 5.6 第 13 步：`safety.apply` —— 唯一的写入口

```rust
match safety.apply(targets, hold, gain) {
    Ok(applied) => limits.extend(applied.limits),
    Err(e) => tracing::warn!(error = %e, "bus write failed"),
}
```

两条铁律，无条件：

1. **非有限值直接拒绝**（不是夹取）。`NaN` 目标不是"太大了"，是"坏了"。
2. **夹到舵机行程内**。注意这是**舵机自己的行程**，不是每个关节的解剖学限位 —— 它能拦住 `NaN`、荒谬的缩放系数和垃圾张量，但**拦不住"把关节驱到一个机械上不明智的位置"**。真正的限位在 alpha 的 MJCF 模型里，那个模型没有 vendor 进这个仓库（这是设计文档里明说的 Open 问题）。

还有一条**死区开关**（deadman）：如果意图停下来了，速度就归零。**注意"停"不等于"软"** —— 通讯断了机器人会**站着不动**，因为对双足机器人来说"站着"才是安全状态。失去平衡是另一回事，这一层不管。

---

## 6. 三条看不见的规矩

这三条是 `robotd` 所有代码的组织原则。看代码时如果觉得某处"绕"，多半是在服务其中一条。

### 6.1 规矩一：`safety` 独占 IO

```rust
// duck-control 里大致是这样：
pub struct Safety<T: RobotIo> { io: T, ... }
```

`safety` **拥有唯一一个写总线的句柄**。策略拿不到，控制器拿不到，客户端更拿不到 —— 它们只能"提议"目标（propose），只有 `safety` 能"发出"（command）。

**这是借用检查器强制的，不是靠约定。** 所以"没有东西能命令电机"这件事，是**结构上不可能**，而不是"大家记得别这么写"。

> 这个思路在仓库里反复出现，设计文档里的说法是：只在一件事已经出错时才运行的代码，恰恰是最容易被悄悄写坏的代码 —— 所以让"坏的状态"根本无法表达。

### 6.2 规矩二：控制循环永不等待客户端

意图 → 原子读；遥测 → 有界广播（`broadcast`），**跟不上的订阅者直接丢帧**（`STATE_BUFFER = 256`，约 5 秒），绝不把背压传导到控制循环上。

所以 `robot.state` 是"参考性的"（advisory）：一个 10 Hz 的仪表盘和一个 50 Hz 的数字孪生，对机器人造成的开销**真的**不一样。

**还有一件事是反过来的：没有任何通道是"进入循环"的。** 健康状态是**发布**出来的，不是**查询**出来的。这带来一个关键性质 —— **一个卡死的循环仍然能诚实地报告自己"不健康"**，而不是把调用者挂住。这是设计文档里五条不变式之一。

### 6.3 规矩三：健康是"发布"的，而且只有发布能进判决

`robot.health` 的答案分两部分，混在同一个响应里，但**用途完全不同**：

| | 是什么 | 谁能用它做决定 |
|---|---|---|
| `healthy` / `degraded` | **控制循环有没有按时完成** | **只有更新系统**（决定是否回滚） |
| 其余全部字段 | 对机器人的**描述**：电池、舵机温度、板子温度、时钟上限、总线计数…… | **不允许任何自动决策读取** |

这条规矩最容易违反，也最贵：

> 如果拿电池做判决 —— 一个电量低的机器人更新后会被回滚，然后新版本又在同样的低电量下被判决，**它从此再也更新不了**，直到有人搞明白为什么。

`robot.health` 的判定逻辑在 `RobotState::health()`（`main.rs:738`），按顺序：

1. `--unhealthy` 强制？（台架测试用）
2. **还没 tick 过一次** —— 区分 "还没启动" 和 "总线上没机器人"：
   - 后者报 **`degraded`**（不是 unhealthy！），因为**没上电的台架板子不该把每个发布都回滚掉**。
3. **策略加载失败** → `unhealthy` ← 这才是让坏发布被回滚的那个判断。
4. **某个槽的 override 加载失败、退回默认** → `degraded`。这是**板子的**问题（有人删了文件），回滚 daemon 修不了它。
5. **连续总线读失败过多** → `unhealthy`。
6. **循环卡住了**（很久没有 tick 落下来）→ `unhealthy`。**这就是"卡死的循环能报告自己不健康"的那条路。**
7. **实际频率低于下限** → `unhealthy`，附带一句 `control loop at 43.9 Hz, below the 50.0 Hz floor`。

注意第 2、4 条：**`degraded` 存在，就是为了让"板子的毛病"不触发回滚。** 这个区分是承重的。

---

## 7. 三个状态机

`robotd` 里所有"一段时间内做的事"都是显式状态机，不是一堆布尔标志。三个重要的：

### 7.1 `Bringup` —— 机器人是怎么"起来"的

```text
   Limp ──── enable（策略已加载 + 有新鲜样本）────▶ Homing ──── 2 秒 ramp ────▶ Ready
  （无扭矩）                                        （扭矩开，                  （在 home
                                                    向 home 姿态斜坡）          姿态，策略可驱动）
```

**核心不变式：`robotd` 绝不因为"一个进程启动了"就动机器人。**

为什么？因为舵机在断电时会**保持最后收到的目标位置**。所以更新时重启 `robotd`，机器人姿态不变 —— 它会**毫无察觉地站着熬过一次更新**。如果在启动时插值到默认姿态，那么**每一次更新重启都会让站着的机器人动一下**：既是摔倒风险，也会污染"我正在测试更新器"这个实验。

**两个条件门控这个状态机**，每个都有自己的理由：

- **策略已加载**：`enable` 的意思是"启用策略"，给一个加载失败或禁用的策略上电，等于让机器人用一个坏版本站起来然后僵在那里。
- **有新鲜样本**：ramp 要从"关节现在在哪"开始。从一个**没人读过的位置**开始，正是 ramp 本身要避免的那一下猛冲。

**"机器人躺在地上"不是拒绝理由。** 早期版本会拒绝，那是从"摔倒判定还能门控其他东西"的年代留下来的。现在它是报告、不是规则 —— 在一个躺着的机器人上按 Start，正是有人叫它站起来的方式。

### 7.2 `LimpFall` —— 摔倒保护

```text
   Idle ──── 预测到要摔 ────▶ Limp ──── 陀螺仪安静下来 ────▶ Posing ────▶ Idle
           （提前，不是等摔完）  （增益降到 gain_limp，  （~1 秒ramp回
                                  关节跟着现状走）        站立姿态，交还策略）
```

这里的设计值得单独讲，因为它违反了直觉：

**"摔倒"其实需要两个检测器。**

- 第一个是**报告用**的：重力方向偏离 + 0.2 s 防抖 → "机器人现在在地上"。回答"它是不是倒了"，这对**上报**是对的。
- 但用来**软化落地**就太晚了：等重力方向过了阈值并且持续 200 ms，机器人**已经在地上了**，值得动作的时间窗早就关了。

所以第二个检测器（`duck_control::fall`）**检测的是角速度而不是位置**。原理很漂亮：投影重力随躯干旋转，所以 `ġ = −ω × g` 是**精确的**，而且 ω 就在同一个 12 字节 IMU 块里 —— 直接外推 ~0.3 秒，就知道重力要去哪。满足三个条件才触发：已经倾斜（约 26°）、还在继续倒、外推结果超过摔倒阈值。

**它买到的不是落地那一下，而是落地之后的"站起来"。** 站立策略擅长把一个静止的、姿态已知的机器人干净地扶起来；对一个还在挣扎的机器人，它只会以走路增益反复尝试、跟地板较劲，而**电机就是在这里付出的代价**。所以序列把摔倒从策略手里拿走：变软跟着下去 → 等陀螺仪安静 → ~1 秒摆回站姿 → 交还。

**调参的方向是"宁可晚"**：误报意味着机器人**被你弄摔的**，比它想避免的"僵硬落地"更糟。

### 7.3 `Sit` —— 坐/站

```text
   Up ──── sit_toggle ────▶ Sitting ──── sit_toggle ────▶ Rising ──── 1 秒 ────▶ Up
                        （姿态标志=1，                    （姿态标志=0，
                          姿态网络保持坐姿）                姿态网络起身）
```

姿态标志走的是**速度的 vx 槽**：1 = 坐，0 = 站。这是原型训练时的编码方式，不是随便选的。

---

## 8. 挂在 tick 上的附加功能

`robotd` 在 slice 2 之后长了四个**不是控制、也不是安全**的子系统。它们有一个共同形状：**都挂在 tick 上，都不许阻塞 tick，都不能绕过循环已经仲裁过的意图去碰总线。**

| 文件 | 是什么 | 关键点 |
|---|---|---|
| `sound.rs` | 播放时的"嗓子" | 用 `aplay` **子进程**播放（默认设备 `plughw:aic3104`）；**没有混音器** —— codec 的 PCM 是独占的，所以"新声音杀掉旧声音"，用一个 `Ride` 状态机仲裁 |
| `theremin.rs` | 特雷门琴：ToF 深度 → 音高 | 从 `tofd` 以 15 Hz 读深度；`kinematics::hand::Tracker` 把手到嘴的距离变成 `closeness`；**它不合成声音**，只把 closeness 交给 `sound.rs`；同一个值还驱动嘴巴舵机 |
| `chorale.rs` | 多只鸭子合唱一首曲子 | **id 最小的当指挥**（确定性，不需要选举、没有消息可以丢）；**指挥拥有座位分配权**，因为自己给自己排座会和别人冲突；**时基是指挥的节拍计数器**（没有可对齐的时钟），卡顿的鸭子能回到正确位置 |
| `pet-detect/` | 摸头检测（独立 crate） | 板载麦克风上的 ~20 KB CNN，跑在自己的 worker 里 |

加上 `soc.rs`，它从 `sysfs` 读板子的温度和时钟上限 —— **故意不放在 `duck_control` 里**，因为它是 Linux 板子的属性而不是机器人的属性，**而这恰恰是它的价值所在：电机总线挂了的时候，它还能回答问题**。一块通风口被堵住的板子和一个舵机全死的机器人，症状是一样的，直到你能同时看到两个数字。

**"看门狗"式的日志限流**在 `main.rs` 里到处都是，这是有原因的战绩：

- `LOOP_SUMMARY_INTERVAL = 300s` —— 50 Hz 每 tick 一行的话是 **430 万行/天**。在 journal 有大小上限的情况下，这不是"吵"，这是**把 support 真正需要的日志挤掉**。
- `BUS_DROP_QUIET = 60s` —— 曾经"一次孤立的总线掉线"会立刻记一行，而 `consecutive` 计数在下一次成功读取时就归零，所以**每一次掉线都满足 `n == 1`**。结果是每分钟八行的最平凡事件把 journal 填满。现在：孤立的掉线每分钟一行，**连成串的掉线照旧大声**（那才是真的抽搐）。

---

## 9. 对外接口：`robot.*` API

socket 在 `/run/robotd.sock`，权限 `0660`，**组决定谁能问**。协议是 **NDJSON 的 JSON-RPC 2.0**（每行一个 JSON 对象）。

这里有一个很漂亮的设计：**JSON-RPC 的两种消息族恰好对应两种意图**。

```jsonc
// 连续意图 → 通知（notification）：没有 id，没有回复，后写覆盖先写
{"jsonrpc":"2.0","method":"robot.move","params":{"vx":0.2,"vy":0.0,"vyaw":0.4}}
{"jsonrpc":"2.0","method":"robot.head","params":{"neck_pitch":0.35,"head_pitch":0.35,
                                                 "head_yaw":0.0,"head_roll":0.0}}

// 离散意图 → 请求（request）：有 id，会被回答
{"jsonrpc":"2.0","id":7,"method":"robot.stop"}
{"jsonrpc":"2.0","id":8,"method":"robot.enable","params":{"on":true}}
```

50 Hz 下，把连续意图做成"通知"意味着**没有回复流量**。而且以后走 WebRTC 时，通知会自然落到**不可靠**的 `teleop` 通道、请求落到**可靠**的 `control` 通道 —— 这不是谁定的规矩，是从消息族里**掉出来的**。

### 方法一览

| 方法 | 类型 | 干什么 |
|---|---|---|
| `robot.move` | 通知 | 身体速度 `vx, vy, vyaw` |
| `robot.head` | 通知 | 脖子 + 头 4 个角度 |
| `robot.pose` | 通知 | 站立时的身体姿态 `z, roll, pitch` |
| `robot.mouth` | 通知 | 张嘴程度 0..1 |
| `robot.look` | 请求 | **看向空间一点** —— 在 robotd 里跑 IK，返回关节角 + 是否被限位 |
| `robot.stop` | 请求 | 速度归零（**不是**断电） |
| `robot.enable` | 请求 | 开/关策略驱动（手柄的 Start） |
| `robot.init` | 请求 | 上电 + 回到 home 姿态（**不需要策略**） |
| `robot.relax` | 请求 | 断电 —— 没人扶着就会瘫下去 |
| `robot.rebootMotors` | 请求 | 重启舵机（全部或指定 ID），然后 limp |
| `robot.do` | 请求 | 跑一个一次性技能，或者切换坐/站 |
| `robot.sound` | 请求 | 播放音效 |
| `robot.theremin` | 请求 | 拿起 / 放下 ToF 特雷门琴 |
| `robot.chorale` | 请求 | 开始 / 停止找其他鸭子合唱 |
| `robot.setMode` | 请求 | 切换行走模式（`walk` / `roller`） |
| `robot.mode` | 请求 | 当前模式 |
| `robot.shutdown` | 请求 | 坐下，然后关机 |
| `robot.subscribe` | 请求 | 把这条连接变成 `robot.state` 状态流 |
| `robot.state` | 通知 | 状态帧（见下） |
| `robot.health` | 请求 | 健康判决 + 全部描述信息 |
| `robot.safeToRestart` | 请求 | 现在能不能重启（走路时不行） |
| `robot.modelApi` | 请求 | 常量：模型 API 版本（当前 `2`） |
| `robot.policies` | 请求 | 每个策略槽在跑什么、从哪来、为什么没跑 |
| `robot.loadPolicy` / `robot.reloadPolicies` | 请求 | 换一个槽 / 重读全部 |
| `robot.model` | 请求 | 静态几何（躯干高度、关节顺序、ToF 光束方向等） |

### 状态帧：`robot.state`

**必须报告"被拒绝的东西"，而不只是"发生了什么"。** 一个遥控界面显示着摇杆推到底、机器人却不动，**而且没有任何解释** —— 那是没法用的。而安全层一直在夹取东西。

```jsonc
{"method":"robot.state","params":{
  "t":1234.567,
  "move":{"requested":[0.4,0,0],"applied":[0.15,0,0],"limited_by":["max_velocity"]},
  "policy":"walk", "safety":{"fallen":false,"limp":false},
  "loop":{"hz":49.8,"missed":0},
  "battery":{"volts":7.62,"percent":64}
}}
```

两个值得学的细节：

- **`battery` 同时带 `volts` 和 `percent`。** 映射关系（6.6 V 空 / 8.2 V 满 / NP-F550 电池）住在 `duck_control::model::battery_percent`，**算好了才上路**。原型只发电压，App 自己用另一套常数再算一遍百分比 —— 同一块电池在两个屏幕上显示两个数，就是这么来的。
- **`limited_by` 的名字是"拼出来给线路用的"**，不是从 Rust 枚举 `Debug` 出来的。这样以后重命名一个变体，不会悄悄破坏一个正在 `match` 这个字符串的客户端。

---

## 10. 配置与部署

### 10.1 参数文件

`/etc/robot/robotd.toml` —— **它在 `releases/<ver>/` 之外**，所以它能**同时活过更新和回滚**。

**文件可以不存在。** 一块没被 provision 过的板子会用内置默认值起来，而不是拒绝启动 —— 这在远程诊断时比"一个起不来的 daemon"好太多了。

大部分配置**只在启动时读一次，不监听变化**。只有两处例外，而且这两个例外是"挣来的"：`padd` 每秒 stat 一次 `[pad]`；`robotd` 在被要求时重读 `[policy]`（这样 `robotctl policy add` 能在**不打断一个站着的机器人**的情况下装载技能）。重读 `[safety]` 或 `[control]` 是一个大得多得多的承诺，**至今没有做**。

主要配置段：

```toml
[bus]             串口端口、fast_sync_read 开关
[control]         hz（默认 50）、cmd_alpha / head_alpha（指令平滑）
[update_gate]     决定 healthy 的阈值（min_achieved_hz 等）
[policy]          各槽的 .onnx 路径、mode（walk/roller）、enabled
[safety]          摔倒阈值、死区超时、gain_limp、电池空关机
[audio]           音效库路径、ALSA 设备、宠物检测
[theremin]        ToF 特雷门琴（默认关）
[chorale]         合唱（默认关）
[pad] / [pad_imu_head_control]   手柄按键绑定（padd 读，robotd 不读）
```

> ⚠️ 一个用血换来的教训：**在板子上被注释掉/写死的值，会在发布版本前进时永远冻结在那块板子上。** 这就是"整个机队的机器人站在 kP 120，而发布默认值是 160"的由来。

### 10.2 systemd 单元

`robotd/systemd/robotd.service` 里几条**承重**的配置：

| 配置 | 为什么 |
|---|---|
| `User=root` | 电机控制需要 i2c/spi/gpio 字符设备 |
| `Group=robot` | **socket 继承进程的主组** —— 这才让 `0660` 的 socket 意味着"robot 组可以连"。否则 `btd` 和 SDK 连不上，而且症状看起来像"机器人不健康"而不是权限错误 |
| `After=local-fs.target`（**无网络依赖**） | 必须零联网起立、保住关节、回答健康 |
| `Restart=always` + `RestartSec=2s` | 干净的退出也等于失控（**没有哪个退出码意味着"就该让它停着"**）；2 秒很短，因为**健康门正在等它回来**，长延迟会吃掉门的预算并回滚一个健康的发布 |
| `RuntimeDirectory=robotd` | 得到 `/run/robotd/identity.json`，`robotctl health` 和 updaterd 的启动检查会读它；停止即删，不留一份"自称在跑"的身份 |
| `RUST_LOG=info` | info 可以出厂 —— 控制循环 5 分钟才一行摘要 |
| 加固只有 `NoNewPrivileges` 等三项 | **故意不用** `ProtectSystem=strict` / `PrivateDevices` —— 这个进程就是来跟硬件说话的 |

注意：文件里**没有** CPU/IO 调度项（没有 `CPUWeight` / `Nice`）。设计文档明确说了这不是一个实时（RT）工程项目：没有 `SCHED_FIFO`、没有绑核、没有 `mlockall`。循环今天已经可靠了，任务是在周边代码变简单的过程中**保持**这一点。

### 10.3 单实例锁

`socket_path + ".lock"`（即 `/run/robotd.sock.lock`），用 `flock` 抢占。

> **永远不要 unlink 这个锁文件，关机时也不要。** 内核在文件关闭或进程退出（包括 `SIGKILL`）时释放建议锁，**文件本身留在原地**。删掉再建，可能让竞争者去锁**两个不同 inode 上的同一个名字**。文件存在 ≠ 锁被持有。

---

## 11. 测试

```bash
cargo test -p robotd
```

**不需要硬件、不需要网络、不需要 Docker。** 秘密是 `FakeIo` —— `RobotIo` trait 的第二个实现（第一个是真的串口），可以脚本化样本、按需冻结或失败。

两个集成测试守的是**契约**，值得单独说：

### `tests/single_instance.rs`

守"启动所有权"。要防的失败是：第二个进程 **unlink 掉第一个的 listener**、抢走客户端，于是**两个控制循环同时跑**。测试覆盖：第二个实例退出码为 1、不发布身份、不起循环、不开总线；`init` 也不能绕过锁；`SIGKILL` 之后必须能用**同一个 lock inode** 重启（PID 文件或无条件独占创建会活过 `SIGKILL`，阻断恢复）；一个健康的 listener 即使没持锁（老版本 robotd）也必须保留。

### `tests/updater_gate.rs`

守"健康门对**真实进程、真实 socket** 有效"。为什么必须是真的？因为 `updater` 内部的 `FakeRobot` **从不做序列化** —— 字段改名、socket 权限错误、"接受连接但不回答"这些 bug 它一个都抓不到。

其中一个用例特别值得理解：`--unhealthy` 必须报 **`Unhealthy(reason)`** 而不是 `Unreachable`。因为 `Unreachable` 是**正常状态**（daemon 起不来时就是它），把它降级会让回滚**因为错误的理由发生**，journal 也就指向了错误的原因。

> 📌 这个测试住在 `robotd/tests/` 而不是 `updater/tests/`，有一个具体原因：只有在本包里，cargo 才会定义 `CARGO_BIN_EXE_robotd` 并**保证二进制是重新构建过的**。在 `updater/tests/` 里曾经需要猜路径，而 `cargo test --test <name>` **不会重建兄弟二进制** —— 于是测试静默地跑了一个旧的 robotd，并且**自信地给出了错误结论**。

---

## 12. 给新手的阅读路线

建议按这个顺序，每一步都能独立看懂：

**第 1 步 —— 建立直觉（30 分钟）**

1. 读 [`design/robotd-design.md`](design/robotd-design.md) 的 §1（形状）、§1.4（tick）、§1.5（不变式）。
2. 读 `robotd/src/main.rs` 的**前 150 行**。别跳注释 —— 这个仓库的注释不是"这行代码干什么"，而是"为什么是这个数、为什么不那样做"。这是它最大的特点。

**第 2 步 —— 看懂一个 tick（1–2 小时）**

3. 读 `main.rs:1761–2100`（循环的开头 + 所有状态变量的声明）。
4. 读 `main.rs:2889–3010`（`driving` 判定 → `controller.step()` → `safety.apply`）。**这三段就是整个程序的核心。**
5. 读 `control.rs` 全文（747 行，不長）。

**第 3 步 —— 看懂边界（1 小时）**

6. 读 `intents.rs` 全文 —— 理解"循环永不等待客户端"是怎么做到的。
7. 读 `main.rs:738–921`（`RobotState::health()`）—— 理解 `healthy` 和 `degraded` 的区别为什么承重。

**第 4 步 —— 挑一个你感兴趣的去读**

8. 声音 → `sound.rs`；合唱 → `chorale.rs`；特雷门 → `theremin.rs`。
9. 想跑起来 → `robotd --fake`（笔记本上，没有机器人）；`robotd --sim host:port`（对 MuJoCo 里的身体跑**同一个 daemon**）。

**第 5 步 —— 动手**

```bash
cargo test -p robotd                                  # 全部测试，不需要硬件

# 笔记本上跑一个"空气机器人"。默认 socket 是 /run/robotd.sock（要 root），
# 所以本地开发要显式改到一个自己可写的地方。
cargo run -p robotd -- --fake --socket /tmp/robotd.sock
```

然后另开一个终端，问它一句：

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"robot.health"}' \
  | socat - UNIX-CONNECT:/tmp/robotd.sock
```

你会看到 `healthy` 判决和它背后的所有数字 —— 也就是更新器做回滚决定时看的那份东西。

---

## 13. 术语表

| 术语 | 意思 |
|---|---|
| **daemon（守护进程）** | 在后台一直运行、不跟终端交互的程序 |
| **tick** | 控制循环的一"拍"。50 Hz 就是一拍 20 毫秒 |
| **控制循环** | `robotd` 的心脏：读传感器 → 算目标 → 写电机，无限重复 |
| **意图 / intent** | 客户端表达"我想让它怎样"，而不是直接命令电机 |
| **Dynamixel** | 舵机品牌（这里是 XL330 系列）。"Dynamixel 协议 v2" 是它说话的方式 |
| **sync_read / sync_write** | 一次事务读/写**多个**舵机的寄存器 —— 总线很贵，所以要一网打尽 |
| **fast sync read** | 协议 2.0 的指令 `0x8A`。16 个设备把数据块**追加进同一个广播包**，总线从每 tick 转身 16 次变成 1 次。需要 XL330 固件 ≥ v46 |
| **torque（扭矩）** | 舵机"用力保持位置"的状态。关掉 = 变软 = 机器人会瘫下去 |
| **gain / kP** | 位置环增益。越大越"硬"，越小越"软" |
| **观测 / observation** | 喂给神经网络的 61 个浮点数：陀螺仪 3 + 投影重力 3 + 关节位置 14 + 关节速度 14 + 上次动作 14 + 指令 13 |
| **策略 / policy** | 一个 ONNX 神经网络文件：61 个输入 → 14 个动作输出 |
| **home 姿态 / DEFAULT_POSITION** | 机器人的"立正"姿势。**必须**和训练环境里的 `HOME_FRAME` 一致，否则观测的 14 个槽会有一个常数偏移 |
| **原子变量 / atomic** | 不加锁就能安全跨线程读写的变量。控制循环用它来"读一眼"客户端意图 |
| **ArcSwap** | 一种无锁单值容器：读一次原子 load，写一次原子 store，互不阻塞 |
| **无锁 / lock-free** | 不需要等别人释放锁。控制循环的全部对外交互都是无锁的 |
| **死区 / deadman** | "如果控制信号停了，就自动归零"的安全机制 |
| **limp（软）** | 扭矩关闭，关节可以自由被推动 |
| **健康门 / health gate** | 更新系统在换版后问 `robot.health`，不健康就自动回滚 |
| **degraded** | "不是发布版本的错"的不健康状态。**不会**触发回滚 |
| **ONNX Runtime** | 跑 `.onnx` 神经网络文件的运行时。它是**板子的前置依赖**，由 `scripts/install.sh` 装，不随发布包走 |
| **rollout / 回滚** | 把 `current` 符号链接指回上一个版本的目录 |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| **配置文件的 schema、默认值、校验与编辑器（姊妹篇）** | [`robotd-params-primer.md`](robotd-params-primer.md) |
| **蓝牙门房：手机怎么连上机器人（姊妹篇）** | [`btd-primer.md`](btd-primer.md) |
| **wifi、身份、手柄配对（姊妹篇）** | [`configd-primer.md`](configd-primer.md) |
| **BLE 的线上契约（姊妹篇）** | [`duck-ble-primer.md`](duck-ble-primer.md) |
| **控制核心：从读总线到写总线（姊妹篇）** | [`duck-control-primer.md`](duck-control-primer.md) |
| 摄像头里的鸭子检测（姊妹篇） | [`duck-detect-primer.md`](duck-detect-primer.md) |
| 仿真的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| 所有服务与客户端的公共契约（姊妹篇） | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| 笔记本上的客户端（姊妹篇） | [`duckctl-primer.md`](duckctl-primer.md) |
| 发布怎么把自己装到板子上（姊妹篇） | [`hooks-primer.md`](hooks-primer.md) |
| 板子被配置成什么样子（姊妹篇） | [`deploy-primer.md`](deploy-primer.md) |
| 控制循环的权威设计（英文） | [`design/robotd-design.md`](design/robotd-design.md) |
| 服务拆分、IPC 契约、状态归属、安全与权限 | [`design/architecture.md`](design/architecture.md) |
| 策略（.onnx）从哪里来、怎么换 | [`design/policy-channel-design.md`](design/policy-channel-design.md) |
| 更新引擎：校验、原子换版、健康门、回滚 | [`design/updater-design.md`](design/updater-design.md) |
| 每一条 `robotctl` 命令 | [`robot/cheatsheet.md`](robot/cheatsheet.md) |
| 在笔记本上跑模拟的鸭子 | [`robot/simulation.md`](robot/simulation.md) |
| 关节角 → 空间中的点：头部姿态、ToF、骨架（姊妹篇） | [`kinematics-primer.md`](kinematics-primer.md) |
| 摄像头、WebRTC、远程网关（姊妹篇） | [`mediad-primer.md`](mediad-primer.md) |
| 机器人走到哪了：控制环里那个纯结构体（姊妹篇） | [`odometry-primer.md`](odometry-primer.md) |
| 手柄自己的 IMU：姿态、零偏、yaw 漂移（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| 那个每天都在用 intent API 的客户（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| 听麦克风的那个 worker（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| 监控控制环的那个 TUI（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| 装机、更新、诊断的那些工具（姊妹篇） | [`scripts-primer.md`](scripts-primer.md) |
| 鸭子的嗓子：可播种的合成器（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 头部的两个传感器：深度与 IMU（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
