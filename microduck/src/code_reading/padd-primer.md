# `padd` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> 手柄驱动这件事的操作者视角由 [`robot/pair-a-gamepad.md`](robot/pair-a-gamepad.md) 拥有；
> `[pad]` / `[pad_imu_head_control]` 的 schema 归 [`robotd-params-primer.md`](robotd-params-primer.md)；
> 它发出去的那些 intent 归 [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) 和
> [`robotd-primer.md`](robotd-primer.md)。若本导读与代码不一致，以代码为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：[`pad-imu-primer.md`](pad-imu-primer.md)（手柄那个 IMU 的姿态怎么算出来的）、
> [`duck-control-primer.md`](duck-control-primer.md)（intent 到了 robotd 之后变成什么）。

## 目录

1. [一分钟版](#1-一分钟版)
2. [它在整个系统里的位置](#2-它在整个系统里的位置)
3. [⭐ 核心心智模型：一个没有任何特权的 API 客户](#3--核心心智模型一个没有任何特权的-api-客户)
4. [那张按键表](#4-那张按键表)
5. [目录导览](#5-目录导览)
6. [一个 tick 里发生什么](#6-一个-tick-里发生什么)
7. [⭐ `Select`：一个按钮，两件事，靠"松开"分辨](#7--select一个按钮两件事靠松开分辨)
8. [⭐ `Continuous`：按住不动就不发](#8--continuous按住不动就不发)
9. [三种模式](#9-三种模式)
10. [配置是活的](#10-配置是活的)
11. [手柄的 IMU 控头](#11-手柄的-imu-控头)
12. [⭐ 那个 raw tap：为什么它长出了一个 socket](#12--那个-raw-tap为什么它长出了一个-socket)
13. [测试：23 个](#13-测试23-个)
14. [几处读者会绊到的地方](#14-几处读者会绊到的地方)
15. [阅读路线](#15-阅读路线)
16. [术语表](#16-术语表)

---

## 1. 一分钟版

`padd` 回答一个问题：

> **我按了这个手柄，机器人该做什么？**

它把手柄的摇杆和按键翻译成 **intent**，通过 `robotd` 的 socket 发过去 ——
**和任何一个客户端走的是同一条路。**

一句话说清它的定位（`main.rs:3-5`）：

> It has **no privileged access to the robot**. It reads a pad, turns sticks and buttons into
> intents, and sends them over `robotd`'s socket **like any other client**.

规模：**2,826 行**（`main.rs` 1463 + `tap.rs` 1315），加一个 systemd 单元。

---

## 2. 它在整个系统里的位置

```
      手柄（蓝牙 / USB）
            │
   ┌────────┴─────────┐
   │                  │
   ▼                  ▼
 gilrs              evdev          ← 同一颗节点，读两遍
 （解析按键/摇杆）    （原始事件流）
   │                  │
   │                  └──► raw tap（/run/padd/pad.sock）
   │                          └──► robotctl monitor 的「pad」面板
   ▼
 padd 的主循环
   │  按键 → skill 名 / 模式切换 / 停止
   │  摇杆 → 速度、头部角度、身体姿势
   ▼
 /run/robotd.sock ──► robotd 的 intents ──► 控制环 ──► 舵机
```

两个消费者/关联方：

| 谁 | 关系 |
|---|---|
| **`robotd`** | intent 的收件人。`padd` 是它**最老也最苛刻的客户** |
| **`robotctl monitor`** | 订阅 raw tap，画手柄面板和线框手柄 |
| **`configd`** | 手柄**配对**归它（需要 root 和 BlueZ），`padd` 不做 |
| **`pad-imu`** | 手柄 IMU 的姿态滤波器，`padd` 用它控头 |

> 💡 配对为什么不在这里（`main.rs:63-65`）：
> bonding a device needs root and BlueZ, and **a `padd` holding either would stop being the
> unprivileged client whose whole value is having no special access.** It lives in `configd`,
> next to wifi.

---

## 3. ⭐ 核心心智模型：一个没有任何特权的 API 客户

这是读懂 `padd` 最重要的一件事，而它**不是一个技术决定，是一个产品决定**。

### 3.1 为什么它是一个独立进程

`main.rs:8-12`：

> **That is the point of it being a separate process rather than a thread inside `robotd`.** The
> intent API is the path the app, the SDK and any remote client will use, and here **it gets
> exercised every day by whoever is working on the robot — so it cannot quietly rot the way an API
> only the phone app uses inevitably would.** The cost is a socket hop: **tens of microseconds
> against a 20 ms tick.**

这段话值得慢慢读。**"只有手机 app 用的 API 一定会烂掉。"**
而手柄是每天有人在用的东西 —— 所以让它走和 app 一模一样的那条路，
这条 API 就永远有人替你验证。

代价是"一次 socket 往返"：几十微秒，对比 20 ms 的控制周期。

### 3.2 它**不**做的事

| 不做 | 为什么 |
|---|---|
| **配对** | 需要 root 和 BlueZ（`main.rs:63-65`） |
| **知道一个 skill 是什么** | 它只读"哪个按钮按下去了"，查出旁边的名字，发出去 |
| **判断 skill 存不存在** | 那是机器人的事，而它答"没有这个"时会带上自己有的列表 |

`main.rs:31-35`：

> This daemon **still knows nothing about what a skill *is***. It reads which button went down,
> looks up the name beside it, and sends that name; **`robotd` decides whether the robot has such a
> thing and answers with the list it does have when it does not.**

**"它读哪个按钮按下去了，查旁边的名字，把名字发出去。"** 就这么多。

### 3.3 为什么 `padd` 是独立 crate

`Cargo.toml:8-9`：

> Its own crate so a gamepad stack stays out of `robotctl`, **which has to work on a broken robot
> and is part of the recovery path**. **Nothing here is on that path.**

**`robotctl` 必须在机器人坏掉的时候还能用，而它是恢复路径的一部分。**
所以手柄这一堆东西（还有它的 C 依赖）不能进去。

### 3.4 一个被记账的代价

`Cargo.toml:11-18`：

> `gilrs` depends on `libudev-sys` **unconditionally on Linux — no feature disables it** — so both
> CI and the board cross-build install libudev. **That is a real cost, paid to keep gilrs's SDL
> controller database**: without it we would hand-map each pad's raw evdev codes, and **the same
> Xbox controller reports different codes over USB and Bluetooth.**
>
> The same expense returns for the next C dependency that has to reach the board, which is **an
> argument for preferring pure-Rust crates anywhere else on that path**.

**"同一个 Xbox 手柄插 USB 和走蓝牙报的是不同的码。"** 这就是为什么值得为它引一个 C 依赖。
而 `evdev`（raw tap 用的那个）是纯 Rust 的 —— 同一个设备节点，不带来任何 C。

---

## 4. 那张按键表

`main.rs:37-46` 的模块文档就是这张表，抄在这里：

```text
Start        切换策略（policy）开关
Y (North)    头部模式 —— 摇杆摆头
B (East)     身体姿态模式 —— 摇杆让站着的机器人倾斜、下蹲
A (South)    地面拾取
LB / RB      左踢 / 右踢
DPad-Down    坐下 ↔ 站起
RT / LT      嘴（哪个扳机大听哪个）· RT 叫一声 · LT 骑 wheee
Select       松开时断电（torque off）—— 急停
Select 按住 2 秒   坐下、断电、然后关机 —— 之后的松开什么都不做
```

### 4.1 只有五个是可以改的

`main.rs:27-30`：

> The five one-shot buttons are `[pad]` in `robotd.toml` — so **a robot that has learned a new skill
> can put it on a button without a release**. The defaults are exactly the mapping below, so a robot
> with no `[pad]` section behaves as it always has.
>
> **Only those five.** `Start`, the two mode toggles, held `Select` and held D-pad up are not
> `robot.do` calls, and **the button that powers a robot off is the one binding worth not being able
> to lose to a config edit.**

**"那个关机的按钮，是唯一一个值得保证不会被一次配置编辑弄丢的绑定。"**

可绑定的五个（`robotd-params` 的 `PadParams`）：`a` · `x` · `lb` · `rb` · `dpad_down`，
默认分别是 `ground_pick` · `roulade` · `kick_left` · `kick_right` · `sit_toggle`。

### 4.2 ⚠️ gilrs 的扳机命名是个坑

```rust
// padd/src/main.rs:529-536（节选）
// gilrs names the *bumpers* `LeftTrigger`/`RightTrigger`; the analog
// triggers are `LeftTrigger2`/`RightTrigger2`. Getting that backwards binds
// a skill to a control nobody presses.
Button::LeftTrigger => pressed.push("lb"),
Button::RightTrigger => pressed.push("rb"),
```

**`LeftTrigger` 是肩键（LB），`LeftTrigger2` 才是模拟扳机（LT）。**
搞反了就是"把一个技能绑到一个没人按的控件上"。

同一个坑在 `robotd-params` 的 `PadParams` 注释里也写了一遍 —— 说明它咬过人。

### 4.3 方向键的两个特殊用途

| 键 | 干什么 | 为什么在这个键上 |
|---|---|---|
| **D-pad 右** | `robot.rebootMotors` —— 伺服原地重启 | "the way back from a tripped overload **without pulling the battery**"（`main.rs:541-542`） |
| **D-pad 上（按住 3 秒）** | 切换驱动模式：走 ⇄ 轮 | 见下 |

```rust
// main.rs:259-264
/// D-pad up held this long switches drive mode, walk ⇄ roller.
///
/// Three seconds, longer than the shutdown hold, and the prototype's number. **D-pad up is a
/// direction anybody might lean on for a moment while driving**; the mode switch takes the robot
/// home and reloads its policies, so **it has to be a hold nobody performs by accident.**
```

**"D-pad 上是任何人开车时都可能顺手按住一下的方向键。"** 所以三秒 —— 比关机还长。

---

## 5. 目录导览

```
padd/
├── Cargo.toml              48 行 —— 头 18 行讲清 gilrs 那个 C 依赖值不值
├── src/
│   ├── main.rs           1463 行  主循环、按键映射、模式、Select、Continuous
│   └── tap.rs            1315 行  原始事件流那个 socket（**只有 Linux**）
└── systemd/
    ├── padd.service      105 行  注释比指令多
    └── sysusers.d/padd.conf
```

### `tap.rs` 在非 Linux 上是一个空壳

```rust
// padd/src/main.rs:95-101
/// The raw tap, on a platform with no evdev to read.
///
/// A `padd` on a Mac **still drives a pad** — that is the bench setup in the crate docs above, and
/// **it would be a poor trade to lose it over a debug facility.** It serves no tap, and `robotctl
/// monitor` finds no socket **and says so, which is the truth rather than an empty stream**.
#[cfg(not(target_os = "linux"))]
mod tap { /* 每个方法都是空实现 */ }
```

**一台 Mac 上的 `padd` 照样能开车，只是不提供 tap。** 而且 monitor 找不到 socket 时**会说出来** ——
"那是事实，而不是一条空流"。

---

## 6. 一个 tick 里发生什么

主循环（`main.rs:481-969`）默认 **50 Hz**。按顺序：

| # | 干什么 | 行 |
|---|---|---|
| 1 | **每秒一次**看看配置文件改没改 | `:487-495` |
| 2 | **排空 gilrs 的事件队列**，抓按键**边沿** | `:503-546` |
| 3 | 没有手柄？**什么都不发**，睡 500 ms | `:551-575` |
| 4 | 告诉 tap 在看哪个手柄、IMU 要不要开 | `:585-590` |
| 5 | 取手柄的姿态（如果开了） | `:594-604` |
| 6 | **Y / B / Start** 三个模式相关的按键 | `:606-696` |
| 7 | **五个可绑定按钮** → `robot.do` | `:704-718` |
| 8 | **X 按住** → 重复发（让技能接续） | `:729-741` |
| 9 | **Select**：松开停 / 按住关 | `:746-768` |
| 10 | **D-pad 右** → 重启伺服 | `:770-782` |
| 11 | **D-pad 上按住 3 秒** → 换模式 | `:788-825` |
| 12 | 读摇杆、扳机 | `:827-841` |
| 13 | **嘴 + 声音边沿**（RT 叫 / LT wheee） | `:842-881` |
| 14 | **组这一帧的连续 intent** | `:886-959` |
| 15 | **发出去**（可能被抑制） | `:961-964` |
| 16 | 睡到周期末尾 | `:966-968` |

### 6.1 ⚠️ 只理第一个手柄的事件

```rust
// main.rs:500-503
// The driving pad is the first one, and only its events may act: with two pads
// connected, a Start or Select from the *other* one would otherwise steer a robot
// whose sticks belong to somebody else.
let pad_id = gilrs.gamepads().next().map(|(id, _)| id);
```

**"否则另一个手柄上的 Start 或 Select 会去操纵一台摇杆属于别人的机器人。"**

而且排空之后要**按 id 重新取**（`:548-551`）：

> a `Disconnected` dequeued above may have taken it, and asking for the first pad again would
> **silently hand the robot the *other* pad's sticks**.

**"一 tick 的'手柄没了'好过那个。"**

### 6.2 没有手柄时**什么都不发**

```rust
// main.rs:552-554
// No pad. Send nothing: `robotd`'s deadman stops the robot on its own, which is
// exactly the wanted behaviour, and inventing a zero command here would mask a
// disconnected pad as a deliberate stop.
```

**"在这里造一个零命令，会把'手柄掉了'伪装成'有人决定停下'。"**

这是整份代码里最该记住的一句安全设计。`robotd` 那边有个**死手开关**（deadman，
`duck-control/src/safety.rs:74`，默认 500 ms）：intent 不再到达，速度就归零。
`padd` 只要**闭嘴**，机器人就会停 —— 而"闭嘴"和"发零"是两件不同的事。

### 6.3 断线时要把"按到一半"的按住清掉

```rust
// main.rs:563-568
// A hold in flight was measured against the pad that just left: drop it, or a
// Select (or D-pad up) still down when the pad returns lands its full hold time
// at once — a shutdown or a mode switch nobody asked for.
select.reset();
dpad_up_held_since = None;
mode_switch_sent = false;
imu_head = PadImuHead::Off;
```

**"否则手柄回来时那个还按着的 Select 会一次性兑现它的整个按住时长 ——
一次没人要求的关机或模式切换。"**

### 6.4 一帧一写

连续 intent 是**攒成一帧**再写的（`:886`、`:1014-1038`）：

> One write for the whole frame: the calls describe a single instant, and **a peer that read half of
> one would be acting on a head pose without the velocity that came with it.**

**"读到半帧的对端，会拿着一个头部姿态却不知道配套的速度。"**
`robotd` 那边自己再把缓冲区切成行。

---

## 7. ⭐ `Select`：一个按钮，两件事，靠"松开"分辨

这是整份代码里最精巧的一段状态机。

### 7.1 问题

`Select` 有两种含义：

- **短按** → 急停（`robot.relax`，断电，机器人瘫下去）
- **按住 2 秒** → 关机序列（坐下、断电、关机）

**而"短按"和"长按"只有在松开的那一刻才知道是哪个。**

### 7.2 解法：短按**在松开时**发

`main.rs:198-203`：

> A short press is the emergency stop … Held for [`SHUTDOWN_HOLD`] it is the shutdown sequence
> instead … **The two cannot both fire — a robot that has already gone limp cannot sit** — so the
> stop is sent **on release**, and only if the hold never reached the shutdown. The cost is that
> the stop lands when the thumb comes off rather than when it goes down, **which for a button
> somebody presses and lets go of is the same instant.**

**"两个不可能同时发生 —— 一只已经瘫掉的机器人坐不下去。"**

代价写得很诚实：急停**在手指松开时**才生效，而不是按下时。
**"而对于一个按一下就松开的按钮来说，那是同一个瞬间。"**

### 7.3 那个 `released` 边沿

```rust
// main.rs:225-227
/// `released` is the edge from the event queue, because a press and release inside one tick
/// leaves `pressed` false on both sides and would otherwise be a stop nobody saw.
fn tick(&mut self, pressed: bool, released: bool, now: Instant) -> SelectAction {
```

**"一个 tick 内按下又松开，`pressed` 在两边都是 false"** ——
所以"松开"必须是**从事件队列里抓的边沿**，不能靠比较 `pressed`。

### 7.4 ⭐ `reset()` 只清一半

```rust
// main.rs:246-256
/// Forget a hold in flight. Called when the pad goes away: **the hold's start was measured
/// against *that* pad's button**, and carrying it onto the next pad would turn a Select
/// still held across a long dropout into a shutdown on the first tick back.
///
/// **`shutdown_sent` survives**, because it is a fact about the robot rather than about the pad:
/// the shutdown went out, the robot is sitting down, and **the release that follows must stay
/// silent whether or not the pad blinked in between.** Clearing it here would hand that release
/// back to the stop and **drop a robot mid-sit.**
```

**"`shutdown_sent` 是关于机器人的事实，不是关于手柄的。"**

- `held_since`（按住的起点）**清掉** —— 它是对着**那个**手柄的按钮量的；
- `shutdown_sent`（关机已经发出去了）**留着** —— 清了的话，
  接下来的松开会被当成急停，**把一只正在坐下的机器人摔下去**。

这两个测试（`main.rs:1412` 和 `:1438`）正是分别钉住这两半的：

```
a_hold_does_not_survive_the_pad_going_away
a_pad_dropout_after_the_shutdown_does_not_revive_the_stop
```

第二个的注释：*"The robot is already sitting down; a `Relax` here would cut torque mid-motion,
**which is the pairing the two actions are written to keep apart**."*

### 7.5 关机之后那一下松开也是静默的

`main.rs:236-243`：

```rust
let was_shutdown = self.shutdown_sent;
self.held_since = None;
self.shutdown_sent = false;
if released && !was_shutdown {
    return SelectAction::Relax;
}
```

**关机的那个 hold 一结束，`shutdown_sent` 就复位** —— 所以下一次短按又变回普通的急停。

---

## 8. ⭐ `Continuous`：按住不动就不发

### 8.1 问题

摇杆是**轮询**的。所以一个没人碰的手柄，每秒五十次重复发送**同样的三个零**：

```rust
// main.rs:982-985
/// The sticks are *polled*, so an untouched pad re-sent the same three zeros fifty times a
/// second — a `serde_json` encode, a `write_all`, a `flush`, and a `serde_json` parse on
/// `robotd`'s side, **a hundred messages a second in the modes that send two, to say nothing
/// changed. Ten a second says it as well.**
```

### 8.2 解法：字节相同就按住不发，但有个心跳

```rust
// main.rs:995
const HEARTBEAT: Duration = Duration::from_millis(100);
```

```rust
// main.rs:1026-1028
if self.line == self.last && self.may_hold(calls, now) {
    return Ok(());
}
```

**"字节完全相同 + 允许按住"才不发。**

### 8.3 ⭐ 那个"允许"的条件，是这个设计的全部

```rust
// main.rs:1040-1052
/// Whether an unchanged frame may be left unsent this tick.
///
/// **Only while it asks for no velocity.** The deadman zeroes the twist and nothing else, so on a
/// frame that already commands zero, letting it fire changes nothing about what the robot does —
/// and **on a frame that commands motion it would stop a robot whose stick is still held.** That
/// is the whole of the argument, and **it holds whatever `deadman_ms` is set to.**
fn may_hold(&self, calls: &[proto::Call], now: Instant) -> bool {
    let asks_for_motion = calls.iter().any(|call| match call {
        proto::Call::RobotMove(p) => p.vx != 0.0 || p.vy != 0.0 || p.vyaw != 0.0,
        _ => false,
    });
    !asks_for_motion && self.at.is_some_and(|at| now.duration_since(at) < HEARTBEAT)
}
```

**只有当这一帧要的速度是零，才允许不发。**

因为死手开关**只把速度归零**：
- 一帧本来就要零 —— 让死手触发**什么都不改变**；
- 一帧要的是运动 —— 让死手触发会**停住一台摇杆还扳着的机器人**。

**"这个论证不依赖于 `deadman_ms` 被设成多少。"**

### 8.4 那它为什么不干脆整个省掉

`main.rs:986-994`：

> **Nothing about the robot's safety rests on this number**, which is why it can be **picked for
> legibility** rather than argued against `[safety] deadman_ms` — **a value this daemon cannot read
> and does not know**. … What the heartbeat buys is **the report**: without it `robotd`'s twist would
> age past the deadman while a pad sat connected and idle, and `robot.state` would carry
> `limited_by: ["deadman"]` for **a robot that is stationary because it was asked to be**.

**"心跳买到的是那份报告。"** 没有它，一本正经停在原地的机器人会被标成"死手触发了"。

> 💡 那个 `std::mem::swap` 的细节（`main.rs:1033-1035`）也值得看一眼：
> 发完把 `last` 和 `line` **对调**，而不是克隆 —— 被换出来的那个缓冲区就是下一 tick 的草稿纸。
> **稳态下零分配。**

---

## 9. 三种模式

```rust
// main.rs:279-286
/// What the sticks drive. **Head and body-pose are modal because two sticks cannot express
/// nine degrees of freedom**; the toggles are the prototype's Y and B buttons.
enum Mode { Drive, Head, BodyPose }
```

| 模式 | 摇杆驱动什么 | 怎么进 |
|---|---|---|
| **`Drive`** | 走路（`robot.move`） | 默认 |
| **`Head`** | 头部四个关节（`robot.head`） | Y |
| **`BodyPose`** | 站姿的高度和倾角（`robot.pose`） | B |

### 9.1 ⭐ 为什么头/身模式要**同时**把速度归零

```rust
// main.rs:912-921
// The body must not keep its last velocity while the sticks are posing the
// head. The deadman would catch it eventually; **a robot that keeps walking
// because you started moving its head is a bad enough surprise to be explicit about.**
//
// In the same frame as the head rather than a notification of its own: the two
// describe one instant, and sending them separately was two `write_all` and two
// `flush` syscalls a tick to say so.
```

**"一只因为你开始摆它的头而继续往前走的机器人，是一个足够糟糕的意外。"**

而且这两件事**必须在同一帧**里 —— 分开发是两个 `write_all` 加两个 `flush`，
就为了说一件同一瞬间的事。

### 9.2 走路的符号

```rust
// main.rs:900-911
Mode::Drive => frame.push(proto::Call::RobotMove(proto::MoveParams {
    vx: left_y * if left_y >= 0.0 { args.max_linear } else { args.max_linear_backward },
    // `vy` is positive to the left; stick-left reads negative on every pad gilrs normalises.
    vy: -left_x * args.max_linear,
    vyaw: -right_x * args.max_angular,
})),
```

三件事：**前进和后退的上限是分开的**；**左摇杆往左读出来是负数，所以要取负**；
**右摇杆往右转是负的 yaw**。三处都有一个负号，全都不是笔误。

### 9.3 头部模式：符号是实测出来的

```rust
// main.rs:922-930
// The prototype's alpha mapping, signs included (its head_pitch/head_yaw
// joint axes are inverted relative to stick direction — verified on
// hardware there, kept verbatim here).
frame.push(proto::Call::RobotHead(proto::HeadParams {
    neck_pitch: right_y * args.max_head,
    head_pitch: -left_y * args.max_head,
    head_yaw: -left_x * args.max_head,
    head_roll: right_x * args.max_head,
}));
```

**"在硬件上验过，原样保留。"**

### 9.4 轮模式：另一套手感

```rust
// main.rs:272-277
/// The prototype's roller-mode stick shaping: **push and brake are asymmetric, there is no
/// strafe**, and heading is capped at 0.3 rad/s regardless of the walking limits — the roller
/// launch line's `--max-angular-vel 0.3`, **unchanged across both of its eras.**
const ROLLER_PUSH: f64 = 0.6;
const ROLLER_BRAKE: f64 = 0.5;
const ROLLER_YAW: f64 = 0.3;
```

推得比刹得快（0.6 vs 0.5），没有横移，转向上限写死 0.3 rad/s。

### 9.5 ⭐ 模式切换是"点名"，不是"取反"

```rust
// main.rs:784-787
// Sent once per hold, and the target is named rather than toggled — so a request that crosses a
// switch from somewhere else asks for a mode rather than for "the other one", **which could be
// either by the time it lands.**
```

**"一个跨过别人切换的请求，要的是'某个模式'而不是'另一个' ——
而'另一个'在它落地的时候可能是任何一种。"**

而且本地的摇杆手感**跟着机器人走，只在机器人同意之后**（`:802-808`）：

> The stick shaping follows the robot, and only when it agreed: **a refused switch that changed the
> mapping here would leave the pad driving a walking duck with roller curves.**

**"一次被拒绝的切换如果改了这边的映射，就留下一只用手柄轮式曲线在开走路鸭子的手。"**

---

## 10. 配置是活的

### 10.1 `[pad]` 每秒重读一次

```rust
// main.rs:484-486
// Once a second, not every tick: a `stat` at 50 Hz to catch a file somebody edits by
// hand a few times a week is work for nothing, and a second is faster than typing the
// next command.
```

**"一秒比敲下一条命令还短。"**

### 10.2 ⭐ 读不懂的配置**不能**把手柄拿走

```rust
// main.rs:291-296
/// A file that will not parse is **never a reason to leave somebody without a pad**: the defaults
/// are a working robot, and the reason is logged. **That matters more here than elsewhere because
/// this is re-read while running** — a half-saved file caught mid-write must not take the buttons
/// away, and the next read a second later gets the finished one.
```

**"一个写到一半被读到的文件，不能把按钮拿走；一秒后的下一次读会拿到写完的那个。"**

这和 [`configd-primer.md`](configd-primer.md) 里 `mediad` 那条"读不懂的文件不是没有视频的理由"
是同一个思路。

### 10.3 为什么重读是安全的

```rust
// main.rs:453-455
// `padd` holds no motor control and no session state — **the whole of it is this table** — so
// re-reading is a swap between two ticks rather than anything to sequence.
```

**"它整个进程就是那张表。"** 所以重读只是两个 tick 之间的一次交换，没有什么需要排序。

---

## 11. 手柄的 IMU 控头

`[pad_imu_head_control] enabled = true` 且手柄有 IMU 时，**Y 键的意思变了**。

### 11.1 三态

```rust
// main.rs:329-339
/// Where the pad's IMU stands in relation to the head.
enum PadImuHead {
    /// Y means what it always did.
    Off,
    /// The head follows the pad's attitude relative to `reference`. The sticks keep driving.
    Following { reference: [f32; 4] },
    /// The head stays where the last pose left it; nothing is sent for it. The sticks drive.
    Holding,
}
```

**按 Y 循环：`Off` → `Following` → `Holding` → `Following` → …**

每次从 `Off`/`Holding` 进入 `Following`，**都用当前姿态当新的基准**（`main.rs:345-350`）：

> Off or holding → follow **from here**, which is what **beats the gyro's yaw drift**: every
> re-entry makes the pad's current attitude the new centre.

**"每一次重新进入，都把'手柄现在的位置'设成新的中心。"**
这就是 [`pad-imu-primer.md`](pad-imu-primer.md) §9 那个 `relative()` 在真实交互里的样子。

### 11.2 ⚠️ 两个"摇头"的来源不能同时开着

```rust
// main.rs:609-613
// Y is the IMU's. The sticks never pose the head while this is possible: two
// sources for one joint set is a head that shakes.
if mode == Mode::Head {
    mode = Mode::Drive;
}
imu_head = imu_head.on_y(attitude);
```

**"一个关节组有两个来源 = 一个会抖的头。"**

### 11.3 姿态还没来的时候要**说出来**

```rust
// main.rs:626-632
if imu_head_cfg.enabled && tap.as_ref().is_some_and(|tap| tap.has_imu()) {
    // The IMU is there and has not spoken yet — a second after connecting,
    // typically. Saying so beats silently doing the other thing.
    tracing::warn!("the pad's IMU has no attitude yet; Y is stick head mode this once");
}
```

**"IMU 在那里但还没开口 —— 通常是连上之后的一秒内。说出来，好过默默地做另一件事。"**

而 `has_imu()` 回答的是"**这个手柄有没有**"，不是"**它开没开**"（`tap.rs:255-259`）：

> True **as soon as the node is known, before it is open** — the question "can Y mean IMU head
> control on this pad" needs answering on the press.

**"Y 键按下去的那一刻就要有答案。"** 所以它从 `wanted_imu` 读，而不是从打开的设备读。

### 11.4 `gain` 和限位

```rust
// main.rs:363-372
let angle = |degrees: f32| (f64::from(degrees).to_radians() * gain).clamp(-max_head, max_head);
proto::HeadParams {
    neck_pitch: 0.0,                 // 一个 pitch 关节足够跟住一只手腕
    head_pitch: angle(pitch),
    head_yaw: angle(yaw),
    head_roll: -angle(roll),
}
```

**脖子恒为 0**，而且这里有两层钳制：`gain` 缩放之后还要 `.clamp(-max_head, max_head)` ——
**头自己的行程上限仍然适用**。

---

## 12. ⭐ 那个 raw tap：为什么它长出了一个 socket

`padd` 提供**唯一一个由它自己回答的调用**：`pad.input`。

### 12.1 那个"别处答不了的问题"

`tap.rs:5-14`（模块文档）：

> One question about a gamepad **cannot be answered from anywhere else in this system**. `padd`
> polls the last known stick value and sends it at a steady 50 Hz, so **a radio that has stopped
> delivering reports still produces perfectly fresh intents**: `robotd` sees a live driver, **the
> deadman never fires**, and the robot keeps walking on a command nobody is still giving. **Every
> surface downstream — `robot.state`, the monitor's `requested` column, the journal — shows a
> healthy robot, because from their side it is one.**
>
> The evidence lives **one layer below `padd`**: the event stream itself, where a report that never
> arrived **leaves a hole in the cadence**.

**这就是那个问题：** 你自己在轮询，所以"上一次的值"永远新鲜 ——
从 `robotd` 那一侧看，驱动一直活着，死手永远不触发，**机器人拿着一个没人在给的指令一直走。**

**证据在 `padd` 的下一层**：事件流本身。一个没到达的报文会在节奏里留下一个洞。

所以这个 tap **原样转出事件流，不做任何总结**，让查的人自己算。

### 12.2 为什么不直接转发 gilrs 给的东西

`tap.rs:18-22`：

> **`Gilrs::next_event` is not the raw stream and cannot be made into one.** It applies three
> filters by default — `axis_dpad_to_button`, `Jitter`, `deadzone` — which **rewrite values, drop
> small movements, and swallow whole events**; `gilrs-core` turns `SYN_DROPPED` into an internal
> resync flag that **never reaches a consumer**; and neither `SYN_REPORT` nor `MSC_SCAN` survives
> the trip. **Every one of those is a thing someone chasing an unreliable link needs to see.**

**"这些每一条都是追查一条不可靠链路的人需要看到的东西。"**

### 12.3 读两遍不花钱

`tap.rs:24-29`：

> Opening the node twice **costs nothing and takes nothing away**: an evdev reader gets its own
> queue, so this cannot starve gilrs of an event, and `scripts/pad-link-test.sh` has been reading
> the same node alongside `padd` since before this existed. The node comes from **gilrs itself**
> ([`gilrs::LinuxGamepadExt::devpath`]), which is the only way to be sure this is watching the pad
> that is actually driving — **one Xbox controller registers several input devices, and the first
> one in `/proc/bus/input/devices` is a media-key keyboard that never sends anything.**

**"一个 Xbox 手柄会注册好几个输入设备，而第一个是永远不会发任何东西的多媒体键盘。"**

### 12.4 ⭐ 没人看的时候就关掉

`tap.rs:33-35`：

> **Nothing.** The device is not opened until a subscriber connects, and it is **closed again after
> the first report following the last one leaving** — the same bargain `robotd` strikes by only
> assembling a `robot.state` frame when someone is subscribed. **A pad at rest is silent, so a
> parked reader is not a wakeup either.**

规则在 `done_with`（`tap.rs:373-385`）里，**每个报文之后问一次**：

```rust
if state.subscribers.is_empty() {
    return Some("nobody is watching any more");
}
if state.wanted.as_deref() != Some(node) {
    return Some("the pad changed");
}
None
```

而这个规则的完整说法在测试的注释里（`tap.rs:1072-1073`）：

> **The reader opens nothing until there is both a pad and somebody watching, and lets go as soon as
> either goes away.** On a robot nobody is usually watching, and **a per-report wakeup for an
> audience of none is the cost `robotd` refuses to pay for `robot.state` either.**

**"为一个没有观众的场合做每次报文一次的唤醒，正是 `robotd` 为 `robot.state` 拒绝付的那笔钱。"**

**注意它返回的是一个"理由字符串"**，注释解释了为什么（`tap.rs:376-377`）：

> Said as a reason rather than dropped silently: **a client that reconnects wants to know why the
> previous stream ended**, and "nobody was watching" is not a fault.

IMU 那条路多一个条件（`tap.rs:404-411`）：**没有订阅者但 `control` 开着也继续读** ——
那就是 `padd` 自己说"给我留着"（`Tap::imu_control`）。

### 12.5 慢订阅者会被丢下，但不会被断开

```rust
// padd/src/tap.rs:512-515
/// Hand one report to every subscriber, **dropping it for any that has fallen behind.**
///
/// **Never blocks.** The reader thread is the only thing that can measure the pad's cadence, and
/// **a subscriber that stalled it would corrupt the measurement it asked for** — every frame after
/// the stall would carry a gap the radio had nothing to do with.
```

**"一个把读线程卡住的订阅者，会毁掉它自己要的那个测量。"**

丢掉的报文**不是消失**：计数器累加，然后**打在订阅者收到的下一个报文上**（`tap.rs:616-618`）：

> Whatever this subscriber missed goes on the next frame it does get, **where it belongs: beside
> the gap it explains.** Left on the counter until then, so it cannot be lost to an `Attached` or a
> `Detached` that carries nowhere to put it.

**"紧挨着它解释的那个洞。"** 而且计数器会**留到那时候** —— 否则会被一个没地方放它的
`Attached`/`Detached` 吃掉。

### 12.6 socket 协议

```
客户端 ──{"jsonrpc":"2.0","id":1,"method":"pad.input"}──►
        ◄──{"result":{"accepted":true}}           ← 先回，再订阅
        ◄──{"method":"pad.report","params":{...}} ← 之后是通知流
```

两个细节：

**① 先回答，再订阅**（`tap.rs:601`）：

> Answered before subscribing, so **the reply cannot arrive after a notification it precedes.**

**② 敲错门会被告知敲的是哪扇**（`tap.rs:580-589`）：

```rust
format!("padd's socket serves {} only, not {}", proto::method::PAD_INPUT, other.method())
```

> A client that meant to reach `robotd` or `configd` gets told which door it is knocking on rather
> than **a silent hang**.

### 12.7 权限

`/run/padd/pad.sock`，模式 `0660`，模式 `0660` + 交给 `robot` 组 ——
和 `mediad` 的 `media.frame` 完全一样的做法（`getgrnam` + `chown`）。

`padd.service:98-101` 解释了为什么**在代码里做而不是用 `Group=robot`**：

> That is done in code rather than with `Group=robot` here, the way `robotd` does it: **this process
> keeps its own primary group, and reaches the robot group as a supplementary one.**

`tap.rs:938-943` 把机制说全了：

> `robotd` gets the same effect from `Group=robot` in its unit, because **a socket inherits its
> creator's primary group**. `padd` cannot copy that: its primary group is its own, and it reaches
> the robot group as a supplementary one — **which is enough for this, since POSIX lets the owner of
> a file give it to any group the owner belongs to.**

**"socket 继承创建者的主组"** —— 所以 `robotd` 能用 `Group=robot`，而 `padd` 不能。

### 12.8 四条线程，两把锁

`Tap::serve`（`tap.rs:200-215`）起三条常驻线程，每个订阅者再加一条：

| 线程名 | 拥有什么 | 干什么 |
|---|---|---|
| `pad-tap-accept` | `UnixListener` | 死循环接受连接，每个连接起一条 `pad-tap-client` |
| `pad-tap-read` | 手柄的 `RawDevice` | 读事件，攒成 `PadFrame` |
| `pad-tap-imu` | IMU 的 `RawDevice` | **单独一条线程，因为 `fetch_events()` 会阻塞** |
| `pad-tap-client` | 一条 socket | 读一行请求，然后一直往外写 |

通信靠两把锁加每订阅者一条有界通道：

```rust
// tap.rs:117-126
struct Shared {
    state: Mutex<State>,
    /// Signalled whenever the reader might have work: a pad appeared, or someone subscribed.
    wake: Condvar,
    /// The IMU's attitude, kept by the IMU reader for the main loop. `None` while no IMU is
    /// open. **Its own lock, not `state`'s: the main loop reads it fifty times a second and must
    /// not queue behind a subscriber's send.**
    attitude: Mutex<Option<pad_imu::Imu>>,
}
```

⚠️ **姿态为什么要有自己的一把锁** —— 这条值得单独记：

`state` 那把锁在**向所有订阅者分发**的时候是held住的（`State::send` 拿着它在 `try_send`）。
而主循环**每 50 ms 要看一次姿态**。如果姿态住在 `State` 里，
**控头的延迟就会继承"最慢的那个订阅者写出去的耗时"**。

**一把锁保护两件事的时候，快的那件事要为慢的那件事买单。**

跨通道传的全是 `Arc<proto::PadReport>` —— 所以**一个报文只序列化一次，N 个订阅者共享**。

### 12.9 关掉之后为什么要睡 250 ms

```rust
// tap.rs:110
const REOPEN_AFTER: std::time::Duration = std::time::Duration::from_millis(250);
```

理由（`tap.rs:99-106`）：

> **It bounds a spin.** Two of the ways a stream ends **leave the state that started it unchanged**
> — the node cannot be opened at all (no `input` group, so every attempt fails identically), and a
> device that is already gone when it is opened — and **without this the reader would reopen, fail,
> and reopen again as fast as the kernel could refuse it.**

**"有两条结束路径不会改变那个让它开始的状态。"** 不睡就是拿满一个核去撞内核。

### 12.10 `SYN_DROPPED`：那个故意**不**自动恢复的读法

这就是 `Cargo.toml:41-42` 说的那件事：

> The raw event stream, unfiltered: **`raw_stream::RawDevice` is the one that does *not* resync on
> `SYN_DROPPED`, which is the event a link investigation most needs to see.**

普通的 evdev reader 会在 `SYN_DROPPED` 之后**自动把所有设备状态重查一遍**，
让上层看起来什么也没发生。**那样的读者看不到这个事件本身。**

而内核的契约是（`tap.rs:680-681`）：

> The kernel's contract after `SYN_DROPPED`: **everything up to the next `SYN_REPORT` is a
> half-report and must be thrown away**, because the events that completed it are already gone.

所以 tap 自己处理它（`tap.rs:699-706`）：丢掉半截报文，标记 `resyncing`，
并且**把 `after_drop` 置上** —— 理由（`tap.rs:700-701`）：

> **Not the radio.** This reader fell behind and the kernel emptied its queue, **which makes the gap
> around it unmeasurable** — so the next complete report says so.

**"不是电台的问题。"** 这个标记存在的意义就是：**别把自己造成的洞算到链路上。**

### 12.11 那个队列是"两秒"，但只按摇杆报文算

```rust
// tap.rs:84-87
/// **Two seconds of a busy pad.** Generous, because the cost of a queue is memory and **the cost of
/// a drop is a hole in the very measurement this exists to make** — but bounded, because the
/// alternative is a slow client turning into unbounded memory on a robot. **A drop is counted and
/// reported rather than hidden.**
```

`QUEUE = 256`（`tap.rs:88`）。但要注意：**摇杆报文和 IMU 批次共用这一条通道**，
而 IMU 每秒约 200 批、摇杆每秒约 50 帧 —— 所以 IMU 的洪水可以挤掉摇杆的帧，反之亦然。

这正是两个计数器分开的原因（`tap.rs:152-154`）：

> counted apart: **a lost sample says nothing about the stick reports**, and stamping it onto a
> `PadFrame` would say it did.

**"丢了一个 IMU 采样，对'摇杆报文有没有丢'什么都没说。"**

---

## 13. 测试：23 个

```bash
cargo test -p padd
```

| 文件 | 数量 | 都在测什么 |
|---|---|---|
| `main.rs` | 12 | `Continuous`、`SelectButton`、`head_from_pad`、参数校验 |
| `tap.rs` | 11 | 订阅者生命周期、IMU 兄弟节点、线格式 |

而且**两个都是纯单元测试** —— 用一个 `UnixStream::pair()` 当假 `robotd`（`main.rs:1108`），
**非阻塞**，因为大多数断言是"**什么也没发**"：

```rust
// main.rs:1104-1107
/// A socket pair standing in for `robotd`, and what came out of it.
///
/// **Non-blocking on the reading end so a test can assert that *nothing* was sent**, which
/// is the assertion most of these are making.
```

### 13.1 `main.rs` 的 12 个

| 测试 | 行 | 验什么 |
|---|---|---|
| `an_unchanged_stationary_frame_is_not_resent` | `:1141` | 静止的重复帧不发 |
| `a_frame_that_asks_for_motion_is_always_sent` | `:1162` | **要动的一定发** |
| `a_stationary_frame_goes_out_again_on_the_heartbeat` | `:1183` | 心跳到了还是要发 |
| `a_changed_frame_is_sent_at_once` | `:1208` | 变了立刻发 |
| `a_two_call_frame_is_one_write_and_two_lines` | `:1228` | 一帧一写、两行 |
| `an_untouched_pad_in_head_mode_holds_both_intents` | `:1256` | 头模式两件事一起被按住 |
| `a_rate_this_loop_cannot_run_at_is_refused_rather_than_divided_by` | `:1282` | `--hz 0` 被拒绝而不是除以零 |
| `y_cycles_follow_hold_follow_and_re_centres_each_time` | `:1301` | Y 的三态循环 + 每次重新取基准 |
| `the_head_follows_the_pad_with_the_sticks_signs_gain_and_limit` | `:1337` | IMU 控头的符号/gain/限位 |
| `select_stops_on_a_short_release_and_shuts_down_on_a_long_hold` | `:1382` | Select 的两义 |
| `a_hold_does_not_survive_the_pad_going_away` | `:1412` | 断线清 `held_since` |
| `a_pad_dropout_after_the_shutdown_does_not_revive_the_stop` | `:1438` | 断线**不清** `shutdown_sent` |

### 13.2 `tap.rs` 的 11 个

| 测试 | 行 |
|---|---|
| `a_subscriber_arriving_mid_stream_is_told_the_device` | `:1019` |
| `a_slow_subscriber_is_dropped_from_rather_than_blocking_the_reader` | `:1032` |
| `a_departed_subscriber_is_forgotten` | `:1061` |
| `the_device_is_only_held_while_a_pad_and_a_watcher_both_exist` | `:1075` |
| `every_code_gets_a_name_or_a_number` | `:1106` |
| `dropped_samples_are_not_dropped_frames` | `:1135` |
| `head_control_holds_the_imu_open_and_reads_the_filter` | `:1151` |
| `a_subscriber_arriving_mid_stream_is_told_the_imu_too` | `:1196` |
| `the_imu_is_the_accelerometer_sibling_under_the_same_hid_device` | `:1224` |
| `an_unreadable_sibling_does_not_end_the_imu_search` | `:1277` |
| `a_frame_survives_the_wire` | `:1309` |

两个值得单独看：

**`every_code_gets_a_name_or_a_number`（`:1106`）：**

> Names come from the kernel's own tables, and a code with no name there becomes **numbers rather
> than evdev's `unknown key: 42` prose — which nobody can grep for and which would land in the
> middle of a JSON line.**

**"没人能 grep 它，而且它会落在一条 JSON 行的中间。"**

**`dropped_samples_are_not_dropped_frames`（`:1135`）** ——
IMU 采样丢的计数和摇杆报文的计数是**两个独立的计数器**，
因为"丢了一批 IMU 采样"对"摇杆报文有没有丢"什么都没说。

---

## 14. 几处读者会绊到的地方

按仓库的规矩，代码与文档不一致的地方，这里只**陈述事实**，不判断该怎么办。

### 14.1 `main.rs` 是 1463 行，其中 350 行是测试

`padd/src/main.rs` 的主体在 `:970` 结束（`request` 之后），`:1108-1463` 全是 `mod tests`。
所以"主循环"实际读到 `:969` 就够了。

### 14.2 `padd.service` 的 `Documentation=` 指向一个**确实会被安装**的文件

```ini
# padd/systemd/padd.service:21
Documentation=file:///opt/robot/daemon/current/docs/architecture.md
```

`architecture.md` 在发布时被从 `docs/design/` **改名**到 `docs/`（`scripts/dev-push.sh:397`），
所以这条路径是对的。**对比 `mediad.service:17` 指向的 `docs/design/remote-webrtc.md` 并不在安装清单里** ——
详见 [`mediad-primer.md`](mediad-primer.md)（那是我之前报过的一处）。

### 14.3 `HEARTBEAT` 那个常数**故意**不去对齐 `deadman_ms`

```rust
// main.rs:986-994
/// **Nothing about the robot's safety rests on this number**, which is why it can be picked for
/// legibility rather than argued against `[safety] deadman_ms` — **a value this daemon cannot read
/// and does not know.**
```

`100 ms` 和 `duck-control` 默认的 `500 ms` 之间是**五倍**关系，而这个关系没有被任何代码保证。
论证（§8.3）说明为什么这没关系 —— 但它值得知道：**这两个数字是可以独立漂移的。**

### 14.4 两个"按住"的时长在注释里被显式排序

```rust
// main.rs:259-264
/// Three seconds, **longer than the shutdown hold**, and the prototype's number.
```

`MODE_HOLD = 3 s` > `SHUTDOWN_HOLD = 2 s`，而注释说这是个**有意的顺序**。
但两个常数之间**没有代码层面的约束** —— 把 `SHUTDOWN_HOLD` 改成 4 秒不会有任何东西抱怨。

### 14.5 轮模式的转向上限和走路的上限互不相干

```rust
const ROLLER_YAW: f64 = 0.3;     // main.rs:277 —— 写死
// ...
vyaw: -right_x * args.max_angular,   // main.rs:910 —— 走 --max-angular，默认 1.5
```

`--max-angular` 的默认是 **1.5 rad/s**，而轮模式把它换成写死的 **0.3** ——
**`--max-angular` 在轮模式下完全不起作用**，命令行上没有任何提示。

### 14.6 订阅者线程没有上限，而且是每个连接一条

`accept`（`tap.rs:538-553`）每接受一个连接就 `spawn` 一条 `pad-tap-client` 线程，
**不设上限**；`Shared::subscribe` 那边也没有。因为是本机 unix socket，
所以这是"同机器上的事"，但一台板子上跑满线程仍然是一个可以到达的状态。

### 14.7 订阅者只读一行，之后再也不读

`subscriber`（`tap.rs:564-568`）读完那行 `pad.input` 之后**再也没读过 socket**。
没有 keepalive，也没有流水线：**同一个连接上的第二个请求永远不会被看见**。
一个连上却不发东西的客户端会一直阻塞在 `read_line` 里，直到它断开。

### 14.8 IMU 节点只在"每个手柄节点"上找一次

`Tap::watch` 在手柄节点没变时**提前返回**（`tap.rs:229-231`），
所以那次 sysfs 搜索**每个手柄节点只跑一次**。注释（`tap.rs:132-133`）解释了为什么：

> Resolved once per pad node rather than per tick, **because it is a walk through sysfs**.

代价是没写的：**一个在手柄节点之后才注册出来的 IMU 节点，要等手柄重新连一次才会被找到。**

### 14.9 一处措辞不够精确

模块文档说设备在 *"the first report following the last one leaving"*（`tap.rs:33-34`）之后关掉，
而检查实际发生在**每个读批次之后**（`tap.rs:740-744`）。一个批次里带好几个报文的话，
是在**第一个批次**之后关的，严格说不是"第一个报文"。

---

## 15. 阅读路线

| 步 | 读什么 | 为什么先读它 |
|---|---|---|
| 1 | `padd/src/main.rs:1-81` | 模块文档 = 整个设计 + **那张按键表** |
| 2 | `padd/Cargo.toml`（1-18 行） | gilrs 那个 C 依赖值不值的账 |
| 3 | `padd/systemd/padd.service` | 权限、为什么是个常驻单元、`AF_NETLINK` 为什么承重 |
| 4 | `padd/src/main.rs:184-296` | 常数和 `SelectButton` —— **每个常数都解释了为什么是这个值** |
| 5 | `padd/src/main.rs:481-969` | 主循环。**对着 §6 那张表读** |
| 6 | `padd/src/main.rs:995-1064` | `Continuous` —— §8 的核心 |
| 7 | `padd/src/tap.rs:1-111` | 模块文档 = **为什么它长出了一个 socket** |
| 8 | `padd/src/tap.rs:347-545` | `Shared` 的锁与生命周期规则 |
| 9 | `padd/src/tap.rs:556-648` | socket 协议（很短） |

**如果只有十分钟**：读 `main.rs:1-81`，然后读 §3 和 §8.3。

三条贯穿全文的主线：

1. **它没有任何特权，而这是重点。** 走和 app 完全一样的那条 API，
   所以那条 API 每天都被验证；配对、root、BlueZ 全都在别处。
2. **不说谎。** 没有手柄就**什么都不发**（让死手去停），不造一个零命令假装是有人要停；
   配置读不懂就用默认值并说出来，不把手柄拿走；IMU 还没开口就说"还没开口"。
3. **每个常数都解释了两头夹在哪。** 500 ms 的轮询、2 秒和 3 秒的按住、
   100 ms 的心跳、3 °/s 的死区 —— 没有一个是"看起来差不多"。

---

## 16. 术语表

| 词 | 意思 |
|---|---|
| **intent** | "我想让机器人做什么"。区别于"直接控制舵机" |
| **`robot.move` / `.head` / `.pose` / `.do` / `.relax` / `.enable`** | 各种 intent 的名字 |
| **continuous intent** | 持续意图：每 tick 覆盖一次，最后写入者赢（速度、头部角度、站姿） |
| **discrete intent** | 一次性意图：有回答（技能、开关、停止） |
| **notification vs request** | 通知没有 `id`、不等回复；请求有 `id`、等一个回答 |
| **deadman（死手开关）** | intent 不再到达就把速度归零。默认 500 ms。**`padd` 安全设计的另一半** |
| **twist** | 速度三元组 `(vx, vy, vyaw)` |
| **gilrs** | Rust 的手柄库。带 SDL 手柄数据库（所以有那个 C 依赖） |
| **evdev** | Linux 的原始输入设备接口。`tap.rs` 直接读它 |
| **`SYN_REPORT`** | 内核说"一个完整的报文到此为止" |
| **`SYN_DROPPED`** | 内核说"你的队列溢出过，我丢了些东西" |
| **`MSC_SCAN`** | 记录"这个按键对应的是扫描码几" |
| **resync** | 收到 `SYN_DROPPED` 后重新查询设备全状态。**tap 故意不要这个** |
| **raw tap** | 那个原样转出事件流的 socket（`pad.input`） |
| **cadence（节奏）** | 报文到达的间隔规律。**链路健不健康的唯一证据** |
| **HID** | 人机接口设备。一个手柄可能注册好几个 |
| **sysfs** | `/sys`，内核把设备拓扑摊在这里。`imu_sibling` 走它 |
| **`condvar`** | 条件变量。一个线程等，另一个叫醒它 |
| **primary / supplementary group** | 主组 / 附加组。socket 的权限看的是主组 |
| **torque off** | 舵机断电，机器人瘫软 |
| **policy（策略）** | 那个 ONNX 神经网络。Start 开的是它 |
| **skill** | 一个有名字的动作（`ground_pick`、`roulade`…）。`padd` **不知道它是什么** |
| **mode（驱动模式）** | 走 ⇄ 轮 |
| **Modal（模态）** | 摇杆的当前含义取决于哪个模式 |
| **边沿（edge）** | "这一 tick 刚按下" / "刚松开"，而不是"现在按着" |
| **`AF_NETLINK`** | libudev 用的 socket 类型。少了它**开机后连上的手柄永远发现不了** |
| **`RuntimeDirectory=`** | systemd 建的目录，属主是这个单元，且不受 `ProtectSystem=strict` 影响 |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| 怎么配对手柄（操作者视角） | [`robot/pair-a-gamepad.md`](robot/pair-a-gamepad.md) |
| `[pad]` / `[pad_imu_head_control]` 的 schema（姊妹篇） | [`robotd-params-primer.md`](robotd-params-primer.md) |
| 手柄那个 IMU 的姿态怎么算的（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| 那些 intent 的线上契约（姊妹篇） | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| intent 到了 robotd 之后变成什么 | [`robotd-primer.md`](robotd-primer.md) · [`duck-control-primer.md`](duck-control-primer.md) |
| **死手开关**和安全层 | [`duck-control-primer.md`](duck-control-primer.md) |
| 配对归谁：蓝牙和 BlueZ（姊妹篇） | [`configd-primer.md`](configd-primer.md) · [`btd-primer.md`](btd-primer.md) |
| 笔记本上那个 `monitor` 面板（姊妹篇） | [`duckctl-primer.md`](duckctl-primer.md) |
| "手柄和远程 peer 抢方向盘"那个已知缺口 | [`design/remote-webrtc.md`](design/remote-webrtc.md) §9 |
| 手柄 IMU 控头的设计取舍 | [`design/robotd-design.md`](design/robotd-design.md) |
| 机器人走到哪了（姊妹篇） | [`odometry-primer.md`](odometry-primer.md) |
| BLE 的线上契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| 摄像头、WebRTC、远程网关（姊妹篇） | [`mediad-primer.md`](mediad-primer.md) |
| 摄像头里的鸭子检测（姊妹篇） | [`duck-detect-primer.md`](duck-detect-primer.md) |
| 仿真的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| 关节角 → 空间中的点（姊妹篇） | [`kinematics-primer.md`](kinematics-primer.md) |
| 发布怎么把自己装到板子上（姊妹篇） | [`hooks-primer.md`](hooks-primer.md) |
| 板子被配置成什么样子（姊妹篇） | [`deploy-primer.md`](deploy-primer.md) |
| 摸头检测：麦克风、log-mel、那个门控（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| `monitor` 那个手柄面板（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| 装机、更新、诊断的那些工具（姊妹篇） | [`scripts-primer.md`](scripts-primer.md) |
| 鸭子的嗓子：可播种的合成器（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 头部的两个传感器：深度与 IMU（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
