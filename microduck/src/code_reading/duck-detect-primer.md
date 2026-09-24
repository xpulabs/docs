# `duck-detect` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> 感知的定位与帧路径由 [`design/architecture.md`](design/architecture.md) §2/§5.3 和
> [`project/npu-bringup.md`](project/npu-bringup.md)（NPU 的实录）拥有。
> 两者若有不一致，以设计文档为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：[`duck-control-primer.md`](duck-control-primer.md)（另一个也用神经网络的地方）。

## 目录

1. [一分钟版](#1-一分钟版)
2. [它在系统里的位置](#2-它在系统里的位置)
3. [三件事：letterbox → 运行时 → decode](#3-三件事letterbox--运行时--decode)
4. [目录导览](#4-目录导览)
5. [一次检测的完整旅程](#5-一次检测的完整旅程)
6. [两个后端：NPU 和 CPU](#6-两个后端npu-和-cpu)
7. [`decode`：那个"看起来几乎合理"的陷阱](#7-decode那个看起来几乎合理的陷阱)
8. [⚠️ 三个必须和训练一致的约定](#8-️-三个必须和训练一致的约定)
9. [手写的 ABI](#9-手写的-abi)
10. [`duck-bench`：怎么在真板上量](#10-duck-bench怎么在真板上量)
11. [测试](#11-测试)
12. [阅读路线](#12-阅读路线)
13. [术语表](#13-术语表)

---

## 1. 一分钟版

`duck-detect` 回答一个问题：**这台机器人的摄像头里，有没有别的 Microduck？**

模型在另一个仓库（[`duck_detector`](https://github.com/pollen-robotics/duck_detector)）训练，到这里是一个 **INT8 的 `.rknn`**：

```text
   一个类别 · 输入 320×320 · 输出 2100 个候选框
```

整个 crate 就是**一帧画面到一个边界框之间的三件事** —— 缩放填充、运行时、解码 —— 外加 `duck-bench`，一个在真板上量它们的小工具。

**⚠️ 它最容易出的故障不是崩溃，而是"悄悄变差"。** 模块头的原话：

> **这里的一切都必须和模型训练时一致**，而跨两个仓库**没有任何东西强制这一点**，
> 除了这段注释和下面那些数字。
>
> 弄错其中一条，检测器**不会失败** —— 它只是**悄悄地变差**，
> 而这正是这个 crate 最容易暴露的失败模式。

规模：**1144 行，5 个文件**。

---

## 2. 它在系统里的位置

```text
   摄像头 ──▸ mediad ──┬──▸ WebRTC（视频）
                       │
                       └──▸ 「raw tee 分支」──▸ duck-detect ──▸ 检测结果
                                                              │
                                                              ▼
                                                    mediad 的 detect.rs
                                                    （一个线程，2 Hz）
```

**消费者只有一个：`mediad`。** 而在 `mediad` 那边，它跑在一个**独立线程**上，理由值得记：

> **是线程，不是 task。** 推理是每帧 60 ms 的**阻塞**工作，
> 而这里的 tokio 运行时是在服务 WebRTC 信令的 ——
> 一个检测器占据了它十分之一秒里的一整个 worker，会让会话建立**毫无理由地卡顿**，
> 而且没人找得到原因。

### 2.1 ⚠️ 有两个"兄弟" crate 容易搞混

```text
   duck-detect   ← 检测器本身（带 NPU 和 ONNX 运行时）
   uyvy          ← 摄像头像素：安装转角 + UYVY 采样（**零依赖**）
```

**`uyvy` 是从 `duck-detect` 里抽出来的**，和 `duck-ble` 从 `btd` 抽出来是同一个故事。原话：

> 三个进程必须对"一帧摄像头画面长什么样"达成一致：`mediad` 要服务并编码它、
> `duck-detect` 要喂给模型、`robotctl monitor` 要在终端里画它。
> 这些算术原来住在 `duck-detect` 里，**而它的依赖树拖着 NPU 和 ONNX 运行时以及 `image` crate** ——
> **一个在恢复路径上的 CLI 绝不能链接那些东西。**
>
> 把四十行采样代码抄进 CLI 是另一个选项，而**一份已经被弄错过一次的旋转的第二份拷贝**，
> 正是"一张图在一个消费者里是正的、在另一个里是躺着的"的由来。

所以 `robotctl` 依赖 `uyvy`（零依赖），**刻意不依赖 `duck-detect`**。

---

## 3. 三件事：letterbox → 运行时 → decode

```text
   ┌────────────────────────────────────────────────────────────┐
   │  ① letterbox_rgb()   把任意尺寸的画面**缩放并填充**成 320×320│
   │                       填 114 灰；**不是拉伸**               │
   ├────────────────────────────────────────────────────────────┤
   │  ② rknn::Model 或 onnx::Model                              │
   │                       一个走 NPU，一个走 CPU                │
   │                       两边返回**同样布局**的原始输出        │
   ├────────────────────────────────────────────────────────────┤
   │  ③ decode()          2100 个候选 → 过滤 → 抑制重叠 → 映射回 │
   │                       原帧坐标                              │
   └────────────────────────────────────────────────────────────┘
```

**关键：第 ② 步的两个后端返回同样的东西**，所以第 ③ 步**不关心**是哪个产生的。

> `onnx.rs` 的 `infer` 注释原话："……和 NPU 路径返回的布局一样，
> 所以 `decode()` 不关心是哪一个产生的。"

---

## 4. 目录导览

```text
duck-detect/
├── Cargo.toml              28 行   依赖（注释解释了每个不显然的选择）
├── src/
│   ├── lib.rs             254 行   ★ letterbox + decode + Detection
│   ├── rknn.rs            462 行   ★ NPU 后端（**手写 ABI**）
│   ├── onnx.rs             92 行   CPU 后端
│   └── bin/duck-bench.rs  308 行   在真板上量它
```

**建议的阅读顺序：** `lib.rs` 的模块头 → `lib.rs` 的 `decode()` → `lib.rs` 的 `letterbox_rgb()` → `rknn.rs` → `onnx.rs` → `duck-bench.rs`。

---

## 5. 一次检测的完整旅程

```text
   ① mediad 从 raw tee 拿到一帧 UYVY（1280×720，而且是躺着的）
              │
   ② uyvy::letterbox_from_uyvy()
      · 边采样边转 90°（不是先转再采样）
      · 输出 320×320×3 的 RGB 字节
      · 记下 scale / pad_x / pad_y → 一个 Letterbox
              │
              ▼
   ③ rknn::Model::infer(&frame, &mut out)
      · rknn_inputs_set（uint8，NHWC）
      · rknn_run
      · rknn_outputs_get（**要浮点**，运行时自己反量化）
      · out = 2100 × 5 = 10500 个 f32
              │
              ▼
   ④ decode(&out, letterbox, threshold, iou_limit)
      · 读 score，低于阈值跳过
      · 解出 cx, cy, w, h（★ 注意是**平面布局**）
      · 反填充、反缩放 → 原帧坐标
      · 按 score 降序，NMS 抑制重叠
              │
              ▼
   ⑤ Vec<Detection>  →  mediad 广播出去
      · box_：[x0, y0, x1, y1] 像素
      · bearing()：-1 最左，0 正前，1 最右
```

### 5.1 `bearing()`：行为真正想要的那个数

```rust
/// 鸭子在画面的什么位置：−1 最左，0 正前，1 最右。
///
/// **一个行为真正想要的那一个数** —— "朝它转过去"需要一个方位角，不是一个框。
pub fn bearing(&self, frame_width: f32) -> f32
```

### 5.2 为什么用最近邻缩放

```rust
/// 故意用最近邻：这段代码每帧都要跑在一个 50 Hz 控制循环旁边，
/// 输入是一张模糊的 720×1280 的室内照片，
/// 而双线性缩放要花**三倍**的代价，只为把一个框挪动一个像素。
/// 如果将来有测量说精度值这个价，RGA 可以免费做。
```

---

## 6. 两个后端：NPU 和 CPU

### 6.1 为什么会有 CPU 后端

模块头说得非常直接：

> **RK3566 有 NPU，厂商内核有驱动 —— 而在这块板子上，设备树把 `npu@fde40000` 发成 `disabled`**，
> 而 Armbian 提供的唯一一个 overlay 是**进一步禁用它**的。
>
> **启用它是一个 overlay 加一次重启，那是关于"某个人的机器人"的决定，不是一个检测器的细节。**
> 所以在那之前，检测器跑在四个 A55 核上，而**改一个配置值就能搬到 NPU**。

而它不带来新依赖：

> ONNX Runtime **已经**在每一块 provisioned 过的板子上了（`setup-board.sh` 为 `robotd` 的策略装它），
> 而 `ort` 是 dlopen 它的。

### 6.2 CPU 后端的一个细节：只给两个线程

```rust
// **两个线程，不是四个。** 另外两个属于 `robotd` 的控制循环和 GStreamer；
// 一个为了看见 3 米外的鸭子就占满整个 SoC 的检测器，
// **拿走的东西比它给的多。**
.with_intra_threads(2)
```

而它自己做两件 NPU 那边由运行时做的事：**HWC → NCHW 的重排**，以及 **÷255 归一化**。

> NPU 那边不用做，因为 `.rknn` 里烘焙了 mean/std 和布局。

### 6.3 为什么 NPU 那边是 `dlopen`

`rknn.rs` 的模块头：

> **`dlopen`，不是链接。** `librknnrt.so` 是一个**厂商 blob**：
> 它不在任何 Debian 套件里、不在笔记本上、**也不需要用来*构建*** ——
> **一个链接了它的守护进程在 CI 里根本没法交叉编译。**
>
> `robotd` 用同样的方式够到 ONNX Runtime，理由也一样。
> **代价是这一个文件；好处是 `cargo board --bins` 在一台没有任何 Rockchip 东西的机器上照常工作。**

搜索路径是**四个候选**（`CANDIDATES`），因为"一块手工 provision 的板子仍然要能用"。

---

## 7. `decode`：那个"看起来几乎合理"的陷阱

### 7.1 ⭐ 输出张量是**平面**的，不是交错的

```text
   raw 有 2100 × 5 = 10500 个浮点。

   它长这样：    [cx₀ cx₁ … cx₂₀₉₉ | cy₀ … | w₀ … | h₀ … | score₀ … ]
                 └────── 全部 cx ──┘

   而不是这样：  [cx₀ cy₀ w₀ h₀ score₀ | cx₁ … ]
```

> 把它读成交错的，得到的是**几乎说得通的框** —— **这是最糟的一种错。**

有一个测试专门钉这件事（`the_head_is_planar_not_interleaved`），注释说：

> 读成"每个框五个数"会产出**几乎说得通的框** —— 最糟的一种错，
> **因为它看起来像一个坏模型，而不是一个坏的读取者。**

### 7.2 头部不抑制任何东西

```rust
/// **头部不做任何抑制。** 2100 个候选意味着**一只鸭子会变成二十个重叠的框**，
/// 而如果不处理，这个 crate 的**每一个**消费者都得知道这件事。
```

所以 `decode()` 做 NMS（非极大值抑制）：按 score 降序，逐个保留"和已保留的框重叠度 < `iou_limit`"的。

### 7.3 阈值是**这个模型**的属性

> 阈值是**这个**模型的属性，而且是**量化过的**：
> 一个 INT8 输出张量**自带 scale**，所以在浮点模型上意味着 0.9 的值，**在这里不是 0.9**。
> **拿板子去调它。**

（`deploy/robotd.toml` 里也写了同一件事：出厂模型的分数**不是概率** —— 每个真实检测都在 1.3 左右，别的什么都不读出来，因为输出张量和框坐标**共用一个量化 scale**。所以它是**一个是/否的阈值，不是一个旋钮**。）

---

## 8. ⚠️ 三个必须和训练一致的约定

`lib.rs` 的模块头列了三条，而且**没有任何东西跨两个仓库强制它们**：

```text
   ① 画面是**填充（letterbox）**成正方形的，不是拉伸；用 **114 灰**填充
   ② **RGB，不是 BGR**
   ③ 送进去的是 `mediad` **已经转正过**的那张图（`--rotate`，默认 90°），
      因为数据集就是透过那个朝向拍的
```

> **弄错其中一条，检测器不会失败 —— 它只是悄悄地变差。**

**第 ③ 条解释了一个看起来奇怪的设计**：为什么 `duck-detect` **不自己转画面**？

因为它拿到的已经不是原始帧 —— 它走的是 `mediad` 的 tee，而那张图**已经是转正的**。这是刻意的：见第 2.1 节，转角的算术在 `uyvy` 里，**而且是在采样的同一次循环里做的**。

> `uyvy` 的 `Turn` 文档讲了这个决定为什么是性能决定而不是审美：
> 管线里曾经用 GStreamer 的 `videoflip` 转过，**代价是 145% 的一个核** ——
> `mpph264enc` 本来免费把 UYVY→NV12 交给 SoC 的 2D 引擎，
> 而 flip 的 buffer 是 RGA **拒绝**的（`RGA_BLIT fail: Bad address`），
> 于是 MPP 退回软件转换每一帧：**97 °C、CPU 降到 408 MHz、30 fps 的摄像头出 8 fps。**
>
> 而采样器**本来就在重采样到 320×320**，所以**在同一次循环里转角一分钱都不花**。

### 8.1 `PAD = 114` 的来历

```rust
/// ultralytics 给 letterbox 填充用的灰色，**因此也是标定和训练看到的那种灰**。
pub const PAD: u8 = 114;
```

---

## 9. 手写的 ABI

`rknn.rs` 是这个 crate 里最长、也最"底层"的部分。它把 Rockchip 的 C 头文件**逐字段转写**成 Rust：

```rust
#[repr(C)]
struct RknnTensorAttr {
    index: c_uint, n_dims: c_uint, dims: [c_uint; 16],
    name: [c_char; 256], n_elems: c_uint, size: c_uint,
    fmt: c_uint, type_: c_uint, qnt_type: c_uint,
    fl: i8, zp: i32, scale: f32, w_stride: c_uint, …
}
```

### 9.1 为什么这很危险，以及怎么防

> **`rknn_query` 用固定大小的结构体回答，而它们的布局*就是* ABI。**
> 它们被逐字段复现在下面；**一个错位是静默的胡说，而不是一个错误** ——
> 这就是为什么**尺寸（和偏移）在启动时就断言，而不是被信任**。

测试断言的不是总大小，**而是偏移**：

```rust
// **偏移，不只是总大小。** 两个字段互换会保持总大小却改变含义，
// 而这条边界的另一边是一个本地没有任何编译器能检查的 blob。
// 这些数字是手数出来的 `rknn_tensor_attr` 的 C 布局：
//   index 0, n_dims 4, dims[16] 8..72, name[256] 72..328, n_elems 328, …
assert_eq!(std::mem::offset_of!(RknnTensorAttr, dims), 8);
assert_eq!(std::mem::offset_of!(RknnTensorAttr, zp), 352);
assert_eq!(std::mem::offset_of!(RknnTensorAttr, scale), 356);
assert_eq!(std::mem::size_of::<RknnTensorAttr>(), 376);
```

> 测试注释：**"这不是厂商头文件的替代品 —— 它是一根绊线，
> 用来绊住一次把字段加错位置的编辑，而这里没有任何编译器能抓到它，
> 因为这条边界的另一边是一个没人链接的 blob。"**

### 9.2 两个"猜错了会静默出事"的地方

**一、`RKNN_QUERY_*` 的编号顺序就是 ABI。**

```rust
/// **顺序就是 ABI。** 它们曾经被猜过一次，输入和输出换了个位，
/// 而症状是 `rknn_query(INPUT_ATTR)` 拿着**输出**张量回答 ——
/// "cannot make sense of the input shape [1, 5, 2100]"，
> 一个**针对错误问题的、完全合理的抱怨**。
```

**二、NCHW 是 0、NHWC 是 1 —— 弄反不会失败。**

```rust
/// 值得强调，因为弄反**不会失败**。运行时会记一行
/// "Meet unsupported src layout for normalize: NCHW, only support NHWC src layout" ——
/// 然后 `rknn_inputs_set` **照样返回成功**，
/// 于是推理跑在输入缓冲区里随便什么内容上，而检测器**每一帧都报恰好两个自信的框，永远如此**。
/// 从外面看，"每帧两个一模一样的检测"就是那个样子。
```

### 9.3 反量化交给运行时的理由

```rust
want_float: 1,   // ← **由运行时反量化**
```

> 一个量化模型的输出是 **int8 加上一个 scale 和 zero point**；
> 在这里要浮点，就把那套算术**留在一个地方 —— 厂商的**，
> 而不是留在一个"会弄错一次、然后被相信"的解码器里。

### 9.4 `rknn_init` 失败时说什么

`why_init_failed()` **先查设备树**，理由写得很实在：

> **设备树排第一，因为那是每块板子起步时的状态。**
> Armbian 把 `npu@fde40000` 发成 `status = "disabled"`，
> 所以一台没人跑过 `setup-npu.sh` 的机器人**有硬件、有内核、有驱动、有运行时，而仍然没有 NPU** ——
> 而运行时自己那行日志是 *"failed to open rknpu module, need to insmod rknpu dirver!"*，
> 它把人送去**找一个已经编进内核的模块**。

于是三档诊断：设备树里禁用了（告诉你跑哪个脚本）→ 设备树里根本没有这个节点（内核不是 Armbian 那个）→ 节点是启用的（那就是模型或驱动）。

---

## 10. `duck-bench`：怎么在真板上量

```bash
sudo duck-bench --model duck.rknn --frames /var/tmp/frames
```

它按**重要性排序**回答三个问题：

```text
   ① 它能跑吗？       运行时加载不了、模型是给别的平台构建的、
                      驱动比运行时老 —— 都**在这里**失败，而不是在一个守护进程里。

   ② 它还看得见鸭子吗？**量化正是检测器停止工作的地方**，
                      而一个"能跑但什么都检测不到"的模型
                      **看起来和一个能工作的模型一模一样**。
                      所以它报的是**每帧检测数**，不只是毫秒。

   ③ 它的代价是多少？  延迟分位数，**以及这个进程烧掉的 CPU** ——
                      因为把它放上 NPU 的理由就是别打扰 `robotd` 的 50 Hz 循环，
                      而"NPU 在做"是一个**要检查而不是假定**的说法。
```

### 10.1 两个"不是礼貌"的默认值

**⚠️ 默认按 2 Hz 限速，而这不是客气：**

> **全速跑，它把一块 Radxa Zero 3 带到 95 °C、CPU 降到 408 MHz** ——
> 所以一次全速运行报出的数字，是**一块已经太热、给不出这些数字的板子**的数字。
> 2 Hz 是检测器实际会跑的频率。`--hz 0` 取消限速，用于在一块有风扇或散热片的板子上找天花板。

**它读 JPEG，而不是打开摄像头：**

> 因为 `mediad` 占着摄像头，而一次采集会话出来的帧**本来就是对的东西**，
> 而且**一个必须先停掉守护进程的基准测试，是一个没人会跑第二次的基准测试。**

### 10.2 实测数字（来自 [`project/npu-bringup.md`](project/npu-bringup.md)）

板上 2 Hz、30 帧 3 轮：

| | 实测 | 备注 |
|---|---|---|
| 驱动 / 运行时 | 0.9.8 / 2.3.2 | `setup-npu.sh` 会打印两个 |
| 延迟 p50 / p95 | **25.7 ms / 58.4 ms** | 推理 + 解码，不含 JPEG 解码 |
| 每帧 CPU | 20.7 ms | **见下 —— 这不全是推理** |
| SoC 温度 | 63 °C | 一次限速运行结束时 |

而那份文档对 CPU 那个数字有一个**很诚实的说明**，值得抄下来：

> **那个 CPU 数字不是 NPU 的代价，而它的报法会诱使人那样读它。**
> 延迟那一列计的是 `infer` + `decode`；CPU 那一列是**整个循环**的进程 CPU 除以帧数，
> 所以它**还捎带了 `letterbox_rgb`** —— 一次 1280×720 → 320×320 的重采样，
> **跑在 CPU 上，而且完全不在延迟里**。
> 剩下那部分是不是 `rknn_run` 在忙等（把等 NPU 的时间算到 CPU 头上）**目前还不知道**。
> 2 Hz 下无论如何是 4% 的一个核；**但在有人把它当成"感知的代价"引用之前，这两者应该分开量。**

### 10.3 模型的来头

同那份文档：`yolo11n` 320×320，一个类别，三个会话的 150 帧，
**留出会话上 mAP50 0.976**，INT8 量化后 **3.9 MB**，
在桌上对浮点模型保持了 **2/2 个检测、95% 框重叠**。

---

## 11. 测试

**只有 6 个测试** —— `lib.rs` 4 个、`rknn.rs` 2 个。

这个数字小得值得说明一下：**这个 crate 的大部分逻辑是几何和 ABI，而两者都是"要么对要么错、错了就静默"的东西**。所以它不是靠测试数量取胜，而是靠**测试挑得准**：四个钉住解码的几何，两个钉住那条**本地没有任何编译器能检查的边界**。

全部在笔记本上跑 —— **不需要 NPU、不需要模型、不需要板子**。

### 11.1 `lib.rs` 的四个：几何

```text
   a_portrait_frame_is_padded_left_and_right     ← 竖构图是**唯一实际发生**的情况
   the_head_is_planar_not_interleaved            ← ★ 第 7.1 节那个陷阱
   overlapping_candidates_collapse_and_map_back_to_the_frame
   two_ducks_stay_two
```

第一个的注释说明了为什么它重要：

> 摄像头在守护进程转了四分之一圈之后是**竖的 —— 720×1280**，
> 所以这是**唯一真正发生**的情况，而**填充弄错会让每一个框偏移一个常数**，
> 谁都不会注意到，**直到机器人伸手去够一只不在那里的鸭子**。

### 11.2 `rknn.rs` 的两个

```text
   the_query_structs_are_laid_out_as_the_abi_says   ← 第 9.1 节
   a_missing_runtime_names_the_setup_script
```

第二个测的是：**一个缺失的运行时必须说出该跑什么，而不是 "cannot open shared object file"**。

---

## 12. 阅读路线

**第 1 步（20 分钟）**

1. 读 `lib.rs` 的模块头（前 22 行）—— 它把"三件事"和"三个约定"说完了。
2. 读 [`project/npu-bringup.md`](project/npu-bringup.md)（182 行）——
   NPU 那件事的**实录**，包括实测数字和一个很诚实的"这份文档哪里还没说清"。

**第 2 步 —— 几何（40 分钟）**

3. 读 `lib.rs` 的 `letterbox_rgb()`（`:65`）和 `Detection`（`:36`）。
4. 读 `lib.rs` 的 `decode()`（`:105`）—— **第 7.1 节那个陷阱**。
5. 读 `uyvy/src/lib.rs` 的模块头和 `Turn`（`:35`）—— 为什么转角在采样里做。

**第 3 步 —— 运行时（1 小时）**

6. 读 `onnx.rs` **全文**（92 行）—— 简单的那一半，先读。
7. 读 `rknn.rs` 的模块头 + `CANDIDATES` + `RKNN_QUERY_*` 常量。
8. 读 `rknn.rs` 的 `Model::open()`（`:182`）和 `infer()`（`:336`）。
9. 读 `rknn.rs` 的 `why_init_failed()`（`:161`）—— 三档诊断。

**第 4 步 —— 看它怎么被用（30 分钟）**

10. 读 `mediad/src/detect.rs` 的模块头（前 15 行）—— 消费者那边。
11. 读 `duck-bench.rs` 的模块头（前 20 行）。

**第 5 步 —— 动手**

```bash
cargo test -p duck-detect        # 20 个测试，不需要 NPU

# 在真板上量（需要一块有 NPU 的板子）
sudo duck-bench --model duck.rknn --frames /var/tmp/frames --verbose
```

试试自己喂一个"两个候选"的平面张量给 `decode()`：

```rust
use duck_detect::{decode, Letterbox};

// frame: 2 个候选。平面布局：[cx₀ cx₁ | cy₀ cy₁ | w₀ w₁ | h₀ h₁ | score₀ score₁]
let raw = vec![10.0, 100.0, 20.0, 200.0, 4.0, 40.0, 6.0, 60.0, 0.9, 0.1];
let identity = Letterbox { scale: 1.0, pad_x: 0.0, pad_y: 0.0 };

let found = decode(&raw, identity, 0.5, 0.5);
assert_eq!(found.len(), 1);              // 只有第一个过 0.5
assert_eq!(found[0].box_, [8.0, 17.0, 12.0, 23.0]);
```

**然后把那个 `raw` 按交错布局重读一遍** —— 你会得到"几乎说得通"的框，这就是第 7.1 节那个陷阱的手感。

---

## 13. 术语表

| 术语 | 意思 |
|---|---|
| **NPU** | 神经网络专用处理器。RK3566 上那个是 0.8 TOPS、单核 |
| **RKNN** | Rockchip 的神经网络格式和运行时（`librknnrt.so`） |
| **ONNX** | 通用的神经网络交换格式。CPU 后端用它 |
| **INT8 量化** | 把模型权重从浮点压成 8 位整数。**小四倍，但精度要重新确认** |
| **反量化 / dequantise** | 把 int8 输出变回浮点。需要 model 自带的 scale 和 zero point |
| **letterbox** | 等比缩放 + 填充成正方形。**不是拉伸** |
| **`PAD = 114`** | ultralytics 用的那种灰，所以也是训练时看到的那种灰 |
| **NHWC / NCHW** | 张量的两种内存布局。**弄反不会报错** |
| **planar / 平面布局** | 所有 cx 放一起、所有 cy 放一起……而不是每个框五个数挨着 |
| **stride** | 每个候选占几个数（这里是 5：cx, cy, w, h, score） |
| **NMS** | 非极大值抑制：一堆重叠的框里只留最好的那个 |
| **IoU** | 两个框的重叠度。NMS 用它判断"这两个是不是同一只鸭子" |
| **confidence / 置信度** | 模型对"这里有个东西"的把握。**量化的模型上它不是概率** |
| **mAP50** | 一种目标检测的精度指标 |
| **bearing** | 方位角。"朝它转过去"需要的那个数 |
| **dlopen** | 运行时才去找库，而不是链接它。好处是构建时不要求它存在 |
| **ABI** | 二进制层面的接口约定：结构体的字段顺序、大小、对齐 |
| **`#[repr(C)]`** | 告诉 Rust"按 C 的规则布局这个结构体" |
| **`offset_of!`** | 编译期取一个字段的字节偏移 |
| **blob** | 一个不透明、没有源代码的二进制（这里指厂商的运行时） |
| **设备树 / device tree** | Linux 上描述硬件的那个数据结构。**NPU 在这里可能是被禁用的** |
| **overlay** | 在设备树上叠一层修改。启用 NPU 就是一次 overlay + 重启 |
| **tee** | GStreamer 里把一个流分叉成多路的东西 |
| **UYVY** | 一种摄像头像素格式 |
| **RGA** | Rockchip 的 2D 加速器 |
| **thermally paced / 限速** | 故意跑慢，免得把板子烧到降频 |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| NPU 那件事的实录（含实测数字） | [`project/npu-bringup.md`](project/npu-bringup.md) |
| 感知应该在哪里、帧路径是什么 | [`design/architecture.md`](design/architecture.md) §2 · §5.3 |
| 检测器怎么被 `mediad` 用起来 | [`design/remote-webrtc.md`](design/remote-webrtc.md) |
| `[duck_detector]` 那些配置键 | [`robotd-params-primer.md`](robotd-params-primer.md) |
| 摄像头像素那件事（`uyvy`） | [`design/media-bringup.md`](project/media-bringup.md) |
| 控制核心：另一个用神经网络的地方（姊妹篇） | [`duck-control-primer.md`](duck-control-primer.md) |
| 控制循环本身（姊妹篇） | [`robotd-primer.md`](robotd-primer.md) |
| BLE 的线上契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| 蓝牙门房：手机怎么连上机器人（姊妹篇） | [`btd-primer.md`](btd-primer.md) |
| wifi、身份、手柄配对（姊妹篇） | [`configd-primer.md`](configd-primer.md) |
| 仿真的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| 所有服务与客户端的公共契约（姊妹篇） | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| 笔记本上的客户端（姊妹篇） | [`duckctl-primer.md`](duckctl-primer.md) |
| 发布怎么把自己装到板子上（姊妹篇） | [`hooks-primer.md`](hooks-primer.md) |
| 板子被配置成什么样子（姊妹篇） | [`deploy-primer.md`](deploy-primer.md) |
| 鸭子的身体几何：正/逆运动学、ToF 重投影（姊妹篇） | [`kinematics-primer.md`](kinematics-primer.md) |
| 检测器跑在谁的管线上（姊妹篇） | [`mediad-primer.md`](mediad-primer.md) |
| 机器人走到哪了：接触式里程计（姊妹篇） | [`odometry-primer.md`](odometry-primer.md) |
| 手柄自己的 IMU：姿态、零偏、yaw 漂移（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| 手柄：按键映射、模式、那个 raw tap（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| 另一个检测器：听声音而不是看图像（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| `robotctl duck-detector`（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| 装机、更新、诊断的那些工具（姊妹篇） | [`scripts-primer.md`](scripts-primer.md) |
| 鸭子的嗓子：可播种的合成器（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 头部的两个传感器：深度与 IMU（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
