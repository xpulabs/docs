# `duckctl` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> `duckctl` 的定位由 [`design/app-path-design.md`](design/app-path-design.md) §3 拥有（英文），
> 命令参考在 [`robot/duckctl.md`](robot/duckctl.md)。
> 两者若有不一致，以设计文档为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：[`btd-primer.md`](btd-primer.md) —— **`duckctl` 是 `btd` 的对手方**。

## 目录

1. [一分钟版](#1-一分钟版)
2. [和 `robotctl` 的分工](#2-和-robotctl-的分工)
3. [核心心智模型：手机的替身](#3-核心心智模型手机的替身)
4. [目录导览](#4-目录导览)
5. [它是怎么找到一台机器人的](#5-它是怎么找到一台机器人的)
6. [一次请求的完整旅程](#6-一次请求的完整旅程)
7. [⭐ 为什么屏幕上长这样](#7--为什么屏幕上长这样)
8. [⭐ 超时是"什么都不来的间隔"](#8--超时是什么都不来的间隔)
9. [地址从广播里来](#9-地址从广播里来)
10. [版本不一致时它做什么](#10-版本不一致时它做什么)
11. [`advwatch`：那个测量工具](#11-advwatch那个测量工具)
12. [测试](#12-测试)
13. [阅读路线](#13-阅读路线)
14. [术语表](#14-术语表)

---

## 1. 一分钟版

`duckctl` 是**在笔记本上跟机器人说话的工具** —— 没有网络、没有 ssh 的时候。

```bash
cargo install --path duckctl      # 装一次
duckctl scan                      # 附近的机器人，以及它们的地址
duckctl status
duckctl wifi scan
duckctl wifi connect "Pollen" --psk secret
duckctl name "Ducky"
duckctl call robot.health
duckctl logs robotd -n 100
```

一句话说清它的定位（模块头原话）：

> **手机 App 的替身，也是唯一能对着真无线电测 `btd` 的办法。**
>
> **蓝牙是它今天够到机器人的方式，不是它本身是什么。** ……
> 所以名字说的是**跟谁说话**，而不是**用什么无线电**。
> **BLE 是唯一答案的那些日子里，它叫 `duck-btctl`。**

规模：**3940 行**（`main.rs` 3625 + `advwatch.rs` 241 + `Cargo.toml` 74），**51 个测试**。

---

## 2. 和 `robotctl` 的分工

这是新手最容易搞混的一对。一句话：

```text
   robotctl   ←  在机器人**上**，说 unix socket，**随发布包发货**
   duckctl    ←  在笔记本**上**，走无线电，**永远不进发布包**
```

`Cargo.toml` 的第一句就是：

> **客户端那一半，而且它跑在离机器人很远的地方。**

而 `CONTRIBUTING.md` 的目录表里，`duckctl/` 那一行写的是：

```text
   duckctl/        the laptop-side client — never shipped, never cross-built
```

**"never cross-built"（从不交叉编译）是真话，而且是机制保证的** —— 见第 3.2 节。

两条工具在文档里反复互相指：

- 需要机器人本机能力时 → **ssh 进去打 `robotctl`**
  （`duckctl ssh -- sudo robotctl pad pair`）
- 被 BLE 拒绝的那些命令 → 最终就是**"机器人上的 `robotctl`"**

---

## 3. 核心心智模型：手机的替身

### 3.1 它存在的理由

设计文档 §3.3 说得很直接：

> **`duckctl` 是一个测试工具，而且刻意不只是多一点 —— 真正的客户端是一个手机 App。**

它存在的意义是：**在手机 App 写出来之前，先把那条路径每天走一遍**。

而 `mobile-app.md` 对它的定位说得更重：

> **`duckctl.md` 是这个 App 拥有的、最接近功能规格的东西** ——
> 里面每一条命令，**都是 App 能用同样的无线电、拿到同样回复的一个调用**。

**这就是为什么它必须走无线电，而不是走一条更省事的捷径。**

### 3.2 ⭐「永远不在机器人上」是怎么保证的

> **机器人上没有任何东西依赖 `duckctl`**，这正是让 `btleplug`（客户端的蓝牙库）不进发布包的原因。

而这句话**曾经是靠一个副作用成立的，现在是直接说出来的**：

```text
   以前：它是 `btd` 的一个 **example**。
         example 的依赖是 dev-dependency，
         所以 `btleplug` 永远到不了发布产物里 ——
         **一个真的保证，但是靠"文件坐在哪个目录"顺带得到的。**

   现在：它是一个**独立的 crate**，而且被
         **排除在 workspace 的 `default-members` 之外**。
```

那第二句才是关键：`cargo board --bins` 会为 aarch64 构建**每一个默认成员**，
而 `duckctl` 不在其中 —— **所以它永远不会被交叉编译上板子**。

> （我核实过：`Cargo.toml` 里 `duckctl` 在 `members` 里、**不在** `default-members` 里。
> 而 CI 用的是 `--workspace`，所以它照常被 lint 和测试。）

### 3.3 为什么用 `btleplug` 而不是 `bluer`

`btd` 在板上用的是 `bluer`，这里用的是 `btleplug`。理由很简单：

> **因为这一端跑在开发者的机器上**：macOS 上是 CoreBluetooth，Linux 上是 BlueZ，Windows 上是 WinRT。
> **`bluer` 会把客户端限制成 Linux 专用，那就把"有一个客户端"的意义抹掉了。**

而它有一个**刻意的版本下限**，`Cargo.toml` 里写得很详细：

> **0.13 或更新，而这个下限是刻意的。**
> 每一个 0.11 在 CoreBluetooth 后端里有**三个 `.expect()`** —— 它们不是让一个调用失败，
> 而是**直接终止整个 BLE 事件循环**：`set_characteristics` 在一个它不认识的服务上 panic，
> 而 `update_descriptors` 又在未知服务或特征上 panic 两次。
>
> **后一对会在 CoreBluetooth 实际会产生的一种发现回调顺序上触发**（deviceplug/btleplug#397），
> **而它带走的是整个客户端，不是那条连接。**
>
> ……我们没有在这里见过那个 panic，而**那说明不了什么**：
> `duckctl` 连一下就走了，开发者不会为此提 issue。
> 换版本的理由是：**那是一个进程直接 abort，出现在的却是人们在板子已经不对劲时才会去拿的工具上。**

### 3.4 它复用 `duck_ble::framing` —— 这是刻意的

> 这里的分片是**机器人用的那个模块的客户端半边**，
> 所以如果分片逻辑不对称，**这个工具根本不会工作** ——
> **这使它成为一次对协议的真正测试，而不是一个可以跟自己达成一致的重写。**

而**唯一刻意不对称的是行长上限**，而且必须不对称：

> 机器人那个上限约束的是**无线电范围内一个未配对的对端能让它缓冲多少**，而这一端没有这样的对端。
> 共用那个紧的，会让**每一条超过 8 KiB 的回复在这里读不出来** —— 而 `btd` 把那些回复服务得好好的。

（这就是 `duck-ble-primer.md` §5.2 讲的 `MAX_LINE` vs `MAX_REPLY_LINE`。）

---

## 4. 目录导览

```text
duckctl/
├── Cargo.toml              74 行   依赖（注释解释了每个不显然的选择）
├── src/main.rs           3625 行   全部逻辑
└── examples/advwatch.rs   241 行   那个测量工具（见第 11 节）
```

`main.rs` 的分区（左边是行号）：

| 行号 | 内容 |
|---:|---|
| 1–129 | 模块头 + **14 个常量**，每个都有一段理由 |
| 130–262 | `Seen` / `Address` / `identity` / `answers_to` —— 一次扫描看到的东西 |
| 263–424 | `Target` / `resolve_pin` / `choose` —— 找哪一台、用哪个 PIN |
| 425–620 | `deliver` / `ssh_*` / `scp_*` / `console_url` —— 第 9 节 |
| 621–842 | 列表渲染与错误消息（`:621`–`:830`） |
| 843–1351 | `Cli` / `Command` 和五个嵌套子命令枚举 |
| **1352–1812** | **`run()` —— 每个子命令** |
| 1813–1990 | 输出格式化 + `Waited` |
| 1991–2106 | 收发：`write_line` / `read_line` / `characteristics` / `warn_about_skew` |
| 2107–2600 | 请求构造（`request_line` / `update_request_line` / 三个 `*_note`） |
| 2600–3625 | 其余命令 + **51 个测试** |

**建议的阅读顺序：** 模块头 → 那 14 个常量 → `run()` 的骨架 → `request_line` → 输出格式化那一段。

---

## 5. 它是怎么找到一台机器人的

### 5.1 扫描是**不带过滤**的

```rust
start_scan(ScanFilter::default())   // ← 空过滤，故意
```

因为设计文档 §3.3 记着一个**属于 CoreBluetooth 而不是这个工具的**性质：

> **CoreBluetooth 严格地遵守过滤条件，而一个已配对的外设经常带着空的服务列表广播。**
> 一旦过滤，**它就根本不会被报告** —— 不是"被报告但没有服务"，是**不存在**。
>
> 这表现为"一次运行 `no robot found`、下一次成功，中间什么都没改"。

### 5.2 ⭐ 轮询，而不是"睡一觉再取一次快照"

```rust
const SCAN_TIME: Duration = Duration::from_secs(8);   // 最多找多久
const SCAN_POLL: Duration = Duration::from_millis(250); // 多久重看一次结果
```

`SCAN_POLL` 的注释是一段**认错**：

> **在固定 sleep 之后取一次快照，是这里以前的做法，而它会间歇性地失败**：
> BLE 广播是周期性的，而 CoreBluetooth 对一个已配对外设的视图会来会走，
> 所以"机器人在不在那一张快照里"**有一部分是靠运气** ——
> 于是一个下一次就答得好好的机器人被报成 `no robot found`。
>
> 而且轮询到有东西出现，也**让常见情况在远不到一秒内就结束**，而不是每次都付满 `SCAN_TIME`。

> 💡 **这正是 `btd-primer.md` §8.1 里那个"三个症状"的第三个** ——
> 当时判定它是**唯一一个客户端侧的 bug**，而这里就是它被修掉的地方。

### 5.3 四档候选，和一个说清"为什么没找到"的过程

扫描过程中会把看到的设备分成几档，从最可信到最不可信：

```text
   advertised   广播里带着服务 UUID            ← 最可信
   named        名字对得上
   connected    本机已经连着它
   （全部）      都记下来，用于"没找到"时解释
```

而 `Target`（`:263`）决定"我在找谁"：

```rust
/// `--name` 如果给了；否则 `DUCK_ROBOT` 如果它说了什么。
fn new(flag: Option<String>, var: Option<String>) -> Self
```

一个细节很讲究：

> **一个空的 `--name` 仍然是一次 `--name`。** 这个 flag 在任何情况下都压过环境变量，
> **包括这一种** —— 所以"用一个空值压过它"是**第二个逃生舱**：
> **一行命令就能丢掉默认值，而不用去改它运行的那个 shell。**
> （`DUCK_ROBOT= duckctl scan`）

**为什么不用 `clap` 自带的 `env` 支持？** 因为它用 `env::var_os`，会把 `DUCK_ROBOT=` 当成一个**值** ——
于是唯一逃开它的办法是 `unset`，而**需要逃开的恰恰就是眼下这一条命令**。

#### ⚠️ 一个 `clap` 撞车的事故

`--name` 这个全局参数的 **clap id 不叫 `name`**。原因值得一记：

> clap 用**参数的 id** 做键，而 `name` 这个子命令的 positional 参数派生出**同一个 id** ——
> **positional 赢了**。
>
> 于是 `duckctl --name duck-c51b name leduckpierre` 会去搜 **`leduckpierre`**
> （也就是它**正要设置的那个名字**），然后**把眼前站着的机器人报成不在范围里**。
>
> 改成 `id = "robot"` 就好了。

> 💡 这是个很好的提醒：**"找机器人"和"给机器人改名"共用了一个词，于是它们在一个 CLI 解析器里撞了车。**

### 5.4 `choose`：**多个候选就拒绝，不猜**

```text
   没给名字   →  第一个候选赢（省略 --name 就是要这个，报错会破坏台架上的简写）
   给了名字   →  命中多个 → **拒绝**
```

`choose`（`:379`）拒绝而不是"挑一个"，理由很硬：

> **从客户端这一侧看，这两台无法区分** —— 挑任何一台都意味着**这次写会落到先被报告的那一台**。
> **而 `net.connect` 会把 wifi 密码放上去。**

而这件事**不需要有人做错**就会发生（注释里点名的机制）：

> **bootloader 留空 `serial-number`，名字就回退成 hostname** ——
> 于是**一批刷同一镜像的板子全都叫 `radxa-zero3`**。

失败时它会列出**其他候选实际叫什么**，并附上名字的来源。

### 5.5 一台机器人可能有**两个**名字

`answers_to`（`:230`）必须同时接受两半：

```text
   radxa-zero3 [duck-c51b]
   └────┬────┘  └───┬────┘
    GAP 名        广播里的名字
   （BlueZ 的 adapter alias，源自 hostname）
```

> CoreBluetooth **从不披露地址**，macOS 上所有设备都报 `00:00:00:00:00:00` ——
> 所以 `identity`（`:200`）用 per-Mac 的 id 顶替它，否则**一份列表分不出哪个未命名设备是哪个**，
> 而那正是列表存在的场合。

而**历史上每个机器人都不同**：GAP 名是 BlueZ 的 adapter alias，源自 hostname，
**同一镜像全是 `radxa-zero3`**。`btd` 现在会把 alias 一起设成广播名（`btd-primer.md` §11.3），
但它**仍然必须两半都收** —— 因为老 release 的板子还在，而且更新前缓存了旧 GAP 名的客户端也在。

> 有一个教训：**精确匹配那个拼接串，曾经让两种拼法都被拒** ——
> 而且失败还把这台机器人当成"不在范围里"的证据列了出来。

### 5.6 ⭐ 错误消息是**一等产物**

这个工具在"没找到机器人"时**不是一个失败就完了**，而是分成好几种，每一种给出不同的下一步：

```text
   nothing_found    什么都没看到，而且列出的设备里没有像机器人的
   radio_saw        无线电看到了设备，但没有一台应答
   missed_the_named_robot   有机器人，但没有一台叫你要找的那个名字
```

有测试专门钉住"**一次没找到**和**一次名字冲突**不是同一种失败"，
以及"**没有 `--name` 时第一个候选仍然会赢**"。

> 这一类设计在这个工具里是系统性的：`step()`（`:830`）给每一个异步操作套上超时，
> 超时时把 **"哪一步" + 多行提示 + 预算** 一起打出来。

---

## 6. 一次请求的完整旅程

```text
   ① 解析命令行，决定找谁（`Target`）和用哪个 PIN
   ② **先做便宜的拒绝**（`scp_refusal`，见第 9 节）—— 在无线电打开之前
   ③ 扫描（不带过滤，轮询到有候选为止）
   ④ connect → discover → 读一次特征
        每一步各有各的超时和失败消息
   ⑤ warn_about_skew —— 版本不一致只说，不拒绝（见第 10 节）
   ⑥ ⭐ **先 subscribe，再写**
   ⑦ 发 `system.authenticate`（PIN 错了会告诉你还剩几次）
   ⑧ 把请求切成 20 字节的块写出去 —— **而且每块都要求一个回应**（见下）
   ⑨ 循环收通知：
        · 没有 `id` 的 → 进度，走 stderr
        · `logs` / `search` / 解析地址 → 各自的渲染器
        · 其余 → 机器人的回复**原样 pretty JSON** 打到 stdout
        · JSON-RPC error 也算"机器人应答了"，用退出码报告
   ⑩ 成功后追加几行"注记"到 stderr（见第 7.2 节）
```

### 6.1 为什么是**先读、再订阅、后写**

```text
   读   ← 这是**唯一被确认**、而且能触发配对的一步
   订阅 ← 它是 `btd` 那个会话能够存在的前提
   写   ← 最后
```

而 `btd` 那边有一条对应的规矩：**没有活跃订阅时，写入是被拒绝的** ——
因为**接受它是撒谎：没有地方可以送回复**（`btd-primer.md` §8.2）。

### 6.2 ⭐ 为什么每块都要一个回应

```rust
// 用 WithResponse，不是 WithoutResponse
framing::chunks(line, 20)
```

BLE 里"写"有两种：**Write Command**（`WithoutResponse`，不等确认）和 **Write Request**（`WithResponse`，等确认）。
这里**刻意用慢的那个**，而注释是一段实打实的事故记录：

> `WithoutResponse` 不带回应，所以**一次拒绝（比如加密不足）完全不可见**：
> **请求静默地没有到达，而客户端等到超时，还不知道为什么。**
>
> **这正是它最初的行为，对着一个完全正常的机器人。**

而 20 字节是**每一条 BLE 链路都保证支持的下限** —— 因为 `btleplug` **不暴露协商出来的 MTU**。

> ⚠️ 注意这和机器人侧的区别：`btd` 那边**知道** MTU（BlueZ 在每次入站写时上报它），
> 所以它按真实值切块。客户端这一侧没有这个信息，只能从下限起步。

### 6.3 `Waited`：三态

```rust
enum Waited { … }
```

等待的结束有三种原因，而它们**给出不同的下一步**：

```text
   收到回复了        → 正常
   一直没东西来      → 超时（"静默"）
   链路没了          → 连接断了
```

> 而这两个失败**必须分开**，因为**一次*成功*的 `update apply` 本来就会断链**
> —— 那个 daemon（连同 `btd`）在更新完成后会重启。

---

## 7. ⭐ 为什么屏幕上长这样

**`duckctl` 没有 `--json`，而且是刻意的。** 这是这个工具最好的设计课。

### 7.1 一条规矩：**stdout 上只有机器人说的话**

```text
   stdout  ←  **机器人的回复本身**（pretty JSON 原样）
   stderr  ←  进度、诊断、警告、注记 —— 一切不是机器人说的话
```

于是这些**都能工作**：

```bash
duckctl logs robotd | grep panic        # 管道里不会混进工具自己打印的行
duckctl policy search flamingo | grep … # 同理
duckctl status > reply.json             # 得到一个干净的 JSON
```

而**机器可读性就是靠这条分工，不是靠一个开关**。

> 只有**三个渲染例外**，而它们有一个共同点：
> **答案是"一份供人挑一个的清单"** —— `policy search`、`logs`，以及 `ip`（只要一个字段）。
> **"答案是一个事实"的命令不享受渲染。**

### 7.2 那几行"注记"（`*_note`）

有三个函数专门在**机器人回复之外**再打一行到 stderr：

| | 什么时候 | 为什么必须单独说 |
|---|---|---|
| `account_note` | 登录 | 把 `user_code` / `verification_uri` / `expires_in` 变成"打开这个网页、输入这个码"。**先打印再开浏览器** —— 因为终端有 scrollback，而浏览器可能没开起来 |
| `limp_note` | `reboot-motors` | 回了 `{"accepted":true}` **只表示接受**，而扭矩真的全关了 —— **只看 JSON 的客户端会以为机器人还站在地上**。所以单独一行叫人扶住它 |
| `restart_note` | `update apply` / `rollback` / `select` | 只有在**真动作**且 `component == "daemon"` 时，预告"约 5 秒后连接会掉，**那是升级在工作**" |

> **为什么不塞进 JSON 里？** 因为这些是"**JSON 本身没说、但人类下一步必须知道**"的东西。
> 塞进去会**污染 stdout 上那份"机器人的原话"**。
> 分开之后，`duckctl … > reply.json` 仍然干净，而 JSON 依然原样打印 ——
> **注记是补充，不是替代。**

### 7.3 一条具体的教训

`print_journal` 和 `print_search` 都遵守同一条：**关于日志的一切（空尾巴、被截断、说明句）都走 stderr**。

> **这正是 `duckctl logs robotd | grep panic` 能工作的原因**：
> **管道里不能出现机器人没写过的行。**

而且 `print_search` 的空结果会说 `nothing on the Hub matched.` —— 一个"下一句建议"，
**照样打在 stderr 上**，这样 `| grep flamingo` 不会把它带上。

---

## 8. ⭐ 超时是"什么都不来的间隔"

这是这个工具体验上最讲究的一处。四个常量：

```text
   REPLY_TIMEOUT       15s    本地读一读
   SLOW_REPLY_TIMEOUT  60s    要动机器人网络或让机器人真干活
                              （wifi scan/connect、policy search/fetch、account login）
   UPDATE_IDLE_TIMEOUT = duck_ipc_proto::UPDATE_MAX_SILENCE_SECONDS + 60
   FOLLOW_TIMEOUT      24h    `update watch` 跟着进度跑，直到被打断
```

### 8.1 "空闲"而不是"总时长"

`REPLY_TIMEOUT` 的注释：

> **是空闲而不是总时长，而正是这个区别让一次更新变得可观看。**
>
> 一次 apply 要多久取决于机器人 —— 下载、校验、解包、换链接、hook、健康门 ——
> 所以一个总预算**要么砍掉一次正在工作的更新，要么为一个死掉的机器人干等**。
>
> **但有用的信号已经在来了**：每一条进度通知都是"机器人活着并在干活"的证明，
> 所以**每收到一条就把表重新开始计**。而一个卡住的镜像**仍然会在几秒内失败**。

### 8.2 ⭐ 那个 60 秒余量是从**协议常量推导出来的**

```rust
const UPDATE_IDLE_TIMEOUT: Duration =
    Duration::from_secs(duck_ipc_proto::UPDATE_MAX_SILENCE_SECONDS + 60);
```

注释说明了它为什么不能是这里的一个数字：

> **这个间隔就是 pre-install hook 的上限**，所以它是从 `UPDATE_MAX_SILENCE_SECONDS` 推导来的，不是这里的数。
>
> 那个 hook 会装一个发布需要而板子可能没有的东西 —— ONNX Runtime，
> 以及一块从没装过的板子上**约 100 MB 的 apt**（给 `mediad` 的 GStreamer 栈）。
> **这个预算在那个上限还是两分钟的时候是 180 秒。**
>
> **一个低于那个上限的预算，会把一次正在工作的更新报告成"机器人停止应答"** ——
> 而操作者的下一步就是**去打断一次本来好好的更新**。
>
> （余下的那一分钟，是留给 hook 之后那条回复的。）

> 💡 这就是 `duck-ipc-proto-primer.md` §10 里那个 `UPDATE_MAX_SILENCE_SECONDS = 600` 的**客户端一侧**：
> **服务端执行它，客户端把自己的预算设在它之上，两边读同一个常量所以不可能分歧。**

### 8.3 `LINK_POLL`：为什么还要每 2 秒查一次链路

> **没有它，一条掉掉的连接和一台安静下来的机器人无法区分**：
> 通知流只是停止产出，于是等待跑完它的空闲预算，然后报告一个"停止应答"的机器人。
>
> 在一次 `update apply` 之后，**这是错两次** —— **机器人应答了，而消失的是这条链路** ——
> 而且要说出来得花掉 `UPDATE_IDLE_TIMEOUT`。

### 8.4 每一步都有自己的预算和消息

```rust
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const DISCOVER_TIMEOUT: Duration = Duration::from_secs(20);
const READ_TIMEOUT: Duration = Duration::from_secs(15);
```

> **btleplug 对这三步一个都不限时**，所以没有它们的话，
> 从"找到了机器人"到"发出请求"之间任何一处卡住，都只会打印 `connecting to …` 然后**什么都没有** ——
> **那只说明有东西不对，不说明是什么。**
>
> 连接、发现、第一次读**各自以不同方式失败，也各自想要不同的下一步**，所以每一步都说出是哪一步。

---

## 9. 地址从广播里来

这是 `duckctl` 最有用的一个功能，也是 `btd` 那边一个决定的终点。

### 9.1 三个命令

```bash
duckctl ip                    # 只打印地址
duckctl ssh -- uname -a       # ssh 进去
duckctl scp file :/tmp/       # 拷文件过去
duckctl open                  # 打开那个 WebRTC 控制台页面
```

**它们都不需要先跑 `ip`，也不需要配对。**

### 9.2 为什么不配对也拿得到

因为**机器人的 IPv4 地址就在广播里**（`btd-primer.md` §11.2 讲的四字节）：

> 那个地址是 `btd` 每 5 秒重读一次 `net.status` 之后重新广播的，
> 所以"读广播"等于**同一次调用、带 5 秒延迟** ——
> **却不需要绑定、不需要 PIN，而且大约一秒就够。**
>
> 只有广播没带地址时才回落到连接（`:1532`）——
> 一台**配对过的 Mac 常常不再广播那个服务**。

这一整套的起点是 `btd` 那边的一句话（`btd-primer.md` §11.2）：

> `duckctl scan` **故意不连接任何东西**，这正是它在机器人连不上时该被想起来的原因。
> 而一个列表最常被用来回答的问题就是 **"我该 ssh 到哪"**。

### 9.3 ⭐ 拒绝发生在最便宜的时刻

```rust
// run() 里，在打开无线电之前：
scp_refusal(&paths)?;
```

`scp_refusal` 拒绝两种输入：

```text
   ① 没有任何一个路径以 `:` 开头
        ← 那其实是**本地到本地的复制**，`scp` 会高高兴兴地执行，
          而**机器人在不在场根本没人知道**。
          而 scp 自己的 usage 错误**说不出这条规则**。

   ② 只有一个路径（有源无目标）
```

而它被放在**扫描之前**，理由写在注释里：

> 否则你会为**一台根本不会被碰到的机器人**先花掉 8 秒。

### 9.4 `become_program`：把进程交出去

```rust
fn become_program(program: &str, argv: &[String]) -> Result<...>
```

它做两件事：

1. **先把命令行 echo 到 stderr** —— "地址归你，而且那也是下次要加 flag 时可以直接粘的那一行"
2. 在 unix 上 **`exec` 顶替掉自己的进程**

> 于是终端、提示符、进度条、退出码、断链处理**全归 ssh/scp**，
> **不会留下一个需要单独 Ctrl-C 的父进程** —— 而无线电在之前就已经释放了。

### 9.5 `console_url` 为什么是 `http`

> 因为**机器人的局域网上没有证书**，而一个 `https` 页面里的 `ws://` 会被当成混合内容拦掉。

---

## 10. 版本不一致时它做什么

`warn_about_skew`（`:2077`）—— 这是"**记录但不拒绝**"那条规矩的**客户端一侧**：

```text
   me     = hello 结果里的 api_version
   mine   = proto::API_VERSION
   不一致 → 警告，然后**继续**
```

理由（`:2057-2084`）：

> **BLE 是"一台没有网络的机器人"的传输方式，而 `wifi connect` 正是它上网的唯一途径。**
> **按版本关门，恰好锁掉的就是那条用来修偏斜的命令。**

这正是 `duck-ipc-proto-primer.md` §7 那段"被推翻的设计"的实践面：
**服务端不拒绝，客户端也不拒绝 —— 只把差异说出来。**

---

## 11. `advwatch`：那个测量工具

`duckctl/examples/advwatch.rs`（241 行）是**这个仓库里最好的"测量驱动开发"样本**。

### 11.1 它要回答的问题

> **机器人广播的到达频率到底是多少？**

因为 `duckctl scan` 只扫 8 秒，**要么找到要么找不到** ——
于是**一个广播得很慢的机器人看起来就是一个坏掉的机器人**。
`advwatch` 改成连续监听并打印到达模式，**把"第二次才找到"变成一个数字**。

### 11.2 为什么这个数字值得测

> 它是**区分三种故障的唯一办法**：
> 机器人根本没在广播 / 广播太稀扫不到 / 客户端有问题。
>
> 而且它**把同房间的每个设备一起测了**，所以结论是**决定性的**：
> **一个比它弱 55 dB 的信标被听到的次数是它的十倍** ——
> 说明既不是距离，也不是干扰。

### 11.3 ⭐ 一个必须记的统计陷阱

> 统计的是 **arrivals（到达）而不是 events（事件）**。
> 一次广播接收会同时触发**多个** btleplug 事件
> （`DeviceUpdated` / `ServicesAdvertisement` / `ManufacturerDataAdvertisement`…），
> **按事件计数会把"被听到"的频率高估 3–4 倍。**
>
> 所以用 200 ms 去抖：每个设备每次真实到达只记 1。

### 11.4 它怎么把结论读出来

输出包括：**每设备到达数 + 信号强度**（机器人那一行标 `<-- the robot`）、
**每秒一个字符的时间线**（`#` 有报告、`.` 沉默 —— **8 个连续 `.` 就是一次会失败的 `duckctl` 运行**）、
**间隔直方图**，以及 **≥8 秒的间隔个数**。

而有一个很漂亮的小技巧：

> **最小区间就是广播间隔** —— 两个都到达的连续报告不可能比广播间隔更近。
> 从到达数据里读出来**成本为零**，而**直接问控制器需要在板子上有 root**。

### 11.5 它的成品

设计文档 §3.4 就是这份仪器的报告，而文档里明确写了它的地位：

> `duckctl/examples/advwatch.rs` **就是那次测量**，
> **保留它是因为这个结论只能靠重跑验证。**

| | 120 秒到达 | 平均间隔 | 最坏沉默 | ≥8 秒的沉默 |
|---|---:|---:|---:|---:|
| 默认（内核 1.28 s） | **16** | 7.5 s | 30.8 s | **7** |
| 改成 100–150 ms | **151** | 0.8 s | 3.8 s | **0** |

（完整的故事在 `btd-primer.md` §11.1。）

### 11.6 它为什么住在这里而不是 `btd`

`Cargo.toml` 里那句答案很干脆：

> **它住这里而不是 `btd`，理由和客户端一样：它是一个扫描器，而扫描器跑在笔记本上。**

两层含义：

1. **被测的是 `btleplug` / CoreBluetooth 那一侧**（Mac 上）。
   板子上的 `btd` 用的是 `bluer`/BlueZ —— **它不是被测量的对象**。
2. **它是个 example，而 example 的依赖是 dev-dependency** —— 所以 `btleplug` 永远进不了板上的产物。

---

## 12. 测试

**51 个测试，全在 `main.rs` 里**（`advwatch.rs` 没有测试）。

对一个 CLI 工具来说这个数字不寻常 —— 而它测的不是"命令能跑"，
而是**那些容易搞错、错了又很难看出来的判断**：

```text
   ── 找哪一台机器人 ────────────────────────────────
   a_single_name_answers_to_itself
   either_half_of_a_macos_composite_answers      ← `radxa-zero3 [duck-c51b]` 两半都算
   a_name_matching_two_robots_is_refused_rather_than_guessed   ← ★ 冲突就拒绝，不猜
   a_miss_and_a_collision_are_not_the_same_failure             ← ★ 两种失败不同
   without_a_name_the_first_candidate_still_wins
   a_named_robot_is_waited_for_rather_than_the_first_one_reported
   a_rename_still_selects_the_robot_by_the_name_it_has_now

   ── 环境变量与 flag 的优先级 ──────────────────────
   the_flag_beats_the_environment
   an_empty_value_is_no_default_at_all            ← ★ 空的 --name 仍然压过环境变量

   ── ssh / scp ────────────────────────────────────
   ssh_resolves_its_user_and_passes_the_command_through
   scp_points_colon_paths_at_the_robot_and_leaves_the_rest_alone
   scp_refuses_a_copy_the_robot_has_nothing_to_do_with        ← ★ 第 9.3 节
   a_robot_with_no_network_is_told_how_to_get_one

   ── 地址 ─────────────────────────────────────────
   a_robot_broadcasts_where_it_is
   no_wifi_and_no_field_read_differently          ← ★ 第 11.2 节的三种情况
   only_a_robot_is_read_for_an_address

   ── 超时（这些是规格，不只是配置）──────────────────
   reading_a_journal_gets_the_slow_budget
   the_hub_commands_wait_as_long_as_they_need
   an_update_is_given_the_longest_silence
   the_link_is_checked_lot_before_a_wait_gives_up ← 第 8.3 节

   ── 注记 ─────────────────────────────────────────
   a_servo_reboot_says_the_robot_is_limp          ← ★ limp_note
   a_restart_is_announced_only_when_the_release_changed        ← ★ restart_note
   a_login_note_carries_the_code_without_opening_anything      ← ★ account_note
   a_drop_during_an_apply_points_at_the_record
```

> 注意最后那几组：**"超时"和"注记"都被测试钉住了** ——
> 也就是说在这个工具里，**"它说什么、等多久"是规格的一部分，不是实现细节。**

---

## 13. 阅读路线

**第 1 步 —— 建立直觉（30 分钟）**

1. 读 `main.rs` 的模块头（前 40 行）。
2. 读 [`robot/duckctl.md`](robot/duckctl.md) 的开头（前 20 行）—— 操作者视角。
3. 读 `Cargo.toml` —— "**客户端那一半，而且它跑在离机器人很远的地方**"那段。

**第 2 步 —— 常量（30 分钟）**

4. 读 `main.rs:55–123` 那 14 个常量。**每一个都有一段理由**，而且是这个工具最有价值的部分之一。

**第 3 步 —— 骨架（1 小时）**

5. 读 `run()`（`:1362`）—— 第 6 节那张时序图。
6. 读 `request_line`（`:2107`）—— 命令 → 请求 + **该等多久**。
7. 读 `Target`（`:263`）和 `choose`（`:379`）。

**第 4 步 —— 输出（40 分钟）**

8. 读 `:1777` 附近（回复怎么打出去）和三个 `*_note`（`:2466` / `:2514` / `:2524`）—— 第 7 节。
9. 读 `print_journal`（`:1851`）—— 为什么诊断走 stderr。

**第 5 步 —— 动手**

```bash
cargo test -p duckctl             # 51 个测试，不需要蓝牙

cargo run -p duckctl -- scan
cargo run -p duckctl -- --help
```

> ⚠️ 第一稿读代码时我以为 `duckctl` 是 `btd` 的一个 example（有几份文档就是这么写的）。
> **现在不是了** —— 它是一个独立的 crate，有自己的 binary，`advwatch` 才是它的 example。
> 见文末"两处过时说法"。

---

## 14. 术语表

| 术语 | 意思 |
|---|---|
| **central / peripheral** | BLE 的两个角色：central（笔记本 / 手机）主动连，peripheral（机器人）被连 |
| **广播 / advertisement** | peripheral 周期性喊"我在这里"。**连接之前唯一的信息来源** |
| **扫描 / scan** | central 听广播的过程 |
| **配对 / 绑定** | 建立加密链路 / 把密钥存下来 |
| **bond** | 绑定过的设备。**配对过的 Mac 常常不再广播服务列表** —— 这是第 5.1 节的由来 |
| **GATT / 特征 / 服务** | BLE 组织数据的模型。见 `duck-ble-primer.md` |
| **MTU** | 一次能传的最大字节数。这里决定分片大小 |
| **NDJSON** | 一行一个 JSON 对象 |
| **JSON-RPC 通知** | 没有 `id`、不期待回复的消息。**进度就是靠它推的** |
| **`btleplug`** | 跨平台的蓝牙客户端库（macOS/Linux/Windows）。`btd` 用的 `bluer` 是 Linux 专用的 |
| **`bluer`** | 只在 Linux 上跑的 BlueZ 客户端库。`btd` 用它 |
| **CoreBluetooth** | macOS/iOS 的蓝牙栈 |
| **快照 vs 轮询** | "睡一觉再取一次" vs "持续重看直到有东西"。**第 5.2 节那个 bug 就是这两者的区别** |
| **到达 / arrival** | 一次真实的广播接收。**不是 btleplug 的一个事件**（一次到达会触发多个） |
| **去抖 / debounce** | 一段时间内的重复信号只算一次。见第 11.3 节 |
| **RSSI** | 收到的信号强度（dBm）。**是负数，越接近 0 越强** |
| **`--psk-stdin`** | 从标准输入读 wifi 密码，这样它不会出现在 `ps` 的输出里 |
| **退出码** | 进程结束时给 shell 的数字 |
| **`exec`** | 用另一个程序顶替掉当前进程。**终端、信号、退出码全都交出去** |
| **stdout / stderr** | 标准输出 / 标准错误。**第 7.1 节那条规矩就是它们的区别** |
| **pipe / 管道** | `|`。`duckctl logs robotd \| grep panic` |
| **cross-build / 交叉编译** | 在一台机器上为另一种架构构建。**`duckctl` 永远不参与** |
| **`default-members`** | cargo 默认构建的成员列表。**把 `duckctl` 排除在外，就是它不上板子的机制** |
| **dev-dependency** | 只给测试和示例用的依赖，不进发布产物 |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| 每条命令做什么（操作者手册） | [`robot/duckctl.md`](robot/duckctl.md) |
| 手机 App 的契约（`duckctl.md` 是它的功能规格） | [`design/mobile-app.md`](design/mobile-app.md) |
| 它对面那一半：蓝牙门房（姊妹篇） | [`btd-primer.md`](btd-primer.md) |
| BLE 的线上契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| 每条方法归谁、占多久（姊妹篇） | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| 在板子上用的那个工具 | [`robot/cheatsheet.md`](robot/cheatsheet.md) |
| 广播间隔那件事的完整实测 | [`design/app-path-design.md`](design/app-path-design.md) §3.4 |
| 配置文件的 schema（姊妹篇） | [`robotd-params-primer.md`](robotd-params-primer.md) |
| 控制循环本身（姊妹篇） | [`robotd-primer.md`](robotd-primer.md) |
| wifi、身份、手柄配对（姊妹篇） | [`configd-primer.md`](configd-primer.md) |
| 控制核心：从读总线到写总线（姊妹篇） | [`duck-control-primer.md`](duck-control-primer.md) |
| 摄像头里的鸭子检测（姊妹篇） | [`duck-detect-primer.md`](duck-detect-primer.md) |
| 仿真的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| 发布怎么把自己装到板子上（姊妹篇） | [`hooks-primer.md`](hooks-primer.md) |
| 板子被配置成什么样子（姊妹篇） | [`deploy-primer.md`](deploy-primer.md) |
| `monitor` 的 ToF 点云视图背后的几何（姊妹篇） | [`kinematics-primer.md`](kinematics-primer.md) |
| 那台服务页面的机器人和它的摄像头（姊妹篇） | [`mediad-primer.md`](mediad-primer.md) |
| `monitor` 的路径地图画的是什么（姊妹篇） | [`odometry-primer.md`](odometry-primer.md) |
| `monitor` 里那个线框手柄画的是什么（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| `monitor` 那个手柄面板的数据源（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| 摸头检测：麦克风、log-mel、那个门控（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| **跑在机器人上**的那一个（姊妹篇，别搞混） | [`robotctl-primer.md`](robotctl-primer.md) |
| 装机、更新、诊断的那些工具（姊妹篇） | [`scripts-primer.md`](scripts-primer.md) |
| 鸭子的嗓子：可播种的合成器（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 头部的两个传感器：深度与 IMU（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
