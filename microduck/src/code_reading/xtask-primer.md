# `xtask/` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> 这个目录是**发布侧的一半**：把一次提交变成一台机器人能装的东西，签名，推出去。
> 而它同时是这个仓库**检查自己**的地方 —— 有一半的代码是哨兵，
> 专门盯住那些"两个列表本来应该一致、但只有人记得"的地方。
> 更新系统的那一半（机器人怎么装）由 [`updater-primer.md`](updater-primer.md) 拥有，
> 完整设计由 [`design/updater-design.md`](design/updater-design.md) §16.3 拥有；
> 密钥托管由 [`project/ci-setup.md`](project/ci-setup.md) 拥有。
> 若本导读与代码不一致，以代码为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：[`updater-primer.md`](updater-primer.md)（**另一半**：机器人怎么装）、
> [`scripts-primer.md`](scripts-primer.md)（装机与运维的那些工具）、
> [`hooks-primer.md`](hooks-primer.md)（**§9.1 那条规则**的另一端）、
> [`deploy-primer.md`](deploy-primer.md)（配置内容）。

## 目录

1. [一分钟版](#1-一分钟版)
2. [⚠️ 先理清：它是**两样东西**](#2-️-先理清它是两样东西)
3. [⭐ 核心心智模型：一个会检查自己的仓库](#3--核心心智模型一个会检查自己的仓库)
4. [目录地图](#4-目录地图)
5. [五个子命令](#5-五个子命令)
6. [`package`：一次发布是怎么被打包出来的](#6-package一次发布是怎么被打包出来的)
7. [⭐ 那七组哨兵](#7--那七组哨兵)
8. [密钥的两条纪律](#8-密钥的两条纪律)
9. [`promote`：晋升是**重签**，不是重建](#9-promote晋升是重签不是重建)
10. [谁在调用它](#10-谁在调用它)
11. [几处读者会绊到的地方](#11-几处读者会绊到的地方)
12. [阅读路线](#12-阅读路线)
13. [术语表](#13-术语表)

---

## 1. 一分钟版

`xtask/` 回答两个问题：

> **① 一次提交，怎么变成一台机器人能装的东西？**
> **② 这个仓库里那些"本来应该一致"的东西，怎么保证它们真的一致？**

而它的形状就是这两个答案：

```
   xtask/
   ├── src/main.rs  2,315 行
   │   ├──  :1–848    工具：5 个子命令          ← 回答问题 ①
   │   └──  :849–2315 测试：39 个哨兵           ← 回答问题 ②
   └── tests/       1,127 行
       ├── artifact.rs  409  打开真的 tarball，看里面有什么
       ├── rescue.rs    602  跑真的 robot-rescue
       └── sideload.rs  116  真的走一遍旁载
```

**三分之二的代码是测试**，而这正是这个 crate 最值得学的地方 ——
而且那些测试分成**两层**：一层读源文件，一层把产物拆开（§3.3）。

```
   一次提交
      │
      ▼
   cargo xtask package ──► daemon-1.2.3.tar.zst + manifest.json（未签名）
      │
      ▼
   cargo xtask sign ─────► 两份 .minisig
      │
      ▼
   GitHub Releases ──────► 机器人 updaterd 去拉
                              （见 updater-primer.md）
```

**如果只记一句话**：*"两个列表本来应该一致"是这个仓库反复犯的错，
而 `xtask` 的答案是**让它们不一致时，构建就红**。*

---

## 2. ⚠️ 先理清：它是**两样东西**

### 2.1 第一件：一个**不上机器人**的二进制

`xtask/Cargo.toml:6`：

```toml
publish = false
```

而 `Cargo.toml:9-12` 解释了为什么它必须是一个**独立的 crate**：

> Deliberately a separate crate, not a subcommand of `updater`: **this never ships to a robot.**
> In particular **it links the *full* `minisign` crate (which can sign), while the updater links
> only `minisign-verify` (which cannot)** — **the daemon has no business being able to sign
> anything.**

**"守护进程没有理由拥有签名的能力。"**

这是 [`updater-primer.md`](updater-primer.md) §7.5 那条纪律的另一半：
在那边是"**我能验证，但我不该链接能签名的代码**"，
在这里是"**我能签名，所以我绝不上机器人**"。

**一次决定，两个方向，两个 crate。**

### 2.2 第二件：一堆**读别的文件**的测试

`xtask/src/main.rs` 的后三分之二是一个 `#[cfg(test)] mod tests`，
**39 个测试，几乎全是读仓库里其它文件的文本然后断言**。

它们**不编译任何东西、不需要网络、不需要板子** —— 全是字符串和正则。

而它们的名字自己就说明了性质：

```
every_unit_install_sh_expects_is_packaged
every_script_the_hooks_run_is_packaged
every_hook_in_the_repo_is_packaged
every_sysusers_file_in_the_repo_is_packaged
every_binary_a_packaged_unit_execs_is_staged
every_install_sh_step_reaches_an_updated_board
setup_board_pins_the_same_onnx_target
the_rkaiq_shim_travels_with_its_script
```

**读一遍这些名字，你就知道这个仓库在怕什么。**

---

## 3. ⭐ 核心心智模型：一个会检查自己的仓库

### 3.1 病灶：两个列表

这个仓库反复出现同一类 bug，而 [`design/updater-design.md`](design/updater-design.md) §9.1 把它总结成了一条规则。
形状是这样的：

```
   A 文件里有一个列表          B 文件里有一个应该和它一致的列表
        │                                  │
        └────────── 没有任何东西绑住它们 ───┘

   它们第一次分开的时候，就是出问题的时候。
```

`_build-release.yml:4-7` 说得很直白：

> The one place the release recipe lives, so the staging and stable paths cannot drift apart in
> what they ship — **this repository has been bitten more than once by two lists that were
> supposed to agree.**

### 3.2 ⭐ 那个把答案说透了的注释

`xtask/src/main.rs:851-863` —— **`PACKAGING_SITES` 的文档，是整个 crate 的论点**：

> Every file that packages a release, which is where the `--include` list and the staged binaries
> live. Repository paths, because one of them is not a workflow.
>
> **Named once, because the tests below all read the same files and the recipe has moved before**:
> it used to sit in `release.yml`, and now lives in the reusable `_build-release.yml` that both the
> staging and stable paths call. **A test that kept reading the old name would pass while guarding
> nothing, which is worse than failing.**
>
> `scripts/dev-push.sh` is the third because **it assembles the same artifact from its own copy of
> the same lists** — a laptop build a board actually runs.

**"一个继续读旧名字的测试会在什么都守护不到的情况下通过 —— 那比失败更糟。"**

**这一句话就是整个 crate 存在的理由。** 一个坏掉的测试会响；
**一个守护着空气的测试看起来像覆盖率**，而它比没有测试更危险。

而这个论点在测试里被**反复执行**（`main.rs:915`）：

```rust
assert!(units.len() >= 4, "expected several units, found {units:?}");
```

几乎每一个"从仓库里发现"的测试都有一个这样的下界断言，
配套的措辞通常是 ***"this test is watching nothing"***。

### 3.3 ⭐ 而且它有**两层**哨兵，第二层更硬

**这是读完 `xtask/` 之后最值得带走的一件事。**

`xtask/src/main.rs` 里那 39 个测试**全部是字符串匹配** ——
读两个源文件，断言它们说的是一回事。

而 `xtask/tests/artifact.rs:1-7` 对这个做法有一句很准确的评价：

> Every other packaging test in this repository asserts that two *source files* agree —
> `.github/workflows/*.yml` against `scripts/install.sh`, or a unit's `ExecStart` against a `cp`
> line. **Those are worth having and they are the weaker form: they describe packaging without
> observing it, so they pass whenever the description is self-consistent, including when the
> description is wrong.**

**"它们描述打包，但没有*观察*打包 —— 所以只要那份描述自洽，它们就通过，包括描述是错的时候。"**

于是有两层：

```
   第一层：字符串哨兵（xtask/src/main.rs，39 个测试）
      「A 文件说的和 B 文件说的一致吗？」        ← 便宜，0.4 秒，但只是描述

   第二层：真的打开 tarball（xtask/tests/artifact.rs，5 个测试）
      「真的跑一次 xtask package，然后把产物拆开看里面有什么」   ← 这是观察
```

`artifact.rs:9-12` 记着**为什么需要第二层**：

> **Two bugs reached a board through that gap on the same afternoon.** A release shipped units its
> artifact did not contain, and then — **two commits after a test was added to stop the first one
> recurring** — binaries its units tried to exec. `btd.service` failed with `203/EXEC`, which reads
> on a board **as a broken daemon rather than as an incomplete release.**

**"两个 bug 在同一个下午通过那个缺口到达了一块板子 —— 而第二个是在'阻止第一个重演'的测试加上去之后两个提交。"**

#### ⭐ 第二层能看见、而第一层**结构上**看不见的四件事

`artifact.rs:14-28` 逐条列了，而它们**每一条都是被验证过的**（`:14-15`：
*"verified by breaking each one and watching the old suite stay green"*）：

| # | 什么 | 为什么第一层看不见 |
|---|---|---|
| **①** | **一个没有 unit 执行它的二进制** | 第一层的列表**从 `ExecStart=` 推导**，所以它**结构上**看不见 `robotctl` —— 没有任何东西 exec 它，是 `install.sh` 把它符号链接到操作员的 `PATH` 上 |
| **②** | **文件的权限位** | *"Nothing else in the tree looks at a mode"* |
| **③** | **那个生成出来的钩子** | `hooks/preinstall` 是 `package` 渲染的，不是 `--include` 的；而钩子测试**跳过 `.in` 模板** |
| **④** | **`package` 本身能不能跑** | `src=dest` 的切分、权限赋值、版本漂移守卫、写进 `version.toml` 的 `binaries` 列表 —— 这些**只有切一次发布才能碰到** |

**① 的具体后果**（`artifact.rs:18-21`）：

> Dropping it from the workflow's staging **passes all six existing tests** and yields an artifact
> where **`/usr/local/bin/robotctl` points at nothing.**

**"把它从 workflow 的 staging 里删掉，会让已有的六个测试全部通过，
而产出一个 `/usr/local/bin/robotctl` 指向空气的归档。"**

#### 而第二层**不**复制那份列表

`artifact.rs:35-37`：

> The inputs still come from the workflow YAML, **because those files *are* the production
> packaging recipe** — **reproducing the list here by hand would recreate exactly the drift these
> tests exist to catch.** **What is no longer taken on trust is the result.**

**"在这里手工复制那份列表，会正好重建这些测试存在的意义就是要抓住的那种漂移。
现在不再被信任的是*结果*。"**

**这一句是整件事的关键**：
**输入仍然来自生产的那份配方（否则就是第三份要漂移的副本），
变的只是"我不再相信它的结果，我要把产物拆开看"。**

### 3.4 所以它有**三个**打包站点

```
   .github/workflows/_build-release.yml      31 条 --include   ← 真正的配方
   .github/workflows/dev.yml                 31 条 --include   ← 每次 push
   scripts/dev-push.sh                       31 条 --include   ← 笔记本构建
        └──────────────────────────────────────────┘
                   三份**完全相同**的列表
```

`PACKAGING_SITES`（`main.rs:864-868`）就是这三个路径，
而**每一个覆盖性测试都会把三个站点全查一遍**。

⚠️ 我验证过：**三份列表今天逐字相同**（各 31 条），而且**三份都被测试盯着**。
所以这不是"已知的不一致"，而是"**已知的重复，用测试兜住**"。

**这个仓库选择了"三份副本 + 一个哨兵"，而不是"一份被三处引用"。**
理由是那些站点一个是 YAML、一个是 YAML、一个是 shell，
**抽出一份共享的列表本身就要引入一个新机制**；而一个测试是现成的。

---

## 4. 目录地图

```
xtask/
├── Cargo.toml          31 行  ← 注意 `publish = false` 和那段关于 minisign 的话
├── src/main.rs      2,315 行
│   ├──  :1–38    模块文档：为什么是 Rust 而不是 shell
│   ├──  :40–58   两个常量（VERSION_FILE、SIG_SUFFIX）+ KeyKind
│   ├──  :60–202  `Command` —— 五个子命令，每个参数都有注释
│   ├──  :204–272 main / run
│   ├──  :287–467 `package`  ⭐
│   ├──  :469–589 `keygen`   ⭐
│   ├──  :590–652 `keycheck`
│   ├──  :653–699 `sign_dir`
│   ├──  :700–766 `promote`  ⭐
│   ├──  :768–847 辅助（onnxruntime_versions、render_preinstall_hook、workspace_version、sha256_hex）
│   └──  :849–2315 **测试模块：39 个哨兵** ⭐⭐
└── tests/
    ├── artifact.rs  409  ← 打开打包出来的 tarball，看里面到底有什么
    ├── rescue.rs    602  ← 真的跑 robot-rescue
    └── sideload.rs  116  ← 真的走一遍旁载
```

---

## 5. 五个子命令

`xtask/src/main.rs:60-202`。**每一个参数的文档都在解释一件具体的事。**

| 子命令 | 一句话 | 什么时候用 |
|---|---|---|
| **`package`** | 组装 `.tar.zst` + 未签名的清单 | CI，每次发布 |
| **`sign`** | 给目录里的东西签名 | CI，紧跟 package |
| **`keygen`** | 生成一对密钥 | **一次性**，见 §8 |
| **`keycheck`** | 证明一对密钥能用、而且是一对 | 依赖一把钥匙**之前** |
| **`promote`** | 从 staging 造一份 stable 清单 | 晋升，见 §9 |

### 5.1 `keycheck` 的那句理由

`main.rs:180-184`：

> Worth doing **before** relying on a key. **A key that turns out to be unusable — bad passphrase,
> mismatched pair, truncated file — is discovered either now, or at the moment you need to sign a
> fix for a fleet of robots.**

**"一把结果不能用的钥匙 —— 密码错了、两半对不上、文件被截断 ——
要么现在发现，要么在你需要为一整队机器人签一个修复的时候发现。"**

而它做的是**真的签一次再验一次**（`main.rs:622-635`）：

> Does a **real sign-and-verify round trip** rather than inspecting the files: **a key that parses
> is not necessarily a key that works, and a `.pub` sitting next to a `.key` is not necessarily
> *its* `.pub`.**

**"一把能解析的钥匙不一定是一把能用的钥匙，而一个放在 `.key` 旁边的 `.pub` 不一定是*它*的 `.pub`。"**

### 5.2 `package` 的那条版本检查

`main.rs:288-313` —— **它拦的是"打了 tag 但忘了改 `Cargo.toml`"**：

```rust
// Catch the classic mistake: tagging a release without bumping Cargo.toml, so the
// robot reports a version that doesn't match what it's running.
```

而那个 `is_prerelease_of_it` 的例外有一段很好的论证（`main.rs:294-301`）：

> A dev build is the crate version plus a prerelease tag — `0.2.0-dev.17.abc1234` against a crate
> at `0.2.0` — so its release triple must match while its prerelease component is free.
> **Accepted without `--allow-version-drift` because every branch build would otherwise need the
> escape hatch, and a flag documented as "only for testing the tool itself" would become part of
> the normal path, where it would stop catching the mistake it exists for.**

**"一个被文档写成'只用于测试工具本身'的开关，会变成正常路径的一部分，
而在那里它就不再能抓住它存在的理由了。"**

---

## 6. `package`：一次发布是怎么被打包出来的

`main.rs:287-466`。**八步**，而每一步都有它的理由。

### 6.1 那八步

```
   ① 版本对得上吗            ← 拦住"打 tag 没改 Cargo.toml"
   ② bin/ 里的可执行文件      ← 0o755，机器人直接从发布目录里跑它们
   ③ --include 的额外文件     ← hooks/ 和 scripts/ 是 0o755，其它 0o644
   ④ **总是**生成 hooks/preinstall  ← 从模板，见下
   ⑤ version.toml            ← 让机器人在没网没清单时也知道自己在跑什么
   ⑥ 关掉 zstd 的帧
   ⑦ sha256 + 清单
   ⑧ **第二份**清单（旁载用）
```

### 6.2 ⭐ 那份钩子**不是** `--include`

`main.rs:365-368`：

> The preinstall hook, **always**, generated from its template.
>
> **Not an `--include` the release workflow has to remember**: the board prerequisites it asserts
> **are a property of every release**, and **a check that ships only when someone adds a flag is a
> check that will one day be missing from the release that needed it.**

**"一个只有某个人加了开关才会随发布走的东西，就是某一天会从最需要它的那个发布里缺失的东西。"**

⚠️ **而且如果 `--include` 里已经有它，`package` 会直接报错**（`main.rs:369-374`）：

```rust
if args.includes.iter().any(|i| i.ends_with("=hooks/preinstall")) {
    return Err("hooks/preinstall is generated; remove the --include for it".into());
}
```

**把"你不该做这件事"写成了构建错误，而不是注释。**

### 6.3 那个模板是怎么被渲染的

`hooks/preinstall.in` 是一个**模板**，里面有 `@ONNX_FLOOR@` 和 `@ONNX_TARGET@` 两个占位符。
`render_preinstall_hook`（`main.rs:786-798`）从 `Cargo.toml` 的
`[workspace.metadata.onnxruntime]` 读出来替换，然后：

```rust
if rendered.contains("@ONNX_") {
    return Err("preinstall template still has unsubstituted @ONNX_...@ placeholders".into());
}
```

而它的理由（`main.rs:783-785`）：

> **Generated rather than committed so the hook cannot disagree with the release it ships inside:
> both come from the same `Cargo.toml` in the same build.**

**"生成而不是提交，这样这个钩子不可能和它随行的那个发布不一致：两者来自同一次构建里的同一份 `Cargo.toml`。"**

⚠️ **而那条检查有一个测试**（`main.rs:2205-2206`）：

> **The shipped hook must be fully substituted.** A placeholder reaching a board would be
> **compared against a version number and silently fail every board the same way.**

**"一个到达板子的占位符会被拿去和一个版本号比较，并且在每一块板子上以同样的方式静默失败。"**

### 6.4 ⭐ zstd 等级：一个解释得很清楚的默认值

`main.rs:322-327`：

> Level 19 by default: **publishing is a one-off, download bandwidth is not.**
>
> But this is single-threaded, and the cost is set by what you feed it. **A release packs stripped
> aarch64 binaries in ~15s; CI's smoke test packs unstripped debug ones and took ~400s at the same
> level** — over half of that job, for an artifact it deletes. Hence `--zstd-level`, so the
> throwaway case can pay level 1.

**"发布是一次性的，下载带宽不是。"**
而"~15 秒 vs ~400 秒"的差别**不是压缩等级，是喂进去的东西**（strip 过的发布 vs 没 strip 的调试版）。

### 6.5 ⚠️ 那个必须 `drop` 的 encoder

`main.rs:395-398`：

```rust
builder.finish()?;
// Dropping the builder finishes the zstd frame; without this the archive is
// truncated and only fails when someone tries to read it.
drop(builder);
```

**"不写这一行，归档就是被截断的 —— 而它只在有人试图读它的时候才失败。"**

（这个坑在 `updater` 那边也出现过一次：`updater/src/verify.rs:490-494` 的测试里同样要显式 `drop`。）

### 6.6 为什么要**两份**清单

`main.rs:428-437`：

> A second manifest whose `url` is a bare filename, which is what `LocalDir` expects. **Emitted here
> so both variants are signed in the same pass:**
>
> - **CI verifies the release through the robot's own code path without needing the signing key a
>   second time** (fewer places the key is handled is worth more than one fewer file);
> - **a developer can drop artifact + this manifest into a directory and sideload it.**

**"少一个处理密钥的地方，比少一个文件更值钱。"**

---

## 7. ⭐ 那七组哨兵

**这是这个 crate 最值得读的部分。** `main.rs:849-2315`，39 个测试，
按它们盯的东西分成七组 —— 而 §7.7 是**另一层**（`tests/` 里那 26 个，真的观察而不是描述）。

### 7.1 覆盖性：东西**在**产物里吗（5 个）

| 测试 | 盯什么 | 它防的那次事故 |
|---|---|---|
| `every_unit_install_sh_expects_is_packaged`（`:888`） | `install.sh` 装的每个 unit | **见 §11.1** |
| `every_script_the_hooks_run_is_packaged`（`:935`） | 钩子 `script=scripts/…` 引用的每个脚本 | 钩子跳过一个没打包的脚本，然后 `mediad` 因为缺插件起不来 |
| `every_sysusers_file_in_the_repo_is_packaged`（`:1915`） | `*/systemd/sysusers.d/*.conf`（**从仓库里发现**） | *"a unit naming a `User=` that does not exist does not start, and the error reads as a broken daemon rather than as a missing account"* |
| `every_hook_in_the_repo_is_packaged`（`:1961`） | `hooks/` 下除 `.in` 外的每个文件 | 没有 `hooks/postinstall` 的发布，**悄悄回到"每块板子都要手动一步"** |
| `every_binary_a_packaged_unit_execs_is_staged`（`:1999`） | 每个 unit 的 `ExecStart=` 指的那个二进制 | ⭐ 见下 |

#### ⭐ 那第五个，和它记着的事故

`main.rs:1987-1997`：

> Every binary a packaged unit tries to exec must be staged into the artifact.
>
> **The sibling of the test above, and the case it missed.** The units were packaged and **the
> binaries were not**, so `btd.service` failed with **`203/EXEC`** — systemd could not execute
> `/opt/robot/daemon/current/bin/btd` **because the release did not contain it.** **That reads on
> the board as a broken daemon rather than as an incomplete artifact**, and **it cost a second
> install cycle to find.**
>
> **Derived from the units rather than from a list kept by hand**: each unit names its binary in
> `ExecStart`, so **adding a service and forgetting to stage it fails here. A hand-kept list would
> have exactly the drift this exists to catch.**

**"一份手工维护的列表，会正好带上这个测试存在的意义就是要抓住的那种漂移。"**

**注意这五个测试的共同结构**：
**它们不读一份清单，它们从别的地方*推导*出应该是什么** ——
从 `install.sh` 的调用、从钩子的 `script=` 行、从仓库的目录结构、从 unit 的 `ExecStart=`。

**这是这一整组的设计原则**：一份手工维护的"应该打包什么"的列表，
**会带上它要防的那种漂移**。

### 7.2 ⭐ §9.1 那条规则的**执行者**（1 个，两张表）

§9.1 的规则是：**"`install.sh` 对一块板子做的任何事，钩子也要做"**
（见 [`hooks-primer.md`](hooks-primer.md) 和 [`scripts-primer.md`](scripts-primer.md)）。

**而它一直是靠人记着的 —— 直到这个测试。**

`main.rs:1013-1031`，`every_install_sh_step_reaches_an_updated_board` 的文档：

> This is the direction `docs/design/updater-design.md` §9.1 is about, **and the one nothing
> watched.** `every_script_the_hooks_run_is_packaged` above checks that a script a hook *already
> names* ships; **it cannot notice a step no hook names at all.**
>
> **That is the mistake, four times**: units left where systemd never looks, a GStreamer stack only
> provisioning installed, a `setup-npu.sh` packaged beside its model and never called, and a
> `/etc/profile.d` snippet that sat in `install.sh` alone **while every board in the fleet updated
> past it.** **The fourth went unnoticed for a month because it is cosmetic** — the robot works, the
> prompt is just wrong — **which is the argument for a test rather than for a rule people are
> supposed to remember.**

**"第四个月才被发现，因为它是外观问题 —— 机器人能用，只是提示符不对 ——
而这正是'要一个测试'而不是'要一条人们应该记住的规则'的理由。"**

#### 它是怎么做的：两张**必须写明理由**的表

```
   install.sh 里每一个 install_* 调用
        │
        ├──► 在 ALSO_ON_UPDATE 里？    → 好，钩子也做（1 条）
        ├──► 在 FIRST_INSTALL_ONLY 里？ → 好，但**你得写下为什么**
        └──► 都不在？                   → ❌ 测试失败
```

`FIRST_INSTALL_ONLY`（`main.rs:995-1011`）的三条，每条都是一个**理由**：

| 步骤 | 为什么只有全新安装需要 |
|---|---|
| `install_config` | *"`/etc/robot/*.toml` belongs to the board：`install.sh` will not overwrite an existing `updater.toml`, and an update must not either"* |
| `install_dev_key` | *"a trust anchor is the operator's decision. **A release that installed trusted keys would be granting itself trust**"* |
| `install_token_dropin` | *"the fetch credential is supplied by whoever runs the install and is **never in an artifact**"* |

**"一个给自己安装信任锚的发布，就是在给自己授权。"**

#### ⭐ 而它诚实地说了自己不是证明

`main.rs:1028-1031`：

> **This is a forcing function, not a proof.** An author **can** satisfy it by adding a name to
> `FIRST_INSTALL_ONLY` — **but they have to write down why an already-provisioned board does not
> need the thing they just added, and every one of the four would have failed at that sentence.**

**"这是一个强制函数，不是一个证明。"**
**"作者可以把名字加进 `FIRST_INSTALL_ONLY` —— 但他必须写下'一块已经装好的板子为什么不需要他刚加的这个东西'，而那四次里有哪一次能写出这句话？"**

**这是这个仓库里关于"测试能做什么、不能做什么"最诚实的一段。**

### 7.3 版本钉：`Cargo.toml` 是唯一真相（5 个）

**同一个陷阱，出现了五次**：

```
   Cargo.toml 里有一个版本号
        │
        └──► 某个脚本里有一个**字面量**，因为那个脚本是 `curl` 单独抓下来的，
              **读不到 Cargo.toml**
```

| 测试 | 钉的是什么 |
|---|---|
| `setup_board_pins_the_same_onnx_target`（`:2075`） | ONNX Runtime 的 target |
| `setup_npu_pins_the_same_runtime`（`:2164`） | NPU runtime |
| `setup_gstreamer_pins_the_same_plugin_version`（`:2185`） | GStreamer 插件版本 |
| `seed_policies_pins_the_same_policy_set`（`:1193`） | 策略集的 repo + 版本 |
| `seed_detector_pins_the_same_detector`（`:1216`） | 检测器的 repo + 版本 |

而每一次都记着**漂移的代价**。最具体的是 ONNX 那个（`main.rs:2070-2073`）：

> `scripts/setup-board.sh` is fetched standalone with `curl`, so **it cannot read Cargo.toml and
> has to carry a literal version.** This is what stops that literal drifting from the value the
> preinstall hook is generated with — **the exact failure that left 1.20.1 on a board against an
> `ort` that requires 1.23 and panics below it.**

**"正是那个把 1.20.1 留在一块板子上、去面对一个要求 1.23、低于它就 panic 的 `ort` 的失败。"**

**注意这五条为什么不能靠"抽出一份共享的配置"解决**：
那些脚本**是独立下载的**，它们运行的时候根本不在仓库里。
**所以唯一的办法就是把两份东西绑在一个测试里。**

### 7.4 「东西跟着它的脚本走」（2 个）

| 测试 | 什么必须跟着 |
|---|---|
| `the_rkaiq_shim_travels_with_its_script`（`:2100`） | `scripts/rkaiq-modinfo-shim.c` |
| `the_npu_overlay_travels_with_its_script`（`:2133`） | `deploy/overlays/rk3568-npu-enable.dts` |

而它们**为什么不被 §7.1 那个脚本测试覆盖**（`main.rs:2093-2098`）：

> **Not covered by `every_script_the_hooks_run_is_packaged`**, which watches `script=scripts/…`
> assignments in the hooks: **the shim is not a script anything runs, it is a source file the script
> compiles.** Packaged without it, **the engine is installed and then segfaults on this kernel** —
> which **looks like a broken camera rather than a missing file.**

**"它不是一个被运行的脚本，它是一个被脚本编译的源文件。"**
而失败的样子是 ***"看起来像摄像头坏了，而不是一个文件没打包"***。

NPU 那个的版本（`main.rs:2129-2131`）：

> Packaged without it, the hook installs the runtime, cannot find the `.dts`, and **leaves the NPU
> node disabled** — so the detector runs on the CPU for ever and **the log line saying why is one
> warning in an update that succeeded.**

### 7.5 播种器：那些"交班"规则（~15 个）

这一组是**最多**的，全部在跑真的 `scripts/seed-policies.sh` / `seed-detector.sh`，
把 Hub 换成一个临时目录（`seed()` 在 `main.rs:1151`）。

核心是几条**交班规则**：

| 测试 | 规则 |
|---|---|
| `policies_this_script_did_not_install_are_left_alone`（`:1765`） | ⭐ **不是这个脚本装的集合，永远不碰** |
| `a_set_past_the_pin_is_left_alone`（`:1639`） | pin 是**下限**不是上限 |
| `a_set_below_the_pin_is_moved_up_to_it`（`:1662`） | 但低于下限要被抬上来 |
| `an_unreachable_hub_installs_nothing_and_does_not_fail`（`:1751`） | 网络不通**不能让更新失败** |
| `a_partial_download_does_not_replace_a_working_set`（`:1787`） | 半个下载不替换一个能用的集 |
| `a_manifest_file_name_that_climbs_out_is_ignored`（`:1531`） | `../../` 不下载 |

#### ⭐ 那个"过去是陷阱"的规则

`main.rs:1629-1637`，`a_set_past_the_pin_is_left_alone`：

> **A set past the pin is never moved back to it.**
>
> The pin is **a minimum** — what a board with nothing gets, and the oldest set the daemon runs
> with — **and not a ceiling.** This **used to** replace any older set on the reasoning that a
> daemon update was still how a retrained gait reached a board; `robotctl policy update` is now how,
> and **that rule was a trap.** A board moved forward to v2 by hand had `current -> releases/seed-v2`,
> which **matches the `seed-*` the seeder called its own**, so **the next unrelated daemon update
> would have put v1 back — silently reverting somebody's gait as a side effect of a binary update.**

**"下一次无关的守护进程更新会把 v1 放回去 —— 作为一次二进制更新的副作用，静默地回退掉某个人的步态。"**

#### 那个 `sed` 解析器的测试

`main.rs:1432-1437`：

> **The seeder's `sed` must match what the manifest actually says.**
>
> **There is no JSON parser where that script runs** — a release on a board with `curl` and a POSIX
> shell — so the file list is extracted with **one pattern** over a file whose shape is ours.
> **That is fine exactly as long as the two agree, and silently downloads nothing the moment they
> do not.**

**"它在两者一致的时候完全没问题，而在它们不一致的那一刻静默地什么都不下载。"**

而那个测试的做法很漂亮：**它把 `sed` 表达式从脚本里*抠出来*，拿它当子进程跑**，
喂一个手工写的 `manifest.json`，断言四个文件名按顺序回来。

### 7.6 那些"仓库全局"的检查（4 个）

| 测试 | 盯什么 |
|---|---|
| `the_preinstall_template_renders_completely`（`:2208`） | 没有 `@ONNX_` 漏网 |
| **`the_board_test_container_script_contains_no_single_quotes`**（`:2240`） | ⭐ 见下 |
| `printed_commands_name_absolute_paths`（`:2282`） | 打印给操作员的命令必须是绝对路径 |
| `the_detector_file_list_is_the_same_everywhere`（`:1241`） | 一份文件列表在**三个**地方必须一致 |

#### ⭐ 那个单引号的测试，和它记的那次事故

`main.rs:2227-2238`：

> `board-test.sh` hands its whole container script to `sh -c` inside **one single-quoted string**,
> so **a single quote anywhere in it ends that string early.**
>
> **Both ways this fails are quiet.** An apostrophe in a comment — *"the oneshot's job"* — leaves
> the file syntactically broken, **which at least fails loudly.** **Worse is a quoted argument:**
> `grep -q '^\[Install\]'` arrives at the container as `grep -q ^\[Install\]`, and the shell there
> strips the backslashes, so grep is handed `^[Install]` — **a bracket expression matching one
> character from `I n s t a l`.** It runs, **it exits 0 or 1 for the wrong reason**, and **the
> assertion built on it reports something that was never checked.** That is how this test came to
> exist, and **finding it took a CI round trip and a while.**

**"它跑了，它因为错误的原因退出 0 或 1，而建立在它之上的那个断言报告了一件从来没有被检查过的事情。"**

（这也是我在 [`scripts-primer.md`](scripts-primer.md) 里记过的那条 CI 注释的另一端 ——
那边是"两个撇号是配平的，所以语法合法，而内容被静默地搞坏了"。）

#### 那个绝对路径的测试，和它**承认**的局限

`main.rs:2270-2280`：

> Advice the provisioning scripts print must be **runnable from where the operator is standing**,
> which is their home directory and not wherever the file was downloaded to.
>
> `setup-board.sh` told people to run `sudo sh migrate-network.sh` — **a bare relative name for a
> sibling script that a fresh board has not fetched at all.** Both halves of that were wrong, and
> **neither is the kind of thing anyone re-reads once their own board works.** Comment lines are
> exempt: **explaining the trap requires quoting it.**
>
> **It catches literals only.** A `sh $VAR` holding a relative path passes, because the value is not
> knowable here — so **this narrows the failure rather than closing it.**

**"它只抓字面量……所以这缩小了失败，而不是关掉了它。"**

**这种"说清楚我的测试抓不到什么"的写法，和 §7.2 的"这是一个强制函数，不是一个证明"是同一种诚实。**

### 7.7 ⭐ 第二层：`xtask/tests/` 那 26 个（真的**观察**）

**这一组和上面六组有本质区别：它们跑真的东西。**

| 文件 | 测试 | 它跑什么 |
|---|---|---|
| **`artifact.rs`** | **5** | **真的 `cargo xtask package`**，然后把产出的 `.tar.zst` **拆开** |
| **`rescue.rs`** | **18** | **真的 `sh scripts/robot-rescue`** 和 `robot-boot-check`，配一个**假的 `systemctl`** |
| **`sideload.rs`** | **3** | 纯文本分析，但它检查的是**两个文件之间**的约定 |

#### `artifact.rs`：那五条

| 测试 | 断言 |
|---|---|
| `the_artifact_carries_what_install_sh_reads`（`:208`） | `systemd/updaterd.service`、`systemd/robotd.service`、`bin/robotctl`、`scripts/robot-rescue`**且可执行**、≥4 个 `.service` |
| `every_unit_in_the_artifact_can_exec_what_it_names`（`:272`） | ⭐ 产物里每个 unit 的 `ExecStart=` 指的东西**真的在里面** |
| `the_boot_recovery_net_is_packaged_whole`（`:320`） | 恢复网的四件套齐全；**`robot-boot-check.service` 里没有 `[Install]` 段** |
| `hooks_are_packaged_executable`（`:356`） | 两个钩子都在，**且都有可执行位** |
| `every_include_lands_where_the_workflow_says`（`:391`） | 每条 `--include` 的 `dest` 真的落到了那个位置 |

**每一个断言都点名 `install.sh` 里的某一行**，理由（`artifact.rs:203-205`）：

> Each assertion names a line of that script rather than a general principle, **because the script is
> the consumer and its failure modes are what this is defending.**

##### 那个"没有 `[Install]` 段"的检查

`artifact.rs:337-339`：

> Both installers `enable --now` every unit that has one, and **doing that here runs a rollback check
> in the middle of the update that installed it — with daemons legitimately mid-restart, which is
> what it reads as a broken release.**

**"两个安装程序都会 `enable --now` 每一个带 `[Install]` 的 unit ——
而在这里做那件事，会在'刚把它装上的那次更新'中途跑一次回滚检查，
那时守护进程正在合法地重启 —— 而那读起来就是一次坏掉的发布。"**

而那个解析规则也是承重的（`:342-344`）：

> A section header at the **start of a line**, which is what systemd parses and what
> `hooks/postinstall` greps for. **Matching the word anywhere would fire on the comment in the unit
> that explains why the section is absent.**

**"匹配这个词出现在任何地方，都会在'解释这一节为什么不存在'的那句注释上误报。"**

#### ⭐ `rescue.rs`：给一段"只在别的东西坏掉时才跑"的代码写测试

`rescue.rs:1-9`：

> This is **the code that has to work when everything else does not**, and **the code least amenable
> to a test**: on a real board it runs **only when a release cannot start.** So both halves are
> written to be askable without a board — **the rescue's decision is a pure function of two symlinks
> and a breadcrumb, and the check's is a pure function of what `systemctl show` answers.**

**"这段代码必须在别的一切都不工作的时候工作，而它也是最难测的代码：
在真板子上它只在一个发布起不来的时候才跑。"**

它的做法：四个环境变量把树、状态目录、脚本路径、uptime 来源挪到临时目录
（`ROBOT_INSTALL_DIR` / `ROBOT_STATE_DIR` / `ROBOT_RESCUE` / `ROBOT_UPTIME_FILE`），
再加一个**放在 `PATH` 上的假 `systemctl`**。

那个假 `systemctl` 有一个很妙的设计（`rescue.rs:106-108`）：

> `systemctl show -p <Property> --value <unit>`, so the property is `$3` and the unit is `$5`.
> **Anything that is not a `show` is recorded instead**, which is how a test asserts on `reboot` —
> and, **more often, on the absence of one.**

**"任何不是 `show` 的调用会被记录下来 —— 测试用它断言发生过一次 `reboot`，
而更常见的是断言*没有*发生。"**

##### ⭐ 那 11 条决策里最值得读的三条

**① 已经指着 golden 就什么都不做**（`rescue.rs:226-228`）：

> **The check that keeps a hardware fault from becoming a reboot loop**: if the daemons are down
> **on the release carrying the standing guarantee**, this is not a release fault and a swap changes
> nothing except adding a reboot.

**"如果守护进程在'那个承载着长期保证的发布'上倒下了，这就不是发布的问题。"**

**② 面包屑：一次只能有一次尝试**（`rescue.rs:395-397`）：

> The breadcrumb is read by `updaterd` (`journal::Breadcrumb`) **as well as by a person, so its shape
> is a contract.** **Overwritten rather than appended**: one attempt at a time, with the history that
> must survive going into the update log instead.

**③ 那个"远在开机之后"的检查**（`rescue.rs:562-564`）：

> Invoked long after boot, **something other than the timer started it** — most likely an installer
> running `enable --now` over the units it just wrote, **mid-update, with daemons legitimately
> restarting.** **Rolling back there would be the worst thing this could do.**

**⚠️ 而它自己说清楚了没覆盖什么**（`rescue.rs:11-16`）：

> What that leaves uncovered is **real and worth naming: systemd itself.** Whether the timer fires at
> `OnBootSec=180`, whether the oneshot's `Conflicts=shutdown.target` keeps it off the way down, and
> whether `NRestarts` reads the way this assumes on a crash-looping unit — **none of that is here.**
> It needs real systemd — `systemd-nspawn`, or a privileged container with it as pid 1.

（那一份在 [`scripts-primer.md`](scripts-primer.md) 里的 `systemd-test.sh`。）

#### ⭐ `sideload.rs`：一个**只有第三个文件**能检查的约定

**只有 116 行，三个测试，而它的结构很值得学。**

它检查的是 `scripts/dev-push.sh` 和 `updaterd.service` 之间那个**靠约定维持的路径**。
而那个约定坏掉的方式，**从两边单独看都是看不见的**（`sideload.rs:5-11`）：

> `updaterd.service` sets `PrivateTmp=yes`, which gives the unit **its own `/tmp` *and* its own
> `/var/tmp`**, so a directory under either **is not the one the daemon reads.** The push succeeds,
> **every file is demonstrably in place**, and the apply fails with *"no manifest for version ... in
> `/var/tmp/duck-sideload`"* — **a sentence that cannot be reconciled with `ls`.**
>
> `updater/src/preflight.rs` makes that failure say so **when it happens**. This file is the other
> half: **the default path must not be one the unit hides in the first place.** **Neither file can
> check it** — the script does not read the unit, the unit does not know the script — **so it is
> checked here, where the whole repository is readable.**

**"这句话无法和 `ls` 的输出对上。"**
**"两个文件都检查不了它 —— 脚本不读 unit，unit 不知道脚本 —— 所以它在这里被检查，在这里整个仓库都是可读的。"**

（这正是 [`updater-primer.md`](updater-primer.md) §5.2 那个 mount namespace 的坑的**另一半**：
那边是"发生的时候说清楚为什么"，这边是"默认路径就不该是那个会被藏起来的地方"。）

##### ⭐ 而它的第三个测试，是给前两个测试写的测试

两个主测试都是**条件性的**（`sideload.rs:66`、`:84` 都在不适用时提前返回）。所以：

`sideload.rs:105-108`：

> **Named here rather than left implicit because both tests above are conditional, and a conditional
> test that stops applying is indistinguishable from one that passes.**

**"一个不再适用的条件测试，和一个通过的测试，是无法区分的。"**

**这一句话又回到了整个 crate 的论点**（§3.2）：**测试必须知道自己有没有在守空气。**

而 `sideload.rs:34-40` 那个"去掉注释"的辅助函数也记着它自己的局限：

> Cuts at the first `#`, which is wrong for a `#` inside quotes. The only such line here is a `sed`
> expression with no path in it, and **a mangled line can at worst hide a match, which the assertions
> below would report as a pass** — so **the failure mode is a weaker test, never a false alarm.**

**"失败模式是一个更弱的测试，永远不是一次误报。"**

---

## 8. 密钥的两条纪律

### 8.1 ⭐ 那条**现在就要做，以后做不了**的事

`main.rs:469-481`，`keygen` 的文档：

> **Why the release *spare* must exist now.** **A robot verifies against the *set* of public keys
> baked into its image.** If only one release key is baked in and it is later lost or compromised,
> **there is no way to introduce a replacement over the air** — the robot would have to be
> **re-flashed by hand.** Generating a second release key today and shipping both public keys from
> the first image means **rotation is later just "sign with the other key". Cheap now, impossible
> to retrofit.**
>
> **Refuses to write a secret key inside the repository. Committing a signing key is the one mistake
> here that cannot be undone by deleting the file.**

**"现在很便宜，以后无法补上。"**
**"提交一把签名密钥，是这里唯一一个删掉文件也无法撤销的错误。"**

而它**真的拒绝了**（`main.rs:481-490`）：

```
refusing to write keys inside the repository (…).
A committed signing key cannot be un-leaked by deleting it later.
Pick a path outside the working tree, e.g. --out ~/robot-keys
```

**"一把被提交过的签名密钥，无法靠以后删掉它来解除泄露。"**

### 8.2 两种钥匙，两种威胁模型

`main.rs:44-52`：

```rust
enum KeyKind {
    /// Long-lived, encrypted at rest, trusted by every robot including customers'.
    Release,
    /// For signing branch builds. Unencrypted so CI needs no passphrase, and present
    /// only in the trusted set of *developer* boards.
    Dev,
}
```

而**dev key 不加密是有理由的**（`main.rs:526-528`）：

> Unencrypted on purpose: **CI signs non-interactively, and the secret store is what protects it.
> An encrypted key plus its passphrase in the same secret store buys little.**

**"一把加密的钥匙，加上放在同一个 secret store 里的它的密码，买到的保障很有限。"**

而 `.dev.` 那个中缀是**承重的**（`main.rs:500-501`）：

> The `.dev.` infix is **load-bearing, not decoration**: `verify::KeyRing` treats a key whose
> filename ends in `.dev.pub` as usable **only when `allow_dev_keys` is set.**

⚠️ 所以 **`keygen` 自己决定文件名** —— 这样那个门就自动生效了。
而 `~/.keys/team.dev.pub` 和 `~/.keys/team.pub` 是**两把不同的钥匙**，名字就是策略。

详见 [`updater-primer.md`](updater-primer.md) §7.2 和 [`project/ci-setup.md`](project/ci-setup.md)：
**分支用 `team.dev`，发布用 `release-1`，两把都在 CI 里，而客户机器人只信 `release-1`。**

### 8.3 一个很小的、但值得学的细节

`main.rs:571-580`，`write_private`：

> Write a secret key readable only by its owner.
>
> **Set before the bytes are written, not after: a key that is briefly world-readable on a shared
> machine has already leaked.**

**"在写入字节*之前*设置，而不是之后：一把在共享机器上短暂地全局可读的钥匙，已经泄露了。"**

实现上就是 `OpenOptions::new().mode(0o600).create_new(true)` ——
**权限是 `open(2)` 的一个参数，所以没有那个窗口。**
而 `create_new(true)` 还顺手保证了**永不覆盖**（`keygen` 在更上面也显式检查了一遍）。

---

## 9. `promote`：晋升是**重签**，不是重建

### 9.1 那句话

`main.rs:23-27`：

> `promote` is what makes §16.3's `staging → stable` real: **it emits a *stable* manifest carrying
> the **same artifact bytes** already validated in staging — same sha256 — rather than rebuilding.**
> **Promotion is therefore a re-signing, and what ships is provably what was tested.**

**"晋升因此是一次重签，而发出去的东西可证明就是被测试过的那个。"**

### 9.2 ⚠️ 而它记着一次真实的事故

`main.rs:29-38`：

> The stable manifest points at the artifact on the *stable* release, which `promote.yml` uploads
> alongside it. **It used to point back at the staging release instead, to avoid a second copy of
> the bytes.** That made **every stable release depend on a tag named as if it were disposable** —
> and **it was duly disposed of: deleting the `daemon-staging-v0.1.x` releases left three stable
> releases pointing at nothing.**
>
> The sha256 in the manifest is verified on the robot before install, so **a copy that diverged
> could never install silently, which is what the single-copy rule was protecting against.**

**"那个被命名得像是用完就扔的 tag"** —— 而它确实被扔了。

**注意这段论证的形状**：它先说旧方案省了什么，再说那个"省"换来了什么，
最后说**当初担心的那个风险其实被另一层保护着**（机器人会验 sha256）。
**一次"我们想省一份拷贝，结果让三个发布指向了空气"的复盘。**

### 9.3 那个**不继承**的字段

`main.rs:737-743`：

```rust
match min_supported {
    Some(floor) => manifest["min_supported"] = serde_json::json!(floor),
    // Not inherited: a floor set to remediate a bad staging build should not
    // silently become a fleet-wide forced upgrade.
    None => { manifest.as_object_mut().map(|m| m.remove("min_supported")); }
}
```

**"为了补救一个坏的 staging 构建而设的下限，不应该悄悄变成一次全队强制升级。"**

⚠️ 注意它是 **`remove` 而不是"不动"** ——
因为 `manifest` 是从 staging 清单 `clone()` 来的（`main.rs:731`），
**所以不删掉就等于继承。** 这是个很容易写错的地方。

---

## 10. 谁在调用它

### 10.1 三个打包站点

| 站点 | 什么时候跑 | 为什么它有自己的一份列表 |
|---|---|---|
| `.github/workflows/_build-release.yml` | **发布**（staging 和 stable 都走它） | 真正的配方 |
| `.github/workflows/dev.yml` | **每次 push 到任何分支** | 见下 |
| `scripts/dev-push.sh` | 开发者手工 | 见下 |

`dev.yml:142-144` 说了为什么 dev 构建要用**同一份**内容：

> **Same contents as a real release**: a dev build that omitted the units or `robotd` would
> **fail its own restart step on the board and roll itself back**, which is a confusing way to
> learn that the packaging differed.

**"一个 dev 构建如果漏了那些 unit，会在板子上让自己的重启步骤失败、然后把自己回滚掉 ——
那是一种很令人困惑的、发现'打包不一样'的方式。"**

### 10.2 那张流程图

```
   你在 GitHub 上点 "Create release"
        │
        ├── pre-release，tag `daemon-staging-v1.2.3`
        │       └──► release.yml ──► _build-release.yml
        │                            构建 → 打包 → 签名 → **用机器人自己的代码路径验证** → 发到 staging
        │
        └── release，tag `daemon-v1.2.3`
                └──► release.yml ──► _promote-release.yml（若 staging 存在）
                                       └─ xtask promote → 重签 → 把**同一份字节**传到 stable
```

`CONTRIBUTING.md:166-171` 的表就是这张图，而它补了一句：

> The canaried path is **two steps on purpose**: publish the pre-release, install it on a robot,
> then create the release. **Creating a release with no staging build to promote is allowed and says
> so in its own notes** — verified in CI, never run on a robot.

**"直接构建一个 stable 发布是允许的，而它会在自己的发布说明里说出来。"**

### 10.3 那个"移走的 tag"

`.github/workflows/prune-dev-releases.yml:8-12` —— 一个很值得读的理由：

> Tidiness is the least of it. **A dead tag stays installable**: months later
> `robotctl update apply daemon --ref some-old-branch` still resolves, verifies and installs,
> **because the artifact is genuinely signed with the team dev key.** **It looks like a valid
> install and it is arbitrary stale code from a branch nobody remembers.**

**"它看起来像一次合法的安装，而它是一个没人记得的分支上的、任意过时的代码。"**

---

## 11. 几处读者会绊到的地方

按仓库的规矩，这里只**陈述事实**，不判断该怎么办。

### 11.1 ⚠️ `every_unit_install_sh_expects_is_packaged` 不覆盖 `mediad.service`

**这是本导读我最想让你知道的一处，因为它正好是这个 crate 自己说的那种失败。**

`main.rs:879-881` 的文档说：

> **Every unit `install.sh` installs** must actually be in the artifact.

而测试的收集方式（`main.rs:899-908`）是：

```rust
let mut units: Vec<String> = install
    .lines()
    .filter(|l| l.contains("for unit in"))
    .flat_map(|l| l.split_whitespace())
    .map(|w| w.trim_end_matches(';').to_owned())
    .filter(|w| w.ends_with(".service"))
    .collect();
```

**它只看 `for unit in` 那一行里写死的名字。** 而 `scripts/install.sh` 里的那些行是：

```
:386  for unit in padd.service tofd.service btd.service configd.service robotd.service updaterd.service; do
:635  for unit in padd.service tofd.service btd.service configd.service robotd.service updaterd.service; do
:668  for unit in updaterd.service robotd.service; do
:823  for unit in $shipped; do          ← 变量，不以 .service 结尾 → 被过滤掉
:861  for unit in updaterd robotd; do   ← 没带 .service → 被过滤掉
```

**所以它收集到的是这六个**：`padd` `tofd` `btd` `configd` `robotd` `updaterd`。

**而 `mediad.service` 不在里面。** 但 `install.sh` 确实装它、也确实启用它：

```
:683  for src in "${unit_src}"/*.service "${unit_src}"/*.timer; do   ← 通配符装**全部**
:796  enable_unit mediad.service                                      ← 按名字启用
:826  mediad.service) ;;                                              ← $shipped 循环里专门有一条
```

**今天 `mediad.service` 在三个站点里都被打包了**（§3.3 验证过），
**但如果有人把那一行从三个 `--include` 里删掉，这个测试仍然会通过。**

**这就是这个 crate 自己那句"a test that ... would pass while guarding nothing"的例子** ——
只不过它守的不是一个旧文件名，而是一个**它从来没有收集到的名字**。

值得留意：**测试内部的行内注释是准确的**（`main.rs:894-898`：*"Every `for unit in …` loop in
the script, unioned"*），而且它甚至记着自己第一次为什么没看见 `updaterd.service`（尾部的 `;`）。
**只有那句放在最上面的文档说明把范围说大了。**

### 11.2 `tests/apply.rs` 那句"most of these tests" —— 同样的形状

（这一条在 [`updater-primer.md`](updater-primer.md) §14.11 里记过，这里只提一句：
**这个仓库的"文档说明比代码说得多"的毛病，在两个 crate 里都出现过。**）

### 11.3 ⚠️ `promote_yml_uploads_the_artifact_it_points_at` 的名字已经过期

`main.rs:1874` 这个测试**不再读 `promote.yml`** —— 它用的是 `PROMOTE_WORKFLOW`（`main.rs:871`）：

```rust
const PROMOTE_WORKFLOW: &str = "_promote-release.yml";
```

而 `.github/workflows/promote.yml` 现在只是一个**派发器**（`promote.yml:29` 是
`uses: ./.github/workflows/_promote-release.yml`）。

**测试本身是对的**，只有**名字**在误导。而这恰恰是 `PACKAGING_SITES` 的文档警告过的那件事
（`main.rs:854-857`）：*"A test that kept reading the old name would pass while guarding nothing,
which is worse than failing."*

### 11.4 `every_install_sh_step_reaches_an_updated_board` 的后半段没有"守空"的断言

`main.rs:1087-1121` 那半段从 `install.sh` 里抠 `current/scripts/setup-*.sh` 的字面量。
而**同一个模块里每一个同类的测试都有一个下界断言**（§3.2）：

- 前半段有（`main.rs:1057-1060`：*"no `install_*` call sites found in install.sh; this test is watching nothing"*）
- `every_script_the_hooks_run_is_packaged` 有（`main.rs:961-964`，同样的措辞）
- `every_sysusers_file_in_the_repo_is_packaged` 有（`main.rs:1950`，`found >= 2`）

**而这一半没有。** 如果 `install.sh` 改成用变量拼那个路径，它收集到的集合会变成空的，
**而它会安静地什么都不检查。**

它现在找到两个（`setup-login.sh` 和 `setup-quiet-boot.sh`），两个都是靠赋值行里的字面量找到的
（`scripts/install.sh:732`、`:744`）—— **而那正是最可能被改掉的那个字符串。**

### 11.5 两处**已自报**的收窄

不是缺陷（源码里都写明了），但值得各记一句：

| 位置 | 抓不到什么 |
|---|---|
| `every_binary_a_packaged_unit_execs_is_staged`（`main.rs:2054-2059`） | 它要求 `cp … staged/` 那一行**正好以 ` staged/` 结尾**。`cp … staged/ && chmod …` 这样的行会看不见 |
| `printed_commands_name_absolute_paths`（`main.rs:2284-2292`） | 只覆盖**七个**脚本，而同一类里还有 `setup-npu.sh`、`setup-login.sh`、`setup-quiet-boot.sh`、`seed-policies.sh`、`seed-detector.sh` |

### 11.6 一处小的：`main.rs:1093-1098` 的死构造

```rust
for (_, rest) in install
    .split("current/scripts/setup-")
    .skip(1)
    .map(|r| ("", r))
{
```

那个 `.map(|r| ("", r))` 造了一个第一个元素永远是空串的元组，然后解构时立刻丢掉它。
`for rest in install.split("current/scripts/setup-").skip(1)` 是同一个程序。

### 11.7 ⚠️ 有三个二进制**三个站点都在打包，而没有任何测试断言它们**

这是第 11.1 条的同类，而且更值得知道，因为它有一句**写在源码里的反向断言**。

`scripts/dev-push.sh:336-338` 说：

> The same list as the `cp` block in `dev.yml` and `release.yml`, deliberately: this pushes the same
> artifact a release does, and **`xtask/tests/artifact.rs` packages all three lists and checks the
> tarball, so a binary added to one and not the others fails there.**

**"`xtask/tests/artifact.rs` 会打包全部三份列表并检查 tarball，所以只加进其中一个的二进制会在那里失败。"**

**而它不会。** 我读过那五个测试，它们断言的是：

- 至少 4 个 staged 的名字
- `bin/robotctl` 在
- `scripts/robot-rescue` 在且可执行
- 至少 4 个 `.service`
- 每个 unit 的 `ExecStart=` 指的那个二进制在
- 恢复网的四件套
- 两个钩子
- **每个站点自己的 `--include` 落到自己产物的正确位置**

**没有任何一条拿一个站点的列表去和另一个站点的比。**

所以这些二进制**只被"至少 4 个"那个下界兜着**：

| 二进制 | 谁需要它 | 三个站点都 stage 吗 |
|---|---|---|
| `sounds` | `hooks/postinstall` 渲染声音库 | ✅ |
| `pet-detect` | 摸头检测 | ✅ |
| `pet-features` | 训练特征提取 | ✅ |

**从任意一个站点删掉其中任何一行，整个测试套件仍然是绿的。**

**而 `sounds` 是最尖锐的那个**：`hooks/postinstall:79-82` 用
`if [ -x bin/sounds ]` 把它包起来，而且**没有 `else`** ——
**一个丢了它的发布会静默地跳过声音库渲染。**

**这正是这个文件存在的意义要消灭的那一类失败。**

（有 9 个二进制**是**被覆盖的：8 个 unit 的 `ExecStart`，加上 `robotctl` ——
而 `robotctl` 只有 `artifact.rs` 抓得住，因为它没有 unit。）

### 11.8 ⚠️ `artifact.rs` 的头说它覆盖 `version.toml`，而它没碰过

`artifact.rs:26-28` 把 *"the `binaries` list written into `version.toml`"*
列在"这个文件比字符串测试多出来的东西"里。

**而整个文件里 `version.toml` 只出现在那两行** —— 也就是头自己。
tarball 被拆成一个 `BTreeMap`，每个测试索引的是 `systemd/…`、`hooks/…`、`bin/…`、`scripts/…`。
**`version.toml` 从来没被打开过**，manifest 也是（channel / version / sha256 / sig_url）。

**真正被覆盖的，是"`package` 在那条路径上没有崩"。**
这是那个四项列表里**唯一一条说过头了的**。

### 11.9 `artifact.rs:32-33` 的"0.4 秒"是旧账

那句话是在这个文件只覆盖**一个**站点（`release.yml`）的时候写的。
现在 `PACKAGING_SITES` 有三个，而五个测试**每一个都遍历三个** ——
所以一次 `cargo test` 会跑 **15 次 `xtask package`**，每次一个新 tempdir，
而且 `packaged_release` **没有记忆化**，所以同三个 tarball 被重建五遍。

（这是算术，不是实测 —— 我没有跑它。但那个数字至少是没有被验证过的，
而且很可能差 3 到 5 倍。）

### 11.10 `artifact.rs:7` 引用了一节已经不存在的文档

> `docs/project/install-path-gap.md` **option A** is this file.

`install-path-gap.md` 里**没有 "option A" 了** —— 一次只改那个文件的 commit
把字母列表换成了编号小节。所以那个引用悬空了。

### 11.11 `the_preinstall_template_renders_completely` 写死了它替换的值

`main.rs:2217-2218` 把 `"1.23"` 和 `"1.28.0"` 直接写在测试里 ——
正好等于今天 `Cargo.toml:31-32` 的值，但**它不读 `Cargo.toml`**，
所以它注意不到那个钉移动了。

它只检查两件事：两个占位符**存在**，以及渲染完之后**没有 `@ONNX_` 残留**。
**那两个*值*由别处守着**（§7.3 的 `setup_board_pins_the_same_onnx_target`，
以及 `render_preinstall_hook` 自己）—— 所以这不是漏洞，
但**测试里那两个字面量是自由漂移的**。

---

## 12. 阅读路线

**3,473 行，但可以分成两条独立的路。**

### 如果只有十分钟

读**§3.2 那段 `PACKAGING_SITES` 的注释**（`main.rs:851-863`）。

**那是整个 crate 的论点**：*"一个继续读旧名字的测试会在什么都守护不到的情况下通过 ——
那比失败更糟。"* 读完它，剩下的 2,300 行都是在执行这一句话。

### 路径 A：我要发一次版本（约 40 分钟）

| 步 | 读什么 |
|---|---|
| 1 | [`CONTRIBUTING.md`](../CONTRIBUTING.md) §Releasing（**操作者视角，先读这个**） |
| 2 | `xtask/src/main.rs:60-202`（五个子命令，每个参数的注释都是一条经验） |
| 3 | `xtask/src/main.rs:287-466`（`package` 的八步） |
| 4 | `xtask/src/main.rs:700-766`（`promote`） |
| 5 | [`project/ci-setup.md`](project/ci-setup.md)（密钥托管与那条流水线） |

### 路径 B：我想理解"仓库怎么检查自己"（约 1.5 小时）

| 步 | 读什么 |
|---|---|
| 1 | `xtask/src/main.rs:851-878`（三个常量：站点、晋升工作流、`RELEASE_BIN_DIR`） |
| 2 | `xtask/src/main.rs:879-935`（两个覆盖性测试 **+ 它们记的事故**） |
| 3 | `xtask/src/main.rs:1013-1031`（§9.1 那个强制函数，**这一段最值得读**） |
| 4 | `xtask/src/main.rs:992-1011`（两张表：`ALSO_ON_UPDATE` / `FIRST_INSTALL_ONLY`） |
| 5 | `xtask/src/main.rs:2227-2238`（那个单引号的事故） |

### 路径 C：我要加一个守护进程（约 20 分钟）

| 步 | 读什么 |
|---|---|
| 1 | §7.1 那五个覆盖性测试（**它们会告诉你漏了什么**） |
| 2 | `.github/workflows/_build-release.yml:160-193`（31 条 `--include`，照着抄） |
| 3 | `.github/workflows/dev.yml` 里同样的列表（**别只改一个**） |
| 4 | `scripts/dev-push.sh:370` 起（**第三个**） |
| 5 | 跑 `cargo test -p xtask` |

**顺序很重要**：先让测试告诉你缺什么，比你读三份列表然后漏掉一份要快。

### 三条贯穿全文的主线

1. **重复的列表怎么办？用一个哨兵兜住。**
   三份 `--include`、两份版本钉、一份文件列表在三个地方 ——
   **这个仓库没有把它们抽成一份共享配置**（那些脚本是独立下载的、跑的时候根本不在仓库里），
   **而是写了一个测试把它们绑在一起。** 这是一个可以带走的模式：
   **当你无法消除重复时，就让不一致变得响。**

2. **测试必须知道自己有没有在守空气。**
   `assert!(units.len() >= 4)`、*"this test is watching nothing"*、
   *"a test that kept reading the old name would pass while guarding nothing, which is worse than
   failing"* —— **这个 crate 反复在给测试本身加安全网。**
   而 §11.1 和 §11.4 说明这件事**很难做全**。

3. **每一次事故都写下来，而且写"当时在想什么"。**
   没有打包的 unit、`203/EXEC`、被删掉的 staging release、`1.20.1` 对上要 `1.23` 的 `ort`、
   `^[Install]` 被当成字符类、九条规则的 pin 被当成上限 ——
   **每一条都在它对应的测试旁边。**
   **这个目录里没有一个数字是猜的，也没有一次失败是白费的。**

---

## 13. 术语表

| 词 | 意思 |
|---|---|
| **xtask** | Rust 项目里"用 Rust 写的构建脚本"的惯例。这里是 `cargo xtask` |
| **artifact / 产物** | 那个 `.tar.zst`。机器人下载并安装的东西 |
| **manifest / 清单** | 描述产物的签名 JSON：版本、url、sha256、要求 |
| **`--include src=dest`** | 把仓库里的一个文件放进产物里的某个路径 |
| **打包站点 / packaging site** | 有 `--include` 列表的三个文件之一 |
| **tripwire / 哨兵** | 一个**读别的文件然后断言**的测试 |
| **forcing function / 强制函数** | 一个不证明正确、但让"绕过它"必须先写下一句话的东西 |
| **`PACKAGING_SITES`** | 那三个站点的路径。**"命名一次"** |
| **staging / stable** | 两条通道。先发 staging 当候选，再晋升到 stable |
| **晋升 / promote** | **重签**同一份字节，不是重建 |
| **canary / 金丝雀** | 先装到少数实验机器人上跑一遍的发布 |
| **minisign** | 签名格式。**`xtask` 链接完整版（能签），`updaterd` 只链接验证版** |
| **信任锚 / trust anchor** | 烤进机器人镜像里的那组公钥 |
| **备用密钥 / spare** | 现在就生成的第二把 release key。**以后无法补上** |
| **`release` / `dev` key** | 两把钥匙，两种威胁模型。dev 不加密、只给开发板 |
| **`.dev.pub` 中缀** | 承重的：`KeyRing` 靠文件名决定这把钥匙要不要 `allow_dev_keys` |
| **`@ONNX_FLOOR@` / `@ONNX_TARGET@`** | 钩子模板里的占位符，`package` 时替换 |
| **pin / 版本钉** | 一份"必须一致"的版本号。`Cargo.toml` 是真相，脚本带字面量 |
| **`FIRST_INSTALL_ONLY`** | 只有全新安装才做的步骤，**每条都必须写明理由** |
| **`ALSO_ON_UPDATE`** | `install.sh` 和钩子**都**做的步骤 |
| **§9.1** | *"凡 `install.sh` 做的，钩子也要做"*。这条规则的执行者是 §7.2 |
| **`203/EXEC`** | systemd 的"这个文件没法执行"。**unit 打包了、二进制没打包**的样子 |
| **seed / 播种** | 从 Hub 下载一套策略/检测器，装到板子上 |
| **`.source` 记录** | 一个集合的出处。**交班靠它**：不是这个脚本装的不碰 |
| **交班 / handover** | 从"发布 seeding"交给"`robotctl policy update`" |
| **`sed` 解析器** | 板子上没有 JSON parser，所以用一个正则从清单里抠文件名 |
| **`shipped`** | `install.sh` 里那个"这个发布带了哪些 unit"的变量 |
| **`install_*`** | `install.sh` 里的步骤函数。**测试数的是调用点，不是定义** |
| **`--allow-version-drift`** | 跳过"版本和 `Cargo.toml` 对得上吗"。**只用于测试工具本身** |
| **`zstd-level`** | 压缩等级。默认 19；一次性产物用 1 |
| **CI 冒烟测试** | 每次 PR 跑一次 `xtask package`，只为证明它能跑 |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| **另一半：机器人怎么装（姊妹篇）** | [`updater-primer.md`](updater-primer.md) |
| **§9.1 那条规则的来源（姊妹篇）** | [`hooks-primer.md`](hooks-primer.md) · [`scripts-primer.md`](scripts-primer.md) |
| 发布、签名、晋升的完整设计 | [`design/updater-design.md`](design/updater-design.md) §16.3 |
| 密钥托管、秘密、轮换 | [`project/ci-setup.md`](project/ci-setup.md) |
| 那四个 bug 是怎么到达板子的 | [`project/install-path-gap.md`](project/install-path-gap.md) |
| 板子被配置成什么样子（姊妹篇） | [`deploy-primer.md`](deploy-primer.md) |
| 更新时在板子上跑的那两个脚本（姊妹篇） | [`hooks-primer.md`](hooks-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 那个 50 Hz 的控制环（姊妹篇） | [`robotd-primer.md`](robotd-primer.md) |
| 那份配置 schema（姊妹篇） | [`robotd-params-primer.md`](robotd-params-primer.md) |
| 装完之后你用的那个 CLI（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| 公共线上契约（姊妹篇） | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| 摄像头、WebRTC、远程网关（姊妹篇） | [`mediad-primer.md`](mediad-primer.md) |
| 深度矩阵与障碍检测（姊妹篇） | [`duck-detect-primer.md`](duck-detect-primer.md) |
| 头部的两个传感器（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 蓝牙门房（姊妹篇） | [`btd-primer.md`](btd-primer.md) |
| BLE 的线上契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| wifi、身份、手柄配对（姊妹篇） | [`configd-primer.md`](configd-primer.md) |
| 手柄：按键映射、模式（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| 手柄自己的 IMU（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| 控制核心：从读总线到写总线（姊妹篇） | [`duck-control-primer.md`](duck-control-primer.md) |
| 关节角 → 空间中的点（姊妹篇） | [`kinematics-primer.md`](kinematics-primer.md) |
| 里程计与那张地图（姊妹篇） | [`odometry-primer.md`](odometry-primer.md) |
| 鸭子的嗓子（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| 摸头检测（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| 仿真的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 笔记本上那个客户端（姊妹篇） | [`duckctl-primer.md`](duckctl-primer.md) |
