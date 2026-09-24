# `tof/` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> 这个目录是**鸭子头部的两个传感器**：一个 ToF 深度相机，和一个 IMU。
> 为什么感知必须是它自己的守护进程，由 [`design/architecture.md`](design/architecture.md) §1 拥有；
> 通道契约（`tof.stream` 那些方法）由 [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) 拥有；
> 这个守护进程**空闲时花掉的那 5%**，由
> [`project/tof-on-demand.md`](project/tof-on-demand.md) 拥有（那是测量记录）。
> **特雷门没有设计文档，而这是有意的** —— `design/robotd-design.md:921-929` 说，
> 一个服务只有在"第二个读者否则就得从代码里推导它的契约"时才需要一页；
> 这些东西各自只有一个实现和一个消费者。本导读就是那个"一页"。
> 若本导读与代码不一致，以代码为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：[`robotd-primer.md`](robotd-primer.md)（唯一的消费者）、
> [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md)（`tof.stream` 的线上形状）、
> [`kinematics-primer.md`](kinematics-primer.md)（把帧变成几何）、
> [`robotctl-primer.md`](robotctl-primer.md)（`monitor` 里那个网格）、
> [`deploy-primer.md`](deploy-primer.md)（I²C 总线是怎么来的）、
> [`scripts-primer.md`](scripts-primer.md)（`/dev/i2c-pihat` 那条 udev 规则）。

## 目录

1. [一分钟版](#1-一分钟版)
2. [⚠️ 这个 crate 里有两个传感器](#2-️-这个-crate-里有两个传感器)
3. [⭐ 核心心智模型：一帧的三种状态](#3--核心心智模型一帧的三种状态)
4. [目录地图](#4-目录地图)
5. [那份 vendor 的 C](#5-那份-vendor-的-c)
6. [传感器：两代，在运行时决定](#6-传感器两代在运行时决定)
7. [`tofd` 的四种数据来源](#7-tofd-的四种数据来源)
8. [⭐ 主循环：那个 poll guard](#8--主循环那个-poll-guard)
9. [socket 那一半](#9-socket-那一半)
10. [头 IMU：为什么它在 `tofd` 里](#10-头-imu为什么它在-tofd-里)
11. [对外的形状](#11-对外的形状)
12. [谁在读它](#12-谁在读它)
13. [几处读者会绊到的地方](#13-几处读者会绊到的地方)
14. [阅读路线](#14-阅读路线)
15. [术语表](#15-术语表)

---

## 1. 一分钟版

`tof/` 回答一个问题：

> **鸭子头上那个传感器看到了什么，怎么把它变成一帧可以读的数据？**

规模很小 —— **2,191 行自己的 Rust**，加上一份 40 KB 的 ST 寄存器序列和 550 KB 的固件。

```
   VL53L8CX / VL53L5CX            （ToF，8×8 深度矩阵，看头部朝向）
   BMI088                          （IMU，陀螺仪 + 加速度计 + 姿态）
        │
        │  同一个 I²C 总线（i2c3），和音频 codec 共用
        ▼
   tofd  ← 唯一碰这条总线的进程
        │
        │  /run/tofd/tof.sock  （unix socket，mode 0660，group robot）
        ▼
   tof.stream / head_imu.stream  →  robotd · robotctl monitor
```

三个值得先记住的事实：

| # | 事实 | 为什么重要 |
|---|---|---|
| **①** | **一帧有「三种」状态，不是一种** | 空无一物 ≠ 测不出来。见 §3 |
| **②** | **它每 66 毫秒只问传感器 3 次，而不是 7 次** | 一个省掉 57% 总线流量的守卫。见 §8 |
| **③** | **头 IMU 默认是关的** | 因为它 4% 的 CPU，而没有任何东西订阅它。见 §10 |
| **④** | **那个「三种状态」的判断，有一个消费者故意不用** | 特雷门信的是一组更宽的状态码，否则它在 30 cm 外就看不见手。见 §3.6 |

---

## 2. ⚠️ 这个 crate 里有两个传感器

`Cargo.toml:1-6` 的第一句就会让人绊一下：

> The head ToF sensor: an 8x8 depth matrix from a VL53L8CX, and the daemon that serves it.

**但它其实服务两个传感器**，而第二个只在文件末尾才出现：

| 传感器 | 是什么 | 在哪读 | 默认 |
|---|---|---|---|
| **VL53L8CX / VL53L5CX** | 8×8 深度矩阵 | `src/sensor.rs` + vendor C | **总是开** |
| **BMI088** | 头部 IMU（陀螺仪 + 加速度计 + 姿态） | `src/imu.rs`（纯 Rust 驱动） | **默认关** |

`imu.rs:1` 讲了为什么它在这里：

> The head IMU (BMI088 on the HAT), read by `tofd` **because `tofd` owns this I²C bus.**

**"因为 `tofd` 拥有这条 I²C 总线。"** —— 两个芯片挂在同一条总线上
（`imu.rs:3-6`：加速度计 `0x19`、陀螺仪 `0x68`、ToF `0x29`、codec `0x18`，不冲突）。

而**它们跑在两个不同的线程上**（`imu.rs:8-11`）：

> Runs on its own std thread, **not the ToF thread**: the ToF blocks for seconds uploading
> firmware and backs off for up to a minute when no sensor is fitted, and **the IMU stream must
> not stall behind that.**

**"IMU 的流不能堵在它后面。"**

### 2.1 那条容易被忽略的依赖

`Cargo.toml:40-47` —— 这个 crate 依赖一个 **git 上的第二个仓库**：

```toml
[target.'cfg(target_os = "linux")'.dependencies]
# The BMI088 driver and its Madgwick fusion, ours because the crates.io ones stop at the raw
# registers. Pinned to a tag: it is a second repository and a moving `main` is not a dependency.
# v0.1.2 is the one that has `Bmi088Ahrs::update_all`, which is what takes a head-IMU sample
# from three I²C transactions to two.
bmi088 = { git = "https://github.com/pollen-robotics/bmi088-rs", tag = "v0.1.2" }
```

**"钉在一个 tag 上：它是一个第二个仓库，而一个会动的 `main` 不是一个依赖。"**

---

## 3. ⭐ 核心心智模型：一帧的三种状态

这是整个目录**最值得理解的一件事**，而它全部写在 `lib.rs:65-80`：

> What one zone of a frame actually says.
>
> **ST's status byte is the difference between "nothing is there" and "I could not tell", and
> collapsing them loses the distinction a map most needs: empty space is information, an
> unusable measurement is not.**

```rust
pub enum Zone {
    /// 有测量值，单位米。状态 5（有效）或 9（有效，大脉冲）。
    Range(f32),
    /// 状态 255：传感器看了，范围内什么也没有。**这是空无一物**。
    NoTarget,
    /// 任何其它状态：测量失败。**这说明不了外面有什么** —— 带着原始码，
    /// 因为对读 ST 表格的人来说，那些码有具体含义。
    Unusable(u8),
}
```

### 3.1 为什么不能用「一个数字」

`duck-ipc-proto/src/lib.rs:4646-4651` 从**线格式**的角度给了同一个论点：

> **Millimetres and ST's raw status, not metres.** **JSON has no NaN**, so a distance-only frame
> would have to encode "no measurement" as **a magic number**; carrying the status byte instead
> keeps the sensor's own **three-way answer** intact — a range, nothing in range, or a
> measurement that failed. The `tof` crate's `Frame::zone` is the interpretation, and **consumers
> should use it rather than re-deriving the thresholds.**

**"JSON 没有 NaN，所以一个只有距离的帧，只能用某个魔法数字来编码'没有测量'。"**

所以线上格式带的是**毫米 + 原始状态字节**（两个平行数组），**由 `Frame::zone` 解释**。

### 3.2 ⚠️ 一个反直觉的细节：有效状态 + 负距离 ≠ 范围

`lib.rs:93-100`：

```rust
if STATUS_VALID.contains(&status) {
    // Negative distances come back from the sensor occasionally on a
    // failed convergence; they are not a range whatever the status says.
    if distance > 0 {
        return Zone::Range(f32::from(distance) / 1000.0);
    }
    return Zone::Unusable(status);
}
```

**"负距离偶尔会从一个失败的收敛里回来；不管状态说什么，它们都不是一个范围。"**

而这一条被测试**钉住了**（`lib.rs:141-145`）：

```rust
assert_eq!(
    frame(5, -3).zone(0),
    Zone::Unusable(5),
    "a valid status with a negative range is not a range"
);
```

### 3.3 那两个状态码

`lib.rs:82-86`：

```rust
/// ST 文档里算作可用范围的码：有效，以及有效（大脉冲）
/// （约 50% 置信度，传感器仍然为它背书）。
pub const STATUS_VALID: [u8; 2] = [5, 9];
/// "测到了，那里什么都没有"的状态码。
pub const STATUS_NO_TARGET: u8 = 255;
```

### 3.4 唯一的那个「一个数」

`lib.rs:112-116`：

> How many zones carry a usable range. **The one number that says whether the sensor is seeing
> anything at all.**

`robotctl monitor` 的网格就是在画这三态。见 §12。

### 3.5 一个不信任输入的设计

`lib.rs:155-168` 的测试：

> A short or ragged frame must not panic a consumer — **the wire carries vectors, and a peer from
> another release could send fewer.**

```rust
assert_eq!(ragged.zone(0), Zone::Range(1.0));
assert_eq!(ragged.zone(2), Zone::NoTarget, "missing status");
assert_eq!(ragged.zone(99), Zone::NoTarget, "past the end");
```

**"线上传的是向量，而来自另一个发布的对端可能发得更少。"**
缺的状态读作 `NoTarget` —— **不是 panic，也不是"有东西"。**

### 3.6 ⚠️ 但是有一个消费者**故意不用**这个判断

这是读完 §3 之后最容易搞错的一处，也是最值得知道的一处。

`lib.rs:82-84` 说 `[5, 9]` 是"ST 文档里算作可用范围的码"，而线格式的文档说
**"consumers should use it rather than re-deriving the thresholds"**（`duck-ipc-proto/src/lib.rs:4649-4651`）。

**但特雷门没有用。** 它用的是一个**更长**的集合（`kinematics/src/hand.rs:73`）：

```rust
// 5 和 9 是 ST 的 "valid" 和 "valid, large pulse"。6 是一个还没做环绕检查的首次测距，
// 10 是一个有效测距但上一次什么都没看到，12 是被尖锐边缘模糊的目标 —— 而手的边缘就是那样。
// 4 和 13 是移动的手在 30 cm 以外产生的**一致性失败**，它们在里面，是因为
// 一个音高不需要毫米级的精度。
statuses: vec![4, 5, 6, 9, 10, 12, 13],
```

而理由是**第一版死在哪里**（`hand.rs:22-26`）：

> **Which status bytes count.** ST calls 5 and 9 "valid", and on this sensor at 15 Hz **a hand
> past ~30 cm routinely comes back as 4 or 13** — *consistency failed*, sigma too high —
> **carrying a distance perfectly good enough for a pitch.** **Accepting only 5 and 9 is why the
> first version died at 30 cm.** The set is `Config::statuses`, and it is **config rather than a
> constant because it is the one number a bench session needs to move.**

**"只接受 5 和 9，就是第一版死在 30 厘米的原因。"**

### 3.7 所以 `robotd` 把帧原样留着

`robotd/src/theremin.rs:57-63`：

```rust
/// One depth frame, as the wire sent it.
///
/// **Kept raw — distances and status bytes, uninterpreted — because which statuses count is
/// `hand::Config`'s decision and it is the decision this feature turned out to hinge on.
/// Interpreting here would have buried it.**
struct Frame {
    distance_mm: Vec<i16>,
    status: Vec<u8>,
```

**"在这里解释它，会把它埋掉。"**

而那个 bug 被测试钉住了（`hand.rs:217-220`）：

> The bug that killed the first version, pinned: **a hand past 30 cm arrives with a
> consistency-failure status, and it must still play.** If someone narrows `Config::statuses`
> back to ST's two "valid" codes, **this is the test that says why not.**

### 3.8 怎么理解这两件事并存

| 层 | 它对「什么算一个范围」的答案 | 为什么 |
|---|---|---|
| **`tof::Zone`** | **`[5, 9]`** | 它回答的是"这一格到底测到没有" —— **一个通用的、保守的答案** |
| **特雷门（`hand::Config`）** | **`[4, 5, 6, 9, 10, 12, 13]`** | 它回答的是"这个距离能不能当音高用" —— **一个用途专属的、宽松的答案** |

**两个都对，因为它们回答的不是同一个问题。**
"一个音高不需要毫米级的精度" —— 而一格深度矩阵的用途会决定它能容忍多少不确定性。

**这一条可以带走**：一个"三态"的抽象**不可能同时是通用答案和最佳答案**。
`tof` 提供了一个保守的默认（`Zone`），并**把原始字节一起发出去**，
让那个知道自己在干什么的消费者自己决定 —— 而它确实决定了。

---

## 4. 目录地图

```
tof/
├── Cargo.toml            54   ← 依赖很少，但有一个 git 依赖
├── build.rs             118   ← ⭐ 编译那两份 vendor 的 C（只讲了一件事：六次重命名）
├── src/
│   ├── lib.rs           169   ← ⭐ 帧的形状 + 那三种状态（**先读这个**）
│   ├── sensor.rs        424   ← 对 vendor C 的安全包装；两代，运行时分流
│   ├── imu.rs           299   ← 头 IMU（BMI088），纯 Rust，默认关
│   ├── config.rs         66   ← 只读一个键：`[head_imu] enabled`
│   ├── status.rs        104   ← "没有传感器"和"还没有帧"是两句不同的话
│   └── main.rs          957   ← `tofd` 本身：循环、socket、四种数据来源
├── systemd/
│   ├── tofd.service           ← 加固、那个**故意不设**的 `PrivateDevices=`
│   └── sysusers.d/tofd.conf   ← 两个组：`i2c` 和 `robot`
└── vendor/                    ← ST 的 Ultra Lite Driver，BSD-3-Clause，**逐字搬运**
    ├── LICENSE.txt
    ├── platform.c             ← ⭐ 一份实现，每个代各编译一次
    ├── probe.c                ← 60 行 ioctl，回答"这是哪一代"
    ├── vl53l8cx/{shim.c, shim 用到的头, *_api.c, *_buffers.h}
    └── vl53l5cx/{同上}
```

**注意没有 `tests/`。** 测试都在各个文件底部 —— 而且它们测的多是**论证**，不是行为（见 §8.4）。

---

## 5. 那份 vendor 的 C

这是这个目录里最"重"的一部分（两份 ULD 一共约 5,000 行 + 550 KB 固件头），
而 `lib.rs:13-26` 用一段话解释了整个决定：

> ## Why the C is vendored
>
> Each of ST's Ultra Lite Drivers is **40 KB of register sequences plus a 550 KB firmware blob
> that is uploaded into the sensor on every start.** **Reimplementing that in Rust would be
> transcribing a binary blob and a state machine nobody has documented outside the driver**;
> **depending on a third-party crate would put a sensor this robot needs behind someone else's
> maintenance.** So both ULDs are **vendored verbatim** (BSD-3-Clause, `vendor/LICENSE.txt`), the
> Linux i2c-dev platform hooks come from `microduck_runtime` **where they were measured** — one
> implementation, compiled once per generation — and **a flat shim keeps every struct on the C
> side of the boundary.**

三个理由，每一个都值得记住：

| 理由 | 原文 |
|---|---|
| **不能重写** | *"transcribing a binary blob and a state machine **nobody has documented outside the driver**"* |
| **不能依赖** | *"would put a sensor this robot needs **behind someone else's maintenance**"* |
| **不能镜像结构体** | 见下 |

### 5.1 那个 shim 的全部意义

`vendor/vl53l8cx/shim.c:1-16`：

> Flat C API over the VL53L8CX ULD, for `tof`'s Rust wrapper.
>
> **Nothing but scalars and arrays crosses this boundary. That is the whole point**:
> `VL53L8CX_Configuration` **embeds the platform struct, the firmware staging buffer and the
> results block**, and **mirroring it as `repr(C)` in Rust would be a large hand-written struct
> that must track ST's header forever. Twelve functions taking `u8`/`i16` do not.**

**"十二个接受 `u8`/`i16` 的函数则不需要。"**

而这条直接决定了 Rust 那边 `unsafe` 的**形状**（`sensor.rs:1-6`）：

> Every call here is one FFI call into a `vendor/*/shim.c`, whose whole surface is **scalars and
> two 64-entry arrays**. **The unsafety is therefore confined to this file and is all of one
> shape** — "the C writes 64 entries into a buffer I sized at 64" — **rather than spread across a
> hand-mirrored `repr(C)` struct.**

**"不安全被限制在这一个文件里，而且全都是一种形状 —— 'C 往一个我按 64 大小分配的缓冲区里写 64 项'。"**

### 5.2 ⭐ 那六次重命名

这是 `build.rs:9-16` 唯一详细解释的东西，也是整个构建最巧妙的一步：

> **Why the six renames.** Each ULD calls its platform hooks by the bare names
> `RdByte`/`WrByte`/`RdMulti`/`WrMulti`/`SwapBuffer`/`WaitMs`, and we ship **one** implementation
> of them (`vendor/platform.c`). **Two generations in one binary would therefore define the same
> six symbols twice.** **The ULD sources are upstream and unedited, so the rename happens in the
> preprocessor instead**: each generation compiles *its own copy* of `platform.c` with its hooks
> under a `vl5_`/`vl8_` prefix, and its ULD compiled with the same defines so the call sites
> follow.

**"ULD 的源码是上游的、未经编辑的，所以重命名发生在预处理器里。"**

```
        vendor/platform.c   （一份实现）
              │
      ┌───────┴───────┐
      │               │
  -DRdByte=vl8_RdByte   -DRdByte=vl5_RdByte
  -DTOF_PLATFORM=       -DTOF_PLATFORM=
     VL53L8CX_Platform     VL53L5CX_Platform
      │               │
  vl8 静态库        vl5 静态库     ← 六个符号各有一套，链接不冲突
```

`build.rs:51-59` 是那六个名字的清单，`build.rs:86-88` 是施加 define 的地方。

### 5.3 另外三条决定

**① 警告不是错误**（`build.rs:18-20`）：

> Warnings are not errors here: `vl53l?cx_api.c` is **upstream code we do not edit**, and **a new
> compiler finding something in it must not be able to stop a robot release from building.**

**② 用 target 而不是 host**（`build.rs:62-64`）：

> The target, not the host: **a build script is compiled for the machine it runs on**, so
> `cfg!(target_os)` here would answer for the laptop and **cross-compiling to the board would
> build nothing.**

**③ 固件 blob 要在 `rerun-if-changed` 里点名**（`build.rs:104-105`）：

> The firmware blob is **a 550 KB header no source file lists**, so it needs naming here or **a
> driver update would not trigger a rebuild.**

### 5.4 `probe.c`：为什么它不用 platform 层

`vendor/probe.c:9-12`：

> **Standalone on purpose**: it opens its own descriptor and does its own three transactions
> **rather than borrowing a generation's platform layer**, because **borrowing one would mean
> picking a generation before knowing which is there.** **Sixty lines of ioctl beats that
> chicken-and-egg.**

**"借用一个代的 platform 层，意味着在还不知道有哪一代之前就得先选一代。六十行 ioctl 胜过这个先有鸡还是先有蛋。"**

### 5.5 `platform.c` 里的一个数字

`vendor/platform.c:38-42`：

> /* One chunk per I2C_RDWR message. The rk3x controller handles large messages fine (FIFO
> refills under interrupt); **2 KiB keeps each bus hold short enough that the codec never waits
> long — the TLV320AIC3104 shares this bus, and a stalled mixer write is audible.** */
> `#define CHUNK 2048u`

**"一次卡住的 mixer 写入是听得见的。"** —— 分块大小是为**音频**选的，不是为 ToF。

而 `platform.c:20-24` 讲了为什么这段是 C 而不是脚本：

> Doing the transfers in C **rather than through a per-callback trip into a scripting language
> cuts the per-transaction overhead ~10x**: the 90 kB firmware upload takes **a few seconds at
> 400 kHz instead of tens of seconds** — and **that upload happens on every sensor start.**

---

## 6. 传感器：两代，在运行时决定

`lib.rs:8-11`：

> **Both generations, decided at runtime.** The two are **interchangeable on the board** and
> differ only in firmware and a driver prefix, so **which one is fitted is not a build-time
> choice**: an ID read picks the driver **before any firmware is uploaded**. **Ducks in the field
> have both.**

### 6.1 那个区分它们的字节

`sensor.rs:68-80`：

```rust
pub enum Generation {
    /// Revision 0x0C.
    L8cx,
    /// Revision 0x02 —— 更老的那个传感器，也是**场上大多数鸭子有的那个**。
    L5cx,
    /// 有东西回答了，但不是任何一个驱动认识的 ID。
    Unknown { device_id: u8, revision_id: u8 },
}
```

### 6.2 ⚠️ 为什么未知的那一代绝不能猜

`sensor.rs:388-390` 的测试注释：

> The revision byte is what picks the firmware, so the mapping is the whole two-generation story.
> **ST's values, and an unknown one must not be guessed at — uploading the wrong blob is how you
> brick a probe.**

**"上传错的 blob 就是你搞砖一个探头的方式。"**

而代码确实不猜（`sensor.rs:255-260`）：未知的 `driver()` 返回 `None`，
然后报一个**带着两个字节的错**：

```
something at 0x29 answered with device 0x00 revision 0xff, which is neither a VL53L5CX nor a VL53L8CX
```

### 6.3 开传感器的顺序

`sensor.rs:238-286`，每一步失败都有自己的一句话：

```
① tof_probe_id()        → "nothing answered at 0x29 on /dev/i2c-3"
② Generation::from_ids  → "…which is neither a VL53L5CX nor a VL53L8CX"
③ driver.open()         → "cannot open /dev/i2c-3"
④ driver.is_alive()     → "the VL53L8CX stopped answering between the probe and the handshake"
⑤ driver.init()         → "VL53L8CX firmware upload failed (ULD status N)"
```

`④` 那句注释说明了为什么它单独存在（`sensor.rs:242-243`）：

> Ask what is there **before** loading anything: the two generations take different firmware, and
> **the upload is the expensive, slow step.**

### 6.4 那个慢

`sensor.rs:224-228`：

> The slow part is the firmware: **~90 KB over I²C, a few seconds at 400 kHz** (tens on a
> bit-banged bus). It happens **once per process**, before ranging, which is **why the daemon does
> it off the socket-serving task.**

### 6.5 ⭐ 单实例，以及那个会变成永久故障的 bug

`sensor.rs:16-19`：

> **One instance per process, enforced.** Each shim keeps its configuration in a file-scope
> static (see its header for why), so **a second `Sensor` would quietly share and corrupt the
> first one's state.** `Sensor::open` refuses instead.

`shim.c:14-18` 从 C 那一侧说了同一件事：

> **One sensor per process.** The configuration is a file-scope static because **the ULD wants a
> stable address for a ~16 KB struct** and this daemon drives one sensor.
> `tof::Sensor` enforces the single instance on the Rust side, so **the static cannot be entered
> twice.**

而实现里有一个**很容易漏掉**的细节（`sensor.rs:230-236`）：

```rust
pub fn open(bus: &Path, address: u8) -> Result<Self> {
    if TAKEN.swap(true, Ordering::AcqRel) {
        bail!("a sensor is already open in this process");
    }
    // From here on every early return must release the claim, or one failed
    // attempt would refuse every retry for the life of the process.
    Self::open_inner(bus, address).inspect_err(|_| TAKEN.store(false, Ordering::Release))
}
```

**"从这以后每一个提前返回都必须释放这个声明，否则一次失败的尝试会让这个进程余生都拒绝每一次重试。"**

而 `sensor.rs:410-412` 的测试把它钉住了：

> Opening a bus that cannot exist must fail *and* release the single-instance claim — **the daemon
> retries after a failure, and a claim left set would turn one bad open into a permanently
> sensorless process.**

### 6.6 非 Linux 上那个**故意不可构造**的类型

`sensor.rs:342-354`：

> `vendor/platform.c` reaches the bus through Linux's `I2C_RDWR` ioctl, so `build.rs` compiles no
> driver anywhere else and there is nothing for `open` to open. **This is not a fake sensor and
> must never become one** — `tofd --fake` already exists for a laptop, and **it says what it is
> in its name.** This exists so that `cargo test --workspace` works off a board.
>
> **Uninhabited on purpose**: `open` is the only constructor and it always fails, so **the
> compiler discharges every other method instead of leaving a body that could one day return an
> invented frame.**

```rust
#[cfg(not(target_os = "linux"))]
pub struct Sensor(std::convert::Infallible);
```

**"故意不可构造：编译器会替我们排除掉其它每一个方法，而不是留下一个有一天可能返回一帧凭空捏造的数据的函数体。"**

**这一句是整个仓库里我最喜欢的一处设计**：用一个类型系统的事实，
替代了一句"记得不要在这里造假数据"的注释。

---

## 7. `tofd` 的四种数据来源

`main.rs:218-224` 那个 `if/else` 就是全部：

| 来源 | 开关 | 干什么 | 用在哪 |
|---|---|---|---|
| **真传感器** | （默认） | 扫总线、探 ID、传固件 | 板子上 |
| **`--fake`** | `main.rs:399` | 一个合成的场景，**三种状态都有** | 笔记本上 |
| **`--sim`** | `main.rs:456` | 从 MuJoCo 身体要一帧 | 仿真 |
| — | — | （IMU 单独有 `--imu` / `--no-imu`） | 见 §10 |

### 7.1 为什么 `--fake` 不是一个平坦的梯度

`main.rs:393-398`：

> A synthetic scene at the configured rate: a wall receding across the frame, a near object,
> **a column of empty space and one of failed measurements.**
>
> **Deliberately not a flat gradient.** The three zone classes render differently and **the two
> non-range ones are the easy ones to get wrong**, so `--fake` shows all three from the first
> frame.

**"那两种非范围的，正是最容易弄错的。"** —— 一个只会看到范围的视图，
是一个**它的另外两种情况从来没被画过**的视图。

实现里就是两列写死的状态（`main.rs:420-425`）：第 2 列状态 4，第 5 列状态 255。

### 7.2 `--sim` 和 `--fake` 的分工

`main.rs:159-169`：

> **The fake at the loop level, with a simulator behind it** — which is where a fake belongs
> here: **`sensor.rs` says in as many words that the off-board `Sensor` "is not a fake sensor and
> must never become one"**, because **the thing it stands for is a vendor C library talking to a
> bus. A frame arriving from somewhere else is a different question from a sensor that lies.**

**"一帧来自别处，和一个会撒谎的传感器，是两个不同的问题。"**

而它对**掉线**的处理值得注意（`main.rs:452-455`）：

> A simulator that goes away is **one missed frame and a reconnect, not a dead daemon**: MuJoCo
> is restarted whenever the number of ducks changes, and **a duck is expected to live through
> that.**

握手只做一次（`main.rs:546-556`），之后每帧一个 `{"op":"tof"}`。
而 `connect_sim` 里有两条关于延迟的（`main.rs:551-553`）：

```rust
// Nagle 会给一个 15 Hz 的请求/响应加上几十毫秒，那几乎是整整一帧。
let _ = stream.set_nodelay(true);
let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
```

---

## 8. ⭐ 主循环：那个 poll guard

这是 `tofd` 里**最值得学的一处优化**，而它只改了 20 毫秒的一个常数。

### 8.1 ⚠️ 先解释一件事：为什么是"问"，而不是"被通知"

**这个传感器没有中断引脚。** `tof/` 这个 crate 里没有任何 GPIO 或中断处理
（`grep -i gpio\|irq tof/src/` 一无所获）—— 唯一能知道"一帧好了"的方式，
是**读一个寄存器**（`sensor.rs:302-310`）：

```rust
/// Is a new frame ready? `Err` is a bus error, which the caller treats as
/// "the sensor went away" rather than "not yet".
pub fn data_ready(&self) -> Result<bool> {
    match self.driver.data_ready() {
        1 => Ok(true),
        0 => Ok(false),
        _ => Err(anyhow!("the sensor stopped answering")),
    }
}
```

**所以"多久问一次"不是一个可以回避的问题** —— 它是这个驱动程序的**唯一**选择，
而每一个问题的代价都是**一次 I²C 事务**（在一条音频 codec 也在用的总线上）。

**这就是为什么下面的那 20 毫秒值得写一整节**：在一个有中断线的传感器上，
这个优化的对象根本不存在。

### 8.2 问题

帧率 15 Hz → 每帧间隔 **66 毫秒**。而循环每 **10 毫秒**问一次传感器"好了吗"。

`main.rs:67-73` 把它说得很直白：

> **Asking every 10 ms for the whole period is asking six times to be told no once.** A frame is
> 66 ms away at 15 Hz and **the sensor answers on its own clock**, so the poll **only has to be
> running as the frame lands** — the rest was **a hundred I²C transactions and a hundred thread
> wakeups a second, forever, on a daemon whose sensor produces fifteen frames in that time.**

**"在整个周期里每 10 毫秒问一次，就是问六次只为被拒绝一次。"**

### 8.3 那个守卫

`main.rs:74-82`：

```rust
/// How long before a frame is due the loop starts asking for it.
///
/// Two poll intervals of margin, and **the anchor is the last frame's *arrival***, so the
/// estimate **can never accumulate more than one period of drift**: this tolerates the sensor
/// being **20 ms early on any given frame — a 30% period error**, far past anything a hardware
/// ranging timer does — and a sensor that is merely late is polled for exactly as long as it was
/// before. **Frame age is unchanged either way: it is still bounded by [`POLL`]**, because that
/// is the granularity the frame is noticed at whichever way the loop got there.
const POLL_GUARD: Duration = Duration::from_millis(20);
```

```
   一帧到达                                     下一帧到达
       │                                            │
       ├────────── quiet_period (46 ms) ────────┤    │
       │      这段什么都不问，直接睡              │    │
       │                                    ├─ 20ms ─┤
       │                                    开始每 10ms 问一次
       ▼                                            
    锚点是**上一帧的到达时刻**，不是某个绝对时间
```

`main.rs:295-297` 那三行是整个机制的实现：

```rust
fn quiet_period(hz: u8) -> Duration {
    Duration::from_secs_f64(1.0 / f64::from(hz.max(1))).saturating_sub(POLL_GUARD)
}
```

`saturating_sub` 而不是 `-`：**比守卫还快的帧率没有东西可跳过**
（`main.rs:290-294`），而 `--hz 0` 是一次"不能做的除法"（`main.rs:949-957`）。

### 8.4 那个省下来的量，被写成了测试

`main.rs:918-932` —— **这是这个仓库里我最欣赏的一个测试**：

> **The saving, as arithmetic rather than as a claim in a comment.**
>
> At the shipped rate a frame used to cost **seven `data_ready` reads to find, six of them
> answered no**. **Widening `POLL_GUARD` until the quiet stretch disappears would leave the loop
> correct and the reason for it gone, which is exactly the change nothing else here would
> notice.**

```rust
let polls = |window: Duration| (window.as_secs_f64() / POLL.as_secs_f64()).ceil() as u32;

assert_eq!(polls(period), 7, "what polling the whole period cost");
// The guard's window, plus the poll that finds the frame at the end of it.
assert_eq!(polls(period - quiet_period(15)) + 1, 3);
```

**"把 `POLL_GUARD` 放宽到那段安静消失，会让循环依然正确、而它存在的理由消失 —— 那正是别的东西都不会注意到的改动。"**

**一个测试同时是文档、是回归保护、也是一个"别删这个常数"的警告。**

### 8.5 另外两个关于守卫的测试

`main.rs:933-940`：

> The anchor is the last frame's arrival, so **the guard only ever has to absorb one period of
> drift.** 20 ms of it at 15 Hz is **a 30% period error** — far past anything a hardware ranging
> timer does.

`main.rs:949-957`：

> A rate whose period is shorter than the guard has nothing to skip, and **must poll straight
> through rather than underflow into a long sleep.**

### 8.6 重试：一个退避服务两种失败

`main.rs:84-91`：

> Backoff between attempts to bring a sensor up, doubling to a cap.
>
> The two failures that matter are **"not fitted" (forever, on most ducks)** and **"the bus
> glitched" (transient)**. **One backoff serves both**: the transient case recovers in a second,
> and **the permanent one settles at one attempt a minute instead of hammering a bus the audio
> codec is also using.**

```rust
const RETRY_MIN: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(60);
```

### 8.7 只抱怨一次

`main.rs:378-384`：

```rust
// Said once per run of failures, not once per attempt: a duck
// with no ToF fitted would otherwise write this line into the
// journal forever.
if !said { said = true; tracing::warn!(...); }
```

**"否则一只没装 ToF 的鸭子会永远把这一行写进 journal。"**

### 8.8 试哪些总线和地址

`main.rs:93-107`：

```rust
/// Buses to try when none was named, in order.
///
/// `/dev/i2c-pihat` is the udev symlink `setup-board.sh` installs, which follows the HAT bus;
/// `/dev/i2c-3` is what the `i2c3-pihat` overlay creates and is **the answer on a board
/// provisioned before that rule existed.** Trying both means **a board that predates the rule
/// still finds its sensor**, and the log says which path answered.
pub(crate) const BUS_CANDIDATES: [&str; 2] = ["/dev/i2c-pihat", "/dev/i2c-3"];

/// 0x29 is the factory default for both generations. **0x52 is where the prototype moved a
/// VL53L5CX when an I²C IMU wanted 0x29** — that IMU is gone, but **a sensor programmed then is
/// still at 0x52, and the address survives power cycles.**
const ADDRESS_CANDIDATES: [u8; 2] = [0x29, 0x52];
```

**两条都是"兼容过去的板子"**：一条 udev 规则之前的板子，和一个原型时期改过地址的传感器。

而缺总线的报错**特意不一样**（`main.rs:570-573`）：

```rust
// A missing bus is not worth an address sweep, and saying so is more use
// than "nothing answered": it means the overlay is not loaded.
last = Some(anyhow::anyhow!("{} does not exist", bus.display()));
```

**"它意味着 overlay 没有被加载。"**

---

## 9. socket 那一半

### 9.1 权限模型

`main.rs:47-53`：

```rust
/// Same mode and reasoning as every other socket here: the group decides who may
/// ask, and it is the same group that may watch `robot.state`.
const SOCKET_MODE: u32 = 0o660;
/// Deliberately the same one as `robotd`'s socket and `padd`'s tap:
/// **whoever may watch the robot may watch what it sees.**
const GROUP: &str = "robot";
```

**"能看这台机器人的人，就能看它看到的东西。"**

而 `tofd.service:24-27` 是它成立的原因：

```
# i2c  — /dev/i2c-* is root:i2c mode 0660, which is the whole of this daemon's
#        privileged access
# robot — so the depth socket can be handed to the group that may watch the
#        robot, exactly as padd does with its pad tap
SupplementaryGroups=i2c robot
```

`sysusers.d/tofd.conf:6-11` 补了那个"为什么不是 root"：

> `tofd` runs unprivileged **for the same reason `padd` does: it needs exactly one thing the
> operator's account does not have — the I²C bus — and that comes from group membership granted
> in tofd.service, not from being root.**

### 9.2 拿不到那个组的时候

`main.rs:626-632`：

```rust
if let Err(e) = give_to_group(socket, GROUP) {
    // Not fatal, and said out loud with what it means: the socket exists, and
    // only tofd and root can read it. On a board that is a broken install;
    // on a laptop it is a machine with no `robot` group, which is ordinary.
    tracing::warn!(...);
}
```

**"在板子上那是一次坏掉的安装；在笔记本上那只是一台没有 `robot` 组的机器，很正常。"**

### 9.3 ⭐ 一次连接只订阅它要的那个流

这是这个文件里**最微妙的一处**，而它有一段很长的注释（`main.rs:672-676`）：

> Takes the two `Sender`s and **subscribes only in the arm that matched**, so **a receiver exists
> where the method is known and nowhere else.** **Subscribing on `accept` made
> `receiver_count()` count connections rather than interest**: a client asking for
> `head_imu.stream` held a depth receiver, and one that connected and said nothing held both.

**"在 `accept` 里订阅，会让 `receiver_count()` 数的是连接数而不是兴趣。"**

而那个测试（`main.rs:827-830`）说了为什么这个数字重要：

> **A connection that has asked for nothing wants nothing**, and one that asked for depth does not
> want the IMU. … **which is the number anything gating a sensor on demand would have to trust.**

**"那个任何'按需启动传感器'的方案都必须信任的数字。"**

### 9.4 一个订阅活在传感器之外

`status.rs:51-58`：

```rust
pub fn result(&self) -> proto::TofStreamResult {
    proto::TofStreamResult {
        // Accepted either way: the subscription is valid and frames will
        // arrive if a sensor appears. Refusing would make a client that
        // subscribed one second early give up for good.
        accepted: true,
        ...
```

**"拒绝会让一个早订阅了一秒的客户端永久放弃。"**

### 9.5 三种状态，三句不同的话

`status.rs:1-5` 讲了这个模块存在的全部理由：

> What the daemon says about its sensor, for a subscriber that has just asked.
>
> It answers **the question a viewer must not have to guess at: is there no sensor, or has it
> simply not produced a frame yet?**

而初始状态是一个**句子而不是 `None`**（`status.rs:28-33`）：

```rust
// Before the first attempt finishes, "starting" is the honest
// answer: the firmware upload takes seconds, and a viewer that
// opened in that window should see a reason rather than nothing.
unavailable: Some("bringing the sensor up".to_owned()),
```

`status.rs:78` 的测试给这三种状态起了名字：**"coming up, ranging, gone"**。

### 9.6 一个不会 panic 的锁

`status.rs:67-71`：

```rust
/// A poisoned lock cannot happen — nothing here panics while holding it — and
/// treating one as fatal would take the daemon down over a status field.
fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
    self.inner.lock().unwrap_or_else(|e| e.into_inner())
}
```

**"把一个中毒的锁当成致命的，会因为一个状态字段而把守护进程干掉。"**

### 9.7 那个"什么都不服务"的运行时

`main.rs:180-182`：

```rust
// One thread is plenty: the sensor is on its own std thread, and everything here
// is a socket doing nothing between frames.
#[tokio::main(flavor = "current_thread")]
```

而 `main.rs:204-206` 讲了为什么传感器**不在** tokio 里：

> The sensor runs on a **plain thread, not a tokio task**: every call into the driver blocks on
> I²C — the firmware upload for seconds — and **none of it is cancellation-safe.**

### 9.8 那个不是个 bug 的"重启"

`tof/systemd/tofd.service:8-10`：

> **Nothing depends on this unit.** `robotd` does not read depth, and `robotctl monitor` says
> **"no depth stream"** and carries on when the socket is absent, so **a board with no ToF simply
> runs one more quiet daemon.**

### 9.9 两个"谁在看着它"的名单，它都只在一半上

**它不在恢复网里。** `scripts/robot-boot-check:32`：

```sh
MEMBERS="updaterd.service robotd.service configd.service btd.service"
```

**`tofd` 不在这个名单上** —— 所以一个**反复崩溃的 ToF 不会触发回滚**
（见 [`scripts-primer.md`](scripts-primer.md) 的 `robot-boot-check` 一节：
判据是 `ActiveState=failed` **或** `NRestarts >= 3`）。

这是**有意的**，而且是 `tofd.service:8-10` 那句的自然推论：*"没有任何东西依赖这个单元。"*
**一个不是任何人的依赖的守护进程，不该有权把一个好发布换掉。**

**但它在另一份名单上。** `configd/src/units.rs:42-50`：

```rust
pub const MANAGED: [&str; 7] = [
    "updaterd.service", "robotd.service", "configd.service", "btd.service",
    "padd.service", "mediad.service", "tofd.service",
];
```

这是 `configd` 在**更新之后**报告"哪个守护进程还跑在旧发布上"的那份名单。
而它上面有一句关于**漏掉一个**的代价（`units.rs:39-41`）：

> It has already cost once: **`mediad` and `tofd` shipped units two releases before they were
> named here**, so the block a person reads after an update — the one that exists to say which
> daemon is still on the old release — **could not report either of them at all.**

**"那个存在的意义就是告诉你哪个守护进程还在旧发布上的区块，根本无法报告它们两个。"**

**所以 `tofd` 在两个名单上的位置不一样，而两个都是有意的**：
**它在"谁的健康决定回滚"里缺席，在"谁需要被报告"里在场。**

### 9.10 那条**故意不设**的加固

`tofd.service:32-34`：

```
# Same hardening as `padd`, minus the parts that would take the bus away.
# `PrivateDevices=` is deliberately NOT set: it would replace /dev with a minimal
# one that has no i2c node, and the failure would read as "no sensor fitted".
```

**"那个失败读起来会像'没有装传感器'。"** —— 一句在别处见过很多次的话：
**加固和硬件访问冲突的时候，失败会伪装成硬件不存在。**

### 9.11 那条身份

`main.rs:191-196`：

> The shared one, not a private copy: as well as the journal line, it publishes
> `/run/tofd/identity.json`, **which is where `robotctl health` and `scripts/dev-push.sh` read
> the release a daemon is actually running from.** **`tofd` was the one daemon that published
> nothing, so both reported it as silent — the exact gap the macro was written for, one daemon
> later.**

**"正是那个宏为之而写的缺口，只是晚了一个守护进程。"**

---

## 10. 头 IMU：为什么它在 `tofd` 里

### 10.1 为什么默认关

这是整个目录里**最有教育意义的一段测量**。`deploy/robotd.toml:386-392`：

> **Off by default, and this is the whole section.** Reading it at 100 Hz costs **~3.5-4.5% of a
> core** on this SoC, and a bench that takes the loop apart says **none of that is fixable**: the
> wakeups are **0.7 points** of it, the fusion **0.3**, and **the rest is the two I²C transactions
> a sample takes — which is what a gyro and an accelerometer sample *is*.** **Nothing subscribes
> to the stream yet, so every duck was paying it from boot for nobody.**

完整的表在 [`project/tof-on-demand.md`](project/tof-on-demand.md)：

```
  睡觉        (0 次读)   cpu 0.69 %
  只跑滤波器  (0 次读)   cpu 1.00 %
  update      (2 次读)   cpu 3.35 %
  update_all  (2 次读)   cpu 3.86 %
  三次读      (3 次读)   cpu 4.20 %
```

**被唤醒一百次是 0.69 个点；Madgwick 更新加 0.31；两个 I²C 事务是剩下的约 2.4–2.9。**

而那份文档**诚实地说出了自己数字的噪音底**：

> `update` and `update_all` do identical work (one delegates to the other) and came out **0.51
> points apart**, so **the noise floor is around half a point** — CPU frequency scaling on an
> A55, most likely.

**"噪音底大约是半个点。"**

### 10.2 结论：一个开关，而不是一个状态机

`tof-on-demand.md` 的 "What was decided"：

> **`[head_imu] enabled`, default off.** Nothing in the loop paid off, so **the switch is the
> answer: a stream nothing subscribes to should not cost ~4% of a core from boot.**

而**为什么不是"按需启动"**，那份文档给了三条，最漂亮的是最后一条：

> **The bring-up is seconds, and it is per process.** … **A `monitor` that started the unit on `t`
> would show an empty grid for seconds.**
>
> **Nothing owns the "off".** Two clients can want depth at once, so stopping on exit needs
> **a reference count that survives a client being `SIGKILL`ed**, and systemd has none for
> manually started units. **A `monitor` killed with Ctrl-\\ would leave the sensor ranging
> forever.**

**"一个被 Ctrl-\\ 杀掉的 `monitor` 会让传感器永远测下去。"**

### 10.3 ⭐ "关掉了"和"没装"必须是两句不同的话

`imu.rs:93-103`：

```rust
/// Switched off in the config, rather than absent or broken.
///
/// A separate sentence from `Self::lost` on purpose: **every other reason this stream has
/// nothing is a board to go and look at, and this one is a line in `robotd.toml`.** A
/// subscriber that cannot tell them apart **sends somebody to check a cable.**
```

而那句理由**点名了那个键**：

```
the head IMU is off — `[head_imu] enabled = true` in robotd.toml, then restart tofd
```

`imu.rs:277` 的测试把它钉住了：`assert!(why.contains("[head_imu] enabled"), "{why}")`。

### 10.4 那个省掉的第三次读

`imu.rs:160-170`：

> `update_all` rather than `update`: both read the accelerometer and the gyroscope, and **only
> this one hands the accelerometer sample back.** Asking for it afterwards — which is what this
> loop used to do — **read the same six registers a second time.**
>
> **Not for the CPU.** A transaction is worth about **9 µs of the ~440 µs a sample costs** on
> this board (`bench_imu` at 100 Hz: 4.53% for three reads against 4.46% for two), so **this buys
> nothing measurable** and the idle cost of this thread is somewhere else entirely. What it buys
> is that **the published `accel` is the sample the quaternion was computed from**, rather than
> one read ~200 µs later, and that **a read can fail in one place instead of two** — either chip
> failing reopens rather than **publishing a zero acceleration, which a consumer cannot tell from
> free-fall.**

**"一次零加速度，消费者无法把它和自由落体区分开。"**

**注意这段的结构**：它先说"这不是为了 CPU"，再给出 CPU 的数字，再说真正的原因。
**一种把"我们量过了、结论是不是这个理由"写下来的方式。**

### 10.5 那个共享总线的论证

`imu.rs:3-6` 回答了一个**一定会被问**的问题：

> The bus is accessed one transaction at a time (**each carries its slave address**), so
> **a second `i2cdev` handle for the IMU coexists with the ToF driver's handle**; the kernel
> serialises transactions at the adapter.

**"每次事务都带着自己的从机地址，所以第二个句柄可以和 ToF 驱动的句柄共存；内核在适配器那一层串行化事务。"**

### 10.6 一个失败的读会重新走退避

`imu.rs:201-203`：

```rust
// A read failure fell straight back into `open_imu`: a chip that answers its ID but
// cannot stream was reopened in a tight loop, warning each time, on the bus the audio
// codec shares. Same backoff as the open-failure path above.
```

**"一个能回答 ID 但不能推流的芯片，会在一个紧凑的循环里被反复重开、每次都警告 —— 而且在音频 codec 共用的那条总线上。"**

### 10.7 `config.rs`：一个坏掉的文件不是停下来的理由

`config.rs:21-27`：

> **A file this daemon cannot read is not a reason to stop ranging.** **`robotd` refuses to start
> on a broken params file, which is the loud signal and belongs to the daemon whose control loop
> the file configures; depth is what somebody looks at while sorting that out.** So this warns,
> names the file, and carries on with the defaults — which for `[head_imu]` means off, **the same
> answer an unprovisioned board gets.**

**"`robotd` 在一份坏掉的参数文件上拒绝启动 —— 那是响亮的信号，属于那个文件所配置的控制环的守护进程；
而深度正是有人在排查这件事的时候会去看的东西。"**

而为什么单独一个文件（`config.rs:8-10`）：

> Its own module rather than four lines in `main`, for the reason `mediad`'s config is: **`main`
> here is largely Linux-only, so anything living in it is not compiled — let alone tested — on
> the machine it is written on.**

**"否则住在里面的东西，在写它的那台机器上根本不会被编译 —— 更不用说被测试。"**

---

## 11. 对外的形状

`tofd` **只服务两个方法**（`main.rs:723-729`）：

```
tofd serves tof.stream and head_imu.stream and nothing else
```

而搞错方法名**会被回答，而不是被断开**（`main.rs:700-702`）：

> One request, and it must be `tof.stream`. **Anything else is answered and the connection kept**,
> so **a client that spells a method wrong is told rather than dropped.**

### 11.1 `tof.stream` 的答复

`duck-ipc-proto/src/lib.rs:4620-4635`：

```rust
pub struct TofStreamResult {
    pub accepted: bool,
    /// 回答了的那一代，例如 `VL53L8CX`。没有时是 `None` —— 见 `unavailable`。
    pub sensor: Option<String>,
    /// 为什么没有传感器：没装、代不对、总线读不了。
    pub unavailable: Option<String>,
    /// 帧的几何，**这样视图可以在第一帧到达之前就排好版**。
    pub rows: u8,
    pub cols: u8,
    pub hz: u8,
}
```

### 11.2 `tof.frame` 的四个时间字段

`duck-ipc-proto/src/lib.rs:4656-4672`：

| 字段 | 是什么 | 为什么 |
|---|---|---|
| `seq` | 这个 `tofd` 启动以来的帧号 | **"so a consumer can see a gap it did not cause"** |
| `at_us` | 启动以来的微秒 | 发送方自己的单调钟 |
| `t_ns` | `CLOCK_MONOTONIC` 纳秒 | **和 `RobotState::t_ns` 共享的那个钟**（v24） |
| `rows` `cols` `distance_mm` `status` | 帧本身 | 毫米 + 原始状态 |

**`t_ns` 是唯一一个能和别的守护进程对齐的时间戳** —— `at_us` 只在 `tofd` 内部有意义。
这是一个很容易搞混的地方。

### 11.3 那个丢包的可见性

`main.rs:21-23`：

> A subscriber that stops reading is **dropped rather than allowed to slow the sensor**
> (`broadcast` gives that for free, and **a lagging consumer's gap is visible in
> `proto::TofFrame::seq`**).

```rust
/// How many frames a slow subscriber may fall behind before it starts losing them.
/// **Two seconds at 15 Hz — generous, bounded, and the loss is visible as a jump in `seq`
/// rather than a silent hole.**
const FRAME_BUFFER: usize = 32;
```

而丢帧**不是致命的**（`main.rs:751-754`）：`Lagged` 只记一条 debug 日志，然后继续。

### 11.4 `head_imu.frame` 的坐标系警告

`duck-ipc-proto/src/lib.rs:4690-4696` —— 这一段很重要：

> All values are in **the IMU's own axes, which are tilted relative to the head/camera — the
> mount is not axis-aligned.** To place a sample in the trunk/camera frame, **rotate it by
> `FramesState::head_imu`** (the sensor→trunk pose the kinematics compute for this tick). **This
> is the head IMU, distinct from the body IMU that `RobotState::imu` carries on the motor bus.**

**"这是头部 IMU，和 `RobotState::imu` 在电机总线上携带的那个身体 IMU 不是一回事。"**

而 `imu.rs:18-20` 划了这条边界：

> Orientation is a Madgwick fusion (the `bmi088` crate's `Bmi088Ahrs`); `gyro`/`accel` are the
> raw sensor axes. **Placing the sample in the head frame (the IMU is rigid to the camera) is a
> `kinematics` job for the consumer, not this daemon's.**

**"把样本放到头部坐标系里是消费者（`kinematics`）的活，不是这个守护进程的。"**

这一条**和 ToF 那边是同一个原则** —— 见下。

### 11.5 ⭐ ToF 那边不做重投影，是同一个决定

`lib.rs:34-41`：

> ## What a frame is, and is not
>
> Raw zone distances and ST's per-zone status, **in the sensor's own frame.** **There is no
> reprojection**: turning zones into directions in the robot's frame **needs the head's forward
> kinematics, which this daemon does not have and does not fake.** Consumers that want geometry
> (mapping, obstacle avoidance) **will combine `tof.frame` with joint state when the kinematics
> arrive**; consumers that want to *look* at the sensor — `robotctl monitor` — **need none of
> it.**

**"它没有、也不假装拥有头部的正运动学。"**

**两个传感器、同一条边界**：`tofd` 交出**传感器坐标系里的原始值**，
几何留给 `kinematics`（见 [`kinematics-primer.md`](kinematics-primer.md)）。

---

## 12. 谁在读它

### 12.1 `tof.stream` 有一个订阅者

**`robotd` 的特雷门**（`robotd/src/theremin.rs:234-241`）——
它连一次、然后一直持有：

```rust
fn stream_frames(socket: &Path, slot: &ArcSwapOption<Frame>) -> Result<(), String> {
    let stream = UnixStream::connect(socket)...;
    let request = proto::Request::call(proto::Id::Number(SUBSCRIBE_ID), &proto::Call::TofStream);
```

这就是 `tof-on-demand.md` 里那条论证的由来：

> **`robotd`'s theremin can keep subscribing at startup.** Its depth reader **connects once and
> holds**, which **under a ranging gate would have pinned the laser on for exactly the ducks that
> play notes.**

**`robotctl monitor`** 也订阅（`robotctl/src/monitor.rs:574-591`），
而且是**唯一一个"必须被告知才去读"的读者**（`monitor.rs:638`）。

### 12.2 `head_imu.stream` 没有本地订阅者

`tof-on-demand.md`：

> **Nothing subscribes to it.** `head_imu.stream` has no consumer in this tree … It was added for
> **the mapping work, which has not arrived.** So **the largest recurring cost in this daemon is a
> sensor read for nobody.**

而**远端的客户端可以订阅** —— `mediad` 的路由允许它（`mediad/src/route.rs:214-215`）：

```rust
// The head IMU rides the same video path, for the same reason: it annotates the frames.
HeadImuStream => true,
```

对照 `btd/src/route.rs:486-491`：

```rust
// `tofd`, which is not one of the sockets `btd` holds. When a phone has a …
TofStream => false,
// Same as the ToF: the head IMU is tofd's, reached over mediad's video path, not BLE.
HeadImuStream => false,
```

而 `updater/src/ipc.rs:862-869` 用一句**说明地址**的错拒绝了它们：

```
tof.stream and head_imu.stream are served by tofd itself, on /run/tofd/tof.sock
```

**所以「没有消费者」指的是没有*订阅者*** —— 三个守护进程都对"要不要转发这个调用"表了态，
而只有 `mediad` 说可以。

### 12.3 一张表

| 谁 | 对 `tof.stream` | 对 `head_imu.stream` |
|---|---|---|
| **`robotd`（特雷门）** | **订阅**（且**自己解释状态字节**，见 §3.6） | 不订阅 |
| **`robotctl monitor`** | **订阅**（用户按了才连） | 不订阅 |
| **`mediad`（relay）** | **转发** | **转发** |
| **`btd`（BLE）** | 拒绝（`route.rs:489`） | 拒绝（`route.rs:491`） |
| **`updaterd`** | 拒绝（`ipc.rs:863`） | 拒绝（`ipc.rs:863`） |

---

## 13. 几处读者会绊到的地方

按仓库的规矩，这里只**陈述事实**，不判断该怎么办。

### 13.1 ⚠️ `tof-on-demand.md` 用现在时描述了一个第二天就被修掉的 bug

`docs/project/tof-on-demand.md` 的 "§1. Make 'somebody wants this' true — a bug either way" 写着：

> `accept` subscribes a connection to **both** channels before it has read a byte of the request
> (`tof/src/main.rs:612`), so `receiver_count()` counts connections, not interest …
> **Move the `subscribe()` calls inside the matched arms of `subscriber()`** …
> **This is worth doing on its own** … and it is the prerequisite for anything below.

**但代码里已经做完了**（`tof/src/main.rs:708-712`），而且带着一个专门的测试
（`main.rs:831-875`），测试的注释甚至复述了同样的理由。

时间线：

```
6944e8f  2026-09-09  The head IMU is off until something reads it   ← tof-on-demand.md 在这里写的
0df8ea4  2026-09-10  tofd: only subscribe to the stream that was asked for   ← 第二天就修了
```

而 `tof/src/main.rs:612` 现在指的是一句关于 `RuntimeDirectory` 的注释，和订阅无关。

**这本身不违反仓库的文档纪律** —— `docs/README.md` 里 `project/` 那一节写着
*"Dated records rather than reference. They describe a moment, and **go stale on purpose**."*
它是一份**有日期的记录**，不是参考文档。但按那个体例，**读它的人应该知道
§1 描述的是一个已经不存在、且当天就被修掉的形状** —— 而它现在读起来像是在待办。

### 13.2 `tof-on-demand.md` 里另外两个指不到地方的引用

同一份文档里：

| 文档里写的 | 实际在哪 |
|---|---|
| `btd` declines to proxy it (`btd/src/route.rs:412`) | `btd/src/route.rs:491`（`:412` 是一段关于"把机器人立起来"的注释） |
| the updater's degraded IPC declines it (`updater/src/ipc.rs:819`) | `updater/src/ipc.rs:863`（`:819` 是 `net.*` 那个列表的开头） |

两处的**内容都是对的**，只有行号漂了。

### 13.3 两份 shim 是逐字相同的

```
$ wc -c tof/vendor/vl53l5cx/shim.c tof/vendor/vl53l8cx/shim.c
2770 tof/vendor/vl53l5cx/shim.c
2770 tof/vendor/vl53l8cx/shim.c
```

**两个文件按字节数相同**，而且把代号前缀互相替换之后 `diff` 为空 ——
它们只在 `vl53l5cx`/`vl5`/`L5CX` 与 `vl53l8cx`/`vl8`/`L8CX` 这些名字上不同。

`build.rs:11-16` 把"每个代编译自己那份"讲成了一条有意的设计，而**这两份文件现在由手工保持同步** ——
没有生成步骤，也没有测试会在它们漂开时报错。（`platform.c` 是**真的**一份实现，靠 define 分代；
`shim.c` 不是。）

### 13.4 `Cargo.toml` 的头一句话只提了一代

`tof/Cargo.toml:1`：

> The head ToF sensor: an 8x8 depth matrix from **a VL53L8CX**, and the daemon that serves it.

而 `sensor.rs:76` 说 **`L5cx` 是"the older sensor, and the one most ducks in the field have"**，
`lib.rs:8-11` 也说两代都要支持。

**头一句话只提 L8CX，和"场上大多数是 L5CX"并排读起来会让人以为装错了。**

### 13.5 `--fake` 和 `--sim` 是互斥的，但错误信息来自 clap

`main.rs:168`：

```rust
#[arg(long, conflicts_with = "fake")]
sim: Option<String>,
```

这是**对的方向**（`--fake` 和 `--sim` 不可能同时有意义），但如果你两个都传，
报错会是 clap 的标准措辞，**不会告诉你"`--sim` 是 `--fake` 之上再加一层模拟身体"这个区别** ——
而那个区别写在 `main.rs:159-169` 的文档注释里，命令行上看不到。

### 13.6 一处小的：`lib.rs:56` 的注释说的是「只有状态说了算」

`lib.rs:55-56`：

> `distance_mm` and `status` are parallel, row-major, `ZONES` long. **A distance is only meaningful
> where the status says so** — see [`Zone`].

准确，但**不完整**：状态说了算之后，`zone()` 还会再检查距离是否为正（`lib.rs:94-99`）。
一个只读这句注释的人会以为"状态 5 ⇒ 一定有范围"。

而 §3.6 是它的**另一个**方向的不完整：`[5, 9]` 也只是 `tof` 自己的答案，
下游的特雷门故意用了一个更宽的集合。

### 13.7 ⚠️ `architecture.md` 里有两行在说"没人读 `tofd`"

`docs/design/architecture.md` 的服务表里，`tofd` 那一行（`:88`）写的是：

> | `tofd` | the head's ToF sensor: an 8×8 depth matrix **it publishes and nobody else reads** |
> `/run/tofd/tof.sock` (`tof.stream`) | the HAT's I²C bus |

**而这是不准确的**：`robotd` 的特雷门订阅它（`robotd/src/theremin.rs:234`），
`robotctl monitor` 订阅它（`robotctl/src/monitor.rs:579`），
`mediad` 转发它（`mediad/src/route.rs:213`）。

同一份文件的行内文字（`:134`）说的是 *"Owns one sensor and publishes frames; **reads
nothing**"* —— **那一句是对的**（是它在读传感器、不读别人），
而 `:88` 那句把"**它不读别人**"写成了"**别人不读它**"，方向反了。

**两行的差别是主客颠倒**，而按仓库的规矩（`CLAUDE.md`：*"当行为和一份设计文档不一致时，
文档是 bug"*），`:88` 是需要改的那一个。

---

## 14. 阅读路线

**2,191 行，是仓库里最小的 crate 之一。可以一次读完。**

### 如果只有十分钟

读 §3 那三种状态，然后读 `tof/src/lib.rs:65-116`（`Zone` 和 `Frame::zone`）。
**那 50 行是这个目录最核心的东西。**

### 路径 A：我想理解这一帧数据（约 20 分钟）

| 步 | 读什么 |
|---|---|
| 1 | `tof/src/lib.rs:1-51`（crate 的论点 + 那个常量） |
| 2 | `tof/src/lib.rs:53-116`（`Frame`、`Zone`、`zone()`、`valid_count()`） |
| 3 | `tof/src/lib.rs:132-146`（那个三态测试） |
| 4 | `duck-ipc-proto/src/lib.rs:4656-4690`（线格式为什么带状态字节） |
| 5 | `robotctl/src/monitor.rs:762` 起（网格怎么画这三态） |

### 路径 B：我想加一个传感器（约 1 小时）

| 步 | 读什么 |
|---|---|
| 1 | `tof/build.rs` 全文（118 行，只有一件事：六次重命名） |
| 2 | `tof/vendor/platform.c:1-45`（一份实现怎么被编译两次） |
| 3 | `tof/vendor/probe.c` 全文（60 行，那个先有鸡还是先有蛋） |
| 4 | `tof/src/sensor.rs:1-19` + `:224-286`（边界和 open 的顺序） |
| 5 | `tof/src/sensor.rs:342-380`（**非 Linux 上那个不可构造的类型**） |

### 路径 C：我在乎那颗 CPU（约 40 分钟）

| 步 | 读什么 |
|---|---|
| 1 | [`project/tof-on-demand.md`](project/tof-on-demand.md) 全文（那张表 + 那次"不做什么"） |
| 2 | `tof/src/main.rs:60-91`（`POLL`、`POLL_GUARD`、退避） |
| 3 | `tof/src/main.rs:899-926`（**四个把节省量写成算术的测试**） |
| 4 | `tof/src/imu.rs:43-60`（`BETA`、退避、`TEMP_EVERY`） |
| 5 | [`project/idle-cpu.md`](project/idle-cpu.md)（它的前一篇） |

### 路径 D：我在排查"没有深度"

1. `tof/src/status.rs:1-5`（"没有传感器"和"还没有帧"是两句不同的话）
2. `tof/src/main.rs:570-573`（缺总线 ≠ 没人应答）
3. `tof/src/main.rs:93-107`（两条兼容旧板子的候选列表）
4. `tof/src/sensor.rs:250-279`（五个阶段的五句话）
5. `tof/systemd/tofd.service:32-34`（**为什么 `PrivateDevices=` 没设**）

### 路径 E：我想理解特雷门为什么"看得见手"（约 25 分钟）

| 步 | 读什么 |
|---|---|
| 1 | §3.6（**为什么它不用 `Zone`**） |
| 2 | `kinematics/src/hand.rs:1-35`（那个"聪明版本"为什么死了） |
| 3 | `kinematics/src/hand.rs:60-85`（`Config` 的默认值，含那七个状态码） |
| 4 | `kinematics/src/hand.rs:217-243`（那个把 bug 钉住的测试） |
| 5 | `robotd/src/theremin.rs:55-70`（为什么帧被原样留着） |
| 6 | [`deploy/robotd.toml`](../deploy/robotd.toml) 的 `[theremin] statuses` 一段 |

### 三条贯穿全文的主线

1. **交出原始值，把几何留给别人。** ToF 不重投影（`lib.rs:34-41`），
   IMU 不放进头部坐标系（`imu.rs:18-20`）。**同一个决定，在两个传感器上各说了一遍。**

2. **"我不知道"必须是一个可以说出口的答案。** 三种状态而不是一个数字；
   "关掉了"和"没装"是两句话；"正在启动"是一个句子而不是 `None`；
   未知的传感器代**绝不猜**（"上传错的 blob 就是你搞砖一个探头的方式"）。
   **这个目录里几乎每一处设计问题，最后都归结成"这句沉默会被读成什么"。**

3. **量过之后再决定，而且把"没量出来"也写下来。**
   `1.00% / 3.35% / 3.86% / 4.20%`、`0.69` 个点的唤醒、**"噪音底大约是半个点"**、
   **"这不是为了 CPU"** —— 那份测量记录里有一节专门叫
   "What is left for a board"，列的是**还没量、但不值得为它再上板子**的东西。
   **这种诚实比数字本身更值得学。**

---

## 15. 术语表

| 词 | 意思 |
|---|---|
| **ToF** | Time of Flight，飞行时间测距。发出一束光，量它多久回来 |
| **VL53L8CX / VL53L5CX** | ST 的两代 ToF 传感器。**这里都支持，运行时按 ID 选** |
| **ULD** | Ultra Lite Driver，ST 给这些传感器的官方 C 驱动 |
| **固件上传** | 每次启动往传感器里灌 ~90 KB 的 blob。**几秒钟** |
| **zone / 区** | 8×8 矩阵里的一格 |
| **8×8** | 分辨率。64 个区（`ROWS * COLS`） |
| **status / 状态字节** | ST 的每区结论。**5/9 = 有效，255 = 那里什么都没有，其它 = 失败** |
| **`Range` / `NoTarget` / `Unusable`** | 那三态的 Rust 名字 |
| **`valid_count()`** | 有多少区给出了可用范围。**唯一那个"它到底看见东西没有"的数** |
| **`statuses`（`hand::Config`）** | 特雷门信的**七个**状态码。**和 `Zone` 的 `[5,9]` 不是同一个集合**，见 §3.6 |
| **重投影 / reprojection** | 把"哪个区"变成"哪个方向"。**这个 crate 不做** |
| **正运动学 / forward kinematics** | 从关节角算出某个部位在哪。做重投影需要它 |
| **I²C** | 两根线的低速总线。**一次事务带一个从机地址** |
| **i2c-dev / `I2C_RDWR`** | Linux 暴露 I²C 的方式：一个设备文件 + 一个 ioctl |
| **`/dev/i2c-3` / `/dev/i2c-pihat`** | 同一条总线。后者是 udev 装的符号链接 |
| **overlay** | 设备树的一段，描述"板子上有什么"。**没有它就没有 i2c3** |
| **HAT** | 扣在板子上的那块扩展板。ToF、IMU、codec 都在上面 |
| **BMI088** | 那个头部 IMU：三轴陀螺仪 + 三轴加速度计，两个从机地址 |
| **陀螺仪 / 加速度计** | 角速度 / 比力（m/s²） |
| **Madgwick** | 一种姿态融合算法。**从陀螺仪和加速度计估计朝向** |
| **`BETA`** | Madgwick 的收敛率。0.1 |
| **四元数 / quaternion** | 表示旋转的四个数。这里标量在前 `[w,x,y,z]` |
| **姿态 / orientation** | 哪个方向是上 |
| **`i2cdev`** | Rust 的 `embedded-hal` I²C 实现 |
| **`repr(C)`** | 让 Rust 结构体的内存布局和 C 一致。**这里刻意避免** |
| **shim** | 一层薄薄的 C，把复杂的 C 接口变成几个标量函数 |
| **ULD status** | 驱动返回的错误码。**0 是成功** |
| **libc / ioctl** | 直接调 C 库和内核接口 |
| **udev** | Linux 的设备管理器。`/dev/` 下的名字由它管 |
| **`uninhabited` / 不可构造** | 一个没有任何值的类型。**编译器因此可以排除它的所有方法** |
| **broadcast（tokio）** | 一对多频道。**慢的订阅者会丢帧而不是拖慢发送方** |
| **`Lagged`** | "你跟丢了 N 条"。**丢帧不是错误** |
| **`seq`** | 帧号。**用它看出你没造成的一个缺口** |
| **`t_ns` / `CLOCK_MONOTONIC`** | 那个和别的守护进程共享的钟。**`at_us` 不能跨进程比** |
| **退避 / backoff** | 失败后越等越久。这里 1 秒翻倍到 60 秒 |
| **poll** | 反复问"好了吗" |
| **`POLL` / `POLL_GUARD`** | 每 10 毫秒问一次 / 帧到期前 20 毫秒才开始问 |
| **`RuntimeDirectory=`** | systemd 帮你建的 `/run/<服务>`，停了就删 |
| **`Sysusers.d`** | 声明"这个服务需要一个用户和组"的文件 |
| **`SupplementaryGroups=`** | 给守护进程额外加的组。**这里是 `i2c` 和 `robot`** |
| **`PrivateDevices=`** | 一个 systemd 加固项，**这里故意没设**（会把 i2c 节点藏掉） |
| **`CapabilityBoundingSet=`** | 清空 —— 一点特权都不给 |
| **degraded IPC** | 更新期间那个只能回答一小部分的兜底接口 |
| **`robotctl monitor`** | 那个把帧画成网格的终端界面 |
| **特雷门 / theremin** | 手在鸭子前面的距离变成音高。**唯一的本地 `tof.stream` 订阅者** |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| **为什么感知是自己的守护进程**（本导读的依据） | [`design/architecture.md`](design/architecture.md) §1 |
| **那 5% CPU 的完整测量记录** | [`project/tof-on-demand.md`](project/tof-on-demand.md) |
| 它的前一篇：守护进程空闲时在干什么 | [`project/idle-cpu.md`](project/idle-cpu.md) |
| 那个唯一的消费者（姊妹篇） | [`robotd-primer.md`](robotd-primer.md) · [`duck-control-primer.md`](duck-control-primer.md) |
| 把帧变成几何（姊妹篇） | [`kinematics-primer.md`](kinematics-primer.md) |
| `tof.stream` 的线上契约（姊妹篇） | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| `monitor` 里那个网格（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| 那条 I²C 总线是怎么来的（姊妹篇） | [`deploy-primer.md`](deploy-primer.md) · [`scripts-primer.md`](scripts-primer.md) |
| 手柄自己的 IMU（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| 深度矩阵怎么用来避障（姊妹篇） | [`duck-detect-primer.md`](duck-detect-primer.md) |
| 里程计里那个 `trunk_height_m`（姊妹篇） | [`odometry-primer.md`](odometry-primer.md) |
| 特雷门那门乐器（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| `[head_imu]` 的 schema（姊妹篇） | [`robotd-params-primer.md`](robotd-params-primer.md) · [`../deploy/robotd.toml`](../deploy/robotd.toml) |
| 仿真的身体协议（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| 摄像头那条感知通道（姊妹篇） | [`mediad-primer.md`](mediad-primer.md) |
| 蓝牙门房（姊妹篇） | [`btd-primer.md`](btd-primer.md) |
| BLE 的线上契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| wifi、身份、手柄配对（姊妹篇） | [`configd-primer.md`](configd-primer.md) |
| 笔记本上那个客户端（姊妹篇） | [`duckctl-primer.md`](duckctl-primer.md) |
| 更新时在这块板子上跑的那两个脚本（姊妹篇） | [`hooks-primer.md`](hooks-primer.md) |
| 麦克斯韦那只鸭子的"耳朵"（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| 手柄：按键映射、模式（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| 装完之后你用的那个 CLI（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
