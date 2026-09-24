# `spaces/` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> 这个目录是**放在 Hugging Face 上的三个网页应用**，加上它们共用的一小套 Python 工具。
> 它们**不在机器人上**，也不在发布里 —— 它们是"从外面看你的鸭子"的窗口。
> 远程访问的设计（relay、rendezvous、信令）由
> [`design/remote-access-design.md`](design/remote-access-design.md) 拥有；
> 机器人那一侧的协议实现在 [`mediad-primer.md`](mediad-primer.md) 和
> [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md)；
> 怎么把它们推上去由 [`scripts-primer.md`](scripts-primer.md) 拥有。
> 若本导读与代码不一致，以代码为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：[`mediad-primer.md`](mediad-primer.md)（`media.stream` 的另一半）、
> [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md)（那些 JSON-RPC 方法）、
> [`robotctl-primer.md`](robotctl-primer.md)（同一个协议的本机版本）、
> [`configd-primer.md`](configd-primer.md)（wifi 和身份）、
> [`scripts-primer.md`](scripts-primer.md)（`publish-space.sh`）、
> [`btd-primer.md`](btd-primer.md)。

## 目录

1. [一分钟版](#1-一分钟版)
2. [⚠️ 先理清：Space 是什么，为什么这里全是 Docker Space](#2-️-先理清space-是什么为什么这里全是-docker-space)
3. [⭐ 核心心智模型：三个 Space，三种「谁连谁」](#3--核心心智模型三个-space三种谁连谁)
4. [目录地图](#4-目录地图)
5. [`shared/`：那套共用的小工具](#5-shared那套共用的小工具)
6. [`hello`：最小的那个，用来做二分](#6-hello最小的那个用来做二分)
7. [`vision-demo`：机器人主动拨号](#7-vision-demo机器人主动拨号)
8. [`policy-playground`：从 Python 容器搬进浏览器](#8-policy-playground从-python-容器搬进浏览器)
9. [发布：`publish-space.sh`](#9-发布publish-space-sh)
10. [⚠️ 平台坑：一份反复出现的清单](#10-️-平台坑一份反复出现的清单)
11. [几处读者会绊到的地方](#11-几处读者会绊到的地方)
12. [阅读路线](#12-阅读路线)
13. [术语表](#13-术语表)

---

## 1. 一分钟版

`spaces/` 回答一个问题：

> **一台在你家路由器后面的鸭子，怎么让外面的人看见、并且操作它？**

这里的核心答案是一个**方向的反转**，而它值得先说清楚，因为整个目录都在复述它：

```
   ❌ 旧的做法（拉）
   数据中心里的程序 ──WebRTC──► 需要 relay 候选 ──► 你家路由器后面的鸭子
                                  ↑ 花的是机器人主人的流量配额，按帧计费

   ✅ 这里的做法（推）
   数据中心里的程序 ──"请把画面发到这个地址"──► rendezvous ──► 鸭子
   鸭子 ════════════ 主动拨出的 WebSocket ══════════════════► 数据中心
```

`vision-demo/app.py:12-17` 把理由写得最清楚：

> **So the direction is inverted and the problem disappears.** The rendezvous is used for one
> small thing — **telling the robot where to send frames** — and the frames come **outbound from
> the robot** to a WebSocket on this Space. **A robot dialling out is the one thing that always
> works; it is doing it right now to stay reachable at all.** NAT stops being a participant, no
> relay is needed, and **the rendezvous carries an instruction rather than pixels**, which is
> also why this scales where relaying payload through a shared service would not.

**"一台主动拨号的机器人是唯一永远可行的东西 —— 它现在就在这么做，否则它根本不会出现在你的列表里。"**

三个 Space，一句话各一个：

| Space | 一句话 |
|---|---|
| **`hello`** | **诊断工具**：最小的、能跑起来的 Docker Space，用来定位"四个东西里是哪个坏了" |
| **`vision-demo`** | 鸭子的摄像头，推流到 Hugging Face，用 OpenCV 逐帧处理 |
| **`policy-playground`** | 给十岁小孩用的遥控页：**选一个把戏，看你的鸭子做** |

---

## 2. ⚠️ 先理清：Space 是什么，为什么这里全是 Docker Space

**Hugging Face Space** = 一个托管的网页应用。你给一个目录，它给你一个 URL。

Space 有两种 SDK：

| SDK | 是什么 | 这里用了吗 |
|---|---|---|
| **`sdk: gradio`** | 你写 Python，平台帮你跑 Gradio | ❌ **一个都没用** |
| **`sdk: static`** | 一堆静态文件，平台直接发 | ❌ 也没有 |
| **`sdk: docker`** | **你自己写 Dockerfile，自己起服务器** | ✅ **三个都是** |

三个 README 的 front-matter 里都写着 `sdk: docker`。

### 2.1 为什么绕开最简单的路

**每一个 Docker 决定都对应一次失败。** 这是这个目录最鲜明的特征。

`policy-playground/Dockerfile:1-14` 说得很直接：

> **Why Docker rather than a static Space.** A static Space is documented to inject
> `window.huggingface.variables`, and for `microduck-console` **it never did** — through a
> rebuild, a privacy flip, a recreation, and a page given a real `<head>` to be injected into.
> **Its Dockerfile records that afternoon**, and this takes the same way out, which is also the
> one the `telepresence` Space takes.

`vision-demo/Dockerfile:1-3`：

> A Docker Space, because **FastAPI owns the server here**: the robot's frames arrive on a
> **WebSocket route of ours**, with Gradio mounted underneath it.

`vision-demo/README.md` 里那段最完整：

> FastAPI owns the server and Gradio is mounted into it, because **the frames arrive on a
> WebSocket route of our own.** That is the documented direction — **the reverse, adding routes
> to Gradio's app, has known WebSocket breakage** — and running `uvicorn` ourselves removes any
> question about whether the platform will carry a custom route.

**"反过来做 —— 往 Gradio 的 app 上加路由 —— 有已知的 WebSocket 故障。"**

### 2.2 一句话总结这个目录的工程风格

> **凡是"平台说它会帮你做"的事，这里都自己做了一遍 —— 因为平台没做。**

`policy-playground/entrypoint.sh:16-19` 把这条讲成了原理：

> It also keeps the property the placeholder was chosen for: **the injection is ours, out of this
> container's own environment, and depends on nothing on Hugging Face's side that can silently
> stop happening.**

**"这个注入是我们自己的，来自这个容器自己的环境变量，不依赖 Hugging Face 那边任何会悄悄停止发生的事情。"**

---

## 3. ⭐ 核心心智模型：三个 Space，三种「谁连谁」

这是理解 `shared/` 为什么存在、以及为什么每个 Space 长得不一样的钥匙。

```
   ①  vision-demo   「鸭子主动连上来」
      鸭子 ──outbound wss──► Space 的 WebSocket 路由
      控制：Space ──rpc──► rendezvous ──► 鸭子          （反向的那一条）

   ②  policy-playground  「浏览器直接连鸭子」
      浏览器 ──POST /send {peer, rpc}──► rendezvous ──► 鸭子
      浏览器 ◄──SSE {peer, rpc}───────── rendezvous ◄── 鸭子
      没有 Space 容器参与！（Docker 只是用来发那一页）

   ③  hello        「什么都不连」
      只有一条自己的 WebSocket 路由，用来证明这四件事里哪一件坏了
```

### 3.1 关键洞察：**rendezvous 什么都能转发**

这是 `shared/wire.py:10-14` 揭示的、整个 `policy-playground` 得以存在的那件事：

> The rendezvous already relays what is wanted: `handle_peer_message` in its `app.py` forwards
> **every key of a `peer` envelope except `type` and `sessionId`** verbatim to the session
> partner, **without looking at `sdp` or `ice`.** So **a `peer` envelope carrying an `rpc` key is
> a control call**, and `mediad::relay`'s control lane answers it out of the same routing table
> and the same per-lane sockets the datachannel uses.

```
POST /send  {"type": "peer", "sessionId": S, "rpc": {"jsonrpc": "2.0", "id": 1, …}}
SSE         {"type": "peer", "sessionId": S, "rpc": {"jsonrpc": "2.0", "id": 1, "result": …}}
```

**"它不看 `sdp` 也不看 `ice`。"** —— 服务只是**按 key 原样转发**。所以：

> **Two HTTP verbs, one stream, and nothing a NAT can refuse.**

**"两个 HTTP 动词，一条流，没有任何 NAT 能拒绝的东西。"**

### 3.2 这条路的四项代价

`wire.py:19-36` 逐条列了，每一条都是读者会踩的：

| 代价 | 原文 |
|---|---|
| **没有视频** | *"Pixels are RTP on the media path. Over this they would be **base64 inside JSON** at the rate limit below — **a snapshot, not a stream** — so this transport shows none, and the page says so."* |
| **不是遥操作通道** | *"The rendezvous allows **1200 requests per 60 s per peer**, and going over earns a `429` on **everything that token does**. The robot's lane budgets its own notifications for that reason"* —— 而 *"**a click is four calls**"* |
| **必须先开流** | *"`POST /send` before `GET /events` is a **400** — identity comes from the bearer token and **the stream is what binds it** — so the stream opens first and everything else follows the `welcome`."* |
| **有两个答案不在流上** | *"`startSession`'s answer is **in the POST body**, not on the stream, which is the one shape a reader of this protocol gets wrong once. `list` is the same."* |

### 3.3 `control.py`：为什么这段代码"与传输无关"是**承重的**

`shared/control.py:8-11`：

> **Transport-agnostic, and that is now load-bearing rather than tidy.** Three of them have been
> tried: **a datachannel over the rendezvous, a datachannel on the LAN, and JSON-RPC relayed as
> HTTP with no WebRTC at all.** Every one of them hands lines to this object and takes lines back,
> so **none of the page above it changed when the first was replaced by the third.**

**"当第一个被第三个替换掉的时候，它上面的页面一行都没改。"**

---

## 4. 目录地图

```
spaces/
├── shared/                    ← 三个 Space 共用的 Python 工具（零第三方依赖之外的东西）
│   ├── wire.py          412   ← ⭐ JSON-RPC over rendezvous，完全没有 WebRTC
│   ├── rendezvous.py    235   ← 一个账号能连到哪些机器人、谁忙
│   └── control.py       164   ← JSON-RPC 2.0 的行协议，与传输无关
│
├── hello/                     ← 76 行 app.py + Dockerfile，纯诊断
│   ├── app.py            76
│   ├── Dockerfile
│   └── README.md
│
├── vision-demo/               ← 鸭子推流过来，OpenCV 逐帧处理
│   ├── app.py           503   ← FastAPI + 自己的 WebSocket 路由 + Gradio 挂在下面
│   ├── receiver.py      301   ← ⭐ 鸭子拨进来的那个端点，以及"这是谁的摄像头"
│   ├── filters.py       146   ← 逐帧的像素处理（只依赖 OpenCV + numpy）
│   ├── boot.py           60   ← ⭐ 起不来的时候，**把原因端出来而不是退出**
│   ├── Dockerfile
│   └── README.md
│
└── policy-playground/         ← 给小孩用的遥控页
    ├── index.html        25   ← **构建产物**（`npm run build` 生成，已提交）
    ├── entrypoint.sh     67   ← ⭐ 把 HF 的运行时变量写进页面，然后发文件
    ├── Dockerfile
    ├── README.md
    └── web/                   ← 真正的源码（Vite + TypeScript）
        ├── src/main.ts      746   ← 页面状态机
        ├── src/rendezvous.ts 362  ← `wire.py` 的 TypeScript 移植
        ├── src/hub.ts       291   ← Hub 上有什么策略，按机器人的读法读
        └── src/auth.ts      188   ← PKCE 登录，**没有任何 secret**
```

**约 5,000 行，其中 3,700 是 Python + TypeScript，1,400 是 `package-lock.json`。**

### ⚠️ 三个看不见的文件：符号链接

`ls spaces/vision-demo/` 会看到 `control.py`、`rendezvous.py`、`wire.py` 三个文件，
但 `find -type f` **看不到它们** —— 它们是**符号链接**：

```
spaces/vision-demo/control.py     -> ../shared/control.py
spaces/vision-demo/rendezvous.py  -> ../shared/rendezvous.py
spaces/vision-demo/wire.py        -> ../shared/wire.py
```

**这是 `shared/` 到达 Space 的唯一机制**，见 §5.0。`policy-playground` 不用它们
（它是 TypeScript，自己移植了一份），`hello` 也不用（它是纯诊断，什么都不连）。

---

## 5. `shared/`：那套共用的小工具

这三个文件是**三个 Space 之间唯一的共享代码**。它们只做一件事：**把 JSON-RPC 送到鸭子那里。**

### 5.0 ⭐ 它们怎么到达一个 Space：符号链接 + `cp -L`

**一个 Space 仓库不能有父目录。** 所以 `spaces/shared/` 里的模块靠**符号链接**进到
每个 Space 的顶层目录，然后由 `publish-space.sh` 在发布的那一刻**解引用**。

`scripts/publish-space.sh:62-67` 解释了这件事：

> **Symlinks are followed and flattened, which is how two Spaces share a client.** `spaces/shared`
> holds the modules that speak this project's protocols — the control lane, the rendezvous
> listing — and **each Space links to the ones it uses. A Space repo cannot have a parent
> directory, so `-type l` and `cp -L` turn the link into the file at publish time.**
> **Duplicating those modules per Space instead is the drift `remote-access-design.md` §5 keeps
> their source in this repository to avoid**, and **two copies in one repository would drift just
> as happily.**

**"两个在同一仓库里的副本，会一样欢快地漂开。"**

而在本地跑的时候，符号链接就是符号链接 —— 所以 `vision-demo/app.py:43` 有这一行：

```python
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
```

`app.py:42` 的注释说明了它为什么够用：

> `spaces/shared`, **flattened beside this file at publish time** by `scripts/publish-space.sh`.

**所以本地是"链接解析成 `../shared/`"，发布后是"文件就在旁边" —— 两种情况下 `import control` 都成立。**

### 5.1 `control.py`：id 出去，答案和通知回来

`control.py:3-6`：

> `duck-ipc-proto`'s own wire, **one object per line** — the same lines `robotctl` sends over a
> unix socket, the console page sends over a datachannel, and `mediad`'s control lane relays
> inside a `peer` envelope. **Ids are handed out here and answers matched to them, which is what
> lets a Gradio callback block on one.**

**"同一批行。"** 这是整个目录能成立的前提 —— 见 [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md)。

它还记了一个已经消失的垫片（`control.py:13-18`）：

> It once also held a shim over `ReachyCentralConsumer`, whose `pc.on("datachannel")` handler
> **drops any label but `"data"` while `mediad` opens `"control"`** — `remote-access-design.md`
> §5.1 records it, and **it is still true of their client.** It is gone because **the transport
> that needed it is gone**.

### 5.2 `rendezvous.py`：只是问"我有哪些机器人"

`rendezvous.py:3-9` 特别强调了它是**读代码读出来的，不是猜的**：

> `GET /api/robot-status` with `Authorization: Bearer <hf token>`. **Read off
> `pollen-robotics/reachy_mini_central`'s `app.py` rather than guessed**, because a `401` from it
> was first mistaken here for something structural: the endpoint is `Depends(_resolve_hf_token)`
> and then `validate_hf_token`, which is one `whoami-v2` call and **no scope check, no token-type
> check and no requirement that the caller hold an event stream.**

**为什么用它而不是用控制台那条路**（`rendezvous.py:11-16`）：

> better than the console's route for one: `mediad/webclient/index.html` lists by opening
> `GET /events` and asking `list`, because a browser that is about to start a session needs the
> stream anyway. **Peers are keyed by token, so a second `/events` on the same one supersedes the
> first** — **a page that listed that way could not refresh its list without dropping the session
> it was holding.** This one opens nothing.

**"一个用那种方式列清单的页面，没法在不丢掉自己正持有的会话的情况下刷新清单。"**

### 5.3 那两个诊断结论

`rendezvous.py:18-26` 记了两条**看起来像机器人问题、其实不是**的：

> **A `429` here is not theirs.** `robot_status` is `validate_hf_token` and then a loop over the
> producers — **it never calls `check_rate_limit`** … So **a 429 on this route was written by
> something in front of the application**, and `_who_answered` exists to say which something.
>
> **A `401` here means the token, and nothing else.** … run outside a Space, **Gradio mocks its
> login and hands the app the literal string `mock-oauth-token-for-local-dev`**, which
> `whoami-v2` refuses **exactly as it should.**

**"`mock-oauth-token-for-local-dev`"** —— 一个在本地开发时会被当成"机器人有问题"的东西，
实际是 Gradio 的模拟登录。

---

## 6. `hello`：最小的那个，用来做二分

**这个 Space 的存在理由是诊断。** `hello/README.md:14-15`：

> A deliberately minimal Docker Space, **published to find out which of four things breaks the
> real one**: the container, a custom WebSocket route, Gradio mounted under FastAPI, or Hugging
> Face OAuth.

> It has **the first three and *not* OAuth**, which is where the last crash was. **Grow it back
> one piece at a time rather than debugging four at once.**

**"一次加回来一块，而不是同时调试四件事。"**

而它为什么**故意不要 OAuth**（`hello/app.py:3-6`）：

> **No OAuth**, because that is where the real app died: a `gr.LoginButton` makes Gradio call
> `attach_oauth` while the Blocks is built, **which mocks when `SPACE_ID` is absent, and the mock
> raises without a local `hf auth login`. A container has none.**

**这是一个可以带走的调试技术**：当四件事同时可能坏的时候，**造一个只差其中一件的最小版本**。

---

## 7. `vision-demo`：机器人主动拨号

### 7.1 它的形状

```
   this Space ──media.stream {url: "wss://…/frames"}──► rendezvous ──► the duck
   the duck   ═════════ H.264, outbound wss, direct ═════════════════►  this Space
```

`media.stream` 那个调用**由 `mediad` 自己回答**（`mediad/src/stream.rs`），
而它**一个 key 读三种意思**（`vision-demo/README.md`）：

> a `url` starts a stream, `url: null` stops it, and no `url` asks what is streaming.

### 7.2 代价，逐条说清楚

这个 README 有一整节叫 **"What that costs"** —— 这是整个目录里最诚实的写法：

| 代价 | 原文 |
|---|---|
| **没有回程媒体路径** | *"This cannot drive the robot or watch it in real time; **a viewer wants WebRTC** and §6 is still what that needs. This is for the case where **the consumer is a program**."* |
| **每秒几帧，不是三十帧** | *"Five at 640 px is plenty for a model and a fraction of the encode the video track is already doing. **The rate is imposed on the robot by a `videorate` in the branch rather than by the receiver asking politely.**"* |
| **H.264 的解码代价** | *"a receiver **cannot decode anything until a keyframe arrives**, and **a dropped unit corrupts every unit after it until the next one**"* |

而 H.264 vs JPEG 的数字是**量出来的**：

> on synthetic frames it measured **0.5 KB against JPEG's 6.5 KB**, and real camera footage will
> be **less dramatic than that but the same direction.**

三个应对措施（都是"处理了，不是指望它没事"）：

1. `mediad` **在阀门打开的那一刻就向编码器要一个关键帧**
2. **每个关键帧前面重复 SPS/PPS**
3. **遇到缺口就丢弃到下一个关键帧，而不是跨着缺口发**

### 7.3 ⭐ "这是谁的摄像头" —— 一个不能省掉的检查

`receiver.py:14-24`：

> This endpoint is public — **a Space's URL is a Space's URL** — so anything that can reach the
> internet can open it. **Two things would go wrong without a check**: anybody could push frames
> into somebody else's demo, and worse, **a visitor could be shown a stranger's camera.** So the
> robot presents **its own account token** on the handshake and this resolves it through
> `whoami-v2`, exactly as the rendezvous does, and frames are filed under the username it answers
> with. **A visitor sees the robots on their own account and nothing else.**
>
> **The token never leaves this process and is never stored**: it is resolved once per connection
> and what is kept is the username.

**"Space 的 URL 就是 Space 的 URL"** —— 公开的。所以认证不是可选项。

### 7.4 `boot.py`：⭐ 起不来的时候，把原因端出来

这是整个目录里**最值得偷的一个技巧**（`boot.py:1-10`）：

> Start the app — and when it cannot start, **serve the reason instead of exiting**.
>
> A container that exits is reported by Hugging Face as **"App process crashed"**, and the only
> detail that reaches its API is **a truncated first line**: **four rounds of this went into the
> port** before a pasted traceback showed the real fault was an import-time `ValueError` from
> Gradio's OAuth setup. **Reading a Space's own logs needs write access to the Space, so every
> question cost a round trip.**
>
> So: **import the app inside a `try`. If it works, serve it. If it does not, serve a page that
> *is* the traceback, on the port the platform expects.** The Space stays up, `curl` answers the
> question, and **nobody has to paste a log again.**

**"那个 Space 会保持运行，`curl` 就能回答这个问题，再也不用有人去粘贴日志了。"**

### 7.5 `filters.py`：为什么像素处理单独一个文件

`filters.py:1-7`：

> Separate from `app.py`, and **for the same reason `mediad`'s `session.rs` is
> transport-agnostic**: it **imports OpenCV and numpy and nothing else**, so it can be exercised
> **on a synthetic frame pair without a WebRTC stack, a robot, or a Hugging Face token.**
> Every one of these is **a few lines whose failure mode is a wrong picture rather than an
> exception**, which is exactly the kind of thing **to run before a Space builds rather than
> after.**

**"失败模式是一张错的图，而不是一个异常 —— 这正是那种应该在 Space 构建之前而不是之后跑的东西。"**

### 7.6 ⚠️ 一处已经过期的文档：README 说 JPEG，代码说 H.264

`vision-demo/README.md` 的 "The robot dials us" 一节写的流程图是：

```
the duck   ═════════ H.264, outbound wss, direct ═════════════════►  this Space
```

而**同一个文件更下面的 `app.py` 的模块文档**（`app.py:19-20`）画的是：

```
the duck   ═════════ JPEG frames, outbound wss, direct ═════════►  this Space
```

README 的正文**已经把这件事讲对了** —— 它有一整段解释为什么从 JPEG 换成了 H.264
（*"on synthetic frames it measured 0.5 KB against JPEG's 6.5 KB"*），
而且明确保留了 JPEG 作为可选项（`media.stream {"encoding": "jpeg"}`）。
**只有 `app.py` 顶部那张 ASCII 图没跟着改。**

### 7.7 这里已经没有 WebRTC 了

README 的最后一节：

> It used to pull frames with `reachy_mini[central-consumer]`, which meant **`aiortc`, `av`, and
> a DTLS cipher shim over one of their private methods** — and which **could never connect from a
> data centre.** The robot dials us now, so what is left is `gradio`, `fastapi`, `opencv`,
> `requests` and `av`. **That last one is back for H.264, and it is a *decoder* rather than a
> *transport*: no ICE, no DTLS, no signalling, nothing that a NAT gets a vote on.**

**"它回来是为了 H.264，而且它是一个*解码器*而不是一个*传输层*：没有 ICE，没有 DTLS，
没有信令，没有任何 NAT 有权投票的东西。"**

---

## 8. `policy-playground`：从 Python 容器搬进浏览器

### 8.1 ⭐ 为什么把整页从 Python 搬到浏览器

`policy-playground/README.md` 有一节叫 **"Why it is a browser and not a Python container"**，
列了**四个**只有"在数据中心里跑的客户端"才会有的问题：

| # | 问题 | 原文 |
|---|---|---|
| **①** | **rendezvous 拒绝它** | *"`requests` signs its calls **`python-requests/2.x`**, which Hugging Face's edge reads as **a bot**: from a Space container the very first `GET /api/robot-status` came back **`429` with an HTML page and `server=awselb/2.0`**, and **the service never saw the request.** From a browser the call carries **the visitor's own address and their own browser's signature.**"* |
| **②** | **每个访客共用一只机器人** | *"The session lived in **a module-level object**, because **module globals are per-process and a Space is one process.** Here **each visitor is their own browser**, and per-visitor sessions cost nothing to arrange."* |
| **③** | **一整套 WebRTC 依赖** | *"`aiortc`, `av`, a DTLS cipher patch and `PyGObject` existed **to give Python a WebRTC stack. A browser has one.**"* |
| **④** | **服务端渲染** | *"which put a Node proxy in front of the page and **stopped ten seconds after it started, with no traceback.**"* |

> **None of those exist here.** `microduck-console` is the same shape and **has never had any of
> them.**

**第 ① 条是最漂亮的**：一个 `User-Agent` 字符串，让整个服务端方案从第一行就死掉。

### 8.2 ⭐ 受众是十岁小孩，这是**约束**不是装饰

`web/src/main.ts:1-17`：

> **Written for a ten-year-old**, which is **a constraint on the whole file and not a coat of
> paint.** **Nothing on the page names a method, a transport, a socket or a schema.** A trick has
> **a name, a sentence about what it does, and one button.** What the four calls are, which lane
> they take and why a refusal happened lives in ***What just happened?*** at the bottom, which is
> where you go **when something breaks rather than when you want to see a duck bow.**

而 README 补了一句：

> What the four calls are — `policy.fetch`, `robot.setSkill`, `robot.policies`, `robot.do` —
> which lane they take, and why a refusal happened, all live in **What just happened?** at the
> bottom.

### 8.3 ⭐ "等你的鸭子"不是填充

README 里那句加粗的：

>     getting it → putting it on your duck → waiting for your duck → doing it
>
> **"Waiting for your duck" is not padding.** Putting a trick on a duck **makes it reload**, a
> reloading duck **goes back to its standing pose**, and **it refuses to do anything until it gets
> there** — so without the wait, **the press that installs is the press that gets refused, and
> the trick silently never runs.** `homed` on `robot.policies` (`API_VERSION` 30) is the flag to
> wait on. **A duck too old to publish it sends nothing, and then there is nothing to wait for.**

而 `main.ts:29-37` 给了那个超时：

```ts
/**
 * How long to wait for a duck that is going back to its standing pose.
 * …
 */
const HOME_TIMEOUT = 15_000;
```

**以及一条关于状态的原则**（`main.ts:45-52`）：

> Not a belief this page keeps: **the robot owns it, and anything else can change it** — the pad,
> a relax, either side restarting. **A client that remembered its own answer would show a Start
> button that does nothing every other press**, which is the reason `robot.enable` has a `toggle`.

**"一个记住自己答案的客户端，会每隔一次就显示一个按了没反应的 Start 按钮。"**

### 8.4 `hub.ts`：同一个规则写了第二遍

`hub.ts:45-55` 有一个 `notATrick()`，它有一段很重要的注释：

> **Why this cannot be a trick you ask for, or `null`.**
>
> **The daemon does not make this check and `robot.setSkill` would accept the entry**: a policy
> whose command the daemon generates — a phase for a ground pick, a flag for a sit — **fed a
> constant instead is a robot moving plausibly and wrongly, which is worse than a refusal.**
> `robotctl` is where the rule lives on the robot's side and **`robotctl` is not in the path of a
> click, so it is written here a second time.**
>
> **Said in words a child can act on**: this is not a trick, it is part of how the duck moves.

**"一个被喂了常量的地面拾取，是一台看起来合理地、但错误地动着的机器人 —— 那比拒绝更糟。"**

还有一条关于**报错信息本身**的教训（`hub.ts:58-61`）：

> **Deliberately generic.** The first version **named a ground pick**, because `phase` was the
> ground pick's encoding — and then `robot_crouch` arrived, which is **also `phase` and is not a
> ground pick**, and **the page told somebody it was.** The encoding says the duck drives this
> one itself.

**"第一版点名了一个地面拾取，因为 `phase` 曾经是地面拾取的编码 —— 然后 `roller_crouch` 出现了，
它也是 `phase` 但不是地面拾取，而页面就这么告诉别人了。"**

### 8.5 `hub.ts`：画廊和 `policy.search` 不可能不一致

`hub.ts:4-6`：

> A port of `…/catalogue.py`, which **makes the same two requests `updater/src/policy.rs` makes**
> — `?search=microduck` and a `manifest.json` per hit — so **the gallery and `policy.search`
> cannot disagree about what exists.**

而那一句关于信任边界的（`hub.ts:14-15`）：

> **Every field below the repo is the publisher's claim, not a fact — displayed, never acted on.**
> **What gets installed comes from the robot's own reading of the manifest it downloaded.**

**"仓库以下的每个字段都是发布者的声明，不是事实 —— 只展示，绝不据此行动。"**

### 8.6 `auth.ts`：PKCE，所以页面可以公开

`auth.ts:1-7`：

> Signing in with Hugging Face, from the page, **with no secret anywhere near it.**
>
> **PKCE: the browser proves it started the flow, so the app needs no client secret and this page
> can be read by anybody.** `OAUTH_CLIENT_SECRET` is in the Space's environment and **must never
> reach here** — `entrypoint.sh` publishes only the variables a static Space publishes, and **that
> is not one of them.**

而为什么用 `localStorage` 而不是 `sessionStorage`（`auth.ts:21-26`）：

> **`localStorage` rather than `sessionStorage`: the Hugging Face redirect can come back in a new
> tab, and a session store is empty there — which reads as a sign-in that silently did nothing.**

### 8.7 `rendezvous.ts`：`wire.py` 的移植，加上浏览器带来的一个好处

`rendezvous.ts:13-23` 列了**协议会惩罚不知情读者**的四件事：

| # | 陷阱 |
|---|---|
| **①** | **`POST /send` before `GET /events` is a 400.** |
| **②** | **`startSession` and `list` answer in the POST body**, not on the stream. *"This is the shape a reader gets wrong once."* |
| **③** | **CRLF 不是我们能假定的。** *"SSE permits `\r\n` and a proxy may rewrite them; **splitting on `\n\n` alone then matches nothing and every message vanishes in silence.**"* |
| **④** | **一只机器人一个消费者。** *"`sessionRejected` means somebody else holds it, and **the robot's own console counts.**"* |

而**浏览器带来的那一个好处**（`rendezvous.ts:25-28`）：

> And one thing the browser changes for the better: **`EventSource` cannot send an
> `Authorization` header**, so this reads the stream with `fetch` and a reader. **That is not a
> workaround — it is what lets the token stay in a header rather than a query string** the
> service only kept as a deprecated fallback.

**"这不是绕路 —— 正是它让 token 能留在一个 header 里，而不是一个服务端只作为废弃后备保留的查询字符串里。"**

### 8.8 `entrypoint.sh`：⭐ 那个锚定的正则

`policy-playground/entrypoint.sh` 干的事是：把环境变量写进页面的 `<head>`，然后发文件。
而里面有一段**关于正则的注释**，记的是一个很妙的失败（`entrypoint.sh:42-46`）：

> **The opening tag on a line of its own, not the first `<head>` in the file.** The page's own
> comments talk about `<head>` — **that skeleton being load-bearing is the whole reason it has
> any** — and **a plain first-match replace puts the bootstrap *inside an HTML comment*, where it
> never runs.** The page then **looks exactly like a Space with no OAuth app**, which is the
> failure those comments are a record of. **Anchored, and required to match once.**

```python
HEAD = re.compile(r"^([ \t]*)<head>[ \t]*$", re.MULTILINE)
```

而且它**拒绝猜**：

```python
if found is None:
    sys.exit("no <head> line to inject into; the page cannot sign anybody in")
if HEAD.search(page, found.end()) is not None:
    sys.exit("more than one <head> line; refusing to guess which one serves the page")
```

**"页面的注释里就提到了 `<head>` —— 而那个骨架是承重的，这正是它要有注释的原因 ——
于是一个朴素的首次匹配替换，会把启动脚本放进一个 HTML 注释里面，它永远不会运行。"**

**为什么用 Python 而不是 `sed`**：

> because **the value being substituted is now JSON**: a provider URL is full of the characters
> a `sed` replacement treats as syntax, and **one of them silently produces a page that parses
> and signs nobody in.**

**"它们中有一个会静默地产生一个能解析、但谁都登录不了的页面。"**

### 8.9 为什么构建产物被提交进仓库

README：

> That file is committed, because **`publish-space.sh` publishes the *top level* of a space
> directory — files, not trees** — and a bundler emits `assets/`. **Inlining everything keeps the
> published Space the same four files the console has**: a page, a Dockerfile, an entrypoint and
> this card. **Nothing is built on Hugging Face's side, so nothing there can fail for a reason
> nobody can see.**

**"在 Hugging Face 那边什么都不构建，所以那边不可能因为一个没人看得见的原因而失败。"**

---

## 9. 发布：`publish-space.sh`

`scripts/publish-space.sh`（见 [`scripts-primer.md`](scripts-primer.md)）把 `spaces/<name>/`
推到 `pollen-robotics/microduck-<name>`。

```bash
scripts/publish-space.sh vision-demo
scripts/publish-space.sh vision-demo --space pollen-robotics/other-name --dry-run
```

### 9.1 ⭐ 为什么源码在**这个**仓库里

`publish-space.sh:4-8`：

> The source lives in this repository **for the reason `remote-access-design.md` §5 gives about
> the console**: **a Space consuming a duck tracks things that live here** — the rendezvous
> protocol, the robot's own method names, the camera's geometry — and **a copy in a Space repo
> drifts from all of them.** This is the deploy, by hand while there are two of them.

**"一个消费鸭子的 Space，跟踪的是住在这里的东西。"**

### 9.2 两个 README 都用同一句话警告

`vision-demo/README.md` 和 `policy-playground/README.md` 都有一句加粗的：

> **Do not edit this Space directly.** The source is `spaces/<name>/` in
> `pollen-robotics/microduck`, and `scripts/publish-space.sh` is what puts it here.

**"不要直接编辑这个 Space。"** —— 因为下一次 `publish-space.sh` 会覆盖掉。

### 9.3 ⭐ "先暂存，再比较"

这个脚本里有一段很值得学的注释（`publish-space.sh:72-77`）：

> **Staged first, then compared.** `git diff --quiet` **ignores untracked files**, so a publish
> whose only change is **a *new* file** reported **"the Space already serves this" and pushed
> nothing** — **the worst answer available, because it is indistinguishable from success.**
> Staging first and then diffing the index sees additions, deletions and modifications alike.

**"这是能给出的最坏的答案，因为它和成功无法区分。"**

### 9.4 两条别的边界

**只拷贝，不同步**（`publish-space.sh:53-55`）：

> **Copied rather than synced: a file deleted here stays in the Space until somebody removes it
> there. Deliberate — a `--delete` that ran against the wrong Space id would remove somebody's
> work**, and these are hand-run.

**用 `find` 而不是通配符**（`publish-space.sh:57-61`）：

> Files only, and **`find` rather than a glob for one reason: running a Space locally leaves a
> `__pycache__` beside its source** (gitignored, so it stays there), and **`cp` without `-r` fails
> on a directory instead of skipping it** — which under `set -e` **aborts the publish after the
> clone, for a reason that has nothing to do with the Space.**

**用 `find -maxdepth 1 \( -type f -o -type l \)` 才同时拿到普通文件和符号链接** —— 这就是 §5.0。

---

## 10. ⚠️ 平台坑：一份反复出现的清单

这个目录里最实用的一部分。**每一条都是花过时间的。**

### 10.1 用户必须是 `user`，家目录必须是 `/home/user`

`vision-demo/Dockerfile:5-9`：

> **The user is `user` at `/home/user`, and that is not a preference.** Hugging Face appends its
> own layers to a Docker Space's build — **a dev-mode init process, an openvscode-server, a `git
> config --global`** — and they assume **the canonical uid-1000 `user` with a writable
> `/home/user`.** **Naming it `duck` and putting `HOME` elsewhere built fine locally and failed in
> their builder with `exit code 1` under a page of cache-miss noise, which names no step at all.**

三个 Space 的 Dockerfile 都有这几行：

```dockerfile
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    PYTHONUNBUFFERED=1
```

### 10.2 ⚠️ `git` 是给 Hugging Face 装的，不是给我们

`hello/Dockerfile:3-5` 和 `vision-demo/Dockerfile:19-24` 都装了 `git`，理由一样：

> **`git` is for Hugging Face, not for us.** Their builder appends layers to every Docker Space,
> and one of them is `git config --global user.email …`. **A `-slim` base has no git, so that
> layer dies with `exit code: 127` *after* the whole image has built successfully** — and the
> error the API reports for it is **a page of cache-miss noise naming one of their own steps,
> which is not something anybody guesses from.**

**"整张镜像成功构建完之后，那一层死于 `exit code: 127`"** —— 而且报的是一页缓存未命中的噪音。

### 10.3 ⚠️ `SYSTEM=spaces` —— "四轮调试就是为这一行"

`vision-demo/Dockerfile:39-50`：

> **`SYSTEM=spaces`, and this one line is what four rounds of debugging were about.**
>
> Gradio decides whether it is running on a Space with `get_space()`, which is
> **`os.getenv("SYSTEM") == "spaces"` and then `SPACE_ID`** — *not* `SPACE_ID` alone. **Hugging
> Face sets `SYSTEM=spaces` for gradio-SDK Spaces and *not* for Docker ones**, so on a Docker
> Space **Gradio concludes it is on somebody's laptop**: `attach_oauth` installs its *mocked*
> login routes, and **the mock calls `_get_mocked_oauth_info()`, which raises without a local
> `hf auth login`.**
>
> A container has none, so **the module fails at import, uvicorn never binds, and the platform
> reports "App process crashed" — while the UI you can see for a second is the previous container
> still serving.**
>
> **`SPACE_ID` and `OAUTH_CLIENT_ID` were both set the whole time. The only thing missing was this.**

**"`SPACE_ID` 和 `OAUTH_CLIENT_ID` 一直都设着。唯一缺的就是这一行。"**

### 10.4 `GRADIO_SSR_MODE=false`

`vision-demo/Dockerfile:32-37`：

> Ruled out explicitly rather than left to the environment, and **on its own line because a
> comment inside a line continuation is not something to gamble a build on.** Gradio's
> server-side rendering **starts a `Node` server of its own and this image has no Node**, so a
> platform that sets `GRADIO_SSR_MODE=true` would have `mount_gradio_app` try to launch one. **SSR
> buys SEO for a page that sits behind a sign-in, which is nothing worth a second process for.**

### 10.5 这张清单的一般形式

把 §10.1–10.4 抽出来，就是一条：

> **托管平台会往你的镜像里追加它自己的层，而那些层假定了一个特定的环境。
> 当假定不成立时，失败发生在你完全看不到的地方，而报错指向他们自己的步骤。**

所以这个目录的 Dockerfile **把一个平台的内部假设显式地写成了自己的代码** ——
`user`/`/home/user`/`git`/`SYSTEM=spaces`/`GRADIO_SSR_MODE=false`。
**每一条都是一次调试的化石。**

---

## 11. 几处读者会绊到的地方

按仓库的规矩，这里只**陈述事实**，不判断该怎么办。

### 11.1 `vision-demo` 的 README 和 `app.py` 对帧格式的说法不一致

见 §7.6。README 的流程图说 **H.264**（正文也整段解释了为什么换成 H.264），
而 `app.py:20` 的流程图说 **JPEG frames**。

### 11.2 `hub.ts` 的模块文档指向一个不存在的文件

`hub.ts:4`：

> A port of `spaces/shared/../policy-playground/catalogue.py`

那个路径规整一下就是 `spaces/policy-playground/catalogue.py` —— **而这个文件在仓库里不存在**
（`policy-playground/` 下只有 `index.html`、`entrypoint.sh`、`Dockerfile`、`README.md` 和 `web/`）。

那句里的 `spaces/shared/../` 也让这个路径读起来像是一个被移动过的文件留下的痕迹。

### 11.3 `spaces/hello/requirements.txt` 的内容值得看一眼

`hello` 是"最小的、仍然是真 Space 形状的东西"，所以它的依赖清单**就是它宣称支持的那三件事**
（容器 / 自定义 WebSocket 路由 / Gradio 挂在 FastAPI 下）所要求的最小集合。
如果你想确认"哪些依赖是真正必需的"，这是**唯一一份没有被别的东西污染的清单**。

### 11.4 `vision-demo/wire.py` 是一条符号链接，而在编辑器里读起来像一份副本

见 §5.0。用 `find -type f`、`ls -l` 之外的方式列出这个目录，
`wire.py` / `control.py` / `rendezvous.py` 看起来就是三个普通文件。
**但它们是到 `spaces/shared/` 的链接** —— 改其中一个就是改共享的那个，
而这一点在 `git ls-files`（它列出链接本身）里也看不出来。

`publish-space.sh` 在推送前会把它们**解引用成真正的文件**，所以 Space 上看到的是副本；
**本地是链接、远端是副本，这个差别只在 `publish-space.sh` 的一条注释里写明了。**

### 11.5 `policy-playground` 的 README 说"四个调用"，但页面上的调用不止四个

README：

> What the four calls are — `policy.fetch`, `robot.setSkill`, `robot.policies`, `robot.do`

这四个是**按一个把戏走的流程**（下载 → 安装 → 轮询 → 执行）。
而 `main.ts` 里还用了 `robot.skills`（`main.ts:58` 提到 `overridden`）、
`robot.enable`（`main.ts:50`）等等 —— 那些属于**进页面时的准备**，不属于按一个把戏的流程。
README 那句话读起来像穷举，实际是"一次点击的四个调用"。

---

## 12. 阅读路线

**约 5,000 行，但三个 Space 各读各的，互不依赖。**

### 如果只有十分钟

读 §1 那张方向对比图，然后读 `spaces/shared/wire.py` 的模块文档（`wire.py:1-36`）。
**那 36 行解释了这个目录一半的设计。**

### 路径 A：我想理解"机器人怎么被从外面够到"

| 步 | 读什么 |
|---|---|
| 1 | §1 和 §3.1 |
| 2 | `spaces/shared/wire.py:1-36`（rendezvous 转发一切） |
| 3 | `spaces/shared/rendezvous.py:1-27`（`/api/robot-status` 到底做什么） |
| 4 | `spaces/shared/control.py:1-19`（同一批行） |
| 5 | [`design/remote-access-design.md`](design/remote-access-design.md) §3 §5 §6 |
| 6 | [`mediad-primer.md`](mediad-primer.md)（机器人那一侧） |

### 路径 B：我想给鸭子做一个网页

| 步 | 读什么 |
|---|---|
| 1 | `policy-playground/README.md` 全文（**这是这个目录里最好的一份文档**） |
| 2 | `web/src/rendezvous.ts:1-29`（那四个陷阱） |
| 3 | `web/src/main.ts:1-60`（状态机 + 那三条注释） |
| 4 | `web/src/auth.ts:1-60`（PKCE，没有 secret） |
| 5 | `entrypoint.sh` 全文（67 行，那个锚定正则） |
| 6 | `web/src/hub.ts:45-61`（`notATrick` 和它那次报错事故） |

### 路径 C：我想发布一个 Space

1. `policy-playground/README.md` 的 "Working on it"（`npm run dev` / `npm run build`）
2. `policy-playground/Dockerfile:1-14`（为什么构建产物被提交）
3. `scripts/publish-space.sh`
4. §10 那张平台坑清单

### 路径 D：我想知道"为什么连不上"

1. `vision-demo/boot.py:1-10`（**先让容器别退出**）
2. §10.3（`SYSTEM=spaces`）
3. `hello/`（二分：四件事里是哪一件）
4. `shared/rendezvous.py:18-26`（429 不是他们的，401 就是 token）

### 三条贯穿全文的主线

1. **方向反转。** 一台主动拨号的机器人是唯一永远可行的东西。控制走 rendezvous 的
   `peer` 转发，画面走鸭子自己拨出去的那条 WebSocket。**整个目录都是这一条的推论。**

2. **凡是"平台说会帮你做"的，这里都自己做了一遍。** `window.huggingface.variables` 的注入、
   OAuth 的挂载、SSR 的关闭、uid-1000 的用户 —— **每一个都是因为平台没做或做错了。**
   这条风格会让人误以为是偏执，直到你读到 `SYSTEM=spaces` 那四轮调试。

3. **报错信息是产品的一部分。** `boot.py` 把 traceback 当成页面端出来；
   `notATrick` 用十岁小孩能懂的话说"这不是把戏"；`hub.ts:58-61` 记着一次
   **因为报错信息太具体而说了假话**的事故。**这里的人对"错误长什么样"的在意程度，
   和对"功能是否工作"是一样的。**

---

## 13. 术语表

| 词 | 意思 |
|---|---|
| **Space** | Hugging Face 托管的网页应用。三种 SDK：`gradio` / `static` / `docker` |
| **SDK（Space 的）** | 见上。front-matter 里的 `sdk:` 那一行 |
| **front-matter** | README 开头 `---` 之间的那一段 YAML，Space 用它配置自己 |
| **rendezvous** | 那个"介绍所"服务：告诉双方对方在哪，并转发消息 |
| **peer envelope** | rendezvous 转发用的信封：`{type, sessionId, …其它原样转发}` |
| **relay / 中继** | 直连不通时的后备媒体通道。**这里就是被绕开的那个东西** |
| **NAT** | 家用路由器那个"外面连不进来"的机制 |
| **ICE / 候选 / candidate** | WebRTC 找路的过程和它找到的路 |
| **SDP** | WebRTC 的能力协商文档 |
| **DTLS** | WebRTC 的加密层 |
| **SCTP** | WebRTC 的数据通道底层。**和媒体走同一对候选** |
| **datachannel** | WebRTC 的数据通道，用来跑 JSON-RPC |
| **SSE** | Server-Sent Events，服务器推给浏览器的一条长连接 |
| **`POST /send`** | rendezvous 的发送端点 |
| **`GET /events`** | rendezvous 的接收流。**必须先开它** |
| **`sessionId`** | 一次会话的 id |
| **`sessionRejected`** | "别人占着这只机器人" |
| **`welcome`** | 流开好后服务发的第一条消息 |
| **429 / 401** | 限流 / 未认证。**见 §5.3：这里的 429 不是服务写的** |
| **`whoami-v2`** | Hugging Face 的"这个 token 是谁"接口 |
| **`SPACE_ID` / `SPACE_HOST`** | 平台注入的环境变量 |
| **`SYSTEM=spaces`** | Gradio 判断"我在不在 Space 上"的那个变量。**Docker Space 不给** |
| **`GRADIO_SSR_MODE`** | Gradio 的服务端渲染。**开着会去起一个 Node** |
| **SSR** | 服务端渲染 |
| **uid-1000 `user`** | 平台追加的层假定的那个用户 |
| **PKCE** | 一种 OAuth 流程，让浏览器证明是自己发起的，**因此不需要 client secret** |
| **client secret** | OAuth 里那个"必须保密"的东西。**这里没有** |
| **scope** | OAuth 申请的权限范围 |
| **`localStorage` / `sessionStorage`** | 浏览器里的两种存储，前者跨标签页 |
| **`EventSource`** | 浏览器原生的 SSE 客户端。**不能发自定义 header** |
| **CRLF** | `\r\n`。**SSE 允许它，代理可能改写它** |
| **WebSocket** | 双向长连接。鸭子的画面从这里上来 |
| **wss** | WebSocket over TLS |
| **`media.stream`** | 那个"请把画面发到这个地址"的调用（见 [`mediad-primer.md`](mediad-primer.md)） |
| **H.264** | 一种视频编码。**帧间预测，所以需要关键帧** |
| **关键帧 / keyframe** | 能独立解码的那一帧。**丢包后要等它** |
| **SPS / PPS** | H.264 的参数集，**每个关键帧前面要重复** |
| **JPEG** | 逐帧独立的编码。**贵，但一收到就能解** |
| **`videorate`** | GStreamer 里控制帧率的元件 |
| **OpenCV** | 图像处理库 |
| **`opencv-python-headless`** | 去掉 GUI 的版本，**但仍然链接 `libgl1`** |
| **FastAPI / uvicorn** | Python 的 web 框架 / 它的服务器 |
| **Gradio** | Hugging Face 的 UI 框架。**这里挂在 FastAPI 下面** |
| **`manifest.json`** | 策略仓库里描述"这个策略是什么"的文件 |
| **`API_VERSION`** | 机器人协议的版本号（见 [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md)） |
| **`homed`** | "鸭子已经站回起始姿态了"那个标志 |
| **把戏 / trick** | 页面上给人的说法。协议里叫 policy / skill |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| **`media.stream` 的机器人那一侧（姊妹篇）** | [`mediad-primer.md`](mediad-primer.md) |
| **那些 JSON-RPC 方法（姊妹篇）** | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| 同一个协议的本机版本（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| 远程访问的完整设计（relay / rendezvous / §5 / §6） | [`design/remote-access-design.md`](design/remote-access-design.md) |
| 怎么把它们推上去（姊妹篇） | [`scripts-primer.md`](scripts-primer.md) · [`deploy-primer.md`](deploy-primer.md) |
| 策略是怎么打包和发布的 | [`design/updater-design.md`](design/updater-design.md) |
| 鸭子那一侧的策略加载 | [`robotd-primer.md`](robotd-primer.md) · [`robotd-params-primer.md`](robotd-params-primer.md) |
| 键盘 / 手柄那条控制路径（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| 蓝牙门房（姊妹篇） | [`btd-primer.md`](btd-primer.md) |
| 摄像头是怎么 bring-up 的 | [`project/media-bringup.md`](project/media-bringup.md) |
| BLE 的线上契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| 控制核心：从读总线到写总线（姊妹篇） | [`duck-control-primer.md`](duck-control-primer.md) |
| 深度矩阵与障碍检测（姊妹篇） | [`duck-detect-primer.md`](duck-detect-primer.md) |
| 仿真的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| 笔记本上那个客户端（姊妹篇） | [`duckctl-primer.md`](duckctl-primer.md) |
| 更新时在这块板子上跑的那两个脚本（姊妹篇） | [`hooks-primer.md`](hooks-primer.md) |
| 关节角 → 空间中的点（姊妹篇） | [`kinematics-primer.md`](kinematics-primer.md) |
| 里程计与那张地图（姊妹篇） | [`odometry-primer.md`](odometry-primer.md) |
| 手柄自己的 IMU：姿态与零偏（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| 摸头检测：麦克风与那个分类器（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| 鸭子的嗓子：可播种的合成器（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| 头部的两个传感器：深度与 IMU（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
