# `duck-control` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> 控制路径的机制由 [`design/robotd-design.md`](design/robotd-design.md) §2 拥有（英文）。
> 两者若有不一致，以设计文档为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：[`robotd-primer.md`](robotd-primer.md)（那个**调用**这个 crate 的守护进程）。

## 目录

1. [一分钟版](#1-一分钟版)
2. [为什么它不是一个 daemon](#2-为什么它不是一个-daemon)
3. [核心心智模型：接缝与唯一的写句柄](#3-核心心智模型接缝与唯一的写句柄)
4. [目录导览](#4-目录导览)
5. [一个 tick 的数据流](#5-一个-tick-的数据流)
6. [`RobotIo`：三个后端](#6-robotoi三个后端)
7. [读总线：`bus.rs`](#7-读总线busrs)
8. [12 字节的 IMU：`imu.rs`](#8-12-字节的-imuimurs)
9. [61 个浮点：`obs.rs`](#9-61-个浮点obsrs)
10. [神经网络：`policy.rs`](#10-神经网络policyrs)
11. [唯一能写总线的地方：`safety.rs`](#11-唯一能写总线的地方safetyrs)
12. [预测摔倒：`fall.rs`](#12-预测摔倒fallrs)
13. [机器人作为数据：`model.rs`](#13-机器人作为数据modelrs)
14. [第三个后端：`sim.rs`](#14-第三个后端simrs)
15. [测试](#15-测试)
16. [阅读路线](#16-阅读路线)
17. [术语表](#17-术语表)

---

## 1. 一分钟版

`duck-control` 是**从读总线到写总线之间的一切**：

```text
   读总线 ──▸ [ duck-control ] ──▸ 写总线
              │
              ├─ model.rs     机器人是什么（15 个关节、ID、home 姿态）
              ├─ bus.rs       跟 15 个舵机 + IMU 板说话
              ├─ imu.rs       把 12 个字节变成"机器人朝向哪"
              ├─ io.rs        RobotIo trait —— 控制循环和物理世界之间的接缝
              ├─ obs.rs       61 个浮点：神经网络看到的世界
              ├─ policy.rs    ONNX 神经网络
              ├─ safety.rs    唯一能写总线的地方
              ├─ fall.rs      预测"是不是要摔了"
              └─ sim.rs       第三个后端：MuJoCo 里的鸭子
```

**它不是守护进程。** lib.rs 开头：

> 故意**不是**一个守护进程。这里没有 tokio、没有 socket、没有 systemd —— 那些都归 `robotd`。
> 边界由**编译器**而不是纪律来保证，**这正是阻止"进程的顾虑"渗进驱动电机的代码里的东西**。

规模：约 4900 行，10 个模块，**86 个测试**（其中 8 个标了 `#[ignore]`，需要 ONNX Runtime）。

---

## 2. 为什么它不是一个 daemon

这个 crate 和 `robotd` 的分工，是理解整个控制系统的起点：

```text
   ┌─────────────────────────────────────────────────────────┐
   │  robotd —— 守护进程                                     │
   │    socket · JSON-RPC · systemd · 健康上报 · 50 Hz 的循环 │
   │    客户端、意图槽、策略换版、limp-fall 状态机……          │
   └───────────────────────┬─────────────────────────────────┘
                           │  调用
                           ▼
   ┌─────────────────────────────────────────────────────────┐
   │  duck-control —— 库                                     │
   │    纯计算 + 一条串口                                     │
   │    **没有 tokio、没有 socket、没有 systemd**             │
   └─────────────────────────────────────────────────────────┘
```

**为什么分开？** 设计文档给了三条理由：

**一、边界由编译器保证。** 这个 crate 里的代码**没法**去碰 socket 或 systemd —— 因为它连那些依赖都没有。所以"进程的顾虑不要渗进控制代码"不是一条需要记住的规矩，而是一个**编译错误**。

**二、测试不需要硬件。** 因为 `RobotIo` 是一个 trait（第 6 节），整个控制路径能在**没有机器人的笔记本上**跑完。

**三、它将来可以被搬进另一个仓库。** 设计文档说，这样"原型过渡期"可以复用同一份控制核心，而不用重写。

> 💡 一个具体的证据：这个 crate 的 `Cargo.toml` 里**没有** `tokio`，也**没有** `serialport` 之外的任何 IO 依赖。

---

## 3. 核心心智模型：接缝与唯一的写句柄

整个 crate 可以画成两句话。**看懂这两句，就看懂 `duck-control` 了。**

### 3.1 `RobotIo` 是接缝

```text
   ┌────────────────────────────────────────────────┐
   │  纯计算                                        │
   │  obs → policy → safety 的夹取与拒绝            │
   │  （这一部分完全不需要机器人）                  │
   └────────────────────┬───────────────────────────┘
                        │
              ┌─────────┴─────────┐
              │   trait RobotIo   │  ← 接缝（seam）
              └─────────┬─────────┘
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
   DynamixelIo       FakeIo         RemoteIo
   真的串口总线      笔记本上的假件   MuJoCo（TCP）
```

**`read()` 和 `write()` 之间的一切都是纯数据计算。** 这就是整个循环能在笔记本上被测的原因 —— 也是这个 crate 能独立存在的原因。

### 3.2 `safety` 拥有唯一的写句柄

```rust
pub struct Safety<T: RobotIo> { io: T, ... }
```

`safety` **拥有**那个 `RobotIo`。策略、控制器、客户端**都没有** —— 它们只能**提议（propose）**目标，只有 `safety` 能**发出（command）**。

> `robotd-primer.md` §6.1 讲过这条，这里是它的**实现**：
> 这是**借用检查器**强制的，不是靠约定。所以"没有东西能命令电机"是**结构上不可能**，
> 而不是"大家记得别这么写"。

---

## 4. 目录导览

```text
duck-control/
├── Cargo.toml                     依赖（注释解释了每个非显然的选择）
├── src/
│   ├── lib.rs             27 行   模块声明 + re-export
│   ├── model.rs          276 行   机器人作为数据：三张表 + 电池 + 嘴
│   ├── io.rs             351 行   ★ RobotIo trait + FakeIo
│   ├── bus.rs            743 行   ★ DynamixelIo —— 真的串口
│   ├── imu.rs            355 行   SFLP 解码、四元数、半精度
│   ├── obs.rs            406 行   ★★ 61 个浮点（"本 crate 风险最高的代码"）
│   ├── policy.rs         811 行   ★ ONNX 的边界
│   ├── safety.rs         913 行   ★ 唯一能写总线的地方
│   ├── fall.rs           272 行   摔倒预测
│   └── sim.rs            441 行   RemoteIo —— MuJoCo 里的鸭子
├── examples/
│   └── policy-rehearsal.rs 77 行  离线跑一个 .onnx，量延迟
└── tests/
    ├── recurrent_policy.rs 164 行 循环网络的状态测试（`--ignored`）
    └── fixtures/                  13 个手写的 .onnx + generate.py
```

**建议的阅读顺序：** `lib.rs` → `model.rs` → `io.rs` → `obs.rs` → `safety.rs` → `policy.rs` → `imu.rs` → `bus.rs` → `fall.rs` → `sim.rs`。

先读 `obs.rs` 是因为它定义了"神经网络看到什么"，`safety.rs` 定义了"什么绝对不允许发生"。`bus.rs` 和 `imu.rs` 放后面，因为它们是**硬件的细节**，而前面那些是**逻辑**。

---

## 5. 一个 tick 的数据流

```text
   ①  bus.rs  read()
   ┌──────────────────────────────────────────────────────────┐
   │  一次 sync_read：IMU 板(id 200) + 15 个舵机              │
   │  · IMU 排最前，先于舵机突发应答                          │
   │  · 每个舵机 12 字节：电流 / 速度 / 位置                  │
   │  · IMU 槽 12 字节：陀螺仪 + SFLP 四元数                  │
   └────────────────────┬─────────────────────────────────────┘
                        ▼
   ②  imu.rs  SflpDecoder::decode()
      12 字节 → 陀螺仪(rad/s) + 投影重力(单位向量) + 四元数
                        │
                        ▼
   ③  safety.rs  observe()
      更新"摔倒了没"的判定（防抖 200 ms）——**只是一个报告**
                        │
                        ▼
   ④  obs.rs  Observation::build()
      ┌────────────────────────────────────────────┐
      │  [ gyro(3) | 重力(3) | 关节位置(14) |      │
      │    关节速度(14) | 上次动作(14) | 指令(13) ]│  = 61 个浮点
      └────────────────────┬───────────────────────┘
                           ▼
   ⑤  policy.rs  infer()
      ONNX 网络 → 14 个动作（**跳过嘴**）
                        │
                        ▼
   ⑥  目标 = home 姿态 + 缩放 × 动作
      （这一步在 robotd 的 control.rs 里）
                        │
                        ▼
   ⑦  safety.rs  apply()          ★ 唯一能写总线的地方 ★
      · 非有限值 → **拒绝**（不夹）
      · 逐关节夹到 ±π（舵机行程）
      · 按需写增益
                        │
                        ▼
   ⑧  bus.rs  write()
      一次 sync_write：15 个目标位置
```

**注意第 ③ 步和第 ⑦ 步的关系**：摔倒判定**不门控任何东西** —— 它只是被发布出去，由上层（`robotd` 的 limp-fall 序列）决定要不要做点什么。设计文档的说法是：

> **一个必须被恢复流程绕过的安全规则，就不是一条安全规则。**

**还要注意第 ⑥ 步在 `robotd` 里，不在这个 crate 里。** 同样地，**电压适应也不在这里** —— 它在 `robotd` 的控制循环里（`scale_mult`）。`safety` 只管两件事：拒绝坏值、夹到行程。

---

## 6. `RobotIo`：三个后端

```rust
pub trait RobotIo {
    fn read(&mut self) -> Result<Sensors>;          // 关节 + IMU，一次事务
    fn write(&mut self, targets: &JointTargets) -> Result<()>;
    fn set_gain(&mut self, kp: u16) -> Result<()>;  // 每关节一次，不是每 tick
    fn set_torque(&mut self, on: bool) -> Result<()>;// 同上
    fn reboot(&mut self, id: u8) -> Result<()>;
    fn slow_sensors(&mut self) -> Result<SlowSensors>;
    fn imu_stale(&self) -> ImuStale;                // 默认实现
    fn imu_ready(&self) -> bool;                    // 默认实现
}
```

### 6.1 为什么关节和 IMU 在**同一个** `read` 里

> `Sensors` 把关节和 IMU 放在一起，因为**硬件就是这样**：IMU 板挂在 Dynamixel 总线上，
> 与舵机在**同一次事务**中取回。拆开这条 trait 等于**发明了总线并不存在的区分**，而且会令总线流量翻倍。

### 6.2 两个结构体的细节

**`Sensors`** —— 三个 `[f64; 15]`（位置、速度、电流）+ `imu`。

> 注意电流**丢弃符号**：方向可以从速度推断，消费者要的是**负载**。

**`SlowSensors`** —— `volts`（电压是**均值**）+ `temps_c: [f64; 15]`（温度**逐关节**）。

```text
   电压为什么取均值？15 个舵机接在**同一个电池包**上，
   所以单个读数只是同一个测量加了噪声。
   还要过滤掉答 0 的设备 —— 否则会像"电池空了一半"。

   温度为什么不取均值？因为**一个膝盖深蹲支撑**远热于嘴巴，
   15 个取平均恰好**掩盖了即将触发过热关断的那一个舵机**。
```

### 6.3 `ImuStale`：两个数回答两个问题

```rust
pub struct ImuStale {
    pub total: u64,  // 启动至今累计，永不重置
    pub run: u64,    // 当前连续重复的长度，任一新鲜块清零
}
```

- **`total`** 说明**整轮运行里板子重复了多少次**。零星命中很正常 —— 循环和板子各有自己的时钟，落在一次板载刷新内的 tick 合法地看到同样的字节。
- **`run`** 说明**此刻**姿态是否冻结。板子停止融合的话，每个 tick 都重复，`run` 无界增长。

> 两者必须**一起报**，否则会像当初那样把 `run` 单独误读成警报。

**为什么 tracker 里的 `last` 必须是 `Option`？** 这个细节很精妙：

> 全零的初始值**恰好就是** SFLP 表还没写时板子发的内容 ——
> 会对一个**从不存在的"前驱"**判陈旧，从而在每次启动的第一 tick 就往那个被当作警报渲染的计数器里放一个永久的 1。

### 6.4 `FakeIo`：笔记本上的机器人

默认的假舵机**完美跟踪** —— `read` 回显上次 `write` 的位置。公开字段让它能演示各种故障：

| 构造器 / 字段 | 演示什么 |
|---|---|
| `FakeIo::at(positions)` | 从一个给定姿态开始 |
| `FakeIo::frozen()` | 忽略写入 —— 一个无力、或被人推着的机器人 |
| `failing_reads(n)` | 连续 n 次读失败 —— 舵机没上电 |
| `fail_next_read` | 一次失败后自清，测错误路径 |
| `torque: Option<bool>` | **最重要的断言**：`None` = "重启没动机器人"长这样 |

> `slow: None` 让读失败，也就是"一个没有总线的机器人"。
> 默认值是 7.4 V / 32 ℃，这样 `--fake` 显示的是一个**合理的**机器人。

---

## 7. 读总线：`bus.rs`

`DynamixelIo` 是**真的**那个后端。它跟 15 个 XL330 舵机和一个 `imu_to_dxl` 板说话。

### 7.1 每个 tick 两次事务

```text
   read()          一次合并 sync_read：
                   ids = [200, 20..24, 30..34, 10..14]
                   地址 124，长度 12  ← IMU 板在同一地址提供 12 字节

   slow_sensors()  一次单独的事务（约每秒一次）：
                   ids = 15 个关节，地址 144，长度 3
                   = present_input_voltage (u16) + present_temperature (u8)
```

**为什么电压和温度不并进 tick 的那次读？** 因为它们晚 8 个字节 —— 中间隔着 `velocity_trajectory` / `position_trajectory` 那 12 个**没人要的**字节。并进去意味着每个舵机每 tick 应答 22 字节，**比两次事务更费总线时间**。

### 7.2 ⭐ 那两个 EEPROM 寄存器

启动时（`check_registers()`）会**断言并纠正**四个寄存器。其中两个值得单独讲：

#### `return_delay_time = 0`

> XL330 出厂是 **250**，那是**每个设备** 500 µs 的转身时间。
> **跨 16 个设备就是每 tick 8 ms —— 20 ms 预算的 40%** —— 全部花在等舵机"转过身来回答"上。

一个被恢复出厂或新换上的舵机会带着 250 到来，**所以这个检查消除了一整类"为什么这块板子上这么慢"**。

#### `shutdown = 52` —— 那一位的方向

```text
   52 = 0b110100
        │││└── bit 0: 输入电压   ← **清零**
        ││└─── bit 2: 过热
        │└──── bit 4: 电击
        └───── bit 5: 过载
```

**出厂值是 53 —— 只差这一位。**

> 那一位的作用是：**一旦供电超过舵机的 `Max Voltage Limit`，就清除力矩**。
> 而这个上限**本仓库从不写**，所以它保持默认的 **7.0 V**。
> 而一块充满的 2S 电池**高于它** ——
>
> **所以清零这一位，正是 15 个舵机不会在满电时集体锁死的原因。**

代码注释特意警告：**读成"在输入电压故障上锁存"，会得到与它实际行为完全相反的结论。**

有一个测试专门钉住这一位（`the_shutdown_mask_clears_the_input_voltage_bit`），注释说：出厂默认只差一位，**所以一个"恢复默认值"的后续改动应该撞上一个测试，而不是一条注释**。

### 7.3 换舵机：一条完整的收养流程

一个新 XL330 出厂是 **ID 1、57 600 baud** —— 而这两个值在本总线上都**刻意不用**（`model.rs` 里有测试钉住），**这正是让替换品能和所有已装舵机区分开的原因**。

```text
   ① missing_servos()    ping 15 个预期 ID
                         · 齐全 → 什么都不做（这是唯一额外开销）
                         · 恰好 1 个静默 → 继续
                         · 2 个静默 → 放弃（无从判断新品替谁，猜就会烧错关节）

   ② 先在本速 ping 一下 ID 1        （防"已经刷成 1 Mbps 但保留 ID 1"的情况）
      没有 → reopen(57 600) 再 ping
      还没有 → reopen(1 Mbps)，返回 false，调用方继续等

   ③ 先写 ID，再写波特率
      ← 顺序是承重的：第二条写在旧速率下被确认、之后才切换。
        反过来的话，两次写之间要白白重开一次端口。

   ④ check_registers_of(id)        跟其他舵机走完全相同的检查

   ⑤ reboot + 等 500 ms + ping 确认它回来了

   ⑥ 读 hardware_error_status —— 非 0 就报错
```

**第 ⑤ 步的 reboot 是刻意的，而且是整条流程里最微妙的一步：**

> 刷写会给舵机留下**硬件错误警报**，而那个警报会**一直保持力矩关闭**，直到断电或重启。
> 在这里 reboot 之后，它就与"一直都在"的舵机**无法区分**了。
>
> 而如果 reboot 之后警报还在，**必须报出来** —— 因为"一条腿无力"这个症状
> **指向不了任何地方**。

### 7.4 fast sync read（指令 `0x8A`）

普通 sync read：16 个设备各自发一个状态包，每个都有 10 字节的协议 2.0 包头，每个前面都有那个设备的转身时间。

**fast sync read：所有设备把数据块追加进*一个*来自广播 ID 的状态包**，总线每 tick 转身**一次**而不是 16 次。

**它全有或全无。** 一个不支持 `0x8A` 的固件设备**根本不应答**，所以整个读会**超时** —— 而不是"部分返回看起来合理的东西"。

需要 **XL330 固件 v46+**，而且 `id 200` 的 `imu_to_dxl` 板也得支持。

> **这是机器人硬件的属性**，也正是它是 `robotd.toml` 里一个**配置项**而不是本代码自行决定的原因。
>
> 代码**不做任何探测**：一个不应答的设备和**没上电的设备长得一模一样**，
> 启动探测要先能区分这两者才有意义。所以答案是一把**由人关掉的开关**，而不是每次启动做的猜测。

⚠️ 一个容易漏的地方：`DynamixelIo` 要**保存** `fast_sync_read` 字段，因为 `reopen()` 会新建 controller —— **漏了就会静默退回普通 sync read，一次换舵机会悄悄让 tick 的总线预算减半。**

### 7.5 换算常数

```rust
const RAD_PER_SEC_PER_COUNT: f64 = 0.229 * (2.0 * PI / 60.0);   // 0.229 rev/min per count

// 位置：4096 counts 一圈，中心偏移 −π
position = (2.0 * PI * counts / 4096.0) - PI;
```

两个都有测试**和 `rustypot` 自己的转换往返验证**。为什么值得测：

> 速度换算错了，**所有关节速度会被同一个常数缩放**，而策略**"容忍得恰好够走出难看的步态"**。
> 位置换算错了，**指令角和回读角会不一致**。

### 7.6 三个"等待"常量

| 常量 | 值 | 为什么 |
|---|---|---|
| `READ_TIMEOUT` | 30 ms | 健康的 16 设备读取远快于此。**封顶让缺失设备只造成有界抖动**，而不是耗在串口驱动默认值上 |
| `REBOOT_SETTLE` | 500 ms | 太早 ping 会把**还在启动**的舵机读成"flash 失败"，白白判死一次成功的领养 |
| `EEPROM_SETTLE` | 20 ms | 舵机在单元格**真正提交前**就确认了。写只发生在换电机时，等待零成本，而这消除了数据手册留下的唯一竞态 |

### 7.7 `set_gain` 为什么把 I 和 D 写成零

写的是 kP，而且 **I=0、D=0**：

> 这些是 **RAM 寄存器**，每次上电会恢复出厂值，**而工厂的 D 不是零**。
> 留着它会**阻尼舵机内部的 PID**，于是**同样的 kP 下机器人跑起来明显更软**。
> **这不是谁做出的调参选择**，所以它被钉死，而不是做成一个旋钮。

### 7.8 `set_torque` 的一个细节

固有方法每次**写全部舵机，即便前面失败了**：

> 连续 14 个被确认的事务里**一个丢包**曾让循环当场终止，
> 而对 `on = false` 的关机路径来说，那意味着**机器人坐下了、半条腿还锁着** ——
> 因为"看到错误的那一 tick 是最后一次能重试的机会"。
>
> 写齐其余的代价与原本相同，而错误会列出**所有**没应答的关节。

---

## 8. 12 字节的 IMU：`imu.rs`

`imu_to_dxl` v2 板上是 **LSM6DSV16X**。它的 12 字节块长这样：

```text
   字节 0..6    陀螺仪 x/y/z，i16 小端，±500 dps
   字节 6..12   SFLP 四元数 x/y/z，**IEEE 半精度**
                （w = √(1 − x² − y² − z²)，所以不需要传）
```

> 板子的完整诊断块是 20 字节（还有原始加速度计、采样计数器和状态标志）。
> **控制循环只消费前 12 个**，这样这次读能和舵机放进同一个事务。

### 8.1 三件"就地解决"的事

**一、SFLP 就是芯片自己算的融合。** 没有主机上的融合要跑 —— 芯片的 SFLP 块直接给出游戏旋转四元数，而且**自己估计陀螺仪零偏**。

**二、安装朝向是一个常量。**

```rust
pub const DEFAULT_MOUNT: [f64; 4] = [FRAC_1_SQRT_2, 0.0, FRAC_1_SQRT_2, 0.0];
```

板子是按 `trunk = [+raw_z, +raw_y, −raw_x]` 装的，也就是**绕 Y 轴 +90°**。

**三、半精度是手写的。** `half()` 是因为 LSM6DSV16X 就用这个格式发四元数分量。有测试钉住零、一、负数、次正规数 ——

> **这里指数偏置写错，会静默地把地平线弄歪。**

### 8.2 那个"不能撒谎"的地方

```rust
// 全零的四元数字节 = SFLP 还没写它的表 —— 板子刚上电，或它的初始化失败了。
// **保持上一个好值。**
```

> **快照到单位四元数**（也就是"完美直立"）会告诉摔倒检测**机器人没事**，
> 而它的朝向其实是**未知的** —— 这是能撒的最糟的一个谎。

对应的测试叫 `all_zero_quaternion_bytes_hold_the_last_good_value`。

### 8.3 `ready()`：0.25 秒的门

```rust
pub fn ready(&self) -> bool { self.quat_samples >= 25 }
```

**大约 100 Hz 下 0.25 秒。** 在这之前，朝向是一个**默认值，不是测量值**。

> 这块门控的是**摔倒检测**。如果它在第一个块就为 true，
> 机器人会在头四分之一秒里**被一个默认朝向评判**。

### 8.4 中值滤波，和一个**保留下来**的"缺陷"

```rust
fn median3_each(history: &[[f64; 3]; 2], now: [f64; 3]) -> [f64; 3]
```

**三点中值**：一个丢失或损坏的块表现为**一个野值**，三点中值能丢掉它**而没有平均的滞后**。

但注释里有一个诚实的说明：

> **先归一化，再做中值**，与原型一致。注意后果：**三个单位向量的逐分量中值本身不是单位向量**，
> 所以在瞬态期间策略看到的是一个**略短的**向量。稳态是精确的。
>
> ……**不过那是对一条目前能走路的路径做行为改动。**

有一个测试把这个边界**钉下来而不是假定**（`gravity_stays_close_to_unit_through_a_transient`）：断言瞬态下模长 > 0.5。

> 测试注释："如果这个值离 1.0 太远，就是策略被喂了训练从没见过的东西。"

---

## 9. 61 个浮点：`obs.rs`

**这是整个 crate 里风险最高的代码。** 模块头第一句：

> 它是一个 61 个浮点的扁平数组，**每一个索引都必须和策略训练时一致**。
> **一个错的偏移不会响亮地失败** —— 它会产出一个**看起来合理地摔倒**的机器人，
> 而症状看起来像整定或时序问题，而不是索引问题。

### 9.1 完整的布局

```text
   索引     宽度   内容
   ──────────────────────────────────────────────────
   0..3       3   陀螺仪，trunk 系，rad/s
   3..6       3   投影重力，trunk 系，单位向量
   6..20     14   关节位置 **减去 home 姿态**，跳过嘴
   20..34    14   关节速度，跳过嘴
   34..48    14   **上次动作**，跳过嘴
   48..61    13   指令块（见下）
```

### 9.2 指令块的 13 个

```text
   48..51     3   vx, vy, vyaw
   51..55     4   neck_pitch, head_pitch, head_yaw, head_roll
   55..57     2   body x, y      ← **永远是零**
   57         1   body z
   58         1   body roll
   59         1   body pitch
   60         1   body yaw       ← **永远是零**
```

三个"看起来像 bug、其实不是"的地方，都**对着原型的 `control_step` 核对过**而不是猜的：

**一、body 的 x / y / yaw 是硬编码零。**

> 它们在训练环境里**是未绑定的**，所以**全零的 body 指令是"名义"编码，不是一个等着被填的占位符**。
> 填别的值就是喂它训练时从没见过的信号。

**二、头部目标**乘在指令里**，不叠加到策略输出上。**

> 原型在不同模式下**两件事都做**，并用 `if !new_cmd_obs` 门控那个事后叠加，
> 注释写着 *"head_offsets are a COMMAND fed via the obs vector instead — don't double-add it here"*。
> **两件事都做会把头弯两次。**

**三、body 块内部是 `z, roll, pitch`，不是 `z, pitch, roll`。**

> 后两个调换，会让机器人**被要求前倾时向侧面倒**。

### 9.3 `twist_magnitude()`：只有速度算数

```rust
pub fn twist_magnitude(&self) -> f64  // 只取 twist 的 L2 范数
```

**头和身体的运动不能让机器人以为它在走路** —— 有一个测试专门钉这件事。

### 9.4 `scatter_action`：14 → 15

```rust
// slot < MOUTH_INDEX(9) → 直通；否则 +1
fn joint_of(slot: usize) -> usize
```

**关键是它是 `policy_joints` 的镜像 —— 同一个映射函数双向使用**，所以读和写**不可能不一致**。

> 错了会让索引 9 之后的**每一个关节偏一位**，"灾难性且完全静默"。
> 嘴的那个槽保持调用者的原值（它不是任何策略的一部分）。

### 9.5 一个编译期断言

`OBS_LEN` 和 `ACTION_LEN` 在 `duck_ipc_proto` 里**也有一份**（因为策略清单要声明它们，而 `updaterd` 会**在下载 800 KB 之前**用它拒绝不匹配的策略）。注释说：

> 一个决定机器人走不走路的东西有两份副本，**正是这个仓库一直在写测试防的那类漂移** —— 所以这里有一个测试。

### 9.6 关于 golden vectors

原始设计想要**逐步的 golden 向量**（从训练环境导出的 61 浮点数组）。`obs.rs` 里**没有**逐字的 golden 向量，只有分块的固定值测试（块边界、body 零轴、顺序、相对 home、跳过嘴……）。

事实上的 golden vector 在别处：

```rust
// tests/recurrent_policy.rs
fn obs() -> Observation { Observation::from([0.2; 61]) }

#[test] fn feedforward_outputs_are_unchanged_by_selection_and_reset() {
    for net in [Net::Walk, Net::Stand, Net::Skill(999), Net::Walk] {
        assert_eq!(p.infer(&obs(), net).unwrap(), [0.2; 14]);
    }
}
```

**输入 61 个 0.2 → 输出 14 个 0.2**（那个 fixture 网络就是 `Gather` 前 14 个）。
这个测试标了 `#[ignore]`，需要 ONNX Runtime ≥ 1.23。

---

## 10. 神经网络：`policy.rs`

### 10.1 `Net`：五张网络，一个布局

```rust
pub enum Net { Walk, Stand, SitStand, GroundPick, Skill(usize) }
```

| 网络 | 怎么被选中 | 指令块里带着什么 |
|---|---|---|
| `Walk` | 速度幅值 > 阈值 | 正常的 twist |
| `Stand` | 速度幅值 ≤ 阈值（`DEFAULT_STANDING_THRESHOLD = 0.05`） | 正常的 twist（≈全零） |
| `SitStand` | `robotd` 的调度器显式选 | vx 槽 = **姿态标志**（1 = 坐，0 = 站） |
| `GroundPick` | 显式请求 | twist 槽 = `[cos φ, sin φ, 0]`（相位编码） |
| `Skill(i)` | 显式请求，按配置顺序 | 由那条配置决定 |

**所有网络共用同一个 61 维布局**，所以"技能" = **选一个 session + 编码指令块**。

> `Skill(usize)` 是索引而不是变体，理由是：踢腿和翻滚**曾经是变体**，但它们是**同一件事的三遍**
> （全零指令训练、固定窗口驱动、显式请求选择），**差别只是时长和整定 —— 那是数据**。
> 用索引意味着**机器人靠加一条配置获得一个技能，而不是靠发一次版本**。

### 10.2 ⭐ 一切在 **load** 时校验，不在推理时

模块头的原话：

> **错误宽度 / 动作数 / 缺失的 ONNX Runtime 必须在机器人静止、调用者能被告知原因时失败**，
> 而不是六十个 tick 之后、迈步中途。

校验在 `open()` 里，检查：

```text
   ✓ 输入名叫 "obs"，**恰好 rank 2**
   ✓ shape[0] 是 1 或 −1（动态批），shape[1] == 61
   ✓ 类型必须是 float32
   ✓ 按 (输入数, 输出数) 判契约：
        (1, 1) → 前馈（API 1）
        (3, 3) → 循环（API 2，obs/h_in/c_in → actions/h_out/c_out）
        其它   → 报 "input/output contract" 错
   ✓ 动作出口宽度 == 14
   ✓ LSTM 状态：四张张量各查 3 维、层数与隐藏宽为正、
                 batch 为 1 或 −1、四个形状必须一致
   ✓ 状态元素数上限 1 048 576
```

**为什么合成一个 warm-up 推理？** 因为 warm-up **本来就必须在 load 时做**：

> 首次推理**总是离群值**（懒初始化、冷页、首次触碰缺页）。
> 在 tick 1 付这个代价，**看起来和"控制循环错过截止时间"一模一样**。
>
> 而且它同时**证明 ONNX Runtime 真的可用** —— 在 `load-dynamic` 下，只有跑起来才知道。

### 10.3 ⭐ `ensure_runtime()`：为什么要先探测

`ort` **在 dylib 缺失时不返回错误** —— 它在 `setup_api` 里 `expect`，从一个**任何 API 调用都可达的懒路径**触发，于是**缺失的库会 abort 触碰它的线程**。

> 在控制循环里，那意味着**线程死亡、永远没有 tick 落地**，
> 而 `robot.health` 永远回答"循环尚未完成一个周期" ——
> **守护进程看起来卡死了，而不是在说"ONNX Runtime 没装"。**

做法：用 `libloading`（`ort` 内部用的同一个 loader）**先探测** dylib 能不能加载。

> ⚠️ 但注释诚实地说了它**只证文件能加载，不证 ort 不会 panic**：
> 一块 Radxa 用 ONNX Runtime **1.20.1** 证伪了早先版本的说法 ——
> 库加载成功、探测通过，而 ort 在**版本检查**里 panic 了
> （`expected version >= '1.23.x', but got '1.20.1'`）。

### 10.4 `catching_ort_panics` 和一个**脆弱的不变式**

```rust
std::panic::catch_unwind(std::panic::AssertUnwindSafe(work))
```

它**只包 ort 的工作，不包整个 `Policy::load`** —— 免得我们自己的真 bug 被重新标成"策略不可用"。

而这里有一条**写在注释里的警告**：

> **`panic = "abort"` 会毁掉这一切。**
> 根 `Cargo.toml` **没有** `[profile.release]`，所以默认的 unwind 策略生效；
> **加一个会静默地把这里变回一个死掉的控制线程。**

（我核实过：根 `Cargo.toml` 确实没有 `[profile.release]`，只有一句注释说 binary size 不值得优化。）

### 10.5 `PolicyError`：为什么路径是**可选**的

```rust
pub enum PolicyError {
    Read { path, source },       // ← 有 path
    Load { path, source },       // ← 有 path
    Shape { path, what, expected, got },  // ← 有 path
    Inference(String),
    RuntimeMissing { searched, detail },  // ← **没有 path**
    RuntimePanic { detail },              // ← **没有 path**
}
```

> `path()` 只对 `Read`/`Load`/`Shape` 返回文件名 ——
> **缺 runtime 或 ort panic 不归咎任何策略文件**，
> 否则会把运维送去替换一个**没问题的**文件。

### 10.6 循环网络与"episode memory"

```rust
struct Network { session, state: Option<LstmState>, action_name, path, digest: [u8; 32] }
```

**状态缓冲在 load 时分配、属于单个 session、从不跨槽共享。**

**什么时候重置？** 三种情况，都有理由：

| 情况 | 为什么 |
|---|---|
| `infer` 时发现**选中的网络变了** | 网络在"切走再切回"时**重新开始** |
| **推理失败** | "绝不把失败推理的状态带进另一个控制 tick" |
| 显式 `reset()` | 禁用后恢复、或者 fall recovery 之后开新 episode |

**未加载的可选网络回退到 `Walk`，而且是在比较之前解析的** ——
这样"请求一个缺失的技能"**不会每 tick 重置 walking 网络**。

**`carry_over()`：热重载时怎么保留状态？** 比较的是**模型字节的 digest，而不是路径**：

> 两种情况必须重新开始：**原地替换了文件**、以及 seated swap **有意换掉了活动网络**。
> digest 相同才拷 h/c。

有一个测试专门钉住它（`changed_weights_at_the_same_path_start_with_fresh_memory`）。

### 10.7 两个常量

| 常量 | 值 | 为什么 |
|---|---|---|
| `DEFAULT_STANDING_THRESHOLD` | 0.05 | 原型的值 |
| `INTRA_THREADS` | **1** | 原型用 2。在四核 A55 上，**控制线程会阻塞在一个它不拥有的池上**，而这么小的网络同步开销超过并行收益。注释说值得在板上重测 |

### 10.8 `validate()`：一个**证明得更少**的检查

```rust
pub fn validate(path: &Path) -> Result<(), PolicyError>
```

它**只开图查两个形状就丢弃 session，不做 warm-up**。

> 它是关于**文件**的问题，不是关于"即将运行的 session"的问题 —— 所以它证明得更少：
> **图能开、形状对，仍然可能跑不起来。**

两个调用者：`robot.loadPolicy`（同步答复客户端，把"已接受"变成立即的 `observation width is 51, expected 61`），以及启动时的槽位覆盖检查。

⚠️ **它不可从 tick 内调用**：开一个 session 要几十毫秒，而循环只有 20 ms。

---

## 11. 唯一能写总线的地方：`safety.rs`

### 11.1 两条无条件规则

```rust
pub fn apply(&mut self, targets, hold, gain) -> Result<Applied>
```

**规则一：非有限值 —— 拒绝，不是夹取。**

> 夹一个 NaN 会得到一个**"看着合理"的关节角**，机器人会**猛地冲到限位**而不是站住。

**规则二：逐关节夹到 `±π`。**

```rust
pub const ACTUATOR_MIN: f64 = -PI;
pub const ACTUATOR_MAX: f64 =  PI;
```

> 注释照实说：这是**执行器的行程**（XL330 一圈），**不是关节的解剖学限位**。
> 它能拦住 `NaN`、荒谬的缩放系数和垃圾张量；
> **它拦不住"把一个关节驱到一个机械上不明智的位置"。**
> 真正的限位在 alpha 的 MJCF 里，**而那个模型不在此仓库**。

### 11.2 死区开关（deadman）

```rust
pub enum Limit { Deadman, Range, NotFinite }
```

```text
   intent_age ≤ deadman(默认 500 ms)?
     ├─ 是 → 指令清零，armed = true
     └─ 否 → **twist 置 0，但 head 保留**，返回 Limit::Deadman
```

> **头为什么保留？** 因为**陈旧的速度会走进墙里，陈旧的头姿无害**。

**没有配置开关能关掉 deadman。** `deadman_armed` 只用来**压日志**：

> 一台从未被驱动过的机器人（台架、技能测试、`robotctl`）**每 tick 都会判 stale** ——
> 不压的话就是**每天八万行**。

### 11.3 摔倒判定：一个**报告**，不是规则

```rust
pub fn observe(&mut self, sensors: &Sensors, period: Duration)
pub fn fallen(&self) -> bool
```

```text
   down = gravity[2] > fall_gravity_z(−0.5)
        （直立 ≈ −1，侧躺 ≈ 0）

   双向防抖 200 ms：累计；**任何一个清醒的样本都清零**
```

**两件承重的事：**

**一、未收敛的 IMU 不投票。**

> 否则**启动 200 ms 就会 latch `fallen`** → `robotd` 写 `gain_limp` → `padd` 被拒 →
> **几秒后自清，但增益留在 50**。
>
> 有一个回归测试叫 `an_unconverged_imu_cannot_declare_a_fall`，
> 注释说是"板上代价一个下午的回归"。**它有一对**：
> `a_converged_imu_still_detects_a_fall` —— 防的是"守卫变成关掉整个检测"。

**二、它什么都不门控。**

> `fallen` **不抢占任何东西**。"摔倒之后做什么"在上层，
> 而 `robotd` 的 limp-fall 用 `FallPredictor`，**而且必须走同一个 `apply` —— 没有后门**。
>
> 有一个测试就叫 `a_fall_does_not_preempt_the_caller`。

### 11.4 增益只在**变化时**才写

```rust
fn set_gain(&mut self, kp: u16) -> Result<()>  // 内部有 gain: Option<u16> 缓存
```

**为什么必须缓存？** 一次 `set_gain` 是 **15 个舵机 × 3 个寄存器**（P，且 I=D=0）。
不缓存就是**每秒 750 次额外的总线写**。

有一个测试叫 `the_gain_is_only_written_when_it_changes`：三次 `apply` 只应该有**一次**增益写。

### 11.5 ⚠️ 两个"不在这里"的常见误解

**一、`gain_limp` / `gain_running` 的切换不在这个文件里。**

`safety` 只是**把调用者给的 kp 写下去**。`gain_limp` 只是躺在 `SafetyConfig` 里的一个数 ——
**真正的切换在 `robotd` 的 `LimpFall` 状态机里**，而且它走的是**同一个 `apply`**。

**二、电压适应不在这里。**

`bus.rs` 里电压只是**只读遥测**。动作的电压缩放（`scale_mult`）在 **`robotd` 的控制循环**里。

### 11.6 `reboot_motors` 和增益缓存

```rust
pub fn reboot_motors(&mut self, ids: &[u8]) -> Result<()>
```

逐个 reboot 之后把 `self.gain = None` ——

> 这样下次 `apply` 会**重写增益**：重启的舵机回到 EEPROM 的增益值。

### 11.7 日志限流

`LIMIT_LOG_EVERY = 50`（50 Hz 下即**每秒一行**），配**三个独立的 run 计数器**。

> 一个关节被夹和一个关节被夹九次是**不同的故障**。

---

## 12. 预测摔倒：`fall.rs`

**为什么需要第二个检测器？** 因为 `safety` 那个判决**太晚了**：

> 它 latch 的时候，机器人**已经在地上了**。而 limp 的全部价值在**落地之前**那个窗口里。

```text
   FallPredictorConfig {
       tilt_z:     −0.90,     // 约 26°
       predicted_z: −0.5,
       lookahead:  300 ms,
       debounce:   60 ms,     // 50 Hz 下三个 tick
   }
```

### 12.1 那个漂亮的数学

```text
   投影重力随躯干旋转，所以        ġ = −ω × g      **是精确的**
   而我们只用 z 分量：             ġz = −(ωx·gy − ωy·gx)

   外推：                          predicted = gravity[2] + ġz · lookahead
```

**ω 就在同一个 12 字节的 IMU 块里** —— 直接测量，不需要微分四元数。

> 而微分四元数会把**滤波器自身的滞后**加进那个**唯一价值就是"早"**的数里。

### 12.2 三个条件，全满足才触发

```text
   ① gravity[2] > tilt_z(−0.90)      **已经倾斜**
        ← 这一条挡住了直立机器人的脚掌冲击、推搡、以及被人拿起来

   ② rate > 0                        **仍在倒**，不是正从倾斜中恢复

   ③ predicted > predicted_z(−0.5)   **外推结果超过阈值**

   任一失败 → 清零 + fired = false（重新武装）
   三条都满足 + 防抖满 + 未 fired → true（**边沿一次，不刷流**）
```

### 12.3 调参就是全部

> **默认值刻意偏晚，而这是不对称的**：
> **一个假阳性是机器人"自己造成的"摔倒 —— 比它想避免的僵硬落地更糟。**

### 12.4 两个测试值得看

- `the_rate_is_the_analytic_derivative` —— 精度 **1e-12**。因为**阈值之上的一切都建立在导数正确上**。
- `a_footfall_on_an_upright_robot_never_fires` —— 钉住那条 tilt 闸门确实挡掉了每步约 8° / 3 rad/s 的误报。
- `a_slow_lean_waits` —— **"早了就是在制造摔倒"**。

---

## 13. 机器人作为数据：`model.rs`

### 13.1 只有一台机器人

> **只有一个变体 —— alpha** —— 因为**那是唯一存在的机器人**。
> 所有发布的策略都是 `alpha_*`；v1/v1.5/v1.6 是历史。
> **第二个版本会变成第二组表** —— 这在有第二台机器人可供泛化之前是诚实的做法。

### 13.2 三张按同一整数索引的表

```rust
JOINT_IDS        [u8; 15]    // 20..24, 30..34, 10..14
JOINT_NAMES      [&str; 15]  // **来自 duck-ipc-proto**
DEFAULT_POSITION [f64; 15]   // home 姿态
```

**`JOINT_NAMES` 为什么从协议 crate 来？** 因为**线上是把 `joints` 和 `targets` 按位置传的**，
所以两份顺序**不能被允许漂移**。有一个 `const _: () = assert!(...)` 让"不能"成真。

**`DEFAULT_POSITION` 为什么必须精确？**

> 它**必须**和训练环境里的 `HOME_FRAME` 一致 ——
> 策略是**相对** home 姿态观测关节位置的，
> 所以这里的一个偏差，就是**观测的 14 个槽上的一个常数偏移**。

### 13.3 那些测试很有代表性

| 测试 | 钉住什么 |
|---|---|
| `tables_agree_on_length` | 三张表按同一整数索引，长度不一致会让每次查表**静默读到错的关节** |
| `ids_are_unique` | 重复的 ID 会让 `sync_read` 返回无法对应回关节的块 —— **看起来像接线故障** |
| `imu_id_does_not_collide_with_a_joint` | IMU 板共总线，ID 不能撞 |
| `factory_defaults_are_unused_on_the_bus` | 如果某个关节占了 ID 1，新舵机就和它**无法区分** |
| `home_pose_legs_are_mirrored` | 腿是镜像的。**一个符号笔误"靠看是看不出来的"**，而它会让机器人**歪着站** |

### 13.4 电池：没有电量计

```rust
BATTERY_FULL_V  = 8.2   // 充满，带载
BATTERY_EMPTY_V = 6.6   // 下垂地板
```

**唯一的测量是舵机报告的它们自己的供电电压。** 所以它是**带载下垂、静止恢复**的。注释说得很清楚：

> 这个区间是关于**电源轨**的陈述，而它成立是因为**那条轨就是电池包**：
> 舵机接的是 2S 电池，不是稳压的 5 V。
>
> 一个接在台式电源上的舵机读它自己的供电，和别的没什么两样 ——
> **5 V 落在 `BATTERY_EMPTY_V` 之下、映射到 0%，这是映射按定义工作，不是要去追的故障。**

**那个映射为什么住在这里？**

> 原型的 CLI 里有一份，**App 里又推导了一遍** —— 这就是两块屏幕对同一块电池显示两个数的由来。

### 13.5 嘴

```rust
MOUTH_CLOSED = −5°    MOUTH_OPEN = +30°
pub fn mouth_target(open: f64) -> f64   // 0..1 → 弧度，越界夹取
```

> 嘴**不是任何策略的一部分** —— 每个 alpha 网络都是 14 个动作、跳过这个关节 ——
> **所以这两个数和 `mouth_target()` 就是嘴控制的全部。**

---

## 14. 第三个后端：`sim.rs`

`RemoteIo` 让机器人住在 **MuJoCo** 里。

> **设计文档 §9 推迟的那个"MuJoCo 后端和 `RemoteIo` 协议"，就是它。**
> 这条 trait 之上的**一切** —— 控制循环、策略、`Safety`、摔倒检测、里程计、运动学、
> 每一个 IPC 调用、`robotctl` —— **原样运行，而且分辨不出来。**
> 这就是重点：**接缝是模拟器被允许存在的唯一地方。**

### 14.1 为什么是 TCP 而不是 unix socket

> 两个理由，都是**学来的而不是假定的**：
> unix 路径被 `SUN_LEN` 限制在约 108 字节，**一个临时目录立刻就用超了**。
> 而且模拟器必须能从守护进程所在环境**之外**够到 —— Linux 上是一个容器，
> macOS 上是一个 Linux VM。**端口能穿过所有这些，socket 路径不能。**

### 14.2 为什么用 JSON

> 一个 tick 是 15 个关节进、15 个出 —— 约 1 KB，50 Hz 下是 50 KB/s，
> 相对于"**能用 `nc` 读一帧、再用二十行 Python 写另一半**"来说什么都不算。
>
> 替代方案是"一个在两个仓库、两种语言之间共享的紧凑结构体" ——
> **而这正是这个项目已经因为一个偏移写错、失败还是静默的，损失过几天的那种东西。**

### 14.3 三个值得注意的细节

**⚠️ Nagle 会是灾难性的，而且是静默的。**

```rust
let _ = stream.set_nodelay(true);
```

> 它会**推迟一个小写入去等更多数据，最多约 40 ms —— 两倍于 tick** ——
> 把每一次事务变成一次错过的截止时间，**看起来像一个慢的模拟器**。

**模拟器消失时怎么办？** 它会**经常**消失（MuJoCo 要编译模型，改鸭子数量意味着重启它）。

> 所以一次死的连接是"返回给调用者的错误 + 下一次调用时重连" ——
> **没有退避线程，因为控制循环就是那个重试计时器。**

**每个写操作都要一个 ack。**

> 这样"模拟器拒绝了一个写"就**不会静默地**变成"写成功了"。
>
> 而 `reboot` 是**故意的空操作**：一个模拟舵机没有锁存的硬件错误要清、也没有固件要重启。
> 它不被放在线上 —— 否则模拟器只为了回一个 ack 而实现它。

---

## 15. 测试

**86 个测试**（含 8 个 `#[ignore]`），全部在笔记本上跑，**不需要机器人**。

| 文件 | 测试数 |
|---|---:|
| `safety.rs` | **20** |
| `model.rs` | 11 |
| `bus.rs` | 9 |
| `obs.rs` | 8 |
| `fall.rs` | 8 |
| `policy.rs` | 7 |
| `imu.rs` | 6 |
| `sim.rs` | 6 |
| `io.rs` | 3 |
| `tests/recurrent_policy.rs` | 8（全部 `#[ignore]`） |

### 15.1 `--ignored` 的那 8 个和 13 个夹具

```bash
cargo test -p duck-control --test recurrent_policy -- --ignored
```

需要 **ONNX Runtime ≥ 1.23**。`tests/fixtures/` 里有 **13 个手写的 `.onnx`**，还有一个 **`generate.py`**（79 行）用 Python + `onnx` 重新生成它们：

```python
"""Regenerate tiny contract fixtures: python with onnx + numpy installed.
The recurrent fixture uses the real ONNX LSTM operator, with deterministic weights.
No trained model or hardware is needed."""
```

其中 9 个是**故意坏的**：`bad_width`、`bad_batch`、`bad_state_shape`、`dynamic_hidden`、`missing_state`、`extra_input`、`wrong_type`、`bad_rank`、`bad_action_count`。

```rust
#[test] fn unsupported_contracts_fail_before_the_control_loop() {
    for name in ["bad_width", "bad_batch", ...] {
        assert!(validate(&fixture(name)).is_err(), "accepted {name}");
    }
}
```

**测试的名字本身就是规格说明。** 挑几个最能说明这个 crate 性格的：

```text
   ── safety.rs（"唯一能写总线的地方"）─────────────────
   an_unconverged_imu_cannot_declare_a_fall        ← 板上代价一个下午
   a_converged_imu_still_detects_a_fall            ← 防守卫变成关掉检测
   by_default_a_fall_reports_but_does_not_preempt
   a_fall_does_not_preempt_the_caller              ← 契约：只能"请求"，不能豁免
   a_non_finite_target_is_refused_not_clamped      ← "拒绝"和"夹取"是两回事
   out_of_range_targets_are_clamped_and_reported
   the_deadman_zeroes_the_twist_only               ← 头姿保留
   the_gain_is_only_written_when_it_changes
   the_three_limits_are_counted_separately         ← 一个关节 ≠ 九个关节
   a_robot_that_has_never_been_driven_reports_no_deadman
   a_refused_tick_does_not_end_a_range_run

   ── fall.rs ───────────────────────────────────────
   the_rate_is_the_analytic_derivative             ← 1e-12
   a_footfall_on_an_upright_robot_never_fires
   a_static_tilt_is_not_a_fall
   recovering_from_a_lean_never_fires
   a_slow_lean_waits                               ← 早了就是在制造摔倒
   it_rearms_when_the_fall_stops
   a_fall_fires_once_after_the_debounce

   ── model.rs ──────────────────────────────────────
   the_shutdown_mask_clears_the_input_voltage_bit  ← ★ 那一位的方向
   home_pose_legs_are_mirrored                     ← 符号笔误看不出来
   factory_defaults_are_unused_on_the_bus

   ── imu.rs ────────────────────────────────────────
   all_zero_quaternion_bytes_hold_the_last_good_value  ← 撒的最糟的谎
   not_ready_until_the_chip_has_produced_output
   gravity_stays_close_to_unit_through_a_transient

   ── obs.rs ────────────────────────────────────────
   the_layout_widths_sum_to_the_declared_input
   every_block_lands_at_its_documented_offset
   unbound_body_axes_are_always_zero
   the_body_block_is_z_roll_pitch
   joint_positions_are_relative_to_the_home_pose
   the_mouth_is_excluded_from_the_observation
   scattering_an_action_skips_the_mouth
   twist_magnitude_ignores_head_and_body

   ── bus.rs ────────────────────────────────────────
   read_block_is_long_enough_for_every_field
   position_conversion_round_trips_through_rustypot
   velocity_scale_matches_the_datasheet_figure
   a_replacement_is_inferred_only_from_exactly_one_missing_servo
   the_first_block_is_never_stale                       ← 那个 Option 的由来
   a_hiccup_is_remembered_in_the_total_but_not_the_run
   a_dead_board_runs_past_the_warning_threshold
```

### 15.2 `examples/policy-rehearsal.rs`

一个**离线**跑 `.onnx` 的基准工具（**从不打开电机总线**）：

```bash
cargo run --release -p duck-control --example policy-rehearsal -- policy.onnx [trace.json]
```

它输出 `p50 / p95 / p99 / max` 延迟，以及 **`over_20_ms`** —— **超过一个 tick 预算的步数**。

---

## 16. 阅读路线

**第 1 步 —— 建立直觉（30 分钟）**

1. 读 `lib.rs`（**27 行**）。
2. 读 `docs/design/robotd-design.md` §2（The control path）—— 这是这个 crate 的设计文档。
3. 读 `model.rs` 全文（276 行）—— 机器人作为数据，读完就有坐标系和关节的概念了。

**第 2 步 —— 接缝（1 小时）**

4. 读 `io.rs` 的 `RobotIo` trait（`:113`）和 `Sensors`/`SlowSensors`/`ImuStale`。
5. 读 `io.rs` 的 `FakeIo`（`:174`）—— 理解测试是怎么不用硬件的。

**第 3 步 —— 数据（1.5 小时）**

6. 读 `obs.rs` 的模块头（前 45 行）—— **那张表要背下来**。
7. 读 `obs.rs` 的 `Observation::build()`（`:174`）和 `scatter_action()`（`:237`）。
8. 读 `imu.rs` 的模块头 + `SflpDecoder::decode()`（`:103`）。

**第 4 步 —— 神经网络的边界（1 小时）**

9. 读 `policy.rs` 的模块头 + `Net`（`:205`）+ `PolicyPaths`（`:224`）。
10. 读 `ensure_runtime()`（`:127`）和 `catching_ort_panics()`（`:177`）—— 第 10.3 / 10.4 节。
11. 读 `infer()`（`:336`）—— episode memory 的规则。

**第 5 步 —— 安全（1 小时）**

12. 读 `safety.rs` 的 `apply()`（`:353`）**逐行读** —— 这是全 crate 最重要的一段。
13. 读 `gate()`（`:309`）和 `observe()`（`:244`）。
14. 读 `fall.rs` 全文（272 行）。

**第 6 步 —— 硬件（1.5 小时）**

15. 读 `bus.rs` 的 `read()`（`:461`）和 `slow_sensors()`（`:564`）。
16. 读 `check_registers()`（`:152`）和 `model.rs` 的 `EXPECTED_REGISTERS`。
17. 读 `adopt_replacement()`（`:234`）—— 换舵机的完整流程。
18. 读 `sim.rs` 的模块头。

**第 7 步 —— 动手**

```bash
cargo test -p duck-control                    # 78 个，不需要硬件

# 需要 ONNX Runtime ≥ 1.23
cargo test -p duck-control --test recurrent_policy -- --ignored

# 离线跑一个网络，量它的延迟
cargo run --release -p duck-control --example policy-rehearsal -- \
  duck-control/tests/fixtures/feedforward.onnx
```

试试自己构造一个观测：

```rust
use duck_control::obs::{Observation, Command};

let obs = Observation::zeroed();
assert_eq!(obs.as_slice().len(), 61);       // 61 个浮点

// scatter_action：14 个动作 → 15 个关节，跳过索引 9（嘴）
let mut targets = [0.0; 15];
Observation::scatter_action(&[1.0; 14]);    // 看看索引 9 是不是没被碰
```

---

## 17. 术语表

| 术语 | 意思 |
|---|---|
| **crate** | Rust 的一个编译单元（一个库或一个可执行程序） |
| **trait** | Rust 的"接口"。`RobotIo` 就是"一个能读能写机器人的东西" |
| **接缝 / seam** | 一个刻意留出的替换点。`RobotIo` 让真机器人、假件、模拟器可以互换 |
| **借用检查器** | Rust 编译期检查"谁拥有什么"的机制。它在这里强制"只有 safety 能写总线" |
| **tick** | 控制循环的一拍。50 Hz 就是一拍 20 ms |
| **Dynamixel** | 舵机品牌。这里是 XL330 系列 |
| **sync_read / sync_write** | 一次事务读/写**多个**舵机 —— 总线很贵，所以要一网打尽 |
| **fast sync read** | 协议 2.0 的指令 `0x8A`：所有设备追加进**一个**广播包 |
| **EEPROM vs RAM 寄存器** | EEPROM 断电保留，RAM 断电恢复出厂值。**增益是 RAM** |
| **`return_delay_time`** | 舵机答完之后的"转身时间"。出厂 250，这里钉成 0 |
| **`shutdown` 掩码** | "哪些故障应该关掉力矩"的位掩码。**那一位的方向很反直觉** |
| **torque（扭矩）** | 舵机"用力保持位置"的状态。关掉 = 变软 = 机器人会瘫下去 |
| **gain / kP** | 位置环增益。越大越硬。这里写 kP 时把 I 和 D 钉成 0 |
| **IMU** | 惯性测量单元。这里是一块挂在电机总线上的板子 |
| **SFLP** | 芯片内部的传感器融合块，直接输出四元数 |
| **四元数 / quaternion** | 表示旋转的四个数。这里是"标量在前" `[w,x,y,z]` |
| **投影重力 / projected gravity** | "重力在这台机器人的坐标系里指向哪"。直立约 `[0,0,−1]` |
| **半精度 / half precision** | 16 位浮点。IMU 用它发四元数分量 |
| **中值滤波 / median filter** | 取三个里的中间值 —— 能丢掉一个野值而没有平均的滞后 |
| **观测 / observation** | 喂给神经网络的 61 个浮点 |
| **策略 / policy** | 一个 ONNX 神经网络文件：61 进 → 14 出 |
| **ONNX / ONNX Runtime** | 神经网络的交换格式 / 运行它的引擎。**它是板子的前置依赖** |
| **`load-dynamic`** | 运行时才去找 ONNX Runtime，而不是链接它 |
| **dylib** | 动态链接库（Linux 上是 `.so`）。ONNX Runtime 就是它 |
| **前馈 vs 循环网络** | 前馈只看当前输入；循环（LSTM）**带记忆**，所以有"重置"这回事 |
| **episode memory** | 循环网络内部的记忆状态。切网络、失败、显式重置都会清它 |
| **digest** | 文件内容的指纹（这里是 SHA-256）。用它比路径来判断"模型换了没有" |
| **warm-up 推理** | 先跑一次丢弃 —— 首次推理总是离群值（懒初始化、冷页） |
| **死区 / deadman** | "控制信号停了就自动归零"的安全机制 |
| **夹取 / clamp** | 把值压进一个区间。**注意它和"拒绝"是两回事** |
| **NaN** | "不是数字"。一个坏掉的浮点值 |
| **防抖 / debounce** | 一个信号必须持续够久才算数，防止抖动误触发 |
| **外推 / extrapolation** | 用变化率推算"再过一会儿会在哪" |
| **MuJoCo** | 一个物理仿真引擎 |
| **Nagle 算法** | TCP 的一个优化：小包先攒着再发。**在这里是灾难** |
| **golden vector** | 一组"固定输入 → 固定输出"，用来防止行为悄悄变化 |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| 控制路径的权威设计（英文） | [`design/robotd-design.md`](design/robotd-design.md) §2 |
| 谁调用这个 crate（姊妹篇） | [`robotd-primer.md`](robotd-primer.md) |
| 策略文件从哪里来、怎么换 | [`design/policy-channel-design.md`](design/policy-channel-design.md) |
| 策略清单（`manifest.json`）的契约 | [`policy-manifest.md`](policy-manifest.md) |
| 模拟的鸭子 | [`robot/simulation.md`](robot/simulation.md) · [`design/simulation.md`](design/simulation.md) |
| 配置文件的 schema（姊妹篇） | [`robotd-params-primer.md`](robotd-params-primer.md) |
| 蓝牙与配网（姊妹篇） | [`btd-primer.md`](btd-primer.md) · [`configd-primer.md`](configd-primer.md) |
| BLE 的线上契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| 摄像头里的鸭子检测（姊妹篇） | [`duck-detect-primer.md`](duck-detect-primer.md) |
| 仿真的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| 所有服务与客户端的公共契约（姊妹篇） | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| 笔记本上的客户端（姊妹篇） | [`duckctl-primer.md`](duckctl-primer.md) |
| 发布怎么把自己装到板子上（姊妹篇） | [`hooks-primer.md`](hooks-primer.md) |
| 板子被配置成什么样子（姊妹篇） | [`deploy-primer.md`](deploy-primer.md) |
| 关节角变成空间中的点：FK / IK / ToF（姊妹篇，**最该一起读**） | [`kinematics-primer.md`](kinematics-primer.md) |
| 摄像头、WebRTC、远程可达（姊妹篇） | [`mediad-primer.md`](mediad-primer.md) |
| 控制环里的位置估计（姊妹篇） | [`odometry-primer.md`](odometry-primer.md) |
| 手柄自己的 IMU：姿态、零偏、yaw 漂移（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| 死手开关的另一半：padd 闭嘴就停（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| 另一个 ONNX 消费者：策略网络（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| CLI 与监控（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| 装机、更新、诊断的那些工具（姊妹篇） | [`scripts-primer.md`](scripts-primer.md) |
| 鸭子的嗓子：可播种的合成器（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 头部的两个传感器：深度与 IMU（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
