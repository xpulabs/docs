# `duck-ether` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> 仿真的机制由 [`design/simulation.md`](design/simulation.md) 拥有（英文），
> 电台那部分尤其看 §4 和 §5。两者若有不一致，以设计文档为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：[`btd-primer.md`](btd-primer.md) —— 这个 crate 就是**把 `btd` 的电台换掉**。

## 目录

1. [一分钟版](#1-一分钟版)
2. [它在整个仿真里的位置](#2-它在整个仿真里的位置)
3. [核心心智模型：它不是电台，是 `btd` 的替身](#3-核心心智模型它不是电台是-btd-的替身)
4. [目录导览](#4-目录导览)
5. [一次信标的完整旅程](#5-一次信标的完整旅程)
6. [谁听得见谁：距离，不是信号强度](#6-谁听得见谁距离不是信号强度)
7. [⭐「故意做一个坏电台」](#7-故意做一个坏电台)
8. [两个容易搞错、而它搞对了的地方](#8-两个容易搞错而它搞对了的地方)
9. [怎么用它](#9-怎么用它)
10. [测试](#10-测试)
11. [阅读路线](#11-阅读路线)
12. [术语表](#12-术语表)

---

## 1. 一分钟版

`duck-ether` 是**给模拟鸭子用的电台**：**一只鸭子广播的东西，它附近的鸭子听得见。**

```bash
duck-ether --duck duck-a=/run/duck-a/robotd.sock@7801 \
           --duck duck-b=/run/duck-b/robotd.sock@7802
```

一句话说清它的定位：

> **它替换 `btd` 的电台，以及那之上的一切都不动。**

为什么能这么干净？因为**"在场"本来就是一个 IPC 契约**，住在 `robotd` 自己的 socket 上：

```text
   chorale.subscribe   ← 告诉我该往空中放什么
   chorale.beacon      ← 放什么
   chorale.heard       ← 听到了什么
```

而 **`btd` 是 `robotd` 的一个*客户端*，不是一个服务端**。所以这个程序**不冒充任何东西、不抢任何 socket 路径** —— 它每只鸭子开一条连接，**和 `btd` 做的事一模一样**，于是每只鸭子的选举、名册、节拍、和对指挥的服从**全都原样跑，分辨不出来**。

规模：**481 行，两个文件**（`Cargo.toml` + `main.rs`）。

---

## 2. 它在整个仿真里的位置

```text
   ┌─ 一台笔记本 ─────────────────────────────────────────────────────┐
   │                                                                  │
   │   MuJoCo（物理）                                                  │
   │      ▲ TCP 身体协议            ▲ TCP                    ▲ TCP     │
   │      │                         │                        │        │
   │   ┌──┴──────┐              ┌───┴─────┐              ┌───┴─────┐  │
   │   │ robotd  │              │ robotd  │              │ robotd  │  │
   │   │ duck-a  │              │ duck-b  │              │ duck-c  │  │
   │   └──┬──────┘              └───┬─────┘              └───┬─────┘  │
   │      │ unix socket             │                        │        │
   │      └──────────┬──────────────┴────────────────────────┘        │
   │                 ▼                                                │
   │           ┌────────────┐                                         │
   │           │ duck-ether │  ← 假电台                                │
   │           └────────────┘                                         │
   │                 │                                                │
   │                 └── 也去问每台模拟器："你的鸭子站在哪？"            │
   └──────────────────────────────────────────────────────────────────┘
```

**在真实的机器人上**，那三条线是蓝牙；**在仿真里**，它们全部经过 `duck-ether` 这一个进程。

**它不在真板上跑**，也不参与发布 —— 它是仿真工具链的一部分，由 `scripts/duck-sim boot` 在鸭子多于一只时启动。

> 操作者视角的说明在 [`robot/simulation.md`](robot/simulation.md)：
> 「鸭子多于一只时，脚本还会启动 `duck-ether`，一个在容器之间搬运合唱 BLE 信标的假电台。
> 它**故意是一个*坏*电台** —— 会丢、会延迟 —— 因为**一个完美的电台会掩盖真实电台会暴露的 bug**。」

---

## 3. 核心心智模型：它不是电台，是 `btd` 的替身

这是理解这个 crate 最关键的一句话，值得单独一节。

```text
   ┌──────────────────────────────────────────────────────────┐
   │  robotd  —— 完全不知道电台是什么                          │
   │    chorale.subscribe → "我想要往空中放这个"               │
   │    chorale.heard     ← "我听到了这个"                     │
   └───────────────────────┬──────────────────────────────────┘
                           │  unix socket（IPC 契约）
         ┌─────────────────┴─────────────────┐
         ▼                                   ▼
   ┌───────────┐                       ┌────────────┐
   │    btd    │  真机器人上            │ duck-ether │  仿真里
   │ 真蓝牙电台 │                       │  假电台     │
   └───────────┘                       └────────────┘
```

**两边做的是同一件事：扮演 `robotd` 眼里的"电台"。**

设计文档 §4 把好处列成了三条，而且**没有一条是"省事"**：

| | |
|---|---|
| **基于"年龄"的同步路径被真的走了一遍** | 而不是被短路掉（见第 8 节） |
| **从 ground truth 来的距离** | 让"范围切分"和"不对称链路"变成一个**旋钮**，而不是一个"要布置现场"的问题 |
| **`from` 被按时轮换** | 那个曾经让项目损失一天的地址轮换 bug，**变成了一个回归测试** |

> ⚠️ **"不需要改 `robotd`、不需要做协议工作"** —— 这不是巧合，是因为 `btd` 当初就被摆成了客户端。
> 详见 `btd-primer.md` §3"一条管道"。

---

## 4. 目录导览

```text
duck-ether/
├── Cargo.toml      15 行   依赖：只有 duck-ipc-proto + clap + tokio + serde_json
└── src/main.rs    466 行   全部逻辑
```

`main.rs` 内部，按顺序（左边是那一项开始的行号）：

| 行号 | 内容 |
|---:|---|
| 1–51 | 模块文档 —— **把"为什么"说完了，先读这个** |
| 63 / 69 | 两个常量：`RANGE`（8 米）和 `DELIVERY`（200 ms） |
| 73 | `Args` —— 六个命令行开关 |
| 101 / 110 | `Weather`（天气 = 电台的不完美程度）+ `noise()`（确定性噪声） |
| 121 / 127 | `Duck` 和它的解析（`name=socket@port`） |
| 145 | `OnAir` —— 一只鸭子此刻在空中的状态 |
| 160 | `main()` —— 每只鸭子一个 task |
| 234 | `address_for()` —— 造一个像样的 BLE 地址 |
| **248** | **`serve()` —— 与一只鸭子的全部对话** |
| **311** | **`nearby()` —— 谁听得见谁** |
| 375 / 389 | `positions()` / `ask_where()` —— 问模拟器鸭子站在哪 |
| 410 | `rotate()` —— 定期换地址 |
| 428 | 四个测试 |

---

## 5. 一次信标的完整旅程

```text
   ① 启动：每只鸭子一个 task
      · 连上它的 robotd socket
      · 发 chorale.subscribe     ← "把该广播的东西告诉我"
              │
              ▼
   ② robotd 回一条通知：chorale.beaconSet { beacon: Option, listening: bool }
      · beacon = 这只鸭子想广播的内容（它选好了曲子、算好了节拍）
      · listening = 它在不在听
              │
              ▼
   ③ duck-ether 记在 OnAir 里：
      · beacon / listening
      · since ← 它**第一次**开始广播的时刻（发现延迟从这里起算）
              │
              │   ┌──────────────────────────────────────────┐
              │   │  另一条并行的线：positions()              │
              │   │  每 250 ms 问一次每只鸭子的模拟器：       │
              │   │  TCP → {"op":"hello"} → {"op":"read"}     │
              │   │      → 读回答里的 "trunk" 字段           │
              │   └──────────────────────────────────────────┘
              ▼
   ④ 每 200 ms（DELIVERY）：
      nearby() 算出"我这只鸭子听得见谁"
        · 我在听吗？不在 → 谁都不听
        · 逐个看别人：有 beacon 吗？
        · 距离 = √(Δx² + Δy²)  ← **只有水平面**
        · 超过 range？跳过
        · 还没被"发现"？跳过（每个"对"各有各的延迟）
        · 这一拍丢了？跳过（按对和 tick 播种）
              │
              ▼
   ⑤ 每个听得见的，回一条通知给这只鸭子：
      chorale.heard { beacon, from: 对方的地址, age_us: 1000 }
              │
              ▼
   ⑥ robotd 拿到它，喂给合唱的相位锁
```

**注意第 ④ 步：距离是 `duck-ether` 自己算的**，因为它每 250 ms 去问了每只鸭子的模拟器。

**注意它是"推"而不是"广播"** —— 每只鸭子拿到的是**过滤过的、只属于它的**一份列表。

---

## 6. 谁听得见谁：距离，不是信号强度

这是最容易误解的一处，代码的模块文档专门解释了：

> **距离，因为 `ChoraleHeard` 里没有信号强度** ——
> 一个真实的扫描器**要么看见一条广播，要么看不见**，而**超出范围的信标根本不会到达**。
>
> 所以这个 ether 问每台模拟器它的鸭子站在哪，**只把信标投递给它 `RANGE` 以内的鸭子**。
> 那是一个**比真电台更粗糙、但可控得多**的电台：
> **一个数字形式的范围，让"这两只能互相听见、那两只不能"变成一秒就能摆好的事** ——
> 而在真硬件上，那意味着**把机器人搬到别的房间去**。

两个细节：

**一、距离只算水平面。**

```rust
let distance = ((other.at[0] - here[0]).powi(2) + (other.at[1] - here[1]).powi(2)).sqrt();
```

`z` 被忽略了 —— 对"同一层楼里的两只鸭子"来说这是对的。

**二、`RANGE` 默认 8 米，而且"故意给得宽"。**

> 一个真实的广播能穿过一个房间还有富余，
> **而有趣的故障是关于谁在范围*之外*** —— 那才是 `--range` 存在的意义。

### 6.1 ⚠️ 和设计文档的一处不一致

`design/simulation.md` §4 是这么写的：

> 一个进程为每只鸭子持有一条连接，收集每只想广播的内容，
> 并且**带着一个由它们身体之间距离推导出的 RSSI** 投递给其他鸭子。

**但 `ChoraleHeard` 里没有 RSSI。** 它的字段只有三个：

```rust
pub struct ChoraleHeard {
    pub beacon: ChoraleBeacon,
    pub from: String,     // 身份，只用于去重
    pub age_us: u64,      // 年龄，不是时间戳
}
```

我核实过：全仓库的 `rssi` 只出现在 `duckctl` 的测量工具和 `btd` 的 BlueZ 监视器参数里，
**协议里没有任何地方带信号强度**。

所以按**代码**的说法（`duck-ether` 的模块文档，写得很明确、也给了理由），真实行为是
**按距离做范围切分**，而不是**附上一个 RSSI 值**。设计文档那半句描述的是一个协议承载不了的东西。

> 两处都是 **2026-08-30** 同一天进来的（设计文档 `47f4003`，`duck-ether` `2581e62`），
> 所以 git 分不出先后。但**代码是考虑过这件事的**（它明说"没有信号强度"并解释了替代方案），
> 所以看起来是**那半句话没跟上**。
>
> 按 `CLAUDE.md`："当行为和一份设计文档不一致时，**文档才是 bug**。"

---

## 7. ⭐「故意做一个坏电台」

**这是整个 crate 存在的最深理由，也是最值得学的一节。**

模块文档开头就是：

> **一个完美的 ether 会掩盖真电台造成的 bug**，而这**不是假设**。
>
> **孪生里的四只鸭子每一次都会收敛到同一首曲子上** —— 错开启动也一样 ——
> **因为每只鸭子从它启动的那一刻起，就对其他每一只可见，瞬间而且无损。**
>
> 在真硬件上，BLE 发现是慢的、有损的，所以**两只鸭子可能在另外两只还没看见它们的时候就已经在唱了** ——
> **而那正是合唱的选举必须活下来的那个脑裂（split-brain）。**

### 7.1 三个旋钮

```text
   --discovery <秒>   一只鸭子要花多久才被"注意到"
   --loss <0.0-1.0>   丢掉这个比例的投递
   --seed <n>         上面两个的随机种子
```

**⭐ `--discovery` 是"每一对"的，不是全局的。** 注释说得很清楚：

> **每一对，而且从对方上空中那一刻起计时：**
> **正是那个*不对称*才把鸭群劈开的**，所以一个所有人共享的延迟**造不出那个场景** ——
> A 和 B 很快互相找到、而 C 和 D 还聋着，**那才是要复现的情形**。

代码里是这样落地的一对一键：

```rust
let pair = format!("{}<-{}", duck.name, name);       // "duck-a<-duck-b"
let wait = Duration::from_millis(noise(seed, &pair, 0) % discovery_ms);
```

### 7.2 ⭐ 为什么要 `--seed`

> **两者都由一个有种子 PRNG 驱动**，所以**一次发生过的劈裂可以被弄成再发生一次** ——
> **一个随机性不重复的坏电台，只有在调试时才有用。**

而 `noise()` 是**手写的一个 splitmix 步骤** —— 短、分布好、**不需要任何依赖**：

```rust
/// 确定性噪声 —— 一个 splitmix 步骤。
/// **确定性才是重点：一个每次运行都抖得不一样的电台，不能用来追 bug。**
fn noise(seed: u64, key: &str, salt: u64) -> u64
```

### 7.3 那个复现配方

设计文档 §5 记录了它复现出来的东西 —— **一个现场报告**：

> 四只鸭子，**`a` 和 `b` 比 `c` 和 `d` 早唱十二秒**：
>
> ```
> duck-ether --discovery 90 --loss 0.3 --seed 3
> ```
>
> | 鸭子 | 声部 | 小节 | 名册 |
> |---|---|---|---|
> | a | **没在唱** | — | 范围内 1 个 |
> | b | bass | 4 | 3 个声音 |
> | c | alto | 4 | 2 个声音 |
> | d | bass | 2 | 2 个声音 |
>
> **那就是现场报告** —— "有时候什么都不发生，有时候两首不同的歌" ——
> **而且还带着互相矛盾的名册和一个重复的声部。**

**而设计文档也诚实地说它还没证明什么：**

> 合入 `chorale-election` 之后，同样的场景**仍然会劈**（小节 5、12、8：三条时间线）。
> 但在 `--discovery 20 --loss 0.4` 下**两者都会收敛**，
> 所以九十秒的发现时间**比那个分支写的时候预想的更狠**，
> 而这**不是**"那个修复在真机器人上会失败"的证据。
> 值得跑的实验是一次**扫描** —— 每个版本停止收敛的那个发现值 ——
> **而现在那是一段对一个数字的循环，而不是四台机器人和一个房间。**

> 💡 这句话是整个 crate 的价值所在：
> **一个原本需要"四台机器人和一个房间"才能碰到的故障，变成了一个可以循环的数字。**

---

## 8. 两个容易搞错、而它搞对了的地方

模块文档专门列了这两条，而且**两条都是踩过坑的**：

### 8.1 `age_us` 是"年龄"，不是"时间戳"

```rust
age_us: 1_000,
```

原话：

> **`age_us` 是一个年龄，不是一个时间戳。** 这个字段存在，是因为**两个 daemon 共享一台机器而不共享 epoch**，
> 而 `robotd` 在收到时**把它从自己的时钟里减掉** ——
> 所以**填一个真实的流逝时间，才是让"基于节拍的同步"被真的走了一遍，而不是被短路掉**。

而代码注释还解释了**为什么不是 0**：

> **零会声称"这条广播在它被交出去的瞬间到达"** ——
> 而那**恰恰是一个真实扫描器永远不会产生的读数**。

### 8.2 地址会轮换

> **`from` 被文档规定为"只用于去重的身份"，而一只真鸭子的 BLE 地址会在它底下改变** ——
> **这个事实曾经让这个项目损失了一天**，当时有东西拿它当了键。
>
> **`--rotate` 让那件事按定时器发生，从而把那个 bug 变成一个测试。**

```rust
let generation = started.elapsed().as_secs() / seconds.max(1);
entry.address = address_for(index, generation);
```

而 `address_for()` 造出来的是**长得像真的**的地址（`E` 前缀，六组十六进制），
并且有一对测试钉住"**每只鸭子地址不同**"和"**每一代地址都换**"。

> 📌 注意到没有：**这两条和 `btd-primer.md` §11.3"机器人有两个名字"、§11.4"地址会变"是同一类知识**。
> 仿真器的价值之一，就是把这些"真硬件上才知道的事"变成可以随手开关的旋钮。

---

## 9. 怎么用它

### 9.1 命令行

```text
   --duck <NAME=SOCKET@PORT>   一只鸭子（可重复，必填）
                                SOCKET = 它的 robotd socket
                                PORT   = 它的**模拟器**身体端口
   --range <米>                信标能传多远（默认 8.0）
   --rotate <秒>               每隔多久换一次地址；0 = 不换
   --discovery <秒>            每只鸭子最多花多久才被"注意到"（每对）；0 = 完美电台
   --loss <0.0-1.0>            丢掉这个比例的投递
   --seed <n>                  discovery 和 loss 的种子
```

**解析 `name=socket@port` 是从右边切 `@` 的**，所以 socket 路径里可以有 `@` —— 有一个测试专门钉这件事（`a_socket_path_may_contain_an_at_sign`）。

### 9.2 正常情况下你不是直接调它

```bash
scripts/duck-sim boot 4        # 鸭子多于一只时，脚本会自动起 duck-ether
```

它**只在仿真里跑**，和发布无关。

### 9.3 想复现那个脑裂

```bash
duck-ether --discovery 90 --loss 0.3 --seed 3
```

再改 `--seed`，看劈裂是不是稳定复现。

### 9.4 它容错的方式

`serve()` 外面包着一层**每秒重试**：

```rust
loop {
    if let Err(e) = serve(&duck, &air, range, weather).await {
        tracing::warn!(duck = %duck.name, error = %e, "lost the duck; retrying");
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
}
```

> 一只鸭子重启、它的 socket 短暂消失，都不会让整个 ether 挂掉。

而**运行时是单线程的**（`#[tokio::main(flavor = "current_thread")]`）—— 它只搬运字节，
而且全部状态在一把 `Mutex<HashMap<String, OnAir>>` 里。

---

## 10. 测试

**4 个测试**，全部是纯函数：

```text
   a_duck_is_a_name_a_socket_and_a_body
   a_socket_path_may_contain_an_at_sign        ← 从右边切 @
   what_is_not_a_duck_says_so                  ← 三种错误输入
   every_duck_has_its_own_address_and_a_new_one_each_generation
```

**没有一个测试碰网络或 IPC。**

这看起来少，但要说清楚**这个 crate 的验证手段不是单元测试，而是它复现出来的那个故障** ——
它存在的全部意义是"让一个原本需要四台机器人和一个房间的故障可以被循环"。

> 设计文档 §5 的那张表（a 没在唱 / b bass bar 4 / c alto bar 4 / d bass bar 2）
> **就是这个 crate 的验收标准**，而且它是一份**现场报告的复现**，不是一个断言。

---

## 11. 阅读路线

**第 1 步（15 分钟）**

1. 读 `main.rs` 的模块文档（**前 20 行**）—— 它把"为什么"说完了。
2. 读 [`design/simulation.md`](design/simulation.md) §4（"Faking the radio costs nothing"）和 §5（"The radio has to be bad"）——
   这是这个 crate 的全部理由。

**第 2 步 —— 骨架（40 分钟）**

3. 读 `Args`（`:73`）—— 六个开关，每个都有理由。
4. 读 `OnAir`（`:145`）—— 一只鸭子此刻在空中的状态。
5. 读 `main()`（`:160`）—— 每只鸭子一个 task，加上 `positions` 和可选的 `rotate`。

**第 3 步 —— 核心（1 小时）**

6. 读 `serve()`（`:248`）—— 与一只鸭子的全部对话。**这是第 5 节那张时序图。**
7. 读 `nearby()`（`:311`）—— 谁听得见谁。**这是第 6、7 节。**
8. 读 `positions()` / `ask_where()`（`:375`）—— 它怎么知道鸭子站在哪。

**第 4 步 —— 动手**

```bash
cargo test -p duck-ether        # 4 个测试，不需要任何东西

cargo run -p duck-ether -- --help
```

**第 5 步 —— 想看真的，就跑仿真**

```bash
scripts/duck-sim boot 3         # 三只鸭子，脚本会自动起 duck-ether
```

然后按第 9.3 节的配方去复现脑裂。

---

## 12. 术语表

| 术语 | 意思 |
|---|---|
| **仿真 / simulation** | 机器人跑在 MuJoCo 里，而不是真硬件上 |
| **孪生 / twin** | "数字孪生" —— 那个仿真出来的机器人 |
| **MuJoCo** | 一个物理仿真引擎 |
| **ether** | "以太" —— 旧物理学里假想的那种传播无线电的介质。这里指"空气"本身 |
| **body / 身体** | 仿真里那只鸭子的物理实体（相对于 daemon 那套"软件"） |
| **身体协议 / body protocol** | `robotd` 和 MuJoCo 之间那条 TCP 上的行分隔 JSON |
| **`chorale.*`** | 合唱那三个 IPC 方法：`subscribe` / `beaconSet` / `heard` |
| **信标 / beacon** | 一只鸭子往空中放的一小段数据（曲子、节拍、声部、名册） |
| **名册 / roster** | 指挥维护的"谁唱哪个声部"的名单 |
| **脑裂 / split-brain** | 一个分布式系统分裂成两组、各自以为自己是全部 —— 这里是"两组鸭子唱不同的歌" |
| **收敛 / converge** | 所有鸭子最终唱到同一首、同一拍上 |
| **选举 / election** | 决定谁当指挥。这里的规则是"id 最小者"，是确定性的 |
| **RSSI** | 收到的信号强度。"我知道它多远"的粗略估计 |
| **ground truth** | "真值" —— 仿真里可以直接读到的准确位置，真硬件上读不到 |
| **`epoch`** | 时间的零点。**两个进程的 epoch 不同，所以时间戳不能直接用** |
| **`age_us`** | 消息有多旧（微秒）。**这是跨进程能用的那个表示** |
| **seeded PRNG** | 有固定种子的伪随机数发生器 —— **同样的种子产生同样的"随机"** |
| **splitmix** | 一种短小的哈希/PRNG 算法。这里手写了它的一个步骤，避免引入依赖 |
| **幂等 / 可复现** | 同样的输入给同样的输出。**调 bug 的前提** |
| **回归测试** | 一个专门用来防止某个已修好的 bug 复发的测试 |
| **`systemd-nspawn`** | systemd 的容器工具。`duck-sim boot` 用它跑真的 systemd 单元 |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| 仿真的权威设计（英文） | [`design/simulation.md`](design/simulation.md) §4 · §5 |
| 操作者视角：怎么跑仿真 | [`robot/simulation.md`](robot/simulation.md) |
| 它替换掉的那个电台（姊妹篇） | [`btd-primer.md`](btd-primer.md) |
| 合唱本身（在 `robotd` 里） | [`robotd-primer.md`](robotd-primer.md) §8 · [`robot/cheatsheet.md`](robot/cheatsheet.md) |
| 鸭子站在哪：`robotd` 怎么跟 MuJoCo 说话 | [`duck-control-primer.md`](duck-control-primer.md) §14 |
| 配置文件的 schema / 编辑器（姊妹篇） | [`robotd-params-primer.md`](robotd-params-primer.md) |
| wifi、身份、手柄配对（姊妹篇） | [`configd-primer.md`](configd-primer.md) |
| BLE 的线上契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| 摄像头里的鸭子检测（姊妹篇） | [`duck-detect-primer.md`](duck-detect-primer.md) |
| 所有服务与客户端的公共契约（姊妹篇） | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| 笔记本上的客户端（姊妹篇） | [`duckctl-primer.md`](duckctl-primer.md) |
| 发布怎么把自己装到板子上（姊妹篇） | [`hooks-primer.md`](hooks-primer.md) |
| 板子被配置成什么样子（姊妹篇） | [`deploy-primer.md`](deploy-primer.md) |
| 语音与合唱的音色 | [`design/robotd-design.md`](design/robotd-design.md) §4.5 |
| 鸭子的身体几何：正/逆运动学、ToF 重投影（姊妹篇） | [`kinematics-primer.md`](kinematics-primer.md) |
| 摄像头、WebRTC、远程可达（姊妹篇） | [`mediad-primer.md`](mediad-primer.md) |
| 机器人走到哪了：接触式里程计（姊妹篇） | [`odometry-primer.md`](odometry-primer.md) |
| 手柄自己的 IMU：姿态、零偏、yaw 漂移（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| 手柄：按键映射、模式、那个 raw tap（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| 摸头检测：麦克风、log-mel、那个门控（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| 机器人上的那个 CLI（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| 装机、更新、诊断的那些工具（姊妹篇） | [`scripts-primer.md`](scripts-primer.md) |
| 鸭子的嗓子：可播种的合成器（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 头部的两个传感器：深度与 IMU（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
