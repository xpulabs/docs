# `deploy` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> `deploy/` 自己的 [`README.md`](../deploy/README.md)（484 行）就是这个目录的权威文档，
> 而信任链的机制由 [`design/updater-design.md`](design/updater-design.md) §5 拥有。
> 本文只做一件事：**带你把这个目录过一遍，并告诉你每个文件归谁管**。
>
> 姊妹篇：[`hooks-primer.md`](hooks-primer.md) —— 那一份讲**发布怎么把自己装到板子上**，
> 这一份讲**板子被配置成什么样子**。

## 目录

1. [一分钟版](#1-一分钟版)
2. [`deploy/` 和 `scripts/` 的分工](#2-deploy-和-scripts-的分工)
3. [目录导览](#3-目录导览)
4. [⭐ 信任链：机器人凭什么相信一个发布](#4--信任链机器人凭什么相信一个发布)
5. [⭐ 日志去哪：两个记录，两种耐久性](#5--日志去哪两个记录两种耐久性)
6. [配置：`robotd.toml` 和 `updater.toml`](#6-配置robotd-toml-和-updater-toml)
7. [硬件使能：设备树和一个内核驱动](#7-硬件使能设备树和一个内核驱动)
8. [部署之后，东西都在哪](#8-部署之后东西都在哪)
9. [阅读路线](#9-阅读路线)
10. [术语表](#10-术语表)

---

## 1. 一分钟版

`deploy/` 里是**属于机器人镜像、而不属于某个服务**的东西。目录自己的 README 第一句就是这个意思：

> 属于**机器人镜像**而不是属于任何一个服务的配置。
> **服务的单元文件住在服务旁边**（`updater/systemd/`、`robotd/systemd/`）；
> **任何机器人范围的东西都在这里。**

```text
   deploy/
   ├── README.md          484 行   ★ 这个目录的权威文档
   ├── robotd.toml        488 行   控制循环的配置（出厂默认值）
   ├── updater.toml       179 行   更新引擎的配置（生产版）
   ├── journald.conf.d/    51 行   日志的持久化与上限
   ├── trusted_keys/               ★ 信任锚：三把 release 公钥
   ├── dev-key/                    开发板的公钥（**故意不放在上面那个目录**）
   ├── audio/                    音频编解码器的设备树 + 一个 vendored 内核驱动
   └── overlays/                 开启 NPU 的设备树 overlay
```

规模：**3795 行，19 个文件**。

> 💡 其中 **1888 行是一个 Linux 内核驱动**（`audio/aic3x-dkms/tlv320aic3x.c`）——
> 一个 C 文件住在一个 Rust 仓库里，而它是**故意的**。见第 7 节。

---

## 2. `deploy/` 和 `scripts/` 的分工

新手最容易问的是："配置在这，那**装它**的脚本呢？"

```text
   deploy/    3795 行   **配置与硬件使能** —— 声明"机器人镜像应该长什么样"
   scripts/   9990 行   **执行那些声明的过程** —— 把上面那些东西装上去
```

**它们不在同一个目录，而这是有意的**：`deploy/` 里的东西**跟着发布走**（被打包进产物、被签名），
而 `scripts/` 里的东西**是被 curl 下来的**。

这也是 `hooks-primer.md` §3.2 里第四个案例的根源：

> 登录 shell 那段 `install.sh` 长了出来，而 **`install.sh` 不被打进发布**，
> 所以**没有任何 hook 能做这件事** —— 直到那个脚本自己搬进 `scripts/`（而 `scripts/` 跟着发布走）。

**记住这一条就够了**：`deploy/` 是"**结果**"，`scripts/` 是"**过程**"。

---

## 3. 目录导览

| 文件 | 行数 | 干什么 | 装到哪 |
|---|---:|---|---|
| `README.md` | 484 | **这个目录的权威文档** | — |
| `robotd.toml` | 488 | 控制循环的配置，**每个值都是内置默认值** | `/etc/robot/robotd.toml` |
| `updater.toml` | 179 | 更新引擎的配置，**生产版**（不是参考版） | `/etc/robot/updater.toml` |
| `journald.conf.d/10-robot.conf` | 51 | 日志持久化与上限 | `/etc/systemd/journald.conf.d/` |
| `trusted_keys/release-{1,2,3}.pub` | 2 各 | **信任锚**：三把 release 公钥 | `/etc/robot/trusted_keys/` |
| `trusted_keys/README.md` | 39 | 为什么是三把、怎么轮换 | — |
| `dev-key/team.dev.pub` | 2 | 开发板的公钥 | **只在你显式推它的时候** |
| `dev-key/README.md` | 26 | 为什么它**故意不在** `trusted_keys/` 里 | — |
| `overlays/rk3568-npu-enable.dts` | 37 | 开启 NPU 的设备树 overlay | `/boot/dtb/.../overlay/` |
| `audio/i2c3-pihat.dts` | 69 | 硬件 I²C 总线（排针 3/5 脚） | 编成 `.dtbo` |
| `audio/aic3104-i2c3.dts` | 92 | 编解码器 + I²S 声卡 | 编成 `.dtbo` |
| `audio/aic3104-init.sh` | 42 | 开机把混音器音量调好 | `/usr/local/bin/` |
| `audio/aic3x-dkms/` | 2280 | **vendored 的内核驱动**（5 个文件） | DKMS 构建 |

### 3.1 ⚠️ 这份目录表比 README 里那张全

`deploy/README.md` 自己也有一张表，但**只列了三项**（`updater.toml`、`trusted_keys/`、`journald.conf.d/`）。
我核实过：**`robotd.toml` 和 `audio/` 在整份 README 里一个字都没提到**
（`robotd.toml` 出现 0 次，`audio` 出现 0 次，`aic3104` 出现 0 次）。

这**不是错误** —— 那份 README 的主题是"**信任链、什么装到哪、日志去哪**"，
而不是一份完整的文件索引，而且 `robotd.toml` 在**它自己里面**有 488 行的注释。
但对一个刚打开 `deploy/` 的人来说，**一个 1888 行的 C 文件出现在目录里、而目录的 README 不提它**，
是值得补一句的。

**`robotd.toml` 的权威解释**是 [`robotd-params-primer.md`](robotd-params-primer.md)，
而 `updater.toml` 的在 [`design/updater-design.md`](design/updater-design.md)。

---

## 4. ⭐ 信任链：机器人凭什么相信一个发布

**这是 `deploy/` 里最值得理解的一部分**，也是这个目录为什么叫"部署"而不是"配置"。

### 4.1 一句话：公钥烧进镜像，签名决定装不装

```text
   发布包 ──用私钥签名──▸ ① manifest 的签名
                         ② artifact 的签名

   机器人 ──用公钥验证──▸ 对得上就装，对不上就拒绝
```

而**公钥从哪里来**？**从镜像里**。`install.sh` 把它们拷到 `/etc/robot/trusted_keys/`，
而 `updater.toml` 里那一行指向它：

```toml
trusted_keys_dir = "/etc/robot/trusted_keys"
```

### 4.2 那个 `.pub` 文件里到底是什么

只有**两行**，而两行都值得看懂：

```text
   untrusted comment: minisign public key: FDD681D1AFBC0B12
   0000000000000000000000000000000000000000000000000000000000000000
   └──────────────────────── base64 ────────────────────────────┘
```

**第一行是"不受信任的注释"** —— `untrusted` 是**字面意思**：
**验证器完全忽略这一行**，它只是给人看的。

**第二行解码出来正好 42 个字节**，结构是：

```text
   ┌────┬──────────────┬────────────────────────────────┐
   │ Ed │  key ID (8)  │  Ed25519 公钥 (32 字节)        │
   │ 2  │              │                                │
   └────┴──────────────┴────────────────────────────────┘
```

（我实际解码验证过：`release-1.pub` 的第二行是 42 字节，前两字节是 `Ed`，
后面 8 字节 `120b bcaf d181 d6fd` **小端反转**之后正是第一行注释里的 `FDD681D1AFBC0B12`。）

> 💡 所以第一行**不泄露任何东西** —— 那个 key ID 本来就在 base64 里。
> 它存在的意义是让**人**能一眼认出"这是哪把钥匙"。

### 4.3 为什么公钥可以公开，私钥不行

`trusted_keys/README.md` 说得直接：

> **公钥不是秘密**，提交进仓库是**对的**。
> 私钥在 `~/.duck-keys` 和密码管理器里，**只有 release-1 的那把在 CI**。

而 `xtask keygen` 把这条写成了**硬约束**：

> **一把被提交进仓库的签名私钥，无法靠事后删除来"收回泄露"。**
>
> （所以 `keygen` 会**拒绝写进仓库里**。）

### 4.4 ⭐ 为什么是**三把** key

这是这个目录里最漂亮的一个设计。三把 key 的**分工**是：

| | 干什么 |
|---|---|
| **release-1** | 签今天所有的发布和晋升。**它的私钥在 CI 里**（因为要自动签名） |
| **release-2** | **第一个轮换目标** —— CI 或 release-1 失守时立刻顶上去 |
| **release-3** | 最后手段。**私钥永不接触任何联网的机器** |

而**真正的理由**在这里（`trusted_keys/README.md`）：

> **三把从一开始就随镜像出厂，而这正是要点。**
>
> **机器人只能用它被烧录时内嵌的那一组 key 来验证** ——
> 所以一台"只有一把 key、而私钥后来丢失或泄露"的机器人
> **无法通过 OTA 更换那把 key**，只能**手工重刷**。
>
> **现在带上备用 key 是免费的；事后补装是不可能的。**

⚠️ 而有一个**残酷的不对称**，README 专门写明了：

> **一个新增的 key，只在"它被加入之后烧录"的机器人上被信任。**
> 所以**轮换只保护未来，救不了已经在现场的机器人** ——
> **而这就是备用 key 必须事先存在的原因。**

### 4.5 泄露之后怎么办：一个**故意滞后**的顺序

`docs/project/ci-setup.md` 记着四步：

```text
   ① 用 release-2 的私钥替换 CI 里的 release-1
   ② **发布一个由 release-2 签名的版本** ← 机器人**已经**信任它
   ③ **在后续的发布里**才把 release-1.pub 从 trusted_keys_dir 移除
   ④ 生成一把新的第三把补位（release-4）
```

**第 ③ 步故意慢于第 ② 步**，而理由是：

> **在每一台机器人都装上 release-2 签名的版本之前就吊销旧 key，
> 会让错过那一版的机器人直接搁浅。**

而 `install.sh` 把这个不对称**落成了代码**：

```text
   缺失的**备用** key → 一条 warning，跳过
   缺失的 **release-1**  → **致命错误**
        （"没有它就无法验证任何东西，也就没有任何东西可以安全安装"）
```

### 4.6 开发密钥：唯一区别是**文件名后缀**

```text
   deploy/trusted_keys/   ← 会被装到**每一台**机器人上
   deploy/dev-key/        ← **默认没有人安装它**
```

`dev-key/README.md` 解释了为什么分开：

> **故意不放在 `../trusted_keys/`** —— 那个目录会被 `install.sh` 拷到**每一台**机器人；
> **而一台信任 dev key 的机器人，会装下团队里任何人构建的东西。**

而一台板子接受分支构建需要**两个独立的条件同时成立**：

```text
   ① 那个 key 在这块板子的 trusted_keys_dir 里，**而且**
   ② 它的 updater.toml 里 allow_dev_keys = true
```

**而把 dev key 和 release key 区分开的，就是文件名**：

```text
   team.dev.pub
        └┬┘
     ".dev." 这个中缀是**承重的，不是装饰**
```

> ⚠️ `install.sh` 会把 dev key **一律装成 `team.dev.pub`，不管来源文件叫什么** ——
> 因为 `.dev.` 这个中缀**就是分类依据**。
> 一把落在别的名字下的 key 会被当成 **release key** 信任，**于是分支构建会被当作已审查的发布接受**。

### 4.7 一个诚实的风险声明

`docs/project/ci-setup.md` 里有一段**坦白陈述的已接受风险**，值得新手读：

> 原来的计划是用 GitHub 的 required reviewers 把关 release-1，
> **而那建不起来**（免费计划的私有仓库不支持，报 `HTTP 422`）。
>
> 所以：**任何有 push 权限的人都能读到 `release-1`。**
>
> **"仅用于发布"只是互信同事之间的约定，不是访问控制** ——
> **workflow 文件不是边界。**

而它点名了那个**无法撤销的失败形态**：

> 泄露意味着要向**每一台**机器人推一个 release-2 签名的更新，
> **而任何错过它的机器人，将永远信任那把已泄露的 key。**

### 4.8 `updater` 只链接"能验证"的那个库

一个值得学的细节（`updater/src/verify.rs`）：

> `updater` 只依赖 `minisign-verify` —— **一个只能验、不能签的库** ——
> 因为**它没资格签名，就不该链接能签名的代码**。

而它的**校验顺序**是：

```text
   ① 验证 manifest 的签名
   ② 下载 artifact
   ③ 校验 artifact 的 sha256
   ④ 验证 artifact 的签名
   → **任何未签名的字节都不会被解包到活动路径、也不会被执行**
```

### 4.9 空目录是**错误**，不是空允许列表

> 一个**空的 keyring 是一个错误**，而不是一份空的允许列表 ——
> **"静默地谁也不信"和"路径配错了"从外面看一模一样。**

---

## 5. ⭐ 日志去哪：两个记录，两种耐久性

这是 `deploy/README.md` 花最多篇幅讲的一件事，而它有一个**实测过**的坑。

### 5.1 两个记录

| | 在哪 | 熬得过重启 | 熬得过断电 | 上限 |
|---|---|---|---|---|
| **服务日志** | journald | 只在配置了之后 | **不能** | `SystemMaxUse=200M` |
| **更新历史** | `/var/lib/robot/updater/update-log.jsonl` | **能** | **能** | 200 条 |

而**更新历史故意不放 journal**：

> 它住在引擎的 `state_dir`（`/var/lib` 下），**每一条在追加时都被 `fsync`**，
> 重写走"临时文件 + rename + 给父目录 fsync"。
>
> 所以**"这台机器人装过什么、后来怎么样了"能熬过一台日志是易失的机器人**，
> 而它可以用 `robotctl update log` 读，或者直接当 JSON 行从磁盘上读。
> **这个性质是被测试验证的，不是假定的。**

### 5.2 那个 `Storage=auto` 陷阱

`journald.conf.d/10-robot.conf` 开头解释了**为什么需要这个文件**：

> systemd 的默认值是 `Storage=auto`，它**把日志留在 RAM 里**（`/run/log/journal`），
> 除非 `/var/log/journal` 已经存在。
>
> 在一张它不存在的镜像上，**每一次日志都在重启时丢掉** ——
> 于是 support 永远会问的那个问题（**"它重启之前说了什么？"**）恰恰就是缺失的那个。

所以这里写死 `Storage=persistent` —— **让行为明确，并自己创建那个目录**，
而不是取决于别的包碰巧有没有创建它。

### 5.3 ⚠️ 而它在 `/var/log` 是 tmpfs 时**不够**

这是注释里的一段警告，而且它是**实测的**：

> ⚠️ **如果 `/var/log` 是 tmpfs，这个文件本身不够。**
> Armbian 镜像带过一种 RAM 日志机制（`armbian-ramlog` / `log2ram`），它把 `/var/log` 挂到内存里来省 SD 卡，
> 定期、以及在干净关机时同步到磁盘。
>
> 在那种情况下，**这个文件让 journald *以为*它是持久的**，
> 而**一次不干净的断电仍然会丢掉最近的日志** ——
> **而机器人一直在被不干净地断电。**
>
> 在板子上验证：
> ```bash
> findmnt /var/log                  # 这里显示 tmpfs 就意味着日志在内存里
> systemctl status armbian-ramlog   # 或者 log2ram
> ```

而 `deploy/README.md` 记了后续（**实测之后**）：

> `/var/log` 在这张镜像上是一个 **zram 设备**，所以 `Storage=persistent` 拿到的目录**本身就在内存里**。
> 它在板子上确认过，不是推断的……
>
> 它**熬得过一次干净的 `reboot`**（因为关机会写回），
> 而**在一次断电时丢掉最近的日志 —— 而那才是机器人实际被关掉的方式**。
>
> 所以服务日志**按构造就是尽力而为的**，而**持久的记录是 `/var/lib` 下的更新历史**。

> 💡 **这是"设计意图"和"平台现实"打架时正确的处理方式**：
> 不改默认值、不假装问题不存在 —— **说清楚哪个是持久的、哪个是尽力而为的，并指出改动它的代价**：
> ```bash
> sudo systemctl disable --now armbian-zram-config   # 日志落到 eMMC 并磨损它
> ```
> *"那是一个**每块板子各自的决定**，不是一个该全机队改掉的默认值。"*

### 5.4 上限和限流

```text
   SystemMaxUse=200M         eMMC 很小，而机器人要跑好几个月
   SystemMaxFileSize=20M     200M / 20M ≈ 保留十次轮转 —— 够跨好几次启动，
   SystemMaxFiles=10         而这正是让"崩溃之前的日志"够得着的东西
   MaxRetentionSec=3month    一台闲置了几个月的机器人不该还留着那时的日志
   Compress=yes
   ForwardToSyslog=no        这张镜像上没有任何东西消费 syslog
                             （顺带跳过 /dev/kmsg，它有自己的一小圈缓冲）
```

而限流那条最值得看：

> **限流保持开启** —— 一个真正失控的服务不能填满磁盘 ——
> **但默认值（每服务 30 秒 1000 条）低到会在崩溃循环中丢消息**，
> **而那恰恰是每一行都重要的时候。**
>
> **提高它，而不是去掉它。**

```text
   RateLimitIntervalSec=30s
   RateLimitBurst=10000        ← 默认是 1000
```

---

## 6. 配置：`robotd.toml` 和 `updater.toml`

### 6.1 两种"生产版 vs 参考版"的哲学，并排放在一个仓库里

这是这个仓库里一个**很有意思的对照**：

| | `robotd` | `updater` |
|---|---|---|
| **生产文件** | `deploy/robotd.toml`（488 行） | `deploy/updater.toml`（179 行） |
| **参考文件** | **就是生产文件本身** | `updater/updater.example.toml`（214 行） |
| 风格 | **穷尽注释，每个键都有一大段** | 生产版**刻意简洁**，参考版才解释每个选项 |

`updater.example.toml` 的开头把两种文件的定位说得很清楚：

> **不是发货的那个。** `deploy/updater.toml` 是 `scripts/install.sh` 装到机器人上的文件；
> **这一个记录每一个选项，包括若干在那边被刻意留空的。**
> **两者不同之处，正是要点 —— 两份的注释都读。**

而 `deploy/updater.toml` 的开头回敬了同一句：

> 和 example 的区别就是要点：**example 展示什么是可能的，这一份展示一台发货的机器人*实际*是什么样**。
> 下面每一个值要么是一个**决定**，要么是一个**事实**；
> 两份文件不一致的时候，**example 的注释解释那个选项，这份的注释解释那个选择**。

> 💡 `robotd.toml` 走的是另一条路：**它自己就是参考** ——
> 而且**它被一个测试钉住**：`the_shipped_example_matches_the_defaults` 逐项断言文件里的每个值都等于内置默认值
> （见 [`robotd-params-primer.md`](robotd-params-primer.md) §13.2）。

### 6.2 ⚠️ `ORG/duck-daemon` 是一个**有守卫的**占位符

`deploy/updater.toml` 里有一行看起来像没填完：

```toml
repo           = "ORG/duck-daemon"
```

**它不是 bug。** `install.sh` 在安装时会替换它：

```sh
fetch "${config_raw}/deploy/updater.toml" "${CONFIG_DIR}/updater.toml"
sed -i "s|\"ORG/duck-daemon\"|\"${REPO}\"|" "${CONFIG_DIR}/updater.toml"
```

而 `REPO` 默认是 `pollen-robotics/microduck`，可以用 `DUCK_REPO` 覆盖。

**而它有一个守卫** —— 如果替换没发生（比如你直接拿这个文件用），`install.sh` 会**直接死掉**：

```sh
case "$REPO" in
    ORG/*)
        die "REPO is still the placeholder '${REPO}'.
  Set DUCK_REPO, or substitute the real repository in scripts/install.sh and
  deploy/updater.toml. A robot installed against a repository that does not exist
  installs fine and then never finds another update."
        ;;
esac
```

> 💡 这值得学：**一个占位符要么有守卫，要么就是一个等着发生的 bug。**
> 而它给出的理由很实在 —— **一台对着不存在的仓库装好的机器人，会装得很顺利，然后永远找不到下一次更新。**

### 6.3 `updater.toml` 里三个值得看的决定

**一、`allow_users = ["btd", "mediad"]`，以及**绝不能出现**的那个值：**

```text
   btd      ← 机主从手机更新机器人，正是 M6 要交付的东西
   mediad   ← 控制台页面是登录的地方，以及 Hub 浏览器的安装按钮

   ⚠️ 绝不能出现的是 allow_groups = ["robot"]：
      robot 组的成员身份让一个进程**够到** updaterd（说话），
      把"可以改"也给它，就把两层塌成一层 ——
      于是**任何能读状态的东西都能替换固件**。
```

而注释特意说明：**这是被一个测试守住的，不是被这段注释守住的**。

**二、`auto_apply = "mandatory"` 是刻意的默认值：**

> 一个 manifest 里 `min_supported` 高于当前版本的发布 —— **因为另一个选择是整个机队卡在一个我们已经撤回的版本上。**
>
> **普通发布仍然等一个客户端**：**机器人什么时候重启是它主人的决定**，
> 而 App 驱动的更新流程存在的意义就是把这个决定交给他。

**三、健康门回滚的是 `unhealthy`，**不是** `degraded`：**

> 一台**看不见自己舵机**的机器人报告 `degraded`，**然后通过**：
> 它在换版之前说的也是同一句话，所以**回滚修不了它，
> 而且会把每一个发布都回滚掉**。

（这正是 [`robotd-primer.md`](robotd-primer.md) §6.3 那条规矩在配置里的体现。）

**四、`golden` 故意是注释掉的：**

> 它命名一个**永不删除的已知良好发布**，而 `robotctl update reset-to-golden` 是那条"永不砖化"链条的最后一环。
> **命名一个机器人从没装过的版本，会让那条命令在恰恰最需要它的时候失败** ——
> 那比它诚实地报告"没有配置 golden"更糟。
> **在发布 1.0.0 的同一次改动里设置它。**

---

## 7. 硬件使能：设备树和一个内核驱动

`deploy/` 里还有一类东西：**让这块板子上的硬件真的能用**。

### 7.1 音频那件事：五层

`scripts/setup-board.sh` 里有一段**权威的五层解释**（这是整个音频目录存在的理由）：

> 五层，每一层都是幂等的：
>
> **① `alsa-utils`**（`aplay`/`arecord`/`amixer`）+ DKMS 工具链 + `dtc`。
>
> **② Armbian 的*厂商*（BSP 6.1）内核** ——
> **编解码器的 I²S 时钟树只存在于那里**，而 DKMS 模块对着它的头文件构建。
>
> **③ 设备树 overlay**，从 `deploy/audio/` 里 vendored 的源码编译：
> **排针 3/5 脚上的硬件 i2c3 总线**，以及**嫁接在它上面的编解码器 + I²S 声卡**。
>
> **④ 编解码器驱动本身**，通过 DKMS 树外构建 ——
> **厂商内核不构建 `SND_SOC_AIC3X`，这就是为什么一块原装板子没有 aic3104 声卡。**
>
> **⑤ 开机时的混音器音量**：`aic3104-init.service`，
> 在 `robotd` 之前跑那个 vendored 的 `amixer` 脚本，**好让那声"你好"听得见**。

**所以那 1888 行 C 文件为什么在这里？** 因为：

1. **那块芯片的时钟树只存在于厂商内核里**（换内核就没有声音了）；
2. **而厂商内核偏偏不构建那个编解码器驱动**。

于是他们**把驱动 vendor 进仓库，用 DKMS 树外构建**。

### 7.2 DKMS 是什么

```text
   dkms.conf      PACKAGE_NAME="aic3x" / PACKAGE_VERSION="6.1-rkr5.1"
                  AUTOINSTALL="yes"    ← ★ 内核升级后自动重建
   Makefile       声明两个模块：snd-soc-tlv320aic3x[-i2c].ko
```

**`AUTOINSTALL="yes"` 是这一整套的关键**：内核一升级，DKMS 会**自动重新编译**这个模块。
没有它，一次 `apt upgrade` 就会让机器人**失去声音和耳朵**。

> 💡 所以 `deploy/audio/` 里的东西是**跟着内核走的**，不跟着发布走 ——
> `setup-board.sh` 把它们编译好放进 `/boot/dtb-*/rockchip/overlay/`，
> 而它是一个**只在 provision 时做一次**的动作（参见 `deploy/README.md` 里那句
> "`setup-board.sh` 是 OS 级 bring-up……**改得很稀，而且需要重启**"）。

### 7.3 ⭐ NPU 那个 overlay：**只有一个属性**

`overlays/rk3568-npu-enable.dts` 只有 37 行，而它的注释把"为什么这很安全"说完了：

> Armbian 的 `rk3566-radxa-zero3.dtb` 把 `npu@fde40000` 发成 `status = "disabled"`，
> **而它提供的唯一一个 NPU overlay 是进一步禁用它** ——
> 所以这个节点必须在 `librknnrt.so`、`duck-detect` 或 NPU 驱动能做任何事之前**手工打开**。
>
> **只有一个属性。** 驱动需要的其余一切**已经在基础节点里了**：
> 时钟、复位、`power-domains`、`operating-points-v2`、`iommus` 和 `rknpu-supply`。
> **那就是为什么它可以放心试** —— **失败模式是一个探测不到的驱动，而那正是这块板子现在所在的位置。**

```dts
	fragment@0 {
		/*
		 * 按路径而不是按标签：基础 dtb 没有为这个节点导出 `__symbols__` 条目，
		 * 所以 `&rknpu` 在 overlay 应用时解析不了。
		 */
		target-path = "/npu@fde40000";
		__overlay__ {
			status = "okay";
		};
	};
```

> 💡 那句 **"失败模式是一个探测不到的驱动，而那正是这块板子现在所在的位置"**
> 是一个很好的判断准则：**当"什么都不会发生"和"现在就是这样"是同一件事时，试它就没有下行风险。**
>
> 而 `target-path` vs `&rknpu` 那个细节是设备树 overlay 的经典坑。

这和 [`duck-detect-primer.md`](duck-detect-primer.md) §6.1 是同一件事的两面 ——
那一份讲"驱动没绑上时检测器怎么退化到 CPU"，这一份讲"怎么把它打开"。

---

## 8. 部署之后，东西都在哪

`deploy/README.md` 有一张很实用的表：

```text
/etc/robot/updater.toml                  配置；**更新永不碰它**
/etc/robot/robotd.toml                   同上
/etc/robot/trusted_keys/release-*.pub    信任锚
/opt/robot/daemon/releases/<版本>/        发布树
/opt/robot/daemon/current -> releases/<版本>
/etc/systemd/system/*.service            **每一个单元，从发布里拷出来**
/usr/lib/sysusers.d/robot.conf           创建 `robot` 组
/var/lib/robot/updater/                  锁、更新日志、启动计数器
/usr/local/bin/robotctl -> current/bin/robotctl
/usr/local/sbin/robot-provision          provisioning，重启后接着跑
/var/lib/robot/provision.log             无人看管的那一半做了什么
```

### 8.1 单元文件是**拷贝**而不是符号链接

这一条的理由很实在：

> **读时通过符号链接，它们会在每次更新时在 systemd 脚下改变**，
> 而**回滚之后 systemd 的视角会取决于上一次 `daemon-reload` 时碰巧是哪个发布活着**。
>
> **而 `robotctl` *是*一个符号链接** —— 因为**它是一个操作者去调用的工具，
> 而不是一个 systemd 会缓存的文件**。

> 💡 **同一个"符号链接 or 拷贝"的选择，在两个不同的消费者面前答案相反** ——
> 判据是"谁在读它、以及它会不会被缓存"。

### 8.2 为什么 `install.sh` 直接跑会让第一次 `robotctl health` 失败

这是一个**很经典的 Unix 细节**，README 专门警告了：

> ⚠️ **直接跑 `install.sh`，第一次 `robotctl health` 会失败，而安装本身是好的。**
>
> 两个 socket 都是 `root:robot` 模式 0660，而 `install.sh` 把操作者加进了 `robot` ——
> **但一个进程的组在它*启动*时就固定了**，
> 所以**运行安装的那个 shell 不在它刚刚加入的那个组里**。
>
> 在同一个 shell 里一条命令：
> ```bash
> newgrp robot
> ```
>
> **没有任何 API 能给一个正在运行的进程加组，即使对 root 也没有** ——
> 所以安装器做什么都修不了启动它的那个 shell。
>
> **这就是 `provision.sh` 在第一阶段就创建那个组的原因**，而重启完成了剩下的工作。

> 💡 这段还解释了为什么 `robotctl` 在失败时**点名这条命令**，而不是把你送去 `systemctl status` ——
> **那会显示两个完全健康的 daemon。**

---

## 9. 阅读路线

**第 1 步 —— 先读那份 README（1.5 小时）**

1. 读 [`deploy/README.md`](../deploy/README.md) 的 **Quickstart**（`:22`–`133`）。
2. 读 **`The trust chain`**（`:288`）和 **`What ends up where`**（`:350`）。
3. 读 **`Where logs go`**（`:393`）—— 第 5 节那个 zram 的故事。

**第 2 步 —— 信任（1 小时）**

4. 读 `deploy/trusted_keys/README.md`（**39 行，全读**）—— 为什么是三把。
5. 读 `deploy/dev-key/README.md`（**26 行，全读**）—— 为什么它不在上面那个目录里。
6. 读 [`project/ci-setup.md`](project/ci-setup.md) 里的**已接受风险**那一节。
7. 自己解码一把公钥：
   ```bash
   sed -n '2p' deploy/trusted_keys/release-1.pub | base64 -d | xxd | head -3
   # 42 字节，前两字节是 "Ed"
   sed -n '2p' deploy/trusted_keys/release-1.pub | base64 -d | xxd | sed -n '1p'
   # 对比第 1 行注释里的 key ID（小端反转）
   ```

**第 3 步 —— 配置（1 小时）**

8. 读 `deploy/updater.toml` 全文（179 行）—— 注意每条注释都在**解释一个选择**。
9. 读 `updater/updater.example.toml` 的开头 30 行 —— 那份**解释选项**。
10. 读 `deploy/robotd.toml` 的开头（前 40 行）—— 那份**就是**文档。

**第 4 步 —— 硬件（40 分钟）**

11. 读 `scripts/setup-board.sh:488–500`（那五层）。
12. 读 `deploy/overlays/rk3568-npu-enable.dts`（37 行，全读）。
13. 读 `deploy/audio/aic3x-dkms/dkms.conf`（9 行）—— `AUTOINSTALL="yes"` 是重点。

**第 5 步 —— 动手（在板子上）**

```bash
robotctl health                      # 部署完了吗
findmnt /var/log                     # 日志在 RAM 里吗
journalctl --list-boots              # 上一轮启动的日志还在吗
robotctl update log                  # 那个持久的记录
```

---

## 10. 术语表

| 术语 | 意思 |
|---|---|
| **deploy / 部署** | 把一台机器人从"一块板子"变成"一台能工作的机器人"的过程 |
| **provisioning** | 同上的另一个说法，通常特指**首次**那一次 |
| **trust anchor / 信任锚** | 那个"你无条件相信"的起点。这里是一组公钥 |
| **minisign** | 一个小巧的签名工具（Ed25519）。发布包用它签名 |
| **公钥 / 私钥** | 用来**验证** / 用来**签名**。公钥可以公开，私钥绝不能 |
| **`.pub`** | 公钥文件。这里只有两行：一行给人看的注释，一行 base64 |
| **Ed25519** | 一种椭圆曲线签名算法。那 32 字节就是它的公钥 |
| **key ID** | 一把 key 的短标识。**它本来就是公开的** |
| **keyring / 钥匙环** | 一组被信任的公钥。**空的 keyring 是错误，不是"谁也不信"** |
| **轮换 / rotation** | 换一把新的签名密钥。**因为信任集合只能烧录，所以必须提前备好** |
| **`.dev.pub`** | 文件名里带 `.dev.` 中缀的公钥 —— **这就是"开发密钥"的分类方式** |
| **吊销 / revoke** | 把一把 key 从信任集合里去掉。**只能靠一次新的发布生效** |
| **journald / journal** | systemd 的日志系统 |
| **zram** | 一块**在内存里**的块设备（压缩过的）。`/var/log` 在这张镜像上就是它 |
| **fsync** | 强制把数据真正写到磁盘 |
| **原子替换** | 先写临时文件再 rename。中途失败不会留下半个文件 |
| **设备树 / device tree** | Linux 上描述硬件的那个数据结构 |
| **overlay** | 在设备树上叠一层修改。**不重编内核就能改硬件描述** |
| **`.dtbo`** | 编译好的设备树 overlay（`.dts` 是源码） |
| **DKMS** | Dynamic Kernel Module Support —— **内核升级后自动重建模块**的机制 |
| **树外模块 / out-of-tree** | 不在内核源码树里构建的内核模块 |
| **BSP / 厂商内核** | 芯片厂商维护的那个内核分支。**它的驱动比主线多** |
| **ALSA / ASoC** | Linux 的音频子系统 / 它的嵌入式编解码器框架 |
| **codec / 编解码器** | 音频芯片。这里是 TLV320AIC3104 |
| **I²S** | 一种数字音频接口 |
| **I²C** | 一种两线制的芯片间控制总线 |
| **amixer** | 命令行调音量的 ALSA 工具 |
| **NPU** | 神经网络加速器（见 `duck-detect-primer.md`） |
| **排针 / header pins** | 板子边上那排可以插线的针脚 |
| **占位符 / placeholder** | 一个等着被替换的值。**要么有守卫，要么就是等着发生的 bug** |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| **这个目录自己的权威文档** | [`../deploy/README.md`](../deploy/README.md) |
| 信任链与签名的完整机制 | [`design/updater-design.md`](design/updater-design.md) §5 |
| 密钥的一次性设置与轮换 | [`project/ci-setup.md`](project/ci-setup.md) |
| `robotd.toml` 的每个键 | [`robotd-params-primer.md`](robotd-params-primer.md) |
| 发布怎么把自己装上去（姊妹篇） | [`hooks-primer.md`](hooks-primer.md) |
| 哪一步重启哪个单元 | [`design/restart-order.md`](design/restart-order.md) |
| NPU 那件事的另一半 | [`duck-detect-primer.md`](duck-detect-primer.md) §6 |
| 蓝牙门房：手机怎么连上机器人（姊妹篇） | [`btd-primer.md`](btd-primer.md) |
| wifi、身份、手柄配对（姊妹篇） | [`configd-primer.md`](configd-primer.md) |
| BLE 的线上契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| 控制核心：从读总线到写总线（姊妹篇） | [`duck-control-primer.md`](duck-control-primer.md) |
| 仿真的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| 所有服务与客户端的公共契约（姊妹篇） | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| 笔记本上的客户端（姊妹篇） | [`duckctl-primer.md`](duckctl-primer.md) |
| 完整的安装流程 | [`robot/install-dev.md`](robot/install-dev.md) · [`robot/install-by-hand.md`](robot/install-by-hand.md) |
| 鸭子的身体几何：正/逆运动学、ToF 重投影（姊妹篇） | [`kinematics-primer.md`](kinematics-primer.md) |
| 摄像头、WebRTC、远程可达（姊妹篇） | [`mediad-primer.md`](mediad-primer.md) |
| 机器人走到哪了：接触式里程计（姊妹篇） | [`odometry-primer.md`](odometry-primer.md) |
| 手柄自己的 IMU：姿态、零偏、yaw 漂移（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| 手柄：按键映射、模式、那个 raw tap（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| 用麦克风的那个人：log-mel、arecord、重训（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| 机器人上的那个 CLI（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| 装机、更新、诊断的那些工具（姊妹篇） | [`scripts-primer.md`](scripts-primer.md) |
| 鸭子的嗓子：可播种的合成器（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 头部的两个传感器：深度与 IMU（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
