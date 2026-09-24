# `duck-ipc-proto` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> IPC 契约的机制由 [`design/architecture.md`](design/architecture.md) §2 拥有（英文）。
> 两者若有不一致，以设计文档为准（见根目录 `CLAUDE.md`）—— 不过本文 §11 记录了一处**它们确实不一致**的地方。
>
> 姊妹篇：另外七份导读。**这一份是它们的公共底层** —— 前面每一份里出现的"JSON-RPC 2.0"、"NDJSON"、
> "`robot.state`"、"`update.*`"，定义的都在这里。

## 目录

1. [一分钟版](#1-一分钟版)
2. [一个定义，多种传输](#2-一个定义多种传输)
3. [为什么是 JSON-RPC + unix socket](#3-为什么是-json-rpc--unix-socket)
4. [文件导览](#4-文件导览)
5. [一条消息长什么样](#5-一条消息长什么样)
6. [`Call`：方法与参数永远成对](#6-call方法与参数永远成对)
7. [⭐ 版本策略：一个被推翻的设计](#7--版本策略一个被推翻的设计)
8. [三个问题，三个答案](#8-三个问题三个答案)
9. [状态流出去了什么](#9-状态流出去了什么)
10. [健康那一族](#10-健康那一族)
11. [⚠️ 和 `architecture.md` 的一处不一致](#11-️-和-architecturemd-的一处不一致)
12. [`ChoraleBeacon`：唯一不是 JSON 的线上契约](#12-choralebeacon唯一不是-json-的线上契约)
13. [那套"启动身份"机制](#13-那套启动身份机制)
14. [测试](#14-测试)
15. [阅读路线](#15-阅读路线)
16. [术语表](#16-术语表)

---

## 1. 一分钟版

`duck-ipc-proto` 是**机器人的线上契约** —— 所有服务与客户端之间说话用的类型。

```text
   robotd · configd · updaterd · btd · padd · tofd · mediad
        │
        │  全部都 `use duck_ipc_proto as proto;`
        ▼
   ┌──────────────────────────────────────────────────────────┐
   │  duck-ipc-proto                                          │
   │    "说什么" —— 方法名、参数、返回值的形状                  │
   │    "怎么打包" —— JSON-RPC 2.0，一行一个 JSON（NDJSON）     │
   │    "谁能问" —— 每个方法归哪个服务、占多久、会不会改东西     │
   └──────────────────────────────────────────────────────────┘
        ▲
        │  16 个 crate 依赖它
        │
   robotctl · duckctl · duck-control · duck-ether · robotd-params · odometry · pad-imu …
```

**它是被依赖最多的 crate 之一** —— 整个 workspace 里 **16 个 crate** 依赖它。

规模：**6436 行，一个文件**，**51 个测试**。

### 1.1 一条必须守住的规矩

`Cargo.toml` 里写着：

> **刻意做到几乎零依赖。** 每个服务和客户端都说这些类型，所以**加在这里的任何东西都加给了它们全部** ——
> 包括 `btd`，而它必须保持小，因为**它在恢复路径上**。
>
> 具体地说：**没有 http、没有 tar、没有 crypto、没有 tokio。**
> 如果一个类型需要其中之一，它属于拥有那个行为的 crate，不属于这里。

实际依赖只有四个：`serde`、`serde_json`、`semver`，以及 `libc`（为了 `clock`）。

---

## 2. 一个定义，多种传输

这是设计文档 §4.1 的图，也是**为什么要有一个独立的 proto crate** 的答案：

```text
        ┌──────── 一份 API 定义（共享的 crate：类型 + 操作）
        │
   ┌────┴─────┬────────────┬──────────────┬────────────────┐
  BLE       unix socket   WebSocket     WebRTC datachannel
 (btd)      robotctl,     server-side   telepresence,
  子集       on-robot SDK  agents/LLM    full fidelity
```

**每个传输都只是同一份 API 上的一层薄适配器。**

而 `btd` 暴露的是**子集**（配网、状态、触发更新、进度）—— 因为 BLE 对这个完整表面来说太慢、太受限。

> 💡 这正是 `btd-primer.md` §7 那张"允许清单"存在的理由：
> **哪些方法能走 BLE，是一个传输层的决定，不是协议层的决定。**

---

## 3. 为什么是 JSON-RPC + unix socket

设计文档 §2.2 把这件事量过了 —— 一张**实测依赖数**的表（ARM-Linux 目标，只算独占依赖）：

| 方案 | 依赖数 | 为什么不 |
|---|---:|---|
| **JSON-RPC/NDJSON + tokio** | **30** | **选它** |
| `jsonrpsee-types`（只用类型，传输自己写） | 36 | 合理；放弃 —— 用冻结的规范代码换一个 `0.x` 依赖 |
| `varlink` | 24 | 精神上接近；但更不熟悉，相比 JSON-RPC 没什么收获 |
| `zbus`（D-Bus，p2p） | 66 | 见下 |
| `axum` over UDS | 66 | 可行；见下 |
| `tarpc` | 71 | Rust↔Rust 很舒服，但不可读，而且服务端推送很别扭 |
| `tonic`（gRPC） | 81 | `.proto` + 代码生成，就为了几个方法 |
| `jsonrpsee-server` | 112 | **它不能服务 unix socket** |

### 3.1 为什么是 unix socket 而不是 localhost 端口

这一条**比省依赖重要得多**：

**一、文件系统权限是免费的授权。** 一个 0660 的 socket + 一个专用组，只有被允许的进程够得着。
而一个 TCP 端口**机器上每个进程、每个用户都够得着** —— 想要追平，就得自己造一层认证。

**二、`SO_PEERCRED`** 给出调用者的 uid/gid/pid，**既用于审计日志**（"谁触发的这次回滚"是 support 第一个问的）
**又用于强制**。

**三、⭐「绑错接口」这一整类 bug 不再存在。**

> 因为一个笔误、一个配置、或者一个"让它从我的笔记本也能用"的补丁而绑到 `0.0.0.0`，
> **会把*固件更新控制*暴露到网络上**。而在 unix socket 上，**这个错误是不可表示的**。
>
> 设计文档说这是**权重最高**的一条 —— **不是今天的威胁模型，而是那个失败模式**。

### 3.2 为什么不是 HTTP/WebSocket

> 协议需要**服务端→客户端推送**（进度）。在 HTTP 上那意味着 POST 发调用 **+** WebSocket/SSE 收通知 ——
> **两套机制**，而且 `curl` 消费不了流式的那一半。
>
> 全部走 WebSocket 能恢复成一套机制，但**为了到达"带帧的 JSON"要先加一次握手**，`curl` 又没了。
>
> 在一条常驻的 NDJSON 连接上，调用和通知**就是一套机制、没有握手** ——
> **概念更少，而那才是真正的目标。**

### 3.3 为什么不是 D-Bus

> 消息类型还必须能走 **BLE 和 WebRTC/WebSocket**，那里**朴素的 serde 结构体能用，而 D-Bus 类型不能**。
> 「一个定义、多种传输」才是目标，而 **JSON 是让它免费的那个东西**。
>
> 我们只在操作系统要求的地方用 D-Bus（BlueZ、NetworkManager）。

---

## 4. 文件导览

**只有一个文件，6436 行。** 它的分区（左边是行号）：

| 行号 | 内容 |
|---:|---|
| 1–395 | 模块头 + `API_VERSION` 的**完整版本策略**（很长，值得整段读） |
| 396–511 | 常量 + `socket` 路径 + `JOINT_NAMES` |
| 512–878 | `method` 模块 —— 所有方法名的字符串常量 |
| 879–920 | `code` 模块 —— 错误码 |
| 921–1126 | `Id` / `Call` / `Service` / `Lane` |
| **1127–1621** | **`impl Call`：`method()` / `is_mutating()` / `destination()`** |
| 1622–1800 | `test_support` —— 共享的测试夹具 |
| 1801–2016 | `Request` / `Response` / `Error` |
| 2017–3010 | 各命名空间的参数与结果类型 |
| 3057–3341 | `update.*` 那一族 |
| 3342–3730 | 健康族 + `IntentResult` + `RobotState` |
| 3730–4974 | 其余领域类型 + **`ChoraleBeacon`** |
| 4975–5246 | `BuildInfo` / `Identity` / `clock` |
| 5247–6436 | 测试（51 个） |

**建议的阅读顺序：** 模块头 → `API_VERSION` 的文档 → `Call` + `impl Call` 的三个函数 → `Request`/`Response` → `RobotState` → 其余按需。

---

## 5. 一条消息长什么样

**线上格式：JSON-RPC 2.0，一行一个 JSON 对象（NDJSON），走 unix socket。** 帧分隔符就是一个换行。

```text
→ {"jsonrpc":"2.0","id":1,"method":"update.apply","params":{...}}
← {"jsonrpc":"2.0","method":"update.progress","params":{...}}   ← 没有 id = 通知
← {"jsonrpc":"2.0","method":"update.progress","params":{...}}
← {"jsonrpc":"2.0","id":1,"result":{...}}                       ← 有 id = 回复
```

### 5.1 `Id`：两种身份

```rust
#[serde(untagged)]
pub enum Id { Number(u64), Text(String) }
```

`untagged` 意味着线上就是一个裸数字或裸字符串，没有包装。

### 5.2 `Request`：四个字段

```rust
pub struct Request {
    pub jsonrpc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,          // ← **通知就是没有这个字段**
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}
```

**`id` 有没有，就是 JSON-RPC 里"请求"和"通知"的全部区别。** 而这一条恰好是这个系统最需要的区分：

> [`Request::notify`] 是这个意思：调用作为通知发出 —— **没有 `id`，所以不期待回复**。
>
> **连续意图就是这样走的。** 50 Hz 下每条消息一个回复是纯粹的开销，
> 而且**对一个 20 ms 后就被取代的速度来说，没有任何有用的话可说**。
>
> 离散意图用 [`Request::call`]，因为**"被拒绝了，原因如下"是调用者需要的答案**。

对应到 `robotd`：

```text
   robot.move / robot.head / robot.pose / robot.mouth   →  通知（无 id）
   robot.stop / robot.enable / robot.do / robot.init…    →  请求（有 id）
```

### 5.3 ⭐ 单位与坐标系：写在**类型旁边**，只写一次

这一条值得单独讲，因为它**曾经是一整类 bug 的来源**。

所有这些类型里的数字，约定是：

```text
   角度   →  弧度（不是度）
   速度   →  m/s、rad/s
   坐标系 →  **trunk 系**（躯干坐标系）、右手系
             x 前 · y 左 · z 上
   vyaw   →  正值 = 左转（逆时针）
```

而**为什么这件事值得写在协议里**（注释原话）：

> 原型因为**这个约定从没被写下来**，攒了 `--laser-track-yaw-sign`、`--laser-track-pitch-sign`、
> `--laser-fk-pitch-sign`、`--laser-fk-neck-sign` 和 `--imu-z-rotation-deg` 这些 flag ——
> **每一个消费者自己实测一遍，然后互相不一致**。
>
> **把它写进协议，就删掉了这一整类问题。**

同样的道理也解释了另外两个看起来"多余"的说明：

- **`HeadParams` 是关节空间，不是注视方向** —— 因为手柄和标定产出的是关节角，而策略的观测里带的也是关节角。
- **`LookParams` 里的 `z` 不是"离地高度"** —— 注释特意说明地面在它下面约 0.12 m。

### 5.4 那些**故意不是** `Call` 的方法名

`method` 模块里有几个名字**没有**对应的 `Call` 变体：

```text
   MEDIA_FRAME · ROBOT_STATE · PROGRESS · PAD_REPORT · TOF_FRAME · HEAD_IMU_FRAME
```

这是**刻意的**：它们全部是**服务端单向推送的通知**，而且好几个带着**二进制尾巴**（一帧原始画面约 1.8 MiB）。
**它们绝不能进入 `Service`/`Lane` 路由，也绝不能进入 WebRTC 的 data channel** ——
而"不在 `Call` 里"就是从类型上保证了这件事。

### 5.5 `code`：错误码

```text
   规范保留的：                     应用自己的：
   -32700  PARSE_ERROR              1   BUSY
   -32600  INVALID_REQUEST          2   UNKNOWN_COMPONENT
   -32601  METHOD_NOT_FOUND         3   PROTOCOL_MISMATCH  ← ⚠️ 已退役
   -32602  INVALID_PARAMS           4   PREFLIGHT_FAILED
   -32603  INTERNAL_ERROR           …   
                                   10  ROLLBACK_FAILED     ← "更新失败而且回滚也失败"
                                   11  NOT_INSTALLED
                                   12  WOULD_DOWNGRADE
                                   13  ARCHIVE_TOO_LARGE
                                   14  PERMISSION_DENIED
```

两个注释值得抄下来：

- **`ROLLBACK_FAILED`** 单独分出来，是为了**让 support 一眼看到最严重的那个结果**。
- **`NOT_INSTALLED` 和 `UNKNOWN_COMPONENT` 是两回事**：前者是"这个零件有这个版本吗"，后者是"根本没有这个零件"。

而 `PROTOCOL_MISMATCH = 3` 是个**退役的常量** —— 见第 7 节，它恰好是理解整个版本策略的钥匙。

---

## 6. `Call`：方法与参数永远成对

这是整个 crate 的核心设计：

> **一个方法连同它的参数。**
>
> 每个请求都由其中之一构造、也作为其中之一读回，**所以一个方法永远不可能配上另一个方法的参数**
> —— 那正是这个 crate 存在的意义。**

```rust
let request = proto::Request::call(proto::Id::Number(1), &proto::Call::RobotStop);
//                                                                  ^^^^^^^^^^^^^^^
//                                         方法名和参数**绑在同一个枚举变体里**
let call: Result<proto::Call, proto::Error> = request.as_call();
```

### 6.1 `method` 模块 vs `Call` 枚举

```text
   method::ROBOT_MOVE  = "robot.move"     ← 字符串常量（:512）
   Call::RobotMove(MoveParams)            ← 类型化的形式（:933）

   Call::RobotMove(_) => method::ROBOT_MOVE      ← 两者靠一个穷尽 match 绑在一起（:1129）
```

**为什么两者都要？** 因为**字符串是线上真实存在的东西**：
一个客户端（比如手机 App）可能只知道方法名这个字符串，而服务端需要一个类型化的东西来 `match`。
而那个把它们绑起来的 `method()` 是**穷尽 match** —— 加一个变体就编译失败，直到有人给它一个名字。

### 6.2 未知方法怎么被拒

`Call::parse(method, params)`：不认识的方法名 →

```text
   code::METHOD_NOT_FOUND，**而且消息里带着那个方法名**
```

`params` 里有一个这个版本不认识的成员 →

```text
   code::INVALID_PARAMS，**而且消息里带着那个成员名**
```

> 第二条来自每一个 params 类型上的 `deny_unknown_fields`。
> 而这**正是当年那个握手门控想达到的严格性，只是搬到了一个能区分"变了的调用"和"没变的调用"的地方**。

---

## 7. ⭐ 版本策略：一个被推翻的设计

**这一节是整个 crate 里最值得读的一段**，因为它记录的是一次**有意的反转**。

### 7.1 现在的规则

`API_VERSION`（当前 = **34**）的文档写得非常明确：

> **一次 bump 在哪个方向上都不承诺任何东西。**
> 它不是"除非特别说明否则是增量的"：v5 是增量的、v4 不是，**而这个常量不区分它们**。
> 板上每一个二进制都期望来自同一次发布，而**安装路径就是交付这件事的东西**。
>
> **⭐ 没有任何 daemon 因为这个数字不同而拒绝一个调用。**
>
> `updaterd` 曾经在一个精确的 `!=` 上拒绝 `hello`。**前提是成立的** —— 一次 bump 什么都不承诺 ——
> **但结论推不出来**：真正弄坏一个不匹配的 peer 的，是一个**它够不到的路由**，
> 或者一个**挪了位置的参数形状**，而这两者各自会**在那一个无法服务的调用上、按名字拒绝自己**。
> 一个握手上的门控反而在**所有**调用上触发，包括那些完全能服务的，
> **包括 `update apply` —— 而版本偏差正是靠它结束的。**
>
> 现在这个差异**被报告**（在 `updaterd` 的 journal 里，以及在 `HelloResult::api_version` 里让客户端自己比较），
> **在任何地方都不被拒绝。**

### 7.2 那个退役的常量就是证据

```rust
/// 已退役：没有任何东西再发出它。版本**差异**被记录并服务，
/// 而真正拒绝的是那个确实缺失的路由 —— 见 [`super::API_VERSION`]。
///
/// 这个常量留着、这个数字也不复用，是因为一块跑着 0.5.1 或更早的 `updaterd` 的板子
/// **仍然会用 `hello` 回答它**，而 `robotctl` 仍然把它映射成一个退出码。
/// 删掉它会让那块板子的拒绝读起来像一个泛泛的失败。
pub const PROTOCOL_MISMATCH: i32 = 3;
```

> **代码不只是"不按版本拒绝" —— 它有一个专门为此退役的错误码，还留着做向后兼容。**

### 7.3 那它承诺什么

| 情况 | 结果 |
|---|---|
| 版本号不同 | **记录，然后照常服务** |
| 这个方法这个版本没有 | `METHOD_NOT_FOUND`，**点名方法** |
| 参数里有个不认识的成员 | `INVALID_PARAMS`，**点名成员** |

而设计意图写在这里：

> 两者本来就是想要的，**与门控无关**：v7 加了 `ApplyOptions::from_dir`，
> 而一个只是**忽略**它的旧 `updaterd`，会**从它配置的来源安装，而操作者以为自己在旁加载一个目录**。
> **沉默才是那里的危险，不是分歧。**

### 7.4 这条规矩已经上升到仓库级

根目录的 `CLAUDE.md`（= `AGENTS.md`）专门有一节：

> ## Never design around a version difference
>
> One user, one robot. An old component's limits are a question to raise, not something to route around —
> bump `API_VERSION` and name the install consequence. **A version skew is logged and served, never refused**;
> only a genuinely missing route or an unknown parameter may refuse.

---

## 8. 三个问题，三个答案

阅读 `impl Call`（`:1127`）时，最重要的是认出**它其实在回答三个不同的问题**：

```text
   ┌──────────────────────────────────────────────────────────────┐
   │  method()      : &'static str         "它叫什么？"           │
   │  destination() : Option<(Service, Lane)>  "归谁管？占多久？" │
   │  is_mutating() : bool                 "它会改变东西吗？"     │
   └──────────────────────────────────────────────────────────────┘
```

### 8.1 `Service`：五个服务

```rust
pub enum Service {
    Updater,   // updaterd
    Robot,     // robotd —— 控制循环
    Config,    // configd —— wifi、身份、配对 PIN、手柄绑定
    Pad,       // padd   —— 原始手柄输入流
    Tof,       // tofd   —— 深度流
}
```

### 8.2 `Lane`：为什么"占多久"是一个字段

```text
   Prompt      一次查询那么久
   Slow        几秒：一次走网络或扫无线电的读
   Operation   想多久就多久，**而且它改变机器人**
   Stream      永远不回答
```

注释解释了为什么这件事必须被回答：

> **这里每一个服务都是"一条连接一次只服务一个请求"。**
> 所以每服务一条连接会让每个调用都排在**那条队列上最慢的东西**后面，而客户端最先会写的两个顺序都被它弄坏了：
>
> - `update.apply` 然后 `update.status` —— status 那行会等在一条 `updaterd` **几分钟都不会读**的 socket 里，
>   于是客户端**什么都没听到就超时了**，而机器人好好的。
> - `update.subscribe` 然后 `update.apply` —— **更糟。** 订阅会一直占着它的连接直到对端消失、从不读下一个请求，
>   所以那个 apply 被写进了一条**没人读**的 socket：**它不会运行、不会回复、也不会报错。**
>   一个机主要求的、而机器人**静默地没有执行**的更新。

> 每服务最多四把 socket、每个会话，**不花任何代价而且不需要记账** ——
> 而替代方案"每个调用一条连接"需要适配器知道一个调用什么时候结束，**那需要它解析回复。它刻意从不这样做。**

### 8.3 `destination()` 为什么住在**这里**

我一开始以为这个函数应该在 `btd` 里（毕竟"哪些方法能走 BLE"是传输层的事）。
它住在 proto 里，而 `btd` 的 `route.rs` 只回答**另一**半问题。这个分工是刻意的：

```text
   duck-ipc-proto        「这个调用**本质上**归谁管、占多久」
                          ← 所有传输共享的知识（WebRTC 那边也要）
   btd/src/route.rs      「**BLE 上**准不准」
                          ← 只有 btd 关心的知识
```

**为什么"归谁管"是共享的？** 因为**每一个传输适配器都要问这个问题**。
如果它住在 `btd` 里，那么 `mediad` 的 WebRTC 网关就得自己再写一份 —— 而那正是"六处写法漂移成六个方向"的配方。

**为什么它返回 `Option`？** 因为有些方法**不属于任何服务**。有**两处**：

```rust
Call::SystemAuthenticate(_) => return None,
//  ↑ PIN 校验属于**传输层**，不属于任何服务：
//    BLE 表达不了印在机器人上的固定 passkey，所以校验上移一层到"我们定义规则的地方"。

// 这两个从不拨号：它们搭着 chorale.subscribe 已经开的那条连接走
//（信标下行、听到的上行）。
Call::ChoraleBeaconSet(_) | Call::ChoraleHeard(_) => return None,
```

> ⚠️ **读那个测试时要注意**：`only_authenticate_has_no_service` 的文档说
> "**第二处 `None` 出现就意味着一个没人能服务的调用**" ——
> 但代码里**已经有第二处**了（上面那两只合唱方法）。
>
> 它现在仍然通过，只是因为那两只**不在 `every_call()` 那份夹具列表里**
> （见 §14.3 —— 那份列表目前比 `Call` 枚举少六个变体）。
> 所以这句话读的时候要理解成"**除了这两处刻意为之的**"，
> 而不是字面上的"只有一个 `None`"。

### 8.4 `is_mutating()`：谁会改变东西

判定权限时**只读调用完全跳过第二层**，所以"哪些是 mutating"必须是一个**明确列出来的清单**：

```text
   update.* 里的写操作（apply / rollback / resetToGolden / select / pin）
   net.connect · net.forget            ← "加入一个网络不是一次读"
   system.setName · system.reboot · system.setPairingPin
   robot.shutdown                      ← "关机至少和重启一样有破坏性"
   pad.pair · pad.forget               ← "一个配好的手柄能启用策略"
   policy.install · policy.fetch       ← "替换策略集改变的是驱动十五个舵机的东西"
   detector.install
```

> 注释里每一条都有理由。而 `pad.status`、`policy.check`、`robot.health` 这些**读**都**保持不设防**。

有测试钉住：`only_software_changing_calls_are_mutating`。

---

## 9. 状态流出去了什么

`RobotState`（`:3636`）是 `robot.subscribe` 推给客户端的那一帧。

```text
   RobotState {
       t             从循环启动算起的秒数
       t_ns          CLOCK_MONOTONIC 纳秒 ← **和别的流共享的时钟**
       movement      requested / applied / limited_by
       head          实际用的头部指令
       policy        这一拍是哪个网络在驱动
       safety        fallen / limp / gravity / gain
       control_loop  hz / missed
       joints        15 个实测角度
       targets       15 个目标角度
       odom          position / yaw
       theremin      （有才在）
       chorale       （有才在）
       imu           gyro / quat
       frames        camera / tof / head_imu 的位姿
       skeleton      整个骨架的位姿
   }
```

### 9.1 ⭐ `MoveState`：报告**被拒绝**的东西

```rust
pub struct MoveState {
    pub requested: [f64; 3],     // 客户端要的
    pub applied:   [f64; 3],     // 实际用的
    pub limited_by: Vec<String>, // **为什么不一样**
}
```

这是设计文档 §3.2 的原话：

> **它必须报告*被拒绝*了什么，而不只是发生了什么** ——
> 一个遥控界面显示着摇杆推到底、机器人却不动、**而且没有任何解释**，那是没法用的。
> **而安全层一直在夹取东西。**

而 `limited_by` 里的名字是**拼出来给线路用的**，不是从 Rust 枚举 `Debug` 出来的 ——
所以重命名一个变体**不会悄悄破坏一个正在 `match` 这个字符串的客户端**。

有一个测试叫 `an_unlimited_command_omits_limited_by`：**没被限制的时候，这个字段根本不出现**（不是空数组）。

### 9.2 `t` 和 `t_ns` 为什么是两个

| | 是什么 | 谁的时钟 |
|---|---|---|
| `t` | 从循环启动算起的秒数 | **`robotd` 自己的** |
| `t_ns` | `CLOCK_MONOTONIC` 纳秒 | **全系统共享的** |

`t_ns` 的存在，是为了**让这一帧能和 `tof.frame` 对齐** —— 一个映射器需要一个**两条流共用的时钟**。
而 `t` 留着，是因为**一个只有这一条流的读者，仍想要一个从零开始的数字**。

### 9.3 关于"人在回路外"的一条规矩

注意 `safety` 里有 `fallen` 和 `limp`**两个**字段：

```text
   fallen   投影重力说的"它是不是倒了"     ← **一个报告**
   limp     "机器人现在真的在 limp 增益上"  ← **一个状态**
```

> `robotd-primer.md` §5 讲过：**摔倒判定不门控任何东西**。
> 所以"倒了"和"变软了"必须分开报 —— 否则客户端无法区分
> "它躺在地上但还在被策略驱动"和"它躺在地上、而且我们把它放松了"。

而 `SafetyState::gravity` 的存在也是同一个道理：**只看判决是没法诊断的** ——
"机器人倒了"和"IMU 装得和这个 build 假设的不一样"**产生同样的 `fallen`**。
把投影重力本身发出来，才能区分这两者。

### 9.4 ⭐ `enable` 的 `toggle`：**信念归机器人**

```rust
pub struct EnableParams {
    pub on: bool,
    /// 翻转当前状态，而不是设置它。
    pub toggle: bool,
}
```

这是新手最容易觉得"多余"的一个字段。它的理由值得完整读：

> 手柄的 Start 用的是它。**一个自己持有 on/off 信念的客户端会漂移** ——
> 因为 `robot.relax`、关机流程、或者任意一侧重启，都会改变那个状态而客户端不知道。
> **而一个陈旧的信念会让 Start 每隔一次就按不动。**

**这是这套 API 里反复出现的一个模式：**

| 别处 | 同样的做法 |
|---|---|
| `robot.setSkill` / `robot.loadPolicy` | 未知的名字**回来成一个"列出已知东西的拒绝"**，不是一个无解释的解析错误 |
| `robot.setMode` | 未知模式 → 拒绝并列出 `"walk"` / `"roller"` |
| **`robot.enable`** | **状态的所有权在机器人，不在客户端** |

**共同点**：**凡是客户端"记着"就可能记错的东西，都让机器人来回答。**

---

## 10. 健康那一族

```text
   HealthResult {
       healthy: bool,      ┐  ★ 只有这两个能进入更新系统的判决
       degraded: bool,     ┘
       reason: Option<String>,
       ── 以下全部是**描述**，任何自动决策都不许读 ──
       battery · motors · cpu_temp_c · cpu_throttle
       control_loop · bus · imu
   }
```

> **`robotd-primer.md` §6.3 讲过这条规矩**，这里是它的**类型定义**：
> 判决和描述**混在同一个响应里**（因为问题只问一次），
> 但**只有前两个字段能影响回滚**。

几个细节：

- **`Battery` 同时带 `volts` 和 `percent`** —— 因为映射（6.6 V 空 / 8.2 V 满）在这里就算好了，
  **一个画电量条的客户端不该需要知道这台机器人配的是哪块电池**。
- **`ImuHealth` 有两个计数**：`stale_blocks`（累计）和 `consecutive_stale_blocks`（当前连续）。
  两个数回答两个问题：**整轮运行重复了多少次** vs **此刻姿态是不是冻住了**。
- **`CpuThrottle`** 同时给时钟上限和降频档位 —— 因为"温度"单独说不了"这块板子已经残了"。

**`ComponentStatus::healthy` 有一个"四值陷阱"** —— 它是 `Option<bool>`，而**四种不同的判决都答 `Some(false)`**，
其中包含 **`degraded`，而健康门是故意让 degraded 通过的**。所以：

> **这个布尔单独给人看就是错的** —— 它必须配上 `degraded` 和 `reason` 一起看。
> 而 `reason` 还承载着两个布尔分不开的情况：
> **`robotd` 完全没回答** vs **答了但形状解析不了**（而后者其实很可能没事）。

### 10.1 ⭐ 向后兼容的**代价**：一次真实的回滚

这一节是**整个文件里最贵的一课**，注释直接写在了 `ImuHealth` 上。

**发生了什么：** `consecutive_stale_blocks` 这个字段发布之后，一块板子上**一个更老的 branch 发来的 `imu` 段缺这个字段**，
于是常驻的 `updaterd` **解析整条 reply 失败** → health 塌成 `Unreachable` →
**健康门从一个"socket 在服务、循环跑 50 Hz"的机器人上回滚了一个 release**。

查了一小时 —— 因为日志里那句 `not healthy within 30s: unreachable`
**没有一个字指向那个缺失的 JSON 字段**。

**得到的结论（写进了类型设计）：**

> struct 级的 `#[serde(default)]` **只在"每个零都是诚实的"时候才安全**。
>
> 所以**带测量的那些兄弟明确不这么做** ——
> `Battery` 默认一个 `percent: 0.0` 会**把满电渲染成没电**。

这句话解释了几个测试为什么存在：

```text
   health_without_the_degraded_field_is_not_degraded      ← 这个 default 是安全的（false 就是诚实）
   an_imu_section_missing_its_newest_field_still_parses
   a_state_frame_missing_odom_still_parses                ← odom 全零 = "像没动过"，诚实
   a_bus_section_missing_a_counter_still_parses
   a_missing_battery_is_unknown_not_empty                 ← ★ **这个 default 会撒谎，所以没有**
```

而最后一条正是那句话的直接体现：

> **"没有电池读数"和"电池是空的"是两回事** —— 前者是 `None`，后者是 `Some(0.0 V)`。
> 混淆它们会在任何人那台启动不到一秒的机器人前面弹出一个"电量耗尽"的警告。

**同一个思路在别处也出现**：`achieved_hz` 是 `Option`，因为 **`0 Hz` 描述的是一个停住的循环 —— 给每个机器人开机第一秒打这个是*说谎***。

---

## 11. ⚠️ 和 `architecture.md` 的一处不一致

第 7 节讲了现在的版本策略：**版本不同只记录，不拒绝**。

而 `docs/design/architecture.md` §4.2「Cross-cutting rules」里写着：

> - **API version handshake.** SDK and daemon versions *will* skew. One integer,
>   **refuse with a clear message on mismatch** (same approach as `model_api`).

**这两者不能同时为真。** 而 §4.2 正好是**拥有 IPC 契约那一页**的横切规则。

我核实了三处和它们的日期：

| 哪里 | 说什么 | 时间 |
|---|---|---|
| `duck-ipc-proto/src/lib.rs` 的 `API_VERSION` 文档 | **不拒绝** | `28298be` · **2026-08-19** |
| `docs/design/app-path-design.md` §3 | "**for saying so, not for refusing**" | 同一次提交改的 |
| `CLAUDE.md` / `AGENTS.md` | "**logged and served, never refused**" | `2dd630a` · 2026-09-14 |
| **`docs/design/architecture.md` §4.2** | **"refuse with a clear message on mismatch"** | `ef9162b` · **2026-08-10** |

而那次反转的提交标题**本身就是那条规矩**：

```text
   28298be  2026-08-19  updaterd: a missing route refuses, a version difference does not
```

它改了 7 个文件 —— 三份设计文档、proto、`robotctl`、`updater` 的实现和测试 ——
**但没有改 `architecture.md`**。`architecture.md` 最后一次被碰是 2026-09-15，改的是别的章节。

> 按 `CLAUDE.md`："**当行为和一份设计文档不一致时，文档才是 bug。**"
> 而按 `docs/README.md` 的归属表，`architecture.md` 正是**拥有这个机制的那一页**。
>
> 顺带一提，这也是 `docs/README.md` 自己警告过的那种失败：
> "**一个写在六处的事实，会朝六个方向漂移**" —— 这里它写在四处，其中一处没跟上。

**我没有改它。** 这一节留在文档里，是因为一个读到 §4.2 然后照着实现"不符就拒绝"的人，
会踩到一个**这个仓库专门写了一条规矩去避免**的坑。

---

## 12. `ChoraleBeacon`：唯一不是 JSON 的线上契约

模块注释里写着：

> **一个线上契约，而且是唯一一个不是 JSON 的。**
> 这个 crate 里其他每条消息都走 socket；**这一条走 BLE 广播**，
> 因为合唱必须在两台**彼此没有网络、也没有共同时钟**的机器人之间工作。

它的线上布局是**手写字节**：

```text
   ┌──────┬───────┬──────┬──────────┬───────────┬────────┬─────────────┐
   │ TAG  │ piece │ beat │ register │ id (u16)  │ 数量   │ roster      │
   │ 0xC0 │       │      │          │ 大端      │        │ (register,  │
   │      │       │      │          │           │        │  id)×n      │
   └──────┴───────┴──────┴──────────┴───────────┴────────┴─────────────┘
     1      1       1       1          2           1        3n
```

### 12.1 `id` 为什么是 16 位 —— 一个真实事故

```rust
/// 决胜与身份，**从 seed 派生而不是 seed 本身**。十六位，而这个宽度是承重的：
/// 这个 id 也是**一只鸭子认出自己信标反射**的方式，也是每只鸭子合并同一个 peer 的多次目击的方式。
///
/// **用一个字节，一个四只鸭子的房间第一天就撞了一对** ——
/// 第四只鸭子撞掉了指挥的那个字节，**大家把两只合并成了一只**，
/// 于是它把指挥的信标当作自己的反射丢掉，**永远加入不了**。
pub id: u16,
```

### 12.2 `roster` 为什么必须在信标里

```rust
/// **这就是阻止两只鸭子唱对方声部的东西。**
///
/// 座次取决于加入顺序，所以**一只根据它碰巧听到的东西给自己排座的鸭子，会和听到不同子集的鸭子不一致**
/// —— 然后两只都唱 alto。
///
/// 指挥维护名册并广播它；其他人对它重放 `seat_all`。
/// **一个真相来源，而这正是指挥的用处。**
pub roster: Vec<(u8, u16)>,
```

### 12.3 四个常量背后的"够用就好"

| 常量 | 值 | 理由 |
|---|---|---|
| `TAG` | `0xC0` | 服务 UUID 已经说了"这是只鸭子"，所以它只需要把**这个载荷**和**另一个广播实例带的 IP 地址字段**分开 —— 否则一个扫描器**会把 `192.168.1.42` 的四个字节听成一拍** |
| `REGISTER_LOW_HZ` / `HIGH_HZ` | 100 / 625 | 括住整个鸭群（`sounds::Personality` 把音高中心夹在 110–620 Hz），**两端都留了余量**，所以最极端的鸭子不会坐在夹取边界上 |
| `MAX_ROSTER` | 4 | 曲子有四个声部。"四只以上"的鸭子**保持聆听**而不是加入 —— 而"一个信标不是描述一个合唱团的地方" |
| 广播预算 | 251 字节 | 一个满编四重奏的名册是 8 字节 |

**`from_bytes` 拒绝任何"形状不对"的载荷，长度也算** —— 而且**更长的载荷是被拒绝的，不是宽松地读**：

> 因为这些信标用的公司 ID 是 `0xFFFF`，SIG 留给测试、**谁都能用**，
> 所以**一个形状不对的载荷是别人的广播，不是我们的一条畸形广播**。
> 而一个**更长**的载荷 —— 一个将来装了更多东西的信标 —— **不是这一个**。

---

## 13. 那套"启动身份"机制

每个 daemon 启动时会往 `/run/<服务>/identity.json` 写一份"我在跑什么"。

```rust
pub fn identity_path(service: &str) -> PathBuf {
    runtime_root().join(service).join("identity.json")
}
```

### 13.1 为什么是"一个服务一个目录"

> 不是"一个共享目录"，因为那正是单元文件里 `RuntimeDirectory=<service>` 给出的东西 ——
> **而它必须是那个，有两个更整洁的布局都活不下来的理由**：
>
> **一、`btd` 和 `padd` 跑在 `ProtectSystem=strict` 下**，所以文件系统对它们**只读**
> —— 除了 systemd 授予的那一点，而 `RuntimeDirectory` 就是那个授予。
>
> **二、systemd 在单元停止时会删掉那个目录**，所以**一个停掉的 daemon 不能留下一份自称在跑的身份**。

### 13.2 `runtime_root()` 为什么要看环境变量

> **不是给机器人用的配置旋钮** —— 板上没有任何东西设置它。
> 它存在，是为了这件事**至少是可测的**，因为**一个测试没法写 `/run`**，
> 而这也是一个手工在笔记本上跑起来的 daemon 能发布身份的原因：那里的 `/run` 也是 root 的，而 macOS 上它根本不存在。

### 13.3 `BuildInfo` 的 `Display`：对"不知道"要坦白

```text
   1.4.2 (rev a1b2c3, built 2026-09-24T10:00:00Z)
   1.4.2 (rev unknown, not a CI build)
```

> 一行、可 grep、**而且对不知道的东西是明确的** ——
> **一份只是缺少 revision 的 support 日志，在"本地构建"和"我们忘了记"之间是有歧义的。**

而 `revision` 是从 **`DUCK_REVISION` 在编译期**读的：**一台发布出去的机器人上没有 git 仓库**。

### 13.4 `build_info!` 为什么是宏

> **是宏而不是函数，因为 `env!` 必须在*调用者*那里展开**：
> 在这里的一个函数里调用它，会给所有人报**这个 crate 的**版本。

---

## 14. 测试

**51 个测试，全部在同一个文件里**（`:5247` 之后）。它们分成几类：

```text
   ── 每个变体都要被覆盖（穷尽性）──────────────────
   every_call_covers_every_variant
   every_call_has_a_distinct_method
   every_call_round_trips_over_the_wire
   a_call_serialises_as_jsonrpc
   component_carrying_calls_expose_it
   notifications_carry_no_id
   responses_omit_the_half_they_do_not_use

   ── 关键字面（这些是线上契约）────────────────────
   robot_state_uses_the_documented_field_names      ← ★
   pad_reports_round_trip_under_their_tag
   robot_results_round_trip

   ── 拒绝的边界 ───────────────────────────────────
   unknown_methods_and_bad_params_get_different_codes
   an_unknown_params_member_is_refused_by_name      ← ★ 每一个 params 类型
   methods_without_params_accept_any_params_field

   ── 优先级与路由 ─────────────────────────────────
   only_software_changing_calls_are_mutating
   only_authenticate_has_no_service
   subscriptions_are_the_only_thing_on_the_stream_lane

   ── 向后兼容 ─────────────────────────────────────
   health_without_the_degraded_field_is_not_degraded
   an_imu_section_missing_its_newest_field_still_parses
   a_state_frame_missing_odom_still_parses
   a_missing_battery_is_unknown_not_empty            ← ★
   degraded_is_omitted_when_false_and_present_when_true

   ── 信标 ─────────────────────────────────────────
   a_beacon_survives_the_advertisement
   a_roster_of_the_wrong_length_is_not_a_beacon
   an_address_payload_is_not_mistaken_for_a_beacon   ← ★ 那条 0xC0 的理由

   ── 身份 ─────────────────────────────────────────
   an_identity_survives_being_published_and_read_back
   a_release_path_names_its_version
   a_dev_release_keeps_the_suffix_that_distinguishes_it
   a_deleted_binary_still_names_its_release
   a_binary_outside_the_layout_has_no_release
   build_info_is_explicit_about_an_unknown_revision
```

### 14.1 `an_unknown_params_member_is_refused_by_name` 的手法

这个测试**遍历 `every_call()`**，给每一条的 params 塞一个 `"from_a_later_release": true`，
然后断言每一条都拒绝**而且消息里点名那个成员**。注释解释了为什么值得这样钉：

> **在所有调用上钉住，而不是指望十四个 `deny_unknown_fields` 属性被记住**，
> 因为**这正是当年 `hello` 握手提供的那个严格性现在所在的地方**。
> **一个没有这个属性的 params 类型会在这里失败。**

### 14.2 `test_support`：共享的夹具

```rust
/// [`Call`] 的每一个变体各一个，**这样一个测试不可能悄悄跳过其中一个**。
///
/// 那些对 [`Call`] 的穷尽 match —— `method`、`destination`、以及每个传输的权限表 ——
/// **正是逼着这个列表保持完整的东西**：一个新增的变体会打断那些构建，
/// 而修它们的人下一步就会来到这里。
pub fn every_call() -> Vec<Call>
```

**为什么它是一个 feature 而不是每个 crate 抄一份？** 因为 `btd`、`updater`、`robotctl` 的测试
**都需要同一批夹具** —— 而"每个 crate 抄一份"就是又一次"六处漂移"的配方。注释里记着账：

> **两份拷贝已经出现过，而且已经漂了 —— 115 行对 82 行**，而第三份正要为 `mediad` 写。

### 14.3 ⚠️ 那份列表目前比枚举少六个

**截至本文写作时**，`Call` 有 **73** 个变体，而 `every_call()` 只列了 **67** 条。缺的是：

```text
   Call::RobotSetMode      Call::RobotTheremin     Call::RobotChorale
   Call::ChoraleSubscribe  Call::ChoraleBeaconSet  Call::ChoraleHeard
```

而 completeness 测试是这样写的：

```rust
assert_eq!(every_call().len(), 67, "a Call variant was added or removed — …");
```

**它比的是一个硬编码的 67，而列表也恰好是 67** —— 所以它通过。

这**恰恰是它旁边那条注释预言过的失效模式**（原话）：

> 它抓得住"列表改了而计数没跟着改" ——
> **而它抓不住"给 `Call` 加了一个变体、两处都没动"**，
> 这正是当年 `pad.input` 从 `every_call` 里消失、而这个测试**在 44 上照样通过**的原因。
>
> 真正抓到它的是**消费端的一个性质测试**：
> `mediad` 的路由表断言"每个服务都有某个被允许的调用能到达"，而 `pad.input` 是唯一到达 `padd` 的那个。
> **所以真正的防线是把这份列表拿去用的那些测试**，而这一对只防得住更便宜的那种错误。

**对读代码的人来说，实践含义是**：读 §14.1 那几组"遍历 `every_call()`"的测试时要知道，
**上面那六个方法（以及它们的 params 类型）不在覆盖范围内**。

---

## 15. 阅读路线

**第 1 步（30 分钟）**

1. 读模块头（`:1`）—— 两个命名空间、线上格式、那个"方法永远配不错参数"的承诺。
2. 读 `API_VERSION` 的**整段文档**（`:396` 往上）—— 第 7 节那个反转。**这是这个文件里最值得读的一段。**
3. 读 [`design/architecture.md`](design/architecture.md) §2.2 —— 为什么是 JSON-RPC + unix socket，带实测的依赖表。

**第 2 步 —— 信封（1 小时）**

4. 读 `Id`（`:921`）、`Call` 枚举的开头（`:933`）。
5. 读 `Request`（`:1801`）和 `Response`（`:1941`）。
6. 读 `code`（`:879`）—— 特别是 `PROTOCOL_MISMATCH` 那条退役注释。

**第 3 步 —— 三个函数（1 小时）**

7. 读 `impl Call` 的 `method()`（`:1129`）—— 看那个穷尽 match。
8. 读 `Service`（`:1085`）和 `Lane`（`:1116`）—— 第 8.2 节。
9. 读 `is_mutating()`（`:1211`）和 `destination()`（`:1268`）—— **注释比代码长，读注释。**

**第 4 步 —— 状态（40 分钟）**

10. 读 `RobotState`（`:3636`）和它的五个子结构。
11. 读 `MoveState` 的 `limited_by` —— 第 9.1 节。
12. 读 `HealthResult`（`:3360`）—— 判决和描述的分界。

**第 5 步 —— 动手**

```bash
cargo test -p duck-ipc-proto        # 51 个测试，不需要任何东西
```

试试亲手构造一条请求，看它在线上长什么样：

```rust
use duck_ipc_proto as proto;

let request = proto::Request::call(proto::Id::Number(1), &proto::Call::RobotStop);
println!("{}", serde_json::to_string(&request).unwrap());
// {"jsonrpc":"2.0","id":1,"method":"robot.stop"}

// 通知：没有 id
let notify = proto::Request::notify(&proto::Call::RobotMove(
    proto::MoveParams { vx: 0.2, vy: 0.0, vyaw: 0.4 },
));
println!("{}", serde_json::to_string(&notify).unwrap());
// {"jsonrpc":"2.0","method":"robot.move","params":{...}}
```

**再试试把方法名和参数配错** —— 你会发现自己**做不到**，因为它们在同一个枚举变体里。这就是这个 crate 的全部意义。

---

## 16. 术语表

| 术语 | 意思 |
|---|---|
| **IPC** | 进程间通信。这里是"机器人上几个 daemon 之间怎么说话" |
| **契约 / contract** | 两端必须完全一致的那部分定义 |
| **JSON-RPC 2.0** | 一种远程调用协议。**通知**（无 id）和**请求**（有 id）两种消息族 |
| **NDJSON** | Newline-Delimited JSON，一行一个 JSON 对象 |
| **帧分隔符** | 用来切分消息的记号。这里**就是换行** |
| **通知 / notification** | 没有 `id`、不期待回复的消息 |
| **信封 / envelope** | 消息的外层结构（jsonrpc/id/method/params），相对于里面的"载荷" |
| **`deny_unknown_fields`** | serde 的开关：出现不认识的字段就报错 |
| **`untagged`** | serde 的属性：枚举在线上就是一个裸值，没有标签 |
| **穷尽 match / exhaustive match** | Rust 要求列出所有分支的 `match`。**加一个变体会编译失败** |
| **`SO_PEERCRED`** | Linux 让你查出 unix socket 对端身份（uid/gid/pid）的机制 |
| **wire format** | "线上格式" —— 真正在字节流里传的东西 |
| **版本偏差 / version skew** | 两个 peer 不是一起构建的 |
| **`API_VERSION`** | 那个版本号。**注意：它不用于拒绝调用** |
| **退役 / retired** | 一个不再发出、但为了兼容旧版本而留着的常量 |
| **lane / 车道** | 按"一个调用占连接多久"分的组，每组一条连接 |
| **mutation / 变更调用** | 会改变机器人状态（而不只是读）的调用 |
| **CLOCK_MONOTONIC** | 单调递增的时钟，不受系统时间调整影响 |
| **CLOCK_REALTIME** | 墙上时钟。会被 NTP 往回拨 |
| **epoch** | 时间的零点。**两个进程的 epoch 可能不同** |
| **newtype** | 用一个单字段结构体包住一个基础类型，为了类型安全 |
| **feature（Cargo）** | 编译期开关。`test-support` 就是这样一个 feature |
| **广告 / advertisement** | BLE 里连接之前唯一的信息来源 |
| **公司 ID / company id** | 广播里给厂商载荷归档的编号。`0xFFFF` 是**留给测试的、谁都能用** |
| **量化 / quantise** | 把连续的值压进少量离散档位（这里：音高 → 一个字节） |
| **roster / 名册** | 合唱里"谁唱哪个声部"的名单 |
| **`RuntimeDirectory=`** | systemd 给一个单元创建的运行时目录。**停止即删** |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| IPC 契约的权威设计（英文） | [`design/architecture.md`](design/architecture.md) §2 · §4 |
| 控制循环（用这套契约最多的那个） | [`robotd-primer.md`](robotd-primer.md) |
| BLE 上的路由表（"哪些方法能走无线电"） | [`btd-primer.md`](btd-primer.md) §7 |
| `robot.state` 那一帧怎么被算出来 | [`duck-control-primer.md`](duck-control-primer.md) §5 |
| 更新那一族方法 | [`design/updater-design.md`](design/updater-design.md) |
| 配置文件的 schema（另一套契约） | [`robotd-params-primer.md`](robotd-params-primer.md) |
| wifi、身份、手柄配对（姊妹篇） | [`configd-primer.md`](configd-primer.md) |
| BLE 的线上契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| 摄像头里的鸭子检测（姊妹篇） | [`duck-detect-primer.md`](duck-detect-primer.md) |
| 仿真的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| 笔记本上的客户端（姊妹篇） | [`duckctl-primer.md`](duckctl-primer.md) |
| 发布怎么把自己装到板子上（姊妹篇） | [`hooks-primer.md`](hooks-primer.md) |
| 板子被配置成什么样子（姊妹篇） | [`deploy-primer.md`](deploy-primer.md) |
| 从笔记本用这套 API | [`robot/duckctl.md`](robot/duckctl.md) |
| `robot.model` / `robot.state` 里那些位姿是谁算的（姊妹篇） | [`kinematics-primer.md`](kinematics-primer.md) |
| 把 `Call` 转发到 unix socket 的那条管道（姊妹篇） | [`mediad-primer.md`](mediad-primer.md) |
| `OdomState` 里那两个数是谁算的（姊妹篇） | [`odometry-primer.md`](odometry-primer.md) |
| `PadImuBatch` 那几个类型的唯一算法消费者（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| intent 最老的那个客户端（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| 摸头检测：麦克风、log-mel、那个门控（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| 那个薄客户端：CLI、monitor、health（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| 装机、更新、诊断的那些工具（姊妹篇） | [`scripts-primer.md`](scripts-primer.md) |
| 鸭子的嗓子：可播种的合成器（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 头部的两个传感器：深度与 IMU（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
