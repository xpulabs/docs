# `duck-ble` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> BLE 那边的机制由 [`design/app-path-design.md`](design/app-path-design.md) 拥有（英文）。
> 两者若有不一致，以设计文档为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：[`btd-primer.md`](btd-primer.md)（蓝牙门房 —— 这个 crate 就是为它和它的客户端的**共同**需求而生的）。

## 目录

1. [一分钟版](#1-一分钟版)
2. [为什么这个"很小"是特性](#2-为什么这个很小是特性)
3. [三个文件，三件必须完全一致的事](#3-三个文件三件必须完全一致的事)
4. [UUID：客户端凭什么认出这台机器人](#4-uuid客户端凭什么认出这台机器人)
5. [分片：把 GATT 特征变成一根管道](#5-分片把-gatt-特征变成一根管道)
6. [广播：31 字节的预算](#6-广播31-字节的预算)
7. [真实客户端长什么样](#7-真实客户端长什么样)
8. [测试](#8-测试)
9. [阅读路线](#9-阅读路线)
10. [术语表](#10-术语表)

---

## 1. 一分钟版

`duck-ble` 是**手机和机器人之间那根线上的"协议"**，而且是**双方共用的同一份代码**。

```text
   手机 App ──┐
   duckctl  ──┼── 都用 duck-ble ──┐
              │                   │   同一份代码
   机器人 btd ────────────────────┘
```

它只有三件东西，每件都是"两边必须**一字不差**地一致"：

| 文件 | 行数 | 是什么 |
|---|---:|---|
| `gatt.rs` | 51 | 服务 UUID 和特征 UUID —— **客户端扫描时找的就是它们** |
| `framing.rs` | 348 | 一条 JSON 消息怎么切成小块、又怎么拼回来 |
| `adv.rs` | 125 | 广播里除了名字还带什么（机器人的 IP 地址） |

**整个 crate 只有一个依赖**（`uuid`），没有蓝牙库、没有异步运行时、没有日志、没有参数解析器。

> lib.rs 的原话：**"这里没有任何东西碰无线电。"**
>
> 它是**字节和算术** —— 所以它能同时编进手机、笔记本和板子。

规模：552 行，**20 个测试**。

---

## 2. 为什么这个"很小"是特性

这是理解这个 crate 的钥匙。`Cargo.toml` 里写着：

> **故意做得极小，而这正是它的功能。** 机器人 BLE 表面的**每一个**客户端都需要这三个模块，
> 而它们**都不需要蓝牙栈**：手机 App 把它编到 `aarch64-apple-ios`，`duckctl` 为三个桌面平台编它，
> `btd` 为板子编它。**在这里加一个依赖，就是给这三者都加** —— 所以门槛很高。

### 2.1 它为什么从 `btd` 里搬出来

这个 crate 原来住在 `btd` 里面。搬出来的理由是一份**账单**：

```text
   如果客户端依赖 btd（而 btd 是一个守护进程）……
       手机 App  →  被迫带上 clap、tracing-subscriber、一堆 tokio feature
       duckctl   →  在 Linux 上被迫带上 bluer 和一个 vendored libdbus
```

> 而 `duckctl` 是一个**跟机器人说话的工具**，不是一个机器人。

设计文档记了这件事：App 为了**一个模块**，把 `clap` 和 `tracing-subscriber` 带进了 iPhone 二进制。
这个 crate 就是**"把它修掉"**，而不是"把它记下来"。

### 2.2 一句话解释全部理由

lib.rs 写得很干脆：

> 它们的共同点是：**第二份实现只会跟自己一致。**
>
> 一个用不同方式分片的客户端，或者一个手工解码广播地址的客户端，**会一直工作到某天不工作为止** ——
> 而那个故障**看起来像机器人的问题**。

这就是为什么这些代码必须共享，而不是各写一份。

---

## 3. 三个文件，三件必须完全一致的事

```text
   ┌───────────────────────────────────────────────────────────┐
   │  gatt.rs  —— "去哪里说话"                                 │
   │    两个 UUID。客户端靠服务 UUID 在扫描结果里认出机器人      │
   ├───────────────────────────────────────────────────────────┤
   │  framing.rs —— "怎么把话说完整"                           │
   │    一条 NDJSON 消息 ⇄ 若干 20~512 字节的蓝牙块             │
   ├───────────────────────────────────────────────────────────┤
   │  adv.rs —— "连上之前能知道什么"                            │
   │    广播里那 4 个字节的 IPv4 地址（+ 怎么区分"没有"和"老版本"）│
   └───────────────────────────────────────────────────────────┘
```

---

## 4. UUID：客户端凭什么认出这台机器人

```rust
pub const SERVICE_UUID: Uuid = uuid!("6f5d2a10-3b47-4c8e-9a1f-2d7e8c4b6019");
pub const RPC_UUID:     Uuid = uuid!("6f5d2a11-3b47-4c8e-9a1f-2d7e8c4b6019");
```

两个**随机生成**的 v4 UUID。注释说明了为什么是随机的而不是推导出来的：

> 它们是**我们的**，而且**一旦有 App 发布过就不能再改**。

（写全了是为了让你 grep 一个值就能找到这段注释。）

### 4.1 为什么只有**一个**特征

```text
   服务 6f5d2a10-…
     └── 特征 6f5d2a11-…   ← 读它拿版本号
                            写它发请求
                            订阅它收回复
```

**同一个特征既写又订阅**，这在 BLE 里完全正常，但它是**刻意的选择**：

> 两个特征（一个写、一个通知）是**更常见**的形状，而且**最先就是那么写的**。
> 它在这里更差，原因很具体：**BlueZ 把"一次写入"和"一次订阅"报告成两个独立的事件**，
> 所以两个特征意味着机器人得**按设备地址**去猜写的一半和通知的一半是不是同一个客户端 ——
> **猜一个关联关系**。用一个特征，两个事件**从构造上**就属于同一个东西，而一条连接就是一个真正的双工流。
>
> 代价：在 nRF Connect 这类通用浏览器里，同一行既是写又是通知，**看起来有点怪**。

### 4.2 那个 read 不是装饰

特征上的 **read** 承担两个职责（`btd-primer.md` §6 有更长的解释）：

1. **它需要加密链路，而订阅不需要** —— 所以它是"客户端必须先配对"的**唯一**强制手段（notify 属性根本没有加密标志）。
2. **它返回 `API_VERSION`**，让版本不一致的客户端在开口之前就能说明白。

---

## 5. 分片：把 GATT 特征变成一根管道

### 5.1 没有长度头

BLE 一次能发的数据很小，所以一条 JSON 消息必须切成很多块。**协议里没有"长度头"这种字段**：

```text
   发送：  {"jsonrpc":"2.0",...}\n        ← 就是普通 NDJSON
   切块：  [20 字节][20 字节][...]
   接收：  拼到看见 \n 为止
```

**帧分隔符就是 NDJSON 本来就有的那个换行**，两个方向都是。注释说这是**安全**的而不是**运气好**：

> `serde_json` 会把字符串里的换行**转义**成 `\n`，所以**原始 `0x0A` 永远不会出现在一个序列化好的 JSON 对象里** ——
> 这正是 NDJSON 能在 unix socket 上工作的同一个性质。

如果加一个长度前缀，那就是一个**只有 BLE 说的第二方言**，每个客户端都得实现它。现在手机只要做 `robotctl` 做的事：**写字节，读到换行**。

### 5.2 四个常量，每个都是一次事故

这是整个 crate 最有价值的部分 —— 每个数字背后都有历史。

#### `FLOOR_MTU = 20`

```text
   任何 BLE 链路都被要求支持的最小有效载荷。
   所以它是唯一安全的**第一**猜测值。
```

（会话开始时还不知道协商出多少，因为 BlueZ 只在**入站写入**时才报告 MTU。）

#### `MAX_ATTRIBUTE_VALUE = 512`

```text
   一个 GATT 特征值最多 512 字节 —— **来自核心规范**（Vol 3, Part F, §3.2.9）。
   它不是 ATT MTU。
```

> **为什么这个区别要命**：大家常说的 MTU 是 **517** = 512 字节的值 + 5 字节的 ATT 开销。
> 所以 517 是每个协议栈都会收敛到的数字，而**只减掉 3 字节的通知头会多出两字节**。

#### `notification_payload(mtu)` —— 那个"丢掉两个字节"的 bug

```rust
pub fn notification_payload(mtu: u16) -> usize {
    usize::from(mtu).saturating_sub(3).clamp(FLOOR_MTU, MAX_ATTRIBUTE_VALUE)
}
```

为什么不是简单的 `mtu - 3`？

> 对一个 CoreBluetooth 协商出来的 517 字节 MTU，`mtu - 3` 得到 514 ——
> 而**交给 central 一个 514 字节的值，它会保留前 512 个字节，丢掉剩下的**。
> **而且是静默地** —— 两边都不报错。

它长什么样：

```json
   机器人发的：  {"security":"wpa_psk"}
   客户端收到：  {"serity":"wpa_psk"}      ← 中间少了两个字节
```

> 更糟的是当丢掉的那一对里**正好包含换行** —— 那一行就**永远不会完整**，
> 调用会一直等到预算耗尽，而机器人**早就回答过了**。
>
> 而单块的回复（`net.status`、`system.info`、`hello`）**全程正常** ——
> 这正是让这个 bug **看起来像"那几个大方法有问题"而不是"每个边界都有问题"**的原因。

#### `MAX_LINE` vs `MAX_REPLY_LINE` —— **两个**方向，**两个**数字

这是这个 crate 里最容易被误解的一处：

| 常量 | 值 | 限制的是**谁** |
|---|---:|---|
| `MAX_LINE` | 8 KiB | **对端能发给我们什么** |
| `MAX_REPLY_LINE` | 64 KiB | **机器人能回答什么** |

```rust
pub const MAX_LINE: usize = 8 * 1024;        // 安全边界
pub const MAX_REPLY_LINE: usize = 64 * 1024; // 信任边界
```

**为什么 `MAX_LINE` 是 8 KiB 而这么紧？** 因为**无线电范围内的任何人都够得着它**。一个从不下换行的 BLE 客户端会让缓冲区无限增长 —— 除非你切断它。

**为什么 `MAX_REPLY_LINE` 必须是另一个数字？** 因为**这两者不一样大，而且曾经是同一个常量**：

> 复用那个紧的（8 KiB）让**每一条超过 8 KiB 的回复都读不出来** ——
> 这悄悄地把 `update.show`（一次普通运行就有几千字节）和 `system.logs`（一屏 journal）
> 从 `duckctl` 手里拿走了，**而 `btd` 把两者都服务得好好的**。
>
> 客户端会报 `no newline within 8192 bytes` —— **读起来像机器人坏了，而机器人没坏**。

一句话记法：**`MAX_LINE` 限制的是对端，`MAX_REPLY_LINE` 限制的是你选择去连接、并且已经信任的机器人。**

### 5.3 `Reassembler`：两半共用的拼装器

```rust
pub struct Reassembler {
    buf: Vec<u8>,
    limit: usize,   // ← 两个方向，两个上限
}
```

**两个构造函数，名字就是用途**：

```rust
Reassembler::new()          // = Default，limit = MAX_LINE（8 KiB）
Reassembler::for_replies()  // limit = MAX_REPLY_LINE（64 KiB）
```

> `Default` 是**紧**的那个，因为**默认值必须是安全的那个** —— `btd` 用默认的就行，不可能不小心拿到松的。
>
> 而 `for_replies()` 是**按方向命名**的，不是"传一个数字进来" ——
> 这样一个读回复的客户端**不可能挑错上限**，而 `btd` **不可能**被误给那个松的。

**三个设计细节：**

**一、一次写入可能带回多行。** `push()` 返回 `Vec<String>`，因为一个客户端把 `hello` 和 `update.status` 打包进一次 40 字节的写入是**高效，不是错**。

**二、出错时清空缓冲区。**

```rust
if self.buf.len() + chunk.len() > self.limit {
    // 清空而不是留着那半行：后面的东西本来也解析不了，
    // 而留着它会让一个对端**钉住内存**。
    self.buf.clear();
    return Err(FramingError::LineTooLong { limit: self.limit });
}
```

**三、错误分两种，因为它们的含义不同。**

```rust
pub enum FramingError {
    LineTooLong { limit: usize },  // 带上限值，因为两个方向不同，消息必须说清撞的是哪个
    NotUtf8,                       // 不是合法 UTF-8，那也不可能是 JSON
}
```

> 两种情况都是"断开连接"，但**日志里不一样**：**一个可能是攻击，另一个只是不会分片的客户端**。

顺带两个体贴的地方：**空行被跳过**（和 `robotd`/`updaterd` 在 socket 上的行为一致），**CRLF 被容忍**（客户端好心加了 `\r` 也不该出错）。

### 5.4 `chunks()`：反过来的那一半

```rust
pub fn chunks(line: &str, mtu: usize) -> Vec<Vec<u8>>
```

两个细节：

- **换行是载荷的一部分**，不是单独的最后一块。这样客户端"拼到换行"就够，**不需要再知道"消息结束了"这回事**。
- **挂掉的 MTU 会被兜住**（`mtu.max(FLOOR_MTU)`）—— 否则一个 0 会除零，一个荒谬的值会**每个字节切成一块**。

### 5.5 那个不能破的性质

```rust
/// 分片和拼装互为逆运算 —— 整个传输层就靠这个性质。
#[test]
fn chunking_round_trips_at_every_mtu() {
    for mtu in [20, 23, 100, 185, 512, 4096] { ... }
}
```

> 从 BLE 的下限一直到比消息本身还大，逐块切、逐块拼，必须原样回来。

---

## 6. 广播：31 字节的预算

`adv.rs` 只干一件事：**机器人把自己的 IPv4 地址放进广播里**。

### 6.1 为什么值得放

因为 **`duckctl scan` 故意不连接任何东西** —— 这正是它在机器人连不上时该被想起来的原因，也意味着**一个列表只能报告广播里带着的东西**。

而列表最常被用来回答的问题就是 **"我该 ssh 到哪"**。地址本来在 `net.status` 里，但读它要付出**一次连接、一次绑定、和 PIN** —— 每台机器人一次。

### 6.2 预算算术

一个传统广播（legacy advertisement）**一共只有 31 字节**：

```text
   ┌────────────────────────────────────────────┐
   │  flags                     3 字节          │
   │  128 位服务 UUID          18 字节 (2+16)   │
   │  厂商数据头                4 字节 (2+2)    │
   │  IPv4 载荷                 4 字节          │
   │                          ─────────         │
   │  合计                     29 / 31          │
   └────────────────────────────────────────────┘
   名字装不下 → 它走"扫描响应"（scan response），那里另有 31 字节
```

> 有一个测试专门断言这个预算（`the_payload_fits_the_budget`）——
> **所以将来载荷要是长大了，必须回到这里来**。

**SSID 不在里面，而且不可能在**：一个 SSID 自己就长达 32 字节，而预算只剩 6 个可用。

### 6.3 公司 ID 不是身份验证

```rust
pub const COMPANY_ID: u16 = 0xFFFF;
```

`0xFFFF` 是蓝牙 SIG 留给**内部/互操作测试**的 ID —— 对一个还没被分配 ID 的项目来说是正确选择。

> ⚠️ **任何人都可以用它**，所以**这个字段不是身份检查**。
> 它只从一个**同时也广播了服务 UUID** 的设备上被读取 —— **UUID 才是判别依据**。

### 6.4 三个函数，和"空白地址"的三种含义

```rust
pub fn address_data(address: Option<Ipv4Addr>) -> Vec<u8>   // 发：None → 0.0.0.0
pub fn address_in(manufacturer_data: &…HashMap…) -> Option<Ipv4Addr>  // 收
pub fn has_address_field(manufacturer_data: &…) -> bool     // ← 这个才是关键
```

**为什么需要 `has_address_field` 这个额外的函数？** 因为**"没有地址"有三种意思**，而它们需要不同的下一步：

| 情况 | `address_in` | `has_address_field` | 意思 |
|---|---|---|---|
| 有地址 | `Some(…)` | `true` | 正常 |
| **字段在，但是 `0.0.0.0`** | `None` | `true` | **机器人没有网络** |
| **完全没有字段** | `None` | `false` | **这是一个比这功能更老的版本** |

> 注释原话：把后两者混为一谈，会**把读的人送去检查一台其实需要更新的机器人的 wifi**。

还有一个边界：**长度必须是正好 4 字节**。别的长度意味着"另一个厂商也在用 `0xFFFF`"，或者"一个我们不认识的格式"—— 两种都不是地址。

---

## 7. 真实客户端长什么样

`duckctl`（笔记本上那个工具）是这套东西的**第一个真实客户端**。看它怎么用，比看文档快：

```rust
use duck_ble::framing::{self, Reassembler};
use duck_ble::gatt::{RPC_UUID, SERVICE_UUID};

// 发一条请求
for chunk in framing::chunks(&line, 20) {
    characteristic.write(&chunk).await?;
}

// 收回复
let mut reassembler = Reassembler::for_replies();   // ← 注意是 for_replies
loop {
    let chunk = characteristic.read().await?;
    for line in reassembler.push(&chunk)? {
        // 一行完整 JSON-RPC
    }
}
```

> 这两处（`duckctl/src/main.rs:1693`/`1702` 和 `1996`/`2009`）**刻意复用**了 `duck_ble::framing`。
>
> 理由值得记住：**分片这件事是"客户端那一半"的真代码，而不是一份可以跟自己达成一致的重写**。
> 如果分片逻辑不对称，这段代码**根本不会工作** —— 所以它是一个**真正的协议测试**，
> 而不是一个"总能和自己意见一致"的实现。

---

## 8. 测试

**20 个测试**（`framing.rs` 15 个，`adv.rs` 4 个，`gatt.rs` 1 个），全部在笔记本上跑，**不需要蓝牙**。

它们的名字就是这份契约的索引：

```text
   ── 拼装 ──────────────────────────────────────────
   a_line_split_across_chunks_reassembles
   several_lines_in_one_chunk_all_come_back
   a_partial_trailing_line_is_retained        ← 半行不能丢，它是下一条消息的开头
   blank_lines_are_skipped
   crlf_is_tolerated
   invalid_utf8_is_refused

   ── 两个方向的边界 ────────────────────────────────
   a_line_without_a_newline_is_refused_at_the_cap
   a_reply_bigger_than_the_request_cap_is_accepted_by_a_client   ← ★
   chunking_round_trips_at_every_mtu                             ← ★
   chunks_terminate_with_exactly_one_newline
   an_absurd_mtu_falls_back_to_the_ble_floor

   ── MTU 算术 ──────────────────────────────────────
   a_corebluetooth_mtu_does_not_exceed_the_value_limit           ← ★
   a_smaller_link_gets_what_its_mtu_allows
   nothing_above_the_cap_gets_through_it
   a_nonsense_mtu_falls_back_to_the_floor

   ── 广播 ──────────────────────────────────────────
   an_address_survives_the_advertisement
   no_wifi_is_a_present_field_and_no_address                     ← ★
   a_payload_of_the_wrong_length_is_not_an_address
   the_payload_fits_the_budget                                   ← ★
```

打 ★ 的五个是**回归测试** —— 每一个都对应一次真实事故：

| 测试 | 钉住的 bug |
|---|---|
| `a_reply_bigger_than_the_request_cap_is_accepted_by_a_client` | 一个常量服务两个方向，`system.logs` 死在客户端 |
| `chunking_round_trips_at_every_mtu` | 整个传输层的地基 |
| `a_corebluetooth_mtu_does_not_exceed_the_value_limit` | 517 MTU 下的静默丢两字节 |
| `no_wifi_is_a_present_field_and_no_address` | "没有网络"和"版本太老"被混为一谈 |
| `the_payload_fits_the_budget` | 广播 31 字节的预算 |

还有一个测试值得单看 —— `a_line_without_a_newline_is_refused_at_the_cap` 断言了**两件事**：

```rust
assert_eq!(r.push(&big), Err(FramingError::LineTooLong { limit: MAX_LINE }));
// 而且缓冲区被释放了，所以对端无法靠重试钉住内存
assert_eq!(r.pending(), 0);
```

> `pending()` 这个方法的存在理由就是"记录一个说到一半就没声了的对端"。

---

## 9. 阅读路线

这是四份导读里最短的一份 —— **整个 crate 只有 552 行，一个下午能通读**。

**第 1 步（10 分钟）**

1. 读 `Cargo.toml` —— 那段"**故意做得极小，而这正是它的功能**"的注释把这个 crate 的存在理由说完了。
2. 读 `lib.rs`（**28 行**）。

**第 2 步 —— 三件东西（40 分钟）**

3. 读 `gatt.rs`（51 行）—— 顺便想想"为什么只有一个特征"。
4. 读 `framing.rs` 的模块头 + 四个常量 + `notification_payload()` —— 就是第 5.2 节。
5. 读 `framing.rs` 的 `Reassembler`（`:79`）、`for_replies()`（`:128`）、`push()`（`:140`）和 `chunks()`（`:181`）。
6. 读 `adv.rs` 全文（125 行）。

**第 3 步 —— 看它怎么被用（20 分钟）**

7. 读 `duckctl/src/main.rs:1690–1710` —— 一个真实客户端的分片循环。
8. 回看 `btd-primer.md` §6 和 §10 —— 机器人那一半是怎么用同一份代码的。

**第 4 步 —— 动手**

```bash
cargo test -p duck-ble        # 20 个测试，不需要蓝牙
```

试试自己写一个分片往返：

```rust
let line = r#"{"jsonrpc":"2.0","id":1,"method":"hello"}"#;
let mut r = Reassembler::new();
let mut got = Vec::new();
for chunk in chunks(line, 20) {          // 用最小的 MTU
    got.extend(r.push(&chunk).unwrap());
}
assert_eq!(got, vec![line.to_owned()]);  // 原样回来
```

再把 `20` 改成 `517`，看看 `notification_payload(517)` 是多少 —— **512，不是 514**。

---

## 10. 术语表

| 术语 | 意思 |
|---|---|
| **BLE** | Bluetooth Low Energy，蓝牙低功耗 |
| **GATT** | BLE 上组织数据的模型：服务（service）里装特征（characteristic） |
| **服务 / service** | 一组相关特征的容器。客户端**扫描时找的就是它的 UUID** |
| **特征 / characteristic** | 一个可以被**读**、**写**、**订阅**的数据点 |
| **UUID** | 128 位的标识符。这里两个都是随机生成的，**一旦有 App 发布就不能改** |
| **MTU** | 一次能传的最大字节数。BLE 保证至少 20，手机通常协商到 500 多 |
| **ATT** | GATT 底下的属性协议。MTU 是 ATT 层的说法 |
| **ATT_MTU - 3** | 一次通知实际能带的载荷 —— 3 是通知头。**但这个算术不够**，见 §5.2 |
| **通知 / notification** | 服务端主动推给客户端的数据块。**发送方向就是靠它** |
| **广播 / advertisement** | 连接建立**之前**唯一的信息来源。传统广播只有 31 字节 |
| **扫描响应 / scan response** | central 主动问"再说详细点"，peripheral 回的第二段 —— **名字装在这里** |
| **central / peripheral** | BLE 的两个角色：central（手机）主动连，peripheral（机器人）被连 |
| **厂商数据 / manufacturer data** | 广播里一块自定义载荷，按"公司 ID"归档 |
| **公司 ID** | 蓝牙 SIG 分配的厂商编号。`0xFFFF` 是**留给测试的**，谁都能用 |
| **NDJSON** | Newline-Delimited JSON，一行一个 JSON 对象 |
| **帧 / frame** | 一条完整的消息。这里**帧分隔符就是换行** |
| **长度头 / length prefix** | 一些协议用来标记"这条消息有多长"的字段。**这里故意没有** |
| **重组 / reassembly** | 把收到的碎块拼回完整的行 |
| **回归测试** | 一个专门用来**防止某个已修好的 bug 复发**的测试 |
| **wire contract** | "线上契约" —— 两端必须完全一致的那部分定义 |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| 蓝牙那套机制的权威设计（英文） | [`design/app-path-design.md`](design/app-path-design.md) |
| 机器人那一半：蓝牙门房（姊妹篇） | [`btd-primer.md`](btd-primer.md) |
| 那个用它的真实客户端 | [`robot/duckctl.md`](robot/duckctl.md) |
| 手机 App 本身 | [`design/mobile-app.md`](design/mobile-app.md) |
| wifi、身份、手柄配对（姊妹篇） | [`configd-primer.md`](configd-primer.md) |
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
