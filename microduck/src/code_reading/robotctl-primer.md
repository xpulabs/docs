# `robotctl` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> 每个命令的操作者视角由 [`robot/cheatsheet.md`](robot/cheatsheet.md) 拥有 ——
> [`docs/README.md`](README.md) 说它是 *"Every `robotctl` command."*，
> 而且它的每一行都是从 `--help` 抄的，不是凭记忆写的。**先读它，再读代码。**
> 开发板相关的命令在 [`robot/cheatsheet-dev.md`](robot/cheatsheet-dev.md)。
> 若本导读与代码不一致，以代码为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：[`duckctl-primer.md`](duckctl-primer.md)（**笔记本上**那个客户端，走蓝牙）、
> [`robotd-params-primer.md`](robotd-params-primer.md)（`configure` 编辑的那份 schema）、
> [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md)（它说的那门语言）。

## 目录

1. [一分钟版](#1-一分钟版)
2. [⚠️ 它跑在**机器人上**，不是笔记本上](#2-️-它跑在机器人上不是笔记本上)
3. [⭐ 核心心智模型：一个薄客户端](#3--核心心智模型一个薄客户端)
4. [命令地图](#4-命令地图)
5. [退出码：为什么每一个都不一样](#5-退出码为什么每一个都不一样)
6. [`monitor`：那个屏幕](#6-monitor那个屏幕)
7. [`configure`：那个编辑器](#7-configure那个编辑器)
8. [`update` 与 `update show`](#8-update-与-update-show)
9. [那个 3D 视图](#9-那个-3d-视图)
10. [⭐ 为什么依赖表这么短](#10--为什么依赖表这么短)
11. [测试：185 个](#11-测试185-个)
12. [几处读者会绊到的地方](#12-几处读者会绊到的地方)
13. [阅读路线](#13-阅读路线)
14. [术语表](#14-术语表)

---

## 1. 一分钟版

`robotctl` 回答一个问题：

> **这台机器人现在怎么样了，我该怎么让它做点什么？**

它是一个**单文件、依赖极少的命令行工具**，通过 **Unix socket** 和机器人上的各个 daemon 说话。
`main.rs:3-6` 说清了它的姿态：

> A **thin client** over `updaterd`'s unix socket: parse argv, send one JSON-RPC request, print the
> streamed notifications and result, map the outcome to an exit code. **It contains no update
> logic** — that lives in the engine inside `updaterd`.

**"薄客户端"**：解析命令行 → 发一个请求 → 打印 → 映射成一个退出码。就这么多。

规模：**15,929 行**（10 个文件），185 个测试。

```
robotctl/
├── Cargo.toml              57 行 —— 头 15 行讲清依赖规则
├── assets/duck.bin     68,622 字节  ← 那个 3D 模型
└── src/
    ├── main.rs           6785 行  CLI、17 个命名空间、health/version、update
    ├── monitor.rs        4850 行  实时 TUI
    ├── configure.rs      1405 行  配置编辑器
    ├── duck.rs            926 行  3D 视图
    ├── show.rs            740 行  `update show`
    ├── path_map.rs        353 行  里程计地图（盲文）
    ├── camera.rs          305 行  摄像头块
    ├── imu_view.rs        297 行  手柄线框
    ├── frame.rs           167 行  本机快照
    └── cells.rs            44 行  半格像素助手
```

---

## 2. ⚠️ 它跑在**机器人上**，不是笔记本上

**这是最容易搞反的一件事。**

| | `robotctl` | [`duckctl`](duckctl-primer.md) |
|---|---|---|
| **在哪跑** | **机器人上**（ssh 进去） | **开发者的笔记本上** |
| **怎么连** | 本机 Unix socket（`/run/*.sock`） | 蓝牙 BLE |
| **会随发布安装吗** | **会** —— 它是"会出货的那个工具" | **不会** —— 排除在 `default-members` 之外 |
| **干什么** | 本机控制与恢复面 | 手机 app 的替身 |

`docs/robot/duckctl.md` 说得最直白：

> **Never on a robot.** Nothing in a release depends on it — **`robotctl` is the tool that ships**,
> and [`cheatsheet.md`](robot/cheatsheet.md) has its commands.

可以用 `Cargo.toml` 的 workspace 配置验证这一点：

```toml
# 根 Cargo.toml:21
default-members = [..., "robotctl", "robotd", "robotd-params", ...]   # ← robotctl 在
#                    ... 没有 duckctl ...
```

> 💡 它**也**能从笔记本上跑 —— 把 socket 转发过去就行：
> `ssh -L /tmp/robotd.sock:/run/robotd.sock duck`，然后 `--socket /tmp/robotd.sock`。
> 但它**家**在机器人上。

---

## 3. ⭐ 核心心智模型：一个薄客户端

### 3.1 一句话

> **它自己不做什么，它只是把话带到，再把回答带回来。**

没有 daemon 逻辑在里面。所有的智慧——更新引擎、控制环、配置校验——都在 socket 的另一头。

### 3.2 `Client` 那个结构体

```rust
// robotctl/src/main.rs:1261-1264
// Deliberately `std::os::unix::net`, not tokio: this is a short-lived CLI issuing one request.
// An async runtime would add a dependency and a concept for nothing.
```

**"一个短命的 CLI 发一个请求 —— 引入 async runtime 只会加一个依赖和一个概念，换不来任何东西。"**

`Client::call`（`:1319`）写一个请求然后循环读：

- **通知**（没有 `id`）→ 写到 **stderr**（`:1316-1318`）
- **回答**（`id` 对得上）→ 返回
- 对不上的 `id` → 忽略

> 💡 **结果走 stdout，通知走 stderr。** 这是 `main.rs:19-31` 那五条设计规则之一，
> 为的是 `robotctl update watch | grep` 这种用法能工作。

### 3.3 ⭐ `hello` 是活性检查，**不是门**

```rust
// robotctl/src/main.rs:1363-1367
/// **A liveness check, not a gate.** It used to be one: a daemon whose `API_VERSION` differed
/// refused the handshake and every command failed here, including the `update apply` that ends
/// the skew. **No daemon refuses on that number now** — see [`proto::API_VERSION`] — so what
/// remains is worth keeping for its own sake, because it turns a socket that accepts and then
/// says nothing into a failure before the real call goes out.
```

**"一个版本号不同的 daemon 会拒绝握手，于是每条命令都失败在这里 —— 包括那条本来能结束这个
skew 的 `update apply`。"**

这就是仓库那条规矩（*"版本差异只记录不拒绝"*）在这个 crate 里的样子。
现在改成了 `warn_once_about_skew`（`:1407`）：**stderr 上警告一次**，一个 run 只一次。

### 3.4 连接失败时要问对问题

```rust
// robotctl/src/main.rs:1218-1226
/// Every kind used to get `Is the service running?  systemctl status …`, which is the right
/// question for **exactly one of them**. On a freshly provisioned board the usual answer is
/// `EACCES`, and there the service is running fine — **the caller is simply not in the `robot`
/// group yet**…
///
/// `EACCES` from `connect` means **something was found and refused us**, never that it was absent
/// — that is `ENOENT` — so the two cases can be told apart without stat'ing anything.
```

**"`EACCES` 意味着有东西在那儿并且拒绝了我们，从来不是它不存在。"**
所以权限错误给的是 `newgrp robot` / `id -nG` / `usermod -aG` 的建议，
而不是让人去查一个运行得好好的服务。

### 3.5 五个服务，七条 socket

所有 socket 路径都是 `#[arg(long, global = true)]`，所以可以写在命令行的任何位置：

| 旗标 | 默认值 |
|---|---|
| `--socket` | `/run/updaterd.sock` |
| `--robot-socket` | `/run/robotd.sock` |
| `--config-socket` | `/run/configd.sock` |
| `--pad-socket` | `/run/padd/pad.sock` |
| `--tof-socket` | `/run/tofd/tof.sock` |
| `--media-socket` | `/run/mediad/media.sock` |
| `--pad-config` | `/etc/robot/robotd.toml`（**文件**，不是 socket） |

⚠️ 注意 `--robot-socket` 用的是**写死的字面量**而不是 proto 的常量 —— 见 §12。

---

## 4. 命令地图

**17 个顶层命名空间**（`enum Namespace`，`main.rs:124`）：

```
frame            存一帧原始摄像头画面
net              wifi（configd 服务）      status · scan · connect · forget
system           名字、身份、电源          info · set-name · pin · set-pin · reboot
robot            给关节通电                init · enable · relax · reboot-motors · do · mode · look
quack            让它叫一声
chorale          和其他鸭子合唱
theremin         把头部深度传感器当特雷门琴
configure        编辑 robotd.toml
pad              手柄                      status · bindings · bind · reset · pair · forget
update           更新与发布管理             （见 §8）
account          Hugging Face 账号         login · status · logout
policy           哪个 .onnx 跑在哪个槽      list · load · add · remove · search · check · update · reset
duck-detector    找鸭子的模型              check · update
monitor          控制环实时视图
health           硬件 + 软件一份报告
version          在跑什么 vs 装了什么
completions      打印 shell 补全脚本
```

### 4.1 ⭐ `quack`：最响的辨认方式

`main.rs:154-156`：

> Play this robot's quack. **The loudest way to tell ducks apart**: every robot's voice is generated
> from its SoC serial, so **the one that answers — in a voice that is only its own — is the one
> you're SSH'd into.**

**"用只属于它自己的声音回答的那一只，就是你 ssh 进去的那一只。"**

（它还会 `println!("🦆")`。）

### 4.2 `pad` 的两半住在不同的地方

```rust
// main.rs:4601-4608（节选）
bindings | bind | reset  →  run_pad_bindings(&cli.robot_socket, &cli.pad_config, …)
其他                     →  run_pad(&cli.config_socket, …)
```

**配对归 `configd`（需要 root 和 BlueZ），按键绑定是改文件**（还要问 `robotd` 有哪些技能）。
所以一个 `pad` 命名空间下面挂着两个不同的后端。

### 4.3 两个命令会**先问你一遍**

`system reboot` 和 `robot relax` 不带 `--yes` 时返回 `USAGE`（`main.rs:2624-2628`、`:2705-2712`）。
理由在 `robot relax` 那条：把机器人弄瘫是一个**没有回头路**的动作。

---

## 5. 退出码：为什么每一个都不一样

```rust
// robotctl/src/main.rs:53
/// Exit codes. Stable — CI asserts on these.
```

| 码 | 名字 | 什么时候 |
|---|---|---|
| 0 | `OK` | |
| 1 | `FAILED` | 其他一切 |
| 2 | `USAGE` | 用法错。**对齐 clap 自己的约定** |
| 3 | `UNREACHABLE` | 够不到 daemon |
| 4 | `BUSY` | **另一个更新正在进行 —— 脚本应该重试** |
| 5 | `REFUSED` | 被拒绝了：不兼容，或者 preflight 失败 |
| 6 | `DENIED` | **没权限改这台机器人** |

**每一条的"为什么是单独的"都写在注释里**，值得逐个读：

```rust
// main.rs:60
/// `updaterd` unreachable — a different problem from a rejected command.

// main.rs:62
/// Another update is in flight. **Distinct so scripts retry rather than fail.**

// main.rs:66
/// Refused: incompatible, or preflight failed. **Distinct so a test can assert "correctly
/// rejected" rather than "something broke"** — needed for the bad-signature and wrong-hardware
/// cases.

// main.rs:70
/// Not permitted to change this robot. **Distinct from REFUSED**: the request was well-formed and
/// applicable, the caller just isn't allowed — so the fix is **"run as root / ask an
/// administrator", not "try something else"**.
```

**`REFUSED` 和 `DENIED` 的区别是"你不能"和"你不许"。**
前者换一条命令，后者换一个身份。

### 5.1 daemon 的错误码怎么映射

集中在 `Failure::from_rpc`（`:2369-2384`）：

| daemon 码 | 退出码 |
|---|---|
| `BUSY` | 4 |
| `INCOMPATIBLE` · `PREFLIGHT_FAILED` · `VERIFICATION_FAILED` · `WOULD_DOWNGRADE` · `NOT_INSTALLED` · `ARCHIVE_TOO_LARGE` | 5 |
| `PERMISSION_DENIED` | 6 |
| `PROTOCOL_MISMATCH` | 2 |
| 其他 | 1 |

### 5.2 `health` 的退出码是个"判决"

```rust
// main.rs:1564-1571
Some(true)  => Ok(())
Some(false) => Err(Failure::silent(exit::REFUSED))
//   "REFUSED, not FAILED: **the robot answered correctly and the answer was "no". That is a
//    verdict, not a malfunction**, and a script should be able to tell them apart."
None        => Err(Failure::silent(exit::UNREACHABLE))
//   "Nothing answered. Distinct again: **there is no verdict to act on.**"
```

`install.sh` 靠这个当门（`:1525`）。

⚠️ **注意 `Failure::silent`**（`:2360`）：它带一个退出码和**空消息**。
因为 `health` 已经把答案打在 stdout 上了，再在 stderr 上打一行 `error: …` 是重复。

**而且只有"机器人不健康"才影响退出码** —— 电量低、电机烫、组件被 pin 都只是**报告，不判决**
（`main.rs:1524-1527`）。

---

## 6. `monitor`：那个屏幕

### 6.1 它为什么存在

```rust
// robotctl/src/monitor.rs:6-8
// Joint tracking lives here, which is the reason this exists: **fifteen measured angles beside
// fifteen commanded ones is unreadable as text at 10 Hz, and is obvious as fifteen bars.**
```

**"十五个实测角度挨着十五个指令角度，用文字看是读不下去的；画成十五根条就一目了然。"**

### 6.2 一份流，两种渲染

```rust
// monitor.rs:9-11
// a screen-painting CLI that writes escape codes into a log file is a CLI nobody can script
```

- **stdout 是终端** → ratatui 界面，原地重画
- **stdout 是管道 / 文件 / `--json`** → 每 tick 一行，`git log` 那样可以 grep

### 6.3 屏幕长什么样

```
┌─ policy walk · t 12s · 50.0 Hz ──────────── q quit · p pad · t tof · c cam ─┐
│  move   asked/applied            │  imu   gravity, upright                   │
│  limits · head · odom            │                                           │
│  power  battery · hottest servo  │                                           │
└──────────────────────────────────────────────────────────────────────────────┘
┌─ pad · cadence ──────────────────────────────────────────────────────────────┐
│  报告间隔的 sparkline + 摇杆格子 + 按住的键                                   │
└──────────────────────────────────────────────────────────────────────────────┘
┌─ joints ─────────────────────────────────────────────────────────────────────┐
│  left_hip_pitch    -0.52   -0.52   0.001  ▏                                  │
│  …每个关节一行：名字 / 实测 / 指令 / 误差 / 偏差条                            │
└──────────────────────────────────────────────────────────────────────────────┘
   loop rate sparkline
```

右列是那个 **3D 视图**，下面挂一张**里程计地图**。

### 6.4 ⭐ 每一块的高度都是**编译期常数**

这是这个文件里最反复出现的一条设计：

```rust
// monitor.rs:59-62
/// Rows the robot block occupies: two borders, a four-row half for the command and the IMU side
/// by side, then the limits, the head, the odometry and the power row.
/// **Fixed, because a header that grows when a limit appears would shift every joint row down at
/// the moment the reader is staring at one.**
```

**"一个在限制出现时长高的表头，会在读者正盯着某一行的时候把每个关节行都往下推。"**

| 常数 | 值 | 哪一块 |
|---|---|---|
| `HEADER_HEIGHT` | 10 | 表头 |
| `PAD_HEIGHT` | 8 | 手柄 |
| `IMU_HEIGHT` | 12 | 手柄的 IMU 面板 |
| `TOF_HEIGHT` | 10 | 深度矩阵 |
| `CAMERA_HEIGHT` | 16 | 摄像头 |
| `PATH_HEIGHT` | 12 | 里程计地图 |

而那三个"开关才出现"的块（`:71-72`）：

> Fixed, like the header and for the same reason — **but *only while open*. Toggling it is a
> deliberate act, and everything below moving then is what the reader asked for.**

**"打开它是一次刻意的动作，那时下面的一切移动是读者自己要求的。"**

### 6.5 ⭐ 那些刷新的节流，都是热量账

| 常数 | 值 | 为什么 |
|---|---|---|
| `IDLE_REDRAW` | 250 ms | 没有新数据也重画，**这样卡住的流看起来就是卡住的** |
| `IMU_REPAINT` | 33 ms | 手柄每秒发 600 个采样，而"每秒重画 600 次的终端是一个别的什么都做不了的终端"（`:85-87`） |
| `CAMERA_PERIOD` | 500 ms | "**每次请求都让 `mediad` 从那条本来会直接丢掉的采集支路上拷 1.84 MiB**，而一个房间的画面不会比人看一眼变得更快"（`:111-114`） |
| `RASTER_INTERVAL` | 80 ms | 3D 视图约 12 fps，中间帧 blit 缓存 |

`duck.rs:311-318` 那句是整份代码里最该记住的一条工具伦理：

> **A tool that measurably slows what it measures is a bad tool**, so motion is re-rendered at
> ~12 fps and the frames in between blit the cached pixels, which costs nothing.

**"一个能被测量出拖慢了它所测量之物的工具，是一个坏工具。"**
—— 而这个视图画的是**控制环**，跑在**同一块板子上**。

### 6.6 ⭐ 只有摄像头那一条要**被要求**才读

```rust
// monitor.rs:638-643
/// **The only reader here that has to be told to read.** The pad tap and the depth stream are
/// subscriptions: they cost the daemon at the other end nothing extra while nobody is looking, so
/// they run whether or not their block is open.
```

而摄像头不一样（`camera.rs:8-12`）：

> **It asks `mediad` for a frame rather than subscribing to one**, because `media.frame` is a
> rendezvous: the capture branch copies a 1.84 MiB buffer **only when a reader has asked for one**,
> and drops every other frame unread. So this asks twice a second while the block is open, and —
> the part that matters — **not at all while it is closed. A monitor left running all day with the
> block shut costs the camera nothing.**

**块关着的时候，摄像头一点开销都没有。**

### 6.7 ⭐ 没有机器人**也**能开

```rust
// monitor.rs:342-347
/// The live view does **not** require a robot. … the pad is worth watching on a board whose servos
/// are unpowered, whose `robotd` is stopped, or which is being bisected — **exactly the boards
/// someone reaches for this on. Refusing to open at all made the pad block reachable only where
/// it was least needed.**
```

**"恰恰是有人会掏出这个工具的那些板子。"**

而 `robot.health` 那条路**在没机器人时最重要**（`monitor.rs:389-394`）：

> a board whose servo power is off never completes a control tick, so no state ever arrives, and
> **the reason why is on this answer and nowhere else.**

### 6.8 ⚠️ 它**不**画的东西

`monitor.rs:1338-1343` 讲了"量一条手柄链路"最难的地方：

> The distinction between the last two is **the whole difficulty of measuring a pad link**, and
> getting it wrong is **not hypothetical**: counting quiet as a stall is how the first measurement
> on this robot reported **three breaches of the deadman — the longest 75 seconds — on a link that
> never faltered**. **A pad on a table sends nothing, and nothing is what a dead radio sends too.**

**"桌上的一只手柄什么都不发，而一个死掉的电台也什么都不发。"**

还有一条关于**自动缩放**的（`monitor.rs:2920-2925`）：

> Drawn to a fixed scale rather than to the tallest gap on screen: **an auto-scaled trace moves its
> own baseline as the window slides, so a link stalling every second draws exactly like a healthy
> one.**

**"一条自动缩放的曲线会随窗口滑动移动自己的基线，于是每秒卡一次的链路画出来和健康的一模一样。"**

### 6.9 按键

| 键 | 干什么 |
|---|---|
| `q` / `Esc` | 退出 |
| `↑` `↓` / `k` `j` | 关节表滚动 |
| `PageUp` / `PageDown` / `Home` | 翻页 / 回顶 |
| **`u`** | 角度在**度 ↔ 弧度**之间切换（默认度） |
| `p` / `t` / `c` / `d` | 开关 手柄 / 深度 / 摄像头 / 3D 视图 |
| `[` `]` / `←` `→` | 绕 3D 视图转视角 |

**默认是度**，但**线上的那份流永远是弧度**（`:209-211`）：

> The wire is radians and stays radians … **a script parsing that output must not have its numbers
> change under it.** This is a reading aid for the live view alone.

**"解析那份输出的脚本，它的数字不能在它底下变。"**

---

## 7. `configure`：那个编辑器

### 7.1 它解决什么问题

```rust
// configure.rs:3-5
/// The shipped `deploy/robotd.toml` is **deliberately exhaustive**: every key, documented at
/// paragraph length, all of it commented out. That is the right *reference* and **a poor *editing
/// surface*** — finding the one switch you want means scrolling four hundred lines of prose.
```

**"那是正确的参考资料，却是一个糟糕的编辑界面。"**

### 7.2 ⭐ `--list`：支持人员问的第一个问题

```rust
// configure.rs:243-246
/// **"What has been changed on this robot" is the first question support asks** … until now the
/// only way to answer it was the editor — a full-screen TUI, **over ssh, on a robot somebody is
/// already having trouble with**. The comparison was there all along; **it was just unreachable
/// without taking over the terminal.**
```

**`robotctl configure --list` 只打印这台机器人**和默认值不一样**的键。
一台没人碰过的机器人什么都不打印 —— 而那本身就是答案。**

### 7.3 ⭐ 三个"它做不到"的保证

`docs/robot/cheatsheet.md` 用操作者的语言把这三条列了出来，而它们在代码里各自有对应：

**① 它不能和 daemon 有分歧。** `configure.rs:12-15`：

> **Nothing here defines a key.** The schema, the defaults, the validation and the one-line docs
> all come from `robotd-params` — **the same crate `robotd` itself parses the file with** — and its
> registry is pinned complete by a test over `Params`'s own serialization. When a section is added
> to the daemon, **this editor learns it at compile time or the build fails; it can be wrong about
> nothing.**

那个测试（`robotd-params/src/registry.rs:535`）的手法值得一提：因为序列化 `Params::default()`
会**省略**值为 `None` 的字段，它改为去读 serde 自己的 `deny_unknown_fields` **拒绝消息**，
从中取出每个段的完整字段表 —— 然后证明注册表里的每个键都真的能解析，而且没有重复。

**② 它不能吃掉你的文件。** `robotd-params/src/edit.rs:4-6`：

> **Comments, ordering and keys from releases this build does not know all survive.**

用的是 `toml_edit` 而不是 `toml`，因为后者会**重新序列化整个文件、毁掉每一条注释**。

⚠️ **但这第一条承诺在实践中够不到** —— 见 §12。

**③ 它不能写出一个 `robotd` 拒绝启动的文件。** `edit.rs:453-457`：

> Validation goes through a real file and [`Params::load`] rather than a bare parse, because
> **`load` is what `robotd` runs at startup** — range checks included. **What this tool writes, the
> daemon starts on.**

流程：先把内容写到 `<file>.toml.new`，**用 daemon 自己的加载器验一遍**，通过了才 `rename` 就位，
然后 fsync 父目录 —— 注释说 *"A robot switched off at the wall is the normal case here, not the
exceptional one."*（**"在墙上被关掉电源，在这里是常态而不是例外。"**）

### 7.4 ⭐ 那个"哪个 daemon 要重启"的表

```rust
// configure.rs:89-93
/// **Every section is listed, and there is no fallback.** `[head_imu]` shipped reading as `robotd`
/// because a `_ => "robotd"` arm answered for it: enabling the head IMU **restarted the daemon
/// that does not read the key** and left `tofd` on the old value, **so the switch did nothing and
/// said nothing.**
```

**一个兜底分支让一个开关"什么都没做，也什么都没说"。** 现在没有兜底了，
而且有一个测试（`every_registry_key_says_how_it_applies`，`configure.rs:1220`）
**对任何一个没有对应分支的键让构建失败**。

| 哪些键 | 要做什么 |
|---|---|
| `media.*` · `duck_detector.*` | **重启 `mediad`** |
| `head_imu.*` | **重启 `tofd`** |
| `pad.*` · `pad_imu_head_control.*` | **什么都不做** —— `padd` 一秒内自己读 |
| `policy.*`（除 `mode`/`enabled`） | **reload `robotd`** —— **电机保持通电** |
| `bus` · `control` · `safety` · `audio` · … | 重启 `robotd` |

而"什么都不做"那一条本身是有理由的（`configure.rs:104-106`）：

> there is nothing to offer, and **offering a restart anyway is not free: the pad session goes with
> it, and robotd's deadman zeroes the velocity of whatever was walking.**

### 7.5 ⭐ 四个写入者共用一份文件

```rust
// robotd-params/src/edit.rs:523-529
/// **Four writers share `robotd.toml`**: `robotctl configure`, `robotctl policy`, `robotctl pad`,
/// and **`robotd` itself**, which writes it serving `robot.loadPolicy`, `robot.setSkill` and
/// `pad.bind` from a phone. Two of them staging into the same `robotd.toml.new` at the same moment
/// is a file with one writer's half of the work, renamed into place by the other.
///
/// On a lock file beside the config rather than on the config itself, **so the hold outlives the
/// rename that replaces it**.
```

而保存时的做法是（`edit.rs:459-462`）：

> **The pending edits are re-applied to the file as it is now**, under the lock, rather than to the
> copy read when this model was loaded. A model can be open for as long as somebody leaves
> `robotctl configure` on screen, and `robotd` writes the same file for `pad.bind` while they do —
> **saving the old document back would silently revert that.**

**"把一个旧文档存回去，会静默地撤销那件事。"**

### 7.6 那三个标记

```rust
// configure.rs:799-802
/// Two markers, both meaning what they look like: `*` you changed it this session and have not
/// saved; `•` this robot diverges from the default. **A key merely *written* in the file at its
/// default value gets no mark** — that distinction confused everyone it was shown to, **starting
/// with the author's own demo file**.
```

而**打字打回默认值等于"清除这个覆盖"，而不是"把默认值钉在文件里"**（`edit.rs:232-234`）：

> a file full of explicitly-written defaults **is the unreadable thing this tool exists to avoid**.

---

## 8. `update` 与 `update show`

`update` 是 `robotctl` 最初的、也是唯一被 `Cargo.toml:6` 提到的命名空间。

| 子命令 | 干什么 |
|---|---|
| `check [component]` | 有没有新版本。什么都不改 |
| `apply <component>` | 装最新版或指定版本 |
| `rollback` / `reset-to-golden` | 退回上一个 / 已知good |
| `select <component> <version>` | 启动一个**已经装好**的版本（不下载） |
| `pin` | 钉住版本，拒绝其他 |
| `status` / `log` / `show` / `watch` | 看 |

### 8.1 ⭐ `--version` 和 `--ref` 是**互斥**的，而且要说出来

```rust
// main.rs:1095-1096
// `conflicts_with` version rather than a silent precedence: **asking for both a ref and a version
// is a mistake worth reporting, not one to resolve by guessing.**
```

`--from` 和 `--staging` 也互斥，因为 *"a directory has no channels"*（`:1135-1136`）。

### 8.2 `--from` 会警告"别放在 `/tmp`

因为 `updaterd.service` 设了 `PrivateTmp=yes` —— 两个进程看到的 `/tmp` 不是同一个（`:1130-1136`）。

而 `--from` 的相对路径**在客户端就被绝对化**了（`:4544-4548`）：

> `updaterd` runs with `/` as its working directory, so **a relative path means something different
> at each end**.

### 8.3 ⭐ `update show`：一次更新运行的全文

`show.rs:3-6`：

> `update log` says an update happened and how it ended. This says **what it *did***: every phase
> with the time it took, the manifest that was verified, the hook output that was collected, the
> units that were restarted, the gate's verdict — **and then the journal for the same window**, so
> the account includes the daemons the update restarted and not only `updaterd`'s side of it.

**两个理由值得抄：**

**① 为什么全是 UTC**（`show.rs:8-11`）：

> **Times are UTC, and so is the spliced journal. Two clocks on one screen is the way to make a
> timeline unreadable**, and `journalctl --utc` makes the halves agree for free. The alternative —
> local time — would **put a timezone database in the one crate whose dependency tree is kept small
> on purpose, for the recovery path**.

**② 为什么日期是手写的**（`show.rs:321-324`）：

> Hand-written, and deliberately: **what must never be hand-rolled is a *timezone* database, and
> this does not touch one** — it is the fixed proleptic-Gregorian arithmetic (Howard Hinnant's
> `civil_from_days`), which is why the whole rendering is in UTC. Adding a date crate to `robotctl`
> for it would put **a tz database on the recovery path** to save fifteen lines of pure arithmetic
> with tests under it.

**"绝不能手搓的是时区数据库 —— 而这个不碰它。"** 这个区分很精确。

**③ 那个"缺失"的判定**（`show.rs:214-216`）：

> **Passing and being healthy are not the same fact**, and rounding one to the other is how a
> transcript ends up saying 'healthy' about a board whose own journal says 'degraded' at the same
> second.

---

## 9. 那个 3D 视图

### 9.1 它为什么存在

```rust
// robotctl/src/duck.rs:3-8
// A joints table says *how far* each servo is from its target; it cannot say what the robot looks
// like. **A leg folded the wrong way, a head pitched into the ground and a robot lying on its side
// are all just numbers there, and every one of them is obvious the moment the pose is drawn.**
```

### 9.2 那个 `.bin` 是什么

```rust
// duck.rs:10-16
// The geometry is **baked by `scripts/bake-duck-mesh.py`** from the app repository's MJCF and
// **compiled in** — `robotctl` stays a single binary with no assets directory, and **the board
// never parses CAD**. The bake decimates **~330k CAD triangles to the few thousand a terminal can
// even express**; the renderer here is a plain z-buffered rasterizer over them, **orthographic,
// flat-shaded**, drawing two pixels per cell with the half-block glyph so pixels come out square.
// **No GPU, no dependency — a frame is a few milliseconds of arithmetic on the board's own CPU.**
```

实测 `assets/duck.bin`：**68,622 字节**，magic `DUCK`，**28 个 mesh、15 个 body、58 个 part**，
2,622 个唯一顶点、5,714 个唯一三角形 —— **每帧实际光栅化 10,847 个三角形**。

```rust
// duck.rs:21-23
/// Committed rather than built, **because building it needs the app repository and numpy, and CI
/// has neither.**
```

那个烘焙脚本的一个细节值得看（`scripts/bake-duck-mesh.py:39-41`）：

> Parts that exist in the CAD but are enclosed by shells: batteries, PCBs, brackets.
> **Invisible from outside, and at this decimation level their triangles would poke through the
> shell that hides them** — dropping them is both lighter and more correct.

**"在这个简化程度下，它们的三角形会从外壳里戳出来。"**

### 9.3 渲染管线

```
烘焙的三角形 ──► 正向运动学（一次左到右遍历）
                    │  根（躯干）由 **IMU 的重力**摆姿势
                    │  其余各 body 继承父节点 + 自己的静止偏移 + 关节角
                    ▼
               每个顶点转一次世界坐标
                    │  （同时找出最低点，把机器人"站"在 z=0 上）
                    ▼
               正交投影（azimuth 可转，elevation 固定 0.32 rad）
                    ▼
               z-buffer + 平面着色（双面）
                    ▼
               半格像素 blit
```

**为什么是正交而不是透视**（`duck.rs:495-496`）：

> **at 100 pixels, perspective is affectation.**

**"在 100 个像素上，透视是装腔作势。"**

**为什么是双面光照**（`duck.rs:530-531`）：

> **Two-sided: decimation does not guarantee winding, and a hole where a triangle flipped is worse
> than the lighting being symmetric.**

### 9.4 它不画偏航

躯干由 `state.safety.gravity` 摆姿势，**不是** `state.imu.quat` —— 因为
**重力观察不到偏航**（`duck.rs:285-287`）。所以"机器人朝向哪里"是由相机的方位角决定的。

**它也是 `odometry` 那个"没有磁力计"的同一个事实** —— 见 [`odometry-primer.md`](odometry-primer.md)。

### 9.5 那两个面板用**不同的**像素密度

| 面板 | 用什么 | 一格几个像素 |
|---|---|---|
| 3D 视图 · 摄像头 · 手柄线框 | **半格** `▀`/`▄` | 2（上下） |
| **里程计地图** | **盲文** | **2×4 = 8** |

`cells.rs:3-9` 解释了半格，还点出了那个**容易搞错**的地方：

> where only one pixel of a pair is lit, **the other must stay the terminal's own background rather
> than being painted black**, so a drawing sits on whatever theme is running.

而盲文（`path_map.rs:4-7`）：

> Drawn in braille (2×4 dots per cell), **which is the finest resolution a terminal offers for a
> line that curves.**

**"对一条会拐弯的线来说，这是终端能给的最细分辨率。"**

---

## 10. ⭐ 为什么依赖表这么短

`Cargo.toml:12-15` 是整份 manifest 的核心：

> Depends on `duck-ipc-proto` alone, not on `updater`. **That was the point of extracting the
> protocol**: a support tool **on the recovery path** should not link the update engine's
> http/tar/zstd/crypto tree, and **structurally cannot now reach into engine internals** instead of
> going through the socket.

**"结构性上再也不可能伸手进引擎内部，而不走 socket。"**

这条规则被**逐条应用**到后来每一个依赖上：

| 依赖 | 为什么**不**用那个更自然的 |
|---|---|
| `kinematics` | *"deliberately NOT the `tof` crate, whose vendored C driver would drag **a cross C toolchain into every robotctl build**"*（`:27-29`） |
| `uyvy` | *"Deliberately NOT `duck-detect` itself … that crate **carries the NPU and ONNX runtimes**, and this one has no dependencies at all"*（`:30-33`） |
| `robotd-params` | *"what makes **the editor unable to disagree with the daemon**"*（`:35-38`），且是纯 serde + toml |
| `ratatui` | *"**Terminal only — no http, no crypto, no async runtime**"*（`:43-46`） |
| `toml_edit` | 因为 `toml` 会**毁掉每一条注释** |
| `clap_complete` | *"nothing on the recovery path depends on it"*（`:20-23`） |

而这一条在别处被反复重申：

```rust
// main.rs:2401-2403
/// `updaterd`'s, for `policy.*`'s reason: it is the daemon with a network stack, and **this binary
/// deliberately does not link one — it is on the recovery path.**
```

```rust
// main.rs:4583-4585
// Pure codegen: no socket, no daemon, no root. **It must keep working on a robot where nothing is
// running, since that is where an operator most wants to type less.**
```

**验证一下它守住了**：`Cargo.toml` 的依赖表里**没有** `updater`、`duck-detect`、`tof`、
`reqwest`、`tokio`。✓

---

## 11. 测试：185 个

```bash
cargo test -p robotctl
```

| 文件 | 测试 | 都在测什么 |
|---|---|---|
| `main.rs` | **83** | CLI 定义、socket 提示、`health` 渲染、`status` 判决、`version` 警告引擎 |
| `monitor.rs` | **58** | 几乎全是**渲染出来的屏幕文本**的断言 |
| `configure.rs` | 13 | 哪个 daemon 重启、搜索排序、首屏渲染 |
| `show.rs` | 10 | 时间线渲染、journal 拼接线、判决措辞 |
| `duck.rs` | 6 | blob 能解析、站着能画、缩放迟滞、标记 |
| `path_map.rs` | 6 | 站着是一个点、前进朝上、长走会变稀 |
| `camera.rs` | 4 | 图片装得下、保持形状、采样不填充 |
| `frame.rs` | 3 | 只保存完整的帧 |
| `imu_view.rs` | 2 | 画出来且跟着姿态动 |
| `cells.rs` | 0 | —— |

### 11.1 ⭐ `monitor` 的测试是**渲染出来再断言文字**

`render_to`（`monitor.rs:3617`）把界面画进一个 `TestBackend`，再把缓冲区拍平成字符串，
所以大多数断言长这样：`assert!(screen.contains("..."))`。

而 `configure` 那边的理由写得最清楚（`configure.rs:1236-1237`）：

> **Rendered rather than asserted on the `Plan`, because what went wrong on the board was what the
> screen *said*.**

**"在板子上出错的，是屏幕'说'了什么。"**

### 11.2 那些"没有机器人也能测"的

`health` 的渲染是一个**纯函数**（`render_health`，`main.rs:1578`）：

> **Pure, so the cases that matter are testable without a robot — and the cases that matter are the
> missing ones, which a live test on a working robot never produces.**

**"而真正要紧的那些用例是'缺失'的用例 —— 那是一个在正常机器人上跑的实测永远产生不出来的。"**

### 11.3 那些 `#[ignore]` 是给人看的工具

| 测试 | 文件 | 干什么 |
|---|---|---|
| `dump_the_listing` | `main.rs:5017` | 用眼睛看那份列表 |
| `show_the_pad_block` | `monitor.rs:4710` | 打印手柄块 |
| `show_me_the_pad` | `imu_view.rs:283` | 打印四种姿态下的线框 |
| `show_me_a_loop_walk` | `path_map.rs:281` | 打印走一圈的地图 |
| `time_the_map` | `path_map.rs:259` | 性能探针 |
| `dump_for_eyeballs` | `duck.rs:809` | 把 3D 画面写成 PPM |

`dump_for_eyeballs` 除非设了 `DUCK_DUMP` 环境变量否则什么都不做 —— 它有几个旋钮
（`DUCK_AZ`、`DUCK_JOINTS`、`DUCK_MARKERS=demo`）。

---

## 12. 几处读者会绊到的地方

按仓库的规矩，代码与文档不一致的地方，这里只**陈述事实**，不判断该怎么办。

### 12.1 ⭐ 3D 视图**没有用**那条为它而设的 skeleton 路由

协议 v25 加了一条路由（`duck-ipc-proto/src/lib.rs:296-303`）：

> # v25 — the whole skeleton's pose, **for a viewer**
>
> [`RobotState::skeleton`] carries every body's pose in the trunk frame this tick, and
> [`ModelResult::skeleton`] the matching static tree. Together they let **a viewer draw the robot
> moving for real — the full kinematics** … **without carrying a copy of the kinematics**, the same
> reason `frames` and `tof_beams` come from the robot.

**而这条路由存在的理由，逐字就是 `robotctl` 那个 3D 视图在做的事。**

实际上：

```
robotctl 里出现 "skeleton" 的地方：只有一处
    robotctl/src/monitor.rs:4847           skeleton: Vec::new(),      ← 是个测试夹具

全仓库消费 .skeleton 的地方：只有一处
    robotd/src/main.rs:4859                ← 是**提供**它的那一侧，不是消费者
```

`duck.rs` 用的是**它自己烘焙在 `duck.bin` 里的那棵树**（15 个 body + 自己的正向运动学）。

时间上说得通，**视图比路由早**：

```
370d86f  2026-08-19  robotctl monitor draws the robot: the sim model, live, in terminal cells
9da3905  2026-09-07  proto+robotd: serve the whole skeleton's pose per tick (v26)
```

所以这个视图**不可能**用过那条路由。两份骨架共享的是**来源**（同一份 alpha MJCF），不是数据通路。
而且视图那份为了终端做了简化、还带着渲染数据（三角形、颜色、实例化），
是线上格式不适合装的 —— 但**正向运动学那段算术确实是重复的**。

### 12.2 ⭐ 编辑器比 daemon **更严**，于是那条承诺够不到

`configure` 的 `--help` 承诺（`main.rs:200-201`）：

> **Comments and anything this build does not know survive untouched**, and nothing is written that
> robotd's own validation would reject.

而打开一个文件的路径是：

```
configure / configure --list
   → Model::load        (robotd-params/src/edit.rs:99)
   → Model::from_text   (edit.rs:112)
   → toml::from_str::<Params>(text)      ← **严格解析**
```

`Params` 是 `#[serde(deny_unknown_fields, default)]`（`robotd-params/src/lib.rs:64`）。

而 **`robotd` 自己启动时走的是另一条路** —— `Params::load`（`lib.rs:1953-1978`）：
**先严格试一次，失败了再走一条宽松的路**，把不认识的键剪掉并 `warn`。
那条宽松路径是有意加的，理由写在 `lib.rs:2019-2031`：一块板子因为一个别的发布留下的
`[chorale]` 段而**连续回滚了四次**，白白搭进去一次台架时间。

**结果是**：一份带着别版本遗留键的 `robotd.toml`

- **`robotd` 正常启动**，只在 journal 里警告一句；
- **`robotctl configure` 打不开它**；
- **`robotctl configure --list` 也报错** —— 而 `--list` 正是 `configure.rs:243` 说的
  *"支持人员问的第一个问题"*。

于是 `--help` 承诺的后半句（"不认识的键原样保留"）在实践中**到达不了**：
这样一份文件根本进不到"编辑"那一步。
（write 那一半是真的做到了 —— writer 只碰注册表里的键。）

### 12.3 ⚠️ 六处被"合并事故"切断的文档注释

同一个形状，我在这份导读的各个 crate 里一共找到了**六处**：

| 位置 | 症状 |
|---|---|
| `robotd/src/intents.rs:468-490` | `request_reboot_motors` 插进了 `request_relax` 的注释中间 |
| `mediad/src/session.rs:625-630` | `media.video` 的注释粘在了 `media.stream` 的测试上 |
| `mediad/src/route.rs:465-467` | 拼出 *"…`mediad` will hold **A peer watching the video**…"* |
| **`robotctl/src/main.rs:1982-2009`** | **三段注释合并到了 `render_units` 上** |
| **`robotctl/src/monitor.rs:3096-3113`** | **`brief` 的注释挂在了 `explain_limit` 上** |
| **`robotctl/src/configure.rs:1344-1350`** | **一句话断在 "Restarting the"，下一行接了另一段** |

`main.rs` 那一处最严重：`version_warnings`（`:2173`）和 `is_behind`（`:2144`）——
两个函数**一句文档都没有**，而 `render_units`（`:2010`）扛着三段互不相干的说明。
其中 `is_behind` 那段讲的是"dev 构建要按 revision 比而不是按 version 比"，
内容很好，但它渲染在错误的函数下面。

`configure.rs:1381` 那一处的孤儿尾巴单独一行：

```rust
    /// wrong daemon is how somebody edits a value three times and swears it does nothing.
    #[test]
    fn the_section_decides_which_daemon_restarts() {
```

### 12.4 `Cargo.toml` 的 description 和两处模块文档都过期了

```toml
# robotctl/Cargo.toml:6
description = "Local CLI for the robot — currently the `update` namespace only"
```

```rust
// main.rs:13-15
//! Scope: **only the `update` namespace is implemented.** The `robotctl` name is
//! kept for the eventual general-purpose robot CLI …
//! Only `update` exists today, plus `version`. The namespace layer is here so adding
//! `robotctl motors` later is additive rather than a restructure.
```

**实际有 17 个顶层命名空间。** 三处说法要一起改。
（`Cargo.toml:8-9` 的前半句 *"its role is broader: it will front `robotd` and other services
too"* 倒是**已经实现了**。）

### 12.5 `--robot-socket` 没有用共享常量

```rust
// main.rs:88
#[arg(long, global = true, default_value = "/run/robotd.sock")]   // ← 字面量
```

而**其他每一个** socket 旗标都用 proto 的常量（`:83`、`:96`、`:103`、`:110`、`:114`），
且 proto 里**有**那个常量：

```rust
// duck-ipc-proto/src/lib.rs:440
pub const ROBOT: &str = "/run/robotd.sock";
```

那个 proto 模块自己的文档解释了这些常量为什么存在（`duck-ipc-proto/src/lib.rs:431-436`）：

> because **more than one client needs them**: `robotctl` and `btd` both connect to all three, and
> **a path duplicated per client is a path that drifts per client.**

所以这里是一个**活的漂移风险**，不只是风格问题。

### 12.6 `update check` 的 help 和代码说的不是一回事

```rust
// main.rs:1074-1075
Check {
    /// Component to check; **omit for all**.
    component: Option<String>,
```

```rust
// main.rs:4657
proto::Call::Check(component(name.as_deref().unwrap_or("daemon")))
```

**省略时实际检查的是 `"daemon"`，不是"全部"。**

### 12.7 三处 `--json` 会**静默地**失败

| 位置 | 序列化失败时 |
|---|---|
| `main.rs:1558`（`health --json`） | 打印 `{}`，退出码 0 |
| `main.rs:1809`（`version --json`） | 打印**一个空行**，退出码 0 |
| `main.rs:4887`（`compact`） | 返回空串 |

在一个自己声称"退出码是有意义的"（`main.rs:53`）的文件里，
这是**机器可读输出可以既空又成功**的地方。

### 12.8 一个"什么都没改"的编辑也会提议重启

在 `configure` 里对一个**本来就在默认值**的键按 `u`/`d`，会无条件排入一个清除操作
（`configure.rs:443-447` 没有检查这个键是否真的被覆盖过）。
确认屏把它算作一次改动，`Model::save` 也会无条件把它记进 `written`（`edit.rs:477-482`）——
`save` 没有"这会不会改变什么"的比较，而 `set_slots`（`edit.rs:683-686`）是有的。

于是退出流程会为一个**磁盘上什么都没变**的编辑提议 `sudo systemctl restart robotd`。

### 12.9 `d` 是一个没有写出来的按键

`u` 和 `d` 是同一个分支（`configure.rs:443`），但页脚只列了 `u`（`:904`）。

### 12.10 那个"机器人先重启"的顺序有两套理由

```rust
// configure.rs:180-181
// `mediad.service` is `After=robotd.service`: restarting in the other order means mediad
// reconnects to a robotd that is about to go away
```

而测试里的理由是（`configure.rs:1391-1394`）：

```
// the order they are least disruptive to restart: the control loop first, then the camera —
// a robot that is standing up should not be waiting on a WebRTC teardown.
```

两套理由**不能同时是承重的那一套**。

### 12.11 几处小的

| 位置 | 什么 |
|---|---|
| `duck.rs:170` | 硬编码 `b.joint < 15`，而同一个文件的文档指向 `JOINT_NAMES` 作为契约 |
| `duck.rs:685-687` | `pose_key` 会哈希**全部 15 个关节**，包括视图从来不画的嘴 —— 于是张嘴会让光栅缓存失效 |
| `duck.rs:251-263` | `axis_pose` 在轴退化为零向量时返回 `cos(θ)·I`（一个**缩放**，不是恒等）。提交的 blob 到不了这里，但它在一句"渲染循环不可能越界"的注释后面 |
| `monitor.rs:586` | `read_tof` 复用了 `PAD_RETRY`（`:151`）这个手柄命名的时间常数 |
| `path_map.rs:4` | 模块文档说面板"尺寸永远不变"，但终端太矮时它会**整个消失**（不是缩小）—— 那个推论只写在 `monitor.rs:1770` |
| `show.rs:277-279` | 那个 unit 列表"取自这次运行本身而不是一个硬编码列表"，很好 —— 但 `id = 999` 是 `watch` 里写死的（`main.rs:4711`） |

---

## 13. 阅读路线

**15,929 行不可能一次读完。** 按这个顺序，每次读一段：

| 步 | 读什么 | 为什么先读它 |
|---|---|---|
| 0 | [`robot/cheatsheet.md`](robot/cheatsheet.md) | **命令的操作者视角**，而且是从 `--help` 抄的 |
| 1 | `robotctl/Cargo.toml`（1-15 行） | 依赖规则，整份 crate 的性格都在这 |
| 2 | `robotctl/src/main.rs:1-70` | 模块文档 + 五条设计规则 + 退出码 |
| 3 | `robotctl/src/main.rs:124-362` | 那 17 个命名空间 —— **对着 §4 读** |
| 4 | `robotctl/src/main.rs:1218-1290` | `unreachable_hint` + `Client` —— 薄客户端的核心 |
| 5 | `robotctl/src/main.rs:1513-1600` | `run_health` + `render_health` |
| 6 | `robotctl/src/monitor.rs:1-200` | 常数和它们的理由（**§6.4/6.5 就是这里**） |
| 7 | `robotctl/src/monitor.rs:640-700` 起 | 四个 reader 线程的模板 |
| 8 | `robotctl/src/configure.rs:1-130` | `Apply` 那张表和它的理由 |
| 9 | `robotctl/src/duck.rs:1-30` | 那个烘焙模型是怎么来的 |
| 10 | `robotctl/src/show.rs:1-60` | UTC、手写日期、拼接 |

**如果只有十分钟**：读 §2（它跑在哪）、§5（退出码），然后读 `main.rs:53-71`。

三条贯穿全文的主线：

1. **薄。** 它自己不做决定 —— 决定在 daemon 里。而依赖表短到可以在脑子里过一遍，
   因为**它是恢复路径上的工具**。
2. **不许静默。** 每个退出码都要能和另一个区分开（"正确拒绝" vs "东西坏了"，
   "你不许" vs "你不能"）；缺失的服务永远变成一句**话**，不是一块空白；
   表头永远直说它截断了什么。
3. **不许悄悄变慢。** 3D 视图画的是控制环，跑在同一个 CPU 上 ——
   所以有 12 fps 的光栅、80 ms 的缓存、500 ms 的摄像头、33 ms 的 IMU 重画。
   **"一个能被测量出拖慢了它所测量之物的工具，是一个坏工具。"**

---

## 14. 术语表

| 词 | 意思 |
|---|---|
| **`robotctl`** | **这台**工具。跑在机器人上，走 Unix socket |
| **`duckctl`** | 另一个工具。跑在笔记本上，走蓝牙。**一个发布都不含它** |
| **薄客户端（thin client）** | 只转发请求和回答，不含业务逻辑 |
| **JSON-RPC** | 它说的那门语言。见 [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| **通知 vs 回答** | 通知没有 `id`、不等回复（走 stderr）；回答有 `id`（走 stdout） |
| **退出码** | 进程的返回值。**这里有七个，每一个都有自己的意思** |
| **`REFUSED` vs `DENIED`** | "你不能" vs "你不许"。一个换命令，一个换身份 |
| **`BUSY`** | 唯一一个"重试就好"的码 |
| **skew（版本偏差）** | 在跑的版本和装着的版本不一致。**只警告不拒绝** |
| **ratatui** | 终端 UI 库。`monitor` 和 `configure` 用它 |
| **crossterm** | ratatui 的后端。交叉平台的终端控制 |
| **半格 `▀`/`▄`** | 一个字符格放两个像素（上下）。**一格大约两倍高** |
| **盲文（braille）** | 一个字符格放 2×4=8 个点。**画曲线最细** |
| **sparkline** | 一行高的小折线图 |
| **正交投影** | 没有近大远小。**"在 100 像素上，透视是装腔作势"** |
| **z-buffer** | 每个像素记一个深度，用来决定谁挡住谁 |
| **正向运动学（FK）** | 给关节角，算各部位在哪。见 [`kinematics-primer.md`](kinematics-primer.md) |
| **烘焙（bake）** | 离线把数据算好、存成文件、编译进二进制 |
| **顶点聚类（vertex clustering）** | 一种简化网格的办法：把附近的顶点合成一个 |
| **`toml_edit`** | 保留注释和排版的 TOML 编辑器。`toml` 会毁掉它们 |
| **原子写** | 先写临时文件、再 `rename` 就位。中途断电不会留下半个文件 |
| **flock** | 文件锁。四个写入者共用一个 `robotd.toml` |
| **`deny_unknown_fields`** | serde 的严格模式：不认识的字**报错**而不是忽略 |
| **preflight** | 更新前的检查。失败就是 `REFUSED` |
| **revision vs version** | dev 构建要按 commit 比，因为 `CARGO_PKG_VERSION` 不带 dev 后缀 |
| **`civil_from_days`** | Howard Hinnant 的日期算法。**手写，因为"绝不能手搓的是时区数据库"** |
| **`#[ignore]`** | 默认不跑的测试。**这里的几个是给人看的工具，不是断言** |
| **`TestBackend`** | ratatui 的假终端，测试用它渲染再断言文字 |
| **`--json`** | 机器可读输出。**`monitor` 的那一份被刻意冻结了** |
| **deadman（死手）** | intent 不再到达就把速度归零。见 [`duck-control-primer.md`](duck-control-primer.md) |
| **回滚（rollback）** | 退回上一个发布。见 [`hooks-primer.md`](hooks-primer.md) |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| **每一个命令**（操作者视角） | [`robot/cheatsheet.md`](robot/cheatsheet.md) |
| 需要开发板的那些命令 | [`robot/cheatsheet-dev.md`](robot/cheatsheet-dev.md) |
| 笔记本上那个客户端（姊妹篇） | [`duckctl-primer.md`](duckctl-primer.md) |
| `configure` 编辑的那份 schema（姊妹篇） | [`robotd-params-primer.md`](robotd-params-primer.md) |
| 它说的那门语言（姊妹篇） | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| 它监控的那个控制环（姊妹篇） | [`robotd-primer.md`](robotd-primer.md) · [`duck-control-primer.md`](duck-control-primer.md) |
| 3D 视图用的那套关节几何（姊妹篇） | [`kinematics-primer.md`](kinematics-primer.md) |
| 那张地图画的是什么（姊妹篇） | [`odometry-primer.md`](odometry-primer.md) |
| 手柄那一块的数据源（姊妹篇） | [`padd-primer.md`](padd-primer.md) · [`pad-imu-primer.md`](pad-imu-primer.md) |
| 摄像头那一块的数据源（姊妹篇） | [`mediad-primer.md`](mediad-primer.md) |
| 深度矩阵那一块 | [`duck-detect-primer.md`](duck-detect-primer.md) |
| 更新与发布的设计 | [`design/updater-design.md`](design/updater-design.md) |
| 发布怎么把自己装到板子上（姊妹篇） | [`hooks-primer.md`](hooks-primer.md) |
| 板子被配置成什么样子（姊妹篇） | [`deploy-primer.md`](deploy-primer.md) |
| BLE 的线上契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| 蓝牙门房（姊妹篇） | [`btd-primer.md`](btd-primer.md) |
| wifi、身份、手柄配对（姊妹篇） | [`configd-primer.md`](configd-primer.md) |
| 仿真的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| 那个听麦克风的分类器（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| 装机、更新、诊断的那些工具（姊妹篇） | [`scripts-primer.md`](scripts-primer.md) |
| 鸭子的嗓子：可播种的合成器（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 头部的两个传感器：深度与 IMU（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
