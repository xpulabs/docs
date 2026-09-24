# `robotd-params` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> 参数文件的机制由 [`design/robotd-design.md`](design/robotd-design.md) §4.2 拥有（英文）。本文只做一件事：
> 带你把这个 crate 读一遍，讲清楚"配置里的一个值，是怎么变成机器人身上的一个动作的"。
> 两者若有不一致，以设计文档为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：[`robotd-primer.md`](robotd-primer.md) —— 那个控制循环本身。

## 目录

1. [一分钟版](#1-一分钟版)
2. [为什么要有这个 crate](#2-为什么要有这个-crate)
3. [核心心智模型：三个问题](#3-核心心智模型三个问题)
4. [文件长什么样：13 个 section](#4-文件长什么样13-个-section)
5. [你实际会怎么改配置](#5-你实际会怎么改配置)
6. [最绕的概念：`resolved()`](#6-最绕的概念resolved)
7. [三个文件的分工](#7-三个文件的分工)
8. [每个键都要说明"怎么生效"](#8-每个键都要说明怎么生效)
9. [热重载：谁被监听，谁必须重启](#9-热重载谁被监听谁必须重启)
10. [写配置的安全性](#10-写配置的安全性)
11. [未知键与拼写错误](#11-未知键与拼写错误)
12. [`[update_gate]` 为什么叫这个名字](#12-update_gate-为什么叫这个名字)
13. [测试：四个最值得讲的](#13-测试四个最值得讲的)
14. [阅读路线](#14-阅读路线)
15. [术语表](#15-术语表)

---

## 1. 一分钟版

`robotd-params` 是**机器人配置文件 `/etc/robot/robotd.toml` 的"说明书 + 默认值 + 检查器 + 编辑器"**。

它自己不控制任何东西，它只回答一个问题：

> **"这个机器人的参数是什么？"**

```text
   /etc/robot/robotd.toml  ← 一个纯文本文件，你可以用记事本改
              │
              │  由 robotd-params 解析、检查、填默认值
              ▼
   ┌─────────────────────────────────────────────────┐
   │  robotd   ← 电机控制循环（读 bus/control/policy │
   │             /safety/audio/theremin/chorale/     │
   │             update_gate）                       │
   │  mediad   ← 摄像头与视频（只读 [media] 和        │
   │             [duck_detector]）                   │
   │  padd     ← 手柄（只读 [pad] 和                  │
   │             [pad_imu_head_control]）            │
   │  tofd     ← 深度传感器（只读 [head_imu]）        │
   └─────────────────────────────────────────────────┘
```

**关键事实：一个文件，四个程序读，各读各的段。** 这句话解释了后面一大半的设计 —— 包括"为什么改一个设置有时要重启 `mediad` 而不是 `robotd`"。

这个 crate 只有三个源文件：

| 文件 | 行数 | 干什么 |
|---|---:|---|
| `lib.rs` | 3349 | schema、默认值、校验 —— **值是什么** |
| `registry.rs` | 683 | 77 个键的机器可读索引 —— **有哪些键** |
| `edit.rs` | 1430 | 无损编辑 TOML —— **怎么写回去** |

---

## 2. 为什么要有这个 crate

`lib.rs` 开头的模块文档给了三条理由，都值得理解：

**一、用一个文件代替 142 个命令行参数。**

原型（`microduck_runtime`）是一个巨大的命令行程序：控制频率、增益、滤波系数、策略路径……全都是 flag。结果是启动命令长得没人能读，而且没有一个地方能回答"这台机器人到底配成什么样了"。

**二、启动时读一次，平时不监听。**

```text
   启动时：读文件 → 解析 → 校验 → 变成 Params → 交给各个 daemon
   之后：  不动了。改了文件？重启才生效（有两个例外，见第 9 节）
```

这是**故意的**。热重载一个正在跑的控制循环（比如改 `[safety]` 的摔倒阈值）是一个大得多的承诺，至今没有做。

**三、文件放在 `releases/<ver>/` 之外。**

机器人的软件是"整目录替换"式更新的：新版解压到 `/opt/robot/daemon/releases/<版本>/`，然后把 `current` 这个符号链接指过去。

所以配置放在 `/etc/robot/robotd.toml`，**在发布目录之外** —— 这样它既活过更新，也活过回滚。这正是为什么**安装脚本只写一次、之后永不覆盖**。

> ⚠️ 这条带来一个后果，是用血换来的教训（`deploy/robotd.toml` 里原话）：
> **一旦你把某个值取消注释，它就在这块板子上被永远冻结了**，而发布版本还在往前走。
> 这就是"整个机队的机器人站在 kP 120，而发布默认值写着 160"的由来。

**四、为什么是一个独立的 crate？**

因为 `robotctl configure` 需要**真正的 schema** 来编辑这个文件。如果 `robotctl` 自己抄一份字段列表，那份拷贝**必然**会漂移 —— 然后"编辑器里能改的键"和"daemon 认识的键"就成了两回事。

把类型放在一个共享 crate 里，编译器就能保证两边永远一致。

---

## 3. 核心心智模型：三个问题

看这个 crate 时，头脑里要一直挂着三个问题。整份代码就是在分别回答它们：

```text
   ① 值从哪来？          ② 谁赢？              ③ 什么时候生效？
   ─────────────         ─────────            ──────────────
   文件写了？            文件 > 内置默认        [pad]  → 1 秒内自动
   没写 → 默认值         槽位 > mode 预设       [policy] → 被要求时重载
   "none" → 关掉         显式 > 隐式           其余 → 重启对应 daemon
```

**问题 ①（值从哪来）** 由 `Params::load` 回答 —— 第 5 节和第 11 节。
**问题 ②（谁赢）** 由 `resolved()` 回答 —— 第 6 节。
**问题 ③（什么时候生效）** 由 `apply_for()` 回答 —— 第 8、9 节。

> 这三个问题不只是"读代码的钥匙"，它们也是**用配置的钥匙**。当有人问"我改了这个怎么没反应"，
> 答案永远是这三条之一。

---

## 4. 文件长什么样：13 个 section

`Params` 结构体（`lib.rs:65`）有 13 个字段，每个对应 TOML 里的一段：

| TOML 段 | Rust 类型 | 谁读 | 管什么 |
|---|---|---|---|
| `[bus]` | `Bus` | robotd | 串口设备、`fast_sync_read` 开关 |
| `[control]` | `Control` | robotd | 控制频率 `hz`、指令平滑 `cmd_alpha`/`head_alpha` |
| `[update_gate]` | `UpdateGate` | robotd | **决定 `healthy` 的三个阈值** —— 也就是回滚的依据 |
| `[policy]` | `PolicyParams` | robotd | 7 个策略槽的路径、增益、滤波、技能列表 |
| `[safety]` | `SafetyParams` | robotd | 摔倒判定、死区超时、电池空关机、limp-fall |
| `[audio]` | `AudioParams` | robotd | 嗓子（音效库、ALSA 设备）、宠物检测 |
| `[theremin]` | `ThereminParams` | robotd | ToF 特雷门琴 |
| `[chorale]` | `ChoraleParams` | robotd | 多鸭合唱（只有 `accept` 一个键） |
| `[media]` | `MediaParams` | **mediad** | 视频源、画质、码率、拥塞控制 |
| `[duck_detector]` | `DuckDetectorParams` | **mediad** | 找其他鸭子的检测器（旧名 `[detect]`） |
| `[head_imu]` | `HeadImuParams` | **tofd** | 头模块的 BMI088 IMU |
| `[pad]` | `PadParams` | **padd** | 手柄按键 → 技能 |
| `[pad_imu_head_control]` | `PadImuHeadControlParams` | **padd** | 手柄自己的 IMU 控制头部（旧名 `[imu_head]`） |

**注意"谁读"这一列。** 三个段不归 `robotd` 读 —— 这正是第 8、9 节要讲的那个坑的来源。

> `[pad_imu_head_control]` 这个名字起得特别长是有原因的。它曾经叫 `[imu_head]`，而上面两行有个 `[head_imu]`（机器人**头里面的** IMU）。两个名字只差一个词序，但说的是完全不同的两件事。代码注释里原话是：**"a name apart, not a difference"**。

### 默认值

每个 section 都有 `Default` 实现。几个值得记住的：

```rust
[control]      hz = 50              // 从原型继承，那时是树莓派 Zero 2W 上选的
               cmd_alpha = 0.2       // 摇杆猛推 → 变成步态跟得上的斜坡
[policy]       gain = 200           // 位置环 P 增益
               action_scale = 0.9   // 走路模式；roller 模式是 0.8
               head_lowpass = 0.5   // ⚠️ 这是策略训练时用的值，改不得
               legs_lowpass = 0.7   // ⚠️ 同上
               voltage_adapt = true // 按电池电压缩放动作
               nominal_voltage = 7.4
[update_gate]  min_achieved_hz = 45.0        // 默认 50 Hz 的 90%
               stall_periods = 25            // 500 ms，超了算"卡死"
               max_consecutive_errors = 10
```

> 💡 `head_lowpass = 0.5` 和 `legs_lowpass = 0.7` **不是调参口味，是训练参数**。alpha 系列策略是**带着这两个滤波系数训练出来的** —— 改了它们，就等于让策略面对一个它没见过的世界，效果变差但**不会报错**。`control.rs` 里有一个测试专门钉住它们。

---

## 5. 你实际会怎么改配置

新手最需要的操作路径。有两条，用哪条取决于你在干什么：

### 5.1 日常改开关 → `robotctl configure`

```bash
sudo robotctl configure          # 全屏交互式编辑器
robotctl configure --list        # 只打印"这台机器人改过什么"，然后退出
robotctl configure --list --json # 同上，输出 JSON（给 support 用）
robotctl configure --file /tmp/bench.toml   # 编辑别的文件（台架副本）
```

第一个是 TUI（终端界面）：**功能开关排在最前**，每个键显示"当前值 vs 默认值"、一行说明，就地切换和输入。

第二个**不需要 root，也不需要终端界面** —— 这是 support 第一个会问的问题，而且能通过 ssh 回答。

> ⚠️ 注意 `--list` **只列改过的键**，不是列出全部。它的原话是
> "Print what this robot **changes from the defaults**"。
> **一台从没被碰过的机器人会什么都不打印 —— 而这本身就是一个答案**，
> 而且比一百行默认值更短。

它存在的理由很实在（`configure.rs` 模块文档原话）：

> `deploy/robotd.toml` 故意写得极其详尽 —— 每个键、段落长度的文档，全部注释掉。
> 那是**正确的参考手册**，但**糟糕的编辑界面** —— 找你想改的那一个开关，意味着翻四百行散文。

改完之后它会**告诉你需要做什么**：

```text
   ⚠️  restart robotd        ← 必须重启才能生效
   ⚠️  restart mediad        ← 注意：不是 robotd！
   ✓  padd picks this up within a second
```

这一句"重哪儿"就是第 8 节的全部内容。

### 5.2 想读文档 / 手工改 → `deploy/robotd.toml`

仓库里的 `deploy/robotd.toml` 是**出厂示例配置**，也是一份极好的教材 —— 每个键都有一段说明"为什么是这个数、什么时候该改"。

它顶部写着一条重要约定：

> **每一个被注释掉的值，显示的就是内置默认值。留着注释，除非这台机器人真的需要别的值。**
> （`install.sh` 只把这份文件拷贝到 `/etc/robot/robotd.toml` 一次，之后永不覆盖，
> 所以一个取消注释的值就在这块板子上被冻结了，而发布版本还在前进。）

举个例子，这份文件里关于 `[update_gate] stall_periods` 的说明：

> 这个值原本是 3（50 Hz 下 60 ms），而一块忙碌板子上普通的调度抖动就会超过它；
> **一个会被抖动触发的健康检查会回滚好的发布。** 25 个周期是 500 ms —— 循环沉默这么久是真的没了。

这段话如果写在别处，就只是"一个数字"；写在这里，它是一段历史。

### 5.3 其他会写这个文件的命令

| 命令 | 只碰哪一段 |
|---|---|
| `robotctl policy load/reset` | `[policy]` |
| `robotctl pad bind/reset` | `[pad]` |
| `robotd` 自己（通过 `pad.bind` IPC） | `[pad]` |

它们**都走同一个写入器**（`edit.rs`），这是刻意的：第二份实现会漂移，而它漂移的地方会是**校验**。

---

## 6. 最绕的概念：`resolved()`

新手最容易困惑的地方：**"配置文件里写的东西"和"程序实际用的东西"不是一回事。**

```text
   文件里写了什么                       实际会用什么
   ─────────────                       ────────────
   [policy]                              ResolvedPolicy
   mode = "walk"          ──┐
   action_scale = <没写>     │  ① 按 mode 填未设置的项
   head_lowpass = <没写>     │     walk → action_scale 0.9, lowpass 0.5/0.7
   walk = <没写>             │     roller → action_scale 0.8, ...
   stand = "none"            │
                         ────┤  ② 叠加技能列表
                             │     从安装的策略集 manifest.json 读，
                             │     按名字合并（同名覆盖、新名追加）
                             │
                             └─ ③ "none" 字面量 → None
                                   → 这个槽不存在，或机器人没有这个能力
                                                 │
                                                 ▼
                                         控制循环
```

调用是 `policy_params.resolved()`（`lib.rs:1556`），返回 `ResolvedPolicy`。

**为什么要分成两层？** 因为一层做不到两件事：

- **`mode` 是预设，不是一个开关。** 把机器人改成轮式（`mode = "roller"`）不只是换策略文件，还要同时换一整套调参默认值。如果每个值都必须显式写出来，改模式就意味着改十几行 —— 而且漏掉一行就是一个静默的怪异行为。
- **"没写"和"写了默认值"必须能区分。** 你没写 `action_scale`，是"跟随 mode"；你写了 `0.9`，是"我就要 0.9，别管 mode"。用 `Option<T>` 就能表达这个区别。

### 6.1 三态：`没写` / `写了默认值` / `写了别的`

这是新手**一定会混淆**的地方，而且它有两个不同的判断函数（`edit.rs:53`）：

```rust
impl Row {
    /// 文件里设了这个键吗？（"有没有被写出来"）
    pub fn overridden(&self) -> bool { self.set.is_some() }

    /// 值和默认值不一样吗？（"值本身是不是分歧"）
    pub fn differs(&self) -> bool {
        self.set.as_deref().is_some_and(|set| set != self.default)
    }
}
```

于是任何一个键处于三种状态之一：

| 状态 | `overridden` | `differs` | 含义 |
|---|:--:|:--:|---|
| **没写**（注释掉或不存在） | ✗ | ✗ | 跟随默认值 / 跟随 mode 预设 |
| **写了，值等于默认值** | ✓ | ✗ | 写法上"覆盖"了，但**没有分歧** |
| **写了，值不一样** | ✓ | ✓ | 这是一次真正的定制 |

**为什么这个区分重要？** 因为 `deploy/robotd.toml` 里就有几个**未注释**的行（`port`、`hz`、`mode`、`enabled`），它们写出来的**正好就是默认值**。

> `differs()` 的注释原话说：一个把默认值**显式写出来**的文件（出厂示例就是这么干的）
> **不是一次分歧**。
>
> 如果把"写出来了"当成"改过了"，那么 `robotctl configure --list` 会把真正重要的两行
> **埋在一堆"看起来像改动其实不是"的行下面**。

顺着这条规矩，还有一个体贴的设计（`edit.rs:243`）：**你在编辑器里把值设成默认值时，它会把这一行删掉，而不是把默认值写进文件。** 这样文件永远保持是"一份决策清单"，而不是"一份默认值副本" —— 这也正是 `--list` 能有意义的前提。

> 💡 记法：**`overridden` 问的是"文件里有没有这一行"，`differs` 问的是"这一行有没有改变行为"。**

### 6.2 三个具体的"陷阱"机制

**`"none"` 哨兵。** 任何可选路径写字符串 `"none"`，意思是"关掉这一项"，映射成 `None`。判断函数是 `is_none_sentinel`（`lib.rs:903`），用的是**大小写不敏感比较** —— 所以 `"None"`、`"NONE"` 都算。

> ⚠️ 这个哨兵的存在意味着：**一个真的名字叫 `none.onnx` 的文件是打不开的。** 这是取舍。

**`walk` 槽永远不为空。** 代码注释记录了一次真实事故：早期版本在 `walk = "none"` 时用 `expect` 直接 panic，**把控制线程打死了**。现在它会退回这台机器人自己的走路策略，并且**报一条 error 说清楚**：`[policy] walk = "none" cannot be honoured`。有一个测试专门钉住这件事（`lib.rs:2676`）。

**技能列表是"按名字合并"的。** 内置的有三个（`roulade`、`kick_left`、`kick_right`），安装的策略集可以在自己的 `manifest.json` 里覆盖它们或追加新的。合并规则（`resolved_skills_with`，`lib.rs:1499`）：

```text
   同名  → 覆盖（改时长、改缩放系数）
   新名  → 追加到末尾
   没提  → 不会丢，保持原样
```

最后 `[policy]` 里那 7 个槽位键会覆盖到列表上，`"none"` 的条目被删掉。另外有一道闸门 `DAEMON_OWNED_SKILLS`：**manifest 不许抢 `ground_pick` 和 `sit_toggle`** —— 这两个是 daemon 自己的机制，不是可配置的一次性技能。

### 6.3 `Slot`：7 个策略槽

```rust
Slot::ALL    = [walk, stand, sitstand, ground_pick, kick_left, kick_right, roulade]
Slot::SKILLS = [kick_left, kick_right, roulade]      // 三个"一次性技能"
```

`Slot` 是一个枚举，不是字符串。它有三个用途，都被测试钉住：

- `as_str()` 必须**正好等于** TOML 里的键名（`lib.rs:2083`）。
- `config_key()` 产出 `policy.<slot>`，给 `apply_for` 用。
- 每个 `Slot` 都必须对应一个 `robotd` 真的会读的键（`edit.rs:1332`）。

---

## 7. 三个文件的分工

```text
   ┌──────────────────────────────────────────────────────────────┐
   │  lib.rs — 值是什么                                           │
   │    Params 结构体 · 每个 section 的 Default · validate()       │
   │    resolved() · Slot · Mode · SkillDef · 策略路径常量         │
   │    ↑ 这是唯一的真相（single source of truth）                 │
   └───────────────┬──────────────────────────┬───────────────────┘
                   │                          │
                   ▼                          ▼
   ┌───────────────────────────┐  ┌────────────────────────────────┐
   │ registry.rs — 有哪些键     │  │ edit.rs — 怎么写回去           │
   │  77 条 Entry{key, kind,   │  │  toml_edit 无损编辑            │
   │  doc, feature}            │  │  写前用 Params::load 校验      │
   │  给编辑器用                │  │  原子替换                      │
   └───────────────────────────┘  └────────────────────────────────┘
                   │                          │
                   └────────────┬─────────────┘
                                ▼
                    robotctl/src/configure.rs
                    （TUI + "该重启谁"）
```

### 7.1 `registry.rs`：给编辑器看的表

`Entry` 只有四个字段：

```rust
pub struct Entry {
    pub key: &'static str,   // "section.key"，和 serde 的拼法完全一致
    pub kind: Kind,          // 值是什么类型 → 编辑器该给什么控件
    pub doc: &'static str,   // 一行说明，显示在编辑器页脚
    pub feature: bool,       // 是不是"功能开关"（编辑器把它们排最前）
}
```

`Kind` 有 12 个变体，把"编辑器需要知道什么"这件事说清楚了：

```text
   Bool / TriBool          开关；三态是给 Option<bool> 用的
   Integer / Float         数字
   OptionalFloat/Integer   数字，或"没写"（跟随别的值）
   Choice(&["a","b"])      从固定几个名字里选
   Text                    自由文本（ALSA 设备名、socket 路径）
   OptionalPath            文件路径，或 "none" 关掉
   IntegerList             一串数字（逗号分隔编辑）
   Table                   重复表 [[policy.skill]] —— 只登记，不就地编辑
   Record(&"...")          嵌套表 [media.intrinsics] —— 同上
```

> **为什么 `Table` 和 `Record` 也要登记，即使编辑器不能改？**
> 因为完整性测试要**真的有完整性**。一个编辑器改不了的 section 仍然是它必须知道存在的 section ——
> 否则下一个加进 `Params` 的重复表就会**悄无声息地**漏掉。

`REGISTRY` 一共 **77 条**，其中 **20 条**标了 `feature`（= 有人打开编辑器就是为了翻的那种开关，而不是要读完文档才敢碰的调参）。

### 7.2 `edit.rs`：无损写入

它**不是**"把结构体重新序列化一遍"。那样会丢掉所有注释 —— 而 `deploy/robotd.toml` 的注释就是这份文件的文档。

用的是 `toml_edit::DocumentMut`：在**原有文档**上只改被指定的那几个键，**注释、顺序、未知键全部原样保留**。

写盘的完整保证（`edit.rs:465` `save`）值得逐步看：

```text
   ①  取文件锁                     ← 并发写不会互相覆盖
   ②  重读磁盘上的最新文档          ← 别人可能改过了
       再"变基"：只把本模型改过的键
       应用上去
   ③  渲染
   ④  写到 robotd.toml.new         ← 临时的
   ⑤  Params::load(&staged, true)  ← ★ 用真正的加载器验证 ★
       失败 → 删掉临时文件，报
       "refusing to write a config robotd would reject"
   ⑥  rename（原子替换）
   ⑦  父目录 sync_all              ← 确保真的落盘
```

**第 ⑤ 步是这里最值得学的设计。** 编辑器不会写出一份 `robotd` 拒绝启动的配置 —— 不是"尽量小心"，而是**写之前先拿真家伙试一遍**。

还有一个体贴的细节（`edit.rs:243`）：**如果你设的值正好等于默认值，它会把这一行删掉，而不是把默认值写进文件。** 这样文件永远保持是"一份决策清单"，而不是"一份默认值副本" —— 也正是这一点让 `robotctl configure --list` 的"当前值 vs 默认值"有意义。

---

## 8. 每个键都要说明"怎么生效"

这是这份代码里最有意思的一个设计，也是新手最容易踩的坑。

**`robotd.toml` 是同一个文件被四个程序读，各读各的段。** 所以"改了这个键要重启谁"**不是**一个常数。

`robotctl/src/configure.rs:63` 用三种答案表达这件事：

```rust
enum Apply {
    Restart(&'static str),   // 启动时读一次。必须重启，那一秒它什么都不干
    Reload(&'static str),    // 跑着的 daemon 会在被要求时重读。比重启便宜：电机不断电
    Live(&'static str),      // daemon 自己会重读文件。什么都不用做，只要告诉用户
}
```

映射函数 `apply_for(key)`（`configure.rs:108`）：

```text
   [media] · [duck_detector]          →  Restart("mediad")
   [pad] · [pad_imu_head_control]     →  Live("padd")
   [head_imu]                         →  Restart("tofd")
   [policy] 除了 mode 和 enabled       →  Reload("robotd")
   [bus] [control] [update_gate]      →  Restart("robotd")
   [policy] [safety] [chorale]
   [theremin] [audio]
```

### 8.1 那个 `[head_imu]` 事故

**这个函数曾经有一个 `_ => "robotd"` 的兜底分支。** 后果是：

> 打开头 IMU，**重启了那个根本不读这个键的 daemon**，而 `tofd` 还拿着旧值。
> 于是开关什么也没做，**而且什么也没说。**

一个"看起来生效了、实际没有、还不报错"的配置项，是最难查的一类 bug。

现在的规则是：**没有兜底**。`apply_for` 遇到不认识的 section 返回 `None`，而**每个 registry 键都必须有答案**由一个测试强制（`configure.rs:1217` `every_registry_key_says_how_it_applies`，遍历整个 `REGISTRY` 断言 `apply_for(key).is_some()`）。

> 加一个新 section 而忘了在 `apply_for` 里加一条？**构建会失败。** 这正是要点。

`Apply` 的每个变体**都带着 daemon 的名字**，也不只是为了实现方便 —— 注释里说：一个只说 "restart" 而**不说重启谁**的提示，正是 `[head_imu]` 变成重启 `robotd` 的原因。所以给用户看的每一句话都点名。

### 8.2 `Plan`：多个键一起改怎么办

`robotctl configure` 一次可能改好几个键。`plan_for_keys`（`configure.rs:165`）把它们合成三个列表，并且做两件"聪明"的事：

**降级吸收。** 如果 `robotd` 已经在重启列表里了，那么它上面的 reload 和 live 就**没必要单列** —— 一个要下线的 daemon 重新起来时会读整个文件。

> 注释里的例子很具体：`[policy] mode` 需要重启，`[policy] gain` 本来会是 reload。
> 同时改这两个，提示 "restart robotd, then reload robotd" 意味着**再打扰一次正在走路的机器人**，
> 去应用一个它已经应用了的值。

**排序。** `robotd` 排在第一个，因为 `mediad.service` 是 `After=robotd.service` —— 反过来的话，`mediad` 会连上一个马上要消失的 `robotd`。

---

## 9. 热重载：谁被监听，谁必须重启

**全仓库没有 `SIGHUP` 处理器，没有文件监听器（inotify/notify）。** 只有两处例外，而且都是"挣来的"，不是"顺手加的"：

### 例外一：`padd` 每秒看一次文件时间戳

`padd/src/main.rs` 里 `BINDINGS_POLL = 1s`：每秒 `stat` 一次 `robotd.toml`，`mtime` 变了就重读 `[pad]` 和 `[pad_imu_head_control]`。

**为什么值得破例？** 因为重启 `padd` 的代价不是"一秒"，而是：

> 手柄会话断了 → `robotd` 的死区开关（deadman）把**正在走路的机器人**速度归零。

对比一下：为了应用一个按键绑定，让机器人停下来 —— 不值。所以这里 `Apply::Live`，提示语是实话实说：**"padd picks this up within a second"**。

细节上还有两点：解析失败会**退回默认映射**（半写状态不会让人失去手柄）；轮询是一秒一次而不是每 tick 一次，因为"人工改文件一周几次，50 Hz 地 stat 是白做功"。

### 例外二：`robotd` 被要求时重读 `[policy]`

`PolicyChange::Reload`（`robotd/src/main.rs:1595`）：重新解析整个 `[policy]`，重建控制器。

**为什么值得破例？** 因为重启 `robotd` 会把电机控制权从一个**站着的机器人**手里拿走 —— 就为了改一个本来可以站着改完的数字。

这就是 `robotctl policy add` 能在**不打断一个站着的机器人**的情况下装载技能的原因。

**但有两个键不在这个承诺里**，`apply_for` 里专门排除：

| 键 | 为什么不能 reload |
|---|---|
| `mode` | 重载时**故意保留**当前 mode —— 因为 `robot.setMode` 不写配置文件，如果重载时采纳文件里的 mode，就会**把一次热切换悄悄撤销掉** |
| `enabled` | 只读一次进 `RobotState`，而且 `enabled = false` 时这个重载调用本身是**被拒绝**的 —— 所以大家真正在意的那个方向（关→开）根本没法靠 reload 做到 |

---

## 10. 写配置的安全性

除了第 7.2 节的"写完前先验证"，还有两条规矩：

**权限：文件是 root 所有的。** 要写它就得 `sudo`。错误提示会直接说清楚这一点（`edit.rs` `writable_hint`）。

> 有个细节值得注意：这个提示**不再**说"请运行 `sudo robotctl configure`"。因为现在有四个调用者会写这个文件，**而 `robotd` 就是其中之一** —— 它本身就以 root 跑，所以对一个通过无线电来问的客户端说"去终端跑 sudo"，是把它指向一个 sudo 也到不了的地方。

**并发：两个写者不会互相吃掉对方的修改。** 取锁 → 重读最新文档 → 只把自己改过的键变基上去。有一个测试专门验证这件事（`edit.rs:1131`）。

---

## 11. 未知键与拼写错误

这里有一个**反直觉但正确**的决定：**不认识的键不会让机器人起不来。**

`Params::load`（`lib.rs:1935`）的流程：

```text
   读文件
     │
     ├─ 文件不存在？
     │     · 是默认路径 → 用内置默认值 + 一条 warn   ← 没 provision 过的板子也能起来
     │     · 是命令行点名的 → 报错（你说了它在这，它就得在）
     │
     ▼
   严格解析 tomllib
     │
     ├─ 成功 → 完事（99% 的情况，一次过）
     │
     └─ 失败
          │
          ├─ 试着剪掉未知键再解析
          │     ├─ 成功 → warn 列出被忽略的键名，继续跑
          │     └─ 失败 → 报错（但报的是最初的严格错误，
          │              因为它带着行号和列号）
          ▼
       validate()：hz 必须 1..=1000
                    bitrate 必须 100_000..=20_000_000
```

**为什么对未知键这么宽容？** 因为这台机器人上的软件是可以**回滚**的。

> 一台跑着新版本的机器人被回滚到旧版本 —— 而配置文件里还留着新版本才认识的键。
> 如果未知键是致命的，**这台机器人就再也起不来了**，只因为一个它根本不该关心的键。

所以：**不认识的键被忽略，并且明确地说出来**（`this build has no such keys; they are ignored and their values do nothing`）。

### 两条方向相反的规矩

这一对极容易记混，所以并排写出来：

| | 读（`Params::load`） | 写（`edit.rs`） |
|---|---|---|
| 遇到不认识的键 | **容忍** —— 剪掉、warn、继续跑 | **拒绝** —— 只写 registry 认识的键 |
| 为什么 | 回滚/降级/分支切换时，旧文件里会留着新版本才认识的键。致命 = 机器人再也起不来 | 编辑器只知道 registry 里的键。放行一个它不认识的键，等于**写出一个它没验证过的文件** |

一句话记法：**读要宽容，因为文件可能比程序新；写要严格，因为程序比文件清楚。**

### 校验只有两处，而且位置是刻意的

`validate()` 只检查两个值：`control.hz` 必须在 `1..=1000`，`media.bitrate` 必须在 10 万..=2000 万。

第二处的注释值得读（`lib.rs:1995`）：

> **在这里查，而不是在 `mediad` 里，是为了让 `robotctl configure` 拒绝写出它。**
> 会因为这个值噎住的 daemon，并不是编辑器那道门所在的 daemon。

也就是说：这个值最终是 `mediad` 用的，但**校验放在 `robotd-params` 里**，因为编辑器是通过这个 crate 写文件的。放在 `mediad` 里的话，编辑器会**高高兴兴地写下一个会让 `mediad` 起不来的值**。

### 但宽容是有代价的，而且被明确处理了

宽容带来一个真问题：**拼错一个键名，会被当成"不认识的键"静默忽略。**

有一个测试专门钉住这个边界（`lib.rs:3250` `a_typo_is_ignored_and_leaves_the_real_key_alone`）：拼错的键被忽略，**而真正的键保持默认值**（不会被错误地改动）。

还有一条更细的（`lib.rs:3312`）：如果一个**真错误**（比如 `hz = 0`）和一个无害的未知 section 出现在同一个文件里，**报错必须点名那个真错误**，而不是那个未知 section。

> 注释里说得很清楚：把刚刚被这个版本声明为无害的键报成"daemon 起不来的原因"，
> 会把读日志的人送去删一个从来不是问题的段落。

### 两个重命名过的 section

| 旧名 | 新名 | 怎么处理 |
|---|---|---|
| `[detect]` | `[duck_detector]` | `serde(alias)` —— **旧文件照常能读**，编辑器下次保存时改名 |
| `[imu_head]` | `[pad_imu_head_control]` | 同上 |
| `[health]` | `[update_gate]` | **故意不做别名** ← 见下一节 |

**"编辑器下次保存时改名"** 这件事比听起来复杂一点（`edit.rs:138` `migrate_renamed_sections`）：

> 加载器通过 serde alias 接受旧名字，所以改名之前写的文件**原封不动地继续工作**。
> 但如果编辑器往**新名字**下写一个键、而旧的段头还留着，那么文件里就会**同时有两段**
> —— 而加载器会把它当作重复字段**拒绝掉**。
>
> 所以旧段头在这里被**一次性改名**，下次保存写出的文件里只有新名字。
> 另外：**在别的东西被保存之前，什么都不会写** —— 只是浏览一遍不会改动任何文件。

---

## 12. `[update_gate]` 为什么叫这个名字

它以前叫 `[health]`。改名了，而且**故意不留别名** —— 带旧名的板子会得到一条**点名这个 section 的解析错误**，这比"静默地跑在没人选过的阈值上"好。

为什么非改不可（`lib.rs:1824`）：

> `robot.health` 报告的东西**远不止**这些：还有电池、电机温度、循环和总线计数。
> **这些一个都不许进入裁定** —— 一个发布绝不能因为它落在的那块板子的状态而被回滚。
> 所以它们在这里**一个对应的键都没有**。
>
> 叫它 `[health]` 会让人读成"机器人现在怎么样"，而它实际配的是
> **"自动回滚唯一关心的那一个问题"**。

而且注释特意点了下一步：**这一切都是软件属性**。将来如果真想要一个"电机温度过高就限速"的功能，那应该另开一个 `[thermal]` 段 —— 属于另一个名字。

> 📌 这条和 `robotd-primer.md` 第 6.3 节的"规矩三"是同一件事的两面：
> 健康判决里只允许出现**发布能被责怪**的东西，其余全部是**描述**。

---

## 13. 测试：四个最值得讲的

`lib.rs` 里大约 60 个测试，`edit.rs` 32 个，`registry.rs` 3 个。挑四个最能说明这个 crate 的性格：

### 13.1 `the_registry_covers_every_key_exactly`（`registry.rs:535`）

**手法非常巧，值得单独看。** 它要证明"registry 里的键和 `Params` 的字段**恰好**一一对应"。

问题是：**直接序列化 `Params::default()` 会漏掉所有值为 `None` 的 `Option` 字段** —— 静态遍历看不见新加的字段。

它的解法：**故意往每个 section 里塞一个不存在的键**（`__no_such_key__ = 0`），然后**从 serde `deny_unknown_fields` 的报错信息里读出真实字段名**。

读到字段名之后，断言三件事：

1. 每个真实字段**都**在 `REGISTRY` 里；
2. 每条 `REGISTRY` 记录都能被 `Params` 解析（按 `Kind` 生成一段探测 TOML；`Kind::Record` 用它自带的 body）；
3. 没有重复。

还有一个前置断言（`registry.rs:524`）：**serde 的报错格式没变** —— 否则这个测试就"瞎了"，会静默地什么都读不到却依然通过。

### 13.2 `the_shipped_example_matches_the_defaults`（`lib.rs:3052`）

```rust
include_str!("../../deploy/robotd.toml")
```

它把出厂示例配置**真的读进来解析**，逐项断言每个值都等于内置默认值。

为什么重要？因为 `deploy/robotd.toml` 是给人看的文档。**如果它和实际默认值不一致，那这份文档描述的就是一个不存在的机器人。**

> ⚠️ 注意这个测试的**边界**：它只能验证**被解析到的值**。**注释掉的行不参与解析** ——
> 所以一条写错了默认值的注释，它是抓不住的。这条边界值得记住，因为这份文件的全部价值
> 就在注释里。

### 13.3 `disabling_the_walking_slot_falls_back_rather_than_panicking`（`lib.rs:2676`）

回归测试，钉住一次真实事故：`walk = "none"` 曾经让控制线程 panic。

### 13.4 `a_config_robotd_would_reject_is_never_written`（`edit.rs:819`）

钉住第 7.2 节第 ⑤ 步：编辑器的输出**必须**能被真正的加载器接受。还有一个测试做**真实往返**（写出去、读回来、比对）。

---

## 14. 阅读路线

**第 1 步 —— 先当用户（15 分钟）**

1. 读 `deploy/robotd.toml`。**不要读代码，先读这份文件。** 它是这个 crate 存在的理由，也是最好的入口。
2. 跑一下 `robotctl configure --list`（在一台机器人上）或只是想象一下它的输出。
3. 记下第 3 节那三个问题。

**第 2 步 —— schema（1 小时）**

4. 读 `lib.rs:1–100`（模块文档 + `Params` 结构体）。
5. 挑两个 section 读它们的字段和 `Default` 实现 —— 建议 `Control`（简单）和 `PolicyParams`（复杂）。
6. 读 `Slot`（`:1358`）和 `Mode`（`:812`）。

**第 3 步 —— 解析与解析后（1 小时）**

7. 读 `Params::load`（`:1935`）和 `validate`（`:1988`）—— 就是第 11 节那张图。
8. 读 `resolved()` / `resolved_with()`（`:1556`）—— 就是第 6 节那张图。**这是全 crate 最需要读懂的一段。**
9. 读 `is_none_sentinel`（`:903`）和技能合并（`resolved_skills_with`，`:1499`）。

**第 4 步 —— 编辑与生效（1 小时）**

10. 读 `registry.rs` 的 `Kind` 枚举（`:20`）—— 它把"编辑器需要知道什么"讲得很清楚。
11. 读 `edit.rs` 的 `save`（`:465`）—— 七步保证。
12. 读 `robotctl/src/configure.rs` 的 `apply_for`（`:108`）和模块文档 —— 第 8 节那个事故。

**第 5 步 —— 动手**

```bash
cargo test -p robotd-params        # 全部测试，不需要硬件
```

然后试试改一个键，观察它有没有被写出去：

```bash
# 这台机器人改过什么？（不需要 root，不用进全屏界面）
robotctl configure --list

# 改一个键 —— 需要 root，因为文件是 root 所有的
sudo robotctl configure
```

改完注意看它打印的那句 **"该重启谁"** —— 那就是第 8、9 节的全部内容。

---

## 15. 术语表

| 术语 | 意思 |
|---|---|
| **schema** | 数据的"形状"定义：有哪些字段、什么类型、什么范围 |
| **serde** | Rust 的序列化/反序列化框架。`Deserialize` 就是"能从 TOML/JSON 读进来" |
| **`deny_unknown_fields`** | serde 的一个开关：出现不认识的字段就报错。本 crate 普遍打开它，但**加载时会兜住**（剪枝重试） |
| **alias** | `serde(alias = "旧名")`：让旧名字也能被解析，用于重命名过的字段/section |
| **Default 实现** | Rust 里"这个类型没被指定时的标准值" |
| **`Option<T>`** | "有值或没有"。在这里，"没有"是一个**有意义的状态**（= 跟随 mode / 自动） |
| **哨兵值 / sentinel** | 用一个特殊的值表示特殊含义。这里的 `"none"` 字符串表示"关掉这一项" |
| **resolved / 解析后** | 把"文件说的"和"预设的"合起来之后，**程序实际会用的**那份值 |
| **manifest.json** | 策略集自带的清单，声明这个集里有哪些技能、各自的时长和缩放 |
| **无损编辑** | 编辑时保留原有的注释、顺序和未知内容 —— 不是重新生成整个文件 |
| **`toml_edit`** | 支持无损编辑的 TOML 库（普通的 TOML 库读完再写会丢掉一切格式和注释） |
| **原子替换** | 先写临时文件、验证、再 `rename` 覆盖。中途失败不会留下半个文件 |
| **TUI** | 终端里的全屏交互界面 |
| **registry / 注册表** | 一张"所有配置键"的清单，附带类型和说明，供工具使用 |
| **feature 开关** | 那 20 个"有人打开编辑器就是为了翻它"的键，编辑器把它们排在最前 |
| **热重载 / live reload** | 改了配置不用重启就生效 |
| **mtime** | 文件的"最后修改时间"。`padd` 就是靠比对它来发现文件被改了 |
| **deadman / 死区开关** | "控制信号停了就自动归零"的安全机制。这就是重启 `padd` 的代价 |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| 参数文件的机制（权威，英文） | [`design/robotd-design.md`](design/robotd-design.md) §4.2 |
| 出厂示例配置 —— **最好的入门读物** | [`../deploy/robotd.toml`](../deploy/robotd.toml) |
| 控制循环本身（姊妹篇） | [`robotd-primer.md`](robotd-primer.md) |
| 蓝牙门房：手机怎么连上机器人（姊妹篇） | [`btd-primer.md`](btd-primer.md) |
| wifi、身份、手柄配对（姊妹篇） | [`configd-primer.md`](configd-primer.md) |
| BLE 的线上契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| 控制核心：从读总线到写总线（姊妹篇） | [`duck-control-primer.md`](duck-control-primer.md) |
| 摄像头里的鸭子检测（姊妹篇） | [`duck-detect-primer.md`](duck-detect-primer.md) |
| 仿真的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| 所有服务与客户端的公共契约（姊妹篇） | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| 笔记本上的客户端（姊妹篇） | [`duckctl-primer.md`](duckctl-primer.md) |
| 发布怎么把自己装到板子上（姊妹篇） | [`hooks-primer.md`](hooks-primer.md) |
| 板子被配置成什么样子（姊妹篇） | [`deploy-primer.md`](deploy-primer.md) |
| 健康判决为什么只允许某些东西进入 | [`design/robotd-design.md`](design/robotd-design.md) §3.4 |
| 策略文件从哪里来、怎么换 | [`design/policy-channel-design.md`](design/policy-channel-design.md) |
| 每一条 `robotctl` 命令 | [`robot/cheatsheet.md`](robot/cheatsheet.md) |
| 手部检测参数的来源：几何库（姊妹篇） | [`kinematics-primer.md`](kinematics-primer.md) |
| `[media]` 和 `[duck_detector]` 的消费者（姊妹篇） | [`mediad-primer.md`](mediad-primer.md) |
| 机器人走到哪了：接触式里程计（姊妹篇） | [`odometry-primer.md`](odometry-primer.md) |
| `[pad_imu_head_control]` 背后那个滤波器（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| 手柄：按键映射、模式、那个 raw tap（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| `[audio] pet_detect` 背后那个分类器（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| `configure` 是它的编辑界面（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| 装机、更新、诊断的那些工具（姊妹篇） | [`scripts-primer.md`](scripts-primer.md) |
| 鸭子的嗓子：可播种的合成器（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 头部的两个传感器：深度与 IMU（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
