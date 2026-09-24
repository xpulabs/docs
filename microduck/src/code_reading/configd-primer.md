# `configd` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> `configd` 的机制由 [`design/app-path-design.md`](design/app-path-design.md) 拥有（英文，和 `btd` 共用一页 —— 因为它们是**同一个功能**）。
> 两者若有不一致，以设计文档为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：[`btd-primer.md`](btd-primer.md)（蓝牙门房）、[`robotd-primer.md`](robotd-primer.md)（控制循环）、
> [`robotd-params-primer.md`](robotd-params-primer.md)（配置）。

## 目录

1. [一分钟版](#1-一分钟版)
2. [为什么它是第五个服务](#2-为什么它是第五个服务)
3. [目录导览](#3-目录导览)
4. [一次请求的旅程](#4-一次请求的旅程)
5. [它不存密码（wifi 的分层）](#5-它不存密码wifi-的分层)
6. [wifi 的四个实测教训](#6-wifi-的四个实测教训)
7. [手柄配对：为什么在这里，不在 padd](#7-手柄配对为什么在这里不在-padd)
8. [机器人的身份与名字](#8-机器人的身份与名字)
9. [配置存储](#9-配置存储)
10. [另外三个 `system.*` 方法](#10-另外三个-system-方法)
11. [部署：为什么它跑 root](#11-部署为什么它跑-root)
12. [测试](#12-测试)
13. [阅读路线](#13-阅读路线)
14. [术语表](#14-术语表)

---

## 1. 一分钟版

`configd` 管**机器人的配置**：wifi、名字、配对 PIN、手柄绑定、重启。

```text
   手机 ──BLE──▸ btd ──┐
  robotctl ──unix──────┼──▸ configd ──D-Bus──▸ NetworkManager  (wifi)
   (mediad) ──WebSocket┘                     └──▸ logind          (重启)
                                             └──▸ BlueZ           (手柄配对)
                                             └──▸ 一个 JSON 文件   (名字、PIN)
```

它提供三个命名空间的方法：

| 命名空间 | 管什么 | 底层是谁 |
|---|---|---|
| `net.*` | `status` / `scan` / `connect` / `forget` | NetworkManager（经 D-Bus） |
| `pad.*` | `status` / `pair` / `forget` | BlueZ（经 D-Bus） |
| `system.*` | `info` / `setName` / `pairingPin` / `services` / `logs` / `reboot` | 一个 JSON 文件 + systemd + logind |

**它不拥有任何凭据。** wifi 密码交给 NetworkManager 就忘了 —— lib.rs 的原文：

> NetworkManager 拥有那些凭据，以 root-only 持久化，并**自己重连**；`configd` 把密码递过去然后忘掉。
> 它真正拥有的只是一个小小的配置文件和机器人的名字。

规模：约 5000 行，11 个模块，**60 个测试**。

---

## 2. 为什么它是第五个服务

`configd` 的存在是两个已定的规则**推导出来**的，不是谁想加一个服务：

**规则一：`btd` 不拥有任何东西。** 如果配置住在 BLE 服务里，那么一个 SDK 竟然要**通过蓝牙去设置机器人的名字**。

**规则二：`robotd` 死掉的时候，配置必须还能到达。** 配 wifi 恰恰是**机器人坏了的时候**最需要做的事，所以它不能住在控制守护进程里。

两条规则一夹，`net.*` 和 `system.*` 就**没有地方可放了** —— 于是有了第五个服务。

> 💡 设计文档里有一句话值得记住：**"这项工作的大部分都不是蓝牙。"**
> 手机 App、SDK、`robotctl`、`mediad` 的远端网关**需要的是同一套 API**；
> `btd` 只是它上面的一层薄管道 —— 而"薄"的证据是：加那七个 `net.*`/`system.*` 方法，
> 在 `btd` 里只花了**路由表里各一行**。

### 2.1 `pad.*` 为什么也在这里

因为**给手柄配对是一个关于射频的配置问题，需要 root**。

而真正**读**手柄的那个进程（`padd`）**故意没有任何特权** —— 因为它要演练的正是手机 App 将来会用的那套意图 API。让它去碰 BlueZ 会毁掉这个性质。

理由和 wifi 完全一样：需要 root，而且要能在机器人本身坏掉时仍然回答。顺带的好处是：通过 `btd` 转发 `pad.*`，配对对手机也可达。

---

## 3. 目录导览

```text
configd/
├── Cargo.toml                     依赖清单（解释了为什么用 zbus 而不是 dbus crate）
├── src/
│   ├── lib.rs             37 行   ★ crate 级文档（很短，先读这个）
│   ├── main.rs           633 行   ★ socket、两层权限、dispatch 表
│   ├── net.rs            411 行   ★ Net trait + FakeNet + UnavailableNet
│   ├── nm.rs             871 行   NetworkManager 的真实实现（zbus）
│   ├── bluez.rs         1122 行   手柄配对（zbus，文件头是一份长设计说明）
│   ├── pad.rs            534 行   Pads trait + 手柄识别的启发式
│   ├── store.rs          339 行   名字和 PIN 的 JSON 文件
│   ├── identity.rs       152 行   SoC 序列号 → 默认名字
│   ├── units.rs          256 行   查询 systemd 单元状态（zbus）
│   ├── logs.rs           407 行   `system.logs` —— 读 journal
│   └── power.rs           59 行   重启（logind，不是 reboot(2)）
└── systemd/
    ├── configd.service   116 行   单元文件（注释解释了每一条加固）
    └── sysusers.d/README          "configd 跑 root，所以不需要自己的用户"
```

**建议的阅读顺序：** `lib.rs` → `main.rs` 的 `dispatch` → `net.rs` → `store.rs` → `identity.rs` → `power.rs`
→ `units.rs` / `logs.rs` → `nm.rs` / `bluez.rs`。

两个大文件（`nm.rs`、`bluez.rs`）放最后，因为它们是"跟外部世界说话"的那一层，而对外部世界的每一次妥协都在它们的文件头里写着。

> 💡 注意 `sysusers.d/` 里那个 **README 而不是 `.conf`** —— 这个仓库用它标记"这个文件**故意**不存在"。
> 它写着：configd 跑 root 所以不需要自己的用户；如果将来有了 polkit 让它能降权，
> 它的 sysusers 条目**属于这里**。

---

## 4. 一次请求的旅程

### 4.1 进门

```text
   ① 客户端连上 /run/configd.sock（模式 0660 —— 组 `robot` 才连得上）
              │
   ② handle()：读一次 socket 对端的凭据（SO_PEERCRED）
              │  ← 每条连接只读一次：凭据不会在连接活着的时候改变
              ▼
   ③ 逐行读 NDJSON，解析成 JSON-RPC
              │
   ④ 如果这条调用会改变东西 → 查权限
              │     通过 → 记一条 INFO（"谁让这台机器人重启"是 support 第一个问的）
              │     拒绝 → PERMISSION_DENIED，并把理由写清楚
              ▼
   ⑤ dispatch()：查表，交给对应的后端
              │
   ⑥ 后端异步做完，把结果包成 JSON-RPC 响应写回去
```

### 4.2 两层权限

和 `updaterd` 一样的分法（`lib.rs` 的 `PeerPolicy`）：

```text
   第 1 层：socket 模式 0660 + 组 `robot`    → 谁可以**连上并说话**
   第 2 层：--allow-user / --allow-group     → 谁可以**改变东西**
```

**只读调用完全跳过第 2 层**，而且是刻意的：这样 support 能检查一台它无权重新配置的机器人 —— 也这样 `btd` 才能报告 wifi 状态**而不被信任去加入一个网络**。

判定用的是一个**共享的**函数：`call.is_mutating()`（定义在 `duck-ipc-proto` 里，`updaterd` 用的是同一个）。它明确列出哪些是"会改变东西"的调用：

```text
   update.* 的写操作 · net.connect/forget · system.setName/setReboot/setPairingPin
   robot.shutdown · pad.pair/forget · policy.install/fetch · detector.install
```

> 注释里每一行都有理由。比如 `pad.pair`：**"把一个手柄绑定到这台机器人，改变的是*什么可以驱动它*，
> 这是这个命名空间里最有后果的事 —— 一个配好的手柄能启用策略。"**
> 而 `pad.status` 是读，保持不设防。

**按名字授予，绝不按 uid**：`systemd-sysusers` 动态分配 uid，所以写进发布单元文件里的数字**写在为它准备的那块板子上是对的，下一块就错了**。名字在启动时解析一次（`getpwnam`/`getgrnam`）。

> ⚠️ 两个陷阱，都写在单元文件里：
>
> **一、`SO_PEERCRED` 只报告对端的*主* gid。** 这就是 `configd.service` 里 `--allow-user btd` **是承重的而不是整洁**的原因：
> 没有它，**每一个会改变东西的调用经蓝牙过来都被拒绝**，因为 `btd` 的主组是它自己。
> `SupplementaryGroups=robot` 让 `btd` 穿过 socket 的 0660 模式，**但到此为止** —— 而这正是正确的两层分法。
>
> **二、权限错误必须点名正确的参数。** 错误信息里曾经写 `--allow-uid`，而真正的参数是 `--allow-user`（而且收的是**名字**）——
> 照做的人会直接撞上 "unexpected argument"，**比原来的错误更糟**。

---

## 5. 它不存密码（wifi 的分层）

这是整个 wifi 部分的组织原则，值得先理解：

```text
   ┌──────────────────────────────────────────────────────┐
   │  main.rs  dispatch                                   │
   │    net.connect(ssid, psk) ──┐                        │
   └─────────────────────────────┼────────────────────────┘
                                 ▼
   ┌──────────────────────────────────────────────────────┐
   │  net.rs   trait Net  ← 接缝（seam）                   │
   │    status() · scan() · connect() · forget()          │
   │                                                      │
   │    ┌────────────────┬────────────────┬────────────┐  │
   │    │  FakeNet       │ UnavailableNet │ NetworkMgr │  │
   │    │  内存里的假实现 │  没有 wifi 栈  │  真的 NM   │  │
   │    └────────────────┴────────────────┴────────────┘  │
   └──────────────────────────────────────────────────────┘
```

**三个实现，各有各的理由：**

**`FakeNet`** —— 测试接缝，也是 `--fake-net`。它能模拟真实 AP 上**很难制造**的失败：密码错、需要密码却没给、企业级网络（不支持）、SSID 看不见。所以整条 `net.*` 表面能在**没有板子、没有无线电**的笔记本上被测。

> 但它**不能模拟 `Timeout`** —— 它瞬时返回，没有"关联上了但 DHCP 拿不到地址"这条路径。

**`UnavailableNet`** —— 没有 wifi 栈时的兜底。它**不是错误**：`status` 返回"不可用"，`scan` 返回空，只有 `connect` / `forget` 才报错。

> 为什么不让 `configd` 在没有 wifi 栈的时候干脆退出？因为 `system.pin` 正是 `btd` 拿 PIN 的地方 ——
> **一个因为依赖缺失就退出的 `configd`，会把"wifi 不可用"变成"机器人完全联系不上"**，
> 而这块板子上手机是唯一的入口。
>
> 这**也是 `configd` 有资格进启动恢复机制（boot recovery net）的条件**：
> 一个单元只有在**等它的依赖而不是退出**的时候才能加入那个集合 ——
> 这样一个 `failed` 的单元才意味着**发布坏了**，而不是板子坏了。

**`NetworkManager`** —— 真实实现，见下。

### 5.1 为什么"不存密码"是个安全收益

> NetworkManager 拥有它，以 root-only 持久化，**自己重连**。
> `configd` 把密码递过去然后忘掉。

这样做换来四件事：代码更少、更安全、**少一处需要迁移的东西**，而且凭据**熬得过 `configd` 自己的重启、升级和回滚**。

代价是：`net.status` 要**去问** NM，而不是读自己的内存。

### 5.2 ⚠️ 一个读代码时会撞上的矛盾

`nm.rs` 的文件头写着：

> **Untested against a real NetworkManager.** It type-checks for aarch64; every claim here is intent
> until it runs on the board.

但设计文档 [`app-path-design.md`](design/app-path-design.md) §2.4 记录了一次**真机运行**：

> 从 Mac 作为客户端，在一块 Radxa Zero 3 上端到端验证过：发现、连接、版本读、PIN 认证、`system.info`、
> `net.status`、`net.scan`、拒绝边界……**以及一个机器人从未见过的网络，经 BLE 配好、加入、
> 并且在重启之后自己重新加入** —— 这正是整条路径存在的场景。
>
> `net.forget` 清掉了某个 SSID 的所有 profile：五个重复的 `kek` profile（修复前的二进制留下的）一次调用全清。
> **整个 `net.*` 表面现在都跑过真实的 NetworkManager 了。**

而同一份文档的 §6.1 又说：

> Neither service has met a **real radio** or a **real NetworkManager**.

**这三处不能同时为真。** 设计文档的两段是**同一次提交**（`ef9162b`，2026-08-10）进来的，
所以 git 分不出先后；`nm.rs` 的那句更早（`471b2dd`，2026-08-04）。

§2.4 写得很具体、有日期，而且它自己的开场白是**"记录下来，因为在这份文档里 'built' 和 'works' 曾经是同一个词太久"** ——
所以 §2.4 读起来像是**修正**，而另外两处像是没跟上的旧话。但这不是我能定的，留给你判断。

（这也是本仓库的一条规矩的反面教材：`CLAUDE.md` 说"当一个事实属于某一页时，其他每页只用一句话并链接"。这里同一个事实写了三遍。）

---

## 6. wifi 的四个实测教训

`nm.rs` 和设计文档 §2 里的每一段都来自**板上真实踩过的坑**。四个最值得看的：

### 6.1 扫描：`RequestScan` 返回 ≠ 扫完了

`RequestScan` 返回的是 NM **受理了**这个请求，**不是无线电扫完了频道**。而 NM 会**剪掉**它最近没见过的 AP —— 所以已经关联上某个网络时，缓存里常常**只有它正连着的那个**。

> 原文实测：**第一次调用列出 1 个网络，第二次同样的调用列出 8 个。**

修法是等 `LastScan` 属性**前进**（上限 10 秒）。而且**限流不算错**：NM 拒绝一个扫描请求通常意味着"刚扫过、缓存正新鲜"，那就直接返回它。

> 对客户端来说这是必须的：一个"在不熟悉的地方挑网络"的人，**"再问一次"不是一个可以发布的契约**。

### 6.2 连接：为什么看 activation，不看 device

**这是这条路径上最糟的一个 bug。**

`connect` 原本轮询的是**设备**状态。而一个设备在**它已经在用的那个网络**上会一直保持 `ACTIVATED`，与此同时旁边一个新的激活正在失败。结果是：

```text
   connect("Tehaupoo", psk: "lol")     ← 这个网络甚至不在范围内
   → {"outcome":"connected","ssid":"SFR-e994"}   ← 报的是机器人一直在用的那个网络
```

> **为一个从未发生的连接报告成功，是能给出的最糟的答案** —— 手机会得出结论"机器人配好了"，然后走开。

现在是轮询 `AddAndActivateConnection` **返回的那个 active-connection 对象**，而且成功时返回**请求的那个 SSID**，而不是 `status` 说什么。

顺带三条同源的处理：
- **无线电看不见的 SSID，当场以 `NotFound` 拒绝。**
- **失败的激活会删掉 NM 刚加的那个 profile** —— 否则 autoconnect 会永远重试一个已知错误的密码，而 `net.status` 还声称这个网络是 `saved`。
- **隐藏 SSID 也被这个预检拒绝。** 加入它需要 profile 里的 `802-11-wireless.hidden` 和客户端"这是隐藏网络"的标志，而 API 现在还没有这个形状。

### 6.3 重新配置：先删后加

`AddAndActivateConnection` **只会新增**，而且 NM 允许两条 profile 用同一个 id。

于是最普通的一条路径 —— 手机上一个密码打错、`BadKey`、然后重发正确的 —— 会让机器人**同时留着两条**，而且**不保证下次重启后 NM 会拿哪条自动连**。

`net.forget` 原本更糟：它删掉两条中的一条然后报告成功。

现在：某个 SSID 的已保存 profile 被当作**一个集合**枚举，连接前**全部删除**。

> **先删后加，而不是先加后删** —— 因为反过来会在"add 成功、清理失败"的时候留下重复。
> 如果 add 之后失败了，那个 SSID 会**没有任何 profile**，而这对于一个正在被替换的配置是**诚实的结果**，并且会报给客户端。

代价：如果被替换的正是当前活跃的那条 profile，**这会断开机器人**。不可避免 —— 换密码就意味着重新关联 —— 而 **BLE 上的客户端不受影响**，这正是整个设计所依赖的性质。

### 6.4 `BadKey` 是值得为它做一次迁移的理由

`ConnectFailure` 有五个变体：`BadKey` / `NotFound` / `Timeout` / `Unsupported` / `Other`。

**映射规则里最重要的一条是"其它一律 `Other`"**：

| NM 的 reason | 变成 |
|---|---|
| `REASON_NO_SECRETS` (7) | `BadKey` |
| `REASON_SSID_NOT_FOUND` (53) | `NotFound` |
| supplicant timeout (11) / disconnect (8) / IP config unavailable (5) | `Timeout` |
| **其余全部** | **`Other`** |

> **一个没有被映射的 reason 绝不能变成 `BadKey`** ——
> 那会把人送进一个**反复重打一个本来就正确的密码**的循环。有一个测试专门钉住这件事。

而 `BadKey` 之所以重要，是因为它是**从 netplan 迁移到 NetworkManager 的整个理由**：被拒绝的密码是配网中最常见的失败，**而一个说不出来的客户端让用户无事可做**。

> 顺带一个反直觉的坑：**失败之后再读 `StateReason` 属性会得到 0**（NM 已经把设备挪走了），
> 所以 reason **只能从 `StateChanged` 信号里拿**。这个 proxy 的函数被特意命名成
> `device_state_changed`，就是为了避开属性自动生成的 `receive_state_changed`。

---

## 7. 手柄配对：为什么在这里，不在 padd

### 7.1 最长的那段：agent 为什么要"抢 default 角色"

`bluez.rs` 的文件头是一份六节的长设计说明，其中最不显然的一条是：

> **`configd` 在配对窗口内不仅注册自己的 agent，还调用 `request_default_agent` 去抢 default 角色；窗口结束再交还。**

为什么？因为 **`bluetoothd` 只从 default agent 往下推 IO capability**。

一个**非 default** 的 `NoInputNoOutput` agent，会让适配器**仍然声明自己有输入和显示能力**。后果是：

```text
   MITM 保护被启用 → SMP 选 numeric comparison 而不是 just-works
        → RequestConfirmation 落到一个没有 agent 的地方
        → 手柄等到 link supervision 超时
        → BlueZ 报 AuthenticationCanceled（实测约 17 秒）
```

所以 `configd` 的 agent 是**短命、按设备收窄**的（`permit()` 只放行正在配的那一个设备，其余 `AccessDenied`）：它只在自己发起的配对窗口里抢 default，之后交还。

> 对比 `btd`：`btd` 用 `bluer` 注册一个**长期持有**的 default agent（所有 handler 留 `None`，等价 `NoInputNoOutput`），服务手机路径。
> 这样 **`configd` 为它发起的配对作答，`btd` 继续为其它一切作答**。

### 7.2 三个 BlueZ 行为，各造成过一个 bug

| BlueZ 的行为 | 后果 |
|---|---|
| `Connect()` 对一个**未绑定**设备会回 `br-connection-profile-unavailable` | 所以它必须被当作**软失败** —— 硬拒会否掉一个马上就能绑上的手柄 |
| `Connect()` 会在绑定**落地之前**就返回 | 所以不能靠它判断成功 |
| 对一个**正在绑定中**的设备调 `Pair()` **永不返回** | **这就是"第一次配对超时、第二次秒成"这个已发布 bug 的成因** |

对策：**`Paired` 属性是唯一的事实来源** —— `wait_until_paired()` 一直轮询到它为 true。

还有一个必须记住的操作细节：**连接之前先 `stop_discovery()`**。因为**扫描进行中，BlueZ 会接受 `Connect()` 但间歇性失败** —— 表现为"第二次才配上"这种**看起来像硬件故障**的东西。

### 7.3 `Trusted = true` 是重连能工作的唯一原因

绑定结束时会把设备设成 trusted。文件里的注释说得很直接：这是**"昨天还好好的、今天什么都不做"**那种故障的成因 —— 少的那一行就是它。

> 全仓库**没有** `pad-reconnect` 这样的单元：重连是 BlueZ / 内核自己做的，靠的就是这个标志。

### 7.4 Pro Controller 克隆柄是**两个**设备

一个便宜的 Switch Pro 克隆柄会以两个设备出现：

```text
   LE 面：      "BLE Controller_280609"      ← 只有名字匹配，先被报告
   BR/EDR 面：  98:B6:E9:...                 ← 带 Class，能配对
```

**先停就会挂 30 秒，而且拿到的是一个已经死掉的对象。**

对策是两道：`find()` 只对**被射频分类过的**匹配提前结束，然后 `one_face_per_pad()` 按 unit octets 把两面合并，保留 classic 面。

还有一条省电的：`UserspaceHID=false` —— 否则经典手柄约 200 包/秒的 IMU 数据经 `bluetoothd` + `uhid` 会**烧掉 16% 的一个核**。

### 7.5 状态存在哪里

**不在 `configd` 里。** 真值在 BlueZ（`/var/lib/bluetooth/<适配器>/<手柄>/info`），每次调用现场读一遍，**没有缓存**。

### 7.6 为什么"手柄连上了"和"padd 在跑"是**两个**问题

`pad.status` 返回**两个**字段：`pads` 和 `driver`。

> 因为**两者会各自失败**：手柄连上了但 `padd` 死了 → 按键没反应；`padd` 在跑但没手柄 → 同样没反应。
> **一个已连接的手柄配一个死掉的 driver，看起来和没有手柄一模一样。**

而 systemd 管理的 `padd.service` 状态**只有 systemd 知道** —— `configd` 不能冒充回答，所以它去问（见第 10 节）。

### 7.7 配对窗口有多长

**不是 BlueZ 的 `Pairable` 窗口**，而是**调用者给的那段发现期**：期间才注册 agent、抢 default 角色，结束后交还。

| 常量 | 值 | 为什么是这个数 |
|---|---|---|
| `DEFAULT_PAIR_TIMEOUT` | 15 s | 有人正按着 sync 键站着 —— 这是人放弃前大概会等的时间。够 BlueZ 报出几秒才广播一次的设备，又短到手机拿到答案而不是转圈 |
| `MAX_PAIR_TIMEOUT` | 120 s | 上限是**礼貌**：整个窗口发现都开着，问一小时的人早走了，适配器还在扫 |
| `BOND_TIMEOUT` | 30 s | **手柄已找到之后**射频能用的时间，和调用者的发现窗口量的是两件不同的事。BlueZ 自己的配对超时是 60 s，30 s 留在它**之内**，好让答案来自这里而不是一个被丢掉的 D-Bus 调用 |
| `BOND_SETTLE` | 5 s | `Connect()` 触发的绑定自行落地的时间窗（实测 Xbox 1 秒内完成，5 秒是余量） |
| `BOND_POLL` | 200 ms | 轮询 `Paired` 的间隔 |
| `SIBLING_GRACE` | 1 s | 见到第一个候选后再多扫一会儿，等同一手柄的另一面 |

---

## 8. 机器人的身份与名字

**身份来自 SoC 序列号**，读 `/proc/device-tree/serial-number`。

为什么不用别的东西：

- **不用 `/proc/cpuinfo`** —— devicetree 是通用 binding。
- **不用蓝牙适配器地址** —— 因为实测**它不稳定**：一块板子在 16 次启动之间报了两个不同的地址（`…2B:EC` → `…1B:92`）。而 BlueZ 把每个绑定存在 `/var/lib/bluetooth/<地址>/` 下，**地址一变，所有绑定都成了孤儿**。

序列号的好处是它**烧在芯片里**：刷机后还在、换掉无线电模块后还在、**而且不需要任何 provisioning 步骤**。

### 8.1 默认名字

```text
   duck- + SHA-256(序列号) 的前两个字节的十六进制
        = duck-c51b
```

**为什么用哈希而不是切片？** 因为**没有任何东西保证芯片 ID 的哪一部分在芯片之间会变化**。

**为什么是 SHA-256，不是 Rust 标准库的 hasher？** 因为 `DefaultHasher` 的输出**明确不保证跨 Rust 版本稳定** —— 一次 `rustup update` 会**静默地重命名现场所有机器人**，而且**没有人会把这两件事联系起来**。

四个十六进制字符是 65536 种可能，所以三个人一个房间大约**两万二千次里撞一次**。而**为什么是四个而不是更多**：长度受 BLE 广播预算约束（见 `btd-primer.md` §11.2）。

> 🧪 有一个测试把 `default_name("bb7b734a7717ac41") == "duck-c51b"` 钉死了 ——
> 这样将来改算法会**立刻失败**，而不是悄悄给现场所有机器人改名。

**读不到序列号怎么办？** 退回 `/etc/hostname`，并且打一条 warn 说明后果：**同一镜像刷出来的板子无法区分**。

### 8.2 模拟的鸭子

`--simulated <serial>` 给 MuJoCo 里的鸭子一个身份。

**为什么模拟的机器人也需要身份？** 因为它**没有地方可读**：没有 SoC、没有 devicetree，`/etc/machine-id` 一台机器只有一个（一场景四只鸭子会共用），macOS 上根本没有。

而且这个身份是**承重的两次**：默认名字由它派生（所以孪生里的鸭子叫 `duck-3f9c` 而不是退回笔记本的 hostname），而且它是 `mediad` 向 rendezvous 注册的 `hardware_id` —— **重启的模拟鸭子会在列表里替换掉自己，而不是出现两次**。

---

## 9. 配置存储

只有一个文件：`/var/lib/robot/config/config.json`，装两个字段：

```json
{
  "name": "Ducky",
  "pairing_pin": "042042"
}
```

**它在发布目录之外**，所以它**熬得过更新，也熬得过回滚**。

### 9.1 写入的纪律

```text
   写临时文件 config.tmp
     → sync_all()              ← 确保内容真的落盘
     → rename(2)               ← 原子替换
     → 打开目录再 sync_all()    ← ★ 这一步最常被忘记 ★
```

> 目录 fsync 是通常被忘掉的那一步：**没有它，rename 可能熬不过一次断电** ——
> 而对一台机器人来说，**被人在墙上拔掉电源是常态而不是例外**。
> 和更新日志用的是同一套纪律。

`flock` 加在一个**独立的 `config.lock` 文件**上，不是加在配置本身上 —— 注释说明了原因：**锁必须活得比那次 rename 长**（rename 会把配置文件的 inode 换掉）。

### 9.2 字段的规则

| | 规则 | 为什么 |
|---|---|---|
| `MAX_NAME` | 24 个字符 | 受 BLE 广播的 31 字节预算约束 |
| `DEFAULT_PIN` | `"000000"` | **众数而不是每板随机** —— 所以它只证明物理在场，仅此而已 |
| `PIN_DIGITS` | 正好 6 位 ASCII 数字 | 因为 BlueZ 的 passkey 就是六位；五位就要补零，而两端会对 `"12345"` 还是 `"012345"` 产生分歧 |

名字会被清洗（`sanitise`）：trim → **去掉控制字符** → 按**字符边界**截断 → 再 trim。

> 控制字符是重点：这个字符串会走到 BLE 广播、日志行、最后是 App 的界面，
> 而名字里的一个换行**能让它劈开一条 journal 记录**。

### 9.3 一个已知的竞态

`set_name` 和 `set_pairing_pin` 都是这个形状：

```rust
let mut config = self.read()...;   // ← 在锁外面读
config.name = Some(name);
self.write(&config)?;              // ← 锁在 write 内部才拿
```

`flock` 只序列化了**写**，没有覆盖**读-改-写**。所以两个并发的写者（比如手机在改名、同时 ssh 上有人在设 PIN）可以都读到旧配置，然后**各自写出一份完整副本，后写的覆盖先写的** —— 丢掉一个字段。

名字丢了是小事；**PIN 丢了意味着用户以为设好了每板 PIN，而机器人还在接受公开的 `000000`。**

修法是把锁提到 `read` 之前（一个 `with_lock(|config| …)` 之类的形状），也就是 `write` 里那句注释 *"flock serialises writers"* 本来想表达的意思。

---

## 10. 另外三个 `system.*` 方法

### 10.1 `system.services` —— 哪个 daemon 在跑

**走 D-Bus，不是 `systemctl` 子进程。** 用一个 `LoadUnit` 调用，而不是 `GetUnit` —— 因为**后者对尚未加载的单元会失败，与"不存在"无法区分**。

监控七个单元：`updaterd` / `robotd` / `configd` / `btd` / `padd` / `mediad` / `tofd`。

**版本号不靠猜**（不问 systemd、不看 `/proc`），而是读 `/run/<服务>/identity.json`。

> ⚠️ 一个很值钱的细节：判定状态时**先看 `SubState`** —— `auto-restart*` 前缀 → 报告为 `Restarting`。
> 因为**崩溃重启循环和首次启动在 `ActiveState` 上都是 `activating`**。
> 这正是让 `mediad` 在摄像头排线没插时崩溃循环、而 `robotctl health` 却报 active 的那个坑。

**为什么需要这个方法？** 因为**手柄灯亮着、而 `padd` 已经死了，看起来和正常硬件一模一样**。

### 10.2 `system.logs` —— 读 journal

**spawn 一个 `journalctl` 子进程**，不是链接 libsystemd —— 后者等于**为一个只读查询在交叉编译里塞进 vendored C**。

两个安全/健壮性设计：

**一、单元名先对着固定表匹配，才交给 `journalctl`。** 这挡住了绝对路径注入。有一个测试钉住 `--directory=...`、`_PID=1`、`*`、`"robotd.service extra"` 全部被拒 —— 而拒绝信息里**列出它会接受哪些**。

**二、字节上限有两层**：

| 上限 | 值 | 管什么 |
|---|---|---|
| `MAX_LINE_BYTES` | 2 KiB | **单行**截断 —— journald 自己的 `LineMax` 是 48 KiB，一条序列化的 blob 能挤掉整条尾巴 |
| `MAX_LOG_BYTES` | 48 KiB | **整条回复**（序列化后的 JSON），超了从**头部**删最旧的行并置 `truncated` |

> 48 KiB 的由来是**传输层**：BLE 把回复拼成一行，而客户端缓冲 64 KiB（见 `btd-primer.md` §10.2）。

还有一个贴心的功能：`assemble` 会在日志里插入 `-- new robotd process, pid N --` 这样的**重启标记**。

**关于脱敏**：`logs.rs` **自己不做任何过滤** —— 它是原始 journal 尾巴。防线在上游：

- `NetConnectParams` 的 `Debug` 是**手写的**，把 `psk` 变成 `<redacted>`（但**保留"有没有给密码"这个信息** —— "密码错"和"安全网络没给密码"是两个不同的 bug）。
- `net.connect` 的日志用 `?params`，所以是安全的；PIN **故意不打日志**。

> ⚠️ 但要注意：**NetworkManager 自己在 journal 里回显的 passphrase 会原样出现在 `system.logs NetworkManager` 的输出里** —— 那条路径没有脱敏。

### 10.3 `system.reboot` —— 3 秒后重启

**不是 `reboot(2)`。** 文件头解释了为什么：

> `reboot(2)` 是一个 syscall，但它会**不停服务直接切电**：`robotd` 永远不会放掉舵机的扭矩，
> 更新 journal 永远不会落盘。**用摔倒来实现重启是不可接受的。**

实现是 **logind 的 D-Bus `Reboot(false)`**（`false` = 非交互，logind 不弹询问）。

**这也解释了 `configd` 为什么跑 root**：logind 的 `Reboot` 受 polkit 管，板上**没有 polkit**，session-less 的非 root 直接被拒。

> 而 `CapabilityBoundingSet=` 是**空的**，并且**特意不给 `CAP_SYS_BOOT`** ——
> 因为一旦有了这个 capability，就能直接调 `reboot(2)`，**正是这个模块要避免的不干净关机**。

非 Linux 上它直接返回错误 —— 免得测试把开发者的笔记本重启了。

---

## 11. 部署：为什么它跑 root

这看起来是本仓库里最反常的一件事：**解析无线电字节的那个进程（`btd`）不跑 root，而 `configd` 跑。**

### 11.1 理由是窄的

`configd` 只需要**两**个特权：NetworkManager 的 D-Bus API（改连接需要 polkit 或 root）、以及 logind 的 `Reboot`（同理）。

**这块镜像上没有 polkit**，而没有 polkit 时 systemd 会把这两样都拒绝给任何**无会话的非 root**调用者。

> 所以选择是：**root，或者装一个 JS 策略引擎来授权两个调用。**

**信任边界仍然在正确的位置**：`btd` 解析来自无线电范围内任何人的字节，它是非特权的；而 `configd` 只见到从有 peer 凭据的本地 socket 上来的、已经成型的 JSON。

> 单元文件的原话：**"让解析器非特权，比让分发器非特权更重要。"**

如果将来因为别的原因有了 polkit，这个服务应该降到一个专用用户加两条 polkit 规则。而那个用户的 sysusers 条目**已经预留了位置**（`sysusers.d/README`）。

### 11.2 那个"窄 root"

和 `robotd` 不同 —— `robotd` 需要裸设备访问所以加固有限 —— **`configd` 不碰任何硬件，所以能被正确地关起来**：

```ini
User=root
Group=robot                      ← socket 要能被 robot 组读
ProtectSystem=strict             ← 整个文件系统只读，除了 ReadWritePaths
ReadWritePaths=/var/lib/robot/config /run
StateDirectory=robot/config
RestrictAddressFamilies=AF_UNIX  ← 它从不自己碰网络接口，只通过 D-Bus 问 NM
CapabilityBoundingSet=           ← 空
```

单元文件里逐条说明了为什么：

- **`AF_NETLINK` 不在列表里**：`configd` 通过 D-Bus（一个 unix socket）问 NetworkManager，**从不自己碰接口**。
- **`CAP_SYS_BOOT` 特意不给**：logind 执行重启，`configd` 只是**请求**。
- **`system.logs` 不需要额外开权限**，这一点特意写下来，免得有人为它放宽这个文件：`ProtectSystem=strict` 下 `/usr` 仍是可执行的，而 journal 文件是 `0640 root:systemd-journal` —— 所以 uid 0 作为属主读得到，**capability 集合仍然是空的**。如果将来内核或 journald 改了这一点，修法是 `SupplementaryGroups=systemd-journal`，**不是一个 capability**。

### 11.3 单元文件里那三条必须保持的性质

```text
   ① 和 robotd 双向无依赖    ← 机器人死掉时配置必须够得着，这是整个服务存在的理由
   ② 和 btd 也无依赖         ← BLE 只是几个前门之一，SDK 不该被迫走蓝牙
   ③ socket 必须能被 `robot` 组读  ← btd / robotctl / 将来的 mediad 就是这样够到它的
```

NetworkManager 用 `Wants` 而不是 `Requires`：NM 缺失时 `configd` 照常启动并报告 `net.state=unavailable` —— 那是一个**可诊断的答案**，并且告诉你这块板子还在 netplan 上。

---

## 12. 测试

**60 个测试**，全部在笔记本上跑，**没有 wifi、没有蓝牙、没有 D-Bus、没有板子**。

靠的是两个 trait 和它们的内存假实现：`net::Net` → `FakeNet`，`pad::Pads` → `FakePads`（就像 `duck-control` 有 `RobotIo`）。

测试分布说明重心：

| 文件 | 测试数 |
|---|---:|
| `pad.rs` | **13** |
| `logs.rs` | **13** |
| `store.rs` | **12** |
| `net.rs` | 8 |
| `identity.rs` | 6 |
| `units.rs` | 4 |
| `bluez.rs` / `nm.rs` | 2 / 2 |

测试名字本身就是规格说明：

```text
   a_pin_keeps_its_leading_zeros
   a_pin_must_be_exactly_six_digits
   a_corrupt_file_yields_the_fallback_rather_than_an_error
   control_characters_are_stripped
   an_empty_name_is_refused
   a_wrong_key_is_reported_as_a_wrong_key
   a_missing_key_is_not_a_wrong_key          ← 这两个必须不同！
   an_unknown_ssid_is_not_found
   two_pads_in_pairing_mode_are_refused_not_guessed
   two_faces_of_one_pad_share_their_unit_octets
   a_name_alone_is_weak_evidence
   keyboards_and_mice_are_not_gamepads
   auto_restart_is_not_active
   a_restart_is_marked_where_it_happened
   an_oversized_tail_keeps_the_end_and_says_it_was_cut
   a_line_is_cut_on_a_character_boundary
   a_config_robotd_would_reject                   (属于 robotd-params)
```

### 12.1 ⚠️ 但测试有一个方向性问题

设计文档 §2.3 说得很直白，而且它描述的**不是一个 bug，是三个**：

> 在板上发现的**每一个** wifi bug 里，**`FakeNet` 早就有正确的行为，而 NetworkManager 的实现从它漂移了出去**：
>
> | 行为 | `FakeNet` | 实装的 NM 路径 |
> |---|---|---|
> | 无线电看不见的 SSID | `NotFound` | 报告 `connected`，还报了另一个网络的名字 |
> | 一次失败的尝试 | 什么都不存 | 留下一条带着错误密钥的已保存 profile |
> | 重新配置一个 SSID | 替换 | 又叠了一条 profile |

> **所以这个 trait 不只是一个测试接缝；它是这份契约唯一被写下来的形式。**
> 问题在于**校验的方向**：测试套件验证的是**假实现符合契约**，而**没有任何东西验证 NM 符合它**。

两个实现都实现了 `Net`，所以同一批断言**本来也可以**跑在真实现上；挡住它的是 NM 那侧需要真的 NetworkManager 和真的无线电，也就是需要一块板子而不是 CI。

**所以诚实的总结是：`configd` 的 wifi 行为被测过，而跑在机器人上的那份代码没有。**

---

## 13. 阅读路线

**第 1 步 —— 建立直觉（20 分钟）**

1. 读 `configd/src/lib.rs`（**只有 37 行**，但把"为什么是第五个服务"说完了）。
2. 读设计文档 [`app-path-design.md`](design/app-path-design.md) §1（形状）和 §2（wifi）。
3. 读 `docs/robot/cheatsheet.md` 的 `### Wifi (configd)` 和 `### Identity and power (configd)` 两节 —— 看看**用**它是什么样。

**第 2 步 —— 骨架（1 小时）**

4. 读 `main.rs:96–171`（`PeerPolicy` + `resolve_uid`/`resolve_gid`）—— 两层权限。
5. 读 `main.rs:193–287`（`main()`）—— 注意**每个后端失败时都不退出**。
6. 读 `main.rs:419–582`（`dispatch`）—— 一张表，每一行都有理由。

**第 3 步 —— 三个"东西"（1 小时）**

7. 读 `net.rs` 的 `Net` trait 和 `FakeNet`。
8. 读 `store.rs` 全文（339 行）—— 写入纪律和字段规则。
9. 读 `identity.rs` 全文（152 行）—— 为什么是 SHA-256。

**第 4 步 —— 外面那一层（1.5 小时）**

10. 读 `nm.rs` 的模块头 + `failure_of()` + `scan()` + `connect()` —— 就是第 6 节那四个教训。
11. 读 `bluez.rs` 的**文件头**（前 187 行，本身就是一份设计文档）。
12. 读 `logs.rs` 的 `resolve()`（安全边界的那几行）。

**第 5 步 —— 动手**

```bash
cargo test -p configd                         # 60 个测试，不需要硬件

# 笔记本上跑一个"假 wifi + 假手柄"的 configd
cargo run -p configd -- --fake-net --fake-pads --socket /tmp/configd.sock
```

然后另开一个终端问它：

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"net.status"}' | socat - UNIX-CONNECT:/tmp/configd.sock
echo '{"jsonrpc":"2.0","id":2,"method":"system.info"}' | socat - UNIX-CONNECT:/tmp/configd.sock
```

`FakeNet` 预置了两个网络（一个 WPA2 的 `Pollen`，密码是 `correct-key`，一个开放的 `Cafe`），
所以可以试一次成功的连接和一次 `BadKey`：

```bash
echo '{"jsonrpc":"2.0","id":3,"method":"net.connect","params":{"ssid":"Pollen","psk":"wrong"}}' \
  | socat - UNIX-CONNECT:/tmp/configd.sock      # ← 应该回 BadKey
```

---

## 14. 术语表

| 术语 | 意思 |
|---|---|
| **NetworkManager (NM)** | Linux 上管网络连接的服务。**它才是拥有 wifi 凭据的那个** |
| **netplan** | Ubuntu/Armbian 上的网络配置生成器。本仓库**从它迁移到了 NM**，因为 netplan 回答不了"密码错了吗" |
| **supplicant** | 真正跟 AP 协商加密的那层软件（`wpa_supplicant`）。NM 在它上面 |
| **SSID / PSK** | 网络名 / 预共享密钥（也就是 wifi 密码） |
| **AP** | Access Point，接入点 |
| **关联 / association** | 无线链路建立起来。**关联成功 ≠ 拿到 IP** |
| **`BadKey`** | 一个自定义的错误分类：**密码错**。值得单独分出来，因为它是用户唯一能自己修的错误 |
| **D-Bus** | Linux 上的进程间通信总线。有"系统总线"（本程序用的）和"会话总线" |
| **`zbus`** | 一个**纯 Rust** 的 D-Bus 客户端库。configd 用它（NM、BlueZ、logind、systemd 都走它） |
| **polkit** | Linux 的"谁被允许做特权操作"的策略引擎。**这块板子上没有它** —— 这就是 configd 跑 root 的原因 |
| **logind** | systemd 里管登录/关机/重启的那个组件 |
| **`reboot(2)`** | 直接切电的内核调用。**本仓库故意不用它** |
| **BlueZ** | Linux 的蓝牙协议栈 |
| **bonding / 绑定** | 把配对产生的密钥存下来，下次不用重配 |
| **agent** | 向 BlueZ 提供"配对时该问用户什么"的代理。`NoInputNoOutput` = 没有键盘也没有屏幕 |
| **default agent** | BlueZ **只从它**往下推 IO capability —— 这决定了 MITM 保护开不开（§7.1） |
| **`Trusted`** | BlueZ 的一个设备属性。置 true 是**重启后能自动重连的唯一原因** |
| **`Paired`** | 另一个属性。这里被当作"绑定成功了没有"的**唯一事实来源** |
| **BR/EDR vs LE** | 经典蓝牙 vs 低功耗蓝牙。同一个手柄可能**两个都有**（§7.4） |
| **flock** | Linux 的文件锁。用来让多个写者排队 |
| **原子替换** | 先写临时文件再 `rename`。中途失败不会留下半个文件 |
| **fsync** | 强制把数据真正写到磁盘。**目录也要 fsync**，否则 rename 熬不过断电 |
| **journal / journald** | systemd 的日志系统 |
| **单元 / unit** | systemd 眼里的一个服务（比如 `robotd.service`） |
| **`SO_PEERCRED`** | Linux 让你查出"这条 unix socket 对面是谁"的机制 |
| **主 gid** | 进程的主组 ID。**`SupplementaryGroups` 不算** —— 这是这里的陷阱 |
| **provisioning** | 给一块新板子配置 wifi、名字等的过程 |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| `btd` 和 `configd` 的权威设计（英文，写得很好） | [`design/app-path-design.md`](design/app-path-design.md) |
| 蓝牙那边（姊妹篇） | [`btd-primer.md`](btd-primer.md) |
| 手机和机器人之间的协议（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| 服务拆分、IPC 契约、权限模型 | [`design/architecture.md`](design/architecture.md) |
| 怎么配 wifi、怎么改名、怎么配手柄 | [`robot/cheatsheet.md`](robot/cheatsheet.md) · [`robot/pair-a-gamepad.md`](robot/pair-a-gamepad.md) |
| 手机 App 本身 | [`design/mobile-app.md`](design/mobile-app.md) |
| 从笔记本操作机器人的每条命令 | [`robot/duckctl.md`](robot/duckctl.md) |
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
| 手柄的 IMU 姿态怎么来的（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| 手柄配对归 configd，驱动归 padd（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| 摸头检测：麦克风、log-mel、那个门控（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| `robotctl net` / `system` 的对面（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| 装机、更新、诊断的那些工具（姊妹篇） | [`scripts-primer.md`](scripts-primer.md) |
| 鸭子的嗓子：可播种的合成器（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 头部的两个传感器：深度与 IMU（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
