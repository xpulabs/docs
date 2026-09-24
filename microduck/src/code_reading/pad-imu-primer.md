# `pad-imu` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> 这个 crate 是纯库，没有自己的设计文档。它服务的那个功能（手柄控制头部）由
> [`robotd-params-primer.md`](robotd-params-primer.md) §`[pad_imu_head_control]` 和
> [`robot/cheatsheet.md`](robot/cheatsheet.md) 的操作者视角拥有。
> 若本导读与代码不一致，以代码为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：[`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md)（`PadImuBatch` 那几个类型住在那里）、
> [`robotd-params-primer.md`](robotd-params-primer.md)（`[pad_imu_head_control]` 的开关）。

## 目录

1. [一分钟版](#1-一分钟版)
2. [它在整个系统里的位置](#2-它在整个系统里的位置)
3. [⭐ 核心心智模型：互补滤波器](#3--核心心智模型互补滤波器)
4. [目录导览](#4-目录导览)
5. [坐标系：先把这个搞对](#5-坐标系先把这个搞对)
6. [⭐ 陀螺零偏：为什么必须学它](#6--陀螺零偏为什么必须学它)
7. [那个"静止窗口"是怎么判的](#7-那个静止窗口是怎么判的)
8. [`sample()`：一个采样的完整旅程](#8-sample一个采样的完整旅程)
9. [⭐ 两种漂移，两种治法](#9--两种漂移两种治法)
10. [手搓的四元数算术](#10-手搓的四元数算术)
11. [⚠️ `euler_deg` 的返回顺序是个陷阱](#11-️-euler_deg-的返回顺序是个陷阱)
12. [两个消费者怎么用它](#12-两个消费者怎么用它)
13. [测试：5 个](#13-测试5-个)
14. [几处读者会绊到的地方](#14-几处读者会绊到的地方)
15. [阅读路线](#15-阅读路线)
16. [术语表](#16-术语表)

---

## 1. 一分钟版

`pad-imu` 回答一个问题：

> **我手里这个手柄，现在是什么姿态？**

有些手柄自带一颗六轴惯性单元（IMU）——"Pro Controller"的 Switch 山寨柄就有。
`padd` 把它读出来，**用"你手里手柄的倾斜"去摆机器人的头**。

一句话说清它的定位：

> **它是"手柄朝向"的唯一算法，两个程序共用，因为头和画面不能对同一个手柄有两种说法。**

`Cargo.toml:3-5`：

> One filter for two programs: `padd` poses the robot's head from it, `robotctl monitor` draws the
> pad from it. **Its own crate so neither depends on the other**, and so **the head and the picture
> cannot disagree** about which way the pad is tilted.

**"头和画面不能对同一个手柄有两种说法。"** 这就是它为什么要单独成一个 crate。

规模：**616 行**（`lib.rs` 602 + `Cargo.toml` 14），只有一个依赖（`duck-ipc-proto`，为线上类型）。

---

## 2. 它在整个系统里的位置

```
  手柄（HID 设备）
      │  内核 evdev 事件：ABS_X/Y/Z（加速度）+ ABS_RX/RY/RZ（角速度）
      ▼
   padd 的 tap                    ← 读 evdev，分批
      │  原始整数 + 分辨率（accel_per_g / gyro_per_dps）
      ▼
   PadReport::Imu(PadImuBatch)    ← 走 IPC，广播给订阅者
      │
      ├──────────────► pad_imu::Imu::absorb()  ← 就是这个 crate
      │                       │
      │                       │  姿态四元数（body → world）
      │                       ▼
      │           ┌───────────┴────────────┐
      │           ▼                        ▼
      │   padd：摆机器人的头        robotctl monitor：画一个线框手柄
```

两个消费者（`Cargo.toml` 里能看到）：

| crate | 用它干什么 |
|---|---|
| **`padd`** | `[pad_imu_head_control]` 打开时，用手柄的倾斜摆头（`padd/src/tap.rs:125`） |
| **`robotctl`** | `monitor` 里画一个跟着真手柄转的线框手柄（`robotctl/src/imu_view.rs`） |

> 💡 注意它**只依赖 `duck-ipc-proto`** —— 为的是那几个线上类型。
> 它不认识 `padd`，也不认识 `robotctl`，不认识 GStreamer 也不认识 evdev。
> **一个纯算法库。**

---

## 3. ⭐ 核心心智模型：互补滤波器

这是整份代码唯一的思想。

### 3.1 两个传感器，各有一个毛病

| 传感器 | 擅长 | 毛病 |
|---|---|---|
| **陀螺仪**（gyro） | **短期**准。测角速度，积分出角度 | **会漂**。而且这颗柄的陀螺**没校准过** |
| **加速度计**（accel） | **长期**准。静止时永远指着"下" | **一动就废**。你晃它，它测的是你的手 |

**一个短期准，一个长期准 —— 那就把它们互补起来。**
这就是"互补滤波器"（complementary filter）这个名字的来历。

### 3.2 做法：以陀螺为主，用重力慢慢拽回来

模块文档（`lib.rs:11-15`）：

> **Orientation**, as a quaternion from the pad's body frame to the world, by **integrating the gyro
> and pulling the result back toward the accelerometer's gravity** — the smallest useful
> complementary filter. **Gravity fixes pitch and roll; yaw comes from the gyro alone and drifts**,
> which is honest: **nothing on a pad can observe heading.**

拆开就是两步，每个采样都做一遍：

**第一步：让陀螺转一下。**

```rust
// lib.rs:274-275
let step = [gyro[0] * rad * dt, gyro[1] * rad * dt, gyro[2] * rad * dt];
self.q = mul(self.q, from_rotvec(step));
```

把角速度（°/s）乘上时间间隔 `dt`，得到"这一小段时间转过的角度"，
再把它变成一个四元数，**乘在当前的姿态右边**。

**第二步：让重力拽一下。**

```rust
// lib.rs:282-291
if gravity_ok {
    let measured = normalized(accel);                        // 加速度计说"上"在哪
    let predicted = rotate(conj(self.q), [0.0, 0.0, 1.0]);   // 姿态说"上"在哪
    let error = cross(measured, predicted);                  // 两者的差
    let k = GRAVITY_GAIN * dt;
    self.q = mul(self.q, from_rotvec([error[0]*k, error[1]*k, error[2]*k]));
}
```

- `measured` = **加速度计说的"上"**（在柄的身体坐标系里）；
- `predicted` = **当前姿态认为的"上"**（同样是身体坐标系 —— 所以用 `conj(q)` 把世界的 +Z 转回身体）；
- `error` = 两者的**叉积** —— 一个"该往哪个方向转、转多少"的小旋转；
- 只转 `GRAVITY_GAIN * dt` 那么多，**不是一次转到位**。

### 3.3 ⚠️ 那个叉积的**顺序**是有讲究的

注释专门写了这件事（`lib.rs:278-281`）：

> With `q ← q ⊗ δ`, the new prediction is `δᵀ·predicted`, so **δ has to carry *measured* onto
> *predicted*** — **hence the order of the cross product; the other way round runs away rather than
> converging.**

**"反过来写不会收敛，会发散。"** 也就是说，写反了姿态不会"差一点"，而是**直接飞走**。
所以这一行是 `cross(measured, predicted)`，不是 `cross(predicted, measured)`。

### 3.4 `GRAVITY_GAIN = 2.0` 是什么意思

```rust
// lib.rs:39-44
/// How hard the accelerometer pulls the orientation back toward gravity, per second.
///
/// Two: a tilt error decays with a **half-second time constant**, which is slow enough that
/// **shaking the pad does not make the attitude flinch** and fast enough that it is **level a
/// second after being set down**.
```

**2.0 / 秒 → 时间常数 0.5 秒**（时间常数就是增益的倒数）。这个数字是两头夹出来的：

- **够慢**：晃手柄不会让姿态一惊一乍；
- **够快**：放回桌上，一秒之内就水平了。

### 3.5 `GRAVITY_BAND`：什么时候**不**信加速度计

```rust
// lib.rs:46-50
/// Accelerometer magnitudes accepted as "this is gravity", in g.
///
/// Outside this the pad is being moved, and **the accelerometer measures the hand as much as the
/// earth**. The orientation then runs on **the gyro alone** until the pad settles.
const GRAVITY_BAND: std::ops::RangeInclusive<f32> = 0.85..=1.15;
```

静止时加速度计的模长应该是 **1 g**。偏离这个范围说明你在晃它 ——
这时候**重力修正整个跳过**（`if gravity_ok` 那个分支），只靠陀螺。

0.85 ~ 1.15 这一圈留了 ±15%，够容下手抖和噪声，又挡得住真正的甩动。

---

## 4. 目录导览

```
pad-imu/
├── Cargo.toml     14 行  —— 头 5 行讲清"为什么它自己是一个 crate"
└── src/
    └── lib.rs    602 行  全部算法（含 5 个测试）
```

一个文件，分四段：

| 段 | 行 | 内容 |
|---|---|---|
| 常数 | `:39-65` | 五个可调数字，**每个都有长注释** |
| `Imu` + `Bias` | `:67-161` | 状态 |
| 算法 | `:163-306` | `absorb` / `sample` / 取数 |
| 四元数算术 | `:308-443` | 手搓的 12 个小函数 |

---

## 5. 坐标系：先把这个搞对

```rust
// lib.rs:24-30
//! ## Axes
//!
//! `hid-nintendo` reports the accelerometer on `ABS_X/Y/Z` and the gyro on `ABS_RX/RY/RZ`, with
//! `+Z` up when the pad lies flat: the clone reads about `+1 g` there at rest. The body frame is
//! **+X the pad's front** — the edge with the triggers, away from the player — and **+Y the pad's
//! left**, which follows from a right-handed frame with Z up.
//! **Confirmed against the drawn pad on the robot, 2026-09-09.**
```

**平放在桌上时：**

```
        +X（手柄的前沿 —— 扳机那一侧，背对玩家）
         ↑
         │
+Z 朝上   │
（对着天花板）
         │
         └──────────→ +Y（手柄的左手边）
```

- **+X** = 手柄的**前**（扳机那条边，远离玩家）
- **+Y** = 手柄的**左**（由"右手系 + Z 朝上"推出来）
- **+Z** = **上**（平放时朝天花板，静止读数约 +1 g）

> 💡 那句 **"Confirmed against the drawn pad on the robot"** 说明这不是猜的 ——
> 是拿真手柄对着屏幕上画出来的线框核对过的。
> 而 [`imu_view.rs:6-7`](../robotctl/src/imu_view.rs) 解释了为什么线框上要画一个"前沿标记"：
> **"a wrong guess about the body frame is visible the first time the pad tilts"** ——
> 坐标系猜错了，第一次倾斜就看得见。

---

## 6. ⭐ 陀螺零偏：为什么必须学它

这是这个 crate 里**最实用**的一段，值得单独讲。

### 6.1 问题

模块文档（`lib.rs:17-22`）：

> **Gyro bias**, because **the clone's gyro is not calibrated**. At rest on a table its Z rate reads
> about **12 °/s**, and integrated as-is the attitude would **turn a full circle every thirty
> seconds while the pad lay still**.

**手柄躺着不动，姿态每三十秒转一整圈。**

算一下：12 °/s × 30 s = 360°。这就是"没校准"的实际后果 ——
不是因为噪声大，而是因为有一个**恒定的偏移**，而积分器最怕的就是恒定偏移。

### 6.2 解法：趁它不动的时候偷偷量一下

> So the rate is watched for **stillness** — a short window in which the three rates barely move
> **and the accelerometer reads one g** — and **the mean over such a window is taken as the bias**.

三个条件缺一不可：

1. **三个轴的角速度几乎不动**（在一段时间内）；
2. **加速度计读数接近 1 g**（说明没在晃）；
3. 持续**够久**。

满足全部三条，就把这段窗口内角速度的**平均值**当成零偏。

> 💡 为什么"不动"要用均值而不是瞬时值？
> 因为静止时读数是 `真值 + 零偏 + 噪声`。真值是 0，所以均值 ≈ 零偏。
> **平均是在从噪声里把那个常数捞出来。**

### 6.3 学不到之前怎么办

```rust
// lib.rs:238
let bias = self.bias.value.unwrap_or([0.0; 3]);
```

**用 0 顶着** —— 也就是"先按没零偏算"。而 `bias_dps()` 会**诚实地返回 `None`**：

```rust
// lib.rs:205-207
/// The gyro bias in use, °/s — `None` while it is still being learned.
pub fn bias_dps(&self) -> Option<[f32; 3]> {
    self.bias.value
}
```

**"还没学会"和"零偏是 0"是两件不同的事**，而 API 把它们分开了。

### 6.4 学会了之后也不是一锤定音

```rust
// lib.rs:139-149
// Blend with what is already known rather than jumping: two still windows a minute
// apart disagreeing by a tenth of a degree per second should not make the attitude
// twitch each time.
self.value = Some(match self.value {
    Some(old) => [0.5 * (old[0] + mean[0]), ...],   // 新旧各一半
    None => mean,                                     // 第一次就直接用
});
```

**"两个相隔一分钟的静止窗口差 0.1 °/s，不该让姿态每次抖一下。"**
所以第二次以后取的是**新旧平均**（本质上是个两点滑动平均）。

> 💡 这也解释了为什么零偏是**热漂移友好**的：手柄放久了、温度变了，
> 只要它再静止一次，零偏就会被重新估计并**慢慢**跟上。

---

## 7. 那个"静止窗口"是怎么判的

```rust
// lib.rs:52-59
/// How long the rates have to hold still before a bias is taken from them, seconds.
const STILL_WINDOW_S: f64 = 0.5;

/// How far the rates may wander across a still window and still count as still, °/s.
///
/// **Above the clone's noise (about one °/s peak to peak at rest)** and **well below the slowest
/// turn a hand makes on purpose**.
const STILL_SPREAD_DPS: f32 = 3.0;
```

**0.5 秒的窗口，期间三个轴的角速度极差不能超过 3 °/s。**
3.0 这个数字也是两头夹出来的：**比噪声（约 1 °/s 峰峰值）高，比人故意转的最慢速度低得多。**

### 7.1 窗口记账

```rust
// lib.rs:86-96
struct Bias {
    /// The bias in use, °/s. `None` until the first still window completes.
    value: Option<[f32; 3]>,
    /// The window under way: when it opened, what it has seen.
    since_us: Option<u64>,
    min: [f32; 3],
    max: [f32; 3],
    sum: [f64; 3],
    count: u32,
}
```

一个滚动窗口，用**极差**（`max − min`）判"稳不稳"，用**和**算均值。
注意 `sum` 是 **`f64`** 而其他是 `f32` —— 一秒几百个样本累加，用 `f64` 免得精度丢在加法里。

### 7.2 ⚠️ 两条"重开"的路径

```rust
// lib.rs:110-116（节选）
fn observe(&mut self, raw_dps: [f32; 3], gravity_ok: bool, at_us: u64) {
    if !gravity_ok {
        self.reset_window();
        return;
    }
```

**第一条：加速度计说"在动"，立刻重开窗口。** 理由（`lib.rs:110-111`）：

> Only samples taken while the accelerometer reads gravity count: **a pad in motion can have a
> quiet gyro for a moment and still not be at rest.**

**"一个在动的手柄可以有一瞬间陀螺是安静的，但它并不静止。"**

```rust
// lib.rs:128-132
if spread > STILL_SPREAD_DPS {
    // Moved. Start over from here rather than waiting the window out.
    self.reset_window();
    return;
}
```

**第二条：角速度极差超了，也重开** —— 而且注释点明了是**"从这里重开"**，
不是"把窗口耗完再说"。因为窗口的两端必须是连续静止的。

---

## 8. `sample()`：一个采样的完整旅程

```rust
// lib.rs:218
fn sample(&mut self, sample: &proto::PadImuSample)
```

按顺序：

| 步 | 干什么 | 行 |
|---|---|---|
| 1 | **把原始整数换成物理单位**（用设备报的分辨率） | `:221-232` |
| 2 | 算加速度模长，判断**"这是不是重力"** | `:235-236` |
| 3 | **喂给零偏学习器** | `:237` |
| 4 | **减掉零偏**，存下来 | `:238-244` |
| 5 | 算**时间间隔** `dt`，更新速率估计 | `:246-259` |
| 6 | **还没种子？** 用重力种一次，然后返回 | `:261-267` |
| 7 | **陀螺积分** | `:272-275` |
| 8 | **重力修正** | `:282-291` |
| 9 | **归一化** | `:292` |

### 8.1 单位换算

```rust
// lib.rs:221-232
let accel_scale = scale(self.device.accel_per_g);
let gyro_scale = scale(self.device.gyro_per_dps);
let accel = [sample.accel[0] as f32 * accel_scale, ...];
let raw_gyro = [sample.gyro[0] as f32 * gyro_scale, ...];
```

线上传的是**原始内核整数**，加上设备声明的分辨率。`hid-nintendo` 报的是
**4096 单位/g** 和 **14247 单位/(°/s)**。

```rust
// lib.rs:358-366
/// Units per physical unit → physical units per raw unit. **A driver that declared no resolution
/// leaves the numbers raw, which is at least not wrong.**
fn scale(per_unit: i32) -> f32 {
    if per_unit > 0 { 1.0 / per_unit as f32 } else { 1.0 }
}
```

⚠️ 但这个"至少不算错"有个**没说出口的下场**：分辨率是 0 时，原始值（约 4096）会被
当成"g"来用，于是 `norm(accel) ≈ 4096` 落在 `GRAVITY_BAND` 外面 ——
**永远不会种子，`quaternion()` 永远返回 `None`。** 见 §14。

### 8.2 为什么有个 `seq` 却不用它

`PadImuSample` 有个 `seq` 字段（"Samples since this IMU attached"），
而 `sample()` **一次都没读它**。间隔完全用**内核时间戳** `at_us` 算。

理由在 `duck-ipc-proto` 的 `PadImuSample` 文档里：`seq` 的用途是
**"A hole is a batch this subscriber missed — `PadImuBatch::socket_dropped`"** ——
也就是给读者发现**丢包**用的，不是给积分器算时间的。

### 8.3 ⭐ `MAX_DT_S`：太长的间隔，量它但不积分它

```rust
// lib.rs:61-65
/// Longest gap between two samples the integrator will bridge, seconds.
///
/// Beyond it the pad was silent — a dropped batch, a paused reader — and **integrating one stale
/// rate over the whole gap would throw the attitude**. **The sample is taken; the interval is
/// not.**
const MAX_DT_S: f32 = 0.05;
```

**"采样照收，间隔不算。"** 50 ms 对应 20 Hz —— 低于这个速率就不敢信了。

```rust
// lib.rs:253-259
if dt > 0.0 && dt <= MAX_DT_S {
    let hz = 1.0 / dt;
    self.rate_hz = Some(match self.rate_hz {
        Some(rate) => rate + 0.02 * (hz - rate),   // 平滑
        None => hz,
    });
}
// ...
// lib.rs:268-270
if dt <= 0.0 || dt > MAX_DT_S {
    return;                                        // ← 不积分
}
```

**注意这两处是分开的**：速率估计**用**这个间隔（它是个测量），
积分**不用**（它是个坏主意）。这就是注释那句 "measured (for the rate) but not integrated"。

### 8.4 种子：第一次知道"上"在哪

```rust
// lib.rs:261-267
if !self.seeded {
    if gravity_ok {
        self.q = from_gravity(accel);
        self.seeded = true;
    }
    return;
}
```

`from_gravity`（`:424-443`）算的是**"把测到的'上'转到世界的'上'，且不带 yaw"**的最小旋转。
注释（`:421-423`）：

> The body → world rotation that carries the measured up (the accelerometer at rest) onto the
> world's up, **with no yaw**. **The seed, and what the filter would converge to if the gyro said
> nothing.**

**"没有 yaw"** 是关键：重力**观察不到朝向**（绕竖直轴转多少，重力都一样），
所以种子只能把 pitch 和 roll 定下来，yaw 从 0 开始。这直接导致了 §9.2 的问题。

### 8.5 那个"倒过来"的特判

```rust
// lib.rs:430-436
if s < 1e-6 {
    return if c > 0.0 {
        [1.0, 0.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0, 0.0]      // upside down: any horizontal axis will do
    };
}
```

叉积接近 0 意味着"测到的上"和"世界的上"**平行或反平行**。
正平行就是恒等；**反平行（手柄倒过来）时轴不确定 —— 随便挑一根水平轴**。
`[0,1,0,0]` 是绕 X 轴转 180°。

> 💡 这是这个仓库里反复出现的同一个品味的第四次：
> **退化的时候要退到一个"合法的、能看的结果"，而不是 `NaN`。**
> （前三次：`kinematics` 的 `Quat::normalized`、`tof` 的 `level_from_gravity`、`odometry` 的 `normalized4`。）

---

## 9. ⭐ 两种漂移，两种治法

这是整份文档最该记住的一节。

### 9.1 pitch 和 roll：重力管着，不会漂

因为重力**能观察到**倾斜。所以只要手柄偶尔静止一下，pitch 和 roll 就会被拽回真值。
**时间常数 0.5 秒，永远不累加。**

### 9.2 yaw：只有陀螺说话，一定会漂

重力**观察不到朝向** —— 你把一个手柄在桌面上转 90°，它读到的重力方向一模一样。

所以（`lib.rs:13-15`）：

> yaw comes from the gyro alone and **drifts**, which is honest: **nothing on a pad can observe
> heading.** Whoever uses yaw **has to re-zero it now and then**, and [`relative`] is how.

**"诚实"** 这个词用得很准：这不是算法不够好，是**信息根本不存在**。

### 9.3 `relative()`：治漂移的办法

```rust
// lib.rs:310-315
/// The rotation from `reference` to `now`, **in the body frame of `reference`**: what a pad has
/// done since the moment `reference` was taken. **This is how a consumer of yaw beats the drift** —
/// take a fresh reference when the person says "this is centre", and read everything after it
/// relative.
pub fn relative(reference: [f32; 4], now: [f32; 4]) -> [f32; 4] {
    normalized4(mul(conj(reference), now))
}
```

**一行。** 就是 `conj(基准) × 当前`。

**漂移是"基准本身偏了"，而相对姿态把基准整个减掉了。**
所以每次你重新取一次基准，之前积累的 yaw 漂移就**一次性归零**。

### 9.4 这在机器人上长什么样

`padd` 就是这么用的（`padd/src/main.rs:334-344`）：

> Y was pressed with an IMU pad and the feature on. Off or holding → follow **from here**, which is
> what beats the gyro's yaw drift: **every re-entry makes the pad's current attitude the new
> centre.** Following → hold.

操作者视角（`robot/cheatsheet.md:528-533`）：

> Y changes meaning on such a pad: the first press hands the head to the pad — tilt it and the head
> tilts, turn it and the head turns — while the sticks go on driving the body. Press Y again and the
> head stays where it is. ... **A third press hands the head back to the pad from where the pad is
> *now*.**

**"第三次按下，从手柄现在的位置重新交给它。"** 这就是 `relative()` 在真实交互里的样子。

---

## 10. 手搓的四元数算术

`lib.rs:308-443`，12 个小函数。和 `kinematics` 一样是**手搓的**，
但**用的是 `f32` 而不是 `f64`**，而且**没有对 MuJoCo 那样的外部基准**。

| 函数 | 行 | 干什么 |
|---|---|---|
| `mul` | `:392` | 四元数乘法 |
| `conj` | `:401` | 共轭（逆旋转） |
| `rotate` | `:416` | 用四元数转一个向量 |
| `from_rotvec` | `:406` | 小旋转向量 → 四元数 |
| `from_gravity` | `:424` | 重力 → 姿态种子 |
| `normalized4` | `:376` | 四元数归一化 |
| `matrix` | `:332` | 四元数 → 旋转矩阵 |
| `euler_deg` | `:321` | 四元数 → 欧拉角 |
| `norm` `normalized` `cross` `scale` | `:354` `:368` `:384` `:360` | 向量小工具 |

**约定：`w` 在前**（和 `kinematics` 一致）。

两个和 `kinematics` 一样的退化保护：

```rust
// lib.rs:376-382（normalized4）
if n < 1e-9 { return [1.0, 0.0, 0.0, 0.0]; }     // 坏的四元数 → 恒等，不是 NaN
```

```rust
// lib.rs:368-374（normalized）
if n < 1e-9 { return [0.0, 0.0, 1.0]; }           // 零向量 → "上"，是个合法的方向
```

> 💡 **为什么是 `f32` 而不是 `f64`？** 这里没写理由，但答案在模块末尾：
> *"A few dozen multiplications per sample. **Six hundred a second** are a rounding error next to
> reading them off the kernel."*
> 六百赫兹的浮点精度不是问题；**`f32` 够用，而且更省。**
> 对比 `kinematics` 用 `f64` —— 那边跑在 50 Hz 且要和 MuJoCo 对到 1e-6。

---

## 11. ⚠️ `euler_deg` 的返回顺序是个陷阱

```rust
// lib.rs:317-329
/// Pitch, roll and yaw of a body → world rotation, degrees.
///
/// **Aerospace order** — yaw about Z, then pitch about the body's Y (nose up positive), then roll
/// about its X (left side up positive) — read off the rotation matrix.
pub fn euler_deg(q: [f32; 4]) -> [f32; 3] {
    let m = matrix(q);
    let pitch = (-m[2][0]).clamp(-1.0, 1.0).asin();
    let roll = m[2][1].atan2(m[2][2]);
    let yaw = m[1][0].atan2(m[0][0]);
    let deg = 180.0 / std::f32::consts::PI;
    [pitch * deg, roll * deg, yaw * deg]      // ← 注意这个顺序
}
```

⚠️ **返回的是 `[pitch, roll, yaw]`** —— **不是**常见的 `[roll, pitch, yaw]`，
也**不是** `[yaw, pitch, roll]`。

**这个顺序很容易记反，而记反了不会报错，只是三个数各自装错了轴。**
好消息是类型都是 `f32`，编译器帮不上忙；坏消息是**画面/头部会以"看起来也像那么回事"的方式错**。

两个真实消费者都是**解构**取的，所以顺序是显式的：

```rust
// padd/src/main.rs:366
let [pitch, roll, yaw] = pad_imu::euler_deg(relative);
```

```rust
// imu_view 和 monitor 也是
let [pitch, roll, _] = imu.euler_deg();
```

> 💡 公式本身是标准的 **ZYX（航空航天）序**：
> `R = Rz(yaw)·Ry(pitch)·Rx(roll)`，从矩阵里读出来就是那三行。
> `pitch` 那行还有个 `.clamp(-1.0, 1.0)` —— 因为浮点误差可能让 `asin` 的输入
> 差一点点越过 ±1，而 `asin(1.0000001)` 是 `NaN`。

---

## 12. 两个消费者怎么用它

### 12.1 `padd`：手柄的倾斜 → 机器人的头

`padd` 的 tap 里存着一整个 `pad_imu::Imu`（`padd/src/tap.rs:125`），
每读一批就喂给它，主循环来问姿态：

```rust
// padd/src/tap.rs:262-270
pub fn attitude(&self) -> Option<[f32; 4]> {
    self.shared.attitude.lock()... .and_then(pad_imu::Imu::quaternion)
}
```

然后（`padd/src/main.rs:355-366`）：

```rust
fn head_from_pad(relative: [f32; 4], gain: f64, max_head: f64) -> proto::HeadParams {
    let [pitch, roll, yaw] = pad_imu::euler_deg(relative);
    let angle = |degrees: f32| (f64::from(degrees).to_radians() * gain).clamp(-max_head, max_head);
    proto::HeadParams {
        neck_pitch: 0.0,
        head_pitch: angle(pitch),
        head_yaw: angle(yaw),
        head_roll: -angle(roll),          // ← 注意这个负号
    }
}
```

里面有两句话值得抄下来。**第一句关于符号**（`main.rs:358-363`）：

> The signs are the ones that made the head copy the pad on the robot (2026-09-09): pad nose-up is
> a positive `head_pitch`, pad yaw to the left a positive `head_yaw`, and the pad rolling right
> (left side up) a negative `head_roll`. **Pitch and roll came out opposite to the stick mapping's
> guess, which is worth knowing: the sticks' signs describe "stick up looks up", not the joint
> axes, and the pad frame is the joints'.**

**"摇杆的符号说的是'推上去就是往上看'，不是关节轴；而手柄的坐标系是关节那一套。"**
这两套东西的"上"正好相反，所以符号得实测。

**第二句关于脖子**（`main.rs:363-364`）：

> **The neck stays at zero: one pitch joint is enough to follow a wrist.**

**"一个 pitch 关节足够跟住一只手腕了。"** 所以 `neck_pitch` 恒为 0。

### 12.2 `robotctl monitor`：画一个跟真的转的线框手柄

`robotctl/src/imu_view.rs:3-7`：

> The attitude comes from the `pad-imu` crate — **the same filter `padd` poses the head with** —
> and this module only draws it. **A dozen line segments rasterised into half-block pixels,
> redrawn at the monitor's own pace rather than the IMU's**: six hundred samples a second is a rate
> for a filter, not for a terminal.

两件事：**同一个滤波器**（所以画的和头不会打架），以及**按终端的节奏重画**，不是按 IMU 的。

线框是"一块平板 + 两个握把 + 两个摇杆 + 前沿的标记"，从一个固定的四分之三视角看。

`robotctl/src/monitor.rs:1241` 起的 `render_imu` 还会显示速率、加速度、以及**学到的零偏**：

```rust
let bias = match imu.bias_dps() {
    Some(b) => /* 显示三个数 */ + " — removed from the rates above",
    None => /* 显示"还在学" */,
};
```

---

## 13. 测试：5 个

```bash
cargo test -p pad-imu
```

五个，全在 `lib.rs:445-602`，**一个都没有 `#[ignore]`**：

| 测试 | 行 | 验什么 |
|---|---|---|
| `a_pad_at_rest_reads_level_and_learns_its_bias` | `:497` | 躺着不动 → 水平 + **学到 12 °/s 的零偏** + 速率 ≈ 200 Hz |
| `a_tilt_reads_as_pitch_whether_seeded_or_integrated` | `:519` | **两条路走到同一个答案** |
| `motion_neither_corrects_the_attitude_nor_teaches_a_bias` | `:546` | 晃动时既不修正姿态，也不学零偏 |
| `a_long_gap_is_not_integrated` | `:561` | 3 秒的间隔不被积分 |
| `a_relative_attitude_starts_from_zero_and_reads_the_turn_since` | `:580` | 相对姿态从 0 开始，之后的转动读得出来 |

### 13.1 那个最漂亮的测试

`a_tilt_reads_as_pitch_whether_seeded_or_integrated`（`:519`）同时验了**两条完全不同的路径**：

```
路径 A：直接从一个倾斜的加速度计种子
路径 B：先水平放着学会零偏，再用 60 °/s 转半秒（加速度计说"在动"，所以只有陀螺说话）
        → 30°
然后放回倾斜的静止姿态 → 重力认可并保持住
```

三条断言都指向 30°。**这就是互补滤波器的定义在测试里被验了一遍**：
短期靠陀螺、长期靠重力、两条路必须一致。

### 13.2 测试怎么造数据

```rust
// lib.rs:486-492
/// Feed `seconds` of a steady reading at 200 Hz.
fn steady(imu: &mut Imu, seconds: f32, accel_g: [f32; 3], gyro_dps: [f32; 3]) {
    let n = (seconds * 200.0) as u64;
    let start = imu.last_us.unwrap_or(0);
    for i in 1..=n {
        imu.absorb(&one(sample(i, start + i * 5_000, accel_g, gyro_dps)));
    }
}
```

`sample()` 那个辅助函数（`:461`）做的是**反向的换算**：给它物理单位，
它乘回 4096 / 14247 变回原始整数。**所以整条路径（换算→滤波→欧拉角）都被测到了**，
而不是绕开换算直接喂物理单位。

而且 `steady` 接着上次的 `last_us` 继续，所以连续的 `steady` 调用像是**一个连续的时间轴** ——
这也是为什么 `a_long_gap_is_not_integrated` 能手动插一个 3 秒的洞进去。

---

## 14. 几处读者会绊到的地方

按仓库的规矩，代码与文档不一致的地方，这里只**陈述事实**，不判断该怎么办。

### 14.1 分辨率是 0 时，下场比注释说的严重

```rust
// lib.rs:358-359
/// Units per physical unit → physical units per raw unit. A driver that declared no resolution
/// leaves the numbers raw, **which is at least not wrong**.
```

实际上：原始值（约 4096）会被当成"g"，于是 `norm(accel) ≈ 4096` 落在
`GRAVITY_BAND`（0.85..=1.15）外面 —— 于是

- **永远不会种子**，`quaternion()` 恒为 `None`；
- **零偏永远学不到**，`bias_dps()` 恒为 `None`。

所以后果不是"数字是原始的"，而是**这块手柄完全提供不了姿态**。
（从"不要发布错数字"的角度看这是安全的降级，但注释没说到这一层。）
`hid-nintendo` 报的是 4096 和 14247，所以真手柄走不到这条路。

### 14.2 `duck-ipc-proto` 说"换算发生在 viewer 里"

`PadImuSample` 的文档（`duck-ipc-proto/src/lib.rs`）说：

> Raw kernel units, deliberately — the tap hands out what the device said and the resolution to
> read it with, and **the conversion happens once, in the viewer**.

而换算现在发生在 `pad-imu`，它的消费者**两个**：`robotctl`（确实是 viewer）
和 `padd`（是控制回路，不是 viewer）。措辞停留在只有 viewer 一个消费者的时期。

### 14.3 `rate_hz` 的平滑系数是"每采样"的，不是"每秒"的

```rust
// lib.rs:255-258
self.rate_hz = Some(match self.rate_hz {
    Some(rate) => rate + 0.02 * (hz - rate),
    None => hz,
});
```

固定 `0.02` 的指数平滑，**每次采样一次**。所以在 600 Hz 下时间常数约 83 ms，
在 200 Hz 下约 250 ms —— 同一个 `0.02` 表示不同的时间。只影响显示，不影响滤波。

### 14.4 `STILL_SPREAD_DPS` 的注释引用了没写出的速率

```rust
// lib.rs:55-59
/// How far the rates may wander across a still window and still count as still, °/s.
///
/// Above the clone's noise (about one °/s peak to peak at rest) and well below the slowest turn a
/// hand makes on purpose.
```

`max − min` 是**极差**，和"峰峰值"在概念上接近但不完全一样；
而且这个窗口有 0.5 秒长，样本数取决于实际速率（文档别处提到 600/s 和 200/s 两个数字）。
数字是对的（3.0 确实在这两头中间），只是"峰峰值"这个词用得比较松。

---

## 15. 阅读路线

很小，可以一次读完。

| 步 | 读什么 | 为什么先读它 |
|---|---|---|
| 1 | `pad-imu/Cargo.toml`（1-5 行） | 五句话说清"为什么它自己是一个 crate" |
| 2 | `pad-imu/src/lib.rs:1-35` | 模块文档 = **整个设计**。坐标轴那段尤其要看 |
| 3 | `pad-imu/src/lib.rs:39-65` | 五个常数，**每个都解释了两头夹在哪** |
| 4 | `pad-imu/src/lib.rs:110-161` | `Bias::observe` —— 零偏是怎么学的 |
| 5 | `pad-imu/src/lib.rs:218-293` | `sample()`。**§8 那张表就是它** |
| 6 | `pad-imu/src/lib.rs:310-329` | `relative` 和 `euler_deg` 两个公开函数 |
| 7 | `pad-imu/src/lib.rs:497-601` | 五个测试，比文档更能说明它保证了什么 |
| 8 | `padd/src/main.rs:330-367` | 它在真机器人上变成什么（`head_from_pad`） |

**如果只有十分钟**：读模块文档那 35 行，然后读 §3 和 §9 两张表。

三条贯穿全文的主线：

1. **两个传感器互补**。一个短期准会漂，一个长期准怕动 —— 各取所长。
2. **退化要退到合法值**。零向量 → "上"；坏四元数 → 恒等；倒过来 → 随便一根水平轴。
   全仓库同一个品味。
3. **诚实地报告"还不知道"**。`bias_dps()` 的 `None`、`quaternion()` 的 `None`、
   种子之前"只有默认值没有姿态"—— **"还没学会"和"是零"从来不混为一谈。**

---

## 16. 术语表

| 词 | 意思 |
|---|---|
| **IMU** | 惯性测量单元。陀螺仪 + 加速度计（这里是六轴） |
| **陀螺仪（gyro）** | 测**角速度**（转多快）。积分得到角度 |
| **加速度计（accel）** | 测**加速度**，包含重力。静止时指着"下" |
| **姿态（attitude / orientation）** | "朝哪"。这里是一个四元数，body → world |
| **互补滤波器** | 陀螺管短期、加速度计管长期的融合方法 |
| **零偏（bias）** | 传感器在"什么也没发生"时的非零读数。这里的陀螺有约 12 °/s |
| **漂移（drift）** | 误差随时间累积。零偏积分出来的就是它 |
| **静止窗口** | 一段"角速度不抖 + 加速度计读 1 g"的区间，用来量零偏 |
| **极差（spread）** | 最大值减最小值。这里用它判"稳不稳" |
| **重力带（`GRAVITY_BAND`）** | 0.85~1.15 g。出了这个范围说明在动，重力不可信 |
| **种子（seed）** | 第一次用重力定出姿态。在它之前没有姿态 |
| **时间常数** | 误差衰减到 1/e 需要的时间。增益 2.0 → 0.5 秒 |
| **四元数** | 表示旋转的四个数。这里 `w` 在前 |
| **共轭（conjugate）** | 四元数的"逆旋转" |
| **旋转向量（rotvec）** | 轴 × 角度，一种紧凑的旋转表示 |
| **欧拉角** | pitch / roll / yaw 三个角 |
| **pitch / roll / yaw** | 抬头低头 / 左右翻滚 / 左右转头 |
| **body frame** | 手柄自己的坐标系。+X 前、+Y 左、+Z 上 |
| **world frame** | 世界坐标系。重力沿 −Z |
| **相对姿态（`relative`）** | 相对于某个基准的变化量。**治 yaw 漂移的办法** |
| **重新取基准（re-zero）** | 趁现在这一刻把漂移归零 |
| **evdev** | Linux 的输入设备接口。手柄走它 |
| **`hid-nintendo`** | 内核里那个驱动。它报出 4096 单位/g 和 14247 单位/(°/s) |
| **分辨率（resolution）** | 驱动声明的"一个物理单位等于多少个原始计数" |
| **`#[ignore]`** | 默认不跑。**这个 crate 一个都没有** |
| **`f32` vs `f64`** | 单精度 / 双精度浮点。这里用 `f32`，因为 600 Hz 且精度不是瓶颈 |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| 操作者视角：Y 键怎么用 | [`robot/cheatsheet.md`](robot/cheatsheet.md) §手柄 |
| `[pad_imu_head_control]` 的 schema 和 `gain` | [`robotd-params-primer.md`](robotd-params-primer.md) |
| 手柄怎么配对（姊妹篇） | [`robot/pair-a-gamepad.md`](robot/pair-a-gamepad.md) · [`configd-primer.md`](configd-primer.md) |
| `PadImuBatch` 那些线上类型（姊妹篇） | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| 另一套四元数实现，用 `f64` 且有 MuJoCo 基准（姊妹篇） | [`kinematics-primer.md`](kinematics-primer.md) §5 |
| 控制环里那个"手柄和远程 peer 抢方向盘"的问题 | [`design/remote-webrtc.md`](design/remote-webrtc.md) §9 |
| 控制循环本身（姊妹篇） | [`robotd-primer.md`](robotd-primer.md) |
| 笔记本上的客户端：`monitor`（姊妹篇） | [`duckctl-primer.md`](duckctl-primer.md) |
| 蓝牙门房（姊妹篇） | [`btd-primer.md`](btd-primer.md) |
| BLE 的线上契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| 控制核心：从读总线到写总线（姊妹篇） | [`duck-control-primer.md`](duck-control-primer.md) |
| 摄像头里的鸭子检测（姊妹篇） | [`duck-detect-primer.md`](duck-detect-primer.md) |
| 仿真的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| 发布怎么把自己装到板子上（姊妹篇） | [`hooks-primer.md`](hooks-primer.md) |
| 板子被配置成什么样子（姊妹篇） | [`deploy-primer.md`](deploy-primer.md) |
| 机器人走到哪了（姊妹篇） | [`odometry-primer.md`](odometry-primer.md) |
| 摄像头、WebRTC、远程网关（姊妹篇） | [`mediad-primer.md`](mediad-primer.md) |
| 它的两个消费者之一：手柄控头（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| 摸头检测：麦克风、log-mel、那个门控（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| `monitor` 那个线框手柄（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| 装机、更新、诊断的那些工具（姊妹篇） | [`scripts-primer.md`](scripts-primer.md) |
| 鸭子的嗓子：可播种的合成器（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 头部的两个传感器：深度与 IMU（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
