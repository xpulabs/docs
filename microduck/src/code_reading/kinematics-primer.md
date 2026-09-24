# `kinematics` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> 这个 crate 是纯库，没有自己的设计文档；正向运动学的**几何真相**是
> [`../kinematics/assets/alpha/robot_walk.xml`](../kinematics/assets/alpha/robot_walk.xml) 本身。
> 用到它的机制分别由 [`design/robotd-design.md`](design/robotd-design.md)（头部姿态、ToF §4.4 里程计）
> 拥有。若本导读与代码不一致，以代码为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：这份导读最该和 [`duck-control-primer.md`](duck-control-primer.md) 一起读 —— 那篇讲**关节角怎么变成扭矩**，
> 这篇讲**关节角变成空间中的点**。两者共用同一份 MJCF。

## 目录

1. [一分钟版](#1-一分钟版)
2. [它在系统里的位置：四个消费者](#2-它在系统里的位置四个消费者)
3. [核心心智模型：MJCF 是唯一真相，加载时编译一次](#3-核心心智模型mjcf-是唯一真相加载时编译一次)
4. [目录导览](#4-目录导览)
5. [`math.rs`：手搓的四元数](#5-mathrs手搓的四元数)
6. [身体树：14 个关节、8 个 site](#6-身体树14-个关节8-个-site)
7. [`lib.rs`：一次查询就是一次折叠](#7-librs一次查询就是一次折叠)
8. [`mjcf.rs`：解析器只认三样东西](#8-mjcfrs解析器只认三样东西)
9. [`head.rs`：从"看向那个点"到四个关节角](#9-headrs从看向那个点到四个关节角)
10. [`tof.rs`：64 条斜距变成空间中的点](#10-tofrs64-条斜距变成空间中的点)
11. [`hand.rs`：故意做笨的那一个](#11-handrs故意做笨的那一个)
12. [测试：一个真数字和两个探针](#12-测试一个真数字和两个探针)
13. [两处读者会绊到的地方](#13-两处读者会绊到的地方)
14. [阅读路线](#14-阅读路线)
15. [术语表](#15-术语表)

---

## 1. 一分钟版

`kinematics` 回答一个问题：

> **给定 14 个关节角，鸭子的各个部位现在在空间的哪个位置、朝哪个方向？**

这就是**正向运动学**（forward kinematics，FK）。它是个**纯计算库**：

- 没有 socket，没有线程，没有 `main`，不碰硬件。
- 输入是 `&[f64]` 关节角，输出是 `Pose`（位置 + 朝向）。
- 唯一的"输入文件"是编译进二进制的 MJCF（`include_str!`），所以**运行时不需要文件系统**。

```rust
let model = kinematics::Model::alpha();          // 静态单例，解析只发生一次
let head  = model.site("head_camera").unwrap();  // 名字 → 索引，也是在加载时做掉的
let pose  = model.site_pose(head, &angles);      // 一次折叠，无哈希、无分配
```

一句话说清它的定位：

> **它是"鸭子的身体长什么样"这件事的唯一存放处。**

在它出现之前，每个需要知道"脚底在哪""摄像头朝哪"的地方各自手抄一份骨骼尺寸表；
改一次机械结构，要记得改 N 个地方。现在只有一份 `robot_walk.xml` —— **而且那一份就是策略训练时用的那一份**，
所以控制策略眼里的身体和 `robotd` 眼里的身体**不可能不一致**。

---

## 2. 它在系统里的位置：四个消费者

`kinematics` 是 workspace 里最底层的库之一（只依赖 `roxmltree` 和 `thiserror`）。
依赖它的有四个 crate：

| 消费者 | 用它的什么 | 代表作 |
|---|---|---|
| **`robotd`** | 头部 FK、ToF 重投影、整副骨架 | `robotd/src/main.rs:4751-4753`、`mapping` 模块 |
| **`robotctl`** | ToF 重投影（`monitor` 的点云视图） | `robotctl/src/monitor.rs:1402` · `:2520` |
| **`odometry`** | 脚底 site 的位置 | `odometry/src/lib.rs:37` · `:134-135` |
| **`robotd-params`** | 只有 `hand::Config` 的默认值 | `robotd-params/src/lib.rs:684` · `:699` |

设计文档对"为什么要有这个 crate"的说法（`docs/design/robotd-design.md:132-136`）：

> They are separate crates for the same reason `duck-control` is — **the compiler is what keeps
> daemon concerns out of them**, and `kinematics` in particular has two consumers (`odometry`
> and `robotd`'s head FK) that would otherwise **each grow a copy of the model**.

**"否则每一个都会各自长出一份模型的副本。"** 这就是这个 crate 存在的全部理由。

四个里最值得看的是 `robotd`，因为它把 FK 的结果**发到线上**：

```rust
// robotd/src/main.rs:4821 — robot.model 这条调用返回的东西
tof_beams: TOF.beams().to_vec(),
```

```rust
// robotd/src/main.rs:4810 — robot.state 里的 frames
head_imu: FK.head_imu_in_trunk(head).map(pose),
```

也就是说 **`Model::alpha()` 里的几何会经过 IPC 走到笔记本上**：一个把照片和位姿配对的服务，
问 `robot.model` 拿几何，而不是自己再抄一份。这正是一个"唯一真相"该有的样子。

`odometry` 那侧的理由写得最直白（`odometry/src/lib.rs:13-14`）：

> The foot chains come from the `kinematics` crate's MJCF model instead of hand-transcribed
> segment tables — the geometry has one source of truth.

---

## 3. 核心心智模型：MJCF 是唯一真相，加载时编译一次

这是整个 crate 最重要的一件事，值得单独一节。

### 3.1 MJCF 是什么

**MJCF**（MuJoCo XML Format）是 MuJoCo 物理引擎的模型描述语言。一个机器人是一棵树：

```xml
<body name="trunk_base" pos="0 0 0.12" quat="1 0 0 0">
  <body name="neck" pos="0.026 0.0145011 0.0324424" quat="0 -0 -0.707107 0.707107">
    <joint name="neck_pitch" type="hinge" axis="0 0 1" range="..."/>
    ...
  </body>
</body>
```

- `<body>` 是**刚体**（一段不会变形的骨头），`pos`/`quat` 是它**相对于父亲**的固定偏移 —— 这叫 **rest pose**（静止位姿）。
- `<joint>` 是**关节**，装在某个 body 上，让这个 body 能相对父亲动。`type="hinge"` 是"只能绕一根轴转"（铰链）。
- `<site>` 是**一个只有位置和朝向右没有质量的点**，贴在某个 body 上。摄像头、ToF、IMU 都是 site。

### 3.2 它被编译进来，不是读进来的

```rust
// kinematics/src/lib.rs:36
const ALPHA_MJCF: &str = include_str!("../assets/alpha/robot_walk.xml");
```

`include_str!` 是**编译期**宏：XML 的文本在 `cargo build` 时就被塞进二进制了。
所以板上没有这个文件也能跑，也不存在"XML 和二进制版本对不上"这种事。

### 3.3 加载时做一次，之后就只是查表

```rust
// kinematics/src/lib.rs:142
pub fn alpha() -> &'static Model
```

`Model::parse` 在**第一次调用时**做完全部昂贵的工作：

1. 解析 XML，建出 `Vec<Body>` 和 `Vec<Site>`。
2. **把名字换成索引** —— `joint_index("left_knee") -> 3`。之后查询里没有一次字符串比较。
3. **给每个 site 预编译一条从根到它的链**：

```rust
// kinematics/src/lib.rs:54（节选）
pub struct Model {
    ...
    /// One chain per site, root → site, with names resolved to indices. A query walks
    /// only the links the site hangs from.
    chains: Vec<Box<[Link]>>,
}
```

为什么要预编译？看注释里 `Cargo.toml:5-9` 的自述：

> Absorbed from the `microduck_kinematics_rs` satellite repo, reworked for the control-loop
> hot path: joints are indices into a slice rather than names in a `HashMap`, and a site
> query walks its own precompiled chain instead of recomputing every body in the tree.

翻译一下这个改动值多少钱：控制环跑 50 Hz，如果一个 tick 里要问好几个 site，
"重算整棵树"是每个 site 都走一遍 20 个 body，而"走自己的链"平均只走几个。
`tests/perf_probe.rs` 就是拿来量这件事的（见 §12）。

### 3.4 查询是一次折叠

```rust
// kinematics/src/lib.rs:191（节选）
pub fn site_pose(&self, site: SiteId, angles: &[f64]) -> Pose {
    let mut t = Pose::IDENTITY;
    for link in &self.chains[site.0] {
        t = t * link.rest;                              // 先吃下这段骨头的固定偏移
        if let Some((idx, axis)) = link.joint {
            t.quat = t.quat * Quat::from_axis_angle(axis, angles[idx]);  // 再吃下关节转的角度
        }
    }
    t
}
```

三行，两个运算，**没有分支（除了 `if let`）、没有分配、没有哈希**。这就是全部的正向运动学。

注意 `angles[idx]` 里那个 `idx` **不是** 你传进来的数组下标，而是 `Model` 在解析时解析出来的**MJCF 关节序号**。
所以调用者传的角度切片必须按 `model.joint_names()` 的顺序排列 —— 乱序不会报错，只会算出一个安静地错的答案。
`lib.rs` 对此有防守：

```rust
assert_eq!(angles.len(), self.joint_names.len(), "angle slice must cover every joint");
```

而且注释写明了为什么这里该 panic 而不是返回 0：

> a call-site bug, not a robot state, so it panics rather than silently reading zeros.

**"这是调用方的 bug，不是机器人的状态"** —— 这句话是整份代码的品味所在，值得记下来。
长度不对只可能是程序员写错了；而一个全是 0 的关节角是**物理上合法**的姿势，静默地算出来会很难查。

---

## 4. 目录导览

```
kinematics/
├── Cargo.toml                  9 行注释解释"为什么有这个 crate"
├── assets/alpha/
│   └── robot_walk.xml          109 行 —— 唯一的真相（也是策略训练用的那份）
├── src/
│   ├── lib.rs      369 行      Model、SiteId、site_pose、body_poses
│   ├── math.rs     180 行      Quat / Pose，手搓
│   ├── mjcf.rs     231 行      XML → 树，只认 body / hinge joint / site
│   ├── head.rs     366 行      头部 FK + look_at（逆运动学）
│   ├── tof.rs      386 行      64 条斜距 → 空间中的点
│   └── hand.rs     373 行      "那是不是一只手" —— 故意最笨的那个
└── tests/
    ├── fk_against_mujoco.rs   90 行    对 MuJoCo 的 64 组姿势奇偶校验
    ├── fixtures/fk_alpha.json           基准数据
    └── perf_probe.rs          68 行    两个 #[ignore] 的性能探针
```

`src/lib.rs` 顶部是这样导出子模块的（`lib.rs:21-29`）：

```rust
mod math;
mod mjcf;

pub mod hand;
pub mod head;
pub mod tof;

pub use math::{Pose, Quat};
pub use mjcf::ParseError;
```

注意 `math` 和 `mjcf` 是**私有**的：`Pose`/`Quat` 被重导出成公共类型，但解析器不外露。
外面的人不需要知道 XML 是怎么读的。

---

## 5. `math.rs`：手搓的四元数

180 行，实现两个类型：`Quat`（旋转）和 `Pose`（位置 + 旋转）。
没有 `nalgebra`，没有 `glam`，什么都没有。

### 5.1 它是怎么自我辩护的

模块文档写得很直白（`math.rs` 开头）：

> Hand-rolled rather than pulled from nalgebra deliberately... the MuJoCo fixtures in `tests/`
> pin every one of them to 1e-6, which is a stronger correctness argument than a dependency's
> name. What nalgebra would add is compile time, not confidence.

翻译：**"依赖库的名字"不是正确性论据，"和 MuJoCo 对到 1e-6"才是。**
nalgebra 能给的只有更长的编译时间。这是这个仓库里很典型的一种论辩风格：
不要用"这是最佳实践"来结束讨论，要用"它能解决什么这里真实存在的问题"。

### 5.2 约定（这是最容易搞错的部分）

**四元数是 Hamilton 约定，标量在前，存成 `[w, x, y, z]`。**

```rust
// math.rs:19
pub struct Quat {
    pub w: f64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}
```

> ⚠️ 这是**第一号陷阱**。ROS 的 `geometry_msgs/Quaternion` 也是 `x,y,z,w` 顺序，
> 但**存的顺序**和**构造参数的顺序**在别的库里经常反着。这里 `Quat::new(w, x, y, z)`（`math.rs:34`）
> 和结构体字段顺序一致，而且 `wxyz()`（`math.rs:76`）是明确的转换出口 —— 说明作者知道这会咬人。

**乘法是"父乘子"，`a * b` 的意思是"先做 b，再做 a"。**

```rust
// math.rs:127（Pose 的 Mul）
impl Mul for Pose {
    type Output = Pose;
    fn mul(self, rhs: Pose) -> Pose { ... }
}
```

`math.rs:162` 的测试名直接就是这条约定：

```
pose_composition_applies_the_right_operand_first
```

对应到 §3.4 的折叠代码 `t = t * link.rest`：`t` 是"从根走到父亲"的变换，
`link.rest` 是"从父亲走到我"的偏移。左乘把新的变换**接在右边**，正好就是"再往外走一段"。
所以整条链是从根往外一路乘出去的 —— 这就是为什么它能只用一行循环写完。

### 5.3 角落里的小心思

`math.rs:176`：

```
a_broken_quat_normalizes_to_identity_not_nan
```

一个退化的（零长度的）四元数，`normalized()` 返回单位四元数而不是 `NaN`。
这是防御性的：`NaN` 会顺着乘法污染整棵树的每一个位姿，而"没转"至少是个能看的结果。

---

## 6. 身体树：14 个关节、8 个 site

把 `robot_walk.xml` 画出来：

```
trunk_base  pos="0 0 0.12"
│           ↑ 这就是 trunk_height_m() 返回的 0.12
│  ● site: imu_bno        躯干上的 BMI088
│  ● site: imu            躯干上的另一颗
│
├─ yaw2roll ──── joint: left_hip_yaw
│  └─ hip_l ──── joint: left_hip_roll
│     └─ left_upper_leg ── joint: left_hip_pitch
│        └─ leg ────────── joint: left_knee
│           └─ ankle_left ─ joint: left_ankle
│              ● site: left_foot
│
├─ neck ───────── joint: neck_pitch
│  └─ neck_pitch ─ joint: head_pitch
│     └─ yaw_roll_motion ─ joint: head_yaw
│        └─ bottom_head_shell ─ joint: head_roll
│           ● site: head_camera
│           ● site: mouth_tip
│           ● site: tof
│           ● site: head_imu
│
└─ bearing_roll ─ joint: right_hip_yaw
   └─ hip_l_2 ─── joint: right_hip_roll
      └─ right_upper_leg ─ joint: right_hip_pitch
         └─ leg_2 ───────── joint: right_knee
            └─ ankle_right ─ joint: right_ankle
               ● site: right_foot
```

数一下：**14 个 hinge joint，8 个 site**。

### 6.1 为什么是 14 而不是 15？

因为**嘴没有关节**。`mouth_tip` 是一个 site，挂在 `bottom_head_shell` 上，
它跟着头动，但它自己不会动 —— 张合是另一套机制（`duck-ipc-proto` 的 `JOINT_NAMES` 里嘴那一路
在策略的 14 维动作向量里被排除，见 [`duck-control-primer.md`](duck-control-primer.md)）。

> 💡 这是读这个 crate 时**最容易数错**的地方：`JOINT_NAMES` 有 15 个名字，
> `robot_walk.xml` 有 14 个 `<joint>`。**两个数字都对，它们数的不是同一件事。**

### 6.2 名字有点乱的右腿

右腿的 body 叫 `hip_l_2` 和 `leg_2`（`robot_walk.xml:82` · `:92`）——
带 `_l_` 前缀的右腿骨。这是从 MuJoCo 建模工具里导出来时留下的，
**关节名是对的**（`right_hip_roll`、`right_knee`），body 名只是没人用的内部标签。
`body_names()` 会把它们发到线上（`robot.model` 的骨架），所以你在 `robotctl` 里会看到这两个名字。

### 6.3 躯干被"焊"住了

MJCF 里 `trunk_base` 挂着一个 `<freejoint>`（`robot_walk.xml:7`）——
在 MuJoCo 里这意味着"这块可以自由漂浮，由物理决定它在哪"。

但 `mjcf.rs` **不认 `freejoint`**，所以对它来说根永远是固定的。这是**故意的**：

```rust
// kinematics/src/lib.rs:290
fn the_trunk_frame_ignores_where_mujoco_drops_the_robot
```

**这个 crate 的所有输出都在"躯干坐标系"里**，不是世界坐标系。
躯干在地面上的真实位置和倾斜，是 IMU 和里程计的事（`odometry`），不是 FK 的事。
`trunk_height_m()` 只是把 XML 里那个 `0.12` 记下来备用（`lib.rs:173`），
用来回答"如果鸭子站直了，躯干离地多高"。

这个分工很干净：**FK 只管身体内部的相对几何，世界在哪由别人负责。**

---

## 7. `lib.rs`：一次查询就是一次折叠

除了 §3.4 的 `site_pose`，`lib.rs` 还提供两样东西。

### 7.1 `body_poses`：整副骨架

```rust
// kinematics/src/lib.rs:216
pub fn body_poses(&self, angles: &[f64]) -> Vec<Pose>
```

返回**每一个 body** 的位姿，按树的顺序（也就是 `body_names()` / `body_parents()` 的顺序）。
`robotd` 用它渲染一副完整骨架发给客户端（`robotd/src/main.rs:4778` 的 `skeleton_at`）。

和 `site_pose` 的差别：这个**要分配**（`Vec`），而且是全树遍历。
所以它在"给人看"的路径上（一条 `robot.state` 一个 tick 发一次），
不在控制环的内层。

### 7.2 `SiteId`：一个不能被伪造的索引

```rust
// kinematics/src/lib.rs:41
pub struct SiteId(usize);
```

`SiteId` 的字段是**私有**的 —— 外面拿不到里面的 `usize`，只能从 `model.site("名字")` 拿。
这意味着**一个 `SiteId` 一定属于某个 `Model`**，你没法手搓一个越界的下标出来。

这是 Rust 里所谓 **newtype** 模式的一个好例子：用一个单字段结构体把裸 `usize` 包起来，
就免费得到了"类型不同 = 不能混用"的保证。`odometry` 里
`feet: [SiteId; 2]`（`odometry/src/lib.rs:54`）存的就是它 —— 左脚和右脚，
不可能哪天有人把关节序号填进去。

---

## 8. `mjcf.rs`：解析器只认三样东西

231 行，一个手写的 MJCF 子集解析器，基于 `roxmltree`。

**它只认 `<body>`、`type="hinge"` 的 `<joint>`、`<site>`。**
geom、inertial、actuator、sensor、`<asset>`（网格文件）**全部忽略**。

为什么够用？因为这三种东西正好拼出运动学树：
骨头（body）、能动的连接（joint）、感兴趣的参考点（site）。
质量、碰撞形状、电机、传感器 —— 那些是 MuJoCo 训练时才需要的，FK 不问。

### 8.1 输出

```rust
// kinematics/src/mjcf.rs:63-71
pub(crate) struct Tree {
    pub bodies: Vec<Body>,
    pub sites: Vec<Site>,
    pub trunk_pos: [f64; 3],
}
```

注意 `trunk_pos` 是**单独拎出来**的（`mjcf.rs:70`）。
躯干的 `pos` 没有被放进任何 `Pose` 里 —— 因为如上文所说，躯干是原点，
它的位置只是"离地多远"这个数字。

### 8.2 两个已知的窄边界

解析器有两条明确的取舍，写在 `mjcf.rs` 的注释里，值得知道：

1. **一个 body 只取第一个 `<joint>`**（用 `.find()`）。真 MJCF 允许一个 body 挂多个关节
   （比如一个球铰拆成三个 hinge）。鸭子身上每个 body 只有一个，所以够用 ——
   但如果哪天真要加一个"两自由度的脚踝"，这里是静默地丢掉第二个的地方。

2. **`freejoint` 不被识别**（见 §6.3）—— 这是有意的，不是遗漏。

两条都记在 `mjcf.rs` 里，不是藏起来的坑。

---

## 9. `head.rs`：从"看向那个点"到四个关节角

`lib.rs` 解决的是**正**问题（给角度，求位置）。`head.rs` 里有一半解决的是**反**问题：
**给一个想看的点，求四个头部关节该转到哪**（逆运动学，IK）。

### 9.1 为什么鸭子需要这个

因为 `robot.look` 这条 IPC 调用是这么用的：

> 客户端说"看 `(x, y, z)`"，机器人回四个关节角。

为什么回关节角而不是自己闷头转？`robotd/src/main.rs:4295-4298` 的注释说得很清楚：

> so a client can hold the gaze by resending them as `robot.head`, or notice `clamped` and
> move the robot instead. Never refused: an aim is an intent like `robot.head`, and the
> closest-possible gaze at a clamped target is still the most useful thing the head can do.

**"永远不会被拒绝"** —— 够不着就给你够得着的最近的那个，并且告诉你够不着。
这和仓库里"版本差异只记录不拒绝"是同一个世界观。

### 9.2 四个关节和它们的顺序

```rust
// kinematics/src/head.rs:23
const HEAD_JOINTS: [&str; 4] = ["neck_pitch", "head_pitch", "head_yaw", "head_roll"];
```

`HeadFk` 在构造时（`head.rs:43`）把这四个名字解析成 `Model` 的关节索引，
存进 `joints: [usize; 4]`。之后所有操作都在索引上做。

### 9.3 `look_at`：一个真的优化器

这里是整个 crate 里最"算法"的一段。`head.rs:132` 的 `look_at` 不是
"分别算 yaw 和 pitch 该转多少"的朴素解法，而是一个**带阻尼的高斯-牛顿迭代**。

为什么不能分轴算？注释在 `head.rs:120-124` 解释了：

> `head_yaw` in the chain, so pitching tilts the plane yaw pans in, and near ±90° of yaw the
> pitch joint loses elevation authority entirely (its axis aligns with the camera's forward).
> A per-axis update stalls there, so this solves the 2×2 system properly: damped Gauss-Newton
> against the real FK, Jacobian by finite differences — FK is ~50 ns, so the whole solve is a
> couple of microseconds.

翻译：**两个轴不独立**。yaw 转多了以后，pitch 轴会逐渐和摄像头的朝向对齐，
这时候"抬高"这个动作就没有权限了（万向节死锁）。
分轴更新会在这里卡死，所以老老实实解一个 2×2 方程组。

关键参数（`head.rs:133-137`）：

| 参数 | 值 | 意思 |
|---|---|---|
| `TOLERANCE` | `1e-4` | 收敛判据：比任何舵机能跟踪的都紧，又不至于迭代太久 |
| `STEP_H` | `1e-5` | 有限差分的步长（雅可比是数值算的，不是解析的） |
| `LAMBDA` | `1e-3` | Levenberg 阻尼。**专治 yaw 90° 那个奇点**，其他地方多花一次迭代 |
| `MAX_STEP` | `0.7` rad | 单步上限，防止在远处一次跳过头 |
| 迭代次数 | ≤ 30 | |

每一步都把关节角 **clamp 到 MJCF 的 `range` 里**（`head.rs:146` 的 `clamp` 闭包）。
理由（`head.rs:127-129`）：

> the servos enforce those mechanically, so an unclamped answer would be a pose the
> robot cannot hold.

**算出一个机器人摆不出来的姿势是没有意义的** —— 舵机的机械限位不会听你的。

### 9.4 `Gaze::clamped` 的确切含义

```rust
// kinematics/src/head.rs:209
pub struct Gaze {
    pub joints: [f64; 4],
    pub clamped: bool,
}
```

⚠️ **第二号陷阱：`clamped` 不是"撞到限位了"。**

```rust
clamped: residual >= TOLERANCE
```

它说的是 **"解算完了，但还没对准目标"** —— 不管是撞了行程限位，还是纯粹因为几何上顾不过来。
文档原话（`head.rs:130-131`）：

> it is the caller's "the robot is looking as close as it can".

所以 `clamped == true` 的正确读法是 **"尽力了"**，不是 **"坏了"**。

### 9.5 `neck_pitch` 是姿势，不是解

`look_at(target, neck_pitch)` 的第二个参数是**调用方给的**，求解器不碰它：

```rust
let mut joints = [clamp(neck_pitch, range(0)), 0.0, 0.0, 0.0];
```

`head.rs:303` 的测试名就是这条契约：

```
look_at_keeps_the_neck_it_was_given
```

`head_roll` 同理，被固定在 `0.0`。**只有 `head_pitch` 和 `head_yaw` 是解出来的** ——
所以是 2 个未知数、2 个方程的那个 "2×2"。

### 9.6 摄像头坐标：`cv2`

```rust
// kinematics/src/head.rs:16
pub const SITE_TO_CV2: Quat = Quat::new(0.5, -0.5, 0.5, -0.5);
```

`cv2` 是 OpenCV 的相机坐标系：**+x 向右，+y 向下，+z 向前**（沿光轴）。
MJCF 里那个 site 的朝向是建模工具给的，和这个不一样，所以要转一次。

`look_at` 里的误差函数（`head.rs:149`）就是在这个系里算的：
把"目标 − 摄像头位置"这个向量用 `cam.quat.conjugate().rotate(v)` 转到相机系，
然后在 (yaw, pitch) 两个方向上各取一个 `atan2`。

`head.rs:252` 的 `alpha_head_axis_conventions` 把符号钉死了 ——
**`+head_yaw` → `+y`，`+head_pitch` → `−z`**。这个测试存在的原因是：
符号错误算出来的姿态看起来"也像那么回事"，只有对着一个已知的答案才能发现。

---

## 10. `tof.rs`：64 条斜距变成空间中的点

ToF（Time of Flight，飞行时间）传感器返回一个 **8×8 = 64 格**的距离网格 ——
每一格是"沿着这个方向，最近的障碍物有多远"。

但这 64 个数字**单独看没什么用**：你要知道的是**东西在哪**。
`tof.rs` 干的活叫**重投影**（reprojection）：把每一格的"多远"变成躯干坐标系里的一个点。

### 10.1 64 条光线是怎么摆的

```rust
// kinematics/src/tof.rs:28-34
pub const ROWS: usize = 8;
pub const COLS: usize = 8;
const N_ZONES: usize = ROWS * COLS;      // 64
pub const FOV_DEG: f64 = 45.0;
```

视场 45°，排成 8×8。算术在 `tof.rs:108-109`：

```rust
let half = (FOV_DEG / 2.0 - FOV_DEG / (COLS as f64) / 2.0).to_radians();
let step = 2.0 * half / (COLS as f64 - 1.0);
```

读出来是：

- `half` = 22.5° − (45°/8)/2 = 22.5° − 2.8125° = **19.6875°** —— 这是最边上那一条光线的角度。
- `step` = 2 × 19.6875° / 7 = **5.625°** —— 相邻两条的间隔。

**注释里那句 "an 8-zone row has 8 centres, not 9 fenceposts"** 是关键：
8 条光线把 45° 分成 8 份（每份 5.625°），每条光线在**自己那一份的中心**，
所以最外两条不是正好在 ±22.5° 的边界上，而是往里缩了半个格子。
这是个很容易搞错一格的细节。

顺序是 **row-major**，row 0 在最上面，col 0 在传感器自己的左边 ——
和线上协议里 zone 的排列一致。

### 10.2 三个分类：`Zone`

```rust
// kinematics/src/tof.rs:38
pub enum Zone {
    Empty,                          // 这一格什么也没测到
    TooClose { .. },                // 太近了，不可信
    Floor { point },                // 打在地板上
    Hit { point, range },           // 打在某个东西上
}
```

- **`Empty`** —— 没读数。
- **`TooClose`** —— 水平距离小于 `MIN_RANGE_M = 0.10` m（`tof.rs:101`）。
  这不是"东西很近"，而是**传感器自己的串扰**（cover-glass crosstalk）会凭空造出很近的假读数，
  所以这个门槛是"可信度下限"，不是"口味下限"。
- **`Floor`** —— 这条光线打到了地板。
- **`Hit`** —— 打到了别的东西。`range` 是**水平**距离（见下）。

### 10.3 判地板：为什么要在"重力水平系"里做

这是 `tof.rs` 最精妙的一处。

`project` 的输出点**在躯干坐标系里**（和别处一致）。但是**"这是不是地板"这个判断，
不能在躯干坐标系里做** —— 因为鸭子可能正低着头或者歪着身子，
躯干的"下"和世界的"下"根本不是一回事。

所以判断在一个**用重力摆平的坐标系**里做：

```rust
// kinematics/src/tof.rs:203
fn level_from_gravity(gravity: [f64; 3]) -> Quat
```

它算出一个旋转，把**测到的重力方向**转到正下方 `[0, 0, -1]`。
然后：

- 点用 `sensor.quat` 算（躯干系，给人看）；
- **判断**用 `level.rotate(...)` 算（水平系，给规则用）。

注释一句话点题（`tof.rs:153-155`）：

> Points come out in the trunk frame; the floor and range *verdicts* are computed in the
> gravity-levelled frame, because "down" is the IMU's to say, not the trunk's.

**"下"这件事归 IMU 管，不归躯干管。**

判据本身（`tof.rs:167-168`）：

```rust
let above_floor = sensor_level[2] + posture.trunk_height_m.unwrap_or(self.trunk_height_m);
let floor_threshold = above_floor * Self::FLOOR_SAFETY;   // 0.85
```

传感器离地多高，乘以 0.85 —— 也就是说**光线竖直方向走过的距离达到"传感器到地板"的 85%，
就认为它到地板了**。留 15% 是给噪声和地形起伏的余量。
`above_floor` 那行 `unwrap_or(self.trunk_height_m)` 是兜底：IMU 没给躯干高度时用 MJCF 里的静态值。

还有个前提：`downward > 0.0` —— **朝上的光线永远不可能是地板**
（`tof.rs:308` 的测试名：`an_upward_beam_is_never_the_floor`）。

### 10.4 IMU 没收敛时的保护

```rust
// kinematics/src/tof.rs:204-206
let n = (gravity[0]*gravity[0] + gravity[1]*gravity[1] + gravity[2]*gravity[2]).sqrt();
if n < 0.5 {
    return Quat::IDENTITY;
}
```

注释（`tof.rs:200-202`）：

> Identity for a gravity too small to trust — an IMU that has not converged should level
> nothing rather than something random.

**没收敛的 IMU 应该"什么也不摆平"，而不是"随便摆平一下"。**
这是同一个品味的第三次出现（前两次是 §5.3 的 `NaN` 和 §3.4 的 panic）：
**宁可退化成"没做"，也不要退化成"做错了"。**

### 10.5 `beams()` 是给谁用的

```rust
// kinematics/src/tof.rs:135
pub fn beams(&self) -> &[[f64; 3]; N_ZONES]
```

返回 64 条光线的**单位方向向量**（传感器自身坐标系）。`robotd` 把它原样发到线上
（`robotd/src/main.rs:4821`），好让客户端**不必自己重算这套排布**就能画出光线的方向。

> 📌 这段函数的文档注释说它暴露给 "[`crate::hand`]'s plane fit"。
> 那是**过期的说法** —— `hand.rs` 里的平面拟合已经删掉了（见 §11），
> 而且 `hand.rs` 里一次都没出现过 `beams`。真正的消费者是 `robotd`。
> 详见 §13。

---

## 11. `hand.rs`：故意做笨的那一个

`hand.rs` 回答一个问题：**鸭子嘴前面那是不是一只手？**
它是"ToF 特雷门琴"（theremin）的输入 —— 手离得越近，音越高。

### 11.1 它曾经很聪明，然后被删掉了

模块文档（`hand.rs:3-10`）是整份代码里最值得读完的一段：

> This started out clever. It carried a background captured when the theremin armed, so that
> a duck facing a wall could still tell a hand from the wall; a plane fit to exempt walls from
> being mistaken for one enormous hand; a slow drift so the room could be rearranged. **All of
> it worked in tests and none of it survived a duck**, for one reason worth writing down:
> **the sensor's input is not stable enough to reason that hard about.**

翻译：

> 它一开始很聪明。它记了一张"启动时拍下的背景"，这样面对墙的鸭子也能把手和墙分开；
> 一个平面拟合，好让墙不至于被当成一只巨大的手；还有缓慢漂移，好让房间可以被重新布置。
> **这些东西在测试里全都工作，但没有一个活过一只真鸭子。**
> 原因值得写下来：**这个传感器的输入不够稳，经不起这么用力的推理。**

接着是那句结论：

> Cleverness on top of a noisy input multiplies the noise; it does not filter it.

**建立在噪声输入上的聪明是放大噪声，不是过滤噪声。**

### 11.2 现在它做什么

就三件事：

**① 哪些 status 字节值得相信。**

```rust
// kinematics/src/hand.rs:73（Config::default 节选）
statuses: vec![4, 5, 6, 9, 10, 12, 13],
```

ST（STMicroelectronics，传感器厂商）官方把 5 和 9 叫作 "valid"。
但实测（`hand.rs:22-26`）：

> on this sensor at 15 Hz a hand past ~30 cm routinely comes back as 4 or 13 —
> *consistency failed*, sigma too high — carrying a distance perfectly good enough for a pitch.
> **Accepting only 5 and 9 is why the first version died at 30 cm.**

**只信 5 和 9，就是第一版在 30 cm 处死掉的原因。**
每个字节的含义注释里都写了（`hand.rs:68-72`），其中 12 号（"目标被锐利边缘模糊"）
的注解是全场最佳：

> 12 a target blurred by a sharp edge — **which is what the edge of a hand *is***.

这个集合是 **config 而不是常量**，理由（`hand.rs:25-26`）：

> because it is the one number a bench session needs to move.

**"这是台架调试唯一需要动的那个数字。"** 于是它被接到了 `robotd.toml` 上（`robotd-params/src/lib.rs:699`）。

**② 取一个低百分位数，不是最小值。**

```rust
// kinematics/src/hand.rs:162 · :165
in_band.sort_by(...);
let range_m = in_band[in_band.len() / 5];      // 第 20 百分位
```

注释（`hand.rs:163-164`）：

> A low percentile, not the minimum: **single-zone fliers a few centimetres short of the
> truth are routine here**, and as the pitch input one would be a chirp.

**孤立的"飞点"是常态**，用最小值当音高输入会变成一声鸟叫（chirp）。

**③ 一个 hold（保持）。**

```rust
hold: Duration::from_millis(250),
```

15 Hz 下，一格在"可用"和"不可用"之间抖动会把一个音符切成砂砾声。
`hold` 让最后一次的手在丢帧时**多留一会儿**（`hand.rs:149-157`），
于是丢帧听不出来，而手真的拿开时音符还是及时停。

### 11.3 它**不**做的事（也是故意的）

`hand.rs:32-35`：

> There is no floor filter and no reprojection here, on purpose. Both need the head's forward
> kinematics and the IMU, and both were another way for a note to disappear for a reason the
> player cannot see. An instrument that plays the raw beam is one you can predict.

**没有地板过滤，没有重投影，故意的。** 两者都需要头部 FK 和 IMU，
而两者都是"音符因为演奏者看不见的原因消失"的又一种方式。
**一个直接演奏原始光线的乐器，是你预测得了的乐器。**

注意这跟 `tof.rs` 是**刻意的分工**：`tof.rs` 费那么大劲判地板、做重投影，
`hand.rs` 却只要原始读数。这不是谁写错了 —— 而是**两种消费者对"稳"的定义不同**：
一个给可视化用（错了看得见），一个给实时演奏用（错了听得见，而且来不及解释）。

### 11.4 `Hand` 的四个字段

```rust
// kinematics/src/hand.rs:88（节选）
pub struct Hand {
    pub range_m: f64,     // 稳健距离
    pub closeness: f64,   // 0 = 最远，1 = 最近。越近越高
    pub zones: usize,     // 覆盖了几格
    pub held: bool,       // true = 这是"记住的上一帧"，不是这一帧测到的
}
```

`held` 这个字段的存在理由（`hand.rs:99-101`）是：
**让读数能显示"我在补一个丢帧"，而不是假装自己真的看见了。**

`status_histogram`（`hand.rs:190`）是纯诊断，但它是最有用的那个诊断（`hand.rs:186-188`）：

> "it stops working past 30 cm" and "status 4 covers 31 zones of the frame" are the same
> sentence, but only the second tells you what to change.

**"它在 30 cm 外就不工作了"和"这一帧有 31 格是 status 4"是同一句话，
但只有第二句告诉你要改什么。**

---

## 12. 测试：一个真数字和两个探针

测试一共 33 个：

| 位置 | 数量 | 性质 |
|---|---|---|
| `src/lib.rs` | 6 | 单元测试 |
| `src/head.rs` | 7 | 单元测试（含符号约定） |
| `src/tof.rs` | 6 | 单元测试 |
| `src/hand.rs` | 8 | 单元测试（最多） |
| `src/math.rs` | 3 | 单元测试 |
| `src/mjcf.rs` | 0 | —— |
| `tests/fk_against_mujoco.rs` | 1 | **唯一的真数字** |
| `tests/perf_probe.rs` | 2 | **两个 `#[ignore]` 探针** |

### 12.1 `fk_against_mujoco`：那一个数字

```rust
// tests/fk_against_mujoco.rs
fn alpha_matches_mujoco_on_every_site_of_64_random_poses
```

64 组随机姿势，逐 site 比对，容差 `POS_TOL` / `QUAT_TOL` = **1e-6**。

基准数据是 **MuJoCo 自己的 `mj_kinematics`** 生成的：

> The FK's ground truth: MuJoCo's own `mj_kinematics`... generated by `scripts/gen_fixtures.py`
> in the `microduck_kinematics_rs` repo (run via `uv`)... Regenerate it whenever the MJCF
> changes — **the parity is exact (1e-6), so any real divergence fails loudly.**

**这就是 §5.1 那句"1e-6 才是正确性论据"的兑现处。**
这也是为什么这个 crate 敢不用 nalgebra：它有一个比自己更强的裁判。

四元数比对会接受 **±q**：因为 `q` 和 `-q` 表示同一个旋转
（四元数是旋转的**双重覆盖**），不处理这个会得到假失败。

> ⚠️ 这个 fixture 覆盖 **6 个 site**，而模型有 **8 个** —— `imu_bno` 和 `head_imu` 不在里面。
> 详见 §13。

### 12.2 `perf_probe`：两个探针，不是两个测试

```rust
// tests/perf_probe.rs 的模块文档
```

> **Not a test — a probe... Numbers land in the terminal, not in an assertion:
> wall-clock thresholds in CI are flakiness, not coverage.**

**"不是测试，是探针。数字打在终端上，不是断言里：CI 里的墙上时钟阈值是脆弱性，不是覆盖率。"**

这条原则值得记下来。两个探针（都带 `#[ignore]`，要手动跑）：

- `time_site_pose` —— 量 §3.4 那个折叠有多快。
- `time_tof_reprojection` —— 量 64 格重投影有多快。

**只有在你改了 `Model` 的编译策略、或者怀疑某处退化时，才手动跑一次看数字。**
平时不跑，因为一个忽快忽慢的 CI 只会教人学会忽略红色。

---

## 13. 两处读者会绊到的地方

按仓库的规矩，代码与文档/自身不一致的地方，这里只**陈述事实**，不判断该怎么办。

### 13.1 fixture 覆盖 6 个 site，模型有 8 个

`robot_walk.xml` 声明了 **8 个 site**：

```
imu_bno · imu · left_foot · head_camera · mouth_tip · tof · head_imu · right_foot
```

`tests/fixtures/fk_alpha.json` 里的 `site_names` 只有 **6 个**：
`head_camera`、`imu`、`left_foot`、`right_foot`、`mouth_tip`、`tof`。

缺的两个是 **`imu_bno`** 和 **`head_imu`**。而 `head_imu` 是**真的在用**的：

```rust
// robotd/src/main.rs:4810 — 进 robot.state，发给客户端
head_imu: FK.head_imu_in_trunk(head).map(pose),
```

site 表和 fixture 是同一次提交引入的（`cc972c5`，2026-08-21）。
fixture 自己的说法是 "any real divergence fails loudly" —— 对**它覆盖的那 6 个**成立。

### 13.2 `beams()` 的文档注释指着一个已经删掉的东西

```rust
// kinematics/src/tof.rs:131-134
/// The unit beam directions, in the sensor's own frame, row-major like the wire's
/// zones. Exposed for geometry that reasons about the beams themselves rather than
/// about where they landed — [`crate::hand`]'s plane fit, which needs the direction a
/// slant range was measured along.
```

但 `hand.rs` 里的平面拟合在 §11.1 描述的那次简化里被删掉了：

- `hand.rs:3-6` 把它列为**被移除**的做法之一；
- `grep -c "beams" kinematics/src/hand.rs` 返回 **0** —— 这个文件一次都没提过它。

真正调用 `beams()` 的是 `robotd`：

```
robotd/src/main.rs:4821:            tof_beams: TOF.beams().to_vec(),
```

---

## 14. 阅读路线

按这个顺序读，每一步都建立在前一步上：

| 步 | 读什么 | 为什么先读它 |
|---|---|---|
| 1 | `kinematics/Cargo.toml`（1-9 行的注释） | 九行说清了整个 crate 的来龙去脉 |
| 2 | `assets/alpha/robot_walk.xml` | **先看真相**。109 行，对着 §6 的树状图读 |
| 3 | `src/math.rs` | 最短的文件（180 行），且是所有别的东西的语言 |
| 4 | `src/lib.rs` | `Model` + `site_pose`。**§3.4 那 8 行是核心** |
| 5 | `src/mjcf.rs` | 回头看 XML 是怎么变成 `Model` 的 |
| 6 | `src/head.rs` | 第一个有算法的模块：`look_at` |
| 7 | `src/tof.rs` | 第二个：重投影 + 判地板 |
| 8 | `src/hand.rs` | 最简单也最有人味的一个。**模块文档必读** |
| 9 | `tests/fk_against_mujoco.rs` | 看正确性是怎么被钉死的 |

**如果只有十分钟**：读 §1、§3、§6 的树状图，然后读 `hand.rs` 的前 16 行。

三条贯穿全文的主线，看到时留意一下 —— 它们比任何单个算法都更能说明这个 crate 的性格：

1. **唯一真相**：几何只写在 XML 里一处，连策略训练都用同一份。
2. **加载时编译**：名字→索引、链的展平，全在加载时做完，热路径上只剩算术。
3. **宁可不做，不可做错**：`NaN` → 单位四元数；IMU 没收敛 → 不摆平；角度切片短了 → panic。

---

## 15. 术语表

| 词 | 意思 |
|---|---|
| **正向运动学（FK）** | 给定关节角，算各部位在哪、朝哪。**这个 crate 的主业** |
| **逆运动学（IK）** | 反过来：给定想要的位置，算关节角该多少。`look_at` 是 |
| **MJCF** | MuJoCo XML Format。MuJoCo 物理引擎的模型描述语言 |
| **body** | 刚体，一段不会变形的骨头 |
| **joint** | 关节。`type="hinge"` = 只能绕一根轴转的铰链 |
| **site** | 贴在 body 上的"有名有向但没有质量的点"。摄像头、ToF、脚底都是 site |
| **rest pose** | 关节角全为 0 时，一个 body 相对于父亲的固定偏移（`pos` + `quat`） |
| **Pose** | 位置 + 朝向。`math.rs` 里的一个结构体 |
| **四元数（Quat）** | 表示旋转的四个数。这里用 Hamilton 约定、标量在前 `[w,x,y,z]` |
| **躯干坐标系（trunk frame）** | 以躯干为原点的坐标系。**这个 crate 的所有输出都在这里** |
| **世界坐标系（world frame）** | 以地面为基准的坐标系。归 IMU 和 `odometry` 管 |
| **site_pose** | 从根折叠到某个 site，得到它的位姿。**热路径上最重要的那个函数** |
| **LazyLock / 静态单例** | 第一次用到时初始化、之后一直复用。`Model::alpha()` 就是 |
| **Gauss-Newton（高斯-牛顿）** | 一种迭代求根法。`look_at` 用它解 2×2 方程 |
| **Jacobian（雅可比）** | 导数的矩阵形式："每个输入动一点，每个输出各动多少"。这里是数值算的 |
| **阻尼 / Levenberg** | 给迭代加一点点"粘性"，防止它在奇异点附近跳飞 |
| **奇异点 / 万向节死锁** | 两个转轴对齐、丢掉一个自由度的姿态。head_yaw ≈ 90° 时出现 |
| **ToF** | Time of Flight，飞行时间测距。返回 8×8 的距离网格 |
| **重投影（reprojection）** | 把"某方向上的距离"换算成"空间中的点" |
| **斜距 / 水平距离** | 斜距 = 沿光线量；水平距离 = 投到地平面上量。`Hit::range` 是后者 |
| **percentile（百分位）** | 排序后取第 N% 个。这里取第 20 个，为了避开孤立飞点 |
| **fixture** | 预先算好的基准数据，用来比对。这里是 MuJoCo 算的 64 组姿势 |
| **奇偶校验（parity）** | 两套实现给同样的答案。这里指本 crate 与 MuJoCo |
| **`#[ignore]`** | 默认不跑，要 `--ignored` 手动跑。用于探针这类不该进 CI 的东西 |
| **newtype** | 用单字段结构体包一个裸类型，换来类型安全。`SiteId(usize)` 就是 |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| 关节角怎么变成扭矩（姊妹篇，**最该一起读**） | [`duck-control-primer.md`](duck-control-primer.md) |
| 鸭子站在哪：接触点里程计 | [`design/robotd-design.md`](design/robotd-design.md) §4.4 · [`robotd-primer.md`](robotd-primer.md) |
| 头部姿态、ToF 在 `robotd` 里怎么用 | [`design/robotd-design.md`](design/robotd-design.md) |
| `robot.look` / `robot.model` / `robot.state` 的线上契约 | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| ToF 重投影在笔记本上长什么样 | [`duckctl-primer.md`](duckctl-primer.md) |
| `hand::Config` 怎么接到配置文件 | [`robotd-params-primer.md`](robotd-params-primer.md) |
| 控制环的 50 Hz 心跳 | [`robotd-primer.md`](robotd-primer.md) |
| BLE 电台（姊妹篇） | [`btd-primer.md`](btd-primer.md) |
| BLE 的线上契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| wifi、身份、手柄配对（姊妹篇） | [`configd-primer.md`](configd-primer.md) |
| 摄像头里的鸭子检测（姊妹篇） | [`duck-detect-primer.md`](duck-detect-primer.md) |
| 模拟鸭子用的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| 发布怎么把自己装到板子上（姊妹篇） | [`hooks-primer.md`](hooks-primer.md) |
| 板子被配置成什么样子（姊妹篇） | [`deploy-primer.md`](deploy-primer.md) |
| MuJoCo 孪生：策略怎么训练的 | [`design/simulation.md`](design/simulation.md) |
| ToF 重投影的另一个消费者：摄像头管线（姊妹篇） | [`mediad-primer.md`](mediad-primer.md) |
| 谁的脚踩在地上：接触式里程计（姊妹篇，**最该一起读**） | [`odometry-primer.md`](odometry-primer.md) |
| 另一套四元数实现，用 `f32` 且没有外部基准（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| 手柄：按键映射、模式、那个 raw tap（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| 摸头检测：麦克风、log-mel、那个门控（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| 3D 视图那份自己烘焙的骨架（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| 装机、更新、诊断的那些工具（姊妹篇） | [`scripts-primer.md`](scripts-primer.md) |
| 鸭子的嗓子：可播种的合成器（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 头部的两个传感器：深度与 IMU（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
