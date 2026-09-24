# `odometry` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> 里程计的机制由 [`design/robotd-design.md`](design/robotd-design.md) §4.4 拥有（英文）。
> 它脚下的几何来自 [`kinematics-primer.md`](kinematics-primer.md) —— **这份导读最好和那篇一起读**：
> 那篇讲"关节角变成空间中的点"，这篇讲"**这些点里哪一个踩在地上**"。
>
> 姊妹篇：[`robotd-primer.md`](robotd-primer.md)（它是这个结构体唯一的调用者）。

## 目录

1. [一分钟版](#1-一分钟版)
2. [它在整个系统里的位置](#2-它在整个系统里的位置)
3. [⭐ 核心心智模型：一只脚踩在地上，躯干从它推出来](#3--核心心智模型一只脚踩在地上躯干从它推出来)
4. [目录导览](#4-目录导览)
5. [`update()`：一次 tick 的五步](#5-update一次-tick-的五步)
6. [⭐ `reproject`：那三行就是全部](#6--reproject那三行就是全部)
7. [`lowest_corner`：谁在下头](#7-lowest_corner谁在下头)
8. [⭐ 三个常数，两条防抖规则](#8--三个常数两条防抖规则)
9. [连续性：为什么换锚点不会跳](#9-连续性为什么换锚点不会跳)
10. [`anchors.rs`：三套候选点，和一场 3.2 米的实测](#10-anchorsrs三套候选点和一场-32-米的实测)
11. [⚠️ 它不知道的事](#11-️-它不知道的事)
12. [谁在用它](#12-谁在用它)
13. [测试：8 个，其中 2 个是手动工具](#13-测试8-个其中-2-个是手动工具)
14. [几处读者会绊到的地方](#14-几处读者会绊到的地方)
15. [阅读路线](#15-阅读路线)
16. [术语表](#16-术语表)

---

## 1. 一分钟版

`odometry` 回答一个问题：

> **机器人从开机到现在，走到哪儿了？**

它是个**纯结构体**，554 行，没有 socket、没有线程、没有 `main`。`robotd` 在控制环里每个 tick 调它一次：

```rust
// robotd/src/main.rs:2060-2062
if safety.imu_ready() {
    odometry.update(&fresh.positions, fresh.imu.quat);
}
```

一句话说清它的定位：

> **它是"机器人走到哪了"的唯一答案，而它靠的是自己的脚和 IMU —— 没有任何外部定位。**

`Cargo.toml:6-8` 讲清了为什么它不是一个服务：

> **No dedicated service**: it is a pure struct `robotd` ticks inside its control loop, because
> **its inputs are exactly the sample the loop already holds.**

**它的输入就是控制环本来就拿在手里的那个采样。** 再加一个服务、一条 socket、一次序列化，
只是为了把已经在那儿的数字搬个地方。

---

## 2. 它在整个系统里的位置

`odometry` 是个小 crate，只依赖两个东西：

```toml
# odometry/Cargo.toml:16-18
[dependencies]
duck-ipc-proto = { path = "../duck-ipc-proto" }   # JOINT_NAMES
kinematics = { path = "../kinematics" }           # 脚底在哪（正向运动学）
```

**只有 `robotd` 依赖它**（`robotd/Cargo.toml:13`）。

```
       robotd 的 50 Hz 控制环
              │
              ├─ 从总线读关节角 + 从 IMU 读姿态      ← 这一份采样本来就有
              │
              ▼
       odometry.update(joints, quat)              ← 一次 update
              │
              ▼
       odometry.position() / yaw()
              │
              ▼
       robot.state 的 odom 字段 ──► robotctl monitor 的路径地图
```

### 设计文档怎么说它

`design/robotd-design.md` §4.4：

> `odometry::Odometry::alpha()` is stepped once per tick from the joint positions and the IMU
> quaternion the loop has just read, and its estimate goes out on the state stream as
> `odom: { position, yaw }`. `robotctl monitor` draws it as a path map under the 3D view.
>
> It costs the loop **two chain evaluations per tick and no extra bus traffic**, which is why it
> runs at the loop's own rate rather than the prototype's separate 100 Hz. That cost is the reason
> the "no odometry" decision in §7 was **reversed rather than re-argued**: the objection was never
> the arithmetic, **it was that nothing read the answer**.

**"当初反对的理由从来不是算术，而是没有人读那个答案。"**

设计文档 §7 那张表里，这一行的写法很说明问题：

> | ~~no odometry~~ — reversed | `monitor`'s path map reads it, and it is one `kinematics` pass on a sample the loop already took (§4.4) |

**它是被划掉又翻回来的。**

---

## 3. ⭐ 核心心智模型：一只脚踩在地上，躯干从它推出来

这是整份代码唯一的想法，值得慢慢讲。

### 3.1 一句话

> **任何时刻，总有一只脚的一个点是和地面接触的。**
> **把那个点钉在世界坐标上，躯干的位置就由它反推出来。**

模块文档（`lib.rs:4-10`）：

> The idea: at any moment **one point of one sole is the robot's contact with the ground**. Anchor
> that point to the world (it is on flat ground, so **its world Z is 0** and its world X/Y are
> wherever it was when it became the anchor), orient the trunk by the IMU, and **the trunk's world
> position follows by forward kinematics**. When some other sole corner drops below the anchor — a
> step — the anchor moves there, at that corner's current world X/Y, **so the estimate never jumps.**

拆开来看就是四句话：

1. 地上那个接触点，**世界 Z 一定是 0**（地面是平的）。
2. 它的世界 X/Y 是**它成为锚点那一刻的值**，之后就钉住不动。
3. 躯干朝哪，**IMU 说了算**。
4. 于是躯干在世界里的位置 = 从锚点倒推出来 —— 因为**从躯干到那只脚的向量**是可以算的
   （这就是 `kinematics` 干的活）。

### 3.2 为什么这样能工作

关键在于**"脚在地上"这件事把世界坐标系的某一部分免费给了你**。

假设你只知道"脚相对于躯干在哪"（FK 能算）和"躯干朝哪"（IMU 能给），
你仍然不知道**机器人在世界的哪个位置** —— 这是个自由变量。

但如果你知道**脚正踩在地面上**，你就知道那只脚的**世界 Z 是 0**。
这一个约束就消掉了那个自由变量：躯干的世界 Z 也就跟着确定了，X/Y 则由"锚点钉住"确定。

> 💡 这就是所谓的**接触式里程计**（contact odometry）。
> 它不是"积分速度"，而是"**每一刻重新从接触点解一次位置**"——
> 所以它不会积累积分误差，但会积累**接触判断**的误差。

### 3.3 两个坐标系，别搞混

这是读这份代码最容易乱的地方：

| 名字 | 是什么 |
|---|---|
| **世界坐标系（world）** | Z 轴朝上，地面是 Z = 0。原点在**机器人开机时脚下** |
| **躯干坐标系（trunk）** | 原点在躯干。`kinematics` 的所有输出都在这个系里 |

代码里到处在做这两者之间的转换，靠的就是那个**IMU 四元数**：

```rust
let in_world = rot.rotate(feet[foot].transform_point(corner));
//              ↑ 躯干→世界（转）      ↑ 脚→躯干（FK）
```

**从右往左读**：先把候选点从**脚的坐标系**变到**躯干坐标系**（`transform_point`，这是 FK），
再用 IMU 的姿态把它转到**世界朝向**（`rotate`）。

### 3.4 世界原点在哪

**"机器人开机时朝哪，那个方向就是世界的 +x；开机时脚下就是原点。"**

模块文档（`lib.rs:19-21`）：

> Heading is whatever the IMU's integrated yaw says — **there is no magnetometer**, so the world
> frame is **"wherever the robot was looking at boot"**, which is all a relative-motion consumer
> needs.

**没有磁力计**，所以没有绝对方向。这不是缺陷，是刻意的取舍 —— 见 §11。

---

## 4. 目录导览

```
odometry/
├── Cargo.toml     18 行  —— 头 8 行讲清"为什么它不是一个服务"
└── src/
    ├── lib.rs    441 行  全部算法（含 8 个测试）
    └── anchors.rs 95 行  三套候选接触点（**生成的文件**）
```

两个文件，一件事。`Cargo.toml` 的头 8 行值得先读。

---

## 5. `update()`：一次 tick 的五步

```rust
// odometry/src/lib.rs:123
pub fn update(&mut self, joints: &[f64; JOINT_NAMES.len()], quat_wxyz: [f64; 4])
```

注意签名本身就在说一件事：**关节角按 `JOINT_NAMES` 排序**，而 `JOINT_NAMES` 有 **15** 个
（含嘴）—— 而模型的关节只有 **14** 个。这个差在第一步就被处理掉了。

| 步 | 干什么 | 行 |
|---|---|---|
| 1 | **按名字重排关节角**到模型顺序 | `:124-128` |
| 2 | 归一化 IMU 四元数 | `:129-130` |
| 3 | **算两只脚的位姿，各一次** | `:133-136` |
| 4 | 首次 update：**把锚点种在实际起始姿态上** | `:138-142` |
| 5 | **重投影**，然后看看要不要换锚点 | `:144-172` |

### 步 1：那个 `Option<usize>`

```rust
// lib.rs:57-59
/// `JOINT_NAMES` position → model joint index. `None` for the mouth, which
/// moves no leg.
joint_map: [Option<usize>; JOINT_NAMES.len()],
```

`robotd` 给的是**线上顺序**的 15 个关节角；模型要的是**MJCF 顺序**的 14 个。这张表在构造时建好一次：

```rust
// lib.rs:89
joint_map: JOINT_NAMES.map(|name| model.joint_index(name)),
```

**嘴那一路是 `None`** —— 因为 `joint_index("mouth")` 找不到（MJCF 里嘴不是关节）。
测试 `the_mouth_moves_no_odometry`（`:356`）把这件事钉死了：

```rust
let mut open = quiet;
open[9] = 42.0;          // 嘴张到 42 弧度
// ... 断言：位置完全一样
```

### 步 3：为什么是"各一次"

模块文档（`lib.rs:15-17`）：

> Each foot's chain is evaluated once per tick and its four corners are transformed through the
> result; **the prototype re-walked a full leg chain per corner (9 chain evaluations per tick,
> now 2).**

**原型对每个角点重走一遍整条腿链** —— 9 次链求值一个 tick，现在是 **2 次**。
走出来的角点再各自做一次便宜的坐标变换就够了。

### 步 4：为什么要有 `needs_init`

```rust
// lib.rs:73-75
/// True until the first update seeds `anchor_xy` from the actual startup
/// pose, so the trunk starts at (0, 0) instead of offset by the foot.
```

如果不种这一下，第一次 update 时锚点默认在 `(0, 0)`，而脚实际在别处 ——
于是**机器人一开机就"站"在一个偏移了的位置上**。种下去之后，开机位置就是原点。

---

## 6. ⭐ `reproject`：那三行就是全部

```rust
// odometry/src/lib.rs:202-210
/// Trunk position from the anchor: the contact point sits at
/// (`anchor_xy`, 0), the trunk is minus the world-rotated trunk→contact
/// vector away from it.
fn reproject(&mut self, rot: Quat, feet: &[Pose; 2]) {
    let contact_in_trunk = feet[self.anchor_foot].transform_point(self.anchor_local);
    let contact = rot.rotate(contact_in_trunk);
    self.position = [
        self.anchor_xy[0] - contact[0],
        self.anchor_xy[1] - contact[1],
        -contact[2],
    ];
}
```

**整个估计器就是这三行。** 逐行读：

1. `feet[anchor_foot].transform_point(anchor_local)`
   —— 把"接触点在我这只脚里的位置"变成"**接触点在躯干里的位置**"。
   这是正向运动学，由 `kinematics` 完成。

2. `rot.rotate(...)`
   —— 把它从**躯干朝向**转到**世界朝向**。现在 `contact` 是
   "**从躯干指向接触点的向量，用世界的方向表示**"。

3. `position = anchor_xy − contact`（X/Y），`position[2] = −contact[2]`
   —— 因为接触点的世界位置是 `(anchor_xy, 0)`，而躯干在
   **减去那个向量**的地方。

> 💡 **Z 那一行最值得看**：`-contact[2]`。
> 接触点的世界 Z 是 **0**（定义如此），所以 `position[2] = 0 - contact[2]`。
> **躯干的高度是"接触点相对于躯干有多低"直接取负** —— 不需要任何额外信息。
> 这就是 §3.2 说的那个"免费拿到的约束"。

---

## 7. `lowest_corner`：谁在下头

```rust
// odometry/src/lib.rs:214-232（节选）
fn lowest_corner(&self, rot: Quat, feet: &[Pose; 2]) -> Option<(usize, [f64; 3], [f64; 2])> {
    let mut lowest = -SWITCH_MARGIN;
    let mut best = None;
    for foot in [LEFT, RIGHT] {
        for &corner in self.anchors.foot(foot) {
            let in_world = rot.rotate(feet[foot].transform_point(corner));
            let world = [
                self.position[0] + in_world[0],   // ← 加上躯干自己的位置，
                self.position[1] + in_world[1],   //   才是这个世界里的坐标
                self.position[2] + in_world[2],
            ];
            if world[2] < lowest {
                lowest = world[2];
                best = Some((foot, corner, [world[0], world[1]]));
            }
        }
    }
    best
}
```

**它扫过两只脚的所有候选点，挑出世界里最低的那一个。**

注意那个 `+ self.position`：前一步算出的是"相对于躯干"的向量，
加上躯干自己的位置才是**世界坐标**。少了这一步，比较的就是一堆相对高度，没有意义。

返回的是 `(哪只脚, 脚坐标系里的点, 它的世界 X/Y)` —— 正好是换锚点需要的三样东西。

---

## 8. ⭐ 三个常数，两条防抖规则

```rust
// odometry/src/lib.rs:39-50
/// A candidate corner must sit below world Z = `-SWITCH_MARGIN` to bid for the
/// anchor. The anchor itself sits at Z = 0, so the margin is slack for FK and
/// IMU noise, not a physical depth.
const SWITCH_MARGIN: f64 = -0.010;

/// Ticks a candidate must stay the lowest point before the anchor moves. At
/// the control loop's 50 Hz this is 40 ms — well inside a stance phase, well
/// past a one-tick glitch.
const SWITCH_CONFIRM_TICKS: u32 = 2;

const LEFT: usize = 0;
const RIGHT: usize = 1;
```

### 8.1 ⚠️ 那个双负号

`SWITCH_MARGIN` 是 **−0.010**，而门槛用的是 **`-SWITCH_MARGIN` = +0.010**：

```rust
let mut lowest = -SWITCH_MARGIN;      // = +0.010
if world[2] < lowest { ... }          // 世界 Z < +0.010 就能竞选
```

所以**门槛是"比其他候选低，而且低于 +1 厘米"**。
注释说的 "below world Z = `-SWITCH_MARGIN`" 字面上是对的（门槛**就是** `-SWITCH_MARGIN` 这个值），
但一个负的常数叫 `MARGIN`、然后取负当门槛用，很容易读反 —— 见 §14。

那一厘米的余量的用途，注释写了：**是给 FK 和 IMU 噪声的松弛，不是物理深度。**

### 8.2 时间确认：为什么要等两个 tick

```rust
// lib.rs:146-148
// A corner below the anchor is a step landing — but only after it holds
// the claim for SWITCH_CONFIRM_TICKS, so FK jitter cannot walk the
// anchor around mid-stance.
```

**"这样 FK 抖动就没法在支撑相中间把锚点拖着走。"**

而且注意那个计数器**只在"还是同一只脚"的时候才累加**（`:155-160`）：

```rust
if self.pending.is_some_and(|(pf, _, _)| pf == foot) {
    self.pending_ticks += 1;
} else {
    self.pending = Some((foot, local, world_xy));
    self.pending_ticks = 1;          // ← 换了一只脚就从头数
}
```

所以一次单 tick 的抖动把最低点挪到**另一只脚**上，是永远赢不了的 ——
下一个 tick 最低点回到原处，计数就从 1 重新开始。

测试 `the_anchor_switches_only_after_the_claim_holds`（`:372`）把两种情况都钉住了：
**抖一个 tick 偷不走锚点，稳定保持几 tick 就必须赢。**

### 8.3 那 40 ms 是怎么算的

`SWITCH_CONFIRM_TICKS = 2`，控制环 **50 Hz** → 一个 tick 20 ms → **两个 tick 是 40 ms**。

注释：*"well inside a stance phase, well past a one-tick glitch"* ——
**远短于一个支撑相，又远长于一次单 tick 故障。**

> 💡 这个常数**绑在控制环的频率上**，而 `robotd` 是 50 Hz。
> 如果哪天环的频率变了，这 40 ms 会跟着变，而这里没有东西会发现。

---

## 9. 连续性：为什么换锚点不会跳

```rust
// lib.rs:161-170
if self.pending_ticks >= SWITCH_CONFIRM_TICKS {
    let (foot, local, world_xy) = self.pending.take().expect("just matched");
    self.anchor_foot = foot;
    self.anchor_local = local;
    // The corner keeps the world X/Y it already has, so the
    // estimate is continuous across the switch.
    self.anchor_xy = world_xy;
    self.reproject(rot, &feet);
    self.pending_ticks = 0;
}
```

**新锚点保留它"此刻已经算出来"的世界 X/Y**（`anchor_xy = world_xy`），
而不是"就地重新开始计数"。所以：

- 换锚点**前一瞬间**：躯干位置 = `旧anchor_xy − 旧contact`
- 换锚点**后一瞬间**：躯干位置 = `新anchor_xy − 新contact`
- 而 `新anchor_xy` 就是那个新角点**在这个 tick 的世界坐标**，
  `新contact` 也正是从躯干指向它的向量 —— 两者相减得到的**就是同一个躯干位置**。

**数学上恒等，所以不跳。** 这就是模块文档那句 "so the estimate never jumps" 的全部含义。

测试 `stance_leg_motion_translates_the_trunk_continuously`（`:402`）用另一种方式验它：
让髋关节扫 0.2 弧度，断言**每个 tick 的位移都小于 2 厘米**（`:431`），
同时总位移大于 5 毫米（`:435`）—— 也就是**动了，但没有瞬移**。

### 一个容易忽略的推论

因为 `pending_ticks` 在切换后被清 0，**在静止站立时锚点其实每两个 tick 就重新锚一次**
（最低角点一直是同一个，所以每次都满足确认条件）。这没问题 ——
那个角点没动，世界 X/Y 也就没变。

**换锚点不是罕见事件，它是常态。** `SWITCH_CONFIRM_TICKS` 保护的不是"锚点被换"，
而是"**换到了一只刚才还在半空中的脚**"。

---

## 10. `anchors.rs`：三套候选点，和一场 3.2 米的实测

```rust
// odometry/src/anchors.rs:8-13
pub struct AnchorSet {
    pub name: &'static str,
    pub left: &'static [[f64; 3]],
    pub right: &'static [[f64; 3]],
}
```

三套，都是为了回答"脚上哪几个点可能踩到地"：

| 名字 | 多少个点 | 是什么 |
|---|---|---|
| `V15` | 4 | **旧的**：v1.5 鞋底的包围盒，在 site 的 Z = 0 平面上 |
| `ALPHA4` | 4 | alpha 鞋底**平接触面**的四个角，**在网格上** |
| `ALPHA16` | 16 | alpha 整个脚印（**含倒角**）上的 4×4 网格，在网格上 ✅ **现役** |

### 10.1 那场 3.2 米的实测

模块文档（`lib.rs:27-31`）：

> [`Odometry::alpha`] uses [`ALPHA16`], a 4x4 grid over the whole sole on the mesh:
> **in the MuJoCo twin over a 3.2 m walk it drifted 9 mm** where the legacy v1.5 bbox ([`V15`])
> drifted **17 mm** and the flat patch's four corners ([`ALPHA4`]) **16 mm**, and **it stands at
> the true height** (V15 sat 3.7 mm high). **The scan costs about half a microsecond more.**

| 集合 | 3.2 米走完漂了 | 站着的高度 |
|---|---|---|
| `ALPHA16` | **9 mm** | 正确 |
| `ALPHA4` | 16 mm | — |
| `V15` | 17 mm | 高了 3.7 mm |

**多花半微秒，漂移减半，而且站对了高度。** 这就是它成为默认值的全部理由
（提交 `dd0f8c2`：`odometry: ALPHA16 is the default anchor set`）。

> 💡 为什么点多了反而更准？因为**"最低点"这个判断本身依赖采样密度**：
> 只有四个角的时候，脚侧倾一点点，"最低的那个角"就换人了，而真实的接触面可能还在中间。
> 16 个点让"最低点"更接近真实的接触位置。**V15 偏高的原因也是这个** ——
> 它的点在 Z = 0 平面上，而真实的鞋底是有厚度的、有倒角的。

### 10.2 它是生成的文件

```rust
// odometry/src/anchors.rs:4-6
//! GENERATED by microduck_rl/scripts/odom_anchor_points.py — do not edit:
//!   odom_anchor_points.py --rust /home/antoine/Pollen/microduck/odometry/src/anchors.rs
//! from src/mjlab_microduck/robot/microduck/scene.xml.
```

这些点是**在鞋底的网格模型上采样**出来的，采样脚本住在**另一个仓库**
（[`microduck_rl`](https://github.com/pollen-robotics/microduck_rl)，见 §14）。

测试 `alpha_anchor_sets_lie_on_the_sole`（`:251`）守着一堆几何不变量：

- 每个点都在脚底脚印范围内（X ∈ [−0.021, 0.035]，Y ∈ [−0.022, 0.022]，Z ∈ [−0.002, 0.012]）；
- **右脚是左脚的镜像**（在 Y 上取反，容差 3e-4）；
- `ALPHA4` 有 4 个点，`ALPHA16` 有 16 个。

那个镜像检查有个细节（`:259-260`）：

> Each foot is sampled on its own mesh, so the order differs; the right sole is the left one
> mirrored in Y (to the sampling step).

**顺序不一样** —— 所以它检查的是"存在一个镜像"，不是"第 n 个对第 n 个"。

---

## 11. ⚠️ 它不知道的事

这一节比算法重要。`odometry` 是一个**知道自己局限**的估计器。

### 11.1 它会漂，而且不修正

`docs/robot/cheatsheet.md:85-87`：

> There is no magnetometer, so **this is relative motion and it drifts**; it answers
> **"did it walk in a circle"** and not **"where is it"**.

设计文档 §4.4 说得更细：

> **There is no magnetometer and nothing corrects drift**; this is relative motion, and **every
> consumer has to treat it that way.**

### 11.2 它假设地面是平的

整个算法建立在"接触点的世界 Z 是 0"上。**上了台阶、踩到斜坡，这个假设就破了。**

### 11.3 yaw 只能是相对的

```rust
// odometry/src/lib.rs:174
self.yaw = rot.yaw();
```

`yaw` 直接来自 IMU 的积分。`kinematics/src/math.rs:81` 的 `Quat::yaw` 用的是
旋转矩阵 `(1,0)` 对 `(0,0)` 元素的 `atan2`。

**它不是"机器人朝北"，而是"机器人相对于开机时那个方向转了多少"。**

### 11.4 alpha only

> Alpha only, like the daemon: **v1/v1.5 geometry stayed in the prototype.**（`lib.rs:23`）

`V15` 那套点还在代码里，但**只是为了对照和测试**，没有哪只真机器人用它。

### 11.5 只在 IMU 收敛后才开始

`robotd` 那边的门：

```rust
// robotd/src/main.rs:2057-2059
// Only once the orientation filter has converged: seeding the anchor from a
// quaternion that is still swinging would put the world origin somewhere the
// robot never was. A coasted tick is skipped too — repeating a stale sample
// into the estimator would tell it the robot froze, which it did not.
if safety.imu_ready() {
    odometry.update(&fresh.positions, fresh.imu.quat);
}
```

两句理由都值得记：

- **四元数还在摆的时候种锚点，会把世界原点放在机器人从来没去过的地方。**
- **一个"滑行"的 tick（coasting）也要跳过** —— 把过期采样重复喂进估计器，
  等于告诉它"机器人冻住了"，而它没有。

---

## 12. 谁在用它

### 12.1 线上：`robot.state` 的 `odom`

```rust
// robotd/src/main.rs:3228-3231
odom: proto::OdomState {
    position: odometry.position(),
    yaw: odometry.yaw(),
},
```

```rust
// duck-ipc-proto/src/lib.rs:3791-3797
pub struct OdomState {
    /// Trunk position, metres. Z is height above the ground plane.
    pub position: [f64; 3],
    /// Heading, radians.
    pub yaw: f64,
}
```

**注意 Z 也被发出去了** —— 而它有个消费者，见下。

### 12.2 `robotctl monitor`：两处

**① 一行数字**（`robotctl/src/monitor.rs:2103-2109`）：

```
 odom    x  +0.42 m  y  -1.03 m  yaw 23.5°
```

**② 一张盲文地图**（`robotctl/src/path_map.rs`，353 行）：

> A top-down map of where odometry says the robot has been. … The panel's size never changes —
> instead the **world** scales, zooming out as the track grows so the whole path is always in
> frame. **Drawn in braille (2×4 dots per cell)**, which is the finest resolution a terminal offers
> for a line that curves.

约定（`path_map.rs:10-13`）：**世界 +x（开机朝向）朝屏幕上方，世界 +y（左）朝屏幕左方** ——
也就是"你站在机器人起始姿态上方往下看"看到的样子。原点是 `+`，机器人是 `●` 加一条朝向射线。

### 12.3 ⭐ 一个不明显的消费者：ToF 的地板判断

```rust
// robotctl/src/monitor.rs:2533-2540
// The trunk's own tilt and measured height, so a robot leaned by hand
// still calls the floor the floor. Odometry Z of zero means "no
// estimate" (an older robotd, or an unconverged IMU) — fall back to
// the model's rest height rather than believing the trunk is buried.
let posture = kinematics::tof::Posture {
    gravity: state.safety.gravity,
    trunk_height_m: (state.odom.position[2] > 0.02).then_some(state.odom.position[2]),
};
```

**里程计测出来的躯干高度，被拿去当 ToF 判地板的"传感器离地多高"用了。**

而且这里有个漂亮的细节：`position[2] > 0.02` —— **Z 接近 0 被当作"没有估计"**，
退回模型里的静态高度，而不是"相信躯干埋在地下"。

> 💡 这条把 [`kinematics-primer.md`](kinematics-primer.md) §10.3 那个
> `above_floor = sensor_level[2] + posture.trunk_height_m` 补完了：
> 那个 `trunk_height_m` 在生产里**就是里程计给的**。

### 12.4 两个还没有消费者的公开方法

| 方法 | 文档怎么说 |
|---|---|
| `anchor_xy()`（`:190`） | *"For telemetry; `position` is the answer."* |
| `anchors()`（`:114`） | 返回这个估计器在用的锚点集 |

两个在 `odometry` 之外都没有调用者 —— 是**故意公开的遥测口子**，不是死代码。

---

## 13. 测试：8 个，其中 2 个是手动工具

```bash
cargo test -p odometry                              # 6 个
cargo test -p odometry -- --ignored --nocapture      # 另外 2 个
```

| 测试 | 行 | 验什么 |
|---|---|---|
| `alpha_anchor_sets_lie_on_the_sole` | `:251` | 几何不变量 + 左右镜像 |
| `standing_still_stays_at_the_origin` | `:332` | 站着不动就**精确地**在原点上 |
| `yaw_follows_the_imu` | `:345` | yaw 就是 IMU 的 yaw |
| `the_mouth_moves_no_odometry` | `:356` | 嘴张 42 弧度也不动 |
| `the_anchor_switches_only_after_the_claim_holds` | `:372` | 单 tick 抖动偷不走，稳定保持必须赢 |
| `stance_leg_motion_translates_the_trunk_continuously` | `:402` | 动了，但每 tick 步长 < 2 cm |
| `dump_reference_trajectory` | `:280` | **`#[ignore]`** —— 给 Python 复刻版的基准数据 |
| `update_cost_per_anchor_set` | `:306` | **`#[ignore]`** —— 测三套锚点各花多少时间 |

### 13.1 `standing_still_stays_at_the_origin` 断言的是**精确相等**

```rust
assert!(x.abs() < 1e-9 && y.abs() < 1e-9, "drifted to ({x}, {y})");
assert!(z > 0.02, "trunk should stand above the ground, z = {z}");
assert_eq!(odo.yaw(), 0.0);
```

容差是 **1e-9**，不是 1e-3。能这么严，是因为**这里没有积分** ——
同样的输入喂 200 次，每次都是同一个确定性的重投影，不是累加。
这正是 §3.2 说的"每一刻重新解一次"的好处。

同时它检查 `z > 0.02` —— **躯干确实站在地面之上**，而不是塌在 0。

### 13.2 ⭐ 那两个 `#[ignore]` 不是测试，是**工具**

**[1] `dump_reference_trajectory`（`:280`）—— 和另一个仓库的一致性锚点**

```rust
/// Reference trajectory for the Python replica in
/// `microduck_rl/scripts/infer_policy.py` (`PyOdometry`): the same joint
/// and IMU sequence fed to both must give the same positions.
```

它给出一串定死的关节角和 IMU 序列（几条正弦），把每一步的位置打印成
`REF <set> <i> <x> <y> <z> <foot>`。

**为什么要有这个？** 因为这套里程计的存在意义之一是**训练时用的观测**：
策略在 MuJoCo 里训练时看到的位置，必须和真机器人上算出来的一致。
所以有一个 Python 复刻版，而这个测试是**两边对齐的凭证**。

它打印三种锚点集的轨迹（`V15`、`ALPHA4`、`ALPHA16`），所以换锚点的影响是可见的。

**[2] `update_cost_per_anchor_set`（`:306`）—— 定尺寸用的**

```rust
/// Cost of one `update` per anchor set, for sizing the set the robot
/// runs. `cargo test -p odometry --release -- --ignored --nocapture`.
```

20 万次 update，打印每套的 `ns per update`。注释里的 **"for sizing the set the robot runs"**
说明了它的用途 —— §10.1 那句"多花半微秒"就是从这里来的。

> 💡 这和 [`kinematics-primer.md`](kinematics-primer.md) §12.2 的 `perf_probe` 是同一个做法：
> **墙上时钟不进断言，数字打在终端上给人看。** 一条忽快忽慢的 CI 只会教人学会忽略红色。

两个都必须手动跑，而且第二个**必须加 `--release`** —— debug 下的数字没有意义。

---

## 14. 几处读者会绊到的地方

按仓库的规矩，代码与文档不一致的地方，这里只**陈述事实**，不判断该怎么办。

### 14.1 那个负的 `SWITCH_MARGIN`

```rust
const SWITCH_MARGIN: f64 = -0.010;      // lib.rs:42
let mut lowest = -SWITCH_MARGIN;        // lib.rs:215 → +0.010
```

语义上是对的（门槛就是 `-SWITCH_MARGIN`，注释也是这么写的），
但一个**负值**的常数叫 `MARGIN`、然后**取负**当门槛用，读起来要绕一下。见 §8.1。

### 14.2 生成的文件里有一个开发者的家目录

```rust
// odometry/src/anchors.rs:5
//!   odom_anchor_points.py --rust /home/antoine/Pollen/microduck/odometry/src/anchors.rs
```

生成命令里带着**绝对路径**（`/home/antoine/...`）。它只是一条注释，不影响行为，
但它记的是**生成那一刻某台机器上的路径**。

### 14.3 `SWITCH_CONFIRM_TICKS` 的单位是 tick，而注释按 50 Hz 算

```rust
// lib.rs:44-47
/// Ticks a candidate must stay the lowest point before the anchor moves. At
/// the control loop's 50 Hz this is 40 ms — well inside a stance phase, well
/// past a one-tick glitch.
const SWITCH_CONFIRM_TICKS: u32 = 2;
```

常数本身是 tick 数，**没有绑定频率的机制**。`robotd` 改频率时这里不会报错，
只会悄悄变成另一个时间窗口。

### 14.4 两份文档对"几个消费者"的说法不一致

`design/robotd-design.md:134` 说 `kinematics` 有 **two** consumers
（`odometry` 和 `robotd` 的头部 FK），而实际有四个（还有 `robotctl` 和 `robotd-params`）。
详见 [`kinematics-primer.md`](kinematics-primer.md) §2。

---

## 15. 阅读路线

这个 crate 很小，可以一次读完。

| 步 | 读什么 | 为什么先读它 |
|---|---|---|
| 1 | `odometry/Cargo.toml`（1-8 行） | 讲清"为什么它不是一个服务" |
| 2 | `odometry/src/lib.rs:1-31` | 模块文档 = **整个算法**。读两遍 |
| 3 | `odometry/src/lib.rs:39-50` | 三个常数，两条防抖规则 |
| 4 | `odometry/src/lib.rs:52-101` | `Odometry` 的字段 + `new`。**每个字段都有注释** |
| 5 | `odometry/src/lib.rs:123-175` | `update()`。**§5 那张表就是它** |
| 6 | `odometry/src/lib.rs:202-210` | `reproject`。**这三行是核心** |
| 7 | `odometry/src/lib.rs:214-232` | `lowest_corner` |
| 8 | `odometry/src/anchors.rs` | 数据。对着 §10 的表读 |
| 9 | `odometry/src/lib.rs:332-441` | 四个"行为"测试，比文档更能说明它想保证什么 |

**如果只有十分钟**：读模块文档（`lib.rs:1-31`），然后读 `reproject` 那三行，再读 §11。

三条贯穿全文的主线：

1. **每一刻重新解一次，不积分**。所以站着不动是 1e-9 级的精确，代价是**接触判断错了就全错**。
2. **能省的都要省**。它跑在 50 Hz 的环里，所以：脚链一次 tick 算两遍而不是九遍、
   名字→索引在构造时做掉、锚点集是编译进来的常量。**"两个链求值，零额外总线流量"是它敢跑在环里的理由。**
3. **知道自己不知道什么**。没有磁力计就不假装有绝对方向；IMU 没收敛就不种锚点；
   滑行的 tick 就跳过；Z 接近 0 就当"没有估计"。**每一条都在代码里写明了。**

---

## 16. 术语表

| 词 | 意思 |
|---|---|
| **里程计（odometry）** | 估计"走了多远、朝哪"。区别于"定位"（知道自己在地图上的绝对位置） |
| **接触式里程计** | 靠"哪只脚踩在地上"来推位置，而不是靠积分速度 |
| **锚点（anchor）** | 那个被认为**正踩在地面上**的点。世界 Z 定义为 0 |
| **`anchor_local`** | 锚点在**那只脚自己的坐标系**里的位置 |
| **`anchor_xy`** | 锚点在**世界**里的 X/Y。成为锚点那一刻定下，之后钉住 |
| **重投影（reproject）** | 从锚点倒推躯干位置。**这个 crate 的核心动作** |
| **正向运动学（FK）** | 给关节角，算各部位在哪。`kinematics` 的活 |
| **world frame** | 世界坐标系。原点在开机时的脚下，+x 是开机时的朝向 |
| **trunk frame** | 躯干坐标系。`kinematics` 的所有输出都在这个系里 |
| **yaw** | 绕垂直轴的旋转（"朝哪"） |
| **四元数（quat）** | 表示旋转的四个数，这里是 `[w, x, y, z]` |
| **IMU** | 惯性测量单元：陀螺仪 + 加速度计 |
| **磁力计** | 能测出绝对方向（"北在哪"）的传感器。**这只鸭子没有** |
| **支撑相（stance phase）** | 走一步的过程中，脚踩在地上那一半 |
| **漂移（drift）** | 误差随时间累积。**这里累积的是接触判断的误差，不是积分误差** |
| **滑行（coast）** | 没读到新采样时，用上一条顶着。**估计器要跳过这种 tick** |
| **site** | `kinematics` 里贴在刚体上的一个有名坐标点。脚底是两个 site |
| **包围盒（bbox）** | 把物体整个包住的最小方盒子。`V15` 用的是它 |
| **倒角（bevel）** | 鞋底边缘的斜面。`ALPHA16` 采到了，`ALPHA4` 没有 |
| **MuJoCo 孪生（twin）** | 仿真里那只鸭子。**§10.1 那场 3.2 米的实测是在它上面跑的** |
| **`#[ignore]`** | 默认不跑，要 `--ignored` 手动跑 |
| **盲文（braille）** | 终端里用 2×4 点阵画曲线的方式，比字符格细 |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| 里程计的权威设计（英文） | [`design/robotd-design.md`](design/robotd-design.md) §4.4 |
| 脚底那些点是怎么来的 | [`design/robotd-design.md`](design/robotd-design.md) §4.4 · `microduck_rl` 的 `odom_anchor_points.py` |
| 关节角 → 空间中的点（姊妹篇，**最该一起读**） | [`kinematics-primer.md`](kinematics-primer.md) |
| 那个调用它的控制环（姊妹篇） | [`robotd-primer.md`](robotd-primer.md) |
| 控制核心：从读总线到写总线（姊妹篇） | [`duck-control-primer.md`](duck-control-primer.md) |
| 操作者视角：`monitor` 那张地图怎么看 | [`robot/cheatsheet.md`](robot/cheatsheet.md) |
| `odom` 在线上长什么样（姊妹篇） | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| 笔记本上的客户端：`monitor`（姊妹篇） | [`duckctl-primer.md`](duckctl-primer.md) |
| 仿真：`--sim-camera`、MuJoCo 孪生 | [`design/simulation.md`](design/simulation.md) · [`robot/simulation.md`](robot/simulation.md) |
| 摄像头、ToF 的另一个消费者（姊妹篇） | [`mediad-primer.md`](mediad-primer.md) |
| wifi、身份、手柄配对（姊妹篇） | [`configd-primer.md`](configd-primer.md) |
| 蓝牙门房（姊妹篇） | [`btd-primer.md`](btd-primer.md) |
| BLE 的线上契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| 摄像头里的鸭子检测（姊妹篇） | [`duck-detect-primer.md`](duck-detect-primer.md) |
| 仿真的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| 发布怎么把自己装到板子上（姊妹篇） | [`hooks-primer.md`](hooks-primer.md) |
| 板子被配置成什么样子（姊妹篇） | [`deploy-primer.md`](deploy-primer.md) |
| 配置文件的 schema（姊妹篇） | [`robotd-params-primer.md`](robotd-params-primer.md) |
| 手柄自己的 IMU：姿态、零偏、yaw 漂移（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| 手柄：按键映射、模式、那个 raw tap（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| 摸头检测：麦克风、log-mel、那个门控（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| `monitor` 那张地图画的是什么（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| 装机、更新、诊断的那些工具（姊妹篇） | [`scripts-primer.md`](scripts-primer.md) |
| 鸭子的嗓子：可播种的合成器（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 头部的两个传感器：深度与 IMU（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
