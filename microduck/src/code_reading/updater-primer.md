# `updater/` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> 这个目录是**"永不砖机"这条承诺的实现**：一台已经发出去的机器人，
> 怎么在没有人在场的情况下把自己换成新版本，并且在换坏的时候自己换回来。
> 完整的机制由 [`design/updater-design.md`](design/updater-design.md) 拥有（1,485 行，
> 每一节都被本文引用）；重启顺序由 [`design/restart-order.md`](design/restart-order.md) 拥有；
> 掉到 golden 的那条网由 [`design/boot-recovery-net.md`](design/boot-recovery-net.md) 拥有；
> 策略（不是二进制）那条通道由 [`design/policy-channel-design.md`](design/policy-channel-design.md) 拥有。
> 若本导读与代码不一致，以代码为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：[`hooks-primer.md`](hooks-primer.md)（**更新时**在这块板子上跑的东西）、
> [`scripts-primer.md`](scripts-primer.md)（装机和发布的工具）、
> [`deploy-primer.md`](deploy-primer.md)（`updater.toml` 铺到哪里）、
> [`robotd-primer.md`](robotd-primer.md)（被更新的那个东西）、
> [`robotctl-primer.md`](robotctl-primer.md)（你按的那个按钮）、
> [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md)（`update.*` 那门语言）。

## 目录

1. [一分钟版](#1-一分钟版)
2. [⚠️ 先理清：这个 crate 里有两样东西](#2-️-先理清这个-crate-里有两样东西)
3. [⭐ 核心心智模型：三份状态，五道门](#3--核心心智模型三份状态五道门)
4. [目录地图](#4-目录地图)
5. [一次更新的完整旅程](#5-一次更新的完整旅程)
6. [磁盘上有什么](#6-磁盘上有什么)
7. [信任：签名买到了什么，没买到什么](#7-信任签名买到了什么没买到什么)
8. [健康门：三态，不是二态](#8-健康门三态不是二态)
9. [⭐ 失败与回滚：五条路，一个出口](#9--失败与回滚五条路一个出口)
10. [启动时：四条恢复路径](#10-启动时四条恢复路径)
11. [hooks：更新时在这块板子上跑的东西](#11-hooks更新时在这块板子上跑的东西)
12. [配置：示例 vs 出货，差异就是重点](#12-配置示例-vs-出货差异就是重点)
13. [谁在跟它说话](#13-谁在跟它说话)
14. [几处读者会绊到的地方](#14-几处读者会绊到的地方)
15. [阅读路线](#15-阅读路线)
16. [术语表](#16-术语表)

---

## 1. 一分钟版

`updater/` 回答一个问题：

> **一台装在别人家里的机器人，怎么安全地把自己换掉？**

**"安全"这里有一个非常具体的定义**，`updater/Cargo.toml:5` 的 crate 描述只有一行：

> Signed, health-gated, rollback-safe updates for the robot daemon

而整个 crate 的骨架就是这三个形容词：

| 词 | 意味着什么 | 在哪 |
|---|---|---|
| **Signed** | 机器人只装它验过签名的东西 | §7 |
| **Health-gated** | 换完之后**要证明它能跑**，才算数 | §8 |
| **Rollback-safe** | **任何一步失败，都回到换之前** | §9 |

规模：**约 15,000 行源码 + 约 5,000 行测试**，26 个源文件。

```
   GitHub Releases ──┐
   Hugging Face Hub ─┼──► updaterd ──► /opt/robot/daemon/releases/1.4.2/
   本地目录 ──────────┘        │              current → releases/1.4.2   （一个 rename）
                              │              golden  → releases/1.4.1   （永不删除）
                              │
                              ├── 起一个 systemd transient timer（5 秒后重启自己和 btd）
                              └── 在 /var/lib/robot/updater/ 里留下：锁、更新日志、boot counter、transcript
```

**如果只记一件事**：这个系统的核心不是"下载"，也不是"解压"，
而是**一个符号链接的 `rename(2)`** —— 而围绕它的全部复杂度，
都是为了让那个 rename **要么完全不发生，要么可以被撤销**。

---

## 2. ⚠️ 先理清：这个 crate 里有两样东西

`lib.rs:1` 只有四个字：*"Config-driven update engine."*

而这个 crate 同时是**一个库**和一个**守护进程**：

| | 是什么 | 在哪 | 谁用 |
|---|---|---|---|
| **`updater`（库）** | 引擎：状态机、验证、存储、journal | `src/*.rs` | 测试、`updaterd` |
| **`updaterd`（二进制）** | 外壳：解析参数、加载配置、恢复、服务 socket | `src/main.rs`（901 行） | systemd |

`main.rs:3-5` 讲了为什么这么分：

> **Deliberately thin**: parse args, load config, recover from any interrupted run, then serve.
> **All logic lives in the library so it can be tested without a socket or a robot.**

**"所有逻辑都住在库里，这样测试它就不需要一个 socket 或者一台机器人。"**

### 2.1 ⚠️ 而且"常驻"和"安装"不是一回事

`main.rs:14-20` 有一段很容易被误读的话：

> **Resident is about triggers, not about applying.** Applying an update is **a library call**,
> and mutual exclusion is **a file lock in `state_dir`** rather than a property of there being one
> process. What needs a daemon is everything *around* an update: **a socket for the app to trigger
> through, progress to stream back, a timer so a mandatory release can pull a robot forward with
> nobody present, and a process at boot for the boot counter to recover through.**
> **None of that applies to a robot's first install**, which is what the `install` subcommand is for.

**"常驻说的是触发，不是说执行。"**

### 2.2 那个"必须常驻"的结构性理由

`updater/systemd/updaterd.service:5-15`：

> Two properties this unit must preserve, from `docs/updater-design.md` §4 and
> `docs/architecture.md` §1.1:
>
> **1. NO dependency on robotd.** `updaterd` is **the recovery path** — if it only ran when the
> robot was healthy, it would be unavailable **in exactly the situation a client needs it.**
> **2. `updaterd` is never in the restart set of an update it applies**: restarting itself
> mid-swap would **kill the executor at the most dangerous moment.**

第二条有一个很微妙的后果 —— `updaterd.service:11-15`：

> It is **not left on the old binary either** — the engine schedules its restart through
> **a systemd transient unit 5s after the outcome is on the wire**, which is **a transient unit
> precisely so it outlives this one's cgroup.**

**"一个 transient 单元，正是为了让它活得比这个 cgroup 更久。"**

---

## 3. ⭐ 核心心智模型：三份状态，五道门

### 3.1 三份状态，分别住在哪里

这是理解整个 crate 最重要的一张图。**三份状态各有各的家，而"分开"本身是设计。**

```
  ①  发布树（每次更新都被换掉）
      /opt/robot/daemon/releases/<版本>/          ← 真正的文件
      /opt/robot/daemon/current → releases/<版本>  ← 那个符号链接

  ②  引擎状态（必须活过每一次更新和回滚）
      /var/lib/robot/updater/
      ├── lock              单飞锁
      ├── log               更新日志（200 条）
      ├── runs/NNNNNN.jsonl 每次运行的 transcript（20 份）
      ├── pending           boot counter（一个"试用中"的发布）
      └── rescue            robot-rescue 留下的面包屑

  ③  机器人自己的状态（更新的东西之外的）
      校准、学到的偏好、配对的手柄 …
```

**为什么 ② 必须和 ① 分开**，`updater.example.toml:21-23` 一句话说完：

> Engine-owned state: lock, update log, boot counter.
> **MUST NOT live inside any component's `install_dir` — a swap or a rollback would otherwise
> destroy the record of what happened** (§5.7).

**"一次 swap 或者 rollback 会毁掉'发生过什么'的记录。"**
想一想就明白：如果日志住在被换掉的那棵树里，那么**唯一需要日志的那次更新，正好是把它删掉的那次**。

### 3.2 五道门

```
   ①  环境预检 ──────── 时钟、机器人停着、没有远程会话      ← 在**碰网络之前**
        │
   ②  清单 + 签名 ───── 版本、兼容性、降级、pin
        │
   ③  下载 + 校验 ───── sha256 → 签名                       ← 在**解压之前**
        │
   ④  解压 + 预检孤儿 ── 会不会让某个已装的 unit 没东西可执行
        │
   ───────  ★ 原子交换：current → releases/<新版本>  ★ ───────
        │
   ⑤  post hook → 重启 → 自检 → 健康门
        │
   ┌────┴────┐
 健康       不健康
   │           │
 提交 + 清理   回滚
```

**"任何一步失败都回到换之前"** 这句话的形状，就是这张图：
**门 ①–④ 的失败根本不发生 swap，门 ⑤ 的失败把 swap 撤回去。**

### 3.3 那三条塑造一切的规则

`engine.rs:10-18` 把整个 crate 的规则说成三条：

> Full description in `docs/design/updater-design.md` §7. Three rules shape everything here:
>
> - **Any failure at or after the swap rolls back.** Hook failure, health failure and timeout are
>   all the same outcome — **there is no "mostly applied".**
> - **Nothing is extracted to a live path before signature and hash both pass.**
> - **The boot counter is armed before the swap**, so a crash between swap and health check is
>   still recoverable. **The reverse order would leave an unrecorded bad release live.**

**"没有'大部分装上了'这回事。"**

---

## 4. 目录地图

```
updater/
├── Cargo.toml          ← 库 + 一个二进制 updaterd
├── updater.example.toml  ← 带注释的参考（**不是**出货的那份）
├── src/
│   ├── lib.rs       334  ← ⭐ 门面：Error 枚举 + JSON-RPC 错误码映射
│   ├── main.rs      901  ← updaterd：参数、配置、启动顺序、install 子命令
│   ├── engine.rs   3988  ← ⭐⭐ 状态机本体（**先读这个**）
│   ├── config.rs    986  ← updater.toml 的 schema
│   ├── ipc.rs      1133  ← unix socket 服务 + 访问控制
│   ├── journal.rs   761  ← 更新日志、单飞锁、boot counter、面包屑
│   ├── store.rs     467  ← 发布树：releases/ · current · golden · prune
│   ├── verify.rs    634  ← sha256、minisign、解压（带限额）
│   ├── manifest.rs  275  ← 清单的解析与兼容性判断
│   ├── source/           ← 四个"从哪拿"：github · hf_hub · http · local
│   ├── hooks.rs     603  ← pre/post install 钩子
│   ├── preflight.rs 474  ← 五道预检
│   ├── robot.rs     529  ← 引擎眼里的 robotd（一个 trait）
│   ├── orphan.rs    352  ← "这次降级会不会让某个 unit 没东西可执行"
│   ├── reconcile.rs 373  ← 启动时：重启该重启而没重启的
│   ├── transcript.rs 479 ← 每次运行"做了什么"
│   ├── policy.rs   1662  ← 策略（不是二进制）那条通道
│   ├── account.rs   181  ← 这个机器人属于哪个 HF 账号
│   ├── faults.rs    126  ← 故意注入故障（回滚是唯一会悄悄坏掉的功能）
│   ├── spawn.rs     119  ← ⭐ 一个函数，但它存在的理由比代码值钱
│   ├── fsutil.rs · unix.rs · transcript.rs
└── tests/
    ├── apply.rs    2867  ← 端到端：真的下载、验证、交换、回滚
    ├── ipc.rs      1481  ← 线上的形状 + 访问控制
    ├── install.rs   452  ← 首次安装
    └── download.rs  322  ← 下载与重试
```

### 4.1 ⭐ 那 126 个集成测试

| 文件 | 测试数 | 在测什么 |
|---|---|---|
| **`apply.rs`** | **81** | 端到端状态机，**跑真的引擎代码路径，没有网络也没有机器人** |
| `ipc.rs` | 26 | 真的 `Server` 在真的 unix socket 上，用手写的 JSON-RPC 客户端 |
| `install.rs` | 12 | **真的 `updaterd` 二进制** |
| `download.rs` | 7 | 本地 axum 服务器，测重试与续传 |

`apply.rs:1-10` 说了这一套是为**什么**存在的：

> These are the **Tier-1 mechanism tests** from `docs/design/updater-design.md` §16.2: they drive
> **the real engine code path with no network and no robot, so they cannot drift from production
> behaviour.** **This is the suite that replaces manually reverting a robot, applying an update, and
> eyeballing the result.**
>
> Rollback is the thing most likely to be quietly broken, because it only runs when something else
> already went wrong — **so most of these tests deliberately break something.**

**"这一套测试，取代了'手动回滚一台机器人、装一次更新、然后用眼睛看结果'。"**

#### ⭐ 那个 `regressions` 段

`apply.rs:1457-1460` 有一整段，每个测试对应一个 review 里发现的 bug：

```rust
// ── regressions ──────────────────────────────────────────────────────────────
//
// One test per bug found in review. Each reproduces the original failure, so a
// regression shows up as a specific named failure rather than a vague one.
```

**"一个 bug 一个测试。每个都复现原来的失败，所以一次回归会以一个具名的、具体的失败出现，
而不是一个含糊的失败。"**

而那些 bug 正好就是我 §9 里讲的每一条：

| 编号 | 它钉住的是什么 |
|---|---|
| `#1`（`apply.rs:1462`）| **`rollback` 曾经往*前*走**，走到刚刚失败的那个发布上 |
| `#1b`（`:1498`）| rollback 跳过 journal 记录过"已回滚"的发布 |
| `#3`（`:1530`）| 一个无法恢复的试用**每开机一次就重报一次** |
| `#4`（`:1580`）| boot counter 曾经是**一个全局槽**，任何组件的迁移都会毁掉另一个的试用 |
| `#5`（`:1641`）| `transition_to` 在**校验目标之前**就武装了 boot counter |
| `#9`（`:1674`）| `select` 的 apply action 失败后**提前返回**，板子留在未验证的发布上 |
| `#7`（`:1916`）| `select` 一个没装的版本，报的是 `UNKNOWN_COMPONENT` |
| `#8`（`:1940`）| 没有任何东西拒绝降级 |
| `#8b`（`:1971`）| **显式**点名一个更老的版本仍然允许 |

⚠️ 编号有洞，而且不是文件顺序 —— 见 §14.10。

#### `FakeHub` 里一处**自报**的偏差

`tests/ipc.rs:1182-1185` —— 假 Hub 发了真 HF 不会发的字段，而且说明白了：

> It *does* send an `interval` HF omits, **and only to keep the suite quick**: the robot sleeps one
> interval before its first poll, so **the real five seconds would make every login test five seconds
> long.** That HF's omission falls back to five is pinned in `hf_robot_account`'s own tests, where it
> costs nothing.

**"它*确实*发了一个 HF 会省略的 `interval`，只是为了不让测试套件变慢。"**

---

## 5. 一次更新的完整旅程

以 `robotctl update apply daemon`（或手机上按"更新"）为例。**每一步都标了代码位置。**

### 5.0 拿到锁（在任何事之前）

`engine.rs:624-625`：

```rust
// Single-flight. Busy is a normal answer, not a failure.
let lock = UpdateLock::try_acquire(&self.config.state_dir)?.ok_or(Error::Busy)?;
```

`preflight.rs:6-9` 特意说明它**不**在预检清单里：

> Single-flight is **not** one of these checks: it is enforced by **the on-disk lock**
> `crate::journal::UpdateLock`, taken **before any of this runs**, and surfaces as `Error::Busy`.
> **Listing it here as well would imply a second, redundant mechanism.**

### 5.1 开一份 transcript

`engine.rs:628-642` —— 在**任何**拒绝之前就打开，理由写在 `:706-708`：

> Recorded here rather than at the end, and **before any of the refusals below**: a run that was
> *refused* is **one of the two runs anyone reads**, and "which release, from where, signed by
> which key" is what the refusal has to be read against.

**"被拒绝的那次运行，是任何人会读的两种运行之一。"**

### 5.2 门①：环境预检（**在碰网络之前**）

`engine.rs:684-689`：

```rust
// 0. Environment preflight, *before* touching the network. The manifest
//    fetch is HTTPS, and on a board with no battery-backed RTC it fails
//    certificate-date validation with an opaque TLS error — the clock check
//    exists precisely to diagnose that, so it has to run first.
```

五项检查（`preflight.rs:102-112`）：**时钟 · 磁盘 · 旁载目录 · 机器人停着 · 没有远程会话**。

**它们故意不短路**（`preflight.rs:99-101`）：

> **Deliberately does not short-circuit**: telling the user **"clock is wrong AND disk is full"**
> in one round beats making them fix one, retry, and discover the next.

#### 那五项里最有意思的三项

**① 时钟**（`preflight.rs:24-30`）：

> A board with no battery-backed RTC boots with **a wrong clock**, and HTTPS then fails
> cert-date validation before any download can start. **minisign itself is time-independent,
> but TLS is not.**

判据是一个写死的下限 `CLOCK_FLOOR_UNIX = 1_735_689_600`（2025-01-01），
理由是 *"不需要跟 `timedatectl` 说话"*。

**② 旁载目录 —— 一个 mount namespace 的坑**（`preflight.rs:36-49`，整个文件里最长的一段注释）：

> `updaterd.service` sets **`PrivateTmp=yes`**, which gives the unit **its own `/tmp` *and* its own
> `/var/tmp`**. A release copied to either from a shell — **the obvious place to put one, and where
> `scripts/dev-push.sh` used to put it** — is therefore **not the one this process sees**, and
> **every message downstream is a lie**: "no manifest for version X in `/var/tmp/duck-sideload`",
> **against a directory whose `ls` shows that exact manifest**, its signature and the artifact.
> **Nothing in that output points at the namespace, and the caller has done nothing wrong.**
>
> So it is **a named check rather than a better error message further down**: it fails before any
> lookup, **it says which mount namespace is responsible**, and a board that does not privatise
> `/var/tmp` **passes it without noticing it exists.**

**③ "机器人停着吗" —— 一个不对称**（`preflight.rs:187-189`）：

```rust
// Unreachable counts as safe: if the control loop isn't running, nothing is
// moving — and that is precisely the case where an update is the fix. An answer
// that arrived and could not be read does not, because the loop *is* running.
```

**"沉默 = 安全；一个读不懂的回答 ≠ 安全。"**
而这一条**曾经做错过**，测试里记着（`preflight.rs:381-386`）：

> it used to be made the wrong way: **an unreadable reply was mapped to `Unreachable`, which
> permits a restart, so a `robotd` answering "I am walking" in a shape one field newer was read as
> "go ahead".** **Silence means the control loop is not running. An answer means it is.**
> **Those must not share a verdict, whatever else changes here.**

### 5.3 门②：清单和它的签名

`engine.rs:691-699` —— 五种目标：

```rust
let signed = match &target {
    Target::Latest        => source.latest_manifest().await?,
    Target::Exact(v)      => source.manifest_for(v).await?,
    Target::Ref(git_ref)  => source.manifest_at_ref(git_ref).await?,
    Target::Staging       => source.staging_manifest().await?,
    Target::StagingExact(v) => source.staging_manifest_for(v).await?,
};
```

然后是四个**拒绝**，每一个都有它自己的理由：

| 拒绝 | 什么时候 | 为什么（原文） |
|---|---|---|
| **Pin** | 组件被钉在一个版本上 | 运维的显式选择 |
| **Already current** | 已经装的就是这个版本 | ⭐ **见下** |
| **Downgrade** | `Latest` 解析出的版本比装的旧 | **降级攻击**，见 §7.3 |
| **StagingBehind** | `--staging` 拿到的比装的旧 | 见下 |
| **Incompatible** | `hw_rev` / `model_api` 不满足 | |

#### ⭐ "已经是最新的"曾经是错的答案

`engine.rs:726-737`：

```rust
if Some(&manifest.version) == installed.as_ref() {
    // Correct, and for years the whole answer. It is the wrong *question* in one case: the
    // release is installed and a daemon is serving from a different one. That is what an
    // operator reaching for `apply` is usually trying to fix, and answering "already current"
    // told them there was nothing to fix. The units are named here and restarted after the
    // reply — see `restarts_owed`.
    let stale = self.stale_units(&manifest.version, cfg, store);
    return Ok(ApplyResult::AlreadyCurrent { version: manifest.version, stale });
}
```

**"这说明的是对的，而且多年来就是全部答案。但在一种情况下它回答的是错的问题：
发布装上了，而某个守护进程正从另一个发布提供服务。"**

#### `StagingBehind`：一条为一个人写的错误信息

`lib.rs:84-102` 的 doc comment 是一整段：

> `--staging` resolved to a candidate older than what the board is running, which means the staging
> channel has nothing newer to offer.
>
> **Distinct from `WouldDowngrade` because the operator's next move is different.** That one is a
> **rollback-attack guard**: it says a *mirror* may have gone backwards, and the right response is
> **to distrust the source**. This one says **the source is fine and the channel is simply behind**
> … **Answering "refusing to downgrade" sent the one person who hit it looking for a broken mirror.**

而它的错误信息**本身就是一份操作指南**（`lib.rs:96-102`）：

```
the newest release candidate is {candidate}, and this board is already on {installed} —
nothing more recent is available on the staging channel. A release promoted straight to
stable publishes no candidate, so staging stays at the last version that had one. There is
nothing here to test. To install this older candidate anyway, name it:
  robotctl update apply {component} --staging --version {candidate}
```

**"这里没有东西可测。如果要装这个更老的候选版本，就点名它。"**

### 5.4 门③：下载、校验、解压

`engine.rs:850-905` —— 下载时**顺手把进度报告合并**（见 §5.4.1），
然后在**解压之前**做两件事，顺序是**先哈希、再签名**：

```rust
/// 4. Integrity, then authenticity. Both before anything is extracted.
```

`engine.rs:892-894` 讲了为什么它们要走 `spawn_blocking`：

> Hashing and signature verification stream hundreds of megabytes and take **seconds on this class
> of board**. Run on the async worker they would **stall the IPC tasks that are meant to keep
> answering `status`/`subscribe` while the update runs.**

#### 5.4.1 ⭐ 那个进度条为什么不能一次一条

`engine.rs:71-80`：

> Shortest gap between two download-progress notifications.
>
> The source reports **every HTTP chunk** it writes, which for a release artifact is **thousands of
> events**, and every subscriber pays for all of them. **Over BLE that is fatal rather than
> wasteful**: a progress line is around a hundred bytes, which is **five or six notifications at the
> 20-byte floor `btd` frames to**, and **`btd` drops lines when the client falls behind** — so **a
> phone saw an arbitrary subset of the percentages and a bar that jumped 12 → 61 → 34.**
> **Four a second, each a different whole percent, is a bar that moves smoothly and a stream a
> 20-byte pipe can carry.**

而那个 250 毫秒的闸门**是一个类型而不是三个变量**，理由（`engine.rs:83-86`）：

> Two rules, and **the third method is why it is a type rather than three variables**: a percent
> held back by the gap **has to be published when the download ends**, or **a download whose last
> change lands inside the gap visibly finishes at 97%**.

那个"第三个方法"就是 `flush()`（`engine.rs:133-136`）。而 pump 的收尾也记着同一个教训
（`engine.rs:894-896`）：

> Drop the sender so the pump sees end-of-stream and forwards everything it has; **`abort()` here
> would discard the last few updates, so a download could visibly stall at 97%.**

### 5.5 门④：孤儿检查

解压之后、换之前，有一个**只有降级才会触发**的检查（`engine.rs:930-945`）：

> **5b. Would this release leave an installed unit with nothing to exec?** See `crate::orphan` — **a
> downgrade past the release that introduced a daemon leaves that daemon's unit behind**, and it then
> fails with **`203/EXEC`**, which fails the restart, which reverts the update.

而它为什么在这里而不是在预检里：

> Here rather than in `preflight` because **the candidate's file list does not exist until now**, and
> before the dry run returns because **"will this downgrade work?" is exactly what a dry run is
> asked.** **Nothing has moved yet**: staging is disposable, the boot counter is unarmed, `current`
> still points where it did.

**"还没有任何东西动过。"**

### 5.6 ★ 原子交换

这是整个系统的中心。`engine.rs:1024-1057`，四步，顺序是**承重的**：

```rust
// 7. Publish the release directory with one rename, then arm the boot
//    counter *before* the symlink swap so a crash in between is recoverable.
let release_dir = store.release_dir(&manifest.version);
let _ = std::fs::remove_dir_all(&release_dir);
std::fs::create_dir_all(parent)?;
std::fs::rename(extract_dir, &release_dir)?;      // ① 解压好的树就位

self.boot_counter.arm(&PendingUpdate { … })?;      // ② **先**武装 boot counter

rec.phase(Phase::Swapping, …);
store.swap_to(&manifest.version)?;                 // ③ 一个 rename 换掉 current
```

**为什么 ② 必须在 ③ 之前**，`engine.rs:16-18` 说了：

> **The boot counter is armed before the swap**, so a crash between swap and health check is still
> recoverable. **The reverse order would leave an unrecorded bad release live.**

**"反过来，会留下一个没被记录的坏发布在生产里跑着。"**

设计文档里的那句更短（§7.1）：

> Atomicity is **a single `rename(2)` of the symlink on the same filesystem.** **No half-written
> state is ever live.**

#### 那个 `dry_run` 出口

`engine.rs:945-949` —— 在预检钩子**之前**返回：

```rust
if options.dry_run {
    return Ok(ApplyResult::DryRunPassed { candidate: manifest.version.clone() });
}
```

所以 `--dry-run` 走到这里，**已经验证了签名、哈希、兼容性、和孤儿**，而**没有动任何东西**。

### 5.7 门⑤：换之后的三件事

`post_swap`（`engine.rs:1124-1180`）依次做三件事，**任何一件失败都回滚**：

```
   ①  post-install hook      （120 秒上限）
   ②  apply action           （重启 units / 发信号）
   ③  updaterd 自检          ← ⭐ 见下
   ④  health gate
```

#### ⭐ 那个自检，以及它防的是什么

`engine.rs:2578-2582`：

> Prove the release's `updaterd` can start, before committing to it.
>
> `updaterd` does not restart itself during an update, so **without this a replacement binary that
> cannot start is discovered at the *next boot* — after the commit, with nobody watching, and with
> recovery living inside the very process failing to start.** systemd retries it a few times and
> gives up, **leaving a robot that cannot update its way out.**

**"留下一台没法把自己更新出去（update its way out）的机器人。"**

而那个探针**必须用本次引擎加载的那份配置**（`engine.rs:2595-2598`）：

> The config *this* engine was loaded from, not the flag's default. Without it the probe reads
> `/etc/robot/updater.toml` whatever the running daemon was started with, so **on any board using
> `--config` it validates a file that is not in use — and reports the release as broken when that
> file does not exist.** **Found by `scripts/systemd-test.sh` on its first run.**

### 5.8 提交或回滚

```rust
match gate {
    Ok(()) => {
        rec.phase(Phase::Committing, None);
        self.boot_counter.confirm(component)?;      // 试用结束
        match store.prune(cfg.keep_previous, cfg.golden.as_ref()) { … }
        Ok(ApplyResult::Applied { from: previous, to: manifest.version })
    }
    Err(reason) => { … rollback … }
}
```

**清理是"尽力而为"，但失败必须可见**（`engine.rs:1063-1064`）：

> Pruning is best-effort — the update has already succeeded — but **a failure must be visible, or a
> robot slowly filling its eMMC looks perfectly healthy.**

### 5.9 那个被推迟的重启，和那个"锁必须在 fork 之前放掉"

`engine.rs:650-658`：

```rust
// The lock is released before anything is spawned, and that ordering is load-bearing: a
// fork duplicates every open descriptor in the process, so spawning while holding the
// update lock hands a copy of it to the child — and in a test binary running engines in
// parallel, copies of *other* engines' locks too. It surfaced as unrelated operations
// failing with `Busy`. Nothing below this point touches the store.
drop(lock);
schedule_restarts_if_needed(self.deferred_restarts, &outcome, &rec).await;
```

而那两个被推迟的单元（`engine.rs:2555-2568`）：

```rust
const RESTART_AFTER_REPLYING: [&str; 2] = ["updaterd", "btd"];
/// How long to wait before those restarts, so the reply is on the wire first.
/// The engine runs *inside* the `update.apply` call, so restarting `updaterd` synchronously would
/// hand the client a broken pipe instead of the outcome it waited minutes for. A response is a
/// single write; five seconds is far more than it needs and still faster than any human reaction.
const DEFERRED_RESTART_DELAY: &str = "5s";
```

**"一个响应就是一次 write；五秒远远超过它需要的，而且仍然比任何人的反应快。"**

### 5.10 一句"已经是最新的"里藏着的修复

`engine.rs:2831-2850` 的 `restarts_owed` 是**纯函数**，而它的 doc 讲了为什么单独拆出来：

> **`AlreadyCurrent` with stale units** owes exactly those. Nothing was installed because nothing
> needed to be, and **a daemon is still running something else** … **A stale `updaterd` will not
> restart itself from its own startup path**, so the only thing that ever looks at it is an operator
> running `apply`, **who until now got `already_current`, no restart, and a robot still on the old
> binary.**
>
> Pure, and separated from the scheduling below **for the reason `reconcile::verdict_for` is: which
> outcomes owe what is the part that can be wrong, and arranging each of them on a board costs an
> afternoon apiece.**

**"哪个结果欠哪个重启，是那个可能出错的部分；而在板子上把每一种安排一遍，各要一个下午。"**

---

## 6. 磁盘上有什么

> ⚠️ 这一节和 §10 的**机制**由 [`design/updater-design.md`](design/updater-design.md) §7.1 拥有，
> 实现在 `updater/src/store.rs` 和 `updater/src/journal.rs`。

### 6.1 发布树

```
/opt/robot/daemon/                    ← install_dir（每个组件一个）
├── releases/                         ← 全是**目录**
│   ├── 1.4.1/                        ← 上一个（为回滚留着）
│   ├── 1.4.2/                        ← 新的
│   └── .staging-1.4.3/               ← 正在装的：dl/ 下载的产物 · root/ 解压出来的树
│                                         （装完 root/ 被 rename 成 releases/1.4.3/）
├── current → releases/1.4.2          ← 符号链接（**相对目标**）
├── golden  → releases/1.4.1          ← 符号链接；**永不清理**；robot-rescue 读的那个
├── .current.tmp                      ← 只在一次 rename(2) 期间存在
└── .golden.tmp
```

**`.staging-` 这个前缀是有意的**（`store.rs:23-26`）：

> Marks an in-progress install. **Chosen so it can never parse as a semver version**, which is what
> keeps `Store::list` from ever seeing a staging dir as a real release.

**"选它，是为了它永远不可能被解析成一个 semver 版本。"**

**`golden` 是一个符号链接，而这是一个有意的选择**（`engine.rs:2118-2124`）：

> `scripts/robot-rescue` runs when `updaterd` does not, so **it cannot ask this process for golden
> and must not parse `updater.toml` to find it** — **a release whose `updaterd` rejects that file is
> the likeliest thing the rescue exists for.** **The link is how the answer survives the daemon.**

而它在**每次启动**时重新发布（`refresh_golden_links`，`engine.rs:2125`），
并且**配置了一个没装的 golden 会大声警告**（`engine.rs:2140-2147`）：

> A configured golden that is not installed is not a rollback target, and **a dangling link would
> make the rescue believe otherwise.** **Loud, because it means the never-brick guarantee is
> currently void on this board.**

**"大声（警告），因为它意味着'永不砖机'的保证在这块板子上目前是失效的。"**

#### 两个符号链接的两条规则

**① 目标是相对的**（`store.rs:174-175`）：

```rust
// Store a relative target so the tree stays valid if the mount point
// moves (and so it reads sensibly in a shell).
```

**② 先写一个临时链接，再 `rename` 覆盖上去**（`store.rs:159-164`）：

> Writes a temporary symlink beside the real one and `rename`s it over the top: **`rename(2)` on the
> same directory is atomic, so a concurrent reader sees either the old target or the new one, never a
> missing link.** **Removing and recreating the symlink would open exactly that window.**

**"先把链接删掉再建一个新的，正好会打开那个窗口。"**

而**一个指向不存在发布的链接会被拒绝**（`store.rs:166-172`）：`"refusing to link missing release"`，
理由是（`store.rs:360-362` 的测试）：

> A **dangling `golden`** would tell the rescue it has a target when it does not, and **swapping onto
> it leaves a board that can exec nothing at all.**

### 6.2 ⭐ `rename` 是原子的，但**不**是持久的

这是整份文档里最容易被跳过、而最不该被跳过的一处。`fsutil.rs:3-7`：

> The design's crash guarantees rest on two renames being **both durable and ordered**: **the
> boot-counter record must survive a power cut that also made the symlink swap visible** (§7).
> **`rename(2)` is atomic but not durable — the directory entry can still be in page cache — so
> every rename we depend on is followed by an fsync of the containing directory.**

**"`rename(2)` 是原子的，但不是持久的 —— 目录项可能还在 page cache 里。"**

于是 `fsutil.rs:14-17`：

> fsync the directory containing `path`, making a rename into it durable. **Without this, a power cut
> can leave the swap visible and the pending record gone — precisely the state §7 says cannot
> happen.**

**"没有它，一次断电会让 swap 可见而 pending 记录消失 —— 正是 §7 说不可能发生的那种状态。"**

而 `write_atomic` 的顺序也是承重的（`fsutil.rs:51-53`）：

```rust
// Contents first: a durable rename to a file whose data is still in cache
// would leave a correctly-named empty file.
```

**"先写内容：一次指向'数据还在缓存里'的文件的持久 rename，会留下一个名字正确但内容为空的文件。"**

### 6.3 引擎状态

```
/var/lib/robot/updater/                ← state_dir（config.rs:789）
├── update.lock                        ← 单飞锁。**一个 OS 锁，不是 PID 文件**
├── update-log.jsonl                   ← 更新日志，追加式，保留 200 条
├── pins.json                          ← 运行时版本钉（{"组件": "x.y.z"}）
├── pending.json                       ← boot counter：哪个发布正在"试用"
├── rescued                            ← robot-rescue 写的面包屑
└── runs/000001.jsonl                  ← 每次运行的 transcript，保留 20 份
```

**为什么用 OS 锁而不是 PID 文件**（`journal.rs:166-168`）：

> An OS lock rather than a PID file so **the kernel releases it if `updaterd` is killed** — **a stale
> PID file would leave the robot permanently unable to update**, which is a worse failure than a race.

**"一个陈旧的 PID 文件会让这台机器人**永远**无法更新 —— 那比一次竞态更糟。"**

**为什么 pin 住在 `state_dir` 而不是写回 `updater.toml`**（`journal.rs:205-209`）：

> Kept in `state_dir` rather than written back into `updater.toml`: **a pin is *device state*, so it
> belongs outside the shipped config** (§5.7), and **rewriting a human-edited TOML file in place
> would lose comments and formatting.**

**日志容忍**（`journal.rs:50-53`）：

> Durable enough to survive the power loss a failed update can itself provoke: newline-delimited
> JSON, then `sync_data`. **A torn final line is tolerated on read rather than treated as
> corruption** — **losing the last entry is acceptable; refusing to read the log because of it is
> not.**

**"丢掉最后一条可以接受；因为它而拒绝读整份日志则不可以。"**

**而 `known_bad` 记的是"最近一次的结果"，不是"曾经失败过"**（`journal.rs:134-138`）：

> Used to keep `rollback` from landing back on a release that already failed its gate. **Latest-outcome
> rather than ever-failed, so a version that failed once and later succeeded is not blacklisted
> forever.**

**面包屑是 `key=value`，而理由很实在**（`journal.rs:275-280`）：

> `key=value` rather than JSON because **the writer is a shell script running on a board where things
> are already going wrong, and quoting JSON correctly in `sh` is a way to produce a record nothing
> can read.** Which makes this the reader for it — and **a lenient one on purpose: every field is
> optional.**

**"在一个已经有东西出错、而且是在 `sh` 里正确引用 JSON 的板子上，
那是一种'产生一个没人读得了的记录'的方式。"**

### 6.4 transcript：为什么它不写进 systemd journal

**为什么 transcript 不写进 journal**（`transcript.rs:11-15`）：
**为什么 transcript 不写进 journal**（`transcript.rs:11-15`）：

> `/var/log` on this board is **a zram device** (`deploy/README.md`), so `Storage=persistent` buys
> **survival of a clean reboot and not of a power cut** — and **the updates anyone needs a
> transcript for are disproportionately the ones that end in a power cut.**

**"任何人需要一份 transcript 的那些更新，不成比例地，正是以断电告终的那些。"**

而**记录永远不会让一次更新失败**（`transcript.rs:17-20`）：

> **Recording never fails an update.** Every write here is best-effort and reports failure to the
> journal, because **an update that completed and lost its diary is strictly better than one that
> was abandoned to keep the diary honest.**

---

## 7. 信任：签名买到了什么，没买到什么

### 7.1 三件事，两个签名

`design/updater-design.md` §5.4 的验证顺序：

> verify manifest signature → download artifact → verify sha256 → verify artifact signature.
> **No unsigned bytes are ever executed or extracted to a live path.**

**为什么清单和产物都签名**（`xtask/src/main.rs:653-656`）：

> Both are signed: **the manifest so a robot can trust what it says**, and **the artifact so the
> bytes can be verified independently of it.**

### 7.2 信任锚是一**组**密钥，不是一个

`updater.example.toml:11-15`：

> Trusted minisign public keys. **A signature is valid if it verifies against ANY key here.**
> A *set* rather than one key so **a lost or compromised key is survivable** (§5.4).
> **An empty directory is a fatal error, not an empty allow-list.**

⚠️ **而"从第一张镜像就带上备用密钥"是一条只能做一次的决定**（`deploy/updater.toml:12-15`）：

> All three release public keys go in here **at install time**, even though only `release-1` signs
> today: **a robot can verify only against the set baked into it, so shipping the spares is the one
> chance to make key rotation possible without physically re-flashing.**

**"一台机器人只能对烤进它的那一组密钥验证，所以把备用的发出去，
是让密钥轮换不需要物理刷机的唯一一次机会。"**

### 7.3 ⭐ 签名买不到的两件事

这一节值得整段抄下来（`design/updater-design.md` §8.4）：

> A minisign signature proves an artifact **came from us and wasn't modified**. **It says nothing
> about *when* it was published or whether it is still current.** Two attacks survive a perfectly
> valid signature, and they are **the standard pair for any signed-artifact scheme**:

| | 是什么 | 状态 |
|---|---|---|
| **Downgrade / 回滚** | 提供一个**更旧的、真的签过名的**清单，让机器人走回一个我们撤回的版本 | **已修** |
| **Freeze / 冻结** | 永远提供**当前**那份清单，让机器人永远不知道有修复 | **未修**（§8.4.2） |

> Both are reachable by **anyone who controls what the robot fetches**: a stale or reverted
> CDN/mirror, a cached proxy, DNS interception, or a hostile local network.
> **Neither requires a stolen key.**

#### 降级守卫的**不对称**，而那个不对称就是重点

`engine.rs:745-758` 的注释把每一种目标都过了一遍。结论（§8.4.1）：

> **The asymmetry is the point: the guard blocks what an *attacker* can cause while leaving what an
> *operator* can choose.**

具体地：

| 目标 | 被守卫吗 | 为什么 |
|---|---|---|
| `Latest` | **是** | 攻击者能造成的 |
| `Exact` | 否 | **运维的显式动作**，镜像诱导不出来 |
| `Ref` | 否 | **dev 构建永远是预发布版本，排在它之前的发布下面** —— 守卫它会拒绝每一次分支安装 |
| `Staging` | 是（但由另一个函数） | 见 §5.3 |
| `from_dir` | 否 | **"一个由 root 在命令行上点名的目录不是镜像"** |
| `rollback` / `reset-to-golden` | 不适用 | **根本不看清单**，用的是已装的发布 |

#### ⭐ 那条**明确接受**的风险

§8.4.2 的结尾：

> **Explicitly accepted for v1:** **a robot whose network is hostile can be prevented from
> updating.** It **cannot** be made to *downgrade*, install an artifact we did not sign, or install
> one that fails its health gate. **Those are the properties we actually rely on.**

**"一台网络环境恶劣的机器人可以被阻止更新。它不能被弄成降级、装上我们没签名的东西、
或者装上一个过不了健康门的。"**

**这种"说清楚哪条防线不存在"的写法，比多写一条防线更值得学。**

### 7.4 从哪拿：一个 trait，三个后端

`source/mod.rs:1-6`：

> One trait, three backends: **GitHub Releases (daemon), HF Hub (models), and a local directory.**
> **The local backend is not a toy** — it is how the engine gets tested against **its real code
> path with no network.**

| 后端 | 干什么 | 一个值得知道的细节 |
|---|---|---|
| **`github_releases`** | daemon 通道 | 见下 |
| **`hf_hub`** | 模型通道 | **"HF signs nothing for us"** —— 所以签名是我们自己发的 |
| **`local_dir`** | CI 和旁载 | ⭐ **验证一点都不放宽**，见下 |

#### ⭐ `local_dir` 的验证不放宽

`source/local.rs:9-11`：

> **Signature verification is *not* relaxed here.** A local artifact is verified **exactly like a
> downloaded one**; **sideloading works because the dev key is in the trusted set, not because
> checks are skipped.**

**"旁载能工作，是因为开发密钥在信任集里，而不是因为检查被跳过了。"**

#### ⭐ GitHub 那边两个"不要用现成的"

**① 不要用 `/releases/latest`**（`source/github.rs:3-8`）：

> "Latest" is resolved **by listing releases and taking the highest *semver* among tags matching
> `tag_prefix`, not by using `/releases/latest`: **that endpoint is repo-wide, so it breaks the
> moment a second channel shares the repo**, and **it answers "most recently published" rather than
> "highest version" — which differ as soon as you publish a patch to an older line.**

**"它回答的是'最近发布的'，而不是'版本最高的' —— 而你一旦给一条老的线上发一个补丁，这两者就不一样了。"**

**② 不要用 `browser_download_url`**（`source/github.rs:60-64`）：

> Used in preference to `browser_download_url` because **that one 404s on a private repository,
> with or without a token — verified against this repo.** The API endpoint serves the bytes with a
> token and `Accept: application/octet-stream`, and **works for public repos too, so there is one
> path rather than two.**

#### 那两道**独立**的守卫

`source/github.rs:123-127` —— 一个直接针对"信任一个复选框"的写法：

> **Two independent reasons a build is skipped** — GitHub's `prerelease` flag ***and*** a semver
> prerelease component — because **dev builds (`0.2.0-dev.5.abc1234`) must never become `latest` for
> the fleet, and relying on someone remembering a checkbox is not a safeguard.**

#### HTTP 层的三条

`source/http.rs:3-15`：

> - **TLS is rustls via `rustls-platform-verifier`, so certificate roots come from the *OS trust
>   store* rather than a bundled copy.** That matters for a robot: **roots then follow Debian's
>   security updates instead of needing a daemon release**, and **an operator-installed CA works
>   without a rebuild.**
> - **Bounded.** Every request has a connect timeout, and every download has a **per-chunk** stall
>   timeout. A hung mirror must not hold an update open forever — **but a slow one on a big artifact
>   must not be killed by a total deadline either**, which is why the timeout is **per-chunk rather
>   than overall.**
> - **Resumable.** A dropped connection on a large artifact retries with a **`Range` header instead
>   of starting over. Robots are on domestic wifi.**

而重试**只对值得重试的东西重试**（`source/http.rs:44-52`）：

> A wrong repo, tag or asset name (404) **will be just as wrong in half a second**, so retrying only
> **delays a clear error by the whole backoff budget.** Transport errors and server-side faults are
> the opposite: **domestic wifi drops connections and mirrors have bad minutes.**

#### ⭐ 那个 404 其实是"你需要一个 token"

`source/http.rs:364-368` —— 一段真实事故记录：

```rust
// GitHub answers 404 — not 403 — for a private resource the caller cannot see, so
// as not to disclose that it exists. So the one status that most often means "you
// need a token" was the one suggesting a typo. That cost a real debugging round
// trip on the first board: the repo name was right and the message said it was not.
```

**"那个最可能意味着'你需要一个 token'的状态码，恰恰是那个在暗示'你打错了'的。"

### 7.5 验证层：四个值得学的细节

**① 只用能验证的那个 crate。** `verify.rs:11-13`：

> We depend on `minisign-verify` (**zero dependencies, verify-only**) rather than the full `minisign`
> crate: **this process has no business being able to sign, so it shouldn't link the code that can.**

前半句是常识，**后半句是纪律**。（完整的 `minisign` 只作为 dev-dependency 存在，
用来在测试里签出**真的**签名而不是手写的 fixture。）

**② 空的信任目录是错误，不是空允许列表。** `verify.rs:80-83`：

> An empty keyring is **an error**, not an empty allow-list: **silently trusting nothing looks
> identical to a misconfigured path**, and **guessing wrong here is catastrophic in either
> direction.**

**③ 验证会告诉你**哪把**钥匙放它进来的。** `verify.rs:175-177`：

> Returns the key that matched, so **the update log can record which key admitted the artifact** —
> **useful for spotting a robot still relying on a key we meant to retire.**

**④ 一个被拒绝的条目要大声，不能跳过。** `verify.rs:343-346`：

> `unpack_in` returns `Ok(false)` when the entry path is unsafe (absolute, or escaping `dest`).
> **Treat that as tampering, not something to skip**: **we have already verified the signature, so a
> hostile entry means one of our own keys signed it, which we must surface loudly.**

**"我们已经验过签名了 —— 所以一个恶意的条目意味着是我们自己的某把钥匙签的，那必须被大声说出来。"**

而路径穿越的安全性**是委托出去的**（`verify.rs:282-286`）：

> Path-traversal safety comes from **`tar`'s own `unpack_in`**, which refuses absolute paths and
> entries that would escape the destination, **rather than from a hand-rolled check.** On top of
> that we cap total uncompressed size and entry count, **which the library does not do — a zip bomb
> would otherwise fill the eMMC.**

### 7.6 ⚠️ `schema_version` 不是一道门 —— 而 `engine.rs` 说它是

`manifest.rs:37-46`：

> On-disk/config schema this release expects.
>
> **Not a compatibility gate.** It is **context handed to the post-install hook**, which performs the
> migration (§9). **Gating on it would be self-defeating: the engine evaluating a manifest is always
> the *previous* release's engine, so refusing `schema_version > supported` would make every schema
> bump undeliverable — including the release that brings the engine which understands it.**

**"对 `schema_version` 设门会自我挫败：评估一份清单的引擎永远是*上一个*发布的引擎，
所以拒绝 `schema_version > supported` 会让每一次 schema 升级都无法投递 ——
包括那个带来能理解它的引擎的发布。"**

**而 `engine.rs:155-160` 说的是相反的：**

> Highest on-disk/config schema this build understands.
>
> A release declaring a higher `schema_version` expects migrations this engine has never heard of,
> **so it is refused rather than installed and hoped for.** Bump this in the same change that
> teaches the engine the new layout.

**代码站在 `manifest.rs` 这一边。** `SUPPORTED_SCHEMA_VERSION` 在全 crate 里只出现两次：
定义处（`engine.rs:161`），和填进 `Capabilities` 时（`engine.rs:1987`）——
**而 `Capabilities.schema_version` 的文档（`manifest.rs:82-84`）自己写着
"deliberately *not* compared against the manifest"**，`Manifest::compatibility()` 也从不读它。

**所以 `engine.rs:155-160` 描述的是一道被有意地**没有**建出来的门。**
详见 §14.9。

---

## 8. 健康门：三态，不是二态

### 8.1 三种判决

`robot.rs:52-79` 的 `Health` 有**五个**变体，但对门来说重要的是三个：

| 判决 | 门的动作 | 为什么 |
|---|---|---|
| **`Healthy`** | **提交** | |
| **`Degraded(reason)`** | **也提交** ⭐ | 见下 |
| **`Unhealthy`** / `Unreachable` / `Incompatible` | **回滚** | |

### 8.2 ⭐ 为什么 `Degraded` 要通过

`deploy/updater.toml:163-166`：

> The gate rolls back on *unhealthy*, not on *degraded*. **A robot that cannot see its servos reports
> degraded, and passes**: **it said the same thing before the swap, so reverting cannot fix it and
> would revert every release ever shipped to a bench board.** A release that broke the control loop
> still reverts.

而引擎那边（`engine.rs:2285-2293`）**在提交时大声说出来**：

```rust
Some(crate::robot::Health::Degraded(reason)) => {
    tracing::warn!(
        reason = %reason,
        "committing: the robot is degraded for a reason this release \
         cannot have caused and a rollback cannot fix"
    );
    return Ok(GatePassed::Degraded(reason));
}
```

> Passes. **Logged at warn, not swallowed**: committing a release onto a robot that cannot move is
> the right call, but **nobody should have to guess afterwards that that is what happened.**

### 8.3 `Incompatible`：一个花了某人一小时的 bug

`robot.rs:68-71`：

> Reusing `Unreachable` for it **cost an hour**: the gate reported **"not healthy within 30s:
> unreachable"** about a `robotd` that was **serving its socket and running its loop at 50 Hz**,
> and had merely **omitted one JSON field a newer parser required.**

而 `engine.rs:2297-2302` 的措辞是为此写的：

```rust
Some(crate::robot::Health::Incompatible(reason)) => format!(
    "answered in a shape this updaterd cannot read ({reason}) — \
     the robot may be fine and the contract is what disagrees"
),
```

**"机器人可能是好的，是契约不一致。"**

### 8.4 门是**轮询**的，不是问一次

`engine.rs:2230-2237`：

> Because `robotd` says so. Between its socket opening and its first tick **it answers "control loop
> has not completed a cycle yet"**, and the comment on that line reads: **`"Starting" is not
> "started". The gate polls, so it will see the transition.`** **Anything that decides on this answer
> has to be that gate, or a robot that is merely late is a robot that failed.**

轮询间隔 `HEALTH_POLL_INTERVAL = 500ms`（`engine.rs:69`），总时限来自配置
（`probe = "socket", timeout = "30s"`）。

---

## 9. ⭐ 失败与回滚：五条路，一个出口

### 9.1 一切都在 `transition_to` 里汇合

`engine.rs:1505-1509`：

> Shared tail of **rollback / reset-to-golden / select**: swap, apply, gate, and revert on failure.

而 `apply` 那条路是 `stage_and_swap`。**四个入口，一套尾巴。**

### 9.2 ⚠️ 但是**预检钩子**不在这里面

**这是本导读最想让你记住的一处，因为代码自己的注释在这里是错的。**

`hooks.rs:11-12` 说：

> A non-zero exit is **a failed update and triggers rollback**, identically to a failed health probe.
> **Hooks are part of the gate, not fire-and-forget.**

**这句话对 post-install 钩子是对的，对 pre-install 钩子是错的。**
证据在钩子模板自己的头部（`hooks/preinstall.in:9-13`）：

> Runs after the artifact is downloaded, verified and extracted, but ***before* the swap**. **That
> placement is the whole value: failing here aborts the update with the old release still live,
> no rollback, and no boot-counter churn.** Compare the alternative, which is what actually happened
> on a board — full download, swap, restart, a 30s health gate, a rollback, and **`control loop has
> not completed a cycle yet` as the only explanation.**

而四步的顺序在代码里是明摆着的（`engine.rs:999-1060`）：

```
:999   rec.phase(Phase::RunningPreHook, None);
:1013  hooks::run(extract_dir, HookKind::PreInstall, …)
:1021  hook?;                        ← 在这里返回
:1034  std::fs::rename(extract_dir, &release_dir)   ← 还没发生
:1039  self.boot_counter.arm(…)                     ← 还没发生
:1057  store.swap_to(&manifest.version)             ← 还没发生
```

**所以 `hook?` 返回的时候，`current` 还指着老发布，boot counter 还没武装，
而"回滚"这个概念根本不适用 —— 没有任何东西需要被回滚。**

**为什么这件事重要**：一个新手读 `hooks.rs` 的开头，会得到一个
**"钩子失败 = 回滚"** 的心智模型，而那个模型在**最安全的那条路径上**是错的。
正确的模型是：

| 钩子 | 在 swap 的 | 失败时 |
|---|---|---|
| **`preinstall`** | **之前** | **中止更新，老发布继续跑，没有回滚，没有 boot counter 消耗** |
| **`postinstall`** | **之后** | **回滚** |

**这正是"在 swap 之前失败"比"在 swap 之后失败"便宜得多的地方** —— 也是为什么
`PRE_INSTALL_HOOK_TIMEOUT` 可以有十分钟，而 `HOOK_TIMEOUT` 只有两分钟（见 §11.2）。

### 9.3 回滚落点：两条"用血换来的"约束

`engine.rs:1182-1189`：

> Highest installed release strictly *older* than `current`, skipping any whose most recent recorded
> outcome was a rollback.
>
> **Two constraints, both learned the hard way:**
>
> - **Strictly older.** A plain "newest that isn't current" **walks *forward* after an
>   auto-rollback**, because the release that just failed is still on disk (the failure path
>   deliberately doesn't prune). That would make **`rollback` — the one command a support engineer
>   reaches for after a bad update — reinstall the bad update.**
> - **Not known-bad.** A release the journal recorded as rolled back is not a safe landing spot,
>   even if it is the newest older one.

**"那会让 `rollback` —— 一个支持工程师在一次坏更新之后唯一会去按的那个命令 —— 重新装上那个坏更新。"**

### 9.4 那个"什么都没得回滚"的结果

`engine.rs:1104-1117`：

```rust
// Nothing was reverted, so saying "rolled back" would be a lie.
None => Ok(ApplyResult::Stuck {
    version: manifest.version.clone(),
    reason: format!("{reason}; no previous release and no golden configured, so there \
                     was nothing to revert to"),
}),
```

**"没有任何东西被回滚，所以声称'已回滚'会是一句谎话。"**

### 9.5 最严重的那个结果

`lib.rs:201-205`：

> The update failed *and* the rollback failed. **The most serious outcome — surfaced distinctly so
> support sees it immediately rather than reading it as an ordinary failure.**

```rust
#[error("rollback failed after a failed update: {0}")]
RollbackFailed(String),
```

### 9.6 而回滚本身**是可以被测试的**

`faults.rs:1-10`：

> Deliberate failure injection.
>
> **Rollback is the feature most likely to be quietly broken, because it only runs when something
> else already went wrong.** Making failures injectable turns **"rollback presumably works" into a
> CI assertion.**

**"回滚是最可能被悄悄弄坏的功能，因为它只在别的东西已经出错的时候才跑。"**

九个故障（`faults.rs:13-45`），每一个都写了**它必须导致什么结果**。最巧的两个：

| 故障 | 必须的结果 |
|---|---|
| `abort_after_swap` | *"Abort the process immediately after the symlink swap, to prove a `kill -9` mid-swap leaves a consistent state."* |
| `fail_rollback_apply` | *"Make the apply action fail **while rolling back** … A different outcome from `fail_rollback`, and **the distinction is the point: the robot is back on the known-good release and one unit did not restart.**"* |

而那个开关**双重关闭**（`faults.rs:56-70`）：配置里的 `allow_fault_injection` 必须为真，
**而且未知的故障名也是一个错误** ——

> Fails closed on an unknown name too: **silently ignoring a typo would make a test look like it
> passed when the fault it meant to inject never fired.**

---

## 10. 启动时：四条恢复路径

`updaterd` 每次启动，**在服务 socket 之前**，走四条路。顺序是承重的。

```
   updaterd 启动
      │
      ①  clean_staging()                          清掉上次留下的半成品
      │
      ②  record_rescue()                          ⭐ 上一次是被 robot-rescue 救的吗？
      │
      ③  refresh_golden_links()                   把 golden 符号链接发布出去
      │
      ④  boot_counter.record_boot()               ⭐ 试用中的发布，还撑得住吗？
      │
      ⑤  reconcile_running_units()                ⭐ 该重启而没重启的
      ▼
   开始服务 socket
```

`main.rs:7-9` 讲了为什么这一整套必须在监听之前：

> **Startup order matters.** `Engine::recover_on_start` runs *before* the socket is served, so **a
> robot that booted into a bad release has already begun reverting by the time anything can ask it
> to do something else.**

### 10.1 ⭐ ② 必须在 ④ 之前

`engine.rs:1779-1783`：

```rust
// Before the boot counter, and that ordering is load-bearing: a rescue has already made the
// decision an armed trial was going to make, and further than the trial would have gone.
// Left in place, `record_boot` below would advance that trial and eventually revert to
// `previous` — moving `current` off the golden release the rescue just chose.
```

**"一次 rescue 已经做出了那个武装中的试用本来要做的决定，而且做得更远。"**

### 10.2 ⭐ boot counter：预算决定**何时问**，机器人决定**是否回滚**

这是整个恢复网里最精妙的一处。`engine.rs:1817-1840`：

> **The budget decides when to ask; the robot decides whether to revert.**
>
> A trial reaching this point means **no apply ever confirmed it** — the usual cause being **an
> apply that was killed before its gate ran**, which is what happens when **the release's own
> `hooks/postinstall` restarts `updaterd` mid-apply.** It does *not* mean the release is bad, and
> **reverting one that is working replaces the code under whoever is looking at the robot, having
> told them nothing.**
>
> So the same three-way question `health_gate` asks, in the same words, because the reasoning is
> identical:
>
> - **healthy**: the release works. **Confirm it.** The budget was spent counting boots on a release
>   that was fine all along.
> - **degraded**: the robot is not working *for a reason a rollback cannot fix* … **Reverting hides
>   a hardware fault behind a software change, and the next release will be reverted too.**
> - **anything else**: revert, as before.

设计文档 §8 里有一个**真实发生的**例子：

> a board that had installed a branch build and **paired a gamepad on it** came back two boots later
> **running the stable release**, and **every command afterwards ran against code nobody had
> asked for.**

预算本身是 `MAX_BOOT_ATTEMPTS = 2`（`engine.rs:38`），**每个组件独立** ——

> Every component's trial advances, independently. **A model transition must not consume or clear a
> daemon update's budget.**

### 10.3 ⭐ reconcile：日程排上了 ≠ 它发生了

`reconcile.rs:3-12`：

> An update restarts the units a release ships, then — five seconds after its reply is on the wire —
> restarts the two it could not touch while running: itself, and `btd`. Both are scheduled through
> `systemd-run`, and **scheduling is all that is checked today.** `systemd-run` succeeding means
> **a transient timer was created, not that the restart ran, and not that the new binary started.**
> Failures are **logged and swallowed on purpose**, because **an update that worked must not report
> failure over a restart it could not arrange.**
>
> **That leaves one way for a robot to end up running a release it did not install, and it is
> silent.** This closes it.

它是怎么知道的 —— **每个守护进程自己发布自己的身份**：

> Each daemon publishes its own identity at startup — see `duck_ipc_proto::Identity` — so this
> **reads a file rather than interrogating a process.** A daemon that published nothing is ***not*
> treated as stale**: it is either stopped, or too old to publish, and **restarting a robot's
> daemons because they are old is a decision nobody asked for.**

五个判决（`restart-order.md` §5）：

| 判决 | 何时 | 动作 |
|---|---|---|
| `Current` | 发布版本 == 活跃版本 | 什么都不做 |
| `Restarted` | 两者不同 | `systemctl restart`，warn |
| **`ReportedOnly`** | 两者不同**且这个单元是 `updaterd`** | **只记日志，绝不动手** |
| `RestartFailed` | 试过重启但失败 | error |
| `Unknown` | 没有身份文件 | 什么都不做 |

**`ReportedOnly` 是那个"进程不能从自己的启动路径里重启自己"的直接后果**，
而它的理由值得整段读（`reconcile.rs:37-43`）：

> **Except this one.** `updaterd` restarting itself here would be **a loop** if the new binary ever
> disagreed about what "current" is, and **a loop in the process that owns recovery is the one
> failure with no way out.** It is **reported and left alone**, which is safe: it has just started,
> so anything stale about it was decided before this code ran.
>
> That exception used to be the end of the story, **and it left one skew nothing repaired.** It is
> now reached from the other side: `stale_units` is **the same reading without the acting**, and
> `Engine::apply` calls it when a release turns out to be already installed …

**"一个拥有恢复能力的进程里的死循环，是唯一一种没有出路的失败。"**

而决策函数被单独拆出来，理由和 §5.10 那个 `restarts_owed` 一模一样（`reconcile.rs:78-81`）：

> **Pure, and separated from every syscall in this file for one reason: the decisions are the part
> that can be wrong, and they are impossible to arrange on a real board** — a unit running a release
> that is not the active one is **precisely the state that requires a broken update to produce.**

**"单元跑着一个不是活跃版本的发布 —— 恰恰是需要一次坏掉的更新才能造出来的状态。"**

而它**读文件就能回答**，不需要 `systemctl`、不需要 D-Bus、不需要 `/proc`（`reconcile.rs:168-172`）：

> From the identity the daemon published, so **the answer comes from the process rather than from a
> path someone inferred** — and needs no privilege, no D-Bus and no `/proc` read.

而它为什么在**启动时**做（`reconcile.rs:21-23`）：

> It is **the first moment the answer can be trusted.** `updaterd` cannot watch its own restart land.

---

## 11. hooks：更新时在这块板子上跑的东西

> 完整的机制和那条"凡 `install.sh` 做的，hook 也要做"的规则，由
> [`hooks-primer.md`](hooks-primer.md) 和 [`design/updater-design.md`](design/updater-design.md) §9.1 拥有。
> 这里只讲**从更新引擎的角度**看它是什么。

### 11.1 契约

`hooks.rs:3-9`：

> Hooks **ship *inside* the signed artifact, so no unsigned code ever runs.** Same idea as dpkg's
> `postinst` …
>
> ```
> extract → [pre_install] → symlink swap → [post_install] → apply → health gate
> ```

四个结果（`hooks.rs:108-111`）：

> **A missing hook is success** (`ran: false`) — most releases won't have one. **A
> present-but-failing hook is an error, and so is a timeout**: a hook that hangs must not wedge the
> updater forever, and **an unfinished migration is not a successful one.**

⚠️ **一个不可执行的钩子会被当作"存在"**（`hooks.rs:584-585` 的测试注释）：

> A hook that isn't executable is **a packaging mistake**; it must **fail loudly rather than be
> silently skipped.**

### 11.2 两个预算，差五倍，理由在"在哪里失败"

| 钩子 | 上限 | 常量 |
|---|---|---|
| **post-install** | **120 秒** | `HOOK_TIMEOUT`（`engine.rs:48`） |
| **pre-install** | **600 秒** | `PRE_INSTALL_HOOK_TIMEOUT`（`engine.rs:62-66`） |

`engine.rs:50-66`：

> **Affordable precisely because of where it runs.** **Nothing has been swapped yet, the old release
> is still live and serving, and a hook that runs long is a slow update rather than a robot at
> risk** — where **the same minutes spent in the post-install hook would sit between the swap and
> the restart, with the board running neither release properly.**
>
> … **The number lives in `duck-ipc-proto` because it is a contract with every client, not a private
> budget**: the phase notification arrives before the hook, so **this is the longest an apply can go
> silent, and a client with a shorter idle budget calls a working update a dead robot.**

**"一个 idle 预算比它短的客户端，会把一次正常工作的更新叫做一台死掉的机器人。"**

### 11.3 环境只有 PATH + 上下文

`hooks.rs:132-146`：`env_clear()`，然后一个固定的 PATH ——

> A minimal environment: hooks get what we pass plus PATH, so **their behaviour doesn't depend on
> however systemd happened to invoke us.**

上下文变量（`hooks.rs:59-90`），规则是：

> **Absent values are omitted rather than set empty, so a hook can distinguish "first install" from
> "unknown".**

### 11.4 ⚠️ 那个 `$PWD` / `UPDATE_RELEASE_DIR` 的坑

`hooks.rs:67-69` 说：

> The component's *root* (e.g. `/opt/robot/daemon`), not the release directory.
> **A hook's own location is its cwd, and `$PWD` is the release being installed.**

**对 post-install 钩子，这是对的。对 pre-install 钩子，两半都不对：**

- 引擎调用的是 `hooks::run(extract_dir, …)`，而 `extract_dir = staging.join("root")`
  （`engine.rs:820`）—— **所以 pre-install 钩子的 cwd 是一个 staging 路径，不是发布路径**；
- `UPDATE_RELEASE_DIR` 来自 `store.release_dir(&manifest.version)`（`engine.rs:1006`），
  **而在 pre-install 钩子跑的时候，那个目录还不存在** —— 它是钩子返回之后
  `engine.rs:1034` 那个 rename 创建的。

**船载的 `preinstall.in` 不依赖这两件事**（它用的是相对于 cwd 的 `scripts/…`），
所以这是文档漂移而不是线上 bug。但它正好是那个 `.in` 模板的作者说自己避免了的东西 ——
`hooks/preinstall.in:6-8`：*"there is no copy of the version to keep in step."*

---

## 12. 配置：示例 vs 出货，差异就是重点

`updater/updater.example.toml` 和 `deploy/updater.toml` **是两个不同的文件，而这件事本身是设计**。

`updater.example.toml:7-9`：

> **NOT what ships.** `deploy/updater.toml` is the file `scripts/install.sh` installs on a robot;
> this one documents every option, **including several deliberately absent there.**
> **Where the two differ, the difference is the point — read the comments in both.**

`deploy/updater.toml:7-10` 从另一头说同一件事：

> **The difference from the example is the point**: the example shows **what is possible**, this
> shows **what is true of a shipped robot.** Every value below is **either a decision or a fact**,
> and where the two files disagree **the example's comments explain the option while this file's
> comment explains the choice.**

### 12.1 那些"故意不设"的

| 键 | 示例 | 出货 | 为什么 |
|---|---|---|---|
| `golden` | `"1.0.0"` | **注释掉** | 见下 |
| `allow_dev_keys` | `false` | `false` | 出货文件**就是**让它为 false 的那个 |
| `allow_fault_injection` | `false` | `false` | 同上 |
| **`[component.model-*]`** | 配了两个 | **整个不存在** | 见下 |
| `allow_uids` / `allow_gids` | 注释掉 | 用**名字** | 见下 |

**`golden` 为什么注释掉**（`deploy/updater.toml:87-94`）：

> `golden` is deliberately unset until 1.0.0 exists.
>
> It names a never-pruned known-good release, and `robotctl update reset-to-golden` is the last link
> in the never-brick chain (§8.2). **Naming a version the robot has never installed would make that
> command fail at exactly the moment it is needed**, which is **worse than it reporting honestly
> that no golden is configured.**

**"点名一个机器人从没装过的版本，会让那个命令恰好在最需要它的时候失败。"**

**模型组件为什么整个不存在**（`deploy/updater.toml:172-179`）：

> Absent on purpose, and **this is not an oversight to be fixed by copying the example.**
>
> `updater.example.toml` configures `model-walk` and `model-jump` against **HF repos that do not
> exist yet.** **A component whose source 404s makes every `check` — including the periodic one
> above — report a failure for a component nobody has shipped, which trains whoever reads robot
> status to ignore failures.**

**"这会让每一个 `check` 都为一个人人都没发布过的组件报错，
从而训练读机器人状态的人去忽略错误。"**

**为什么用名字不用 uid**（`deploy/updater.toml:71-78`）：

> By NAME, not by uid: **`systemd-sysusers` allocates dynamically, so a number written here would be
> right on one board and wrong on the next.**
>
> **What must never appear here is `allow_groups = ["robot"]`.** Membership of `robot` is what gets a
> process as far as *talking* to updaterd; **granting it change authority too would collapse the two
> layers into one, and anything that could read status could replace the firmware.**
> **There is a test for that as well.**

### 12.2 `units` 是**追加的**，不是权威的 —— 而那曾经是一个 bug

`deploy/updater.toml:148-156`：

> **The list is additive, not authoritative.** Since the restart set is derived from the units a
> release actually ships, **this only needs to name units the release does *not* ship.** Both entries
> below are therefore **redundant**, and kept because **a config that names what it expects is easier
> to read than an empty list that quietly means "work it out".**
>
> **It used to be authoritative, and that is the bug this replaced**: the file belongs to the
> operator and `install.sh` preserves it, so **a board provisioned before `configd` existed kept
> `units = ["robotd"]` forever and every release swapped configd's binary while leaving the old
> process running.** See `docs/project/install-path-gap.md` §4.

**"那个文件属于运维，而 `install.sh` 会保留它。"** —— 一条"用户拥有的配置文件"和
"发布需要改变的行为"之间的经典冲突，而这里的解法是**把权威性从配置里挪进代码**。

### 12.3 `auto_apply`：一个有序的设置，而不是三个开关

`config.rs` 的 `AutoApply`：

| 值 | 含义 |
|---|---|
| `off` | 永不自动；可用性照常记日志，**强制发布大声记** |
| **`mandatory`（默认）** | **只有清单里的 `min_supported` 说当前版本不该再用时** |
| `all` | 每一个可用的发布（canary / 实验板） |

`updater.example.toml:78-80` 讲了为什么是一个有序的值：

> **One ordered setting rather than a flag per urgency**, so **a config cannot say "apply ordinary
> updates automatically but not mandatory ones"** — auto-updating everything except the releases
> published to rescue a broken fleet.

而那个"永不重复"的规则（`updater.example.toml:85-87`）：

> **a release that already failed its gate on this robot is never retried unattended, whatever the
> policy** — that is what stops **a bad release from becoming an endless apply/rollback loop that
> re-downloads and rewrites the eMMC every interval.**

**"一个坏发布变成一次无休止的 应用/回滚 循环，每隔一个周期就重新下载并重写 eMMC。"**

---

## 13. 谁在跟它说话

### 13.1 四个方法组

`duck-ipc-proto/src/lib.rs:521-534`：

```
update.check  · apply · rollback · resetToGolden · select · pin
update.status · listInstalled · log · show · subscribe
update.progress          ← 通知
policy.check · install · fetch · search
account.login · status · logout
```

### 13.2 ⭐ 两层访问控制

`updaterd.service:48-52`：

> Client access is then **two layers**:
> 1. **socket group (0660)** — who may *talk* to updaterd at all;
> 2. **allow_uids/allow_gids** — who may *change* the robot, enforced from `SO_PEERCRED`.
>    **Root always may; anyone else needs listing. Read-only calls need only layer 1.**

而"只读不设卡"的理由（`updater.example.toml:50-52`）：

> Read-only requests (status, log, listInstalled, check, subscribe) are **NOT** gated: **reaching the
> socket already requires its group (mode 0660), and support must be able to inspect a robot without
> being authorised to change it.**

**"支持人员必须能检查一台机器人，而无需被授权改变它。"**

### 13.3 那个让 socket 长出正确 group 的细节

`updaterd.service:41-43`：

> **`Group=robot` is load-bearing, not cosmetic**: **the socket inherits the process's primary
> group**, so this is what makes the 0660 mode mean "the robot group" rather than "root only".
> **Verified: the socket comes up `srw-rw---- root:robot`.**

### 13.4 慢客户端不会拖慢更新

`ipc.rs:6-15`：

> Requirements that follow from `docs/design/architecture.md` §1.1:
> - **Serving never depends on `robotd` being alive.**
> - **A slow or vanished client must not delay an in-flight update.**
> - **An update runs to completion even if every client disconnects** — the robot pulls, so **BLE
>   dropping mid-update is normal, not an abort.**
>
> Structure: one task per connection, and the `Engine` behind a mutex. **A long operation holds that
> mutex, so read-only requests use `try_lock` and fall back to a cached snapshot rather than
> blocking** — that is what keeps `status`/`subscribe` answerable *during* an update.

---

## 14. 几处读者会绊到的地方

按仓库的规矩，这里只**陈述事实**，不判断该怎么办。

### 14.1 ⚠️ `hooks.rs` 的模块文档把 pre-install 钩子的行为说反了

见 §9.2。`hooks.rs:11-12`：

> A non-zero exit is a failed update and **triggers rollback**, identically to a failed health probe.

**对 pre-install 钩子，没有回滚** —— 它在 swap 之前跑，`hook?`（`engine.rs:1021`）在
`rename`（`:1034`）、`arm`（`:1039`）、`swap_to`（`:1057`）**之前**返回。

而**钩子模板自己说的正好相反**（`hooks/preinstall.in:9-13`）：

> failing here aborts the update with **the old release still live, no rollback, and no
> boot-counter churn.**

设计文档 §9 也只说了 *"Non-zero exit ⇒ failed update ⇒ rollback"*，
**没有区分两个钩子**。

**这是这份文档里最可能误导新手的一处**：一个读 `hooks.rs` 开头的人会得到
"钩子失败 = 回滚"的模型，而在**代价最低、最常发生**的那条路径上，这个模型是错的。

### 14.2 `hooks.rs:67-69` 的 `$PWD` 和 `UPDATE_RELEASE_DIR` 只对 post-install 成立

见 §11.4。对 pre-install 钩子：cwd 是 **staging 目录**，
而 `UPDATE_RELEASE_DIR` 指向一个**还不存在**的路径。

### 14.3 ⚠️ `hooks/preinstall.in:34-35` 点名的上限是错的

那条注释说：

> Below the updater's **120s** ceiling on a hook, so a slow network produces our message naming the
> fix rather than a bare "timed out after 120s".

而 **pre-install 钩子的上限是 600 秒**（`engine.rs:65-66` → `UPDATE_MAX_SILENCE_SECONDS`，`duck-ipc-proto/src/lib.rs:427`）。
120 秒是 **post**-install 的预算（`engine.rs:48`）。

`CURL_MAX_TIME=90` 仍然低于 600，**所以行为是对的** ——
但那条注释承诺了一个"点名 120s"的消息，而它已经不可能出现了。
而这是一个**模板文件**，也就是文档告诉你"改这里"的那个文件。

### 14.4 `hooks.rs:97-98` 的"whatever the outcome"和代码不符

`HookOutcome.output` 的文档说它 *"Logged by `run` whatever the outcome"*。
但非零退出在 `hooks.rs:188-201` **提前返回 `Err`**，在成功才走的日志循环（`:211-215`）**之前**。
`engine.rs:2819-2821` 说的是实际行为：

> `hooks::run` logs its output to the journal **either way**, but a caller takes the outcome with `?`
> and drops it — **so on the failure path the output survives only inside the error message.**

**两句话不可能同时为真，而引擎那句是对的。**

### 14.5 `robot.rs:3-5` 引用了一节不存在的内容

> the engine is built before `robotd` exists (`docs/design/architecture.md` §9).

`architecture.md` §9 是 **"## 9. Open questions"**（`:580`）。
构建顺序在 **§10 Build order**（`:604-612`），那里写着
*"`updaterd` is built against an **interface** to `robotd` … not an implementation"*。

### 14.6 `preflight.rs:57` 说 `detail` 只在失败时有，但有一个通过的检查会设它

字段的文档是 *"Why it failed, safe to display."*，
而 `check_no_remote_session` 返回 `passed: true, detail: Some("session check bypassed by request")`。
引擎只读 `report.first_failure()`，**所以那句旁路说明被构造出来然后掉在地上**。

### 14.7 `hooks.rs:121-124` 给一个没跑过的钩子报 `exit_code: Some(0)`

缺失钩子的结果是 `ran: false` 配一个 `Some(0)`。
`record_hook` 会正确地分支（`engine.rs:2823-2824`：*"this release ships no {hook}"*），
**所以今天没有任何东西读错**；但 `exit_code` 是 `Option<i32>` 正是为了能表达"没有退出码"，
而这里的 `Some(0)` 意思是"那个缺席的钩子成功了"。

### 14.8 `Cargo.toml:7-13` 那段关于拆 crate 的注释，两个条件都还没到

> The `proto` module (the IPC contract) is deliberately self-contained … **Extract it into its own
> crate when either happens:** `btd` needs to speak the protocol, **or** this crate gains heavy
> dependencies (http, tar, zstd, crypto).
>
> **Both are event-triggered, not guesses.**

而 `proto` **已经**被拆出去了（`lib.rs:47-49` 是 `pub use duck_ipc_proto as proto;`），
`duck-ipc-proto` 也已经存在。**所以这段注释描述的是一个已经发生的事件，写在了现在时里。**

（它记的**理由**仍然有效，而且比结论更值得读。）
另外 `Cargo.toml:1-4` 还写着 *"Library + the `updaterd` daemon binary"*，
而 `src/proto` 这个目录已经不存在了。

### 14.9 ⚠️ `engine.rs:155-160` 描述的是一道**没有被建出来**的门

见 §7.6。三处互相矛盾：

| 位置 | 说的是 |
|---|---|
| `engine.rs:157-159` | *"A release declaring a higher `schema_version` … **is refused** rather than installed and hoped for."* |
| `manifest.rs:39` | *"**Not a compatibility gate.**"* |
| `manifest.rs:82-84` | *"deliberately **not** compared against the manifest"* |

**而代码站在 `manifest.rs` 一边**：`SUPPORTED_SCHEMA_VERSION` 只出现在
定义处（`engine.rs:161`）和填进 `Capabilities` 时（`engine.rs:1987`），
`Manifest::compatibility()` 从不读 `schema_version`。

**"被拒绝"这件事从来没有发生过。** 而 `manifest.rs` 给出的理由
（*"评估一份清单的引擎永远是上一个发布的引擎"*）**正是不能建这道门的原因** ——
所以这是一处**过期注释在描述一个被有意否决的设计**，而不是一个未实现的计划。

值得留意：一个新手如果先读 `engine.rs`（那是最该先读的文件），
会得到一个和 `manifest.rs` 完全相反的模型。

### 14.10 `tests/apply.rs` 的回归编号有洞，而且不是文件顺序

`tests/apply.rs:1459` 承诺：

> One test per bug found in review. **Each reproduces the original failure, so a regression shows up
> as a specific named failure rather than a vague one.**

而编号是：`#1`（`:1462`）、`#1b`（`:1498`）、`#3`（`:1530`）、`#4`（`:1580`）、
`#5`（`:1641`）、**`#9`（`:1674`）**、`#7`（`:1916`）、`#8`（`:1940`）、`#8b`（`:1971`）。

**`#2` 和 `#6` 在整个仓库里都不存在**，而且 **`#9` 排在 `#7` 和 `#8` 之前** ——
所以编号也不代表文件顺序。要么那份 review 清单住在这个仓库外面，
要么有两个 bug 修了但没有对应的具名回归测试。

（**这不算错误** —— 126 个测试没有一个被 `#[ignore]`，也没有一个失败。
只是读到这里的人会去找 `#6`。）

### 14.11 `tests/apply.rs:9-10` 的头一句话夸大了

文件头说：

> Rollback is the thing most likely to be quietly broken, because it only runs when something else
> already went wrong — **so most of these tests deliberately break something.**

**实际是 81 个测试里的 27 个**（用了故障注入、`unhealthy()`、`DegradedRobot` 或 `AbsentRobot`），
大约三分之一，不是"大多数"。而它在**文件头**，是读者看到的第一句话。

### 14.12 一处小的：`tests/apply.rs:1455` 的 `fn _unused(_: &Path) {}`

这是个空函数，位置在最后一个 bookkeeping 测试和 "regressions" 横幅之间，
**唯一的用途是让 `apply.rs:12` 那个 `Path` 导入不产生警告**
（其它地方用的都是全限定写法）。它读起来像一次意外。

### 14.13 ⚠️ `store.rs:85` 说"悬空的链接读作 `None`"，而代码返回 `Some`

`store.rs:85-86`：

```rust
/// `Ok(None)` when the link is absent (a fresh robot) or dangling — both are
/// recoverable states, not errors.
```

而 `link_version`（`store.rs:100`）用的是 `fs::read_link`，**`readlink(2)` 在一个悬空的符号链接上
是成功的** —— 它返回目标字符串，不管那个目标存不存在。所以：

```
current → releases/1.4.2      而 releases/1.4.2/ 不存在
      → Ok(Some(1.4.2))       不是 Ok(None)
```

**只有链接的*名字*解析不出 semver 时才会返回 `None`。**
唯一的测试（`store.rs:314-318`）只覆盖了"链接不存在"那一种。

`golden()` 的文档（`store.rs:93-95`）做了同一个断言，而且把两者的等价说得很明确：

> the same answer as for a link that is absent, **because the two are the same situation to anything
> that has to decide whether a rollback target exists.**

**"对任何必须判断'有没有回滚目标'的东西来说，这两种是同一个情况"** ——
而代码里它们不是。

### 14.14 ⚠️ `fsutil.rs` 立的那条规则，在最重要的一处 `rename` 上没有执行

`fsutil.rs:5-7` 立了规则：

> **every rename we depend on is followed by an fsync of the containing directory.**

而 `engine.rs:1034` 那个把解压树变成发布的 `rename` **后面没有跟任何 fsync**
（`fsync_parent` 在整个 crate 里只出现在 `store.rs:202` 和 `engine.rs:2112`）。
`store.rs:202` 那次 fsync 刷的是 `install_dir`（也就是 `current` 那个目录项），
**不是上一步创建的 `releases/` 那个目录项**。

所以代码里**没有表达**"发布目录已经持久了"和"`current` 已经指向它"之间的顺序。
在那个窗口里断电：`current → releases/V` 可以是持久的，而 `releases/V` 不是 ——
**而按 §14.13，读回来的还是 `Some(V)` 而不是 `None`。**

两条诚实的限定：（a）在 ext4 上，文件系统里任何一次 `fsync` 都会强制一次 journal commit，
**所以实践中这大概率被文件系统救了，而不是被代码救了**；
（b）解压出来的文件**内容**从来没有被 fsync 过 ——
所以 `store.rs:11-12` 那句 *"no partially written release is ever live"*
说的是**目录项没有撕裂**，不是**内容扛得住断电**。

### 14.15 ⚠️ `reconcile.rs:114` 的 `ReportedOnly` 分支是死的

`reconcile.rs:109-118`：

```rust
pub fn stale_units(expected: &semver::Version, units: &[String]) -> Vec<String> {
    units.iter().filter(|unit| {
        let verdict = verdict_for(running_release(unit).as_ref(), expected, false);
        matches!(verdict, Verdict::Restarted | Verdict::ReportedOnly)
    })
```

**`is_self` 被写死成 `false`**，而 `verdict_for` 只在 `Some(_) if is_self` 那个分支里
返回 `ReportedOnly`（`reconcile.rs:91`）。**所以 `Verdict::ReportedOnly` 在这里永远不可能匹配。**

而它上面两行的文档说：

> `is_self` is false and both stale verdicts are accepted, **because whether a unit may be restarted
> is the caller's question and not this one's.**

**调用者做不了这个选择** —— 参数是写死的。

**行为仍然是对的**（`updaterd` 确实在名单里，只是被判成 `Restarted` 而不是 `ReportedOnly`），
而且这一条和 §10.3 那个"启动路径上 `updaterd` 从不重启自己"**不冲突**：
`stale_units` 服务的是 `apply`/`select` 那条路，那里**安排**一次延后重启是允许的。
**错的只是那句注释给出的理由，和一个到不了的分支。**

### 14.16 `journal.rs` 里的 "journal" 和 `reconcile.rs` 里的 "journal" 不是同一个东西

**这一条对中文读者尤其重要，因为中文里很容易都译成"日志"。**

| 在哪 | 指的是 | 建议的译法 |
|---|---|---|
| `journal.rs`、`update-log.jsonl` | **更新日志**：引擎自己写的那份 | **更新日志** |
| `reconcile.rs:70` | *"The **journal** has systemd's reason."* —— 实际是 **systemd 的 journal**（`journalctl`） | **系统日志 / `journalctl`** |

`reconcile.rs` 什么都**不写** `update-log.jsonl` —— 它 `tracing::error!` 一条
（`reconcile.rs:145`），而发现只被记进系统日志（`main.rs:598-608`）。

设计文档是**有意**把两者分开的（`updater-design.md` §8.3 有一节就叫 **"Why not the journal."**），
**但源码里的用词没有分开。** 本导读里，前者一律写"更新日志"，后者写"系统日志"。

### 14.17 一处小的：更新日志叫 "append-only"，但它会被重写

`journal.rs:26` 说 *"Append-only record of update attempts."*，
而 `trim`（`journal.rs:82-96`）在超过上限时**读出全部再重写整个文件**：

```rust
// Write-and-rename so a crash mid-trim can't leave a truncated log.
```

**记录本身从不被修改，但文件在超过 200 条时会被重写。**
一个画"它只增不减"箭头的读者会画错。

---

## 15. 阅读路线

**约 15,000 行，但它是一条线，不是一个网。** 按顺序读一遍是可行的。

### 如果只有十分钟

读 §3 那两张图，然后读 `updater/src/engine.rs:2-18`（那三行规则）。
**这个 crate 的一切都是那三行的推论。**

### 路径 A：我想理解"一次更新会发生什么"（约 1.5 小时）

| 步 | 读什么 |
|---|---|
| 1 | `docs/design/updater-design.md` §7（那张状态机图 + §7.1 §7.2 §7.3） |
| 2 | `updater/src/engine.rs:1-190`（模块文档 + 所有常量，每个都有理由） |
| 3 | `updater/src/engine.rs:666-845`（`apply_inner`：整条流水线） |
| 4 | `updater/src/engine.rs:846-1122`（`stage_and_swap`：危险的那一半） |
| 5 | `updater/src/engine.rs:1124-1180`（`post_swap`：换之后的三件事） |

### 路径 B：我想理解回滚（约 1 小时）

| 步 | 读什么 |
|---|---|
| 1 | §9 全文 |
| 2 | `updater/src/engine.rs:1182-1310`（`rollback_target` + `rollback_to`） |
| 3 | `updater/src/engine.rs:1510-1632`（`transition_to`：三个入口共用的尾巴） |
| 4 | `updater/src/faults.rs` 全文（126 行，九个故障各有一句"必须导致什么"） |
| 5 | `updater/tests/apply.rs` 里带 `rollback` 的测试 |

### 路径 C：我在乎"机器人起不来了"（约 1 小时）

| 步 | 读什么 |
|---|---|
| 1 | `updater/src/main.rs:7-20` + `:575-600`（启动顺序） |
| 2 | `updater/src/engine.rs:1773-1985`（`recover_on_start`） |
| 3 | `docs/design/updater-design.md` §8.2（golden） |
| 4 | [`design/boot-recovery-net.md`](design/boot-recovery-net.md) + `scripts/robot-rescue` |
| 5 | `updater/src/reconcile.rs` 全文 |

### 路径 D：我想加一个 source（约 40 分钟）

| 步 | 读什么 |
|---|---|
| 1 | `updater/src/source/mod.rs`（`Source` trait 的形状） |
| 2 | `updater/src/source/local.rs`（最小的一个实现） |
| 3 | `updater/src/source/github.rs`（最常用的那个，以及 tag 前缀的两条流） |
| 4 | `updater/src/verify.rs`（不管哪个 source，验证只有一条路） |

### 路径 E：我想改这个引擎，而不弄坏回滚（约 2 小时）

| 步 | 读什么 |
|---|---|
| 1 | `updater/tests/apply.rs:1-10`（这一套测试为什么存在） |
| 2 | `updater/tests/apply.rs:1457-1460` + 那九个 `#N` 测试（**每个 bug 一个测试**） |
| 3 | `updater/src/faults.rs` 全文（九个故障各自"必须导致什么"） |
| 4 | `updater/tests/apply.rs:23-402`（fixture：一个假发布、一块假板子） |
| 5 | 跑一次 `cargo test -p updater` |

**如果只改一处**：改完先看 `apply.rs` 里有没有一个 `#N` 测试会因为你的改动而失败 ——
**那九条是别人已经踩过的坑**。

### 三条贯穿全文的主线

1. **换之前失败是免费的，换之后失败是昂贵的。** 这一条解释了预检为什么要跑两遍、
   两个钩子的预算为什么差五倍、`dry_run` 为什么在钩子之前返回、
   以及"任何失败都回滚"这句话为什么**有一半是对的**。

2. **沉默必须被解释。** `Degraded` 和 `Unhealthy` 分开，`Unreachable` 和 `Incompatible` 分开，
   "关掉了"和"没装"分开，"没有 transcript"和"第一次"分开 ——
   **这个 crate 里几乎每一处 API 设计，最后都归结成"这句沉默会被读成什么"。**

3. **写下来的理由，比写下来的规则活得久。** `spawn.rs` 只有一个函数，
   而它的 119 行里有一半在解释**为什么别的做法都不行**。
   `hooks.rs:178-180` 记着一个 `truncate` 在多字节字符上 panic 的事故。
   `preflight.rs:36-49` 记着一个 mount namespace 的坑。
   **这个目录里的每一段"血泪注释"，都是一个别人不需要再犯的错误。**

**如果只有十分钟**：§3 那两张图，加上 `engine.rs:2-18`。

---

## 16. 术语表

| 词 | 意思 |
|---|---|
| **component / 组件** | 一个**有自己版本线**的东西：`daemon`、`model-walk`… |
| **channel / 通道** | 一个组件的版本线。这里通道名 = 组件名 |
| **manifest / 清单** | 一份签过名的 JSON，说"这个版本是什么、在哪、多大、要求什么" |
| **artifact / 产物** | 那个 tarball。zstd 压缩的 tar |
| **minisign** | 签名格式。公钥一组放在 `/etc/robot/trusted_keys/` |
| **信任锚 / trust anchor** | 烤进机器人的那组公钥。**只能对它们验证** |
| **sha256** | 内容的哈希。**先验哈希再验签名** |
| **swap / 交换** | `current` 符号链接指向新发布。**一个 `rename(2)`** |
| **`current`** | 指向当前活跃发布的符号链接 |
| **`golden`** | 永不删除的已知good发布。`robot-rescue` 的后备 |
| **`keep_previous`** | 保留几个旧发布。默认 1 |
| **prune / 清理** | 删掉超出 `keep_previous` 的旧发布。**golden 永不被删** |
| **health gate / 健康门** | 换完之后问机器人"你能跑吗" |
| **`Degraded`** | "我不能跑，但不是这次发布的错" → **通过** |
| **rollback / 回滚** | 把 `current` 换回去，再跑一次 apply action |
| **boot counter** | 一个持久化的"这次试用还没被确认"的标记 |
| **boot trial / 试用** | 从 swap 到 confirm 之间的那段 |
| **`MAX_BOOT_ATTEMPTS`** | 2。用完就问机器人，而不是直接回滚 |
| **rescue / 救援** | `scripts/robot-rescue`：**不经过 `updaterd`** 的一个 shell 脚本 |
| **breadcrumb / 面包屑** | rescue 留下的记录，下次启动时被 `updaterd` 读到 |
| **`reconcile`** | 启动时：重启那些该重启而没重启的 unit |
| **identity.json** | 每个守护进程发布的"我在跑哪个发布" |
| **`ReportedOnly`** | 一个 reconcile 判决：`updaterd` 只被记录，从不被自己重启 |
| **hook** | 发布自带的脚本，在 swap 前后运行 |
| **`preinstall` / `postinstall`** | 两个钩子。**前者在 swap 之前，没有回滚** |
| **preflight / 预检** | 五道检查。**任何一道失败都没有副作用** |
| **single-flight / 单飞** | 一次只允许一个更新。用一个文件锁 |
| **`Busy`** | "已经有一个更新在跑了"。**是一个正常答案，不是失败** |
| **journal / 更新日志** | `/var/lib/robot/updater/log`。200 条 |
| **transcript** | 每次运行"**做了什么**"。`runs/NNNNNN.jsonl`，20 份 |
| **`RunEvent`** | transcript 里的一行 |
| **orphan / 孤儿** | 一个已装的 unit 指向一个这次降级里不存在的二进制 |
| **`203/EXEC`** | systemd 的"这个文件没法执行"。孤儿的表现 |
| **upgrade / downgrade** | 往新/往旧。**降级只在显式点名时允许** |
| **freeze / 冻结** | 让机器人永远看不到新版本。**未修的第二种攻击** |
| **`min_supported`** | 清单里的下限：低于它就该强制升级 |
| **`auto_apply`** | 没人按按钮时允许装什么：`off` / `mandatory` / `all` |
| **`on_apply`** | 换完之后做什么：`restart` / `reload` / `none` |
| **`schema_version`** | 磁盘布局的版本。**它不是一道门** —— 是交给钩子的迁移上下文，见 §14.9 |
| **`model_api`** | 模型和守护进程之间的兼容版本 |
| **`hw_rev`** | 硬件版本。v1 只有一个值 |
| **`SPACE_MULTIPLIER`** | 3。磁盘需求 = 产物体积 × 3 |
| **`ETXTBSY`** | "文件正在被写"。`spawn.rs` 那个重试要处理的东西 |
| **transient unit** | `systemd-run` 起的一次性单元。**活得比 `updaterd` 的 cgroup 久** |
| **`SO_PEERCRED`** | 内核告诉服务器"连过来的这个进程是谁" |
| **`PrivateTmp=`** | systemd 给单元一个自己的 `/tmp` 和 `/var/tmp`。**旁载目录的坑** |
| **`zram`** | 用内存当磁盘。**所以 `/var/log` 活不过断电** |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| **更新系统的完整设计（本文每一节都在引用它）** | [`design/updater-design.md`](design/updater-design.md) |
| **什么重启、什么时候重启** | [`design/restart-order.md`](design/restart-order.md) |
| 掉到 golden 的那条网 | [`design/boot-recovery-net.md`](design/boot-recovery-net.md) |
| 策略（不是二进制）那条通道 | [`design/policy-channel-design.md`](design/policy-channel-design.md) |
| **更新时在这块板子上跑的东西（姊妹篇）** | [`hooks-primer.md`](hooks-primer.md) |
| 装机、发布、诊断的工具（姊妹篇） | [`scripts-primer.md`](scripts-primer.md) |
| `updater.toml` 铺到哪里（姊妹篇） | [`deploy-primer.md`](deploy-primer.md) |
| 被更新的那个守护进程（姊妹篇） | [`robotd-primer.md`](robotd-primer.md) |
| `update.*` 那门语言（姊妹篇） | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| 你按的那个按钮（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| 那四个失败是怎么到达板子的（事故记录） | [`project/install-path-gap.md`](project/install-path-gap.md) |
| 空闲时守护进程在干什么 | [`project/idle-cpu.md`](project/idle-cpu.md) |
| 密钥托管、发布流水线的一次性设置 | [`project/ci-setup.md`](project/ci-setup.md) |
| 服务怎么切分、IPC 契约归谁 | [`design/architecture.md`](design/architecture.md) |
| wifi、身份、手柄配对（姊妹篇） | [`configd-primer.md`](configd-primer.md) |
| 蓝牙门房（姊妹篇） | [`btd-primer.md`](btd-primer.md) |
| BLE 的线上契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| 摄像头、WebRTC、远程网关（姊妹篇） | [`mediad-primer.md`](mediad-primer.md) |
| 手柄：按键映射、模式（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| 手柄自己的 IMU（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| 关节角 → 空间中的点（姊妹篇） | [`kinematics-primer.md`](kinematics-primer.md) |
| 控制核心：从读总线到写总线（姊妹篇） | [`duck-control-primer.md`](duck-control-primer.md) |
| 里程计与那张地图（姊妹篇） | [`odometry-primer.md`](odometry-primer.md) |
| 头部的两个传感器（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 深度矩阵与障碍检测（姊妹篇） | [`duck-detect-primer.md`](duck-detect-primer.md) |
| 鸭子的嗓子（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| 摸头检测（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| 仿真的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 那份配置 schema（姊妹篇） | [`robotd-params-primer.md`](robotd-params-primer.md) |
| 笔记本上那个客户端（姊妹篇） | [`duckctl-primer.md`](duckctl-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
