# `btd` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> `btd` 的机制由 [`design/app-path-design.md`](design/app-path-design.md) 拥有（英文，955 行，写得非常好）。
> 本文只做一件事：带你把这个 crate 读一遍。两者若有不一致，以设计文档为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：[`robotd-primer.md`](robotd-primer.md)（控制循环）、[`robotd-params-primer.md`](robotd-params-primer.md)（配置）。

## 目录

1. [一分钟版](#1-一分钟版)
2. [它在系统里的位置](#2-它在系统里的位置)
3. [核心心智模型：一条管道](#3-核心心智模型一条管道)
4. [目录导览](#4-目录导览)
5. [一次请求的完整旅程](#5-一次请求的完整旅程)
6. [GATT 接口：一个特征，两个方向](#6-gatt-接口一个特征两个方向)
7. [路由表就是安全边界](#7-路由表就是安全边界)
8. [会话：一个订阅，一个会话](#8-会话一个订阅一个会话)
9. [Lane：为什么一条上游连接不够](#9-lane为什么一条上游连接不够)
10. [分片与 MTU：小包里的大学问](#10-分片与-mtu小包里的大学问)
11. [广播：机器人怎么被找到](#11-广播机器人怎么被找到)
12. [配对与 PIN](#12-配对与-pin)
13. [合唱：只管无线电](#13-合唱只管无线电)
14. [部署与权限](#14-部署与权限)
15. [测试：不能有无线电](#15-测试不能有无线电)
16. [阅读路线](#16-阅读路线)
17. [术语表](#17-术语表)

---

## 1. 一分钟版

`btd` 是**蓝牙门房**。

手机想跟机器人说话，但它不会 ssh、不知道 IP、也没有网络。它能做的第一件事是**蓝牙扫描**。`btd` 就是那个被扫到的东西：它开一个蓝牙 GATT 服务，让手机连上来，然后把手机说的一句话**原样转达**给机器人内部真正负责那件事的程序。

```text
   手机 ──BLE──▸ btd ──unix socket──▸ robotd / configd / updaterd
```

**它自己不拥有任何东西。** 这是整个设计里最重要的一句话，而且不是"整洁"层面的讲究 —— lib.rs 的原文说：

> 如果 provisioning 或配置住在 BLE 服务里，那么**其他每一个服务都得依赖 `btd`**，
> 而一个 SDK 竟然要**通过蓝牙去设置机器人的名字** —— 这很荒谬。

所以 `btd` 是一个**管道**（pipe）。它收到一条 JSON-RPC 请求，看表决定"这条准不准、归谁管"，然后把**原始字节**转发出去，再把回复切块送回蓝牙。

> 📌 **"逐字节原样转发"** 是关键：`btd` 不解析回复、不改写 `id`、不重新序列化参数、不编造结果。
> 它只解析到能回答两个问题为止 —— **这个方法是允许的吗？归哪个 socket？** —— 然后就把原文转走。
> 这个性质让加一个新协议方法只需要在路由表里加一行。

代码规模：约 4600 行，8 个模块。

---

## 2. 它在系统里的位置

`btd` 是**四个传输层之一**。它的特殊之处在于"没有网络的时候它必须能用"。

```text
   游戏手柄          手机          你，在笔记本上        远端 peer
      │ BLE            │ BLE            │ ssh / duckctl       │ WebRTC
      ▼                ▼                ▼                     ▼
   padd              btd            robotctl               mediad
      │                │                │                     │
      └────────────────┴────────────────┴─────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
           robotd          configd        updaterd
```

三个要点：

**一、`btd` 说的和 `robotctl` 说的**是同一套语言**。** 同一种 JSON-RPC 2.0、同一种 NDJSON（一行一个 JSON），只是换了根线。所以 API 不会因为"给手机用的"而悄悄腐烂 —— 它每天都在被 `robotctl` 用。

**二、`btd` 故意不依赖 `robotd` 或 `updaterd`。** systemd 单元里写着这是必须保持的性质：

> `btd` 必须在机器人不回答的时候还能回答 —— 那正是它存在的大部分理由。

**三、它暴露的是一个子集。** 尤其注意：**`robot.move`（遥控移动）在 BLE 上是被拒绝的。** 手机能做的事和遥控操作能做的事不是一回事（第 7 节）。

---

## 3. 核心心智模型：一条管道

整个 crate 可以画成这一张图。**看懂这张图，就看懂 `btd` 了。**

```text
  手机
   │  ① 写一段字节到 GATT 特征
   ▼
 ┌──────────────────────────────────────────────────────────┐
 │  bluez.rs   把字节从蓝牙收进来 / 把字节发回蓝牙           │
 │             （唯一碰无线电的模块，只在 Linux 上编译）     │
 └────────────────────┬─────────────────────────────────────┘
                      │  ② 通过两条 channel（link.rs）
                      ▼
 ┌──────────────────────────────────────────────────────────┐
 │  session.rs   一个客户端的全部行为                        │
 │                                                          │
 │   ③ 重组：把碎片拼回一行（duck-ble::framing）             │
 │   ④ 认出"这一行是什么调用"（解析 JSON）                   │
 │   ⑤ PIN 闸门：认证过了吗？                                │
 │   ⑥ 查表：route.rs 说准不准 / 归谁 / 占多久               │
 │   ⑦ 原样转发 ────────────────────────────────┐           │
 │                                              │           │
 │   ⑩ 回复 → 切成块 → 写回 channel             │           │
 └──────────────────────────────────────────────┼───────────┘
                                                │
                                                ▼
 ┌──────────────────────────────────────────────────────────┐
 │  upstream.rs   按需连接三个内部 socket                    │
 │                每个 (服务, lane) 一条连接                 │
 └────────────────────┬─────────────────────────────────────┘
                      │  ⑧ 原始 NDJSON 一行
                      ▼
        robotd / configd / updaterd  ← ⑨ 谁拥有答案谁回答
```

**这条管道上没有"理解"。** 第 ⑦ 步转发的就是收到的字节。第 ⑩ 步收到的也是上游的原始字节。`btd` 从头到尾**没有解析过任何一个回复**。

> 设计文档给这个性质算了一笔账：一条连接一个调用（而不是按 lane 复用）会"更整洁"，
> 但那需要 `btd` 知道一个调用什么时候结束 —— 也就需要它解析回复。
> **而它从不解析**，正是这个性质让"被路由的子集"是一个**传输层**，而不是 API 的**第二份实现**。

---

## 4. 目录导览

```text
btd/
├── Cargo.toml                    依赖清单（注释解释了每个非显然的选择）
├── src/
│   ├── lib.rs            40 行   模块声明 + crate 级文档（很值得读）
│   ├── main.rs          189 行   命令行参数、日志、启动
│   ├── bluez.rs        1004 行   ★ 唯一碰无线电的模块（Linux-only）
│   ├── session.rs      1022 行   ★ 一个客户端的全部行为
│   ├── route.rs        1020 行   ★ 路由表 = 安全边界
│   ├── upstream.rs      420 行   三个内部 socket 的连接池
│   ├── chorale.rs       494 行   合唱信标的无线电适配
│   ├── pairing.rs       192 行   配对代理（just-works）
│   └── link.rs          109 行   无线电与可测部分之间的接缝
└── systemd/
    ├── btd.service       93 行   单元文件（注释解释了每条加固的理由）
    └── sysusers.d/btd.conf      创建 btd 用户
```

**建议的阅读顺序：** `lib.rs` → `route.rs` 的表 → `session.rs` → `upstream.rs` → `bluez.rs`。
`bluez.rs` 放最后，因为它是唯一需要懂 BlueZ（Linux 的蓝牙栈）的一份。

### 4.1 为什么 `bluez.rs` 长这样（两个"早就试过别的"）

读 `bluez.rs` 时会冒出两个疑问，答案都在模块头里：

**疑问一：为什么用 BlueZ 的"回调"模型，而不是普通的 IO 模型？**

因为 IO 模型**在真机上不可用**：它对 BlueZ 的 `WriteValue` / `StartNotify` 一律回 `NotSupported` ——
它只服务 `AcquireWrite` / `AcquireNotify` 那条 **文件描述符**路径。结果是**广播、连接、订阅、写入全都被接受，
却没有一条到达这个文件**。看起来一切正常，实际什么都不工作。

回调模型的代价是**没有流控**（BlueZ 不告诉你无线电什么时候跟上了）—— 这正是第 10.4 节那三个补丁存在的原因。

**疑问二：为什么射频出任何问题，这个进程都不退出？**

`serve()`（`:217`）是一个**无限循环**：适配器出问题就 warn 一句、睡 5 秒、再试。
连"开机后 73 秒内 `hci0` 根本不存在"都是一个**正常情况**，而不是一个错误。

> 这样做的收益是：**"进程退出了"这件事才等于"二进制坏了"** —— 而这正是它配得上
> [`updater-design.md`](design/updater-design.md) 那套启动恢复机制（boot recovery net）的资格。
> 一个因为蓝牙偶尔抽风就退出重启的 daemon，会让"启动失败"这个信号失去意义。

这也是 `main.rs` 里那句注释的意思：`serve()` **不应该返回**；它返回了就是它自己的 bug，所以退出码非零。

> 💡 还有一个**不在这个目录里但必须知道**的 crate：`duck-ble/`（552 行）。
> 它装的是"手机和机器人必须**完全一致**"的三个东西 —— UUID、分片规则、广播字段的布局。
> 之所以单独拿出来，是因为**第二份实现只会跟自己一致**：一个自己写分片逻辑的客户端，
> 会一直工作到某天不工作为止，而那个故障看起来像**机器人的问题**。
> `duck-ble` 不碰无线电、没有 async runtime、没有日志 —— 所以它能编进手机、笔记本和板子。

---

## 5. 一次请求的完整旅程

拿一个具体例子走一遍。假设手机问 `robot.health`：

### 5.1 上来先认证

蓝牙连上之后，`btd` **什么都不服务**，直到客户端发 `system.authenticate`。

```text
   手机 → 写 {"jsonrpc":"2.0","id":1,"method":"system.authenticate","params":{"pin":"042042"}}
              │
              ▼
   session.rs 认出这是 system.authenticate
              │
              ├─ 这条不走路由表 —— 它由 btd 自己回答（Route::Local）
              ├─ 向 configd 要当前的 PIN（每次都现取，不缓存）
              ├─ 按字符串比较（"042042" ≠ "42042"）
              │
              ├─ 对了 → 这个会话变成"已认证"，回复 {"authenticated":true}
              └─ 错了 → 剩余次数 -1；用完 3 次 → 关掉会话
```

三个细节都是承重的：

- **PIN 每次都从 `configd` 现取**，所以 `robotctl system set-pin` **下一次尝试就生效**，不用等重启。`configd` 答不上来 → 会话被拒绝，而不是被放行。
- **按字符串比较**。`042042` 和 `42042` 是**不同的秘密**，用数字解析会让它们变成同一个。有一个测试专门钉这件事。
- **三次之后关会话。** 六位 PIN 是一百万种可能，而链路**加密但未认证**，所以限次是唯一让暴力破解变贵的东西 —— 重连要付出一次完整的 BLE 连接和绑定。回复里带 `attempts_remaining`，客户端才能说"还剩两次"。

> ⚠️ 注意：`hello` 是**另一个**允许在认证前调用的方法，因为它只报告版本号 ——
> 而版本号 GATT 的 read 本来就已经告诉未认证的客户端了。

### 5.2 然后才是真正的调用

```text
   ① 手机写入：{"jsonrpc":"2.0","id":2,"method":"robot.health"}   ← 可能是分几块写来的
              │
   ② bluez.rs 收到 WriteValue 事件，把字节喂进 link.inbound
              │
   ③ session.rs 重组：拼到看见 \n 为止  ← 这里有个上界 8 KiB
              │
   ④ 解析成 proto::Call
              │
   ⑤ PIN 闸门：已认证 ✓
              │
   ⑥ route.rs::route_for(call)
              │
              ├─ 允许吗？  → permits(robot.health) == true
              ├─ 归谁？    → Upstream::Robot  (→ /run/robotd.sock)
              └─ 占多久？  → Lane::Prompt     (一次查询那么久)
              │
   ⑦ pool.send(Robot, Prompt, 原始那一行)
              │
   ⑧ 从连接池里取 (Robot, Prompt) 那条连接，把原文写进去
              │
   ⑨ robotd 回答：{"jsonrpc":"2.0","id":2,"result":{...}}
              │
   ⑩ 上游连接上有个读任务（连接建立时 spawn 的），把这一行
      丢进 replies channel
              │
   ⑪ session.rs 的 select! 收到它 → 按当前 MTU 切块 → 写进 link.outbound
              │
   ⑫ bluez.rs 的 notify 泵一块一块发给手机（每 16 块歇一下）
```

**注意第 ⑨ 步：`btd` 没有看那个回复里是什么。** 第 ⑪ 步切块是按**字节**切的，不是按 JSON 结构。它只知道"这是一行要转发的东西"。

> 设计文档里有一句话概括了这个：**"响应和通知对我们来说是同一种东西 —— 一行要转发的行。"**
> 所以 `update.subscribe` 这种流式推送不需要任何特例代码，它和普通回复走完全相同的路。

### 5.3 如果出错

错误分三种来源，**客户端看到的东西不一样**：

| 谁出的错 | 客户端收到 | 为什么 |
|---|---|---|
| `btd` 拒绝了这条调用 | `PERMISSION_DENIED`，**并点名方法** | 方法**存在**，只是这个传输不许用 → 意思是"去用 `robotctl`"，而不是"升级你的 app" |
| 上游没在答应 | `INTERNAL_ERROR` + `"Robot is not answering: ..."` | **点名是哪个服务** —— 有人拿着手机截图来问的时候，这一句就是全部诊断 |
| 上游自己返回的 JSON-RPC 错误 | **原样透传** | `btd` 不解析回复，所以错误码是上游的，不是它的 |

> `PERMISSION_DENIED` 这个选择值得记住。用 `METHOD_NOT_FOUND` 会误导客户端去升级 ——
> 而真正的问题是"你可以读状态，但不可以换固件"。

---

## 6. GATT 接口：一个特征，两个方向

BLE 的 API 单位是 **GATT**（Generic Attribute Profile）：一个**服务**（service）里装着若干**特征**（characteristic），每个特征可以被读、写、订阅。

`btd` 服务的结构**简单到反常** —— **一个服务，一个特征**：

```text
   服务 6f5d2a10-3b47-4c8e-9a1f-2d7e8c4b6019   ← 客户端扫描时找的就是它
     │
     └── 特征 6f5d2a11-3b47-4c8e-9a1f-2d7e8c4b6019
           ├── read     → 读一次拿到机器人的 API 版本号
           ├── write    → 写 NDJSON 请求
           └── notify   → 订阅它，收回复和推送
```

**同一个特征既写又订阅**，这在 BLE 里是完全正常的，但它是**刻意的选择**而不是随手：

> 更常见的形状是**两个**特征（一个写、一个通知）。这个版本最先就是这么写的，然后改成现在这样。
> 原因很具体：**BlueZ 把"一次写入"和"一次订阅"报告成两个独立的事件**，
> 所以两个特征意味着机器人要**按设备地址去猜**写的一半和通知的一半是不是同一个客户端 ——
> 猜一个关联关系。用一个特征，两个事件**从构造上**就属于同一个东西。

代价是：在 nRF Connect 这类通用蓝牙浏览器里，同一行既是写又是通知，**看起来有点怪**。设计文档明说了这个代价。

### 为什么版本号是一次 read

那个 read **不是可选的装饰**，而且它承担两个职责：

1. **它是"必须先配对"的强制手段。** 这个 read 需要加密链路（`encrypt_read`），而**订阅不需要**。所以如果没有这个 read，客户端会：订阅成功 → 第一次写入被静默拒绝 → 在 macOS 上**既看不到提示也看不到错误**。有了 read，客户端必须先成为一个加密链路，配对才会发生。
2. **它返回 `API_VERSION`**，让版本不一致的客户端在开口之前就能说明白。

### 版本不一致怎么办：说，但**不拒绝**

这一点反直觉，值得专门记住：

> `API_VERSION` 说的是**这两个 peer 不是一起编译的**，它**不**说哪些调用会失效 ——
> 而在这条链路上，通常一个都不会。

没有任何东西跨这条链路检查版本号：`configd` 不为任何调用做版本门控，`updaterd` 也不要求握手。

**所以一个"因为版本不符就拒绝"的客户端，拒绝的恰恰是机器人本来会回答的调用** —— 而且是在"机器人没有网络"时唯一可用的那条链路上拒绝，而 `net.connect` 正是从版本不符中脱身的办法。

正确做法：**提示不一致，让调用过去，真的碰到形状变了的方​​法时报 JSON-RPC 错误**。那些错误会自己报上名来（`METHOD_NOT_FOUND`、`INVALID_PARAMS`）。

> 这正是仓库自己的规矩（`CLAUDE.md`）：**版本偏差是记录并服务的，不是拒绝的。**

---

## 7. 路由表就是安全边界

`route.rs` 回答三个问题，**一张表同时回答**：

```text
   ┌─────────────────────────────────────────────────────────┐
   │  route_for(call) -> Route                              │
   │                                                         │
   │    Route::To(Upstream, Lane)   允许，转发给谁 / 占多久   │
   │    Route::Local                由 btd 自己回答           │
   │    Route::Refused              拒绝                     │
   └─────────────────────────────────────────────────────────┘
```

> 📌 注意"允许吗"和"归谁管"其实是**同一个问题**：一个调用被允许，**当且仅当**这张表为它指定了一个服务。
> 而"占多久"（Lane）也在同一张表里，**这样新方法不可能在没回答这个问题的情况下被加进来**。

### 7.1 那个穷尽 match

`permits()` 是一个**穷尽匹配（exhaustive match），没有 `_ => false` 兜底**。这不是风格问题：

> 给协议加一个方法，**`btd` 会编译失败**，直到有人对它做出决定。
> 一个 `_ => None` 通配在当下是"安全的默认值"，长期是错的 ——
> 它会**静默地**拒绝新方法，而第一个症状是"手机 app 少了个功能，没人记得要路由它"。

这个设计**已经回本过一次**：七个 `net.*`/`system.*` 方法加进来时打断了构建。

### 7.2 允许什么（BLE 上能做的）

| 分类 | 方法 |
|---|---|
| 握手 | `hello`、`system.authenticate`（Local） |
| **更新** | `update.apply`、`check`、`status`、`subscribe`、`log`、`show`、`listInstalled`、`rollback`、`select` |
| **配网** | `net.status`、`net.scan`、`net.connect`、`net.forget` |
| 系统 | `system.info`、`setName`、`services`、`logs`、`reboot` |
| 手柄 | `pad.status`、`pad.pair`、`pad.forget`、`pad.bindings`、`pad.bind` |
| 机器人（部分） | `robot.health`、`enable`、`do`、`init`、`rebootMotors`、`loadPolicy`、`reloadPolicies`、`policies`、`model`、`skills`/`setSkill`/`removeSkill` |
| 策略与账户 | `policy.check`/`search`/`fetch`/`install`、`detector.check`/`install`、`account.login`/`status`/`logout` |

### 7.3 拒绝什么，以及**为什么**

这张表才是精华。每一行都是一个真实的事故或推理：

| 拒绝的 | 为什么 |
|---|---|
| `system.pairingPin` / `setPairingPin` | **最承重的一条。** 一个未配对的对端就能**读**（或**改写**）的配对码，会让配对彻底沦为表演。`btd` 反过来走 unix socket 去读它 |
| `update.pin` | 一台被误触固定的机器人会**拒绝之后所有更新，并自称已是最新** —— 这里是唯一一个"坏掉了却看起来像正确行为"的故障 |
| `update.resetToGolden` | 实质上的恢复出厂设置。**永远不走无线电** |
| `robot.safeToRestart` / `modelApi` / `remoteSessionActive` | 这些是 `updaterd` 问 `robotd` 的**内部问题**，手机读到也做不了任何事 |
| **`robot.move` / `head` / `look` / `pose` / `mouth`** | **遥控。** 20 字节的通知预算，加上开机后约 73 秒没有链路 |
| `robot.sound` / `theremin` / `chorale` | 声音和合唱是"在场"的功能，不是远端功能 |
| `chorale.subscribe` / `beaconSet` / `heard` | 这三个是 `btd` 和 `robotd` **之间**的内部总线 —— 对客户端来说**根本不存在** |
| `robot.shutdown` / `robot.mode` / `setMode` | 关机与换模式是本地决定 |
| **`robot.relax`** | 非对称是重点：`robot.init` 是**受控地站起来**，而 `relax` 唯一的结果是**把撑住自己的机器人放到地上** |
| **`robot.stop`** | 一个未配对无线链路上的"急停按钮"**看起来像 e-stop，但不是**。真正的机制是 `robotd` 的死区开关（deadman） |
| `robot.subscribe` | 会把控制速率的状态流灌进一条 20 字节的管道 |
| `pad.input` / `tof.stream` / `headImu.stream` | 双重理由：同样是洪泛，而且服务方是 `padd`/`tofd`，**`btd` 根本没有它们的 socket** |

> 💡 **`update.rollback` 和 `update.select` 本来也在这张表上，后来被移出来了。**
> 原来的理由是"引擎自己会回滚坏版本" —— 确实会，但那只覆盖**健康门失败**的那种。
> 而一个机主会拿起手机的场景不是那种：是**装上了、过了健康门、然后表现得*更差*** ——
> 走路更不稳的策略、不再重连的手柄。**除了人，没有东西会回滚那个** ——
> 而那个人手里拿着手机，没有 ssh。
>
> 所以两者都被放行了，但只移到**已经在这块板子上跑过的**版本，不下载任何东西。
> 决定记在 [`project/update-over-ble.md`](project/update-over-ble.md) §2.4。

### 7.4 "信令门控 ≠ 操作者即机械师"

这句话是 `robotd-primer.md` §3.5 提到的"维护是独立命名空间"的由来。这里它是**两层正交的机制**：

```text
   第 1 层：谁能连上？          session.rs 的 PIN 闸门
                                （"你是不是房间里那个人"）

   第 2 层：连上之后能做什么？   route.rs 的 permits 表
                                （"你是操作者，但你不是机械师"）
```

被第 2 层隔开的，是那些**"一次误操作不可逆、或者无法诊断"**的东西：恢复出厂、固定更新、配对码、以及 `updaterd` 对 `robotd` 的内部提问。

---

## 8. 会话：一个订阅，一个会话

`btd` 只保留**一个会话** —— 一个重组缓冲、一个出站队列、一个授权状态。问题是它**活多久**。

### 8.1 那个决定它的 bug

第一版答案是"和服务一样久"，理由看起来很合理：BlueZ 的回调模型**不给订阅任何 peer 身份**，而且每个特征**只保留一个** notify 状态，所以"按 peer 分会话"看起来是为一个不可能发生的情况造机器。

**代价落在了*下一个*客户端身上**，而且花了三个症状才看清：

| 症状 | 原因 |
|---|---|
| 一个请求有回应，紧接着下一个超时 | 出站接收端被第一个泵从共享槽里**取走了**，所以第二个订阅没有泵 —— 回复被写进了一个没人读的 channel |
| 收到 `":0,"result":{"authenticated":true}}` —— 缺了开头 | 那些孤儿块通过后来的通知者冒了出来 |
| `no robot found`，然后同一个命令又能用了 | **无关**：客户端扫描在固定 sleep 后只取一次快照，广播有没有落进那个窗口全凭运气 |

> **只有第三个是客户端的 bug。前两个是同一个缺陷：状态活得比它所属的那个 peer 更久。**
> 在这个模型里"断开"是不可见的，所以没有任何东西会重置它。

### 8.2 现在的规则

会话**在客户端订阅时创建，在它离开时销毁** —— 重组缓冲和队列跟着一起走。重连的手机**从未认证状态开始**。

两个细节是承重的，而且**两个一开始都是错的**：

- **泵要同时等 `notifier.stopped()` 和队列。** 只从"通知失败"里得知对方离开是不够的 —— 那需要一个回复要发。一个**空闲时断开**的客户端会一直占着槽位，直到有人为它发一个请求。
- **拆会话时只在槽里还是*自己*的 sender 时才清空。** 向一个已经消失的客户端通知要花掉 BlueZ 放弃所需的时间 —— 而在这段时间里，重连的客户端**可能已经装好了一个更新的会话**，一个盲目的清空会把它杀掉。

还有一条：**没有活跃订阅时，写入是被拒绝的。** 接受它是撒谎 —— **没有地方可以送回复**。

### 8.3 `link.rs`：为什么不是 trait

`link.rs` 只有 109 行，但它是 `btd` 能测试的**全部原因**。

```rust
pub struct Link {
    pub inbound: mpsc::Receiver<Vec<u8>>,   // 蓝牙进来的字节
    pub outbound: mpsc::Sender<Vec<u8>>,    // 要发回蓝牙的字节
    mtu: Arc<AtomicUsize>,                  // 当前协商出来的 MTU
    // ...
}
```

**"两条 channel，不是一个 trait"是刻意的**（设计文档 §6）：

> 一个 `GattLink` trait 需要一个 async `recv` 和一个 async `send`，
> 而会话循环要**同时**等这两个 —— 这意味着关联类型，或者在 `select!` 里跟借用检查器搏斗。
> 一个持有两条 `mpsc` channel 的普通 struct 说的是同一件事，
> 而测试只需要**构造一个**，不需要实现任何东西。

所以：**会话测试可以跑一条完整的 BLE 对话，用的却是真的 unix socket，完全不涉及蓝牙。**

还有一个精妙之处：`mtu` 是 `Arc<AtomicUsize>` 而不是一个数字 —— 因为**两端学到 MTU 的时机不同**（BlueZ 只在入站 write 时上报 MTU，而会话开始时只知道 20 字节的下限）。共享 cell 让"会话开始时按 20 字节算、第一次 write 之后按真实值算"变成可能。

还有一个编译期断言值得看（`link.rs:105`）：

```rust
const _: () = assert!(
    QUEUE * 20 >= duck_ble::framing::MAX_LINE,
    "QUEUE * 20 must be at least framing::MAX_LINE, or a full-length request can fill the \
     inbound queue and be refused"
);
```

它保证的是：**队列必须深到让最大的入站行永远不必阻塞**（20 是 BLE 保证的最小有效载荷）。

但注释里真正的理由比"容量不够"深刻得多：

> 这是无线电后端使用**同步 `try_send`** 的原因 —— **它不可以 await**，
> 因为"收到一块"和"把它入队"之间的一个让出点，会让**两块交换顺序**，
> 而一块顺序错了的碎片**会破坏一个请求，而不是让它失败**。

（还记得 `main.rs` 为什么单线程吗？同一个道理：**乱序的碎片不会报错，它会拼成一个解析得通但内容错误的东西**。）

---

## 9. Lane：为什么一条上游连接不够

`btd` 按需打开到 `updaterd`、`robotd`、`configd` 的 socket，并在会话期间保留它们。

**它一开始每个服务只有一条连接。** 问题在于：**这三个 daemon 每一条连接一次只服务一个请求** —— 读一行、等整个调用做完、再读下一行。

于是每个调用都排在**那条队列上最慢的东西**后面。而 App 最先会写的两个顺序，正好都被它弄坏了：

| 客户端做的事 | 发生了什么 |
|---|---|
| `update.apply`，然后在它跑的时候问 `update.status` | 那行 status 在一条 `updaterd` **几分钟都不会读**的 socket 里等着。客户端**什么都没听到就超时了**，而机器人好好的，正在更新 |
| `update.subscribe`，然后 `update.apply` | **更糟。** `stream_progress` 会一直占着它的连接直到对端消失，且从不读下一个请求 —— 所以那个 apply 被写进了一条**没人读**的 socket：它**不会运行、不会回复、也不会报错** |

> 第二条是要记住的那条。机主点了"更新"，机器人**什么也没做**，
> 而**没有任何地方有错误可查** —— 请求正躺在一个 socket 缓冲区里。

### 9.1 四条车道

所以调用按**"它占用连接多久"**分组，每组一条自己的连接：

| 车道 | 占用 | 调用 |
|---|---|---|
| `Prompt` | 一次查询那么久 | `hello`、`update.status`/`log`/`listInstalled`、`robot.health`、`net.status`/`forget`、`system.*`、`pad.status`/`forget` |
| `Slow` | 几秒 —— 网络或无线电扫描 | `update.check`、`net.scan` |
| `Operation` | 想多久就多久，**而且会改变机器人** | `update.apply`/`rollback`/`select`、`net.connect`、`pad.pair` |
| `Stream` | 永远，而且不回答任何东西 | `update.subscribe` |

**每个服务每个会话最多 4 条 socket，实际通常是 2 条。**

> 💡 注意 `update.check` **故意不在 `Operation` 车道上**：在一次更新进行中被问到的时候，
> 它有一个立即的答案 —— 把它排队会把一个 `BUSY` 变成一个**几分钟后才解开**的转圈。

**车道是在 `route.rs` 里决定的**，紧挨着权限和服务 —— 这又是为了让穷尽匹配覆盖它：**一个新的长调用不可能在没人做选择的情况下被加进来**。

> 📌 补充一个新手容易困惑的点：**`Lane` 这个类型本身定义在 `duck-ipc-proto` 里，不在 `btd` 里**，
> 因为"这个调用要占多久"是**所有传输共享**的知识（WebRTC 那边也要）。
> `btd` 独有的只是"**BLE 上准不准**"（`permits`）。

---

## 10. 分片与 MTU：小包里的大学问

BLE 一次能发的数据很小，所以一条 JSON 消息必须切成很多块。这块知识集中在 `duck-ble/framing.rs`，**机器人和客户端共用同一份代码**。

### 10.1 没有长度头

```text
   发送方：  {"jsonrpc":"2.0",...}\n   ← 就是普通 NDJSON
   切块：    [前20字节][接着20字节][...]
   接收方：  拼到看见 \n 为止
```

**帧分隔符就是 NDJSON 本来就有的那个换行**，两个方向都是。这是**安全**的而不是**运气好**：

> `serde_json` 会把字符串里的换行转义成 `\n`，所以**原始 `0x0A` 永远不会出现在一个序列化好的 JSON 对象里**
> —— 这正是 NDJSON 能在 unix socket 上工作的同一个性质。

如果加一个长度前缀，那就是一个**只有 BLE 说的第二方言**，每个客户端都得实现它。现在手机只要做 `robotctl` 做的事：写字节，读到换行。

### 10.2 三个数字，各有各的理由

```rust
pub const MAX_LINE: usize = 8 * 1024;        // 我们能重组的最大入站行
pub const MAX_REPLY_LINE: usize = 64 * 1024; // 客户端会重组的最大行
pub const FLOOR_MTU: usize = 20;             // 任何 BLE 链路都保证支持的
pub const MAX_ATTRIBUTE_VALUE: usize = 512;  // 来自核心规范，不是 MTU
```

**`MAX_LINE` 是安全边界。** 一个从不下换行的 BLE 客户端会让缓冲区无限增长 —— **而它在无线电范围内的任何人都够得着**。8 KiB 对任何真实请求都很宽松，又远低于 `updaterd` 自己的 1 MiB 上限。

**`MAX_REPLY_LINE` 是另一个数字，而且必须是。** 注释里记录了一次真实故障：

> 复用那个紧的（8 KiB）让**每一条超过 8 KiB 的回复都读不出来** ——
> 这悄悄地把 `update.show`（一次普通运行就有几千字节）和 `system.logs`（一屏 journal）
> 从 `duckctl` 手里拿走了，而 `btd` 把两者都服务得好好的。

一句话：**`MAX_LINE` 限制的是对端，`MAX_REPLY_LINE` 限制的是你选择去连接、并且已经信任的机器人。** 这两者不一样大。

### 10.3 那个丢掉两个字节的 bug

`notification_payload(mtu)` 计算一次通知能带多少字节：

```rust
usize::from(mtu).saturating_sub(3).clamp(FLOOR_MTU, MAX_ATTRIBUTE_VALUE)
```

为什么不是简单的 `mtu - 3`？因为那个算术**不够**：

> 对一个 CoreBluetooth 协商出来的 517 字节 MTU，`mtu - 3` 得到 514 ——
> 而**交给 central 一个 514 字节的值，它会保留前 512 个字节，丢掉剩下的**。
> **而且是静默地** —— 两边都不报错。

后果长这样：

```json
   机器人发的：  {"security":"wpa_psk"}
   客户端收到：  {"serity":"wpa_psk"}     ← 中间少了两个字节
```

> 更糟的是当丢掉的那一对里正好包含换行 —— 那一行就**永远不会完整**，
> 调用会一直等到预算耗尽，而机器人**早就回答过了**。
>
> 单块的回复（`net.status`、`system.info`、`hello`）全程正常，
> 这正是让这个 bug **看起来像"那几个大方法有问题"而不是"每个边界都有问题"**的原因。

### 10.4 手机改变了问题的规模

一个很漂亮的实测结果：

| 客户端 | 协商出的 MTU | 一次通知能带 |
|---|---|---|
| Mac | （按 20 字节下限起步） | 20 字节 |
| **iPhone 17 / iOS 26** | **515** | **512 字节** |

同一个 5 KiB 的 journal 尾巴：Mac 上要 **≈265 次**通知、1.83 秒；手机上大约 **11 次**。

> 设计文档原话：这是 **`system.logs` 能不能作为一个 App 敢提供的方法** 的区别。

而发送侧为了应付这个，做了三件事（都不是真正的解法，因为那个模型没有"可以发了"的信号）：

- **载荷大小从写侧来** —— 每次入站 write 都带着协商好的 MTU，而且 `system.authenticate` 总是会话的第一次写，所以会话从下限起步、从第一次回复起就按真实大小发。
- **每 16 块暂停一下**（约一个连接间隔）。小回复永远不暂停。
- **被拒绝的块会重试**，而不是当成断开。

---

## 11. 广播：机器人怎么被找到

### 11.1 那个"听不见"的机器人

`duckctl` 大约一半的运行报 `no robot found`，有一阵被当成工具的抽风，或者当成手柄（它的 LE 链路共用天线）。**都不是。**

`btd` 注册广播时没给间隔，于是 BlueZ 用了内核默认的 **1.28 秒**。从一个 Mac 连续扫描两分钟，数每个设备到达几次：

| 设备 | 信号 | 120 秒内到达 |
|---|---|---|
| 智能插座 | −66 dBm | 130 |
| 信标 | −91 dBm | 159 |
| **机器人** | **−36 dBm** | **16** |

> **机器人是房间里信号最强的，却比里面任何东西都少被听到一个数量级** ——
> 所以距离、干扰和客户端都被**排除**了，而不是被争论掉。
>
> 它平均每 7.5 秒出现一次，静默期有 9、14、17 秒，有一次 **31 秒**；
> 那些大间隔接近于 1.28 秒的整数倍 —— 这正是从到达时间反推出间隔的办法。
> **一次落在静默期里的 8 秒扫描，什么都找不到。**

改成 **100–150 毫秒**（普通外设的量级，不是规范允许的 20ms —— 一根天线还要扛手柄的 LE 链路和 wifi）之后：

| | 120 秒到达 | 平均间隔 | 最长静默 | ≥8 秒的静默 |
|---|---|---|---|---|
| 1.28 秒（默认） | 16 | 7.5 s | 30.8 s | 7 |
| **100–150 ms** | **151** | **0.8 s** | **3.8 s** | **0** |

> 九倍的频率，而且 —— 真正重要的那部分 —— **没有任何一次静默接近 `duckctl` 那个 8 秒窗口的两倍以内**，
> 所以当初诊断出的那个故障**不可能再发生**。机器人从 106 个设备里的第 34 名变成 74 个里的第 7 名。

### 11.2 广播里装了什么

```text
   ┌──────────────────────────────────────────────────────┐
   │  传统广播（legacy advertisement）一共只有 31 字节     │
   ├──────────────────────────────────────────────────────┤
   │  flags                    3 字节                     │
   │  128 位服务 UUID          18 字节  ← 客户端认它      │
   │  厂商数据（IPv4 地址）     8 字节  ← 4 字节载荷       │
   │                          ─────                       │
   │  已经 29 字节了，只剩 2 字节                          │
   └──────────────────────────────────────────────────────┘
   名字装不下 → 它走"扫描响应"（scan response），那里另有 31 字节
```

**IP 地址为什么在广播里？** 因为 `duckctl scan` **故意不连接任何东西** —— 这正是它在机器人连不上时该被想起来的原因，也意味着一个列表**只能报告广播里带着的东西**。而列表最常被用来回答的问题就是"我该 ssh 到哪"。

四个字节放在公司 ID `0xFFFF` 下（蓝牙 SIG 留给内部/互操作测试的 ID，对一个还没被分配的项​​目来说是正确选择）。

> ⚠️ **那个字段不是身份验证。** 任何人都可以用 `0xFFFF`。
> 它只从一个**同时也广播了服务 UUID** 的设备上被读取 —— **UUID 才是判别依据**。

**没有地址的机器人广播 `0.0.0.0`，而不是把这个字段丢掉。** 于是列表能区分**三种**状态：有地址、没有网络、以及**一个来自这个功能之前版本的机器人**（根本不广播这个字段）。把后两者混为一谈，会让读的人去检查一台其实需要更新的机器人的 wifi。

> **SSID 不在这里，而且不可能在。** 一个 SSID 自己就长达 32 字节，而预算只剩 6 字节。

### 11.3 机器人叫什么

**身份来自 SoC 序列号**（`/proc/device-tree/serial-number`）。它烧在芯片里、由 bootloader 交出，所以**刷机后还在、换掉无线电模块后还在、而且不需要任何 provisioning 步骤**。

默认名字是 **`duck-` 加上序列号 SHA-256 的四个十六进制字符**：`duck-c51b`。

> 用哈希而不是切片，因为**没有任何东西保证芯片 ID 的哪一部分在芯片之间会变化**。
> 用 SHA-256 而不是 Rust 标准库的 hasher —— 后者的输出**跨 Rust 版本不稳定**，
> 一次工具链升级会把现场每一台机器人改名，而**没有人会把这两件事联系起来**。

四个十六进制字符是 65536 种可能，所以一个房间里的三台机器人**大约两万二千次里撞一次**。这是一个**用来区分**的默认名，**不是唯一键**。

#### ⚠️ 一台机器人有**两个**名字，而且两个都要设

这是踩过的坑，值得单独记住：

| | 从哪来 | 谁知道它 |
|---|---|---|
| **Local Name** | 广播里 | 扫描的人 |
| **GAP Device Name**（特征 `0x2A00`） | BlueZ 取 `Adapter.Alias`，默认是主机名 | **连上之后读它的人** |

> 只设第一个的后果：一台改过名的机器人**广播 `duck-c51b`**，
> 却对**任何读那个特征的人回答 `radxa-zero3`** —— 而**读它正是 central 连接之后做的第一件事**。
>
> BlueZ 随后会用这个答案**覆盖**广播里的名字，于是在 Linux 上机器人
> **第一次接触前叫 `duck-c51b`，接触之后叫 `radxa-zero3`**，而 `--name duck-c51b` 就找不到它了。
> CoreBluetooth 两个都留着，报成 `radxa-zero3 [duck-c51b]`。
>
> 而**手机的蓝牙设置页显示的是 GAP 名字** —— 这才是最要紧的那个场景，也是这个仓库里**没有一个工具能看见**的那个。

所以 `advertise()` 会**同时**设别名，**每一条发布名字的路径都发布两个**。

#### 为什么是"每几秒对一次"，而不是"改名时立刻更新"

`btd` **转发 `system.setName` 时并不读它的回复**（解释回复是它刻意避免的事），所以"刚转发完就去问一次"会和它刚转发的那次写入**抢跑**。

轮询的零件更少，而且覆盖了**通过 `robotctl` 改的名** —— 那种改动**根本不经过 `btd`**。

> `configd` 够不着时退回主机名：**`btd` 在恢复路径上，必须在机器人的其余部分还没起来的时候就能起来。**

### 11.4 一个连接着的机器人仍然找得到

有个机器人一旦手机 App 连上，就**从 `duckctl scan` 里彻底消失了** —— 不在别的名字下、也不在"没有服务"的形态下，就是**不见**。

两个机制叠在一起，只有第一个是显然的：

- **一个连接会停掉产生它的那个广播集。** 这是规范，而 BlueZ 和内核都不会把它放回去，直到链路断开。
- **当一个外设角色的连接打开时，Linux 根本不会启用可连接的广播集** —— 除非控制器说它可以。

实测（手机连着的时候注册）：

| 在手机连接期间注册 | 到空气里了吗？ |
|---|---|
| **不可连接**，带着鸭子服务 UUID | **到了** —— 8 秒后被一台笔记本扫到 |
| 可连接，同样的载荷 | 没有 —— BlueZ 注册了，扫描从没见过它 |

**所以 `btd` 在会话活跃时广播一个"广播式"（broadcast）通告，否则广播一个可连接的通告。** 载荷不变（同样的名字、同样的 UUID、同样的四字节 IP），所以扫描能找到机器人，`duckctl ip`、`ssh`、`scp`、`open` 在 App 占着链路时全都能用。

> **这不仅是唯一可行的说法，也是唯一真实的说法。**
> `bluer` 每个特征只保留一个通知状态（§8.1），所以**第二个 central 不会得到第二个会话，它会*替换*第一个**
> —— 一个可连接的广播是在邀请一件这个 daemon **无法兑现**的事，
> 而接受邀请的那个客户端就**破坏了别人正在用的会话**。

代价：地址会变（内核要求不可连接集必须用隐私地址），所以一个忙碌的机器人对扫描器来说是**另一个外设身份** —— 靠**名字和服务 UUID** 匹配，不靠地址。

---

## 12. 配对与 PIN

### 12.1 为什么不能用印在机器人上的 PIN 做蓝牙配对

原本的设计是：让机器人用存储的 PIN 回答 BlueZ 的 passkey 请求。**在真机上，macOS 显示了它自己的随机六位码，然后等有人把它输进机器人。**

原因是规范强制的：

> 在 LE passkey entry 里，一方**显示** passkey，另一方**输入**它 —— 而角色由各自声明的 IO 能力决定。
> 实现 `request_passkey` 等于声明"本设备能输入"，所以 macOS 就拿了显示的角色。
> **一个没有键盘的机器人填不了那个角色。**

反过来也一样糟：用 `DisplayPasskey` 机器人拿了显示角色，但**规范规定显示方要随机生成 passkey** —— BlueZ 选一个交给 agent，**没有任何办法让它呈现一个我们存着的值**；何况一个无头机器人也没有东西可以显示。

**所以"印在机器人上的固定 PIN"在 BLE passkey entry 里是无法表达的。** 剩下三个选项，选了第三个：

| 方案 | |
|---|---|
| 只做 just-works | 加密、未认证、无 PIN。安全性 = 物理在场。大多数无头 BLE 设备就是这样 |
| 带外（二维码） | 真正认证、真正每台不同。但 BlueZ 的 OOB 支持很薄，也没有手机 App 能驱动它 |
| **just-works + 应用层 PIN** | **选了这个。** 为加密而配对；PIN 在会话里检查，**规则由我们定** |

### 12.2 现在的样子

```text
   ① 蓝牙配对：just-works（每个 agent 处理器都是 None → NoInputNoOutput）
   ② 特征的 read 要求加密链路 → 这才让 central 去配对
   ③ 然后 btd 什么都不服务，直到客户端发 system.authenticate
```

第 ② 步用的是**普通加密**（`encrypt_read`）而不是 `encrypt_authenticated_*` —— 因为 just-works 的绑定**永远无法满足**认证变体，要求它等于拒绝每一个客户端。

> 💡 顺带解释一个刚看代码时会疑惑的点：**为什么"必须先配对"要靠那个 read 来实现？**
> 因为 BLE 的特征属性里，**notify 根本没有加密标志**（`CharacteristicNotify` 没有这个字段），
> 只有 read 和 write 有。所以"让 central 去配对"这件事**只能挂在 read 上** ——
> 一个未配对的客户端读它会收到"认证不足"，从而当场发起配对；订阅做不到这件事。

`pairing.rs` 只有 192 行、**只做一件事**：`pin()` 通过 unix socket 问 `configd` 要当前的 PIN。

两个细节：

- **超时 3 秒**（`PIN_TIMEOUT`）—— 因为此刻 BlueZ **正挂着一个配对交换**，手机在转圈，不能等太久。
- **PIN 从不进日志**，而且**不能从 SoC 序列号派生** —— 因为那个身份是**广播出去的**，任何由它算出来的东西都是公开的。

### 12.3 ⚠️ 而现在加密是关掉的

**这是全仓库最需要注意的一处未完成状态。** 设计文档 §5.5 写得很直白：

> 特征上的 `encrypt_read` 让 **macOS 上的读挂住**：CoreBluetooth 发出 Read Request，
> BlueZ 因为加密不足拒绝它，然后**什么都不解决** —— 没有提示、没有错误、没有重试。
> 客户端对着一个好好的机器人等它超时。
>
> 所以 `btd` 目前在测试板上以"不要求配对"运行，**而 PIN 走的是未加密的链路**。

于是 `--require-pairing` **默认是关的**，而且理由被说清楚了：

> 先试过另一个方案并否掉了：**要求配对作为默认值，会让新装好的机器人安全但完全不可用** ——
> 每个客户端都会卡在版本读上。
> **没有任何东西被一台没人能对话的机器人保护。**
>
> 代价是明说而不是含糊过去的：**每一台这样运行的机器人，其 wifi 凭据和 PIN 都是路人可读的。**

所以 `btd` **每次启动都打一条 warning 点名这件事**，让这个选择保持可见，而不是变成"没人记得的那件事"。

**这必须在任何一台机器人交到任何人手上之前关掉。** 这是设计文档 §8.1 的阻塞项。

> 💡 一个值得知道的对照：参考实现 `reachy_mini` **根本不用链路层加密**。
> 它声明特征时只写 `["write"]` 和 `["read","notify"]`，不带任何加密标志 ——
> 所以它在 iOS 上就是能工作，因为**手机从来没被要求加密任何东西**。
> 他们在应用层自己加密，把设备 PIN 混进密钥派生。
> 我们这边结论是"修链路层"，他们那边是"别再向链路层要机密性，把真正重要的那个秘密封起来"。
> 设计文档 §8.1 现在把两者都列为候选方案。

### 12.4 工厂 PIN 是 `000000`，而且在这个仓库里是公开的

所以在开箱状态下，**这整套东西只证明物理在场，仅此而已**。

> 安全性**完全**依赖于 PIN 是每台不同的 —— 这让它成为一个 **provisioning 义务**：
> 必须有东西去生成它、打印它、并记录打印了什么。

`btd` 在每次用默认 PIN 认证时都会打一条 warning。`robotctl system set-pin` 设的值**必须正好是六位 ASCII 数字**，而且 `configd` 会告诉调用者它是不是还是默认值。

---

## 13. 合唱：只管无线电

`chorale.rs` 的存在理由可以一句话说完（模块头原文）：**`btd` 不持有任何合唱状态、不做任何合唱决策。** 它只**广播被交付的字节**、**上报听到的字节**。

```text
   robotd（行为：谁指挥、唱哪个声部、什么时候开始）
        │
        │  chorale.beaconSet  ↓          ↑  chorale.heard
        ▼
      btd（只是无线电）
        │
        │  第二个广播实例，20–40 ms 一次
        ▼
      空气 ──▸ 别的鸭子
```

三个值得看的点：

**广播用第二个实例，而且必须不可连接。** 可连接的实例在手机连着的时候**拒绝重新广播**。而且**按需注册** —— 因为控制器交错广播实例会把**第一个的速率减半**。

**监听优先用 BlueZ 的 advertisement monitor**（控制器内部匹配），拿不到才退回 `discover()` —— 而后者**必须带 `duplicate_data: true`**，否则只有第一次广播可见。

**发的是"年龄"不是时间戳**：两个进程没有共享的 epoch，所以 `chorale.heard` 带的是 `age_us`。

**信标里的 `id` 故意是 16 位**：一个字节在四只鸭子的房间里**第一天就会撞**，导致**丢掉指挥的信标**。

---

## 14. 部署与权限

### 14.1 一个反常的事实：`btd` 不跑 root，`configd` 跑

看起来搞反了。设计文档 §4.1 解释了：

> **`btd` 才是那个解析"无线电范围内任何人发来的字节"的进程。**
> `configd` 只见到从一条有 peer 凭据的本地 socket 上来的、已经成型的 JSON。
> **把解析器放在这条边界的安全一侧，比加固那个分发器更重要。**

### 14.2 `btd.service` 的关键配置

| 配置 | 为什么 |
|---|---|
| `After=dbus.service bluetooth.service` + `Wants=bluetooth.service` | `bluetoothd` 是硬需求，但用 `Wants` 而不是 `Requires`：bluetoothd 慢或重启时，`btd` **等并重试**，而不是失败 |
| `After=local-fs.target`，**无网络依赖** | **BLE 正是"网络不工作时必须能工作"的那条传输** |
| `User=btd` / `Group=btd` / `SupplementaryGroups=robot bluetooth` | `robot` 让它穿过 0660 的 socket；`bluetooth` 让它够到 BlueZ 的 D-Bus 策略 |
| `Restart=always` / `RestartSec=5s` | |
| `RuntimeDirectory=btd` | 得到 `/run/btd/identity.json`，`robotctl health` 和 updaterd 的启动检查会读它 |
| `RestrictAddressFamilies=AF_UNIX` | **只允许 unix socket** —— 它不需要别的 |
| `CapabilityBoundingSet=`（空） | 一个能力都不给 |
| `ProtectSystem=strict` 等一整套 | 比 `robotd` 能做的严格得多，因为**这个进程没有硬件要够** |

### 14.3 启动要等 ~73 秒

> 在 Radxa 上，`hci0` 在开机后约 **73 秒**才存在：`aic-bluetooth.service` 晚挂上 AIC8800 的 UART，
> 而 `bluetooth.service` 自己又在 `dbus` 后面堵了约 26 秒。
> **所以排在 `bluetooth.service` 后面是必要的，但远远不够** —— 真正让启动能用的是那个重试循环（`ADAPTER_RETRY = 5s`）。

设计文档给手机 App 的提醒很实在：**一个围绕"即时发现"设计的 App 会失望。**

### 14.4 权限是两层的

```text
   第 1 层：socket 模式 0660 + robot 组     → 谁可以"连上并说话"
   第 2 层：allow_users / --allow-user     → 谁可以发"会改变东西"的调用
```

**只读调用完全跳过第 2 层** —— 这样 support 可以检查一台它无权修改的机器人。

**按名字授予，绝不按 uid**：`systemd-sysusers` 动态分配，所以写进发布配置里的数字**写在为它准备的那块板子上是对的，下一块就错了**。

> ⚠️ **`SO_PEERCRED` 只报告对端的*主* gid** —— 这是这里的陷阱：
> `SupplementaryGroups=` 能让你通过 socket 模式，但**到此为止**。
> 没注意到这一点，就是"每一个会改变东西的调用经 BLE 过来都返回 `PERMISSION_DENIED`，
> 而所有只读的都正常工作"的原因 —— **最糟的一种 bug 形状，因为它读起来像一个谜，而不是一个配置错误。**

### 14.5 `btd` 故意不在"更新后重启"的名单里

因为它**可能就是那个更新请求本身走的传输**：重启它会丢掉承载 `update.subscribe` 的连接，而**发起更新的手机永远不知道结果**。

代价是有界的：这个排除在回复上线之后就到期了，所以引擎会在 5 秒后重启 `btd`。

---

## 15. 测试：不能有无线电

`btd` 有 **45 个测试**，全部在笔记本上跑，**没有硬件、没有网络、没有 D-Bus、没有 Docker**。

两个接缝让这件事成立：

- **`configd` 的 wifi 是一个 trait**，带内存里的假实现（就像 `duck-control` 有 `RobotIo`）。
- **`btd` 的无线电是两条 channel，不是一个 trait**（§8.3）。

所以会话测试**用真的 unix socket 驱动一段完整的 BLE 对话**：一个被拒绝的调用永远到不了 daemon、`robot.*` 路由到 `robotd` 而不是 `updaterd`、订阅流的每一个通知都穿过一个 23 字节的 MTU 到达。

测试分布也说明了重心在哪：

| 文件 | 测试数 | 因为 |
|---|---:|---|
| `route.rs` | **18** | 路由表**就是**安全边界 |
| `session.rs` | 14 | 协议行为 |
| `chorale.rs` | 5 | 信标编解码 |
| `pairing.rs` | 4 | |
| `upstream.rs` | 4 | |

测试的名字本身就是一份规格说明，值得一读：

```text
   only_these_mutating_calls_are_reachable_over_ble
   the_pairing_pin_is_not_reachable_over_ble
   teleop_stays_off_the_radio
   a_phone_can_recover_a_robot_but_not_drop_it
   a_pin_with_leading_zeros_is_the_right_passkey
   nothing_else_travels_on_the_stream_lane
   the_calls_that_take_their_time_are_off_the_prompt_lane
   everything_permitted_is_deliverable
   nothing_refused_is_deliverable
   a_beacon_survives_the_advertisement
   the_address_instance_is_not_heard_as_a_beat
   the_scan_pattern_matches_what_is_broadcast
   somebody_elses_payload_is_not_a_beacon
   the_beacon_is_faster_than_the_front_door
```

> `the_address_instance_is_not_heard_as_a_beat` 尤其能说明这个仓库的风格：
> 广播的**地址实例**（不可连接的、带 IP 的那个）不能被误听成合唱的一拍。

**`duckctl`（`cargo run -p duckctl`）是手机的替身**，也是唯一能真正驱动无线电的办法。

它**曾经是 `btd` 的一个 example**，现在**是一个独立的 crate**（有自己的 binary，`advwatch` 才是它的 example）。
这个搬家的意义在于：**保证 `btleplug`（客户端的蓝牙库）永远不进到机器人上**。
以前那个保证是"example 的依赖是 dev-dependency"这个**副作用**得来的；现在它有两种更直接的说法：

> **机器人上没有任何东西依赖 `duckctl`**，而且它被**排除在 workspace 的 `default-members` 之外** ——
> 那正是让它不上板子的东西：`cargo board --bins` 会为 aarch64 构建每一个默认成员，而这是给开发者坐的那台机器用的工具。

它复用 `duck_ble::framing` —— 所以分片这件事是**客户端那一半的真代码**，而不是一份可以跟自己达成一致的重写。

### 15.1 什么没有被测

设计文档直说了，值得抄下来：

- 两个服务**都没有见过真正的无线电**，也没有见过真正的 NetworkManager。
- **~73 秒 BLE 才可用**（§14.3）。
- **`identify` 不存在** —— 让"这一台"机器人点头、闪灯或叫一声。BLE 上按设计拒绝电机控制，所以这缺的是**一条设备路径**，而不是看起来那样的策略问题。

---

## 16. 阅读路线

**第 1 步 —— 建立直觉（20 分钟）**

1. 读 `btd/src/lib.rs`（**只有 40 行**，但信息密度极高）。
2. 读设计文档 [`app-path-design.md`](design/app-path-design.md) §1（形状）和 §3（GATT 表面）。
3. 记下第 3 节那张管道图。

**第 2 步 —— 安全边界（1 小时）**

4. 读 `route.rs` 的 `permits()`（`:76`）。**别从第 1 行读，直接读那个函数** —— 它是一张长表，每一行都有注释说为什么。
5. 读 `route.rs:61` 的 `Route` 枚举和 `:498`–`:538` 四个组合函数。
6. 读 §7.4 那两层正交的机制。

**第 3 步 —— 会话（1.5 小时）**

7. 读 `link.rs` **全文**（只有 109 行）。
8. 读 `session.rs:32` 的 `run()` —— 就是第 5 节那张时序图。
9. 读 `session.rs:240` 的 `authenticate()`。
10. 读 `upstream.rs` 的 `Pool`（`:137`）和 `send()`（`:165`）。

**第 4 步 —— 无线电（1 小时）**

11. 读 `bluez.rs` 的模块头（前 70 行左右），然后 `serve()`（`:217`）。
12. 读 `bluez.rs:784` 的 `advertise()` 和 `:844` 的 `reconcile_advertisement()`。
13. 读 `duck-ble/src/framing.rs` 的模块头和四个常量。

**第 5 步 —— 动手**

```bash
cargo test -p btd            # 45 个测试，不需要蓝牙
cargo test -p duck-ble       # 分片与广播布局

# 有蓝牙的笔记本上，对着真机器人（这是唯一能驱动无线电的方式）
cargo run -p duckctl -- scan
cargo run -p duckctl -- status
cargo run -p duckctl -- call robot.health
```

---

## 17. 术语表

| 术语 | 意思 |
|---|---|
| **BLE** | Bluetooth Low Energy，蓝牙低功耗。和"经典蓝牙"是两套不同的协议 |
| **GATT** | 通用属性配置文件 —— BLE 上组织数据的模型：服务（service）里装特征（characteristic） |
| **服务 / service** | 一组相关特征的容器。客户端**扫描时找的就是它的 UUID** |
| **特征 / characteristic** | 一个可以被**读**、**写**、**订阅**的数据点。`btd` 只有一个 |
| **订阅 / subscribe / notify** | 客户端说"这个特征有变化就推给我"。`btd` 用它送回复 |
| **central / peripheral** | BLE 的两个角色：central（手机）主动连接，peripheral（机器人）被连接 |
| **广播 / advertisement** | peripheral 周期性地喊"我在这里"。**连接建立之前唯一的信息来源** |
| **扫描响应 / scan response** | central 主动问"再说详细点"，peripheral 回的第二段 —— 名字装在这里 |
| **配对 / pairing** | 建立加密链路的过程 |
| **绑定 / bonding** | 把配对产生的密钥存下来，下次不用重新配 |
| **just-works** | 一种配对方式：不验证身份，只加密。安全性 = 物理在场 |
| **passkey entry** | 一种配对方式：一方显示六位码，另一方输入。**机器人填不了任何一边**（§12.1） |
| **MTU** | 一次能传的最大字节数。BLE 保证至少 20，手机通常协商到几百 |
| **ATT** | GATT 底下的属性协议。MTU 是 ATT 层的说法 |
| **NDJSON** | Newline-Delimited JSON，一行一个 JSON 对象 |
| **JSON-RPC 2.0** | 一种远程调用协议。**通知**（无 id，不回复）和**请求**（有 id，会回复）两种消息族 |
| **BlueZ** | Linux 的蓝牙协议栈。`btd` 通过 D-Bus 跟它说话 |
| **D-Bus** | Linux 上的进程间通信总线。`btd` 用它找 BlueZ |
| **`bluer`** | 一个 Rust 的 BlueZ 客户端库。`btd` 用它 —— 因为"GATT 服务端 + 广播 + 配对代理"正是它存在的理由 |
| **D-Bus 回调模型** | BlueZ 通过信号通知 `btd` "有人写了 / 有人订阅了" |
| **lane / 车道** | `btd` 对上游连接的分组：**按这个调用占用连接多久** |
| **一次一个请求** | 本仓库的三个 daemon 都这样服务一条连接 —— 这正是 lane 存在的原因 |
| **peer 凭据 / `SO_PEERCRED`** | Linux 让你查出"这条 unix socket 对面是谁"的机制 |
| **主 gid** | 进程的主组 ID。**`SupplementaryGroups` 不算** —— 这是这里的陷阱 |
| **provisioning** | 给一块新板子配置 wifi、名字等的过程 |
| **`duckctl`** | 笔记本上用的命令行工具，手机的替身，也是唯一能测真无线电的办法 |
| **SoC 序列号** | 烧在芯片里的唯一编号。**刷机不掉、换模块不掉、不需要 provisioning** |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| `btd` 和 `configd` 的权威设计（英文，写得很好） | [`design/app-path-design.md`](design/app-path-design.md) |
| 手机 App 本身 | [`design/mobile-app.md`](design/mobile-app.md) |
| 从笔记本操作机器人的每条命令 | [`robot/duckctl.md`](robot/duckctl.md) |
| BLE 上的更新：决策与权衡 | [`project/update-over-ble.md`](project/update-over-ble.md) |
| 服务拆分、IPC 契约、权限模型 | [`design/architecture.md`](design/architecture.md) |
| **`duck-ble`：手机和机器人之间的那根线（姊妹篇）** | [`duck-ble-primer.md`](duck-ble-primer.md) |
| **`configd`：wifi、身份、手柄配对（姊妹篇）** | [`configd-primer.md`](configd-primer.md) |
| 控制循环（姊妹篇） | [`robotd-primer.md`](robotd-primer.md) |
| 配置文件的 schema（姊妹篇） | [`robotd-params-primer.md`](robotd-params-primer.md) |
| 控制核心：从读总线到写总线（姊妹篇） | [`duck-control-primer.md`](duck-control-primer.md) |
| 摄像头里的鸭子检测（姊妹篇） | [`duck-detect-primer.md`](duck-detect-primer.md) |
| 仿真的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| 所有服务与客户端的公共契约（姊妹篇） | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| 笔记本上的客户端（姊妹篇） | [`duckctl-primer.md`](duckctl-primer.md) |
| 发布怎么把自己装到板子上（姊妹篇） | [`hooks-primer.md`](hooks-primer.md) |
| 板子被配置成什么样子（姊妹篇） | [`deploy-primer.md`](deploy-primer.md) |
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
