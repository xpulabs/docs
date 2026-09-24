# `pet-detect` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> 这个 crate 是纯库，没有自己的设计文档，但有一份很好的 [`README.md`](../pet-detect/README.md)（含**重训流程**）。
> 它服务的那个功能（听到摸头就咕咕叫）由 [`robotd-params-primer.md`](robotd-params-primer.md) §`[audio]`
> 和 [`deploy-primer.md`](deploy-primer.md)（音频硬件）拥有。
> 若本导读与代码不一致，以代码为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：[`duck-detect-primer.md`](duck-detect-primer.md)（另一个检测器，看图像而不是听声音）、
> [`robotd-primer.md`](robotd-primer.md)（跑这个 worker 的人）。

## 目录

1. [一分钟版](#1-一分钟版)
2. [它在整个系统里的位置](#2-它在整个系统里的位置)
3. [⭐ 核心心智模型：把声音当成一张图](#3--核心心智模型把声音当成一张图)
4. [目录导览](#4-目录导览)
5. [第一步：40 带 log-mel 是什么](#5-第一步40-带-log-mel-是什么)
6. [⭐ 那 9 个常数就是训练契约](#6--那-9-个常数就是训练契约)
7. [第二步：那个 20 KB 的模型](#7-第二步那个-20-kb-的模型)
8. [⭐ 迟滞：为什么要两个阈值](#8--迟滞为什么要两个阈值)
9. [⭐ 环境音哨兵：那个"要不要算"的门](#9--环境音哨兵那个要不要算的门)
10. [`arecord` 子进程与重启退避](#10-arecord-子进程与重启退避)
11. [消费者：`robotd` 怎么用它](#11-消费者robotd-怎么用它)
12. [⭐ 训练/推理的一致性](#12--训练推理的一致性)
13. [测试：7 个](#13-测试7-个)
14. [几处读者会绊到的地方](#14-几处读者会绊到的地方)
15. [阅读路线](#15-阅读路线)
16. [术语表](#16-术语表)

---

## 1. 一分钟版

`pet-detect` 回答一个问题：

> **有人在摸我的头吗？**

麦克风在头顶，所以"摸头"在这个麦克风上**响得像敲击**。机器人听到就咕咕叫一声。

一句话说清它的定位（`README.md`）：

> A tiny audio classifier that hears when the robot's head is being scratched (the onboard mic
> sits there). **~20 KB CNN over 40-band log-mel windows, sub-millisecond inference.**

规模：**1,069 行** Rust，加一个 **20,201 字节**的 ONNX 模型、一份 171 行的重训脚本。

```
pet-detect/
├── README.md                    —— 含重训流程
├── Cargo.toml              31 行
├── models/pet_detect.onnx  20,201 字节  ← 就是那个"~20 KB"
├── src/
│   ├── lib.rs             382 行  特征提取 + 推理 + 迟滞
│   ├── worker.rs          519 行  arecord 子进程 + 环境音哨兵
│   ├── bin/detect.rs       87 行  独立二进制：拿一段音频流看概率
│   └── bin/features.rs     50 行  独立二进制：**训练用的那一半**
└── training/train.py      171 行  PyTorch
```

> 💡 这个 crate 只有**一个**消费者：`robotd`。它是纯库 + 两个开发用的二进制。

---

## 2. 它在整个系统里的位置

```
   板载麦克风（TLV320AIC3104 编解码器）
        │  ALSA
        ▼
   arecord 子进程          ← "-D plughw:aic3104,0 -f S16_LE -r 16000 -c 1 -t raw"
        │  16 位小端 PCM，每秒 16000 个
        ▼
   worker::worker_loop      ← 一条名为 "pet-worker" 的线程
        │
        ├──► SoundSentry     环境音哨兵：量房间有多吵（纯 RMS，无 ML）
        │        │
        │        └──► audible?  ── 决定分类器要不要跑 ★
        │
        └──► PettingDetector
                 │  特征 → 模型 → 迟滞
                 ▼
        PettingEvent::Start / End（mpsc 通道）
                 │
                 ▼
        robotd 在控制环里 try_recv_event() ──► 咕咕叫一声
```

**为什么要一个子进程而不是直接绑 ALSA**（`worker.rs:3-6`）：

> The audio source is an `arecord` subprocess rather than an in-process ALSA binding — **the same
> pattern the standalone `pet-detect` binary documents, and no new native dependency.** The capture
> device is **single-client**, so everything that analyses the mic shares this one stream.

两句理由：**不引入新的原生依赖**，以及 —— 更重要的 ——
**采集设备是单客户端的**，所以所有要分析麦克风的东西**必须共用这一条流**。

> 💡 这也是为什么"环境音哨兵"和"摸头分类器"住在同一个 crate 里
> （`Cargo.toml:3-5`）：*"so everything that listens to the mic is one crate."*

---

## 3. ⭐ 核心心智模型：把声音当成一张图

这是读懂这个 crate 最关键的一步。

### 3.1 声音本来就是一堆数字

麦克风每秒吐出 **16,000 个数字**（16 kHz 采样率），每个数字是"此刻空气压强的偏离量"。

**但一个神经网络没法直接从这 16,000 个数里认出"摸头"。** 因为：
- 同一个动作，快一点慢一点，波形就对不齐；
- 波形里最重要的信息是**频率成分**，而不是瞬时振幅。

### 3.2 所以先把它变成"频谱图"

**频谱图（spectrogram）** 的做法：

```
1 秒的音频（16,000 个数）
    │
    ├─ 切成 100 个小片段，每片 25 毫秒，每 10 毫秒切一刀（相邻片段有重叠）
    │
    ├─ 每个片段做一次 FFT → 得到"这段里各个频率各有多强"
    │
    ├─ 把 257 个频率 bin 合并成 40 个"频带"（← mel 刻度，模仿人耳）
    │
    └─ 取对数（← 因为人耳对响度的感知也是对数）
```

结果是一张 **40 × 100 的表**：

```
        时间 →（100 列，每列 10 ms）
      ┌────────────────────────────┐
 频   │                            │
 率   │      这张"图"就是          │
 ↓    │      喂给 CNN 的东西       │
 40   │                            │
 带   │                            │
      └────────────────────────────┘
```

**这就是核心心智模型：声音变成了一张 40×100 的灰度图，然后当一个图像分类问题来做。**

模型里那些 `Conv → BN → ReLU → MaxPool`（`lib.rs:4`）就是图像 CNN 的标准配方。

### 3.3 那条输入张量

```rust
// pet-detect/src/lib.rs:320
let input = Tensor::from_array(([1usize, 1, N_MELS, WINDOW_FRAMES], mel))?;
```

`[1, 1, 40, 100]` —— 批次 1、**通道 1**（灰度图，不是彩色）、高 40、宽 100。
`mel` 是同一个 4000 个数**按行优先拍平**的（`lib.rs:70`、`lib.rs:99`）。

---

## 4. 目录导览

`lib.rs` 分四段：

| 段 | 行 | 内容 |
|---|---|---|
| 常数 | `:24-37` | **9 个数字，全是训练契约** |
| `MelExtractor` | `:40-156` | 特征提取（手写的 mel 滤波器组） |
| WAV 加载 | `:158-211` | 给训练用；重采样、降混 |
| `PettingDetector` | `:213-347` | 推理 + **迟滞** |

`worker.rs` 分三段：

| 段 | 行 | 内容 |
|---|---|---|
| `SoundSentry` | `:29-196` | 环境音哨兵（**纯启发式，无 ML**） |
| `PetHandle` | `:198-282` | 对外的把手：spawn / 收事件 / 关 |
| `worker_loop` | `:284-432` | arecord 的生命周期 + 重启退避 |

---

## 5. 第一步：40 带 log-mel 是什么

### 5.1 参数

```rust
// pet-detect/src/lib.rs:24-37
pub const SAMPLE_RATE: usize = 16_000;   // 每秒 16000 个采样
pub const N_FFT: usize = 512;            // FFT 的点数
/// 10 ms.
pub const HOP: usize = 160;              // 相邻两帧隔多少采样
/// 25 ms.
pub const WIN: usize = 400;              // 每帧多长
pub const N_MELS: usize = 40;            // 40 个频带
/// 1.0 s of audio.
pub const WINDOW_FRAMES: usize = 100;    // 一秒里有 100 帧
/// 16 240 samples.
pub const WINDOW_SAMPLES: usize = (WINDOW_FRAMES - 1) * HOP + WIN;
pub const FMIN: f32 = 0.0;
pub const FMAX: f32 = 8_000.0;
pub const LOG_EPS: f32 = 1e-6;
```

把 `WINDOW_SAMPLES` 展开算一遍：**99 × 160 + 400 = 16,240**。

> 💡 **`HOP` 是 160 而不是 100。** 10 ms 在 16 kHz 下确实是 160 个采样 —— 160/16000 = 0.01 秒。
> 而 `WIN = 400` 是 25 ms。所以**帧与帧之间有 60% 的重叠**（每走 10 ms，看 25 ms）。

⚠️ **`WINDOW_SAMPLES` 是 16,240，不是 16,000。** 也就是**1.015 秒，不是 1 秒**。
这一点在 `worker.rs` 里被专门点出来过（见 §9.3）—— 因为这个 0.015 秒的差别，
"大约一秒"这个直觉写的字面量是**错的**。

### 5.2 mel 刻度是什么

人耳**对低频的分辨力远高于高频**：你能分清 200 Hz 和 250 Hz，但分不清 8000 Hz 和 8050 Hz。

**mel 刻度就是把频率轴按"人耳听起来等距"重新拉一遍。**

```rust
// pet-detect/src/lib.rs:112-117
fn hz_to_mel(f: f32) -> f32 { 2595.0 * (1.0 + f / 700.0).log10() }
fn mel_to_hz(m: f32) -> f32 { 700.0 * (10f32.powf(m / 2595.0) - 1.0) }
```

那个 `2595` 和 `700` 是这条曲线的标准常数 —— 不是调出来的，是 mel 刻度的定义。

然后（`lib.rs:129-132`）：

```rust
// n_mels + 2 evenly-spaced points on the mel scale.
let hz_points: Vec<f32> = (0..n_mels + 2)
    .map(|i| mel_to_hz(mel_min + (mel_max - mel_min) * i as f32 / (n_mels + 1) as f32))
    .collect();
```

**在 mel 刻度上等距取 42 个点，再转回 Hz。** 相邻三点构成一个三角形滤波器：
第 m 个滤波器的低端、中心、高端（`lib.rs:139`）。

因为是在 mel 上等距的，**这些三角形的 Hz 宽度是递增的** —— 低频窄、高频宽。
这正是"模仿人耳"的落地方式。

### 5.3 为什么滤波器组是稀疏的

```rust
// pet-detect/src/lib.rs:44
/// Sparse: for each mel band, (fft_bin, weight).
mel_filters: Vec<Vec<(usize, f32)>>,
```

每个三角形只覆盖少数几个 FFT bin，所以只存**非零的** `(bin, 权重)` 对。
计算时（`lib.rs:94-100`）只遍历这些。

**这个模型的输入是 40×100，不是 257×100** —— 滤波器组在特征阶段就压掉了 84% 的列。

### 5.4 取对数

```rust
// pet-detect/src/lib.rs:99
out[m * WINDOW_FRAMES + frame] = (s + LOG_EPS).ln();
```

`LOG_EPS = 1e-6` 是防止 `ln(0) = -∞`。
测试 `log_mel_reacts_to_signal`（`:370`）钉住了这件事：

> **Silence must produce all-floor log-mels**; a full-scale tone must not.

静音时每个值都等于 `ln(1e-6) ≈ -13.8`，而一个 440 Hz 的正弦必须给出一些正值。

---

## 6. ⭐ 那 9 个常数就是训练契约

`lib.rs:24-37` 上面有一句话（`lib.rs:8-10`）：

> Ported from `apirrone/microduck_pet_detect` **unchanged in every number**: **the mel layout is
> the training contract**, and the `pet-features` binary exists precisely so training and inference
> share this file.

**"mel 的排布就是训练契约。"**

为什么？因为模型是在**某种特定的特征排布**上训练出来的。
你换了 FFT 点数、换了帧率、换了 mel 的个数，**模型不会报错** ——
它只会收到一张和训练时不一样的图，然后给出**看起来也像那么回事的垃圾**。

所以有一个测试专门钉住它（`lib.rs:358-366`）：

```rust
/// The mel layout is the training contract; these numbers moving means retraining.
#[test]
fn the_feature_contract_is_pinned() {
    assert_eq!(WINDOW_SAMPLES, 16_240);
    assert_eq!(N_MELS * WINDOW_FRAMES, 4_000);
    // ...滤波器组有 40 个，每个都非空
}
```

**测试的注释就是全部的理由：*"these numbers moving means retraining."*
这些数字一动，就（意味着）要重训。**

> 💡 这是这个仓库里"契约测试"的一个典型样子：**它不断言行为，它断言"排列"**。
> 因为排列变了行为不会崩，只会悄悄变差。

---

## 7. 第二步：那个 20 KB 的模型

架构（`lib.rs:4`）：

```
Conv → BN → ReLU → MaxPool → Conv → BN → ReLU → GAP → Linear
```

就是最朴素的图像 CNN：

| 层 | 干什么 |
|---|---|
| **Conv**（卷积） | 在"图"上滑动小窗口，找局部模式（边缘、纹理） |
| **BN**（批归一化） | 把每层输出拉回稳定范围，训练更稳 |
| **ReLU** | 负数归零。非线性 |
| **MaxPool** | 下采样：每 2×2 取最大，图变小 |
| **GAP**（全局平均池化） | 把整张特征图**平均成一个数** |
| **Linear** | 全连接层，最后输出 2 个分数 |

`GAP` 是它只有 20 KB 的关键：**它把任意大小的特征图压成固定长度，所以全连接层不用很大。**

### 7.1 推理

```rust
// pet-detect/src/lib.rs:320-323
let input = Tensor::from_array(([1usize, 1, N_MELS, WINDOW_FRAMES], mel))?;
let outputs = self.session.run(ort::inputs![input])?;
let (_shape, probs) = outputs[0].try_extract_tensor::<f32>()?;
let p = probs[1];                        // ← 下标 1 = "petting"
```

⚠️ **`probs[1]` 里的那个 `1` 是一个训练契约**，而它**没有测试**。见 §14。

### 7.2 单线程是故意的

```rust
// pet-detect/src/lib.rs:260-266
// Single-threaded on purpose: the default one-intra-op-worker-per-core spawns
// threads that burn CPU on synchronisation overhead for a 20 KB model.
let session = Session::builder()?
    .with_optimization_level(GraphOptimizationLevel::Level3)?
    .with_intra_threads(1)?
    .with_inter_threads(1)?
```

**"默认的'每个核一个算子线程'，对一个 20 KB 的模型来说，线程都耗在同步开销上了。"**

> 💡 而且它可以这么奢侈，因为 `Cargo.toml:30` 说：
> *"The same pin as `duck-control`: **one ONNX Runtime on the board serves both.**"*
> 板子上只有一份 ONNX Runtime，两个 crate 共用。

---

## 8. ⭐ 迟滞：为什么要两个阈值

### 8.1 一个阈值会抖

如果只有一个阈值（比如 0.9）：概率在 0.9 附近晃的时候，
状态会**在"摸头"和"没摸"之间一秒翻好几次** —— 机器人就会咕咕咕咕叫个不停。

**迟滞（hysteresis）** 的解法：**进入和离开用两个不同的阈值。**

```rust
// pet-detect/src/lib.rs:221-223
/// Hysteresis: **enters "petting" above `enter_threshold`, leaves below `exit_threshold`** —
/// set the exit lower so the boundary doesn't flap.
```

```rust
// pet-detect/src/lib.rs:326-332
if !self.is_petting && p >= self.enter_threshold {
    self.is_petting = true;
    events.push(PettingEvent::Start);
} else if self.is_petting && p < self.exit_threshold {
    self.is_petting = false;
    events.push(PettingEvent::End);
}
```

```
   p
   │
1.0┤
   │        ┌───────────────┐
0.95 ───────┘ 进入           │        ← enter_threshold
   │                         │
0.85 ────────────────────────┘        ← exit_threshold
   │
0.0┤
```

**中间那 0.10 的带子里，状态不变** —— 这就是"不抖"的来源。

### 8.2 ⚠️ 那个 0.85 比你想的高，而原因写下来了

```rust
// pet-detect/src/lib.rs:249-254
enter_threshold: 0.95,
// Higher than you'd naively pick: even ambient mic noise hovers around p ≈ 0.7
// with a small training set, so dropping below 0.85 cleanly means the petting
// actually stopped.
exit_threshold: 0.85,
```

**"比你会天真地选的更高：即使环境噪声，在一个小训练集上概率也在 0.7 附近晃。"**

也就是说：**这个模型对"这不是摸头"并不自信** —— 因为训练集小。
所以"还在摸"的下限必须高到 0.85，才能干净地说"停了"。

这是很诚实的一条注释：**它承认了模型的弱点，并说明阈值是怎么被这个弱点推上去的。**

### 8.3 一个窗口滑一步

`stride` 决定**每多少个采样做一次推理**：

```rust
// pet-detect/src/lib.rs:236-238
/// Samples between successive inference windows. Smaller = lower latency, more CPU.
/// The default is ≈ 250 ms.
pub stride: usize,
```

```rust
// pet-detect/src/lib.rs:248
stride: WINDOW_SAMPLES / 4,     // 16240 / 4 = 4060 采样 = 254 ms
```

所以**一秒的窗口，每 254 ms 往前滑一次** —— 也就是**每秒大约 4 次推理**，
每次看的是过去 1.015 秒。

> 💡 这就是 §9 那个"要不要算"的门的价值所在 —— 一个从不开口的门，
> 省下的是**每秒 4 × (100 次 FFT + 一次前向)**。

---

## 9. ⭐ 环境音哨兵：那个"要不要算"的门

### 9.1 问题

`worker.rs:88-95`：

> **This is what decides whether the classifier runs at all.** The petting model is 40 log-mel
> bands over a second of audio — **a hundred 512-point FFTs and a forward pass, four times a
> second, for ever.** In a quiet room every one of those returns the same answer, and this is
> **the cheap way to know it in advance**.

**"永远，每秒四次。"** 而安静的房间里，每一次都返回同样的答案。

### 9.2 解法：反正哨兵已经在量房间了

`SoundSentry` 本来就在**逐帧算 RMS**（均方根，也就是"这一帧有多响"），
所以门控只需要**读它已经算出来的那个地板值**，而不是另起一套：

> the sentry is already measuring the room frame by frame, so **the gate reads its floor rather
> than keeping a second one that could drift from it.**（`worker.rs:94-95`）

**"而不是另养一个可能和它漂开的地板值。"**

### 9.3 `AUDIBLE_HOLD_FRAMES`：一个被**推导**出来的常数

```rust
// pet-detect/src/worker.rs:35-49
/// 32 ms at 16 kHz.
const SENTRY_FRAME: u32 = 512;

/// How long a sound keeps the classifier armed after it, in [`SENTRY_FRAME`]s.
///
/// **A whole window, derived rather than written down.** A sound heard now is still inside
/// the window the classifier looks at a window from now, so anything shorter would shut the
/// gate on audio still under examination — and **a stroke is not continuous anyway, it is
/// scratches with gaps to sit through.** Rounded up, because a hold that covers all but the
/// last 23 ms of a window covers the wrong thing.
///
/// Written as arithmetic on [`crate::WINDOW_SAMPLES`] because **the obvious literal is wrong:
/// a window is 16 240 samples, which is 1.015 s and *not* the 31 frames that "about a
/// second" suggests.**
const AUDIBLE_HOLD_FRAMES: u32 = (crate::WINDOW_SAMPLES as u32).div_ceil(SENTRY_FRAME);
```

`ceil(16240 / 512) = 32` 帧 = **1.024 秒**。而"大约一秒"的字面量 31 帧 = **0.992 秒**，
**差那 23 毫秒就盖不住一整个窗口。**

这段注释是整份代码里最值得学的一个：**它没有写 32，它写了"为什么 31 是错的"。**

### 9.4 门开在**低**那个阈值上

```rust
// pet-detect/src/worker.rs:140-141
let on_thresh  = (self.floor * 6.0).max(0.002);     // 报告一个声音事件
let off_thresh = (self.floor * 3.0).max(0.0012);    // 事件结束（也用来武装门）
```

```rust
// pet-detect/src/worker.rs:145-149
if rms > off_thresh {
    self.audible_frames = AUDIBLE_HOLD_FRAMES;      // ← 用 off_thresh
} else {
    self.audible_frames = self.audible_frames.saturating_sub(1);
}
```

理由（`worker.rs:97-103`）：

> Armed by the **lower** of the sentry's two thresholds … **This is not deciding whether a sound
> is worth reporting; it is deciding whether a pet is worth looking for, and the two want very
> different margins.** A stroke gentle enough to stay under three times the ambient floor for a
> whole second would be missed — **and would have scored far below the 0.95 enter threshold
> anyway**, on a mic this model was trained through where a head scratch is loud enough to need
> muting.

**"这不是在决定一个声音值不值得报告，而是在决定一次抚摸值不值得去找 ——
这两件事要的余量完全不同。"**

有一个测试专门钉这个区分（`worker.rs:503-518`）：

```
the_gate_opens_below_the_event_threshold
    "a sound too small to report is not too small to classify"
```

**"小到不值得报告的声音，不等于小到不值得分类。"**

### 9.5 ⚠️ 门**不能**关掉"结束"那条路

```rust
// pet-detect/src/lib.rs:310-316
// Only while *not* petting. The End edge is found by inference exactly as the
// Start is, so a session whose room went quiet under a shut gate would never
// end — the robot would sit there believing it was still being stroked.
if !audible && !self.is_petting {
    continue;
}
```

**"一个在关着的门底下安静下来的房间，那次会话永远不会结束 ——
机器人会坐在那儿，相信自己还在被抚摸。"**

所以：**静音时跳过推理，但只在你*没在*摸头的时候跳。**
一旦进入"摸头"状态，**每一帧都要算**，哪怕房间是安静的 ——
因为"停止"这个判断**也只能由推理给出**。

### 9.6 ⭐ 那个 `samples_until_infer` 的推进位置

```rust
// pet-detect/src/lib.rs:300-306
while self.ring.len() >= self.samples_until_infer {
    let start = self.samples_until_infer - WINDOW_SAMPLES;
    // Advanced here rather than at the end of the body, so that *every* path out of
    // this iteration has advanced it. The skip below is one such path, and a skip
    // that forgot to would not be a missed inference — it would be this loop
    // spinning on the same window until the thread is killed.
    self.samples_until_infer += self.stride;
```

**"一个忘了推进的 `continue` 不会是一次漏掉的推理 —— 它会是一个卡在同一个窗口上、
直到线程被杀掉的死循环。"**

所以推进放在**循环体最前面**，而不是末尾。这是那种"看起来无所谓、实际上是唯一正确位置"的代码。

### 9.7 哨兵还会报"环境音事件"

```rust
// pet-detect/src/worker.rs:23-28
/// Ambient sound events, from the same stream the petting classifier consumes. **Pure
/// RMS-envelope heuristics — no ML**:
///   * `Noise`: a sharp transient (clap, bang, door) — ≤ ~0.38 s of loud.
///   * `Voice`: a sustained utterance (speech, a quack at the duck) — up to ~3 s of loud.
///     **Longer runs are continuous noise (vacuum, music) and emit nothing; the adaptive
///     floor absorbs them.**
```

| 时长 | 判成 |
|---|---|
| ≤ 12 帧（0.38 s） | `Noise`（拍手、关门） |
| 12 ~ 94 帧 | `Voice`（说话、对它叫） |
| **> 94 帧（3 s）** | **什么都不报** —— 吸尘器、音乐，被地板值吸收掉 |

而**摸头期间这两个都不报**（`worker.rs:51-53`、`:122-124`）：

> Petting sounds are loud on this mic (**it's practically a contact mic for head scratches**),
> so events are suppressed while the classifier reports petting (+1 s hangover).

**"这个麦克风对摸头来说基本就是个接触式麦克风。"** 不静音的话，
摸头本身会被报成 `Voice` 事件。

### 9.8 地板值怎么适应

```rust
// pet-detect/src/worker.rs:150-153
if !self.in_event {
    // The ambient floor adapts only from non-event frames (τ ≈ 6 s), so sustained
    // noise (gait servos, music) raises the bar instead of spamming events.
    self.floor = 0.995 * self.floor + 0.005 * rms;
```

**只在"没有事件"的帧上更新** —— 否则持续噪声会自己把自己变成"正常"，
然后事件永不停止。它更新得**很慢**（`0.005` → 时间常数约 6 秒），
所以一段持续的噪声**会把门槛抬上去**，而不是一直触发。

---

## 10. `arecord` 子进程与重启退避

### 10.1 捕获命令

```rust
// pet-detect/src/worker.rs:366-374
Ok(Command::new("arecord")
    .args(["-D", device, "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw"])
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()?)
```

`-t raw` 意味着**没有 WAV 头**，纯粹是流。所以读的时候：
`worker.rs:396-402` 检查字节数是偶数，然后 `i16::from_le_bytes` 成对地读。

`stderr` 直接丢掉 —— 所以 `arecord` 自己的抱怨不会进日志。它**退出**才是信号（EOF）。

### 10.2 ⭐ 那个退避是为什么

```rust
// pet-detect/src/worker.rs:284-291
/// Backoff between restarts of a capture that will not stay up: doubling from 250 ms to a cap.
/// **A board where `arecord` exists but the codec does not** — `configure_audio` fails soft at
/// every step, so a failed DKMS build leaves exactly that — **makes `arecord` exit immediately
/// on every spawn.** Without a backoff on *that* path (the original only slept when the
/// `arecord` binary itself was missing) **the worker fork/execs as fast as the CPU allows for
/// the life of the daemon, with a `warn!` per iteration into the journal.**
```

**"worker 会以 CPU 允许的最快速度反复 fork/exec，贯穿 daemon 的整个生命周期，
每轮往 journal 里塞一条 warn。"**

原型的退避只覆盖了"`arecord` 这个程序不存在"这一条路，
而**"程序在、但声卡不在"**是另一条路 —— 一个 DKMS 编译失败的板子正好长这样。

| 常数 | 值 | 意思 |
|---|---|---|
| `RESTART_BACKOFF_MIN` | 250 ms | 起始 |
| `RESTART_BACKOFF_MAX` | 30 s | 上限 |
| `RESTART_HEALTHY` | 5 s | **跑够这么久就不算"这个退避要治的失败"**，计数归零 |
| `RESTART_QUIET_AFTER` | 5 | 之后降成 `debug` |

### 10.3 两个小细节

**① 睡觉要能被叫醒**（`worker.rs:337-339`）：

> Sliced, because `shutdown()` joins this thread: **a 30 s sleep would be 30 s of `robotd` not
> exiting.**

所以 `sleep_unless_shutdown`（`:354-364`）每 100 ms 醒一次看一眼。

**② 模型在**线程外面**建**（`worker.rs:231-234`）：

> Built here, not in the thread, so a missing model or runtime is **an error the caller sees
> instead of a worker that dies quietly on its first breath**. Behind a panic catch, because `ort`
> **panics** on failures it considers unrecoverable — **a missing libonnxruntime must read as
> "no mic worker", not a dead daemon.**

**"一个缺失的 `libonnxruntime` 必须被读成'没有麦克风 worker'，而不是'一个死掉的 daemon'。"**

### 10.4 `pump` 里那两行的顺序

```rust
// pet-detect/src/worker.rs:404-411
// Read before the sentry sees this batch, deliberately: the answer is a one-second
// hangover rather than a verdict on these 128 ms, so it spans batches and reading it
// one batch early costs nothing. Reading it after would mean pushing to the sentry
// first, and the sentry's petting mute wants the state from *after* this batch's
// inference — see below. **Only one of the two can go first, and this is the one whose
// ordering does not matter.**
```

两个动作互相等着对方的输出：门控要哨兵的结果，哨兵的静音要分类器的状态。
**只能有一个先走，而选的是"顺序不影响结果"的那个** —— 因为门控读的是一个
**跨越一秒的保持量**，早读一批没有代价。

---

## 11. 消费者：`robotd` 怎么用它

### 11.1 什么时候起来

```rust
// robotd/src/main.rs:1921-1929
let pet: Option<pet_detect::worker::PetHandle> = if params.audio.enabled
    && params.audio.pet_detect_resolved(params.policy.mode)
    && let Some(model) = params.audio.pet_model_resolved()
    && model.exists()
{
    match pet_detect::worker::PetHandle::spawn(...) { ... }
```

四个条件全满足才起。而起不来只是 `warn`（`:1936-1938`）：

> **Not unhealthy: the classifier is a feature, not the robot.** A missing model on a release
> that ships one is caught by the packaging tripwires.

**"不是不健康：分类器是一个特性，不是机器人本身。"**

### 11.2 默认**关着**

`robotd-params` 的 `AudioParams::default().pet_detect = None`，而（`robotd-params/src/lib.rs`）：

```rust
/// Listen for petting on the onboard mic and coo about it. Absent means **off**: the
/// per-mode resolution the prototype shipped (on for walking) cooed at every incidental
/// head scratch, which **wore thin fast**. Set `true` to opt in.
```

```rust
pub fn pet_detect_resolved(&self, _mode: Mode) -> bool {
    // Off unless asked for, in either mode. It used to resolve per mode as the prototype's
    // launcher did (on for walking, off for the roller) — and **cooing at every incidental
    // head scratch turned out to be more annoying than charming in daily use.** The mode is
    // still passed so flipping this back is a one-line change, not a signature change.
    self.pet_detect.unwrap_or(false)
}
```

**"对每一次偶然的摸头都咕咕叫，在日常使用中被证明是恼人而非可爱。"**

注意那个 `_mode` 参数：**留着不用**，这样"改回去"是一行改动而不是一次签名变更。

### 11.3 咕咕叫的条件

```rust
// robotd/src/main.rs:2226-2240
// Petting: coo, exactly when the prototype coos — not fallen, no scripted move
// in flight. The verdict is used bare here (not the armed fall gate): this is a
// sound cue, and **cooing while face-down would be worse than staying quiet.**
if let Some(pet) = pet.as_ref() {
    while let Some(ev) = pet.try_recv_event() {
        match ev {
            pet_detect::PettingEvent::Start => {
                let calm = !safety.fallen() && controller.as_ref().is_none_or(|c| !c.busy());
                if calm { voice.play("coo", false); }
                else { tracing::debug!("petting detected (ignored: busy or down)"); }
```

**"趴着的时候咕咕叫会比保持安静更糟。"**

### 11.4 环境音事件**还没有消费者**

```rust
// robotd/src/main.rs:2245-2249
// Ambient sound events have no consumer until the autonomous brain arrives;
// surfaced at debug so mic tuning on a bench has data to look at.
while let Some(ev) = pet.try_recv_sound() {
    tracing::debug!(event = ?ev, "ambient sound");
}
```

**"在自主大脑到来之前，环境音事件没有消费者。"** 它现在是台架调麦克风用的数据。

---

## 12. ⭐ 训练/推理的一致性

这是这个 crate 里设计得最漂亮的一处。

### 12.1 问题：训练和推理会用**两份**特征代码

通常的做法是：Python 里用 `librosa` 算 mel，Rust 里自己再写一份。
**然后两份实现有细微差别，而模型在训练时学到的东西在推理时对不上。**

这种偏差不会报错，只会让准确率悄悄变低。

### 12.2 解法：让训练**调用推理的那份代码**

```rust
// pet-detect/src/bin/features.rs:4-6
//! This is **the training half of the train/infer parity contract**: the Python training
//! script extracts features **THROUGH this binary**, so the model always trains on exactly
//! what the robot computes.
```

而 `train.py:11-14`：

```python
"""Train the petting classifier.

Features are extracted by the `pet-features` Rust binary so that the training
features exactly match what the runtime computes — **no risk of a Python/Rust
log-mel discrepancy biasing the model.**
"""
```

而 `lib.rs:8-10` 从第三个角度说了同一件事：

> the `pet-features` binary exists **precisely so training and inference share this file**.

**同一个保证，三个地方各说了一遍。** 因为它是这个 crate 最重要的一条不变式。

### 12.3 它是怎么工作的

```
  WAV 文件
     │
     ▼
  pet-features（Rust）        ← 训练脚本 fork 这个二进制
     │  二进制 f32 LE 流，每块 [40,100]
     ▼
  train.py                    ← numpy 读进来，直接喂给 PyTorch
     │
     ▼
  models/pet_detect.onnx
```

`features.rs:40` 把每个 f32 写成小端字节：
`mel.iter().flat_map(|v| v.to_le_bytes())`，`train.py:41` 那边用 `BLOCK_BYTES = N_MELS * WINDOW_FRAMES * 4` 切块
（并在 `:52-53` 拒绝字节数对不上的文件）。

**没有 JSON、没有 CSV、没有任何会引入精度损失或解析歧义的东西** —— 就是原始 `f32`。

### 12.4 重训流程（`README.md`）

```bash
# 1. 在机器人上录数据
arecord -D plughw:aic3104,0 -f S16_LE -r 16000 -c 1 -d 30 /tmp/petting_01.wav
#    放进 data/petting/ 和 data/normal/（走路、电机、环境音——任何不是摸头的）

# 2. 构建特征提取器
cargo build --release -p pet-detect --bin pet-features

# 3. 训练
uv run --with torch --with onnx training/train.py

# 4. 提交刷新后的 models/pet_detect.onnx
```

⚠️ **`data/` 不在仓库里** —— `README.md` 明说 *"the recordings themselves are not vendored here"*。

### 12.5 归一化在训练里，不在模型外

```python
# training/train.py:101-103
# Per-dataset mean/std normalization. Stored in the ONNX as a Sub/Div is overkill;
# since features.rs and detect.rs share lib.rs, we normalize inside training only —
# the model will learn batch-norm offsets to absorb it. Keep features unnormalized.
```

**"因为 `features.rs` 和 `detect.rs` 共用 `lib.rs`，我们只在训练里归一化 ——
模型会学到 batch-norm 的偏移把它吸收掉。"**

这是一个"因为共享了代码，所以可以省掉一件事"的例子：
如果两边是两份实现，就**必须**把均值和方差存进模型里再对齐。

---

## 13. 测试：7 个

```bash
cargo test -p pet-detect
```

| 文件 | 数量 |
|---|---|
| `lib.rs` | 2 |
| `worker.rs` | 5 |
| 两个二进制 | 0（它们是开发工具） |

### 13.1 `lib.rs` 的 2 个

| 测试 | 行 | 验什么 |
|---|---|---|
| `the_feature_contract_is_pinned` | `:360` | **那 9 个数字**（动了就要重训） |
| `log_mel_reacts_to_signal` | `:370` | 静音走地板、正弦不走 |

### 13.2 `worker.rs` 的 5 个 —— 全都在测那个门

| 测试 | 行 | 验什么 |
|---|---|---|
| `a_quiet_room_never_arms_the_classifier` | `:453` | 安静房间永不开门 |
| `a_sound_arms_the_classifier_and_the_arming_outlives_it` | `:464` | 有声音就开，**而且能跨过抚摸的间隙** |
| `the_arming_runs_out_after_the_hold` | `:478` | **而且会自己过期** |
| `the_hold_covers_a_whole_window` | `:491` | 保持时长 ≥ 一个窗口 |
| `the_gate_opens_below_the_event_threshold` | `:504` | 门开在**低**那个阈值上 |

### 13.3 ⭐ 第一个测试的注释值得抄下来

```rust
// pet-detect/src/worker.rs:447-451
/// **The point of the gate.** A room with nothing happening in it never arms the
/// classifier, so the hundred FFTs and the forward pass never run.
///
/// **A regression is silent in exactly the way the camera one is: petting still works,
/// and the only symptom is a robot warmer than it needs to be.**
```

**"一个回归是完全静默的，就像摄像头那个一样：摸头照常工作，
唯一的症状是机器人比它需要的更热。"**

**这就是为什么这个门需要测试** —— 它坏了没有任何人会注意到，
除了电池续航和温度。

第三条测试（`:478`）的理由也一样简洁：

> And it lets go, or the gate would be a one-way switch and **the saving would last until the
> first door slammed.**

**"否则这个门就是一个单向开关，省下的开销只能维持到第一次有人摔门。"**

---

## 14. 几处读者会绊到的地方

按仓库的规矩，代码与文档不一致的地方，这里只**陈述事实**，不判断该怎么办。

### 14.1 ⚠️ `probs[1]` 的类别下标没有测试

```rust
// pet-detect/src/lib.rs:322-323
let (_shape, probs) = outputs[0].try_extract_tensor::<f32>()?;
let p = probs[1];
```

那个 `1` 的意思是"第 1 类 = 摸头"，而它由 `train.py` 里**两行**决定：

```python
# training/train.py:96-97
Xn, yn = load_class(DATA / "normal", 0)
Xp, yp = load_class(DATA / "petting", 1)
```

**这三处之间没有任何东西把它们绑在一起。** 把 `train.py` 里那两个 `0`/`1` 对调，
模型照样训练成功、照样导出、`lib.rs` 照样读 `probs[1]` ——
**只是现在读出的是"正常"的概率**，而症状是机器人对着安静的房间咕咕叫、摸头时不叫。

对比一下 §6 那条:特征排布有 `the_feature_contract_is_pinned` 守着（`lib.rs:360`），
**而类别顺序没有对应的测试。**

### 14.2 那个"1 秒"的保持有两份，一份是推导的、一份是字面量

```rust
// worker.rs:49 —— 推导出来的，且注释解释了为什么字面量 31 是错的
const AUDIBLE_HOLD_FRAMES: u32 = (crate::WINDOW_SAMPLES as u32).div_ceil(SENTRY_FRAME);  // = 32

// worker.rs:123 —— 字面量，同一个"~1 秒"
self.petting_hold_frames = 31; // ~1 s hangover after petting
```

`AUDIBLE_HOLD_FRAMES` 算出 **32**（1.024 s），而摸头静音用的是写死的 **31**（0.992 s）。
两个都是"大约一秒"，但**只有前者被推导出来**，而且 `worker.rs:46-48` 恰好说了
"31 帧不是一秒"。见 §9.3。

（两者用途不同 —— 门控要保持**覆盖一整个窗口**，静音只要"大约一秒" ——
所以这不是一个 bug，但它是一处读起来会绊一下的地方。）

### 14.3 `deploy/robotd.toml` 里这个 crate 的开关显示了**错的**默认值

`deploy/robotd.toml:34-35` 定了这个文件自己的约定：

> Every value below that is commented out **shows the built-in default**. LEAVE IT COMMENTED
> unless this robot genuinely needs a different value

而 `[audio]` 那一段（`deploy/robotd.toml:301`）写的是：

```toml
# pet_detect = true
```

**内置默认是关的**（`pet_detect: None` → `pet_detect_resolved()` → `false`，见 §11.2），
而同一段散文的上方也写着 *"Unset means off"*。

**按这个文件自己的约定，这一行应该是 `# pet_detect = false`。**

> 📌 形状和我之前报过的 `[duck_detector] # enabled = true`（`deploy/robotd.toml:357`，
> 默认也是 `false`）**一模一样**。这是第二处。
> 这两个逃得过测试的原因是相同的：`the_shipped_example_matches_the_defaults` 比的是
> **未被注释的**值，而这两行都被注释掉了。

### 14.4 `[policy] enabled = true` 没有被注释

`deploy/robotd.toml:101` 是这个文件里**唯一一处未被注释的 `enabled`**，值等于默认（`true`）。
它不违反"值要正确"，但它违反了上面那条"LEAVE IT COMMENTED"的规则 ——
而那条规则的理由是：**未被注释的值会被永久冻结在那块板子上**。

### 14.5 环境音哨兵的事件还没有消费者

`SoundEvent`（`Noise` / `Voice`）这条路径从麦克风一路走到 `robotd`，
然后在 `robotd/src/main.rs:2247-2249` 只打一条 `debug` 日志。
注释说明了原因（*"until the autonomous brain arrives"*），但值得知道：
**这条路径上除了"台架调音用的数据"之外，没有任何东西在读它。**

---

## 15. 阅读路线

| 步 | 读什么 | 为什么先读它 |
|---|---|---|
| 1 | `pet-detect/README.md` | 最短，而且**含重训流程** |
| 2 | `pet-detect/src/lib.rs:1-37` | 模块文档 + **那 9 个常数** |
| 3 | `pet-detect/src/lib.rs:291-347` | `push_samples` —— 门控、推理、迟滞都在这里 |
| 4 | `pet-detect/src/lib.rs:39-104` | `MelExtractor`。对着 §5 读 |
| 5 | `pet-detect/src/worker.rs:35-49` | **那个推导出来的常数**，整份代码里最好的一段注释 |
| 6 | `pet-detect/src/worker.rs:88-152` | 门控和哨兵 |
| 7 | `pet-detect/src/worker.rs:284-374` | arecord 的生命周期和退避 |
| 8 | `pet-detect/src/bin/features.rs`（50 行） | **训练/推理一致性**的落地 |
| 9 | `pet-detect/training/train.py:96-105` | 类别顺序和归一化 |

**如果只有十分钟**：读 `README.md`，然后读 `worker.rs:35-49` 那段注释，再读 §3。

三条贯穿全文的主线：

1. **契约要钉住。** 特征的排布是训练契约，所以有测试；"大约一秒"是错的，所以写推导。
2. **能不算就不算，但不能因此算错。** 门控省掉每秒四次的推理，
   可它**不能**关掉"结束"那条路 —— 否则机器人会相信自己永远在被抚摸。
3. **可选的设备不能让 daemon 倒下。** 模型没有、声卡没有、ONNX Runtime 加载不了 ——
   三种都只 `warn`，机器人照常走路。**"分类器是一个特性，不是机器人本身。"**

---

## 16. 术语表

| 词 | 意思 |
|---|---|
| **采样率（sample rate）** | 每秒采多少个点。这里是 16,000 Hz |
| **PCM** | 最原始的音频格式：一串数字。`S16_LE` = 16 位有符号小端 |
| **RMS** | 均方根。一帧的"平均响度" |
| **FFT** | 快速傅里叶变换：把一段波形拆成"各个频率各有多强" |
| **bin** | FFT 输出的一个频率格。512 点 FFT → 257 个 bin |
| **窗（window）** | 做 FFT 之前乘上的平滑曲线（这里是 Hann），防止边界突变造成假频率 |
| **帧（frame）** | 一次 FFT 看的那一小段音频（这里 25 ms） |
| **hop / stride** | 相邻两帧之间走多远（这里 10 ms） |
| **频谱图（spectrogram）** | 帧 × 频率的二维表。**这个 crate 把它当图像** |
| **mel** | 模仿人耳感知的频率刻度。低频分辨率高，高频低 |
| **滤波器组（filterbank）** | 一组三角形，把 257 个 bin 合并成 40 个频带 |
| **log-mel** | 取过对数的 mel 频谱。**这个模型的输入** |
| **CNN** | 卷积神经网络。这里用在频谱图上 |
| **GAP** | 全局平均池化。把特征图平均成一个数 —— **模型小的关键** |
| **ONNX** | 描述训练好的模型的通用格式。`.onnx` 是那个文件 |
| **ONNX Runtime / `ort`** | 跑 ONNX 模型的运行时。板子上只有一份，两个 crate 共用 |
| **迟滞（hysteresis）** | 进入和离开用两个不同阈值，防抖。**0.95 / 0.85** |
| **地板（floor）** | 房间里"安静时有多响"的估计。**它会慢慢适应** |
| **哨兵（sentry）** | 那个量环境音的组件。纯 RMS，没有 ML |
| **门控（gate）** | "要不要跑分类器"的开关。**省掉每秒四次的推理** |
| **保持 / hangover** | 声音过去之后还维持一段时间的状态 |
| **瞬态（transient）** | 短促的响声：拍手、关门 |
| **arecord** | ALSA 的命令行录音工具。这里当子进程用 |
| **ALSA** | Linux 的音频接口 |
| **DKMS** | 内核模块的动态编译机制。音频编解码器的驱动靠它 |
| **退避（backoff）** | 失败后越等越久，防止疯狂重试 |
| **契约测试** | 钉住"排布/顺序"而不是行为的测试。因为排布变了不会崩，只会悄悄变差 |
| **train/infer parity** | 训练和推理用**完全相同**的特征代码 |
| **`#[cfg(test)]`** | 只在测试时编译的部分 |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| 重训的完整流程 | [`../pet-detect/README.md`](../pet-detect/README.md) |
| `[audio]` 的 schema 和默认值 | [`robotd-params-primer.md`](robotd-params-primer.md) |
| 音频硬件：编解码器、DKMS、设备树 | [`deploy-primer.md`](deploy-primer.md) |
| 那个跑 worker 的控制环（姊妹篇） | [`robotd-primer.md`](robotd-primer.md) |
| 另一个检测器：看图像而不是听声音（姊妹篇） | [`duck-detect-primer.md`](duck-detect-primer.md) |
| 另一个 ONNX 消费者：策略网络 | [`duck-control-primer.md`](duck-control-primer.md) |
| 声音是怎么合成出来的 | [`design/robotd-design.md`](design/robotd-design.md) |
| 配置文件长什么样 | [`deploy-primer.md`](deploy-primer.md) · [`robot/cheatsheet.md`](robot/cheatsheet.md) |
| 手柄（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| 手柄 IMU（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| 机器人走到哪了（姊妹篇） | [`odometry-primer.md`](odometry-primer.md) |
| 关节角 → 空间中的点（姊妹篇） | [`kinematics-primer.md`](kinematics-primer.md) |
| 摄像头、WebRTC、远程网关（姊妹篇） | [`mediad-primer.md`](mediad-primer.md) |
| 公共线上契约（姊妹篇） | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| BLE 的线上契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| 蓝牙门房（姊妹篇） | [`btd-primer.md`](btd-primer.md) |
| wifi、身份、手柄配对（姊妹篇） | [`configd-primer.md`](configd-primer.md) |
| 发布怎么把自己装到板子上（姊妹篇） | [`hooks-primer.md`](hooks-primer.md) |
| 笔记本上的客户端（姊妹篇） | [`duckctl-primer.md`](duckctl-primer.md) |
| 仿真的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| 机器人上的那个 CLI（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| 装机、更新、诊断的那些工具（姊妹篇） | [`scripts-primer.md`](scripts-primer.md) |
| 鸭子的嗓子：可播种的合成器（姊妹篇） | [`sounds-primer.md`](sounds-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 头部的两个传感器：深度与 IMU（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
