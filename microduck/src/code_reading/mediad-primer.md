# `mediad` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> WebRTC 的机制由 [`design/remote-webrtc.md`](design/remote-webrtc.md) 拥有，
> 控制台页面归 [`design/webrtc-console.md`](design/webrtc-console.md)，
> 外网可达（账号、桥、NAT/TURN）归 [`design/remote-access-design.md`](design/remote-access-design.md)，
> 板子上的视频硬件归 [`project/media-bringup.md`](project/media-bringup.md)。
> 两者若有不一致，以设计文档为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：[`duck-detect-primer.md`](duck-detect-primer.md)（这个 crate 用它看鸭子）、
> [`duckctl-primer.md`](duckctl-primer.md)（笔记本上那个消费者）。

## 目录

1. [一分钟版](#1-一分钟版)
2. [它在整个系统里的位置](#2-它在整个系统里的位置)
3. [⭐ 两条路：WebRTC 是默认，`media.stream` 是回退](#3--两条路webrtc-是默认mediastream-是回退)
4. [目录导览](#4-目录导览)
5. [⭐ 核心心智模型：三个互不相干的东西](#5--核心心智模型三个互不相干的东西)
6. [启动顺序，以及每一步为什么在那个位置](#6-启动顺序以及每一步为什么在那个位置)
7. [管线：从摄像头到浏览器](#7-管线从摄像头到浏览器)
8. [控制通道：一条哑管道](#8-控制通道一条哑管道)
9. [外网可达：`relay` 与 `turn`](#9-外网可达relay-与-turn)
10. [控制台页面](#10-控制台页面)
11. [本地取帧：`media.frame`](#11-本地取帧mediaframe)
12. [软件自动曝光](#12-软件自动曝光)
13. [在 tee 上找鸭子](#13-在-tee-上找鸭子)
14. [流出去：`media.stream`](#14-流出去mediastream)
15. [摄像头几何](#15-摄像头几何)
16. [构建、部署、权限](#16-构建部署权限)
17. [测试：122 个，绝大多数不需要板子](#17-测试122-个绝大多数不需要板子)
18. [几处读者会绊到的地方](#18-几处读者会绊到的地方)
19. [阅读路线](#19-阅读路线)
20. [术语表](#20-术语表)

---

## 1. 一分钟版

`mediad` 是**机器人的眼睛**，以及**从外面够到这只机器人的那扇门**。

它一个人干三件互不相干的事，这是读懂它最重要的一点：

| 干什么 | 在哪 | 能不能离开 Linux |
|---|---|---|
| **摄像头管线**：采集 → 编码 → WebRTC | `pipeline.rs`（2704 行） | ❌ 只有 Linux（或 `--features gstreamer`） |
| **控制通道**：一条哑管道，把 peer 的调用转给本地服务 | `session.rs` · `route.rs` · `upstream.rs` | ✅ 可移植，笔记本上能测 |
| **出站连接**：注册到 rendezvous、取 TURN 凭据、往外推帧 | `relay.rs` · `turn.rs` · `stream.rs` | ✅ 可移植 |

一句话说清它的定位：

> **它是"机器人怎么被看见、怎么被驱动"的唯一实现，而且它不在恢复路径上。**

第二条同样重要（`main.rs:15-17`）：

> **It is not on the recovery path.** If `mediad` will not start, the robot still walks, still
> takes an update, and is still reachable over Bluetooth.

**`mediad` 起不来，机器人照样走、照样更新、照样能用蓝牙够到。**
所以它才敢依赖一个从 release 资产里下来的插件、一个设备节点的用户组 —— 那些是 `updaterd` 不敢的。

---

## 2. 它在整个系统里的位置

`mediad` 是个**叶子**：workspace 里没有任何 crate 依赖它（它是 binary，不是库）。
它依赖别人：

```toml
# mediad/Cargo.toml:30-94（节选）
hf-robot-account = "0.1"          # 只有一件事：read_access_token
duck-ipc-proto                   # 公共线上契约
robotd-params                    # [media] 和 [duck_detector] 的 schema
duck-detect                      # 鸭子检测器本体
uyvy                             # 采样器：像素格式转换
```

注意 `robotd-params` 那一条的注释（`Cargo.toml:36-38`）：

> `[media]` and `[duck_detector]` in /etc/robot/robotd.toml — what this daemon streams, and what it
> looks for. **The same crate `robotd` parses that file with and the same one `robotctl configure`
> edits it through, so the schema, the defaults and the editor cannot drift from what is read here.**

**配置文件是同一份，读它的 crate 也是同一个。** `[duck_detector]` 明明归 `mediad` 用，
却住在 `robotd.toml` 里，理由在 `main.rs:499-501`：

> a robot has **one place for its switches**

一只机器人只有一个放开关的地方。

### 谁在用它

| 消费者 | 怎么用 |
|---|---|
| **浏览器 / 手机** | 直接连 `ws://<robot>:8443`，看视频 + 控制 |
| **`robotctl monitor`** | 通过 `media.frame` 拿一帧，画成半格像素的摄像头块 |
| **`robotctl health`** | 读 `/run/mediad/camera.json`（`CameraStats`） |
| **Hugging Face Space** | 经 rendezvous 远程，或机器人拨出去推帧 |
| **recorder / 感知进程** | 本地 `media.frame` socket |

> 💡 **`mediad` 不是 request/response 服务**。它没有自己的 socket 用来回答问题 ——
> 它把调用转发给别的服务（`duck-ipc-proto/src/lib.rs:5111-5113`）。
> 唯一的例外是本地那个 `media.frame`，以及 `media.video`/`media.stream` 两个由它自己答的方法。

---

## 3. ⭐ 两条路：WebRTC 是默认，`media.stream` 是回退

这是仓库里**最容易读反**的一件事，值得单独一节。

`stream.rs`（985 行）的模块文档**长篇论证自己的存在**。仓库根目录的 `CLAUDE.md` 特意警告：

> This is worth stating because the repository reads the other way round if you only follow the
> code: `media.stream` was built when the relay endpoint was dead and WebRTC genuinely could not
> connect from a data centre, so its module doc argues its own case at length. **That endpoint is
> fixed. Do not conclude from the volume of prose that it is the preferred path.**

`stream.rs` 自己也在第一段就承认了（`stream.rs:5-10`）：

> **A consumer should use WebRTC** … This module is for the narrow case WebRTC serves badly: a
> **program** consuming **frames only** on a **long-running** stream, where a relay's metered
> bandwidth is the cost that matters.

### 该怎么选

```
你的消费者是人（浏览器 / 手机）？
  └── 是 → WebRTC。没有第二个选择。

你的消费者是程序？
  ├── 需要驱动机器人（有返回路径）？ → WebRTC
  ├── 需要音频 / 第二条视频轨？      → WebRTC
  └── 只要帧、跑一整天、在意流量？    → media.stream ✅
```

`media.stream` 换来的好处是**不花任何人的中继流量** —— 机器人拨出去，不需要打洞：

```
你的 Space ──media.stream {url: "wss://…/frames"}──►  rendezvous  ──►  机器人
机器人    ══════════ 帧，出站 wss，直连 ══════════════►  你的 Space
```

代价（`docs/faq.md`）：**没有返回路径、没有控制通道、加密是你自己的 TLS 而不是 DTLS-SRTP。**

### 还有第三条，别搞混

`frame.rs`（`media.frame`）**既不是 WebRTC 也不是 `media.stream`** —— 它是**给机器人上跑的程序**用的本地 unix socket。三者不要混为一谈。

---

## 4. 目录导览

```
mediad/
├── Cargo.toml            155 行 —— 头 28 行讲清"为什么会有 C 依赖"
├── src/
│   ├── pipeline.rs      2704 行  GStreamer 管线 + datachannel      [Linux/feature]
│   ├── relay.rs         2563 行  到 rendezvous 的出站连接
│   ├── stream.rs         985 行  帧出站到 Space                    [部分 gated]
│   ├── exposure.rs       726 行  软件自动曝光                      [Linux]
│   ├── session.rs        715 行  一条哑管道
│   ├── main.rs           707 行  组装根：17 步启动
│   ├── turn.rs           561 行  TURN 凭据
│   ├── route.rs          545 行  哪些调用可以被 peer 调用
│   ├── frame.rs          514 行  本地 media.frame 端点             [Linux/feature]
│   ├── camera.rs         460 行  内参（几何）
│   ├── detect.rs         398 行  在 tee 上找鸭子                   [Linux/feature]
│   ├── web.rs            339 行  控制台页面（axum）
│   ├── upstream.rs       301 行  五个服务的连接池
│   ├── producer.rs       253 行  开会话之前先说清自己是谁
│   ├── snapshot.rs       134 行  media.frame 的客户端（页面用）
│   ├── config.rs         105 行  [media] 的加载
│   └── lib.rs             68 行  模块地图
├── systemd/
│   ├── mediad.service          —— 144 行，注释比指令多
│   └── sysusers.d/mediad.conf
└── webclient/
    ├── index.html       1754 行  控制台页面（单文件）
    └── space/            你要推到 Hugging Face 的那个 Space
```

### cfg 门控：四个模块有，其余没有

`lib.rs` 是这张表最清楚的来源：

| 模块 | 门控 | 为什么 |
|---|---|---|
| `pipeline` · `detect` · `frame` | `any(target_os = "linux", feature = "gstreamer")` | 需要 GStreamer |
| `exposure` | `target_os = "linux"` **单独** | **不是打包决定**，见下 |
| 其余 12 个 | 无 | 可移植 |

`exposure` 那条的理由（`lib.rs:49-52`）：

> **Linux only, and unlike [`pipeline`] that is not a packaging decision**: this writes V4L2
> controls to a camera through `ioctl`. Nothing off a robot wants it — **there is no sensor behind a
> simulated source or a test pattern to meter**.

**没有传感器可以测光** —— 所以它不是"能不能编"，而是"有没有意义"。

`Cargo.toml:8-11` 讲了为什么**用 target 门控而不是 feature**：

> Gating by target rather than by feature keeps `cargo test` honest — **a feature that is off by
> default is a module nobody compiles.**

**默认关掉的 feature = 没人编译的模块。**

---

## 5. ⭐ 核心心智模型：三个互不相干的东西

读 `mediad` 最省力的方式，是先把它当成三个程序：

```
┌─────────────────────────────────────────────────────────────────────┐
│ ① 管线（pipeline.rs）                                                │
│    v4l2src → caps → tee ─┬→ queue → webrtcsink → 浏览器              │
│                          ├→ queue(leaky,1) → appsink → 曝光 / 检测   │
│                          └→ queue → valve → … → appsink → media.stream│
│    里面还有一个 webrtcsink 自己的信令服务器（8443）                   │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ ② 控制通道（session.rs + route.rs + upstream.rs）                     │
│    datachannel 的每一行 ──► route 查表 ──► 转给对应的 unix socket     │
│                                       ◄── 原样转发回来                 │
│    ★ 它不解析回复。一个方法被加进 API，这个 crate 一行都不用改。       │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ ③ 出站（relay.rs + turn.rs + stream.rs）                              │
│    机器人主动拨出去，所以不需要打洞                                    │
│    relay：注册 + 桥接会话 + 控制车道（JSON-RPC 经 rendezvous）        │
│    turn：取中继凭据，交给 webrtcbin                                    │
│    stream：把帧推给你的 WebSocket                                      │
└─────────────────────────────────────────────────────────────────────┘
```

`lib.rs:9-10` 对 ② 的自我描述是整份代码里最该记住的一句：

> [`session::run`] is **transport-agnostic on purpose**: it takes lines and gives lines, so it is
> testable without a WebRTC peer and would serve a WebSocket surface (§11) unchanged.

**"收行进、吐行出"** —— 所以它不需要 WebRTC 就能测，所以将来加一个 WebSocket 面也一行不改。

---

## 6. 启动顺序，以及每一步为什么在那个位置

`main.rs` 的 `runtime.block_on` 是一个 400 行的顺序块，**每一步的位置都是决定**。按顺序读一遍，能省掉后面很多"为什么在这儿"的疑问。

| # | 做什么 | 为什么在这个位置 |
|---|---|---|
| 1 | `log_startup_identity!` | 在**任何可能失败的事之前** —— 日志里报启动失败时也得报是哪个 build 失败的 |
| 2 | 建 tokio runtime | |
| 3 | 校验 `--rotate` | **在任何东西启动之前**：错角度是命令行上的笔误，该当场说，而不是先开摄像头 |
| 4 | 读配置 | |
| 5 | 算 `width/height/fps` | **"实际会跑的，不是配置的"** —— 测试图案忽略 `quality`，日志报 quality 会撒谎 |
| 6 | `web::serve` 控制台 | **最先**。它是那个"告诉人管线起不来"的页面，所以它得先活着 |
| 7 | `Producer::learn` | 在管线之前 —— `webrtcsink` 的 `meta` 是建元素时设的，**注册晚了会一直到重启都顶着空名字** |
| 8 | `--sim-camera` 兜底置 `simulated` | 见下 |
| 9 | `turn::maintain` | 在管线之前 —— **第一个消费者的 offer 是管线起来时构建的** |
| 10 | `relay::run` | 在 producer 之后 —— 列表里那个名字来自同一个地方 |
| 11 | 选 source（`match` 不是 `if`） | 新增一个 `MediaSource` 会**编译失败**，而不是悄悄变成测试图案 |
| 12 | `pipeline::start` | |
| 13 | `frame::bind` + `serve` | |
| 14 | `exposure::spawn` | 在管线**之后**：它要测管线自己的帧 |
| 15 | `detect::spawn_first` | |
| 16 | `camera::Intrinsics` | 在管线**之后** —— **只有试过设置之后才知道是哪个 sensor mode** |
| 17 | 接受 peer 的循环 | |

### 每一步的"失败怎么办"也都是决定

**控制台起不来不连累视频**（`main.rs:298-301`）：

> **A page that cannot be served does not cost the video.** A refused bind is almost always a port
> already in use, which `Restart=always` cannot fix by trying again; **a robot that streams and
> answers control calls with no console is much better than one that does neither.**

**producer 学不到名字也不是错误**（`producer.rs:19-26`）：

> a producer with no name is a robot that streams, and **a robot that will not stream because it
> could not learn its own name would be a much worse trade**.

**检测器起不来只是 warning**（`main.rs:503-505`）：

> the camera, the console and the control channel are all still worth having, and **"mediad refused
> to boot because a model file moved" is a bad trade**.

**但 `frame::bind` 失败是致命的**（`main.rs:453`）：`"cannot bind media.frame; refusing a partial start"`。

### `simulated` 那个兜底

```rust
// mediad/src/main.rs:321-326
// **A camera that is MuJoCo is a simulated robot, whatever `configd` said.**
producer.simulated |= args.sim_camera.is_some();
```

理由：`configd` 拥有这个事实，但它被问的时候**只带一个超时**，
而一台机器上每个 daemon 都在同一瞬间启动 —— 答晚了就会把一只模拟鸭子注册成硬件。

> the two cannot disagree — **there is no arrangement in which the frames come from a simulator
> and the robot is real**. （`main.rs:323-325`）

---

## 7. 管线：从摄像头到浏览器

### 7.1 GStreamer 是什么

**对没用过 GStreamer 的人**：它是一个媒体框架，你把一串**元素**（element）接起来，
媒体数据叫 **buffer**，在元素之间沿着 **pad** 流动。每个元素只做一件事
（`v4l2src` 读摄像头、`h264parse` 修 H.264 字节流）。

几个会反复出现的词：

| 元素 | 干什么 |
|---|---|
| `tee` | 把一路流**复制**成 N 路 |
| `queue` | 把一条支路**挪到自己的线程**（没有它，`tee` 的两条支路跑在同一个线程上） |
| `appsink` | 一个把 buffer 交给**你的代码**而不是交给屏幕/文件的 sink |
| `valve` | 开关。`drop=true` 时**丢掉**流过的 buffer |
| `capsfilter` | 钉死格式/分辨率/帧率，而不是让上下游协商 |

### 7.2 这条管线的全貌

```
                              ┌─ queue ──────────► webrtcsink ──► 浏览器
                              │        (webrtcsink 自己带编码器)
采集 ──► caps ──► [videoflip] ──► tee
                              │
                              ├─ queue(leaky,1) ──► appsink ──► 曝光循环 / 检测器
                              │
                              └─ queue ──► valve ──► videorate ──► videoscale
                                            ──► videoconvert ──► mpph264enc
                                            ──► h264parse ──► appsink ──► media.stream
```

三个关键决定：

**① tee 在裸帧上，在编码器之前。**

理由（`pipeline.rs:19-23`）：`architecture.md` §5.3 要"按需给一帧"，§2 要"感知挨着传感器"。
两者都要**像素**，而从编码后的支路拿意味着解码刚刚编过的东西。

**② 原始那一路是 leaky 且只有一格。**

> the raw one is leaky and one buffer deep, which is the *latest* snapshot … rather than a queue of
> stale ones. **A stalled reader costs frames, never the encoder.**（`remote-webrtc.md` §2）

**③ 采集格式是 `UYVY`，不是 NV12。**

```rust
// mediad/src/pipeline.rs:1442
pub const CAPTURE_FORMAT: &str = "UYVY";
```

这是一个**测量结果而不是偏好**（`pipeline.rs:461-464`）：rkisp 同时提供单平面格式和一个
非连续双平面的 `NM12`；要 GStreamer 的 `NV12` 会选中 `NM12`，而 `v4l2src` 在这颗驱动上
推不动它 —— 无论缓冲区多深。实测表：

| caps | 2 buffers | 4+ buffers |
|---|---|---|
| `NV12`（选中 `NM12`） | 19.5 fps | 19.6 fps |
| `UYVY`（单平面） | 19.7 fps | **29.3 fps** |

`mpph264enc` 的 sink pad 上有 `UYVY`，它在 RGA 上转换，所以 4:2:2 → 4:2:0 **不花 CPU**。

### 7.3 ⭐ 那个花了三次调试的分配问题

`pipeline.rs:1497` 的 `raise_capture_buffers` 是整份代码里注释最长的一段，值得单独看看。

rkisp 不实现 `V4L2_CID_MIN_BUFFERS_FOR_CAPTURE`，于是 GStreamer 算出 `own_min = 0`，最终落在**两个缓冲区**。
而**三是悬崖，不是斜坡**：

> `v4l2-ctl --stream-mmap=N` on the main path gives **19.7 fps at two and 29.2 at three or more**.

把深度提上去要**同时**满足两件事（`pipeline.rs:1491-1495`）：

> **And (2) has to happen after downstream answers.** `propose_allocation` implementations
> **overwrite pool 0 rather than appending**, so a `min` written on the way out is replaced by the
> encoder's zero on the way back. A pad probe fires in both directions, so this rewrites pool 0
> every time it sees the query and the last word is ours. **That is the bug that made three
> earlier versions of this function look like they were being ignored.**

**"这就是让这个函数的前三个版本看起来像被忽略了的那个 bug。"**

### 7.4 ⭐ 什么都不转，什么都不转（旋转）

摄像头装歪了四分之一圈。最直觉的修法是 `videoflip`，而**那是错的**，实测（`pipeline.rs:109-115`）：

> **This defaulted to a quarter turn for one afternoon and cost 145% of a core.** `mpph264enc` hands
> the UYVY→NV12 conversion to the SoC's 2D engine and pays nothing for it; `videoflip`'s output is a
> buffer the RGA refuses … so MPP fell back to converting **every frame in software**. Measured on
> the robot: **97 °C, the CPU throttled from 1.8 GHz to 408 MHz, 1565 frames lost by `v4l2src` in
> one session, and 8 fps out of a 30 fps camera.**

所以**管线里没有任何东西旋转**。安装角度是**上报**的（`media.video`），谁显示谁转：
控制台用 CSS transform，那是免费的；感知消费者把它折进自己本来就要做的重采样里。

`--flip-in-pipeline` 把旧行为放回来，给那些自己转不了的消费者。

### 7.5 按需取帧，而不是发布

这是 `pipeline.rs:251-257` 记录的一笔账：

> Copying a frame out of the tee costs the whole frame — **1.84 MB at 720p30** … and the branch's
> readers want two a second between them … Capturing all thirty meant **55 MB/s of memcpy and a
> 1.8 MB allocation thirty times a second, from boot, on every robot**, for twenty-eight frames
> nobody ever read.

**"从开机起，每只机器人，每秒三十次。"** 所以改成：读者说"我要"，appsink 才复制。
其余每帧的代价是**一次 relaxed load 加上把 sample 丢掉**。

而且读者等的是**下一帧**而不是上一帧（`pipeline.rs:258-264`）：

> an exposure loop steering on half-second-old luma is a loop that **hunts**.

### 7.6 两件让失败可见的事

**no panics in a C closure**（`pipeline.rs:80-86`）：

> **Nothing in a signal handler here may panic.** These closures are invoked from C, so a panic
> **does not unwind — it aborts the process**, and the journal shows `thread caused non-unwinding
> panic` with a backtrace through `g_closure_invoke` and **nothing about what was actually wrong**.

**看 bus**（`pipeline.rs:719-726`）：

> **Watch the bus, or every media failure is silent.** … the journal showed a session starting, a
> session ending, and no reason for either. **Two rounds of guessing went into diagnosing something
> GStreamer was already saying out loud.**

### 7.7 datachannel 是机器人建的

```rust
// pipeline.rs:1916-1920
// The robot creates the channel rather than waiting for the peer to, which is what
// `reachy_mini`'s working equivalent does.
```

流程：`consumer-added` 信号（`:1951`）→ `create-data-channel`，label `"control"`，
reliable/ordered（`:2399-2404`）→ 接上 `mpsc` 两端 → 变成一个 `Channel` 交给 `main.rs:626` 的循环。

---

## 8. 控制通道：一条哑管道

### 8.1 心智模型

```
peer 发来一行 JSON-RPC
   │
   ├─ 是 media.video / media.stream？ → session.rs 自己答
   │
   └─ 否则：解析出 id 和 method（只解析到能路由为止）
         │
         ├─ route::permits() 说不行 → 在这里回一个拒绝
         │
         └─ 说行 → 查到 (service, lane) → 原样写进那个 unix socket
                                          │
                    服务吐出来的每一行 ◄──┘ 原样转发给 peer
```

### 8.2 ⭐ 它不解析回复

`session.rs:10-17`：

> **It never parses a reply.** Requests are read far enough to route them and no further; everything
> a service emits is forwarded verbatim. Two things follow, and both matter:
>
> - 订阅（subscription）**不需要特例** —— 把回复和请求关联起来会"留第一条、丢其余"，
>   而订阅恰恰是一串通知。
> - **Adding a method to the API costs nothing here.** `duck-ipc-proto` stays the only place a
>   method is defined, and **this file does not grow a case for it**.

**"给 API 加一个方法，这个文件一行都不用改。"**

### 8.3 `route.rs`：穷尽匹配就是全部的意义

```rust
// mediad/src/route.rs:8-11
/// **The match is exhaustive, and that is the point of having one per transport.** Adding a
/// variant to [`proto::Call`] fails the build here as well as in `btd`, so a new method cannot
/// reach a remote peer because nobody remembered this file. A shared table with a `_` wildcard
/// would have been the hole in both transports at once.
```

`permits()`（`route.rs:51-295`）**匹配每一个 `Call` 变体，没有 `_` 分支**，每个 `true`/`false`
上面都写着理由。`false` 的那些分成三类（`route.rs:47-50`）：

1. **授权的是另一种传输** —— `system.pairingPin`。改了 PIN 就能把手机锁在 BLE 外面，而那是恢复路径。
2. **会把问它自己的那个会话弄断** —— `update.*` 的写操作、wifi、`pad.pair`。改 wifi 或重启 `mediad`，会话就没了。
3. **永远不走网络传输** —— `resetToGolden`、`pin`。

还有一条最值得看的（`route.rs:175-181`）：

> **It is also the largest thing this transport grants** … `account.login` converts **being on the
> wifi *once* into remote access that outlives being there** — the one call here whose effect is
> durable in that particular way.

**"把'此刻在同一个 wifi 上'变成'以后一直够得到'。"** —— 这是这条传输能给出的最大授权。

### 8.4 那个把两个文件绑在一起的测试

`route.rs:371` 的 `only_these_mutating_calls_are_reachable_over_webrtc` 干的事：
把 `every_call()` 里**既 mutating 又 permitted** 的挑出来，断言它等于一个九项的名单。

理由（`route.rs:366-369`）：

> anything both mutating *and* permitted here is a call a LAN peer can get `updaterd` to perform.
> **That is two files agreeing, and this is the test that notices when they stop.**

它已经抓到过一次真的错误：`policy.install`/`policy.fetch` 曾经静默地返回 `PERMISSION_DENIED`，
直到 `mediad` 被加进 `deploy/updater.toml` 的 `allow_users`（为了 `account.login`）。

### 8.5 `upstream.rs`：按 **(服务, 车道)** 建的连接

```rust
// mediad/src/upstream.rs:80-85
/// **Keyed on the lane as well as the service**, which is what keeps a minutes-long update from
/// silencing everything else a peer asks. Every daemon serves one connection one request at a time,
> so calls that share a connection share a queue
```

**车道**（lane）是"回答一个调用会占用连接多久"：`Prompt`（瞬时）/ `Slow`（几秒）/ `Operation`（不定长）/ `Stream`（永不回答）。

为什么不是"一个调用一条连接"（`duck-ipc-proto/src/lib.rs:1100-1114`）：
那需要适配器知道一个调用**什么时候结束** —— 而那需要解析回复。**它故意不解析。**

**服务挂了是正常答案，不是要重试的错误**（`upstream.rs:10-12`）：每个操作都有超时，
而且**恰好重试一次，且只对"peer 走了"这类错误**：

```rust
// upstream.rs:209-217
peer_is_gone(...)  // BrokenPipe | ConnectionReset | ConnectionAborted | NotConnected
```

理由（`upstream.rs:110-112`）：daemon 重启后在同一个路径上重新 listen，
池里那条旧连接就是死的 —— **"那些字节根本没发出去，所以换一条新连接重写，而不是报上去。"**
超时**不重试**：那说明 daemon 在，但卡住了。

---

## 9. 外网可达：`relay` 与 `turn`

### 9.1 结构

```
  rendezvous  ──SSE──►   relay 任务   ──ws──►  127.0.0.1:8443  ◄──ws──  webrtcsink
  (HTTP)      ◄─POST──   (在 mediad 里)  ◄──ws──  信令服务器            (生产者)
```

`relay` 向服务注册成 **`producer`**，向本地信令服务器注册成 **`listener`** ——
**角色在两侧是反的**，因为对服务而言它就是那只机器人，对管线而言它是一个要会话的 peer。

### 9.2 rendezvous 是什么

一个跑成 Hugging Face Space 的**牵线服务**。机器人拨出去、注册，服务把它列在它账号下面，
并在它和一个消费者之间转发消息。**机器人从不接受入站连接。**

`relay.rs:52-57` 纠正了设计文档 §7 的一处说法：

> So the payload stays opaque and the envelope does not: this is **a translator with an opaque
> payload rather than a relay**.

SDP 和 ICE 原样穿过，但**信封要重写** —— 因为 rendezvous 用 HTTP（SSE 进、`POST /send` 出），
而且 peer id / session id 是**逐跳不同**的。

### 9.3 ⭐ 三条从服务源码里读出来、决定了代码形状的事实

`relay.rs:59-71`：

1. **`POST /send` 在 `GET /events` 之前是 400。**
   身份来自 bearer token，而 token 是靠 `/events` 连接绑定到 peer 的 ——
   **所以流先开，注册跟在 welcome 后面。**

2. **租约靠入站 `POST` 刷新，不是靠一条健康的流。**
   > Thirty seconds, and **a half-open TCP connection absorbs server-pushed keepalives silently
   > for minutes** — during which the robot believes it is reachable and is not.

3. **只有带 `meta.hardware_id` 的 producer 会被清扫。**
   没有它就**永远不会被驱逐** —— 一个崩掉的 daemon 会在主人的机器人列表里阴魂不散。

### 9.4 退避与抖动

`BACKOFF_START` 5 s → `BACKOFF_MAX` 60 s，每次失败翻倍（`relay.rs:140-141`）。

抖动是**只加不减**的（`relay.rs:1345-1349`）：

> A duration plus up to [`BACKOFF_JITTER`] of itself, so **a fleet does not reconnect in lockstep**.

理由：一次服务重启之后，一整队机器人同时回来就是一场自伤式雪崩。
测试 `backoff_jitter_only_ever_adds` 断言 100 次里 `waited` 落在 `[10s, 11s]` —— **抖动永远不会缩短等待**，
所以重试不会变成热循环。

两种结束**故意不等**：

| 结束原因 | 等多久 | 为什么 |
|---|---|---|
| `SplitBrain` | **立刻** | 连接看着是健康的 —— **这里每一秒都是机器人以为自己够得到、其实够不到的一秒** |
| `CredentialChanged` | **不等** | 要么立刻有新 token，要么上面那个循环本来就要等文件 |
| `Unauthorised` | `no_token_poll`（30 s） | **退避治不好这个，登录才能** |

### 9.5 配额：为什么不能用它跑遥测

```rust
// mediad/src/relay.rs:922-928
/// The rendezvous allows 1200 requests per 60 s **per peer**, and exceeding it earns a `429` on
/// everything that token does — **including the heartbeat that holds this robot's lease** …
```

`relay.rs:44-50` 说得更直接：

> **What it is not is a teleop lane.** … a 50 Hz intent stream is over budget in a second. Worse,
> exceeding it earns a `429` on the *whole peer*, **which would take the robot's own lease down with
> it: a client could knock a robot off the rendezvous by subscribing to telemetry.**

**"一个客户端可以靠订阅遥测把机器人踢下线。"** 所以有了 `Budget`：
只限通知，**永不限回复**（回复是消费者自己付了 `POST` 换来的）。

### 9.6 `turn.rs`：它不跑 TURN 服务器

⚠️ **第一号陷阱：`DEFAULT_TURN_ENDPOINT` 不是一个 TURN 服务器。**

```rust
// mediad/src/turn.rs:53
pub const DEFAULT_TURN_ENDPOINT: &str = "https://fastrtc-turn-service.hf.space/credentials";
```

它是 Hugging Face 托管的一个**铸凭据的代理** —— 拿账号 token 换 Cloudflare 的短期凭据。
真正的中继是 Cloudflare 的。

用大白话说清 TURN（`turn.rs:7-12`）：

- 同一个局域网：用彼此的地址（**host 候选**）。
- 跨互联网：先试 STUN 报回来的公网地址（**srflx**），这需要**两个 NAT 都肯打洞** ——
  > often they do, and often enough they do not, and **the failure looks like a session that
  > negotiates perfectly and carries nothing**.
- **TURN** 是中转：一方在中继上预订一个地址，把它作为**relay 候选**报出去。
  > It always works, at the cost of somebody's bandwidth, **which is why it is the last resort ICE
  > tries rather than the first**.

**为什么必须是机器人那一侧出中继**（`turn.rs:16-19`）：

> A connection needs **one** relay candidate, not two … and it matters more than it sounds, because
> **`aiortc`'s STUN client works where its TURN client does not, so a Python consumer *cannot* be
> the side that relays.**

### 9.7 ⭐ 为什么取凭据绝不能阻塞

```rust
// mediad/src/turn.rs:28-32
/// **[`Relays::uris`] never blocks and never fails**, and that is the whole design of this module.
```

理由：它唯一的调用者在 GStreamer 的 `consumer-added` 信号里，而**那个 handler 不返回，
这个消费者的 SDP offer 就不会生成** —— 在那里发一个 HTTP 请求会拖慢**每一个**连接，
包括永远不会用中继的局域网连接。

所以它读一个缓存，用 `try_read`（连等都不等），空答案是**正常状态**。

### 9.8 那个安全的坑

`turn.rs:42-52` 记着一件真事：默认地址原本是 `turn.fastrtc.org` ——
一个**悬空的委派**（域名注册健康，但背后的 hosted zone 没了，四个权威服务器全答 `REFUSED`）。

危险的不是服务挂了，而是：

> a signed-in robot sends its account token down this URL **every five minutes**, and whoever wins a
> race to have AWS assign them one of those four delegated nameservers **would serve records for the
> name, pass DNS validation for a certificate on it, and be handed the token**.

所以现在直接指向那个 Space，并且 `parse_endpoint`（`turn.rs:66`）作为 **clap 的 `value_parser`**
在**参数解析阶段**就把坏值拦掉（`turn.rs:64-65`）：

> An endpoint that is wrong rather than refused becomes **a warning every thirty seconds for the
> life of the daemon, which is how a log stops being read**.

---

## 10. 控制台页面

### 10.1 两个端口，但只有一个需要人输

`webrtcsink` 占着 8443（它自己的信令服务器，只接受 host 和 port 两个参数），
所以页面不能是它上面的一个路由。于是：

| 端口 | 谁 | 谁输入 |
|---|---|---|
| **8080** | `web.rs` 的 axum，一个页面 + 一个 `/frame` | **人要输这个**（或 `duckctl open`） |
| 8443 | `webrtcsink` 的信令服务器 | 页面的 JS 自己填，**人永远不输** |

`webrtc-console.md` §1.3 把这个当成**要求**而不是愿望：

> **Two ports is a fact about the implementation, and it must not become a step for a person.**

三条保证它不会变成负担：**只有一个地址要输**；**`mediad` 在服务页面时把信令 URL 填进去**
（所以 `--port` 改了也安全，没有第二份副本）；**两个端口唯一能产生的失败用文字说清楚** ——

> If 8080 answers and 8443 does not … the page must say *the page came from this robot, but its
> signalling port did not answer*, **not `websocket error`**.

### 10.2 页面是嵌进二进制的

```rust
// mediad/src/web.rs:58
include_str!("../webclient/index.html")
```

理由（`web.rs:52-57`）：

> installing it under `current/webclient/` would cost an `--include` line in **three places that
> already drift** … and make **"which page is this robot serving" a question with two answers**.
> The cost is a rebuild to change a stylesheet, which is the right trade for a page that is part of
> the daemon's interface.

### 10.3 一个文件，没有构建步骤

`index.html` 1754 行，里面把理由写得很清楚：

> **One file is a constraint, not an accident** — it is what makes this runnable at all. If it
> outgrows one file it becomes three … **still with no build step and still with no npm.**

它**直接说 gst-plugins-rs 的信令协议**，而不用官方的 JS 库：

> for one reason: **a client that needs npm is a client nobody runs**.

### 10.4 服务页面的两副面孔

同一份 `index.html` 服务两个宿主，靠**有没有被替换过端口**来区分（`web.rs:258-264`）：

| 谁在服务 | `{{SIGNALLING_PORT}}` | 页面走哪条路 |
|---|---|---|
| 机器人（8080） | 被替换成真实端口 | `ws://<robot>:8443` |
| Hugging Face Space | **保持原样**（页面读作"没有机器人服务我"） | rendezvous |

> getting this backwards produces **a console that connects to nothing and says nothing**.

### 10.5 那个 Space 为什么要一个 Dockerfile

`space/README.md` 记着一段伤：

> A static Space is documented to inject `window.huggingface.variables` into the page — and for this
> Space **it never did**, through a metadata change, a privacy flip, a delete-and-recreate, and a
> page given a real `<head>` for the injector to work on.

所以改成 Docker Space：`hf_oauth: true` 把 client id 放进**环境变量**，八行 `sh` 把它写进页面。

`entrypoint.sh` 里那个正则值得一看（`entrypoint.sh:43-48`）：

```python
# **The opening tag on a line of its own, not the first `<head>` in the file.** The page's own
# comments talk about `<head>` … and a plain first-match replace puts the bootstrap
# *inside an HTML comment*, where it never runs.
HEAD = re.compile(r"^([ \t]*)<head>[ \t]*$", re.MULTILINE)
```

**"页面自己的注释里就提到了 `<head>`"** —— 所以不能简单地找第一个。而且它要求**恰好匹配一次**，
多个就报错退出。

---

## 11. 本地取帧：`media.frame`

### 11.1 为什么它不和控制通道共用一条路

`frame.rs:3-7`：

> A frame stays out of the WebRTC control channel: at the default geometry the UYVY payload is about
> **1.8 MiB**, so JSON/base64 would make a control request several MiB and **let a slow peer tie
> camera data to the network**.

**一帧 1.8 MiB，而控制得保持及时。**

### 11.2 socket 与权限

```rust
// mediad/src/frame.rs:32-36
const SOCKET_MODE: u32 = 0o660;

/// The group that may ask for a frame. Deliberately the same one as `robotd`'s socket, `padd`'s
/// tap and `tof`'s stream: **whoever may watch the robot may watch what it sees.**
const GROUP: &str = "robot";
```

⚠️ **第二号陷阱：光有 `0660` 不够。** `Cargo.toml:41-43`：

> `getgrnam` and `chown`, to hand the frame socket to the `robot` group after binding … **Mode 0660
> alone would leave it `mediad:mediad`**, and the operator is only ever added to `robot`.

socket 是 `mediad` 建的，所以它的组是 `mediad` 的主组 —— **`robot` 组里的人根本够不到**。

代码在 `frame.rs:232-256`：`libc::getgrnam` 查 gid，`libc::chown(path, u32::MAX, gid)` 改组
（`u32::MAX` 是 `(uid_t)-1`，文档里"别动属主"的写法）。**改失败只是 warning**（`frame.rs:78-80`）：

> On a board that is a broken install; **on a laptop it is a machine with no `robot` group, which is
> ordinary.**

### 11.3 它是"要"一帧，不是"拿"上一帧

> a caller here **waits for the capture that answers it**, bounded by [`pipeline::FRAME_TIMEOUT`],
> and **a camera that has stopped is reported as a timeout rather than answered with the frame it
> stopped on.**（`frame.rs:9-14`）

---

## 12. 软件自动曝光

### 12.1 为什么需要它

**3A = 自动曝光、自动白平衡、自动对焦。** 板子上的 `rkaiq_3A_server` 拥有白平衡、色彩矩阵、
gamma、降噪 —— 但它的自动曝光：

1. **只在流开始时收敛一次，然后就不管了。**
   > One convergence at stream start is not auto-exposure. **A robot that walks from a window into a
   > corridor keeps the window's exposure.**（`exposure.rs:10-11`）
2. **而且它会漏掉那次流开始事件**，那连这一次都没有 —— 这就是"3A 挂了，重启有时候能修"的形状。

所以软件循环是**补上那个不存在的循环**。

### 12.2 ⚠️ 它用的是 `v4l2-ctl`，不是 `ioctl`

`lib.rs:49-51` 说这个模块 *"writes V4L2 controls to a camera through `ioctl`"*。
**代码不是这么做的**，而它自己的文档解释了为什么（`exposure.rs:357-360`）：

> `v4l2-ctl` rather than the ioctl, for the prototype's reason: **the struct layout of
> `VIDIOC_S_EXT_CTRLS` is three nested types we would have to pin by hand, and getting one offset
> wrong is a write that succeeds and changes nothing.**

**"一个偏移量写错，就是一次成功但什么都没改变的写入。"**
详见 §18。

### 12.3 控制环路

| 参数 | 值 | 意思 |
|---|---|---|
| `INTERVAL` | 500 ms | 一秒两次：够快跟得上机器人从窗口走进走廊，够慢让阻尼步不会振荡 |
| `TARGET_Y` | 90.0 | 目标平均亮度（8 位，**ISP gamma 之后**） |
| `DEADBAND` | 0.12 | 相对误差死区 |
| `ratio` 指数 | **0.6** | 阻尼 |
| `SOFT_LINES` | 600 | 快门软上限（~11.4 ms） |
| `HARD_LINES` | 1200 | 快门硬上限（~22.9 ms） |
| `MAX_ANALOGUE` | 11.0 | 传感器模拟增益上限 |
| `MAX_DIGITAL` | 16.0 | ISP 数字增益上限 |

**三档亮度，按噪声从小到大花**（`exposure.rs:73-77`）：

> Brightness is spent **in noise order**: shutter up to the soft cap first (cheapest and cleanest),
> then sensor analogue gain (clean amplification), then shutter up to the hard cap, and **ISP digital
> gain — the noisiest — only when there is nothing else left**.

**为什么是 `ratio^0.6` 而不是 `ratio`**（`exposure.rs:135-139`）：

> the controls are linear in light and **the measured luma is not**, so a full correction against a
> gamma-compressed measurement **overshoots and the loop hunts**.

**为什么必须有死区**（`exposure.rs:68-69`）：

> Without a deadband the exposure jitters continuously on sensor noise alone, which is visible as
> **a picture that breathes**.

### 12.4 ⭐ 那个"不优化"的重复写入抑制

```rust
// mediad/src/exposure.rs:127-133
/// **That second case is not an optimisation.** A room darker than the sensor can reach … leaves
/// the ratio permanently outside the deadband, **because the setpoint is unreachable rather than
/// merely far away** … each write is a `v4l2-ctl` process: **measured on the board at 43 ms of CPU a
/// call**, which at the throttled 408 MHz is most of a tenth of a core **spent achieving nothing**.
```

### 12.5 那个"读回来证明不了什么"的检查

第一次写入之后会读回一次 —— **但只在"要写的值"和"钉住的值"不同时才读**（`exposure.rs:460-464`）：

> a read-back that finds the pin proves nothing if the pin is also what we asked for. **The check
> would pass on the strength of somebody else's write.** That is not hypothetical: **the first step
> on a robot landed on exactly the 600 lines `mediad` had pinned, and reported success.**

**"这一步会靠着别人的写入而通过。"**

### 12.6 两个心跳

| 心跳 | 周期 | 干什么 |
|---|---|---|
| **重写**（`REASSERT_TICKS = 20`） | 10 s | 把当前值**再写一遍** —— 因为 `v4l2src` 每次打开设备都会重新应用 `extra-controls`，**包括一次不是我们发起的重开** |
| **活体报告**（`REPORT_TICKS = 20`） | 10 s | info 级别说一句"我还活着" |

第二个的理由（`exposure.rs:57-61`）：

> **At info, not debug, because the question "is auto-exposure alive?" should not need a drop-in.**
> **A loop that has settled writes nothing**, and from the sensor that is indistinguishable from a
> loop metering a frozen frame or one that never started.

**"一个已经稳定的循环什么都不写"** —— 从传感器那一侧看，这和"循环在看一帧冻住的画面"完全一样。

---

## 13. 在 tee 上找鸭子

### 13.1 它是一个线程，不是一个 task

```rust
// mediad/src/detect.rs:7-9
/// **A thread, not a task.** Inference is 60 ms of blocking work per frame and the tokio runtime
/// here serves WebRTC signalling; a detector that occupied one of its workers for a tenth of every
/// second would **make session setup stutter for no reason anybody could find**.
```

### 13.2 ⭐ 2 Hz 是热限制，不是偏好

```rust
// mediad/src/detect.rs:11-13
/// **Paced, and the pace is a thermal number.** Flat out on a Radxa Zero 3 the detector reaches
/// **95 °C** and the CPU throttles to 408 MHz — **a robot that walks badly to see well.**
```

**"一只走得很难看、但看得很清楚的机器人。"**

### 13.3 帧从哪来，多久一次

它**问 tee 要帧**（`frames.next_frame()`，`detect.rs:233`）——
和曝光不同，曝光用的是零拷贝的 `inspect_next`，检测器需要像素本身，所以拿的是整帧的拷贝。

节奏**按墙钟走，不是按帧号抽帧**，而且是从**截止时刻**排的（`detect.rs:188-190`）：

> Paced from the deadline rather than by sleeping a period after the work, so **a slow inference
> eats its own slot instead of drifting the whole loop later**.

### 13.4 模型怎么选

按**文件扩展名**，不是配置开关（`detect.rs:68-70`）：

> Chosen by the model's own extension rather than by a config switch: **a `.rknn` only runs on the
> NPU and an `.onnx` only runs on the CPU, so asking somebody to say both is asking them to
> contradict themselves.**

`robotd-params` 给的默认列表是 NPU 优先（`/opt/robot/detector/current/duck_detect.rknn` 再 `.onnx`），
所以 NPU 被关掉的板子会自动落到 CPU 上。

### 13.5 失败怎么处理（分得很细）

| 失败 | 处理 |
|---|---|
| feature 关着 / 没有模型 | info 一句，**完全不启动检测器** |
| 模型加载失败 | `warn`，试下一个（rknn → onnx）；全失败就带上修复提示退出 |
| **推理**失败 | `error`，**循环继续** —— 理由（`detect.rs:115-117`）："a bad frame is no reason for a robot to stop being able to see the next one." |
| tee 上的格式不对 | `warn` 然后 **return**（线程永久停止） |

第三条还有个细节（`detect.rs:280-281`）：

> **Once per distinct message: a failure that repeats at 2 Hz would be 7000 identical lines an
> hour, which is how a journal stops being read.**

### 13.6 结果去哪

一个容量 8 的 `broadcast::Sender`（`detect.rs:39-44`）。`main.rs` 给**每个 peer** 订阅一份，
转成 JSON-RPC 通知 `media.detections` 发出去。

**空结果也照发**（`detect.rs:385-386`）：

> **A detector that goes quiet when it sees nothing leaves the last duck drawn on screen for ever,
> which looks exactly like a duck that is still there.**

### 13.7 心跳里的数字都是"自上次以来"

```rust
// mediad/src/detect.rs:208-210
/// **Every count on this line is since the last one.** A heartbeat answers "is it seeing a duck
/// *now*", and a cumulative `seen` cannot: **one found twenty minutes ago and one found this second
/// both read `seen=1`, for ever.**
```

---

## 14. 流出去：`media.stream`

### 14.1 心智模型

rendezvous 只传**指令**（`media.stream {url}`），**不传像素**。机器人拨到你的 WebSocket，
一个小的 **hello** 文本帧说明接下来是什么，然后一帧一条二进制消息。

```rust
// mediad/src/session.rs:296-298
/// H.264 unless asked otherwise: the encode is the VPU's rather than a core's, and inter-frame
/// prediction is worth **five to fifteen times the bytes** over the same wifi.
```

| 编码 | 好处 | 代价 |
|---|---|---|
| `h264`（默认） | 便宜得多（VPU 编，体积 1/5–1/15） | **中途加入的接收者要等一个关键帧** |
| `jpeg` | **每一帧都是关键帧** | 贵 |

默认 5 fps / 最长边 640 / 质量 70（`stream.rs:125-127`）。

### 14.2 丢弃策略取决于"这一帧能不能独立解码"

`stream.rs:99-103`：

> **This is what makes the drop policy correct.** Discarding the oldest and keeping the newest is
> right for independent frames and **wrong for a predicted stream** … Knowing which is which is the
> difference between **dropping a frame and corrupting a second**.

### 14.3 那个握手头，以及为什么它要记日志

```rust
// mediad/src/stream.rs:411-415
/// **Logged before anything is sent, at info.** This is the one call that makes a robot **hand its
/// camera to somewhere it was told about rather than somewhere it knows** … `remote-webrtc.md` §4
/// leaves this transport ungated on purpose; **a line in the log is what makes that decision
/// auditable rather than invisible.**
```

**"把摄像头交给一个别人告诉它的地方，而不是它认识的地方。"** 所以至少要在日志里留一笔。

令牌是**机器人自己的**，作为 WebSocket 握手头（`stream.rs:253-257`）：

> The receiver is a public endpoint, so it has to be able to say whose camera this is … **Without it
> a Space would take frames from anybody and show them to anybody.**

### 14.4 队列只有两格

```rust
// mediad/src/stream.rs:442-444
/// Two deep: the newest frame and one in flight. A model wants the freshest picture, so a frame
/// encoded while the socket is behind is dropped rather than queued — **a backlog is latency that
/// never comes back**.
```

---

## 15. 摄像头几何

`camera.rs` 提供**内参**：把像素变成方向的那四个数。

```rust
// camera.rs:116
pub struct Intrinsics { fx, fy, cx, cy, calibrated, source, distortion }
```

### 15.1 为什么鸭子需要这个

`remote-webrtc.md` §10：

> Without them **a monocular reconstruction is scale-free and its angles are wrong**; SLAM, visual
> odometry and "how far away is that" all begin here.

### 15.2 ⭐ 两个 sensor mode 的视场角是一样的

这是这个模块最反直觉的一条（`camera.rs:63-77`）：

| mode | 怎么来的 | 水平 FOV | 备注 |
|---|---|---|---|
| **1920×1080** | 全画幅缩放/裁到 16:9 | **62°** | 这个 daemon 钉住的，30 fps |
| 3280×2464 | 完整 4:3 阵列 | **62°** | 启动模式，21 fps |

> So the field of view does not change with the mode — only the resolution and frame rate do …
> **there is no wide-vs-fast trade to make here, because the wide field is already the fast mode.**

**没有"广角 vs 高帧率"的取舍 —— 广角模式本来就已经是快的那个。**

### 15.3 ⭐ 不知道就说不知道

```rust
// camera.rs:29-31
/// **Numbers that are quietly wrong are worse than none**: a consumer told nothing knows it must
/// calibrate.
```

所以没被钉住的 mode 会**完全不发** `intrinsics` 这个键，而不是发一个看起来合理的错数字。
`calibrated` 那个标志也不是装饰：`false` 是"设计值推算"，`true` 是"测出来的"。

### 15.4 两个消费者必须处理的坑

1. **内参是对"未旋转的帧"说的**（`camera.rs:93-97`）：
   > A consumer that rotates the image has to rotate these too — **`cx` and `cy` swap, and so do
   > `fx` and `fy`**.
2. 畸变系数为空时是**省略**而不是 `[]`，因为读 `[]` 的人得知道那意味着"未知"而不是"没有"。

---

## 16. 构建、部署、权限

### 16.1 两个 C 依赖，和那个 sysroot

`Cargo.toml:25-28` 承认得很直接：

> This is **the second C dependency to reach the board**, after libudev for `gilrs` in `padd`, and it
> is **much larger**: `scripts/cross-sysroot.sh` exists for it. `ci-cross-deps.sh` says of the first
> that it "is the cost of that one exception, and **it is worth reading before adding another**" —
> **this is that other, and the cost is a sysroot the whole workspace now builds against.**

**`scripts/cross-sysroot.sh` 把机器人自己的 Debian 包解成一个 sysroot**，
所以整个 workspace 是**对着机器人真正在跑的那套库**交叉编译的（1.26.2）。

### 16.2 那两个 GStreamer 插件

`mpph264enc` 和 `webrtcsink` **在任何 Debian 套件里都不存在**，必须在 CI 里从源码构建：

```toml
# 根 Cargo.toml:78-80
[workspace.metadata.gst-plugins]
repo    = "pollen-robotics/microduck-gst-plugins"
version = "v3"
```

而 `scripts/setup-gstreamer.sh`（653 行）是**这个页面的可执行形式**，它被 release 的 preinstall hook 调用。

### 16.3 systemd 单元：三行是承重的

`mediad.service` 的注释比指令多。最容易忽略的（`mediad.service:5-7`）：

> Two lines here are load-bearing in a way that is easy to miss, and **both present identically at
> runtime — the encoder simply does not exist, with nothing saying why.**

| 行 | 内容 | 少了会怎样 |
|---|---|---|
| `SupplementaryGroups=` | `video render robot` | 见下 |
| `Environment=GST_PLUGIN_PATH=` | `/usr/local/lib/gstreamer-1.0` | **`mpph264enc` 和 `webrtcsink` 不存在，daemon 说一句然后退出** |

### 16.4 三个组，每个都失败得不一样

`mediad.service:46-66`：

| 组 | 覆盖 | 失败的样子 |
|---|---|---|
| **`video`** | `/dev/mpp_service`（VPU）、`/dev/rga`（2D 加速器）、`/dev/videoN` | 没有 VPU 节点 → 编码器**静默地不注册**；没有 `/dev/rga` → 元素在，管线在 RGA 里面失败 |
| **`robot`** | `robotd`/`configd`/`updaterd` 的 0660 socket | 控制通道全部答"is not answering" |
| **`render`** | **NPU**。rknpu 驱动注册成 DRM 设备，`root:render` 0660 | 失败是 `rknn_init` 返回一个数字，**跟权限毫无关系** |

> Three debugging rounds, one cause.

**三轮调试，一个原因。**

### 16.5 为什么必须是 `Restart=always`

`mediad.service:71-73`：

> mediad exits when it cannot start a pipeline, and **a missing plugin or an unopenable device node
> is a state to retry rather than one to stay down in** — **a provisioning run that installs the
> plugins should be enough to bring it up without a reboot.**

### 16.6 那两条"没人看着也会坏"的路

`mediad.service:128-138` 列了两条，都**不碰控制环、BLE、手柄和更新**：

1. **板子上没有 GStreamer 栈** —— 用 `sudo /usr/local/sbin/robot-setup-gstreamer` 修。
2. **板子上没有摄像头**（`[media] source` 默认是 `camera`）——
   而这里有个**不明显但重要**的后果（`mediad.service:37-42`）：

> **The consequence of the camera being on by default, stated because it is not obvious:** the control
> datachannel is bundled with the video track, so **a robot whose camera is absent … fails to start
> this service and loses its WebRTC control surface along with its video.** BLE and the local pad are
> unaffected. The fix on such a board is `source = "test"` in `[media]`, which streams a test
> pattern: **the pipeline starts, so the control channel exists.**

⚠️ **第三号陷阱：控制通道和视频轨是绑在一起的。** 摄像头坏了，WebRTC 的控制面**一起**没。

### 16.7 那个 `[Install]` 段

`mediad.service:118-126`：

> `hooks/postinstall` enables and starts every unit that ships with an `[Install]` section, and
> `units_shipped` in `updater/src/engine.rs` restarts every such unit on an apply — **one rule, read
> off the unit files rather than a list anybody maintains** … **its absence was the whole of why
> every push ended with somebody typing `systemctl restart mediad`.**

---

## 17. 测试：122 个，绝大多数不需要板子

```bash
cargo test -p mediad          # 122 个
```

| 文件 | 行数 | 测试 | 需要板子？ |
|---|---|---|---|
| `exposure.rs` | 726 | 15 | 否 |
| `relay.rs` | 2563 | 20 | 否 |
| `pipeline.rs` | 2704 | 11 | **1 个会自跳过** |
| `camera.rs` | 460 | 10 | 否 |
| `frame.rs` | 514 | 9 | 否 |
| `route.rs` | 545 | 8 | 否 |
| `turn.rs` | 561 | 8 | 否 |
| `web.rs` | 339 | 8 | 否 |
| `session.rs` | 715 | 11 | 否 |
| `producer.rs` | 253 | 5 | 否 |
| `stream.rs` | 985 | 4 | 否 |
| `config.rs` | 105 | 4 | 否 |
| `detect.rs` | 398 | 2 | 否 |
| `snapshot.rs` | 134 | 2 | 否 |
| `upstream.rs` | 301 | 1 | 否 |
| `main.rs` · `lib.rs` | 775 | 0 | — |

### 17.1 ⭐ 没有 mock 库，用的是真服务器

这是这个 crate 最值得学的一个做法。看几个例子：

- `relay.rs` 的 `FakeService` 是一个**真的 axum 应用**，在 loopback 上服务 `/events`（真的 SSE）、
  `/send`、`/api/robot-status`。
- `session.rs` 的 `fake_daemon` 绑定一个**真的 unix socket**。
- `turn.rs` 用一个 axum 假代理。
- `stream.rs` 直接跑一个真的 WebSocket 接收端，其中 `ws://127.0.0.1:1/frames` 的注释是
  **"Port 1 is reliably nobody"**。

### 17.2 ⭐ 时间间隔是可注入的，因为失败都是"时间失败"

`relay.rs:161-168`：

> §3.4's four failure modes are all *timing* failures … and **none of them can be reproduced on
> demand by hand on a board**. With the intervals injectable, **each one is a test that runs in
> under a second.**

同一个理由在 `stream.rs:167-171`：

> a test that waited two real seconds per reconnect is **a test nobody runs**.

`relay.rs` 的 `brisk()` 把所有间隔压到 20–50 ms，于是**"服务不再列出这只机器人"这种失败
可以在一秒内被复现**。

### 17.3 那个会自跳过的测试

`pipeline.rs` 的 `a_reader_gets_a_frame_from_the_running_pipeline` 是唯一跑真管线的测试。
它在缺 `videotestsrc`/`webrtcsink`/编码器时**打印一句话然后自己跳过**，
而且它用 18_443 端口而**不是 8443**，免得撞上正在跑的 `mediad`。

---

## 18. 几处读者会绊到的地方

按仓库的规矩，代码与文档不一致的地方，这里只**陈述事实**，不判断该怎么办。

### 18.1 "mic" 出现在描述里，但整个 crate 没有音频

`Cargo.toml:6` 的 `description` 和 `main.rs:25` 的 `--help` 都是 **"Camera, mic, WebRTC — and
the remote gateway"**。但：

- 全 crate 的 GStreamer 元素清一色是视频（`v4l2src`/`mpph264enc`/`x264enc`/`webrtcsink`…），
  **没有一个 `alsasrc`/`pulsesrc`/`opusenc`**；
- `remote-webrtc.md` §2 的"四条流"图里画着 `audio track  mic; two-way for telepresence`；
- 而 `webrtc-console.md` §1.3 说音频要等 TLS 那一步。

机器人上的麦克风确实存在，但归 `pet-detect` 管 —— 它 fork 一个 `arecord` 子进程做挠头检测。
`mediad.service:16` 的 `Description=` 写的是 "Robot media and WebRTC gateway"（没有 mic）。

### 18.2 `pipeline.rs` 里有三处还写着 `NV12`

```rust
// mediad/src/pipeline.rs:1442 —— 实际值
pub const CAPTURE_FORMAT: &str = "UYVY";
```

但模块头部（`pipeline.rs:11`）、头部正文（`:27`"NV12 because that is what the rkisp capture path
emits … so nothing *converts* anywhere: no `videoconvert`"）和处理失败的错误串（`:702-703`）
都还写着 `NV12`。

而 `:815-816` 说的正好相反：**"The tee carries `UYVY` … and neither encoder takes it"** ——
所以那条支路**必须**有一个 `videoconvert`。

### 18.3 `Cargo.toml` 指着一个不存在的函数

```toml
# mediad/Cargo.toml:112-114
# `GstVideoMeta`, which the camera source has to advertise in the ALLOCATION query or v4l2src
# copies every frame — see `advertise_video_meta`.
```

**`advertise_video_meta` 在整个仓库里不存在。** 那个函数叫 `raise_capture_buffers`
（`pipeline.rs:1497`）。

### 18.4 `lib.rs` 说 `ioctl`，`exposure.rs` 说不用 `ioctl`

`lib.rs:49-51` 说自动曝光 *"writes V4L2 controls to a camera through `ioctl`"*；
`exposure.rs:357-360` 说 *"`v4l2-ctl` rather than the ioctl … the struct layout of
`VIDIOC_S_EXT_CTRLS` is three nested types we would have to pin by hand"*。见 §12.2。

### 18.5 `session.rs` 说 `handle` 只在拒绝时返回回复

`session.rs:144-145`：

> Returns a reply to send back only when this transport answers it itself — **which is to say, only
> when it refuses.**

它**也**返回 `media.video`（`:168-180`）和 `media.stream`（`:199-213`）的**成功**回复。
对"被路由出去的调用"来说这句是对的。

### 18.6 `relay.rs` 说 "sliding"，实现是 tumbling

`relay.rs:932` 的文档说 *"A sliding allowance for lines nobody asked for"*，
而 `Budget::take`（`:958-979`）在窗口到期时做的是 `spent = 0; since = now` ——
一个**以第一次调用为锚点的固定窗口**，不是滑动窗口。

### 18.7 `stream.rs` 里一行被立刻覆盖的赋值

```rust
// mediad/src/stream.rs:471-476
// A gap has happened. On a predicted stream the only safe thing to send next is a keyframe.
awaiting_key = !unit.keyframe || awaiting_key;
if for_encoder.encoding == Encoding::H264 {
    awaiting_key = true;
}
```

`:473` 的值在 `:474-476` 被无条件覆盖；而在 JPEG 那条路上，每个 unit 的 `keyframe` 都是 `true`
（`:659`），所以 `!unit.keyframe` 恒为 `false`。**两条款式路径上，这一行都不决定任何事。**

### 18.8 `relay.rs` 的退避成功之后不重置

`run()`（`relay.rs:507-555`）只在 `CredentialChanged` 和 `SplitBrain` 两个分支里把 `backoff`
重置回 `backoff_start`。`Ended::Reconnect` 只翻倍、不重置 ——
所以一条曾经在网络差的时候爬到 60 s 的连接，**在进程剩下的寿命里都保持 60 s 的重拨间隔**。
`stream.rs:213` 是相反的（每次成功连接都重置），两个模块在这一点上不一致。

### 18.9 两处被"合并事故"切断的文档注释

`session.rs:625-630`：关于 `media.video` 的四行注释，接在了
`media_stream_answers_the_question_and_refuses_a_bad_url`（`:637`）的文档块开头，
和它自己的 `media.stream` 文档粘成了一句话。本该拥有这段注释的
`the_page_can_ask_what_the_video_is`（`:684`）**一句注释都没有**。

`route.rs:465-467`：`reaches_padd_and_tofd_which_btd_cannot` 的开头两行被接到了
`a_watching_peer_can_run_a_skill_and_change_a_policy`（`:474`）上，
拼出 *"…the concrete difference between the two transports' needs: `mediad` will hold
**A peer watching the video can run a skill**…"*；而 `reaches_padd_and_tofd_which_btd_cannot`
（`:531`）只剩下半句 **`/// five connections where `btd` holds three.`**

形状和之前报过的 `robotd/src/intents.rs` 那处一样。

### 18.10 三处没有被用到的代码

| 位置 | 什么 | 状况 |
|---|---|---|
| `exposure.rs:200-208` | `Stop` | 只有 `stopped()`，**没有任何地方写过 `true`**；文档却写着"daemon 要走时置位，好让线程不活得比管线久"。实践上线程只在进程退出时结束 |
| `detect.rs:302-306` | `detect::video_notification` | **没有调用者**（`main.rs:643` 用的是 `session::video_notification`）。同名两个函数，一个死的 |
| `detect.rs:46-53` | `Detector::counters()` | **没有调用者**，尽管文档说它是"`robot.health` 式上报想要的那些计数器" |

### 18.11 一处算错的注释

`exposure.rs:182` 说 `mean_luma` 采样 *"every eighth pixel, which is **11k samples** of a
1280x720 frame"*。步长 16 字节走 `1280×720×2 = 1,843,200` 字节，实际是 **115,200 个样本** ——
差了大约十倍（"every eighth pixel" 本身是对的）。

---

## 19. 阅读路线

| 步 | 读什么 | 为什么先读它 |
|---|---|---|
| 1 | `mediad/Cargo.toml`（1-28 行） | 28 行讲清了唯一的 C 依赖和它的代价 |
| 2 | `mediad/src/lib.rs`（68 行） | **整份 crate 的地图**，含 cfg 门控 |
| 3 | `mediad/src/main.rs`（707 行） | 组装根。**§6 那张启动顺序表就是这个文件** |
| 4 | `mediad/src/session.rs` | 心智模型 ②：一条哑管道。715 行，可移植 |
| 5 | `mediad/src/route.rs` | 穷尽匹配为什么是全部的意义 |
| 6 | `mediad/src/upstream.rs`（301 行） | 车道、连接池、失败是正常答案 |
| 7 | `mediad/src/pipeline.rs` | 最长的文件。**先读模块头 1-120 行**，再读 §7.3 那个分配问题 |
| 8 | `mediad/src/turn.rs` | 心算模型 ③ 里最小的一块 |
| 9 | `mediad/src/relay.rs` | 最大的一块。**先读模块头 1-90 行** |
| 10 | `mediad/src/exposure.rs` | 一个完整的控制环路，注释极好 |
| 11 | `mediad/src/detect.rs` | 最短的带算法模块 |
| 12 | `mediad/systemd/mediad.service` | 权限故事在这里 |

**如果只有十分钟**：读 §1、§3、§5 的三张图，然后读 `lib.rs` 那 68 行。

三条贯穿全文的主线：

1. **测量压过偏好**。UYVY 不是偏好，是 19.6 → 29.3 fps；2 Hz 不是偏好，是 95 °C；
   不旋转不是偏好，是 145% 的核。
2. **不知道就说不知道**。没有内参就**不发那个键**；相机停了就报超时而不是给上一帧；
   `route` 拒绝 `system.authenticate` 而不是假装答对。
3. **失败要说得出原因**。看总线、桥接 GStreamer 日志、把原始统计打出来 ——
   因为"看不见的三轮猜测"是这个 crate 反复记下的教训。

---

## 20. 术语表

| 词 | 意思 |
|---|---|
| **WebRTC** | 浏览器之间实时音视频的标准。这里视频走它，控制通道也走它 |
| **信令（signalling）** | 建立 WebRTC 连接前交换 SDP/ICE 的那段协议。**它是明文 JSON** |
| **SDP** | 会话描述：我支持什么编解码、我的地址是什么 |
| **ICE** | 找一条能通的网络路径。候选分 host / srflx / prflx / relay |
| **候选（candidate）** | 一个"你可以试着往这儿发包"的地址 |
| **STUN** | 问服务器"我的公网地址是什么" |
| **TURN** | 中继服务器。**打洞失败时的最后手段** |
| **DTLS-SRTP** | WebRTC 的加密。**端到端** —— 即使经过中继，中继也看不到内容 |
| **NAT 打洞** | 两个 NAT 后面的机器互相发包，让各自的 NAT 开一个洞 |
| **GStreamer** | 媒体框架。元素（element）连成管线，buffer 沿着 pad 流动 |
| **element / pad / buffer** | 元素 / 元素的输入输出口 / 数据块 |
| **tee** | 把一路复制成多路 |
| **queue** | 把支路挪到自己线程 |
| **appsink** | 把 buffer 交给你的代码的 sink |
| **valve** | 开关，`drop=true` 时丢帧 |
| **caps** | 格式描述（分辨率/帧率/像素格式） |
| **preroll** | sink 在收到第一帧前不肯进入 PLAYING。**这里踩过一次死锁** |
| **RGA** | Rockchip 的 2D 加速器。做格式/步幅转换，**也能免费旋转** |
| **MPP** | Rockchip 的 VPU 接口。**不是 V4L2 M2M** |
| **VPU** | 视频编解码硬件单元 |
| **3A** | 自动曝光、自动白平衡、自动对焦 |
| **rkaiq** | Rockchip 的 ISP 调优引擎 |
| **UYVY / NV12** | 两种像素布局。UYVY 单平面，NV12 是 4:2:0 |
| **luma** | 亮度分量 |
| **内参（intrinsics）** | `fx, fy, cx, cy` —— 把像素变成方向的四个数 |
| **FOV** | 视场角 |
| **rendezvous** | 牵线服务。机器人注册，消费者列出，它转发消息 |
| **producer / consumer / listener** | 信令协议里的三种角色。**机器人在两侧角色是反的** |
| **SSE** | Server-Sent Events。服务器→客户端的长连接文本流 |
| **lease / 心跳** | 租约。**靠入站 POST 刷新，不靠健康的流** |
| **桥（bridge）** | relay 的另一个名字。**"payload 不透明、信封要翻译"** |
| **哑管道** | 只转发、不解析。加一个方法不用改它 |
| **车道（lane）** | 回答一个调用会占用连接多久。`Prompt`/`Slow`/`Operation`/`Stream` |
| **穷尽匹配** | 匹配每个变体、没有 `_` 分支。**加一个方法会编译失败** |
| **阻尼** | 每步只走一部分（这里是 `ratio^0.6`），防振荡 |
| **死区（deadband）** | 误差小于它就什么都不做，防抖动 |
| **leaky queue** | 只保留最新的队列 |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| WebRTC 会话、信令、控制通道的权威设计 | [`design/remote-webrtc.md`](design/remote-webrtc.md) |
| 控制台页面：谁来服务、怎么找到机器人 | [`design/webrtc-console.md`](design/webrtc-console.md) |
| 账号、OAuth 设备流、桥、NAT/TURN | [`design/remote-access-design.md`](design/remote-access-design.md) |
| 板子上的视频硬件：VPU、MPP、要构建的插件 | [`project/media-bringup.md`](project/media-bringup.md) |
| 消费者该选哪条路（任务视角） | [`faq.md`](faq.md) |
| 鸭子检测器本身（姊妹篇） | [`duck-detect-primer.md`](duck-detect-primer.md) |
| 笔记本上的客户端（姊妹篇） | [`duckctl-primer.md`](duckctl-primer.md) |
| 公共线上契约：`Call`、`Service`、`Lane`（姊妹篇） | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| `[media]` / `[duck_detector]` 的 schema（姊妹篇） | [`robotd-params-primer.md`](robotd-params-primer.md) |
| 控制循环本身（姊妹篇） | [`robotd-primer.md`](robotd-primer.md) |
| 控制核心：从读总线到写总线（姊妹篇） | [`duck-control-primer.md`](duck-control-primer.md) |
| 蓝牙门房（姊妹篇） | [`btd-primer.md`](btd-primer.md) |
| BLE 的线上契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| wifi、身份、手柄配对（姊妹篇） | [`configd-primer.md`](configd-primer.md) |
| 仿真的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| 发布怎么把自己装到板子上（姊妹篇） | [`hooks-primer.md`](hooks-primer.md) |
| 板子被配置成什么样子（姊妹篇） | [`deploy-primer.md`](deploy-primer.md) |
| 关节角 → 空间中的点（姊妹篇） | [`kinematics-primer.md`](kinematics-primer.md) |
| ToF 地板判断里的 `trunk_height_m` 从哪来（姊妹篇） | [`odometry-primer.md`](odometry-primer.md) |
| 手柄自己的 IMU：姿态、零偏、yaw 漂移（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| 手柄：按键映射、模式、那个 raw tap（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| 摸头检测：麦克风、log-mel、那个门控（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| 摄像头块的数据源（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| 装机、更新、诊断的那些工具（姊妹篇） | [`scripts-primer.md`](scripts-primer.md) |
| 鸭子的嗓子：可播种的合成器（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 头部的两个传感器：深度与 IMU（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
