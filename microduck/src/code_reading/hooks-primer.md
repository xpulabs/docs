# `hooks` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> hook 的机制由 [`design/updater-design.md`](design/updater-design.md) §9 拥有（英文），
> 那条规则的来历在 [`project/install-path-gap.md`](project/install-path-gap.md)。
> 两者若有不一致，以设计文档为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：**这一份讲的是"发布包怎么把自己装到板子上"** ——
> 前面九份讲的都是**代码**，这一份是**那次交付本身**。

## 目录

1. [一分钟版](#1-一分钟版)
2. [它在整个更新流程里的位置](#2-它在整个更新流程里的位置)
3. [⭐ 那条规则：新装做的事，hook 也要做](#3--那条规则新装做的事hook-也要做)
4. [目录导览](#4-目录导览)
5. [`postinstall`：把发布包的东西铺到板子上](#5-postinstall把发布包的东西铺到板子上)
6. [`preinstall`：在上线**之前**确认板子跑得动](#6-preinstall在上线之前确认板子跑得动)
7. [超时：两个不同的预算](#7-超时两个不同的预算)
8. [运行环境：清空的环境](#8-运行环境清空的环境)
9. [单一真相来源与那些测试](#9-单一真相来源与那些测试)
10. [阅读路线](#10-阅读路线)
11. [术语表](#11-术语表)

---

## 1. 一分钟版

`hooks/` 里是**两个 shell 脚本**，它们在一个发布包被装到机器人上时运行：

```text
   hooks/
   ├── postinstall    185 行  装完之后：把单元、脚本、音色库铺到板子上
   └── preinstall.in  231 行  装之前：确认这块板子跑得动这个发布
```

**它们为什么重要？** 因为 `CLAUDE.md` 有一句话：

> **`main` 修好了不等于机器人修好了。** 稳定通道上的机器人要等一次**发布**才会动。
> …… [`docs/design/updater-design.md`](design/updater-design.md) 拥有这个机制。

而 **hook 是唯一一个"在每一块板子上、每一次更新时都会运行"的东西** ——
所以"这块板子必须先有 X，这个发布才能工作"这句话，**只能写在这里**。

规模：**416 行**（两个 shell 脚本），加上 `xtask` 和 `updater` 里驱动它们的那些代码。

---

## 2. 它在整个更新流程里的位置

一次更新有**五步**，而两个 hook 各自卡在一个精确的位置上：

```text
   ① 下载 → 校验签名 → 解包
              │
              ▼
   ② hooks/preinstall          ★ 在换链接**之前**
              │                    · 失败 → **中止更新，旧发布继续跑，不回滚**
              │                    · 为什么这个位置就是全部价值 —— 见第 6 节
              ▼
   ③ 换 symlink：current 指向新发布
              │
              ▼
   ④ hooks/postinstall         ★ 在换链接**之后**、重启之前
              │                    · 失败 → **更新失败，触发回滚**
              │                    · 这是**唯一能工作的窗口** —— 见第 5.1 节
              ▼
   ⑤ systemctl restart（`on_apply`）→ 健康门
```

`updater/src/hooks.rs` 的开头就是这张图的原文：

```text
   extract → [pre_install] → symlink swap → [post_install] → apply → health gate
```

> **一次非零退出 = 更新失败并触发回滚，和健康探测失败完全一样。
> hook 是那道门的一部分，不是"发出去就不管"。**

---

## 3. ⭐ 那条规则：新装做的事，hook 也要做

**这是整个目录存在的理由，也是这个仓库里被违反次数最多的规则之一。**

设计文档 §9.1 的原话：

> **一个发布在被装齐它需要的一切之前，都不算装好了。**
> **把文件送进发布目录不等于安装了它；把脚本送进发布目录不等于运行了它。**
>
> hook 是唯一在每一块板子上、每一次更新时都运行的东西，
> 所以"这块板子在这个发布能工作之前必须有 X"就属于这里 ——
> **不属于一个在 X 存在之前只跑过一次的 provisioning 脚本，也不属于某个人的记忆。**

### 3.1 要问的那个问题是**机械的**

> **问题不是"这个发布需不需要它"，而是"一次全新安装会不会做这件事"。**
>
> "需要"是一个判断，而它**已经放过去一个**：一小段把机器人名字放进 shell 提示符的代码
> **不是一个发布*需要*的东西**，所以它进了 `install.sh` 而没进别处，
> **于是每一块只更新过的板子都没有它**。
>
> 改问那个机械的问题 —— **`scripts/install.sh` 会写这个文件、或者跑这个命令吗？** ——
> 因为那个问题**能靠 grep 一个文件回答**，而且因为
> **一块不是全新的板子，拿到的恰恰就是 hook 做的事，不多不少。**

### 3.2 ⚠️ 这条规则**已经被违反了四次**，四个不同的形状

| | 出了什么事 |
|---|---|
| **① 单元文件** | 一个加了新 daemon 的发布把 `.service` 放进了产物，**而 systemd 从不看那里**。`btd` 在一块**发布完整且正确**的板子上以 `203/EXEC` 失败，而 `on_apply` **没法重启一个还不存在的单元** |
| **② GStreamer 栈和 3A 引擎** | provisioning 装过它们，所以在那之前 provision 的板子没有；插件比发布旧的那些板子也没有。现在 `preinstall` 每次更新都跑发布**自带的** `setup-gstreamer.sh` / `setup-rkaiq.sh` |
| **③ NPU** | 加鸭子检测的那个分支写了 `setup-npu.sh`、把它和模型一起打进了发布 —— **然后从来没有调用过它**。每块板子都会带着一个**够不到 NPU 的检测器**出货，而发现这一点的方式是 `rknn_init` 返回一个数字 |
| **④ 登录 shell** | `install.sh` 长出了一段 `/etc/profile.d` 片段，把机器人的名字放在主机名旁边（`microduck@radxa-zero3 (coincoin):~$`），这样三个 ssh 窗口不会是三个一模一样的提示符。**没有别的东西装它，而 `install.sh` 不被打进发布**，所以**没有任何 hook 能做这件事** |

设计文档的总结：

> **每一次形状都一样：活是*干完了*的，而"让这个活到达板子"的那一步被落下了。**
> 它在 review 里是**看不见的**，因为那个加了脚本的 diff **看起来是完整的**。

> 第四个案例（登录 shell）的版本更高一层：它连 hook 都到不了，
> 因为 `install.sh` **本身**不在发布里。所以 `postinstall` 现在会**自己去调** `scripts/setup-login.sh` ——
> 而那个脚本**跟着发布走**，所以这次它能到达了。

---

## 4. 目录导览

```text
hooks/
├── postinstall    185 行   **不是模板** —— 没有东西需要替换，所以原样发布
└── preinstall.in  231 行   **是模板** —— `xtask package` 替换两个占位符后
                            以 `hooks/preinstall` 的名字打包
```

**一个 `.in`、一个不是**，而两个文件的头部都解释了原因：

```text
   postinstall:    "Not a template — nothing here needs substituting — so unlike
                    `preinstall.in` this ships as-is."

   preinstall.in:  "TEMPLATE. `xtask package` substitutes @ONNX_FLOOR@ and @ONNX_TARGET@
                    from [workspace.metadata.onnxruntime] in Cargo.toml and ships the result
                    as `hooks/preinstall`. **Edit this file, never the generated one** —
                    and there is no copy of the version to keep in step, because the hook
                    is built from the same constant the release is."
```

> ⚠️ **改 `.in`，不要改生成出来的那个。** 而 `hooks/preinstall` 根本不在仓库里 ——
> 它是 `xtask package` 在打包时生成的。`xtask` 里有一条明确的拒绝：
>
> ```text
>   return Err("hooks/preinstall is generated; remove the --include for it".into());
> ```
>
> 也就是说，**有人试图手工把它加进打包清单时，构建会失败。**

---

## 5. `postinstall`：把发布包的东西铺到板子上

### 5.1 ⭐ 为什么它必须在"那个窗口"里运行

脚本头部的第二段：

> **运行在符号链接交换之后、`on_apply` 的重启之前** ——
> **而这是唯一能让它工作的窗口**：
> `current` 已经指向这个发布了，所以一个单元的 `ExecStart` **解析得开**；
> 而紧接着的那次重启**会遇到一个已经存在的单元**。

### 5.2 ⭐ 致命 vs 警告：一条明确的分界线

> **hook 非零退出会让更新失败并触发回滚**，
> 所以这里的规则是：**只为"这个发布装不上"的事情失败，其余一切只警告。**
>
> **复制一个单元是第一种。一个服务起不来是第二种** ——
> **`btd` 在一块蓝牙适配器还没出现的板子上合法地失败**，
> 而**一台因为无线电不在就不能更新的机器人，是一笔很差的交易**。

把这条规则套到脚本里，你会看到它**逐条**地把每个操作标成 fatal 或 warn：

| 操作 | 是 fatal 吗 | 为什么 |
|---|---|---|
| 装 `sysusers.d/*.conf` | **是** | 单元里的 `User=` 不存在会让单元起不来，**而那个失败读起来像"daemon 坏了"而不是"少了个账号"** |
| 装 `.service` / `.timer` | **是** | "这个发布装不上" |
| 装救援脚本 | 否（警告） | *"一个装不上它们的发布仍然是一个值得拥有的发布"*，而 `install.sh` 在新板子上会做 |
| 登录 shell 文件 | 否 | *"一个 shell 提示符不值得为它回滚一次更新"* |
| apt 离开启动路径 | 否 | *"启动慢一点不值得回滚"* |
| 渲染音色库 | 否 | *"一台没有嗓子的机器人照样走路"* |
| 播种策略集 | 否 | *"一台没有策略的机器人保持姿势并报告 degraded"* |
| 播种鸭子检测器 | 否 | 检测器默认关着，而且 `mediad` 会在 journal 里说 |
| `systemd-sysusers` | 否 | *"账号可能已经存在了，而那才是常见情况"* |
| `systemdctl daemon-reload` | 否 | |
| `enable --now <单元>` | 否 | *"`on_apply` 片刻之后会重启它自己列表里的单元，所以一个只是慢的单元不是问题"* |

### 5.3 单元的两个特殊处理 —— 都关于"别在**现在**跑一个本该开机才跑的东西"

```text
   ① 没有 [Install] 段的单元 → **根本不能 enable**，只打一句说明。
        而恢复机制（recovery net）的 oneshot 单元**故意没有**。
        `enable --now` 它会在更新中途跑一次回滚检查，
        而那时 daemon 正合法地处在重启中间 ——
        **那读起来恰恰就是"一个起不来的发布"。**

   ② 定时器（.timer）→ **enable 但不 start**。
        一个 `OnBootSec=` 的定时器如果在它自己的截止时间之后被启动，
        会**立刻开火** —— 而这个 hook 跑在更新**中途**。
        它在**下一次开机**时武装，而那才是它要管的那次开机。
```

> 💡 第二点是新手最容易觉得"多此一举"的：`enable` 和 `enable --now` 只差三个字母，
> 而在这里它们差着"一次更新中途意外触发的开机任务"。

### 5.4 回滚时这些单元会怎样 —— 而且是**故意的**

> 回滚时，这里装的单元**会留下来**，指向 `current` —— 而那时 `current` 是**更老的、可能不包含它们二进制**的那个发布，
> 所以它们**起不来**。**这是刻意的**：
>
> 另一个选择是**记录装了什么**，好让一次回退能撤销它；
> 而"这个发布没装上，而且有一个服务在下一个发布装上之前一直失败"
> **两种情况是同一个局面**。
>
> 而且它**会自我修正**，因为下一次成功的更新会把它带的东西重新装一遍。

### 5.5 顺序：用户和组**先于**单元

```sh
# Users and groups before units: a unit naming a `User=` that does not exist fails to start,
# and that failure reads as a broken daemon rather than a missing account.
```

### 5.6 单元文件是**覆盖**而不是合并

> 覆盖，和 `install.sh` 做的一样：**单元文件属于发布**，
> 而**定制一个受支持的方式是 `/etc/systemd/system/<单元>.d/` 下的 drop-in，而这里不碰它**。

---

## 6. `preinstall`：在上线**之前**确认板子跑得动

### 6.1 ⭐ 位置就是全部价值

脚本头部：

> 运行在产物**下载、校验、解包之后**，但**在换链接之前**。
> **那个位置就是全部价值**：在这里失败会**中止更新，而旧发布仍然是活的、不回滚、也不折腾 boot counter**。
>
> 对比一下另一个选择 —— **而那恰好是板子上真实发生过的**：
> 完整下载、换链接、重启、30 秒健康门、一次回滚，
> **而唯一的解释是 `control loop has not completed a cycle yet`。**

### 6.2 两个依赖，**故意用不同的方式失败**

| | 失败会怎样 | 为什么 |
|---|---|---|
| **ONNX Runtime** | **致命** | *"一个加载不了策略的发布就是一台站不起来的机器人，而在这里中止会让旧发布继续活着，没有回滚、也不折腾 boot counter。"* |
| **GStreamer 栈** | **不致命** | *"一块没有摄像头栈的板子会失去 `mediad` —— 视频和 WebRTC 控制台 —— 而它照样走路、照样配手柄、照样更新。**为它拒绝这次更新，会意味着一块板子无法被那个'修板子'的机制修好。**"* |

> 📌 第二句值得反复读。它说的是：**如果一个可选的依赖能挡住更新，那你就失去了唯一的修复手段。**

同样的道理让 **3A 引擎**和 **NPU** 也都是"不致命"：
一块装不上 3A 的板子**仍然是一台机器人**（只是摄像头偏绿、固定曝光）；
一块没有 NPU 的板子**照样走路、照样推流、照样看得见** —— 只是在 CPU 上。

### 6.3 ONNX Runtime 的版本检查：两个细节

```sh
installed_onnx() {
    resolved="$(readlink -f "${ONNX_LIB_DIR}/libonnxruntime.so" ...)"
    ...
}
```

> 那个 tarball 会铺下 `libonnxruntime.so.<版本>`，并把裸名作为**符号链接**，
> 所以**解析那个链接就能拿到版本，而不用运行任何东西**。
> 去问库它自己意味着 **dlopen 它** —— 而那正是我们想避免不安全地做的事。

而版本比较**是数字的，不是字符串的**：

> **数字而不是字符串：`"1.9"` 在字典序上排在 `"1.23"` 之上**，
> 那会让一块跑不动的板子通过。补丁号被忽略 —— `ort` 关心的是 API 版本，而它跟着次版本号走。

### 6.4 一个"故意写在不该写的地方"的副作用

```sh
# This writes to /usr/local/lib before the swap, so the change outlives an aborted update.
# Deliberate and safe in this direction: ...
```

> 它在换链接**之前**写 `/usr/local/lib`，所以**这次改动会活过一次中止的更新**。
> **这是刻意的，而且在这个方向上是安全的**：
> `ort` 向 dylib 要的是**至少**它的 `ORT_API_VERSION`，
> 而 ONNX Runtime 保持 C API 向后兼容 ——
> **所以我们正要放弃的那个发布，仍然能对着这个更新的运行时工作。**

### 6.5 装完**还要再验一遍**

```sh
have="$(installed_onnx)"
at_least "$have" "$ONNX_FLOOR" \
    || die "installed ONNX Runtime ${have:-none}, still below ${ONNX_FLOOR}"
```

> **验证而不是假定**：一次报告了成功、但把符号链接留错了的安装，
> 否则会在 `robotd` 的控制线程 panic 时被发现 —— **而那正是这个 hook 被写出来要消除的失败模式。**

（这呼应了 `duck-control-primer.md` §10.3：`ort` 在库缺失时**不是返回错误，而是 panic**。）

### 6.6 三个"跑发布自带的脚本"

GStreamer、3A、NPU 三个函数**形状完全一样**：

```sh
script=scripts/setup-XXX.sh
[ -f "$script" ] || { say "..."; return 0; }     # 发布里没有就跳过
if sh "$script"; then ... else ... fi            # 失败只报告
```

而注释解释了**为什么要跑脚本而不是复制它的内容**：

> **是那个脚本，不是它做的事的一份拷贝。**
> 它拥有固定的插件版本、Debian 包列表、Rockchip 的 MPP 和 RGA deb、
> `/dev/mpp_service` 的 udev 规则、以及编码器报告 ——
> **六件本来会存在两份、然后漂移的事**，而那正是这个仓库一直在写下来的那一类 bug。

> 💡 还有一句解释了整个"provisioning vs 更新"的分工：
> **`provision.sh` 在全新板子上装这个栈；而每一块在那之前 provision 的板子、
> 以及每一块插件比这个发布构建时更旧的板子，都由一次普通更新修好 ——
> 而不是靠某个人记得一条命令。**

---

## 7. 超时：两个不同的预算

两个 hook 的超时**不一样**，而且差很多：

```rust
// updater/src/engine.rs
const HOOK_TIMEOUT: Duration = Duration::from_secs(120);            // ← postinstall
const PRE_INSTALL_HOOK_TIMEOUT: Duration =
    Duration::from_secs(crate::proto::UPDATE_MAX_SILENCE_SECONDS);  // ← preinstall = 600s
```

而 `PRE_INSTALL_HOOK_TIMEOUT` 的注释解释了**为什么它能这么长**：

> 它装着这个发布需要而板子上没有的东西：ONNX Runtime，以及 `mediad` 的 GStreamer 栈 ——
> **在一台从没装过的板子上，大约是 100 MB 的 apt**，还要经过机器人连的那个 wifi。
>
> **能这么长，恰恰是因为它运行的位置。** 什么都还没换，旧发布仍然是活的、仍然在服务，
> 所以一个跑得久的 hook **是一次慢更新，而不是一台有风险的机器人** ——
> 同样的几分钟花在 post-install 里，就会**夹在换链接和重启之间，那时板子两个发布都跑不好**。
>
> **十分钟是靠"一个卡住的 apt 更像卡死而不是慢"划出来的那条线。**

而它**住在 `duck-ipc-proto`** 的理由，正是 `duckctl` 那一侧：

> 这个数字住在 `duck-ipc-proto` 里，因为**它是对每一个客户端的契约，不是一个私有预算**：
> **phase 通知在 hook *之前*到达**，所以这是"一次 apply 最长能沉默多久"，
> **而一个 idle 预算比它短的客户端，会把一次正在工作的更新叫作一台死掉的机器人。**

> 💡 这一条把三个地方串起来了：
> `engine.rs` 用 `UPDATE_MAX_SILENCE_SECONDS` 当上限，
> `duckctl` 用 `UPDATE_MAX_SILENCE_SECONDS + 60` 当自己的预算（`duckctl-primer.md` §8.2），
> 而 `preinstall.in` 里的 `CURL_MAX_TIME = 90` 保证**下载超时会先用自己的话报错**。

### 7.1 ⚠️ 一处过时的注释

`preinstall.in:34-35` 是这么写的：

```sh
# Below the updater's 120s ceiling on a hook, so a slow network produces our message naming
# the fix rather than a bare "timed out after 120s".
CURL_MAX_TIME=90
```

**而 pre-install hook 现在拿到的是 600 秒，不是 120 秒。**

我核实了时间线：

| | 什么时候 |
|---|---|
| 那句注释（"the updater's **120s** ceiling on a hook"） | `88dc1ff` · **2026-08-04** |
| `PRE_INSTALL_HOOK_TIMEOUT`（= `UPDATE_MAX_SILENCE_SECONDS` = **600 s**） | `ae81306` · **2026-08-25** |
| 那次提交的标题 | *"preinstall installs the GStreamer stack, which was always the plan"* |

也就是说：**这个上限正是为了容纳 GStreamer 那 100 MB 的 apt 才从 120 秒提到 600 秒的**，
而解释 `CURL_MAX_TIME` 的那句话还停在 120 —— 它现在指的是**另一个 hook**（postinstall）的上限。

> **行为没问题**（90 < 120 < 600，两边都安全），但**理由指错了地方**。
> 而下一个想把 `CURL_MAX_TIME` 往上调的人，会去对着一个不适用于这个 hook 的数字思考。

---

## 8. 运行环境：清空的环境

`updater/src/hooks.rs` 在运行 hook 之前做四件事：

```rust
command
    .current_dir(release_dir)     // ← cwd 就是正在装的那个发布
    .env_clear()                  // ← **清空整个环境**
    .env("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
    .kill_on_drop(true)
```

### 8.1 为什么清空环境

> **一个最小的环境**：hook 拿到的是我们传的东西加上 `PATH`，
> 所以**它们的行为不取决于 systemd 碰巧是怎么调用我们的**。

而 `preinstall.in` 的头部补了一句**后果**：

> 环境被更新器清空了，`PATH` 和 hook 上下文之外什么都不剩，**所以这里没有 token**。
> 那没关系，**而且这正是这个 hook 取的两样东西都是公开的**的原因：
> 从 `microsoft/onnxruntime` 取 ONNX Runtime，从 `pollen-robotics/microduck-gst-plugins` 取 GStreamer 插件。

> 💡 这是个很值得学的推理链：**因为环境被清空 → 所以 hook 里没有凭据 → 所以它只能装公开的东西 →
> 所以那两个源的公开性是一条被依赖的性质，而不是巧合。**

### 8.2 `cwd` 是发布目录 —— 而这一点被依赖

`postinstall` 里有一句：

```sh
# Hooks run with the release directory as their working directory.
```

所以脚本里的相对路径（`scripts/setup-login.sh`、`bin/sounds`、`systemd/*.service`）
**全都是"这个发布里的"** —— 而不是"板子上某处的"。

`HookContext` 里也因此区分了两个目录：

```text
   UPDATE_INSTALL_DIR   ← 组件的**根**（比如 /opt/robot/daemon）
   UPDATE_RELEASE_DIR   ← **正在装的那个发布**（比如 /opt/robot/daemon/releases/1.4.2）
```

> 注释：*"hook 自己的位置是它的 cwd，而 `$PWD` 就是正在装的那个发布。"*

### 8.3 传给 hook 的环境变量

```text
   UPDATE_COMPONENT        组件名（比如 daemon）
   UPDATE_CHANNEL          同一个值（文档里按这个名字写）
   UPDATE_NEW_VERSION
   UPDATE_INSTALL_DIR
   UPDATE_RELEASE_DIR
   UPDATE_NEW_SCHEMA_VERSION
   UPDATE_OLD_*            （缺席时**省略**而不是设成空，
                            这样 hook 能区分"全新安装"和"不知道"）
```

> 那个"省略而不是设空"很讲究：**空字符串和"没有"在 shell 里长得一样，但在语义上完全不同** ——
> 这和 `duck-ipc-proto-primer.md` §10.1 里"`None` 不是 `0`"是同一个思路。

### 8.4 ⚠️ 一个 `ETXTBSY` 竞态，以及一次靠注释维持的不变式

刚写完的脚本可能还"忙"着（内核在刷），于是 `exec` 会失败并返回 `ETXTBSY`。
`updater/src/spawn.rs` 的 `retrying_busy` 就是为了重试它，而那里的注释记着一课：

> **这个 crate 里没有任何东西可以绕过 `retrying_busy` 去 spawn 一个进程。**
>
> 上面那段文档声称每一次 spawn 都走这里，**而一个写在注释里的声称恰恰就是漂移的东西**：
> **`hooks.rs` 有这个重试，`engine.rs` 没有** ——
> 而那段解释这个竞态的段落，**早就把 `systemctl` 点名为引起它的进程之一了**。
>
> 代价是一个**间歇性变红的 CI job**（包括在一个只改了文档的 PR 上），
> 以及在板子上，一次来自 `self_test_updaterd` 的 `ETXTBSY`，**回滚了一个本来没问题的发布**。

而修法是一条**grep 源码的测试**：

```rust
/// 这个 crate 里没有任何东西可以绕过 [`retrying_busy`] 去 spawn 一个进程。
///
/// 用一个源码 grep 而不是一个类型：`tokio::process::Command` 不是我们能封起来的，
/// 而包它的一个 newtype 得把每一个 builder 方法都重新导出才有点用。
#[test]
fn every_spawn_in_the_crate_goes_through_the_retry()
```

> 💡 **"注释里的一个声称会漂移，所以把它变成一条测试"** —— 这是这个仓库反复出现的模式。

---

## 9. 单一真相来源与那些测试

`hooks` 里有两个版本号，而**它们都不能自己说了算**：

```toml
# Cargo.toml
[workspace.metadata.onnxruntime]
floor  = "1.23"
target = "1.28.0"
```

```sh
# hooks/preinstall.in —— 两个占位符，打包时被替换
ONNX_FLOOR="@ONNX_FLOOR@"
ONNX_TARGET="@ONNX_TARGET@"
```

而 `xtask package` 负责替换，**并且检查替换干净了**：

```rust
return Err("preinstall template still has unsubstituted @ONNX_...@ placeholders".into());
```

### 9.1 那些**读不到** `Cargo.toml` 的脚本怎么办

有一类脚本是**被单独 curl 下来执行的**，所以它**读不到这个文件**，只能自己写一个字面量。
那种情况下，**测试就是那根把它们绑在一起的绳子**：

| 元数据 | 字面量住在 | 怎么防漂移 |
|---|---|---|
| `[workspace.metadata.onnxruntime]` | 被替换进 `hooks/preinstall` | 打包时替换 + 占位符检查 |
| `[workspace.metadata.rknpu]` | `scripts/setup-npu.sh` | **一个测试断言两者一致** |
| `[workspace.metadata.gst-plugins]` | `scripts/setup-gstreamer.sh` | **一个测试断言两者一致** |

而 `Cargo.toml` 里写了**为什么值得这样**：

> 一个真相来源，理由和上面的 `[workspace.metadata.onnxruntime]` 一样：
> `scripts/setup-gstreamer.sh` 是被单独 curl 下来执行的，读不到这个文件，所以它带一个字面量，
> **而一个测试断言两者一致**。
>
> **两份版本号漂开，正是一块板子最后拿到一个它的 `ort` 会 panic 的 ONNX Runtime 的方式。**

---

## 10. 阅读路线

**第 1 步（20 分钟）**

1. 读 `hooks/postinstall` 的**头部注释**（前 31 行）—— 那张窗口图和那条 fatal/warn 规则。
2. 读 `hooks/preinstall.in` 的**头部注释**（前 28 行）—— 为什么位置就是价值。
3. 读 [`design/updater-design.md`](design/updater-design.md) §9.1 —— **那条规则和它的四个案例**。

**第 2 步 —— 两个脚本（1 小时）**

4. 读 `postinstall` 全文（185 行）—— 注意每个操作旁标的 fatal/warn。
5. 读 `preinstall.in` 全文（231 行）—— 注意两个依赖的不同失败方式。
6. 读 [`project/install-path-gap.md`](project/install-path-gap.md) —— 第一个案例的完整经过。

**第 3 步 —— 驱动它们的那一侧（40 分钟）**

7. 读 `updater/src/hooks.rs` 的模块头 + `run()`（`:112`）。
8. 读 `updater/src/engine.rs:46–66`（两个超时常量）。
9. 读 `updater/src/spawn.rs:39–60`（`retrying_busy`）和它那条 `#[cfg(test)]`。

**第 4 步 —— 动手**

```bash
# 这两个脚本自己会被 shellcheck（CI 里跑）
shellcheck hooks/postinstall

# 看打包时模板是怎么被替换的
grep -n -A 12 "fn render_preinstall_hook" xtask/src/main.rs
```

**自己验证一次替换**：

```bash
sed -e 's/@ONNX_FLOOR@/1.23/' -e 's/@ONNX_TARGET@/1.28.0/' hooks/preinstall.in | head -35
```

---

## 11. 术语表

| 术语 | 意思 |
|---|---|
| **hook** | 在某个时刻自动运行的一段脚本。这里是 `preinstall` 和 `postinstall` |
| **`preinstall` / `postinstall`** | 装**之前** / 装**之后**。两个位置各有各的意义 |
| **`postinst`** | Debian 包里同一个概念的名字。这个仓库的注释拿它作类比 |
| **产物 / artifact** | 一个发布打包出来的那个压缩文件（含签名） |
| **换链接 / symlink swap** | 把 `current` 指向新发布的那一步。**它是"上线"的分界线** |
| **`on_apply`** | 更新里"重启单元"的那一步 |
| **健康门 / health gate** | 换版后问 `robot.health`，不健康就回滚 |
| **回滚 / rollback** | 把 `current` 指回上一个发布 |
| **boot counter** | 启动计数器。用来抓"起来了但活不过去"的发布 |
| **恢复机制 / boot recovery net** | 连发布都起不来时那套兜底的东西 |
| **provisioning** | 给一块**新**板子配置的过程（`provision.sh` / `install.sh`） |
| **`sysusers.d`** | 声明"这个系统需要哪些用户/组"的目录，`systemd-sysusers` 读它 |
| **单元 / unit** | systemd 眼里的一个服务或定时器 |
| **`[Install]` 段** | 单元文件里声明"怎么被 enable"的那一段。**没有它就不能 enable** |
| **`enable` vs `enable --now`** | 只登记开机自启 / **顺带现在就启动** |
| **`daemon-reload`** | 让 systemd 重读单元文件。**改了单元之后必须做** |
| **drop-in** | `/etc/systemd/system/<单元>.d/*.conf`，用来定制而不改原文件 |
| **`oneshot`** | 一种只跑一次就结束的单元类型 |
| **`OnBootSec=`** | 定时器的"开机后多久触发"。**过了截止时间才启动会立刻开火** |
| **`203/EXEC`** | systemd 的"我找不到或者起不了这个程序"错误码 |
| **ONNX Runtime** | 跑 `.onnx` 策略的运行时。**板子的前置依赖**，不随发布走 |
| **`ORT_API_VERSION`** | ONNX Runtime 的 C API 版本号 |
| **`dlopen`** | 运行时才去找动态库 |
| **dylib** | 动态链接库（Linux 上是 `.so`） |
| **`ldconfig`** | 更新动态库缓存的命令。**新拷进去的库需要它才找得到** |
| **GStreamer** | 多媒体框架。`mediad` 用它推视频 |
| **3A（rkaiq）** | 摄像头的自动曝光/白平衡/对焦引擎 |
| **NPU / RKNN** | 神经网络加速器 / Rockchip 的运行时（见 `duck-detect-primer.md`） |
| **overlay（设备树）** | 在设备树上叠一层修改。启用 NPU 就是一次 overlay + 重启 |
| **`ETXTBSY`** | "文本文件忙" —— 刚写完的可执行文件还没刷完，`exec` 会失败 |
| **shellcheck** | 检查 shell 脚本问题的工具 |
| **模板 / `.in` 后缀** | "这个文件要先被替换，才是最终的东西"的惯例 |
| **单一真相来源** | 一个值只在一处定义，别处引用或由测试绑定 |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| hook 的权威设计（英文） | [`design/updater-design.md`](design/updater-design.md) §9 |
| 那条规则的四个案例 | [`design/updater-design.md`](design/updater-design.md) §9.1 |
| 第一个案例的完整经过 | [`project/install-path-gap.md`](project/install-path-gap.md) |
| 整个更新引擎 | [`design/updater-design.md`](design/updater-design.md) |
| 哪一步重启哪个单元 | [`design/restart-order.md`](design/restart-order.md) |
| 客户端这一侧：超时怎么和它对齐 | [`duckctl-primer.md`](duckctl-primer.md) §8 |
| 那个会被回滚的机制（健康判决） | [`robotd-primer.md`](robotd-primer.md) §6.3 |
| 启动恢复机制 | [`design/boot-recovery-net.md`](design/boot-recovery-net.md) |
| 一个具体依赖的安装（NPU） | [`duck-detect-primer.md`](duck-detect-primer.md) §6.1 |
| 另一个具体依赖（ONNX Runtime） | [`duck-control-primer.md`](duck-control-primer.md) §10.3 |
| 配置文件的 schema / 编辑器（姊妹篇） | [`robotd-params-primer.md`](robotd-params-primer.md) |
| 蓝牙门房：手机怎么连上机器人（姊妹篇） | [`btd-primer.md`](btd-primer.md) |
| wifi、身份、手柄配对（姊妹篇） | [`configd-primer.md`](configd-primer.md) |
| BLE 的线上契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| 仿真的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| 板子被配置成什么样子（姊妹篇） | [`deploy-primer.md`](deploy-primer.md) |
| 所有服务与客户端的公共契约（姊妹篇） | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| 鸭子的身体几何：正/逆运动学、ToF 重投影（姊妹篇） | [`kinematics-primer.md`](kinematics-primer.md) |
| 摄像头、WebRTC、远程可达（姊妹篇） | [`mediad-primer.md`](mediad-primer.md) |
| 机器人走到哪了：接触式里程计（姊妹篇） | [`odometry-primer.md`](odometry-primer.md) |
| 手柄自己的 IMU：姿态、零偏、yaw 漂移（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| 手柄：按键映射、模式、那个 raw tap（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| 摸头检测：麦克风、log-mel、那个门控（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| `update show`：一次更新的全文（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| 装机、更新、诊断的那些工具（姊妹篇） | [`scripts-primer.md`](scripts-primer.md) |
| 鸭子的嗓子：可播种的合成器（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 头部的两个传感器：深度与 IMU（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
