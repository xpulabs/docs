# `uyvy/` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> 这个目录是**摄像头像素的公共算术**：一个 crate，两个文件，**351 行，零依赖**。
> 摄像头的格式和流水线由 [`mediad-primer.md`](mediad-primer.md) 拥有；
> 检测模型要什么样的输入由 [`duck-detect-primer.md`](duck-detect-primer.md) 拥有；
> 为什么 `robotctl` 不能链接重依赖，由 [`robotctl-primer.md`](robotctl-primer.md) 拥有。
> 若本导读与代码不一致，以代码为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：[`mediad-primer.md`](mediad-primer.md)（最大的那个消费者）、
> [`duck-detect-primer.md`](duck-detect-primer.md)（借用它的两个类型）、
> [`robotctl-primer.md`](robotctl-primer.md)（**必须能链接它**的那个）、
> [`kinematics-primer.md`](kinematics-primer.md)（**同一个模式的第一个实例**）。

## 目录

1. [一分钟版](#1-一分钟版)
2. [⚠️ 先理清：UYVY 是一个像素格式](#2-️-先理清uyvy-是一个像素格式)
3. [⭐ 核心心智模型：边走边转](#3--核心心智模型边走边转)
4. [目录地图](#4-目录地图)
5. [那三样东西](#5-那三样东西)
6. [那两个函数](#6-那两个函数)
7. [⭐ 为什么它值得单独一个 crate](#7--为什么它值得单独一个-crate)
8. [三个消费者](#8-三个消费者)
9. [几处读者会绊到的地方](#9-几处读者会绊到的地方)
10. [阅读路线](#10-阅读路线)
11. [术语表](#11-术语表)

---

## 1. 一分钟版

`uyvy/` 回答一个问题：

> **摄像头交给你的那串字节，怎么变成一张"正着的、能用的"图？**

摄像头在头部，**装歪了四分之一圈**，所以每一个拿到帧的东西都要先做两件事：
**把它转正，然后缩到它真正想要的尺寸。**

`uyvy/` 就是**那两件事的唯一一份实现**：

```
   摄像头 ──UYVY 1280×720──►
                              │
                              ▼
                    uyvy::Turn + 采样
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
           mediad         duck-detect    robotctl monitor
        （编码 JPEG）    （喂给模型）     （画在终端里）
```

而整个 crate 只有 **351 行**、**零依赖**，其中一半是测试和注释。

**如果只记一句话**：*"转"不是一趟独立的处理，而是**采样那个循环里的一次下标变换***。

---

## 2. ⚠️ 先理清：UYVY 是一个像素格式

**UYVY** 是一种 **YUV 4:2:2** 的排布方式。四个字节一组，覆盖**两个**像素：

```
   字节:   [  U  ][ Y0 ][  V  ][ Y1  ]
            └─┬─┘   │    └─┬─┘   │
              │     │      │     └── 像素 1 的亮度
              │     └──────┼──────── 像素 0 的亮度
              └────────────┴──────── 两个像素**共用**的色度
```

两个关键点：

| # | 事实 | 后果 |
|---|---|---|
| **①** | **亮度每个像素一个，色度每两个像素一个** | 一个像素的色度要去**它所在的那一"对"**里找 |
| **②** | **一行 1280 个像素 = 2560 字节** | 所以 `stride = width * 2`（`lib.rs:115`） |

人眼对亮度敏感、对色度不敏感 —— 这就是为什么视频都这么存。
代价是：**要拿到一个像素的完整颜色，你得先算清楚它落在哪一对里。**

而 `lib.rs:130-134` 那三行就是这件事：

```rust
let pair = row + (source_x / 2) * 4;
// U Y0 V Y1: the luma is the odd byte of the half this pixel falls in.
let luma = uyvy[pair + 1 + 2 * (source_x & 1)] as i32 - 16;
let u = uyvy[pair] as i32 - 128;
let v = uyvy[pair + 2] as i32 - 128;
```

**`source_x & 1` 就是在问"这个像素是这一对里的第一个还是第二个"** ——
是第一个就取 `pair+1`，是第二个就取 `pair+3`。

### 2.1 那个 `- 16` 和 `- 128`

这是 **BT.601 limited range（有限范围）**：

```
   Y: 16 … 235     不是 0 … 255
   U/V: 16 … 240   以 128 为中心，不是 0 为中心
```

所以先减掉偏置，再做矩阵乘法（`lib.rs:136-140`）：

```rust
// BT.601 limited range in fixed point — the ISP's convention, and the one every JPEG
// the dataset was labelled from went through. Integer because this is the inner loop.
let r = (298 * luma + 409 * v + 128) >> 8;
let g = (298 * luma - 100 * u - 208 * v + 128) >> 8;
let b = (298 * luma + 516 * u + 128) >> 8;
```

**"ISP 的约定，也是数据集被标注时经过的每一个 JPEG 的约定。"**

`>> 8` 是除以 256（用整数代替浮点），`+ 128` 是四舍五入。
而**为什么是整数**：*"因为这是内层循环。"*

---

## 3. ⭐ 核心心智模型：边走边转

这是整个 crate 唯一的设计思想，而它写在 `lib.rs:10-13`：

> **The turn happens while sampling, not before it.** Both samplers walk their *output* and pull
> the source pixel each one needs, so **the rotation is a change of index inside a loop that was
> already running rather than a pass of its own.**

**"旋转是一个本来就在跑的循环里的一次下标变换，而不是它自己的一趟处理。"**

```
   ❌ 两趟：先转正，再缩小
      921,600 个像素 ──► 转 ──► 921,600 个像素 ──► 缩 ──► 102,400 个像素
                                                            （丢掉 89%）

   ✅ 一趟：遍历**输出**，每个输出像素直接去源头取它要的那一个
      102,400 个像素 ──► 每个都从源里取一次
```

`lib.rs:102-105` 说明了坐标系的选择：

```rust
// Everything below is in *upright* coordinates — the picture the right way up, which is what
// the model was trained on and what a detection has to be reported in. The turn is undone only
// at the moment a source pixel is fetched.
```

**"下面的一切都在*正着的*坐标系里 —— 转只在取源像素的那一刻被撤销。"**

而"撤销"就是那一个函数（`lib.rs:68`）：

```rust
/// Where a pixel of the *upright* picture is in the frame the camera took.
///
/// The inverse mapping, because the sampler walks the output and pulls from the input. Written
/// as one function so the four cases are in one place rather than spread through a loop.
fn source(self, ux: usize, uy: usize, width: usize, height: usize) -> (usize, usize)
```

**"逆映射，因为采样器遍历的是输出、拉取的是输入。"**

---

## 4. 目录地图

```
uyvy/
├── Cargo.toml    17 行   ← `[dependencies]` 是**空的**，而那是重点
└── src/lib.rs   351 行   ← 全部内容
```

**整个 crate 就这么大。** `lib.rs` 的构成：

| 行 | 是什么 |
|---|---|
| `:1-13` | 模块文档：为什么存在、为什么转在采样里 |
| `:15-16` | `PAD` —— 那个 114 |
| `:18-24` | `Letterbox` —— 怎么把检测框映射回去 |
| `:26-81` | `Turn` —— 四个方向 + 那个逆映射 |
| `:83-154` | `letterbox_from_uyvy` —— 给模型的（正方形、带填充） |
| `:156-220` | `rgb_from_uyvy` —— 给人的/给别的模型的（保持比例、不填充） |
| `:222-351` | **7 个测试**，占了全文件 37% |

---

## 5. 那三样东西

### 5.1 `PAD = 114`

`lib.rs:15-16`：

```rust
/// The grey ultralytics pads a letterbox with, and therefore what calibration and training saw.
pub const PAD: u8 = 114;
```

**一个写死的数字，而它必须和训练那边一致** ——
否则模型看到的填充色和它学会的填充色不一样，而*那不会让它报错，只会让它悄悄变差*。

### 5.2 `Letterbox`：怎么把框映射回去

`lib.rs:18-24`：

```rust
/// How a frame was fitted into the model's square, so detections can be mapped back out of it.
pub struct Letterbox {
    pub scale: f32,
    pub pad_x: f32,
    pub pad_y: f32,
}
```

**模型在 320×320 的方图里给出框，而你要的是原图里的坐标** ——
所以缩小比例和两边的填充量必须一路带出去。三个数，一个都不能少。

### 5.3 `Turn`：四个方向，一个逆变换

`lib.rs:34-42`：

```rust
pub enum Turn {
    #[default]
    None,
    /// A quarter turn clockwise: what this robot's camera mount needs.
    Right,
    Half,
    Left,
}
```

而逆映射的四行（`lib.rs:69-79`）值得逐行看：

```rust
match self {
    Self::None => (ux, uy),
    // A quarter turn clockwise sends source (x, y) to upright (h-1-y, x), so the inverse
    // takes upright (ux, uy) from source (uy, h-1-ux).
    Self::Right => (uy, height.saturating_sub(1).saturating_sub(ux)),
    Self::Half => (
        width.saturating_sub(1).saturating_sub(ux),
        height.saturating_sub(1).saturating_sub(uy),
    ),
    Self::Left => (width.saturating_sub(1).saturating_sub(uy), ux),
}
```

**注释把正变换和逆变换都写下来了**，因为这是最容易搞反的地方 ——
而这个函数**故意做成一个函数而不是散在循环里**：
*"这样四种情况就在一个地方，而不是散在一个循环里。"*

而 `saturating_sub` 而不是 `-`：**一个为 0 的尺寸不该 panic。**

`Turn` 还有第三个方法（`lib.rs:56-62`）：

```rust
/// The frame's size once turned — a quarter turn swaps the axes.
pub fn upright(self, width: usize, height: usize) -> (usize, usize)
```

**四分之一圈会交换长宽** —— 1280×720 变成 720×1280。
这是一件**每个调用者都必须知道、而且很容易忘**的事，
所以它也是这个 crate 提供的。

---

## 6. 那两个函数

它们几乎一样，**而差别就是它们都存在的原因**。

| | `letterbox_from_uyvy`（`:94`） | `rgb_from_uyvy`（`:172`） |
|---|---|---|
| **给谁** | **模型** | **人或别的程序看** |
| **输出形状** | **正方形**，`size × size` | **保持长宽比**，不填充 |
| **填充** | `PAD`（114 灰） | 无 |
| **缩放** | 塞进正方形 | **按最长边**，且**只缩不放** |
| **返回** | `Letterbox`（映射回原图用） | `(宽, 高)`（因为四分之一圈会交换它们） |

`lib.rs:156-160` 说了为什么需要第二个：

> [`letterbox_from_uyvy`] above is for the model: a square, padded, at whatever size the network
> wants. This is for a *person or a program looking at the picture* — **a JPEG on its way to a
> Space that runs a model of its own** — so **it keeps the aspect ratio and pads nothing.**

### 6.1 ⭐ 那个"只缩不放"

`lib.rs:181-183`：

```rust
// Downscale only. Asking for a box bigger than the sensor would interpolate detail that was
// never captured and cost the bandwidth of pretending.
let scale = (longest as f32 / upright_w.max(upright_h) as f32).min(1.0);
```

**"要求一个比传感器还大的框，会插值出从没被捕捉到的细节，并且付出'假装'的带宽。"**

而 `.min(1.0)` 就是那条规则本身。它有测试（`lib.rs:253-260`）：

```rust
/// Never upscales: a box larger than the sensor would interpolate detail nobody captured.
#[test]
fn the_rgb_scaler_only_ever_shrinks() {
    assert_eq!(rgb_from_uyvy(&uyvy, 8, 4, 64, Turn::None, &mut out), (8, 4));
    assert_eq!(rgb_from_uyvy(&uyvy, 8, 4, 4, Turn::None, &mut out), (4, 2));
}
```

### 6.2 ⭐ 一帧短了怎么办

两个函数里各有一段一样的处理（`lib.rs:125-129` 和 `:196-201`）：

```rust
let row = source_y * stride;
if row + stride > uyvy.len() {
    // A frame that arrives mid-teardown is short. What is missing stays padding rather
    // than taking the daemon down over a picture.
    continue;
}
```

**"一个在拆卸中途到达的帧是短的。缺的部分保持填充，而不是因为一张图把守护进程干掉。"**

**注意它是 `continue` 而不是 `break`** —— 剩下的行照样走完，
所以**输出缓冲区的长度永远是对的**，只是缺的那些位置保持初始值（填充色或黑色）。

### 6.3 最近邻，而且色度不插值

`lib.rs:91-93`：

> **Nearest-neighbour, and chroma from the pair without interpolation**: the input is **a blurred
> photograph of a room being downscaled by four**, and **nothing in a bounding box survives at that
> precision.**

**"输入是一张被缩小四倍的、模糊的房间照片，而在那个精度上，一个边界框里的东西什么都剩不下。"**

`duck-detect` 那边用同一句话给了同一个判断，还多一句成本（`duck-detect/src/lib.rs:61-64`）：

> Nearest-neighbour on purpose: this runs per frame beside a 50 Hz control loop, the input is a
> blurred 720×1280 photograph of a room, and **a bilinear resize costs three times as much to move
> a box by a pixel.**

---

## 7. ⭐ 为什么它值得单独一个 crate

`Cargo.toml:9` 只有一句：

> **No dependencies, and that is the point of the crate existing.**

而它下面那段解释了**为什么零依赖是承重的**（`Cargo.toml:11-16`）：

> Three processes have to agree about what a camera frame looks like: `mediad` serves and encodes
> one, `duck-detect` feeds one to a model, and `robotctl monitor` draws one in a terminal.
> **The arithmetic lived in `duck-detect`, whose manifest drags the NPU and ONNX runtimes and the
> `image` crate — a tree a CLI on the recovery path must not link.** Copying forty lines of sampler
> into the CLI was the alternative, and **a second copy of a rotation that has already been got
> wrong once is how a picture ends up sideways in one consumer and upright in the other.**

**"这份算术原来住在 `duck-detect` 里，而它的依赖树拖着 NPU 和 ONNX 运行时 ——
一棵处于恢复路径上的 CLI 绝不能链接的树。"**

**"而一份已经搞错过一次的旋转的第二个副本，就是一张图在一个消费者那里横着、
在另一个消费者那里正着的方式。"**

### 7.1 这是**同一个模式的第二个实例**

`robotctl/Cargo.toml:27-34` 把两件事写在了一起，而它们形状完全一样：

```toml
# Pure geometry (the ToF reprojection the monitor overlays) — deliberately NOT the `tof`
# crate, whose vendored C driver would drag a cross C toolchain into every robotctl build.
kinematics = { path = "../kinematics" }
# The camera's pixels, for `monitor`'s camera block: the mount turn and the UYVY sampler, shared
# with `mediad` and `duck-detect`. Deliberately NOT `duck-detect` itself, for the reason above —
# that crate carries the NPU and ONNX runtimes, and this one has no dependencies at all.
uyvy = { path = "../uyvy" }
```

| | 不链接 | 因为 | 链接 |
|---|---|---|---|
| **几何** | `tof` | vendor 的 C 驱动会拖进一整套交叉编译工具链 | `kinematics` |
| **像素** | `duck-detect` | NPU 和 ONNX 运行时 | **`uyvy`** |

**"处于恢复路径上的 CLI 绝不能链接"** —— 这条规则在 [`robotctl-primer.md`](robotctl-primer.md) 里展开了；
而 `uyvy` 和 `kinematics` 是它在代码里的两次落地。

**一条规则，两处把纯算术抽成叶子 crate。** 这是这个仓库里最值得学的一种重构：
**当你发现"我需要 A 的一小部分，但 A 拖着一棵大树"时，把那部分抽出来，而不是复制它。**

### 7.2 那次抽取只用了**一个 commit**

```
a7728e5  uyvy: the camera's pixels move out of duck-detect, which nothing else can link
```

一次干净的抽取：`duck-detect` 那边留下 `pub use uyvy::{Letterbox, PAD};`（`duck-detect/src/lib.rs:29`），
并附上一句关于为什么**不**把采样器也 re-export 的话（`:26-28`）：

> Its own signatures speak in these: `letterbox_rgb` returns a `Letterbox` and `decode` takes one
> back. **The samplers themselves are not re-exported — a consumer that wants pixels wants
> `uyvy`, not a second name for it here.**

**"一个想要像素的消费者想要的是 `uyvy`，而不是在这里的第二个名字。"**

---

## 8. 三个消费者

### 8.1 `mediad`：编码 JPEG

`mediad/src/stream.rs:636` —— 这个 crate 最大的用户，**每帧一次**：

```rust
let (width, height) = uyvy::rgb_from_uyvy(
    &frame.data,
    frame.width as usize,
    frame.height as usize,
    config.longest as usize,
    turn,
    rgb,
);
```

而它复用缓冲区，理由写在 `mediad/src/stream.rs:616-618`：

> Reused across frames: **at 640×480 the RGB buffer is 920 KB, and allocating that five times a
> second forever is a page fault storm for no reason.**

**"一秒五次、永远如此地分配它，是一场毫无理由的缺页风暴。"**

而 `mediad/src/main.rs:274-276` 说明了那个角度是从哪来的：

```rust
// The same angle the detector needs, in its own vocabulary: it folds the turn into the
// resampling it already does, which is why nothing in the pipeline has to.
let turn = match uyvy::Turn::from_degrees(rotate) {
```

**"它把旋转折进它本来就在做的重采样里，所以流水线里没有任何东西需要做这件事。"**

### 8.2 `robotctl monitor`：画在终端里

`robotctl/src/camera.rs:157` —— 和 `mediad` 调同一个函数，但**自己算出那个 `longest`**，
因为终端的块和它不一样（`robotctl/src/camera.rs:149-153`）：

```rust
// `rgb_from_uyvy` fits a box by its longest edge, so the longest edge is what this has to
// work out: the scale that fits *both* ways, applied to whichever edge is longer.
```

而这里有一条**形状**上的注释（`robotctl/src/camera.rs:131-136`）：

> Half-block cells hold two pixels each, so the pixel grid is as wide as the area and twice as
> tall. After the quarter turn this robot's camera needs, **the picture is portrait — 720×1280 —
> so it is height-bound** and leaves room either side, which is why it is centred rather than
> pinned to the left edge.

**四分之一圈的后果一直传到了终端布局**：图是竖的，所以两边留白。

而它把这个算术**钉成了一个测试**（`robotctl/src/camera.rs:204-206`）：

> This is the arithmetic worth pinning: `rgb_from_uyvy` fits a box by its **longest** edge, and a
> block is far wider than it is tall in pixels, so **passing it the width would draw a picture
> several times the height of the block — off the bottom of it, and off the frame.**

### 8.3 `duck-detect`：⚠️ 只用它的**类型**

**`duck-detect` 不调用这两个采样函数**，它只 `pub use uyvy::{Letterbox, PAD};`（`lib.rs:29`），
然后用自己的 `letterbox_rgb`（`duck-detect/src/lib.rs:65`）处理**已经是 RGB 的帧** ——
而那帧是 `mediad` 已经转正的（`duck-detect/src/lib.rs:17`）。

**这条链是**：

```
   摄像头 ──UYVY──► [uyvy::rgb_from_uyvy 转正] ──RGB──► duck-detect::letterbox_rgb ──► 模型
                          （mediad 里）
```

**这不是错误** —— `duck-detect` 和这个 crate **一致**（`PAD` 和 `Letterbox` 都来自这里）。
只是"三个消费者都做同样两件事"这句话，对 `duck-detect` 不成立。见 §9.1。

---

## 9. 几处读者会绊到的地方

按仓库的规矩，这里只**陈述事实**，不判断该怎么办。

### 9.1 `lib.rs:5-7` 说三个消费者都"做同样两件事"，而 `duck-detect` 不做

`lib.rs:3-8`：

> The head camera hands out `UYVY` at 1280×720 and **is mounted a quarter turn off**, so **every
> consumer of a frame does the same two things first: turn it the right way up, and sample it down
> to the size it actually wants. Three of them do — `mediad` encoding a JPEG or a PNG,
> **`duck-detect` feeding a model**, and `robotctl monitor` drawing one in a terminal** — and this
> is the one copy of that arithmetic.

**而 `duck-detect` 两件事都不做：**

- 它**不调用** `letterbox_from_uyvy` 或 `rgb_from_uyvy`（全文件只 `pub use` 了两个类型）；
- 它**不转** —— 它的 `letterbox_rgb` 收的是 `mediad` 已经转正的 RGB 帧
  （它自己的文档在 `duck-detect/src/lib.rs:17` 说了这一点）。

所以实际是**两个**消费者做那两件事（`mediad`、`robotctl`），
而 `duck-detect` 是**第三个同意"一帧长什么样"的**（通过共享 `PAD` 和 `Letterbox`）。

⚠️ **`Cargo.toml:11-13` 那段说的是准确的那个版本** —— *"Three processes have to **agree about
what a camera frame looks like**"* —— 而 `lib.rs` 的版本把"同意"说成了"都做"。

**值得留意的地方**：这个 crate 的**存在理由**正是"三个消费者需要同一份算术"，
所以那句夸大正好落在最会被引用的一段话里。

### 9.2 ⚠️ 工作区的 `default-members` 里 `"duck-ble"` 出现了两次

`Cargo.toml:21`：

```toml
default-members = ["btd", "configd", "duck-ble", "duck-ble", "duck-control", ...]
```

**`"duck-ble"` 写了两遍**（`members` 那一行只有一次）。
实际后果是零 —— Cargo 会去重 —— 但它是同一条列表里唯一一个重复项。

（这是我在写 [`scripts-primer.md`](scripts-primer.md) 时顺带发现的，记在这里因为这是它所在的文件。）

### 9.3 两个函数据说几乎一样，而它们的相似部分**没有被共享**

`letterbox_from_uyvy`（`:94-154`）和 `rgb_from_uyvy`（`:172-220`）里，
**取源像素那六行是逐字相同的**（`:123-134` 对 `:194-206`），
YUV→RGB 那三行也是（`:138-140` 对 `:209-211`）。

`lib.rs:91-93` 和 `:208` 都把理由写成了指向对方的话（*"as above"*、*"the same call … makes"*），
所以**这份重复是被知道的**，而不是漏掉的。

**没有把它们抽成一个内层函数**可以说得通 —— 那是个内层循环，
而 `Turn::source` 已经被抽出来当成"四种情况在一个地方"了。
只是读者会想知道为什么一处抽了、另一处没抽。

---

## 10. 阅读路线

**351 行。整个读完大概 20 分钟。**

### 如果只有五分钟

读 `lib.rs:10-13`（那句话）和 `lib.rs:68-80`（那个逆映射）。
**一个说为什么，一个说怎么做，而这就是全部。**

### 路径 A：我想理解那一帧数据（约 30 分钟）

| 步 | 读什么 |
|---|---|
| 1 | §2（UYVY 的排布 + BT.601） |
| 2 | `lib.rs:1-24`（模块文档 + 两个常量） |
| 3 | `lib.rs:94-147`（`letterbox_from_uyvy` 的内层循环） |
| 4 | `lib.rs:262-289`（那个"灰色保持灰色、V 高是红"的测试） |
| 5 | `lib.rs:291-298`（短帧不 panic） |

### 路径 B：我想改旋转的算术（约 40 分钟）

| 步 | 读什么 |
|---|---|
| 1 | `lib.rs:68-80`（**先把四个方向背下来**） |
| 2 | `lib.rs:300-324`（那些用逆映射表达的断言） |
| 3 | `lib.rs:326-350`（**用像素**验证旋转的测试） |
| 4 | §3 那张两趟/一趟的对比图 |
| 5 | 跑一次 `cargo test -p uyvy` |

**改之前先看 `lib.rs:300-304`**：

> This is the arithmetic that replaced a `videoflip` costing **145% of a core**, so it had better be
> right: **a mirrored or transposed picture would still detect *something*, on a model trained on
> neither.**

**"一张镜像或者转置的图仍然会检测出*某些东西* —— 在一个两者都没训练过的模型上。"**

### 路径 C：我想理解为什么要抽这个 crate（约 25 分钟）

| 步 | 读什么 |
|---|---|
| 1 | `Cargo.toml` 全文（17 行，注释比代码长） |
| 2 | `robotctl/Cargo.toml:27-34`（**同一个模式的两个实例**） |
| 3 | `duck-detect/src/lib.rs:1-30`（那边留下了什么） |
| 4 | [`robotctl-primer.md`](robotctl-primer.md)（"恢复路径上不能链接"那条规则） |
| 5 | `git show a7728e5 --stat`（那次抽取的大小） |

### 三条贯穿全文的主线

1. **一趟，而不是两趟。** 转在采样里、色度不插值、缓冲区复用、
   整数代替浮点 —— **全是同一个判断在四个地方的表现**：
   这是一条每帧都要跑、而且跑在 50 Hz 控制环旁边的路径。

2. **一个数字要和别处一致，而没有任何东西强制它。**
   `PAD = 114` 是训练那边的约定，`BT.601 limited range` 是 ISP 的约定，
   而 `duck-detect/src/lib.rs:12-14` 把这件事说得很清楚：
   ***"Everything here has to agree with how the model was trained, and nothing enforces that
   across the two repositories except this comment and the numbers below."***
   **搞错一个不会让检测器失败 —— 它只会悄悄变差。**

3. **纯算术应该是一个叶子。** 零依赖不是洁癖，是一条规则：
   **处于恢复路径上的东西，不能因为"我想画一张图"就链接一棵带着 NPU 运行时的树。**

---

## 11. 术语表

| 词 | 意思 |
|---|---|
| **UYVY** | 一种像素排布：`U Y0 V Y1` 四个字节覆盖两个像素 |
| **YUV / YCbCr** | 亮度 + 两个色度分量 |
| **亮度 / luma (Y)** | 明暗。**每个像素一个** |
| **色度 / chroma (U, V)** | 颜色。**每两个像素共用一个** |
| **4:2:2** | 横向减半的色度采样。"4:2:2" 里的 2 说的是这个 |
| **stride** | 一行占多少字节。这里 `width * 2` |
| **BT.601** | 一组 YUV↔RGB 的转换系数 |
| **limited range** | Y 在 16…235 而不是 0…255 |
| **定点 / fixed point** | 用整数和移位代替浮点。`>> 8` 就是 ÷256 |
| **最近邻 / nearest-neighbour** | 缩放时直接取最近的那个源像素，不插值 |
| **双线性 / bilinear** | 缩放时按距离加权四个源像素。**这里不用** |
| **letterbox** | 保持比例缩放到框里，空白处填色。**不拉伸** |
| **`PAD`** | 那个填充色，114 灰。**必须和训练一致** |
| **`Letterbox`** | 三个数：缩放比 + 两个方向的填充量 |
| **`Turn`** | 四个方向：`None` / `Right` / `Half` / `Left` |
| **`source()`** | 逆映射：正着的图上的 (ux,uy) 在原始帧的哪里 |
| **`upright()`** | 转完之后的长宽。**四分之一圈会交换它们** |
| **ISP** | 图像信号处理器。它决定 YUV 的约定 |
| **`videoflip`** | GStreamer 的旋转元件。**这里不用它**，见下 |
| **RGA** | Rockchip 的 2D 加速器 |
| **MPP** | Rockchip 的媒体处理。硬件编解码走它 |
| **零拷贝 / zero-copy** | 数据不经过 CPU 内存搬来搬去 |
| **NV12** | 另一种 YUV 排布，硬件编码器要的 |
| **recovery path / 恢复路径** | 一切坏掉时还得能用的那条路。`robotctl` 在上面 |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| **摄像头、流水线、编码（姊妹篇）** | [`mediad-primer.md`](mediad-primer.md) |
| **借用它的两个类型的那个 crate（姊妹篇）** | [`duck-detect-primer.md`](duck-detect-primer.md) |
| **"恢复路径上不能链接"那条规则（姊妹篇）** | [`robotctl-primer.md`](robotctl-primer.md) |
| **同一个模式的第一个实例（姊妹篇）** | [`kinematics-primer.md`](kinematics-primer.md) |
| 摄像头是怎么 bring-up 的（含 VPU 和那两个插件） | [`project/media-bringup.md`](project/media-bringup.md) |
| 远程访问、WebRTC、那条视频路径 | [`design/remote-access-design.md`](design/remote-access-design.md) |
| 鸭子检测器的完整故事 | [`project/npu-bringup.md`](project/npu-bringup.md) |
| 头部的两个传感器（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 控制核心：那个 50 Hz 的循环（姊妹篇） | [`duck-control-primer.md`](duck-control-primer.md) |
| 那个 50 Hz 的控制环（姊妹篇） | [`robotd-primer.md`](robotd-primer.md) |
| 那些 JSON-RPC 方法（姊妹篇） | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| 里程计与那张地图（姊妹篇） | [`odometry-primer.md`](odometry-primer.md) |
| 装机、更新、诊断的那些工具（姊妹篇） | [`scripts-primer.md`](scripts-primer.md) |
| 更新时在这块板子上跑的那两个脚本（姊妹篇） | [`hooks-primer.md`](hooks-primer.md) |
| 板子被配置成什么样子（姊妹篇） | [`deploy-primer.md`](deploy-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| wifi、身份、手柄配对（姊妹篇） | [`configd-primer.md`](configd-primer.md) |
| 蓝牙门房（姊妹篇） | [`btd-primer.md`](btd-primer.md) |
| BLE 的线上契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| 手柄：按键映射、模式（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| 手柄自己的 IMU（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| 鸭子的嗓子（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| 摸头检测（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| 仿真的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 那份配置 schema（姊妹篇） | [`robotd-params-primer.md`](robotd-params-primer.md) |
| 笔记本上那个客户端（姊妹篇） | [`duckctl-primer.md`](duckctl-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
