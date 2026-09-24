# `scripts/` 新手导读

> **这是一份阅读指南，不是设计文档。**
> 
> 这个目录是**工具**而不是程序：30 个 shell / Python / C 文件，11,790 行。
> 它们的分工由 [`../CONTRIBUTING.md`](../CONTRIBUTING.md) §仓库布局 拥有（`CONTRIBUTING.md:100-107`）；
> 更新时那一半由 [`hooks-primer.md`](hooks-primer.md) 和 [`design/updater-design.md`](design/updater-design.md) §9 拥有；
> 板子被配置成什么样由 [`deploy-primer.md`](deploy-primer.md) 拥有。
> 若本导读与代码不一致，以代码为准（见根目录 `CLAUDE.md`）。
> 
> 姊妹篇：[`hooks-primer.md`](hooks-primer.md)（**更新时**在这块板子上跑的那两个脚本）、
> [`deploy-primer.md`](deploy-primer.md)（配置与硬件）、
> [`robotctl-primer.md`](robotctl-primer.md)（装完之后你用来操作它的工具）。

## 目录

1. [一分钟版](#1-一分钟版)
2. [⚠️ 三个目录，三种时间尺度](#2-️-三个目录三种时间尺度)
3. [⭐ 核心心智模型：一台机器人是怎么被造出来的](#3--核心心智模型一台机器人是怎么被造出来的)
4. [目录地图](#4-目录地图)
5. [装机三兄弟](#5-装机三兄弟)
6. [板级 bring-up](#6-板级-bring-up)
7. [`hooks` 的接口：哪些脚本在**每次更新**时也会跑](#7-hooks-的接口哪些脚本在每次更新时也会跑)
8. [测试与诊断](#8-测试与诊断)
9. [开发工具](#9-开发工具)
10. [⭐ 只属于 `scripts/` 的那条纪律：shellcheck](#10--只属于-scripts-的那条纪律shellcheck)
11. [几处读者会绊到的地方](#11-几处读者会绊到的地方)
12. [阅读路线](#12-阅读路线)
13. [术语表](#13-术语表)

---

## 1. 一分钟版

`scripts/` 回答一个问题：

> **一块空板子变成一只鸭子，中间那些手敲的命令是什么？**

它们全部是**幂等的、不交互的、能重复跑的**工具。分三类：

| 类别          | 什么时候跑                   | 例子                                                                |
| ----------- | ----------------------- | ----------------------------------------------------------------- |
| **装机**      | 一块板子的一生一次               | `provision.sh` · `install.sh` · `setup-board.sh`                  |
| **更新**      | **每次发布**（由 `hooks/` 调用） | `setup-gstreamer.sh` · `setup-rkaiq.sh` · `seed-policies.sh`      |
| **开发 / 诊断** | 人手动跑                    | `duck-sim` · `dev-push.sh` · `board-test.sh` · `pad-link-test.sh` |

**它和 `hooks/` 的关系是这个目录里最重要的一件事**，`CONTRIBUTING.md:100-107` 那段把它写成了一张图：

```
scripts/        provision-board.sh · dev-push.sh + dev-build.Dockerfile (from your machine) ·
                provision.sh → setup-board.sh → setup-gstreamer.sh · setup-rkaiq.sh ·
                migrate-network.sh · install.sh (on the board) ·
                setup-login.sh · setup-quiet-boot.sh (install.sh and postinstall both run these) ·
                robot-boot-check · robot-rescue (recovery, installed to /usr/local/sbin) ·
                pad-link-test.sh · pad-stack-report.sh (gamepad radio, on the board) ·
                board-test.sh · systemd-test.sh (CI) · cross-sysroot.sh (cross-builds) ·
                bake-duck-mesh.py (the monitor's 3D model, run by hand)
```

⚠️ 那张图**不是完整的** —— 见 §11。

---

## 2. ⚠️ 三个目录，三种时间尺度

读这个仓库的时候，很容易把 `scripts/`、`hooks/`、`deploy/` 混在一起。它们的分界**不是按文件类型，是按寿命**：

| 目录             | 是什么                                                | 多久变一次 | 谁跑它                        |
| -------------- | -------------------------------------------------- | ----- | -------------------------- |
| **`deploy/`**  | 配置**内容**：`updater.toml`、`robotd.toml`、信任锚、journald | 每次发布  | `install.sh` 铺到 `/etc/`    |
| **`hooks/`**   | 更新流程里的两个脚本                                         | 每次发布  | **`updaterd`**，在**每一块**板子上 |
| **`scripts/`** | 装机、开发、诊断的工具                                        | 随时    | 人、CI、或者被上面两个调用             |

而那条把 `scripts/` 和 `hooks/` 绑在一起的规则，`CONTRIBUTING.md:97-100` 写得最直白：

> **the only thing that runs on every board on every update: anything `install.sh` does to a board
> belongs here too** (`updater-design.md` §9.1)

**"`install.sh` 对一块板子做的任何事，这里也都要做。"**

这条规则被违反过四次，每一次的形状都一样（[`hooks-primer.md`](hooks-primer.md) §3.2 有完整表格）：
**活是干完了的，而"让这个活到达板子"的那一步被落下了。**

### 2.1 那两条分流

| 脚本                                                       | 谁调用                                    | 为什么                                 |
| -------------------------------------------------------- | -------------------------------------- | ----------------------------------- |
| `setup-login.sh`                                         | `install.sh` **和** `hooks/postinstall` | *"that second caller is the point"* |
| `setup-quiet-boot.sh`                                    | `install.sh` **和** `hooks/postinstall` | 同上                                  |
| `seed-policies.sh` · `seed-detector.sh`                  | `hooks/postinstall` 和 `install.sh`     | 同上                                  |
| `setup-gstreamer.sh` · `setup-rkaiq.sh` · `setup-npu.sh` | **`hooks/preinstall`**                 | 见 §7                                |
| `setup-board.sh`                                         | **只有 `provision.sh`**                  | **不随发布走** —— 它改设备树，属于板子             |
| `migrate-network.sh`                                     | **只有 `provision.sh`**                  | 有意**不**进 hook（见下）                   |

`migrate-network.sh:5-14` 讲了为什么它不进 hook：

> **1. Different lifetime.** … This script exists *only* because Armbian's stock image ships netplan
> 
> + systemd-networkd + wpa_supplicant. The day we build a robot image with NetworkManager already
>   in it, **this whole file is deleted and nothing else changes.**
>   **2. Different risk.** Everything in `setup-board.sh` is safe to run at any time. **This is the
>   one step that can make a headless board unreachable.**

**"这是唯一一个能让一块无头板子彻底够不到的一步。"** 所以它只能在有人看着的时候跑。

---

## 3. ⭐ 核心心智模型：一台机器人是怎么被造出来的

一台鸭子的一生有三个阶段，每个阶段由不同的东西驱动：

```
   ①  一块刷好 Armbian 的空板子
        │
        │  scripts/provision-board.sh      ← 在**你的笔记本**上跑，全程 ssh
        │      └─► scripts/provision.sh    ← 送到板上，root，**跨一次重启分两阶段**
        │              ├─ phase 1: setup-board.sh → migrate-network.sh → 重启
        │              └─ phase 2: setup-board.sh → setup-gstreamer.sh
        │                            → setup-rkaiq.sh → migrate-network.sh
        │                            → install.sh
        ▼
   ②  一块跑着 daemon 的机器人
        │
        │  scripts/install.sh 装的是**最后一个稳定发布**
        │  然后它成为 **golden** —— 恢复网的后备
        ▼
   ③  之后每一次改动都走更新
        │
        │  updaterd 跑 hooks/preinstall → 换链接 → hooks/postinstall
        │      hooks 调用 scripts/ 里的那些脚本
        ▼
   ④  一个能自愈的机器人
        │
        └─ robot-boot-check.timer（每次开机 3 分钟后）
               失败 → robot-rescue → 换回 golden
```

### 3.1 那三个设计决定

**① 引导的循环是"下载一个裸 `updaterd` 然后让它自己装"**（`install.sh:17-21`）：

> The circularity — "an update needs the updater, which arrives in an update" — **is broken by
> downloading one bare `updaterd` binary and running its `install` subcommand.** That runs the
> ordinary engine: signature verification, extraction, the atomic swap, the journal entry.
> **There is no bootstrap-specific install logic, so nothing here can drift from how every later
> update behaves.**

**"没有任何专门用于引导的安装逻辑，所以这里不可能和之后每一次更新跑偏。"**

**② 它从不解析 manifest**（`install.sh:23-25`）：

> Notably this script **never parses a manifest.** It hands `updaterd` the config and lets the
> configured source resolve `latest`, because **a shell script picking the version out of a signed
> JSON document would be a second, weaker reader of that document.**

**"一个 shell 脚本从一个签名过的 JSON 文档里挑版本号，会成为那份文档的第二个、更弱的读者。"**

**③ 第一个装上的发布成为 golden**（`provision.sh:629-633`）：

> The first release installed becomes **golden**, the boot recovery net's fallback, and **a branch
> build as golden would give a broken branch a broken fallback.**

**"一个分支构建当 golden，就是给一个坏掉的分支配了一个坏掉的后备。"**

---

## 4. 目录地图

按用途分成五组：

### 装机（在板子上跑，root）

| 文件                   | 行数   | 一句话                                       |
| -------------------- | ---- | ----------------------------------------- |
| `provision-board.sh` | 894  | **在笔记本上**，全程 ssh，让装机变成一条命令                |
| `provision.sh`       | 808  | 板子上的编排者，**跨一次重启分两阶段**                     |
| `install.sh`         | 1054 | 装一个签名过的 daemon 发布                         |
| `setup-board.sh`     | 1122 | 设备树 overlay、内核、蓝牙、音频、ToF、摄像头、ONNX Runtime |
| `migrate-network.sh` | 554  | netplan → NetworkManager，**一次性**，带后备      |

### 组件（`hooks/preinstall` 每次更新都跑）

| 文件                     | 行数  | 一句话                              |
| ---------------------- | --- | -------------------------------- |
| `setup-gstreamer.sh`   | 653 | GStreamer 栈 + 两个必须从源码构建的插件       |
| `setup-rkaiq.sh`       | 332 | Rockchip 的 3A 引擎 + IMX219 调优     |
| `setup-npu.sh`         | 244 | RK3566 的 NPU 运行时 + 设备树节点         |
| `rkaiq-modinfo-shim.c` | 79  | `LD_PRELOAD` 垫片，**不是脚本，是在板上编译的** |

### 收尾（`install.sh` 和 `hooks/postinstall` 都跑）

| 文件                    | 行数  | 一句话                        |
| --------------------- | --- | -------------------------- |
| `setup-login.sh`      | 189 | motd、提示符里的名字、`robotctl` 补全 |
| `setup-quiet-boot.sh` | 87  | 把 apt 从启动路径上拿掉             |
| `seed-policies.sh`    | 216 | 从 HF Hub 下载官方策略集           |
| `seed-detector.sh`    | 126 | 同上，鸭子检测器                   |

### 恢复

| 文件                 | 行数  | 一句话                        |
| ------------------ | --- | -------------------------- |
| `robot-boot-check` | 144 | **每次开机**跑一次，判断这个发布起来没有     |
| `robot-rescue`     | 203 | 换回 golden，**不经过任何 daemon** |

### 测试 / 开发 / 诊断

| 文件                                                 | 行数   | 一句话                                  |
| -------------------------------------------------- | ---- | ------------------------------------ |
| `board-test.sh`                                    | 1173 | 交叉编译 + 在容器里跑**真的二进制**                |
| `systemd-test.sh`                                  | 364  | 真的 systemd 当 pid 1，真的更新              |
| `pad-link-test.sh`                                 | 455  | 手柄的链路可靠吗（**在板子上跑**）                  |
| `pad-stack-report.sh`                              | 700  | 两块板子的手柄栈一样吗（**在板子上跑**）               |
| `duck-sim`                                         | 1105 | 一条命令跑一只 MuJoCo 里的鸭子                  |
| `dev-push.sh`                                      | 559  | 不走 CI 的推送路径                          |
| `cross-sysroot.sh`                                 | 204  | `mediad` 交叉编译要的 aarch64 sysroot      |
| `bake-duck-mesh.py`                                | 217  | 把 CAD 烘焙成 `robotctl/assets/duck.bin` |
| `publish-console.sh` · `publish-space.sh`          | 200  | 把页面推到 Hugging Face Space             |
| `ci-release-notes.sh`                              | 56   | 发布说明                                 |
| `dev-build.Dockerfile` · `systemd-test.Dockerfile` | 52   | 两个镜像                                 |

---

## 5. 装机三兄弟

### 5.1 `provision-board.sh`：**唯一在笔记本上跑的那个**

`provision-board.sh:10-12` 说得很清楚，而它存在的理由是一个**缝隙**：

> What it is for is **the seam in the middle**. `provision.sh` reboots the board and finishes on its
> own, which is right, but **from the outside that looks like an ssh session dying followed by an
> unknown interval and a guess about when to log back in.**

**"从外面看，那就像一次 ssh 会话死掉，然后是一段未知长度的等待，再加上一个'什么时候该重新登录'的猜测。"**

它做的事：一次四向诊断的 ssh 探测 → 把 `provision.sh` 送过去 → `ssh -t … sudo env DUCK_TOKEN='…' sh /tmp/provision.sh`
→ **先等板子消失，再等它回来** → 轮询把 `/var/lib/robot/provision.log` 拷过来直到状态文件消失 → `robotctl health`。

里面有两处**疤痕式**的注释值得读：

**① 为什么按 pidfile 而不是按名字杀进程**（`duck-sim:99-101`）：

> By pidfile, **never by name.** `pkill -f robotd` also matches the shell that is about to start one,
> which is a good way to kill your own terminal — **three times in one afternoon**, in this case.

**② 为什么"一个 pid 不是身份"**（`duck-sim:111-117`）：

> **A pid is not an identity.** … The result was `kill -TERM -<recycled pid>` **as root**, which took
> out an unrelated process group: **it killed a login session, and the machine had to be rebooted to
> get it back.**

### 5.2 `provision.sh`：两阶段，中间一次重启

`main`（`:770-806`）只有三条路：

```
状态文件存在，且是同一次开机  → **die**，让操作者去重启
状态文件存在，且开机号不同    → phase_two
否则                          → phase_one
```

**为什么它总是重启**（`provision.sh:26-35`）：

> **Not because it always needs one, but because *deciding* would mean either re-deriving what the
> two scripts already decided or parsing their output, and both drift.** A reboot on a board being
> provisioned costs thirty seconds.

**"不是因为它总是需要重启，而是因为*判断*需不需要意味着要么重新推导那两个脚本已经决定过的事，
要么解析它们的输出 —— 而两者都会漂。"**

**为什么"哪次开机"用的是 `boot_id` 而不是时间戳**（`provision.sh:314-317`）：

> Deliberately not the state file's timestamp against uptime, which was the first attempt and is
> **wrong on this hardware**: the board has **no battery-backed RTC, starts at 1970**, and NTP steps
> the clock *during* provisioning … File-time arithmetic would be **comparing two clocks that
> disagree by decades.** There is no clock in this.

⚠️ 这一节有**一个真实的问题** —— 见 §11。

### 5.3 `install.sh`：只装发布，不碰板子

它的边界写在自己的注释里（`install.sh:968-973`）：

> Board bring-up is `setup-board.sh`'s job — **device-tree overlays need a reboot and belong to the
> board, not to a daemon release.** But installing a robot daemon onto a board with no bus is worth
> saying out loud: **the install will succeed, `robotd` will start, fail to open the bus, and report
> unhealthy.** That is honest behaviour, and an easy thing to stare past.

**"装会成功，`robotd` 会起来，打不开总线，然后报告不健康。那是诚实的行为，也是很容易盯过去的一件事。"**

两个值得知道的细节：

**① 为什么 `robotctl` 是符号链接而单元文件是拷贝**（`install.sh:605-609` 和 `:707-710`）：

> They are *copied* rather than symlinked through `current`: **a unit file read through the symlink
> would change under systemd's feet on every update**, and after a rollback systemd's view of the
> world would depend on which release happened to be live at the last `daemon-reload`.

> The recovery scripts on root's PATH, and *copied* — **the opposite decision to `robotctl` above** …
> **They exist for boards whose release cannot start, so reading them through `current` would route
> the recovery through the thing being recovered.**

**"它们是为'发布起不来'的板子存在的，所以通过 `current` 读它们，就是把恢复路由到那个正在被恢复的东西上。"**

**② 为什么单元清单是读目录而不是写死的**（`install.sh:676-682`）：

> Read the directory rather than assert a list. **A hardcoded set makes this script fail on any
> release that is not exactly its contemporary** — which is every fresh install, because the scripts
> come from a branch and the release is the last stable one. `configd.service` was the case that
> proved it: **added on main, absent from 0.2.0, and provisioning died at "the installed release has
> no systemd/configd.service" on a board that was fine.**

---

## 6. 板级 bring-up

### 6.1 `setup-board.sh`：设备树的那两个静默陷阱

这是整个目录里最长的一个（1122 行），而它开头就把"为什么是脚本而不是一张清单"写清楚了
（`setup-board.sh:227-228`）：

> **Two traps here, both of which fail *silently*** — which is why this is scripted rather than
> written up as a checklist:

那两条（`:229-235`）：

```
1. Armbian 发的是 `overlay_prefix=rk35xx`，但 RK3566 和 RK3568 共用设备树 overlay，
   而它们的文件名是 `rk3568-*.dtbo`。前缀错了，加载器什么都找不到，**开开心心启动，
   然后没有 /dev/ttyS2**。
2. `armbian-config` 的 overlay 编辑器在这块板子上会因为同样的原因崩掉
   （`Invalid overlay_prefix rk35xx`），所以直接改文件。
```

**"前缀错了，加载器什么都找不到，开开心心启动，然后没有 `/dev/ttyS2`。"**
没有那个 UART 就没有舵机总线 —— 而**启动日志里一个字都不会说**。

### 6.2 `setup-rkaiq.sh` + 那个 C 垫片

**rkaiq** 是 Rockchip 的 ISP 用户态：`rkaiq_3A_server` 加 `librkaiq`。
**3A** 是自动曝光 / 自动白平衡 / 自动对焦。

为什么用厂商的（`setup-rkaiq.sh:34-39`）：

> **There is no other 3A on this platform.** libcamera's rkisp1 IPA drives the *mainline* rkisp1
> driver; this board runs Rockchip's vendor rkisp on the vendor kernel, **which is also where the
> hardware encoder `mediad` depends on lives**… **Choosing mainline to get an open 3A would cost
> the VPU.**

**"选主线来换一个开放的 3A，代价是丢掉 VPU。"**

#### 那个 C 垫片为什么存在

`rkaiq-modinfo-shim.c:1-31` 讲了一个很具体的 bug：

> the Radxa camera-engine-rkaiq deb was built against different headers than the Armbian vendor
> kernel (**5203 vs 5207 bytes on 6.1.115**), so **the ioctl fails with ENOTTY, librkaiq silently
> ends up with an empty IQ file name ("/etc/iqfiles//") and segfaults.**

**"ioctl 数字里编码了结构体的大小。"** 而那个结构体在不同 BSP 内核之间漂了 4 个字节。
垫片做的事是**暴力探测**内核期望的大小，然后用**内核自己的 ioctl 号**调一次，再把结果拷回来。

两句值得抄的（`rkaiq-modinfo-shim.c:28-30`）：

> Carried here from the prototype unchanged in substance: **it is the only thing that makes the
> Radxa engine deb run on the Armbian vendor kernel, and it was arrived at by finding the byte
> count.**

**"它是靠找出那个字节数才被搞出来的。"**

### 6.3 `setup-npu.sh`：三件事，不是一个

RK3566 有一个 0.8 TOPS 的 INT8 NPU。用它需要**两半**（`setup-npu.sh:4-7`）：

> the **driver**, which is part of the vendor kernel and is either there or is not, and the
> **runtime** `librknnrt.so`, which is a vendor blob in no Debian suite.

**而第三件是最容易漏的**（`:19-23`）：

> Armbian's `rk3566-radxa-zero3.dtb` ships `npu@fde40000` as `status = "disabled"` **on *every*
> Radxa Zero 3** — so **a runtime installed without it can never run anything.**

**"一个没有它的运行时，永远跑不了任何东西。"**

它**不重启**（`:120-121`）：

> It still never reboots: the change lands on the next boot, and **rebooting somebody's robot is not
> a thing a setup script decides.**

### 6.4 `migrate-network.sh`：那个"够不到"的风险

一次性的 netplan → NetworkManager 迁移。为什么（`:16-19`）：

> netplan is a config *generator*, not a runtime network manager. **It has no scan API**, and
> `netplan apply` reports "config applied" rather than whether association actually succeeded.

它带**后备**（backstop），而这是整份导读里最值得记住的一个模式（`:350-354`）：

> Same principle as the update system's boot counter: **the change that could make the board
> unreachable verifies itself after the reboot and undoes itself if it did not work.**
> Without this, **a wrong key or a missed step costs a serial cable or a card reader.**

**"没有它，一个错的密码或者漏掉的一步，代价是一根串口线或者一个读卡器。"**

---

## 7. `hooks` 的接口：哪些脚本在**每次更新**时也会跑

这一节是 `scripts/` 和 `hooks/` 之间的全部接口。

| hook                         | 调用的脚本                                                                                                                    | 失败会怎样        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------ |
| **`preinstall`**（换链接**之前**）  | `setup-gstreamer.sh` · `setup-rkaiq.sh` · `setup-npu.sh`                                                                 | **只警告**，更新继续 |
| **`postinstall`**（换链接**之后**） | `setup-login.sh` · `setup-quiet-boot.sh` · `seed-policies.sh` · `seed-detector.sh` · 拷 `robot-rescue`/`robot-boot-check` | 单元装不上才致命     |

⚠️ **注意 `preinstall` 从来不碰 `setup-board.sh`** —— 它改设备树，那是 `provision.sh` 的事。

`setup-npu.sh:29-35` 把"为什么一个装机脚本要住在 hook 里"说得最好：

> **Run by `hooks/preinstall` on every update**, beside `setup-gstreamer.sh` and `setup-rkaiq.sh`
> and on the same terms: never fatally, with its report in the update log. **That is what the split
> between provisioning and updating is for — a board provisioned before the NPU existed is fixed by
> an ordinary update rather than by somebody remembering a command**, and a release that ships a
> model should not also ship a manual step before the model can run.
> 
> **Running it by hand is then a retry, not the mechanism.**

**"手动跑它只是重试，不是机制本身。"**

`setup-rkaiq.sh:204-208` 讲了一条 hook 脚本的**成本纪律**：

> Only when there is something to build. **`hooks/preinstall` runs this script on every update**, so
> an unconditional `gcc` is a compile on every release for ever on a board that already has the
> shim — **the cost `updater-design.md` §9.1 says a hook step may not have.**

---

## 8. 测试与诊断

### 8.1 `board-test.sh`：名字骗人，它**不碰板子**

`:14-18`：

> **Not a substitute for hardware**, but it catches everything that only appears off the dev
> machine: cross-linking (notably `zstd`'s C code), glibc floors, unix-socket and file-permission
> semantics, and anything that quietly depended on macOS.

它做的事：交叉编译 → 在一个 `debian:trixie-slim` 的 arm64 容器里跑**真的二进制**。
**没有一个测试需要真硬件** —— 但它需要**真的 Linux 内核**，因为那些 uid/group/socket 的检查
*"Only meaningful on Linux, so this is the only place it can be tested"*（`:295`）。

一个很聪明的做法（`:106-137`）：**它从 CI 的 workflow 文件里解析出产物清单**，
所以被测的就是生产真的会产出的那个东西。

`:104-105` 记了为什么这一步要自己检查：

> Parsing the entry point instead produced **an empty list and a failure two hundred lines later**
> — "the installed release has no systemd/updaterd.service" — so **the emptiness is now checked
> here, where it can name its own cause.**

### 8.2 `systemd-test.sh`：为什么必须真的 pid 1

`systemd-test.sh:8-18`：

> None of it **can see whether a restart *happened***, because none of it has systemd. …
> **really replaces `updaterd` — a child process could not, because it would sit in the cgroup being
> killed.**

它**故意不进 CI**（`:30-33`）：

> It needs `--privileged` and the host's cgroup filesystem, **which is a much larger thing to hand a
> workflow than any check here is worth**… **This is the one to run when `on_apply`, the deferred
> restarts or the hook change — which is rarely, and is exactly when a stub stops being evidence.**

**"而这正是存根不再是证据的时候。"**

### 8.3 那两个手柄脚本问的是**不同**的问题

| 脚本                    | 问题                   |
| --------------------- | -------------------- |
| `pad-link-test.sh`    | **"这条链路现在可靠吗？"**     |
| `pad-stack-report.sh` | **"这两块板子跑的是同一套栈吗？"** |

`pad-link-test.sh:9-18` 把两种失败分开了：

> a **drop**（设备消失，`padd` 记下来，死手停住机器人 —— **响亮而且已经在 journal 里了**）
> 和 a **stall**（链路还在，报文停了几百毫秒，`padd` 继续以 50 Hz 重发上一次的摇杆值，
> 死手永远不触发，**而机器人在拿一个陈旧的命令走路** —— **哪里都没记**）

所以它读**原始 evdev 流**（`od -A n -t u8 -w24 -v`），量 `SYN_REPORT` 之间的间隔。

`:55-57` 记了第一次运行时的假警报：

> Counting those as stalls made the first real run report **three breaches of the deadman on a link
> that never faltered** — the longest of them **75 seconds**, which is **a pad on a table, not a
> radio.**

**"那是桌上的一只手柄，不是电台。"**

而 `pad-stack-report.sh:13-14` 讲了它的第一条设计：

> None of that survives a `diff`, and **a diff full of timestamps is a diff nobody reads.**

### 8.4 恢复的那一对

```
robot-boot-check.timer (OnBootSec=180)
      │
      ▼
robot-boot-check          ← 每次开机一次，3 分钟后
      │  成员：updaterd · robotd · configd · btd
      │  判据：ActiveState=failed **或** NRestarts >= 3
      ▼
robot-rescue --reboot     ← 把 current 换回 golden
```

**"没起来"的定义**（`robot-boot-check:13-19`）：

> Everything else is left alone, and **that asymmetry is the point.** … A daemon still waiting for
> hardware is `active` — **all four members wait rather than exit, which is what makes them members
> at all** — and a single crash that recovered leaves one or two restarts, not three.
> **A false negative here costs an operator a diagnosis; a false positive costs a good release.**

**"这里的一次假阴性代价是一次诊断；一次假阳性代价是一个好发布。"**

**为什么是 3 而不是 1**（`:34-36`）：

> Three, not one. `Restart=always` plus a 2-5s `RestartSec` means **a genuine loop passes three
> within the deadline several times over**, while **a daemon that died once on a transient and came
> back does not. One would fire on the latter.**

**为什么 `robot-rescue` 是 shell 而不是二进制**（`robot-rescue:11-19`）：

> A rescue that ships as a binary in the release payload **is broken by exactly the releases it
> exists to survive**: the wrong architecture, a missing shared library, a panic on startup.
> … A rescue that **parses** that same file **dies of the disease it is treating.**

**"一个要解析那份文件的救援脚本，会死于它正在治的那种病。"**

---

## 9. 开发工具

### 9.1 `duck-sim`：两个模式，不同的目的

| 模式           | 是什么                        | 能测到什么                                                                      |
| ------------ | -------------------------- | -------------------------------------------------------------------------- |
| **`up`**（默认） | 真 daemon 当普通进程跑            | 控制环、策略、IPC、`robotctl`、控制台                                                  |
| **`boot N`** | 每只鸭子一个 `systemd-nspawn` 容器 | **加上** `User=`/组/`RuntimeDirectory=`/加固、更新的 apply、健康门、回滚、重启顺序、`journalctl` |

```
scripts/duck-sim              # 一个窗口打开，鸭子站起来，归你了
DUCK_SIM_DUCKS=4 scripts/duck-sim up
scripts/duck-sim boot 4       # 四只鸭子，四台真 systemd
```

`duck-sim:532-537` 记了一个很实在的坑：

> **`robot.enable`, not `robot init`.** `init` enables torque and then position-ramps to the home
> pose over two seconds **with nothing balancing** — and this duck **cannot hold any pose without a
> policy driving it, at any timestep, from any placement.**

### 9.2 `dev-push.sh`：不走 CI 的那条路

`:16-20`：

> **What this is for**: the loop between "I changed a line" and "the robot is running it" was a
> push, a CI run and a `--ref` install. **Everything CI does to make that artifact happens locally in
> well under a minute**, so **the only reason to involve CI is to publish something other people
> install.**

而 `:22-27` 最重要的一句：

> **It is an ordinary update.** … **a local build that does not come up is reverted and the board is
> back on what it was running.**

⚠️ 而它自己承认**验证是有缺口的**（`:458-465`）：

> The apply reporting success means the swap happened and the health gate passed. **It does not mean
> the seven daemons are running the release that was swapped in** … **four wifi fixes were once
> verified as broken against a `configd` that had never restarted.**

### 9.3 `bake-duck-mesh.py`

把机器人的 MJCF + STL 视觉模型烘焙成 `robotctl/assets/duck.bin`（68,622 字节）。
为什么要提交产物（`:6-9`）：

> `robotctl` ships to the board as **a single binary with no assets directory**, and a terminal is a
> ~100×100-pixel display **for which 330k triangles of CAD export are pure waste.**

---

## 10. ⭐ 只属于 `scripts/` 的那条纪律：shellcheck

这些脚本**没有一个是被编译的**，所以没有编译器能替你抓错别字。
`.github/workflows/ci.yml:70-115` 里有一整段专门讲这件事：

> These are the pieces of this repo that **run without being compiled** — four on a robot, and
> `provision-board.sh` and `dev-push.sh` on a developer's machine — so **nothing else would catch a
> typo in one until someone tried to provision a board.**

**"直到有人试图去装机，否则没有任何东西会发现它们里面的错别字。"**

### 10.1 那段注释是一部事故史

它逐条解释了**为什么每一个脚本在这张清单上**，而每一条都是一个疤：

| 脚本                    | 那段注释怎么说                                                                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci-release-notes.sh` | *"it runs **during a release**, which is the worst moment to find a typo in a shell script."*                                                                                                         |
| `migrate-network.sh`  | *"was missing from this list **while being the riskiest of them** — it is the one step that can make a headless board unreachable, and **the one nobody re-runs once their own board is migrated**."* |
| `robot-rescue`        | *"it is the script that runs when a board **cannot start its update daemon** — **the worst possible moment to find a typo**."*                                                                        |
| `pad-link-test.sh`    | *"it is typed by someone **whose pad is already misbehaving**, and `set -eu` turns a stray `[ x ] && y` into **an exit two minutes into a measurement**."*                                            |
| `hooks/postinstall`   | *"was missing from this list while being **the one file that runs on every board on every update** — **the argument this comment opens with, applied to itself**."*                                   |

**"这段注释开头那个论证，被应用到了它自己身上。"**

而 `board-test.sh` 单独一个任务，因为那 980 行的检查体是**一个巨大的单引号字符串**
（`.github/workflows/ci.yml:117-133`）：

> an apostrophe inside that string closes it early, and everything after it is then expanded by this
> shell instead of the container's. **It cost a full `board` run twice in one afternoon** — four QEMU
> minutes to be told `unexpected EOF`, when SC2211 names the line.
> **`sh -n` alone is not enough: two apostrophes balance, so the syntax is valid and the content is
> silently mangled.**

**"两个撇号是配平的，所以语法合法，而内容被静默地搞坏了。"**

### 10.2 那条"POSIX sh，不是 bash"

同一个任务里：

> **POSIX sh, not bash**: the script is piped to `sh` by the documented one-liner, and **a bashism
> would work on a dev box and fail on the board.**

**"一个 bashism 会在开发机上工作，在板子上失败。"** —— 这就是为什么几乎所有脚本都是 `#!/bin/sh`。

---

## 11. 几处读者会绊到的地方

按仓库的规矩，代码与文档不一致的地方，这里只**陈述事实**，不判断该怎么办。

### 11.1 ⚠️ 六个 POSIX `sh` 脚本不在 shellcheck 清单上

CI 的清单（`.github/workflows/ci.yml:105`）点了 15 个脚本。**`scripts/` 里另有六个 `sh` 脚本不在上面**：

`scripts/` 里一共 **22 个 `#!/bin/sh` 脚本**。清单上是 15 个，`board-test.sh` 由第二个 job 单独 lint，
**剩下六个哪个 job 都不管**：

| 脚本                     | 行数   | 为什么看起来该在清单上                                   |
| ---------------------- | ---- | --------------------------------------------- |
| **`setup-rkaiq.sh`**   | 332  | **`hooks/preinstall.in:164` 在每一块板子的每一次更新上跑它** |
| **`setup-npu.sh`**     | 244  | `hooks/preinstall.in:195` 调用它                 |
| **`robot-boot-check`** | 144  | `hooks/postinstall:44` 安装它，**每次开机由一个定时器跑**    |
| `duck-sim`             | 1105 | 这个目录里最大的脚本                                    |
| `systemd-test.sh`      | 364  |                                               |
| `cross-sysroot.sh`     | 204  |                                               |

**另外两个** `publish-console.sh` / `publish-space.sh` 是 `bash`（`set -euo pipefail`），
所以"POSIX sh，不是 bash"那条理由对它们不适用。

对照一下：hooks 调用的**其他五个**脚本 —— `setup-gstreamer.sh`、`setup-login.sh`、
`setup-quiet-boot.sh`、`seed-policies.sh`、`seed-detector.sh` —— **都在清单上**，
`robot-rescue` 也在（而 `robot-boot-check` 不在）。

而 CI 那段注释自己的论证是：*"这些是不用编译就会运行的部分，所以直到有人试图装机，
没有任何东西会发现它们里面的错别字。"* 按这个论证，上面那三个**在每块板子上运行**的脚本属于这张清单。

**顺带一处**：`setup-npu.sh` 和 `setup-rkaiq.sh` 恰好也是**仅有的两个用 `set -e` 而不是 `set -eu`** 的脚本
（其余 20 个都是 `set -eu`）。所以它们既不在 lint 清单上，运行时的严格程度也和其余的不同。

### 11.2 `CONTRIBUTING.md` 的 `scripts/` 地图缺了 9 个文件

`CONTRIBUTING.md:100-107` 那张图列了 19 项，而 `scripts/` 里有 28 个文件。
**没被提到的九个**：

```
ci-release-notes.sh     duck-sim              publish-console.sh
publish-space.sh        rkaiq-modinfo-shim.c  seed-detector.sh
seed-policies.sh        setup-npu.sh          systemd-test.Dockerfile
```

其中 **`setup-npu.sh` 和 `duck-sim`** 是最显眼的两个 —— 前者在每块板子上跑，
后者是这个目录里最大的脚本（1105 行）。

### 11.3 ⚠️ `--no-rkaiq` 撑不过那次重启

`provision.sh:139` 写着：

```
# `DUCK_RKAIQ=0` turns it off — `--no-rkaiq` on `provision-board.sh`.
```

但存状态的时候（`provision.sh:275`）**只写了 `DUCK_GSTREAMER`**：

```sh
kv DUCK_GSTREAMER "$GSTREAMER"
```

而恢复的时候（`:299`）**也只恢复了 `GSTREAMER`**：

```sh
GSTREAMER="${ENV_GSTREAMER:-${DUCK_GSTREAMER:-1}}"
```

于是 `RKAIQ="${ENV_RKAIQ:-1}"`（`:141`）在 phase 2 里**重新求值成 `1`** ——
而 resume 单元（`:420-441`）什么都不提供 `Environment=`。
**phase 2 会照常跑 `setup-rkaiq.sh`（`:563-572`）。**

`--no-gstreamer` 是好的；**`--no-rkaiq` 在默认（要重启）的那条路上被静默忽略。**

（同一类还有 `DUCK_PAUSE_BTD`：`provision-board.sh:698` 设了它，`provision.sh:274`/`:298` 也不带它。
这个在实践中无害，因为 phase 1 已经跑过 `setup-board.sh` 了。）

### 11.4 `board-test.sh` 的头部说测三个镜像，代码只测一个

`board-test.sh:5-8`：

> Armbian 26.2 also offers Ubuntu Noble and a minimal Debian Bookworm, so we build against an older
> glibc than any of them and **verify against all three** — Trixie first, since that is what will be
> flashed.

而实际（`:43`）：

```sh
IMAGES="${BOARD_IMAGES:-debian:trixie-slim}"
```

**只有一个镜像**。而且后面 `:37-39` 的注释解释了测多个是**被有意砍掉的**：

> The target userland, and only that one. … **testing configurations nobody runs costs ~2x the job
> time to defend a claim we do not need.**

所以**代码是对的，头部那句话说错了**。而它恰好断在一个括号没闭合的地方（`:30-33`），
读起来像是被剪掉了一半。

### 11.5 `setup-board.sh` 里一段过期的注释

`setup-board.sh:112-114`：

> The prototype also enables `i2c-gpio-pihat`, `aic3104-pihat` and a camera overlay; **none apply
> here** — our IMU rides the Dynamixel bus rather than I²C, and **`robotd` owns no camera or
> audio.**

而**同一个文件往下就装了** `i2c3-pihat`、`aic3104-i2c3`、一个音频 codec 的 DKMS 模块
**和**那个摄像头 overlay（`:590`、`:744-772`）。那段注释是音频和摄像头被移植进来之前写的。

### 11.6 `setup-rkaiq.sh` 的头部和它的代码说的不一样

头部（`:25-27`）：

> the shim is **rebuilt each run** because it is cheap and because the kernel it probes can change
> under it.

而代码（`:215`）是用 `cmp -s` 比源码，**一样就跳过编译**：

```
the ioctl shim is current
```

`:204-208` 的注释和代码是一致的（*"an unconditional `gcc` is a compile on every release for ever"*）——
**只有头部那一句是旧的**。

### 11.7 两处小的

| 位置                     | 什么                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `cross-sysroot.sh:4-5` | 一句话里插进了另一段：*"…libudev, for `gilrs` in `padd` — and **The multiarch script this replaced said plainly that it** …"*，引文没有归属了 |
| `duck-sim:912`         | `printf "root:x:0:\n" >/dev/null` —— 写进 `/dev/null`，一个遗留的空操作                                                               |
| `duck-sim:1048`        | `PORT_I="$(duck_port "$i")"` 赋给一个没人读的变量                                                                                    |
| `setup-npu.sh:220`     | 裸调 `ldconfig`，而 `setup-board.sh:328-337` 专门处理了"`/usr/sbin` 可能不在登录 PATH 上"                                                  |

---

## 12. 阅读路线

**11,790 行不可能一次读完。** 按目的选入口：

### 如果你想装一块板子

| 步   | 读什么                                                                |
| --- | ------------------------------------------------------------------ |
| 1   | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) §仓库布局（`:92-106`）—— 那张地图 |
| 2   | [`robot/install-dev.md`](robot/install-dev.md)（操作者视角）              |
| 3   | `provision-board.sh:1-40`（模块文档 + 为什么它存在）                           |
| 4   | `provision.sh:1-60` + `:489-530`（两阶段）                              |
| 5   | `install.sh:1-40`（引导的循环）                                           |

### 如果你想改板级的东西

| 步   | 读什么                                        |
| --- | ------------------------------------------ |
| 1   | `setup-board.sh:1-50`（边界 + 那两个静默陷阱）        |
| 2   | `setup-board.sh:225-275`（overlay 前缀）       |
| 3   | `setup-board.sh:386-425`（getty 那个疤）        |
| 4   | `setup-rkaiq.sh:1-60`（为什么是厂商引擎）            |
| 5   | `migrate-network.sh:1-40` + `:340-400`（后备） |

### 如果你想理解恢复

| 步   | 读什么                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------- |
| 1   | `robot-boot-check:1-45`（成员、阈值、那条不对称）                                                                |
| 2   | `robot-rescue:1-45`（为什么是 shell）                                                                     |
| 3   | [`hooks-primer.md`](hooks-primer.md) + [`design/boot-recovery-net.md`](design/boot-recovery-net.md) |

**如果只有十分钟**：读 §2 那张表、§3 那张图，然后读 `robot-boot-check:13-19`。

三条贯穿全文的主线：

1. **幂等，不交互，不重启。** 每一个脚本都能重复跑；"要不要重启"是一个**脚本不替你决定**的问题
   （唯一的例外是 `provision.sh`，而它的理由写在 `:26-35`）。
2. **静默的失败是这里最大的敌人。** 错的前缀会"开开心心启动然后没有 `/dev/ttyS2`"；
   缺一个组会让 `robotctl health` 读起来像 daemon 崩了；一个过期的 token 会让更新
   "on a timer, forever, with nothing in front of a human"。
   **所以这些东西被写成了脚本而不是清单。**
3. **每一次改动都要能到达已经在场上的板子。** 这就是 `hooks/` 存在的理由，
   而 `scripts/` 里一半的设计（`setup-login.sh`、`setup-quiet-boot.sh`、`seed-*.sh`、`setup-npu.sh`）
   都是在回答同一个问题：**一块在我写这个之前就装好的板子，怎么拿到它？**

---

## 13. 术语表

| 词                              | 意思                                           |
| ------------------------------ | -------------------------------------------- |
| **provision**                  | 让一块空板子具备运行条件。**装机**                          |
| **bring-up**                   | 同上，偏"让硬件活过来"                                 |
| **设备树 / DTB / overlay**        | 描述板子上有什么硬件的树。overlay 是往树上加一段                 |
| **`overlay_prefix`**           | Armbian 找 overlay 文件时加的前缀。**前缀错了会静默地什么都不加载** |
| **`armbianEnv.txt`**           | Armbian 的启动参数文件（在 `/boot`）                   |
| **RK3566 / RK3568**            | SoC 型号。**两者共用设备树 overlay，但文件名前缀不同** ← 那个陷阱   |
| **UART / ttyS2**               | 串口。这里跑 Dynamixel 舵机总线                        |
| **getty**                      | 串口上那个登录提示符。**它会读端口，把舵机的回包吃掉**                |
| **rkaiq**                      | Rockchip 的 ISP 用户态。`3A` = 自动曝光/白平衡/对焦        |
| **ISP**                        | 图像信号处理器                                      |
| **NPU**                        | 神经网络加速器。RK3566 上是一个 0.8 TOPS 的 INT8 单元       |
| **`librknnrt.so`**             | Rockchip 的 NPU 运行时，厂商二进制                     |
| **DKMS**                       | 内核模块的动态编译机制                                  |
| **vendor kernel**              | 厂商分支的内核（这里有 VPU 和摄像头驱动）                      |
| **xenial / trixie / bookworm** | Debian 版本代号                                  |
| **netplan**                    | Ubuntu/Armbian 的网络**配置生成器**（不是运行时管理器）        |
| **NetworkManager**             | 真正的网络管理器，有扫描 API                             |
| **supplicant**                 | 管 wifi 关联的进程。**两个同时在一个网卡上会掉线**               |
| **backstop（后备）**               | 一个"改了会够不到"的改动，重启后自己验证、不成功就自己撤销               |
| **`systemd-nspawn`**           | systemd 的容器工具。`duck-sim boot` 用它跑真 systemd   |
| **`mmdebstrap`**               | 造 Debian rootfs 的工具                          |
| **binfmt**                     | Linux 的"这个二进制用什么解释器"机制。x86 上跑 arm64 容器靠它     |
| **glibc floor**                | 二进制要求的最低 glibc 版本                            |
| **sysroot**                    | 交叉编译时假装成目标系统的那个目录树                           |
| **`PKG_CONFIG_LIBDIR`**        | pkg-config 的搜索路径。**它是替换而不是追加**               |
| **shellcheck**                 | shell 脚本的静态检查器                               |
| **`set -eu`**                  | 出错就退出（`-e`）+ 用未定义变量就报错（`-u`）                 |
| **`pipefail`**                 | 管道里任何一段失败都算失败（bash 特性，`sh` 没有）               |
| **POSIX sh**                   | 可移植的最小 shell 方言。**bashism 在开发机上工作，在板子上失败**   |
| **idempotent（幂等）**             | 重复跑结果一样                                      |
| **golden**                     | 那个已知good、永不删除的发布。恢复网的后备                      |
| **boot counter**               | 启动计数器。开机几次都不健康就自动回滚                          |
| **`LD_PRELOAD`**               | 在别的进程启动前塞进去一个 `.so`，可以拦截它的调用                 |
| **ioctl**                      | 设备驱动的一种系统调用。**它的编号里编码了结构体大小** ← 那个垫片         |
| **ENOTTY**                     | "这个设备不认识这个 ioctl"                            |

---

## 延伸阅读

| 想知道什么                      | 去哪                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| **更新时在这块板子上跑的那两个脚本（姊妹篇）**  | [`hooks-primer.md`](hooks-primer.md)                                                          |
| 板子被配置成什么样子（姊妹篇）            | [`deploy-primer.md`](deploy-primer.md)                                                        |
| 发布、签名、回滚的设计                | [`design/updater-design.md`](design/updater-design.md)                                        |
| 启动恢复网                      | [`design/boot-recovery-net.md`](design/boot-recovery-net.md)                                  |
| 怎么装一块开发板（操作者视角）            | [`robot/install-dev.md`](robot/install-dev.md)                                                |
| 怎么跑仿真（`duck-sim`）          | [`robot/simulation.md`](robot/simulation.md) · [`design/simulation.md`](design/simulation.md) |
| 摄像头那套硬件是怎么 bring-up 的      | [`project/media-bringup.md`](project/media-bringup.md)                                        |
| 手柄的电台怎么诊断                  | [`robot/pair-a-gamepad.md`](robot/pair-a-gamepad.md) · [`padd-primer.md`](padd-primer.md)     |
| 装完之后你用的那个 CLI（姊妹篇）         | [`robotctl-primer.md`](robotctl-primer.md)                                                    |
| 那个被烘焙的 3D 模型画在哪（姊妹篇）       | [`robotctl-primer.md`](robotctl-primer.md) §9                                                 |
| BLE 的线上契约（姊妹篇）             | [`duck-ble-primer.md`](duck-ble-primer.md)                                                    |
| wifi、身份、手柄配对（姊妹篇）          | [`configd-primer.md`](configd-primer.md)                                                      |
| 蓝牙门房（姊妹篇）                  | [`btd-primer.md`](btd-primer.md)                                                              |
| 摄像头、WebRTC、远程网关（姊妹篇）       | [`mediad-primer.md`](mediad-primer.md)                                                        |
| 控制核心：从读总线到写总线（姊妹篇）         | [`duck-control-primer.md`](duck-control-primer.md)                                            |
| 深度矩阵与障碍检测（姊妹篇）             | [`duck-detect-primer.md`](duck-detect-primer.md)                                              |
| 仿真的假电台（姊妹篇）                | [`duck-ether-primer.md`](duck-ether-primer.md)                                                |
| 公共线上契约：它说的那门语言（姊妹篇）        | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md)                                        |
| 笔记本上那个客户端（姊妹篇）             | [`duckctl-primer.md`](duckctl-primer.md)                                                      |
| 关节角 → 空间中的点（姊妹篇）           | [`kinematics-primer.md`](kinematics-primer.md)                                                |
| 里程计与那张地图（姊妹篇）              | [`odometry-primer.md`](odometry-primer.md)                                                    |
| 手柄自己的 IMU：姿态与零偏（姊妹篇）       | [`pad-imu-primer.md`](pad-imu-primer.md)                                                      |
| 摸头检测：麦克风与那个分类器（姊妹篇）        | [`pet-detect-primer.md`](pet-detect-primer.md)                                                |
| 那份配置 schema（姊妹篇）           | [`robotd-params-primer.md`](robotd-params-primer.md)                                          |
| 那个 50 Hz 的控制环（姊妹篇）         | [`robotd-primer.md`](robotd-primer.md)                                                        |
| 鸭子的嗓子：可播种的合成器（姊妹篇）         | [`sounds-primer.md`](sounds-primer.md)                                                        |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md)                                                        |
| 头部的两个传感器：深度与 IMU（姊妹篇）      | [`tof-primer.md`](tof-primer.md)                                                              |
| 永不砖机：签名、健康门、回滚（姊妹篇）        | [`updater-primer.md`](updater-primer.md)                                                      |
| 摄像头的像素：旋转与采样（姊妹篇）          | [`uyvy-primer.md`](uyvy-primer.md)                                                            |
| 发布与自检：打包、签名、晋升（姊妹篇）        | [`xtask-primer.md`](xtask-primer.md)                                                          |
| 构建、测试、仓库约定、发布              | [`../CONTRIBUTING.md`](../CONTRIBUTING.md)                                                    |
