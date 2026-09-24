# `sounds/` 新手导读

> **这是一份阅读指南，不是设计文档。**
>
> 这个目录是鸭子的**嗓子**：约 5,900 行 Rust，从一颗整数种子推导出一只鸭子全部的叫声。
> 声音在**机器人上**是什么、由谁播放，由 [`robotd-primer.md`](robotd-primer.md) 拥有；
> 音频硬件（TLT320AIC3104 codec、I²S 时钟）由 [`deploy-primer.md`](deploy-primer.md) 拥有；
> 合唱用的蓝牙信标契约由 [`duck-ble-primer.md`](duck-ble-primer.md) 拥有。
> 若本导读与代码不一致，以代码为准（见根目录 `CLAUDE.md`）。
>
> 姊妹篇：[`robotd-primer.md`](robotd-primer.md)（谁在播放、什么时候播放）、
> [`padd-primer.md`](padd-primer.md)（按键怎么变成叫声）、
> [`duck-ble-primer.md`](duck-ble-primer.md)（合唱的信标）、
> [`pet-detect-primer.md`](pet-detect-primer.md)（鸭子的"耳朵"）、
> [`kinematics-primer.md`](kinematics-primer.md)（特雷门用到的 `hand` 模块）。

## 目录

1. [一分钟版](#1-一分钟版)
2. [⚠️ 四件事别搞混](#2-️-四件事别搞混)
3. [⭐ 核心心智模型：声音是**推导**出来的](#3--核心心智模型声音是推导出来的)
4. [四种声音，三种时间尺度](#4-四种声音三种时间尺度)
5. [`sounds` crate 地图](#5-sounds-crate-地图)
6. [一次「叫一声」的完整旅程](#6-一次叫一声的完整旅程)
7. [性格：一个整数如何变成一副嗓子](#7-性格一个整数如何变成一副嗓子)
8. [⭐ 为什么 RNG 是自己写的](#8--为什么-rng-是自己写的)
9. [和声（chorale）：一个完整的小系统](#9-和声chorale一个完整的小系统)
10. [特雷门（theremin）：同一个合成器，翻过来用](#10-特雷门theremin同一个合成器翻过来用)
11. [命令行](#11-命令行)
12. [几处读者会绊到的地方](#12-几处读者会绊到的地方)
13. [阅读路线](#13-阅读路线)
14. [术语表](#14-术语表)

---

## 1. 一分钟版

`sounds/` 回答一个问题：

> **一只鸭子应该是什么声音，这个声音从哪来？**

答案只有一句话：

> **每只鸭子的嗓子是从它芯片里的序列号推导出来的。没有一个是录制或存储的。**

```
SoC 序列号 (efuse, 烧在芯片里, 刷机也不变)
      │ sha256, 取前 4 字节
      ▼
   seed: u32                       ← 一只鸭子的全部身份
      │ Personality::from_seed
      ▼
   Personality                     ← 20 多个性格参数（音高、颤音、沙哑度…）
      │ 7 个 tag × 各自的 recipe
      ▼
   /var/lib/robot/sounds/**/*.wav  ← 82 个 wav 文件，"the bank"
```

**这个设计最漂亮的地方在于它的副作用**：声音本身就是身份。说得最好的是 `robotctl` 里那个 `quack` 命令：

> `robotctl/src/main.rs:542-544` — `robotctl quack`: **the loudest way to tell ducks apart.** SSH
> into one, quack it, and the robot that answers **in its own voice** is the one you're talking
> to: every voice bank is seeded from the SoC serial, so **the voice itself is an identity.**

**"最响亮的区分鸭子的方法。"**

`Cargo.toml:1-5` 讲了为什么这件事必须发生在机器人上：

> Ported from `apirrone/microduck_sounds` (Python/numpy) so a release carries its own voice
> generator **instead of a pip install** — the bank renders **on-device in a few seconds of
> Rust** rather than **minutes of numpy on a venv nobody provisioned.**

---

## 2. ⚠️ 四件事别搞混

这是读这个目录时**最容易搞错**的地方。名字都像，职责完全不同：

| # | 是什么 | 在哪 | 谁执行 | 什么时候 |
|---|---|---|---|---|
| **①** | **bank**：预先渲染好的 wav | `/var/lib/robot/sounds/` | `sounds ensure-bank` | 每次安装 |
| **②** | **播放**：挑一个 wav，喂给 `aplay` | `robotd/src/sound.rs`（947 行） | `robotd` | 运行时 |
| **③** | **实时合成**：边算边放 | `sounds/src/stream.rs`（838 行） | `robotd` 的一个写线程 | 特雷门 |
| **④** | **和声编排**：离线渲染一个四声部 | `sounds/src/chorale/`（2,900 行） | `sounds chorale` / `robotd` | 合唱 |

**最容易搞错的是 ③。** `sounds/src/stream.rs` 的开头第一句就在纠正这个直觉：

> **The duck's voice, held open: a block-wise synth driven by live parameters.** (`stream.rs:1`)
>
> Every other sound in this crate is a *recipe* — a whole vocalisation rendered offline from a
> frequency curve the recipe writes down **in advance**. That is the right shape for a quack,
> and **the wrong one for anything the robot must sing *while* something outside it moves.**
> The ToF theremin's pitch is a hand's distance, known only 15 times a second and **never in
> advance**, so the frequency curve **cannot be written down**: it has to be integrated as it
> arrives. (`stream.rs:3-8`)

**"它必须在信号到达的时候被积分出来。"**

所以：

- **`stream.rs` 不播放任何东西。** 它只**产出** `f32` 样本。
- **所有播放都在 `robotd/src/sound.rs`**，通过 `aplay` 子进程。
- `sounds/` 这个 crate 里**没有一行播放代码**。

---

## 3. ⭐ 核心心智模型：声音是**推导**出来的

`sounds/src/lib.rs:3-7` 是这个 crate 的整个论点：

> A single integer seed deterministically derives a `Personality` — pitch register, harmonic
> tilt, nasality, vibrato, quackiness, tempo. **Two seeds sound like two different creatures;
> the same seed always sounds the same.** Each sound **tag** has several **variants** (small
> re-rolls within the same voice) so **the duck doesn't sound like a stuck recording.**

### 3.1 种子从哪来

`lib.rs:132-153` 的 `hardware_seed()`：

```
1. /proc/device-tree/serial-number   ← 首选：烧在芯片 efuse 里，刷机也不变
2. /etc/machine-id                   ← 后备：每次装系统会变
3. 两个都读不到 → 报错
```

为什么用序列号而不是 UUID，`lib.rs:128-131` 讲了：

> The serial is burned into the chip, **survives reflashes**, and the supported boards expose it
> at the same path. … **sha256 decorrelates consecutive factory serials so two robots from the
> same batch don't get neighbouring (and thus meaninglessly different) seeds.**

**"sha256 让同一批次出厂的两只鸭子不会拿到相邻（因而毫无意义地相似）的种子。"**

### 3.2 哈希只用前 8 个十六进制位

`lib.rs:155-158`：

> `sha256(id)`, first 8 hex chars as u32 — **the exact derivation the Python installer used**,
> so **a robot keeps the seed (and personality traits) it already had.**

而这一条被**测试钉住了**（`lib.rs:167-172`）：

```rust
/// The seed derivation is the robot's identity — pin it against the shell original
/// (`sha256sum | cut -c1-8` read as hex).
#[test]
fn the_seed_derivation_matches_the_installer() {
    // printf 'test-serial' | sha256sum → c96f1146...
    assert_eq!(seed_from_id("test-serial"), 0xC96F_1146);
}
```

**"种子的推导就是这个机器人的身份 —— 把它钉在 shell 原版上。"**

### 3.3 ⚠️ 唯一的例外：`DUCK_IDENTITY`

`lib.rs:134-140` 有一段关于模拟器的注释：

> **One machine, several ducks** — the one situation where deriving identity from hardware is
> wrong. The simulator runs a robot per container, or several on one laptop, and they would
> otherwise share a serial and therefore a voice ***and a chorale id***: that id is how a duck
> recognises its own beacon reflected back, so **identical ducks drop each other's beacons as
> their own and can never hear anybody.** **Nothing on a robot sets this.**

**"没有任何一台机器人会设置这个变量。"**

### 3.4 `BANK_VERSION`：什么时候重渲染

`lib.rs:41-43`：

> Bump when the synth changes enough that existing banks should re-render on the next install —
> the `.seed` marker includes it, so old banks stop matching and regenerate.
> **v4 was the last Python bank; v5 is the Rust port** (new RNG, 48 kHz native).

⚠️ **而这次升级有一个可见后果**（`lib.rs:17-20`）：

> the random streams are not numpy's, and rendering is 48 kHz native instead of 22.05 kHz +
> resample — so **every robot's voice re-rolls once** when the bank regenerates. That is a
> **bank-version bump**, the same event as a synth retune upstream, **not data loss**: the voice
> is derived from the SoC serial and **stays stable from here on**, guarded by the pinned-RNG
> test in `rng.rs`.

**"每只鸭子的嗓音会重掷一次 —— 这是重新生成，不是数据丢失。"**

---

## 4. 四种声音，三种时间尺度

这是理解整个目录最好的一个分类法。**问的不是"这是什么声音"，而是"形状什么时候才知道"。**

| 种类 | 形状何时知道 | 谁生成 | 例子 |
|---|---|---|---|
| **一次性** | **提前**，完全已知 | bank 里的 `.wav` | `greet` `chirp` `peck` `coo` `alarm` `inquire` |
| **分段** | 提前，但**长度不定** | 三段 wav，流式喂给一个 `aplay` | `wheee`（骑行） |
| **实时乐器** | **永远不知道** | `sounds::Stream`，一个 block 一个 block | 特雷门 |
| **合奏** | 提前，但**由别的鸭子触发** | 每只鸭子渲染自己的声部 | 合唱 |

### 4.1 一次性：7 个 tag

`lib.rs:49-58` 是**全部**的 tag：

| tag | `duck-ipc-proto` 里的描述（`lib.rs:2134-2153`） | 谁触发 |
|---|---|---|
| `alarm` | *Sharp honk.* | **只有客户端**（见 §12） |
| `greet` | *Wake-up quack (sometimes a double "wak-wak").* | `robotd` 启动时（`main.rs:1999`） |
| `inquire` | *Rising question.* | **只有客户端** |
| `peck` | *Low "tock" — the goodbye before power-off.* | 关机前（`main.rs:2483` `:2496`） |
| `chirp` | *The mouth-trigger quack. `robotctl quack` plays this.* | 嘴部触发（`main.rs:2306` `:2308`） |
| `coo` | *Drowsy, breathy — the petting response.* | 被抚摸时（`main.rs:2237`） |
| `wheee` | *The held joy ride: start → loop while held → end.* | `padd`（`padd/src/main.rs:865`） |

**变体数量是分级的**（`lib.rs:59-67`）：

> How many variants each tag gets. The robot picks a random variant at play time, so **more
> variants directly means a more organic-feeling duck.** `chirp` (mouth trigger) and `greet`
> (wake-up) are **the most-heard tags, so they get the most.**

```rust
"greet" | "chirp" => 12,     // 听得最多
"wheee"           =>  6,     // 但有 3 段，所以 18 个文件
_                 => 10,
```

总数：`10 + 12 + 10 + 10 + 12 + 10 + 6×3 = 82` 个 wav（`lib.rs:179` 的测试钉住了这个数）。

### 4.2 分段：`wheee` 的两次退出

`wheee`（骑行时的"呜——"）被切成 **start / loop / end** 三段，因为**长度取决于骑多久**。

`robotd/src/sound.rs:9-15` 讲了为什么"退出"有两种，而它们**不是同一件事**：

> **The wheee ride streams into a single `aplay`**: start → loop (repeating while held) → end,
> written by a paced thread so the pipe **never queues more than ~250 ms** — else the release
> would land that late. The ride has *two* exits, and they are not the same:
> **a client that says "released" cuts it** (kill the child, the writer exits on the broken
> pipe), while **a hold that merely went stale lands it** — the writer is let out of its loop
> and writes the end segment into a pipe that is still open.
> **Only the second one ever plays `wheee_end_*`, which is why `Ride` is a state and not a bool.**

**"只有第二种会播放 `wheee_end_*`，这就是为什么 `Ride` 是一个状态而不是一个布尔值。"**

### 4.3 实时：特雷门 —— 见 §10

### 4.4 合奏：合唱 —— 见 §9

---

## 5. `sounds` crate 地图

```
sounds/
├── Cargo.toml          依赖只有 4 个：anyhow · clap · hound · sha2
├── scores/
│   ├── wistful.duckscore   ← 船载的那首曲子，同时是文本文法的文档
│   ├── duck_strut.mid      ← MIDI 导入的例子
│   └── outer_wilds.mid
└── src/
    ├── lib.rs          186  ← 门面：seed → bank，以及 TAGS 表
    ├── rng.rs          153  ← ⭐ 自己写的 xoshiro256++
    ├── personality.rs  191  ← 一个 seed → 20 多个性格参数
    ├── synth.rs        260  ← DSP 原语（振荡器、滤波器、包络），48 kHz
    ├── voices.rs       452  ← 7 个 tag 的"配方"
    ├── stream.rs       838  ← ⭐ 实时合成器（特雷门用）
    ├── main.rs         443  ← 命令行
    └── chorale/      2,900  ← 合唱那一半
        ├── mod.rs     1485  ← 声部、音符、元音、座位
        ├── midi.rs     852  ← 自己写的 MIDI 解析器
        ├── beat.rs     521  ← 节拍：指挥的信标，跟随者的相位平均
        └── text.rs     516  ← `.duckscore` 文本格式
```

**依赖只有 4 个**（`Cargo.toml:14-18`），其中 `hound` 是 wav 写入、`sha2` 是种子推导、
`anyhow`/`clap` 是每个 crate 都有的。**整个 DSP、RNG、MIDI 解析都是自己写的。**

---

## 6. 一次「叫一声」的完整旅程

以 `chirp`（摸一下嘴，"嘎"一声）为例：

```
   ① 触发
      padd / 嘴部传感器 / robotctl quack
            │  JSON-RPC: robot.sound { tag: "chirp" }
            ▼
   ② 意图
      robotd/src/intents.rs
            │  放进一个队列，由 50 Hz 控制环取走
            ▼
   ③ 播放（robotd/src/sound.rs:281 `play`）
      ├─ 检查 ride 是否占着 PCM（:290）→ 是就跳过
      ├─ stop_child()              ← ⭐ 杀掉上一个
      ├─ pick("chirp")             ← 随机挑一个变体
      └─ spawn aplay <wav>
            ▼
   ④ 出声
      aplay → I²S → TLV320AIC3104 codec → 喇叭
```

### 6.1 ⭐ "一次只有一个孩子，新的声音会杀掉它"

`sound.rs:3-8` 把这个性质**追到了硬件**：

> Ported from the prototype's `play_voice` / `start_wheee`. **The codec PCM is exclusive and
> single-client**, which two properties fall out of:
>
> - **One playing child, and a new sound kills it.** That is what lets someone **spam the chirp
>   trigger cleanly** — each press cuts the previous call off — and **why everything that plays
>   goes through this one struct, owned by the control loop.**
> - The wheee ride streams into a single `aplay` …

**"编解码器的 PCM 是独占的、单客户端的。"** 这不是设计选择，是**硬件的约束** ——
而代码把它变成了一个特性：连按嘴部触发器听起来很自然，因为每一声都干净地掐掉前一声。

### 6.2 播放就是 spawn

`sound.rs:26-28`：

> **Playing is spawning**: nothing here blocks the 50 Hz tick **except the deliberately blocking
> goodbye peck right before power-off**, when there is no tick left to miss — and that one is
> **bounded**, because **a wedged PCM must not be able to hold up the power-off.**

那个界限是（`sound.rs:40-41`）：

```rust
/// How long the blocking goodbye peck may hold up the power-off. The longest bank sound is
/// well under a second; this is a ceiling on a wedged PCM, not a playback budget.
const BLOCKING_PLAY_MAX: Duration = Duration::from_millis(1500);
```

**"这是一个卡死的 PCM 的上限，不是播放预算。"**

### 6.3 bank 不见了会怎样

`sound.rs:293-301` 只警告**一次**（`warned_missing` 标志），然后**静默地跳过所有声音**：

```
no voice bank — sounds are skipped (run `sounds ensure-bank`)
```

这正是 `hooks/postinstall:76-82` 那一句的理由：

> **A warning, not a failure: a robot without a voice walks.**
>
> ```
> postinstall: could not render the voice bank; the robot stays quiet
> ```

**"没有嗓子的机器人照样会走路。"**

---

## 7. 性格：一个整数如何变成一副嗓子

`personality.rs:1`：*"A `Personality` derives stable per-robot vocal traits from a single seed."*

### 7.1 那 23 个参数

`sounds show` 会把它们全部打出来（`main.rs:141-164`）：

| 组 | 参数 | 直觉 |
|---|---|---|
| **音高** | `pitch_center_hz` · `register` · `pitch_spread` · `glide_bias` | 高还是低、滑音往上还是往下 |
| **音色** | `brightness` · `tilt` · `nasal` · `harmonic_skew` · `formant_n` · `formant_gain` | 明亮/闷、鼻腔共鸣、共振峰在哪 |
| **颤动** | `vibrato_rate_hz` · `vibrato_depth` · `jitter_depth` | 颤音快慢深浅、音高毛刺 |
| **噪声** | `breath` | 气声 |
| **鸭子味** | `quackiness` · `am_rate_hz` · `am_depth` | "嘎"的程度、振幅调制 |
| **摇摆** | `warble_hz` · `warble_depth` | 抖音 |
| **包络** | `attack_sharpness` · `speed` | 起音多陡、整体快慢 |

`personality.rs:7-9` 讲了为什么**要这么多**：

> The trait set is **deliberately wide**: register (octave shift), harmonic tilt, formant
> emphasis, glide bias, quackiness — **each one alone is enough to make two seeds feel like
> different creatures.**

**"每一个单独拿出来，都足以让两个种子感觉像两种不同的生物。"**

### 7.2 变体：同一副嗓子的小重掷

`personality.rs:3-5`：

> Two robots with different seeds sound recognisably different; **the same robot is consistent
> across runs.** Variants within a tag **re-roll a small sub-seed** so the duck doesn't sound
> like **a stuck recording.**

实现是一个从 `(tag, variant)` 派生的独立 RNG（`personality.rs:111` `variant_rng`）——
所以"第 3 个 chirp"永远是同一个"第 3 个 chirp"，但和"第 4 个"不同。

### 7.3 recipe 拿性格当画画的颜料

`voices.rs:1-5`：

> Recipes paint with the personality's traits — pitch center, register, glide bias, harmonic
> tilt/formant, quackiness, warble — so **the *same* recipe on two different seeds gives two
> recognisably different ducks.**

**"配方不是声音本身，是画声音的笔法。"** 7 个 recipe（`voices.rs:64` 到 `:404`）就是 7 支笔。

---

## 8. ⭐ 为什么 RNG 是自己写的

这是整个 crate 里**最值得读的一段注释**（`rng.rs:1-13`）：

> The Python original used `np.random.default_rng` (PCG64 + numpy's distributions). **A robot's
> voice is *derived*, not stored** — the bank is re-rendered from the seed on every install that
> bumps the bank version — **so the generator IS the voice.** Depending on `rand` for it would
> tie every duck's voice to **whichever algorithm that crate ships this year**; `StdRng`
> explicitly reserves the right to change. **Forty lines of xoshiro we own cannot drift.**
>
> xoshiro256++ seeded through splitmix64 (both public domain, Blackman & Vigna). Uniforms take
> the top 53 bits; normals are Box–Muller. **None of it needs to match numpy** — the port
> re-rolls every voice once, and the bank version bump makes that **a regeneration, not a
> corruption.**

**"生成器就是嗓音本身。"**

### 8.1 这句话的一般形式

把它抽出来，就是一条**可以带走的工程原则**：

> **当一个随机数生成器的输出是被持久化的产物时，这个生成器就是那个产物的一部分，
> 它属于你的代码，不属于你的依赖。**

`rand` 的 `StdRng` **明确保留改变算法的权利** —— 那是给"随机数用完即弃"的场景设计的。
这里不是：这里的每个随机数都会变成一个 wav 文件，留在机器人的磁盘上。

**"我们自己拥有的四十行 xoshiro，不会漂。"**

### 8.2 那四十行有多小

`rng.rs:16` 的 `Rng` 结构体，公开方法只有 6 个（`rng.rs:54-87`）：
`random` · `uniform` · `integers` · `choice` · `standard_normal` · `standard_normal_vec`。

而 `from_seed` 的注释（`rng.rs:23-25`）说明了为什么用 splitmix64 展开：

> Seed from a u32, as the Python did (`seed & 0xFFFFFFFF`). **splitmix64 expands it into the
> four xoshiro words so small seeds still start well-mixed.**

**"小种子也能从充分混合的状态开始。"** —— 否则种子 0、1、2 的头几个输出会很像。

---

## 9. 和声（chorale）：一个完整的小系统

这是 `sounds/` 里最大的部分（2,900 行），也是**最独立**的一块：
它在笔记本上把四只鸭子的合唱**离线渲染**出来，为了在真的联网之前就能判断编曲好不好听。

`chorale/mod.rs:3-7`：

> This module is **the *musical* half** of the duck chorale, and it is **deliberately separate
> from the half that will be hard on real hardware** (finding each other, agreeing on a clock).
> It renders an ensemble offline, on a laptop, **so the arrangement can be judged before a
> single packet is sent between two ducks** — and so that when the sync work starts, **"does it
> sound good" is already answered and only "is it together" is in question.**

### 9.1 ⭐ 身份是音色，不是音高

这是整个合唱设计里最反直觉、也最重要的一条（`mod.rs:9-21`）：

> Every duck's voice is derived from its SoC serial, and **the loudest thing that varies is
> `Personality::pitch_center_hz`** — a duck is high or low. **Letting that shift the *notes*
> would be the obvious way** to keep each duck sounding like itself, and **it would wreck the
> piece**: four ducks singing a chord each **in their own tuning** is four ducks **out of tune
> with each other. Beating, not harmony.**
>
> So **the note is absolute**, from one shared reference (`A4_HZ`, equal temperament), and what
> each duck keeps is **everything else**: harmonic weights, formant, nasality, breath, and the
> tamed remains of its vibrato. **Register is used instead for *casting*** — the lowest duck
> sings bass — and for choosing what key the piece lands in, **so nobody is asked to sing
> outside the range their own voice was rolled for.**

**"显而易见的做法会毁掉这首曲子：四只鸭子各自按自己的调子唱一个和弦，就是四只鸭子互相走调。
是拍频，不是和声。"**

### 9.2 ⭐ 完美同步是错误的目标

`mod.rs:23-35`：

> Four voices starting a note on the same sample and holding the same frequency **do not sound
> like a choir; they sound like one organ with a thick stop.** What makes an ensemble is that
> its members are ***almost* together and *almost* in tune**: a few cents of pitch spread and a
> few tens of milliseconds of onset spread. **Both are added here on purpose**, derived from
> each duck's seed so **a given group always sounds like that group.**
>
> That is also **the answer to how tightly real ducks will have to agree on a clock: the target
> is ±20 ms, not ±1 ms, because ±15 ms is what we are deliberately adding.** A chord's *tuning*
> is what has to be exact, and **that needs no synchronisation at all** — only a shared
> reference pitch, which is a constant.

**"目标不是 ±1 毫秒，是 ±20 毫秒 —— 因为我们故意加了 ±15 毫秒。"**

**这一句话把整个同步问题缩小了一个数量级。**

### 9.3 节拍：指挥是一个信标，不是一个时钟

`chorale/beat.rs:3-19` 讲了整个方案的来由：

> Four robots singing a chord have to agree on when the beat is, to about **±20 ms**. The obvious
> way is to sync the clocks and agree a start time. **This does not do that, because there is no
> clock to sync**: the boards have **no RTC agreement and no NTP**, so establishing an offset
> would mean **a connection, a bond, and a central-role Bluetooth client that `btd` does not have.**
>
> ## The conductor is a beacon
>
> Instead, **nobody shares a clock — they share a *beat*.** The duck conducting puts a beat
> counter in its **BLE advertisement** and bumps it once per musical beat. Everyone else
> **passively scans**, and ***the arrival of a new counter value is the downbeat.*** No
> timestamps to compare, **no offset to estimate, no connection, no pairing**: passive scanning
> is the whole radio requirement, and **it is the cheapest thing a Bluetooth controller can do.**

**"新计数值的到达，就是强拍。"**

### 9.4 为什么电台的抖动不会毁掉它

`beat.rs:21-33`：

> Air time is microseconds; **the error is the *advertising slot*.** The conductor hands new
> payload to its controller and it goes out at the next slot, which `btd` spaces
> **100–150 ms** apart *on purpose* (one antenna carries BLE, the gamepad and wifi). So a
> follower hears each beat somewhere in a **50 ms window**, and — crucially — ***independently
> per beat.***
>
> Two things turn that into **±6 ms**:
>
> - The conductor **delays its *own* playback by `SLOT_MEAN_S`**, the middle of that window, so
>   it is wrong **in the same direction** as everyone else rather than early by default.
> - A follower **does not chase individual beats. It averages the *phase* over a sliding
>   window**, so independent jitter **falls as the square root of the window.**

### 9.5 ⭐ "节奏不是被估计出来的，这是修正而不是抄近路"

`beat.rs:35-41` 是这份文档里最诚实的一段失败记录：

> **The tempo is not estimated, and that was the fix rather than the shortcut.** The first
> version fitted **a straight line** through (beat, arrival) and read the tempo off its slope,
> **which is the textbook thing to do and was measurably worse**: a line fit evaluated at the
> *newest* point — **the edge of the window, which is exactly where "where are we now" is
> asked** — carries about **four times the error** it carries at the window's centre, because
> **slope uncertainty compounds with distance from the centroid.** Two simulated followers came
> out **36 ms apart.**

**"直线拟合在窗口边缘 —— 而那正是'我们现在在哪'被问起的地方 —— 带着四倍的误差，
因为斜率的不确定性会随着离质心的距离累积。"**

于是：**周期按乐谱固定，只平均相位。** 斜率项消失了。

### 9.6 分声部：按音高，不按轨道顺序

`chorale/midi.rs:14-26`：

> By **mean pitch**, not by track order — **the lowest group of notes sings bass.** Track order
> would be the obvious rule and is **wrong twice over**: notation editors write scores **top
> staff first** (soprano, alto, tenor, bass — **the reverse** of what a `Voicing` lists), and a
> file from a DAW may have the tempo track, empty tracks, or **the parts in any order at all.**
> Sorting by pitch is right **whatever produced the file**, and it is **the same rule `cast`
> uses to seat the ducks, which keeps one idea in one place.** A track *name* that says
> "Soprano" is believed first, **since a human wrote it down.**

### 9.7 为什么不引入 MIDI 库

`midi.rs:9-12`：

> **No dependency.** A Standard MIDI File is **a length-prefixed chunk format with
> variable-length delta times**, and the subset a score needs is **note-on, note-off, tempo and
> track name. That is a couple of hundred lines and no supply chain**, against a crate that
> would parse **controller automation and SysEx this will never look at.**

和 RNG 那一段是**同一个论证**：**你要的是一小部分，那就自己写那一小部分。**

### 9.8 元音：嘴型是"表演优先"

`Vowel` 有 6 个值（`mod.rs:135`）：`Ah` `Eh` `Ee` `Oh` `Oo` `Mm`。
而它的 `open()` 方法带了一段关于**偏离语音学**的注释（`mod.rs:152-156`）：

> Phonetically honest values were tried and **looked broken on the robot**: the shipped piece
> opens with six beats of `oo`, and an `oo` of 0.15 is **a duck audibly singing through a closed
> beak.** These are **stage vowels** — exaggerated open, ordered the same — because **on a robot
> the mouth is *performance* first and phonetics second. Only the hum stays closed: humming
> through a shut beak is correct, and rather charming.**

**"在机器人身上，嘴首先是表演，其次才是语音学。"**

而且（`mod.rs:132-133`）：

> The mouth opening is **the *same number* the beak servo gets**, so **the vowel is visible as
> well as audible.**

**嘴张开的数值，和舵机拿到的数值是同一个。** 不是两套映射 —— 所以看到的和听到的永远一致。

### 9.9 文本格式和 MIDI 是两个不同的入口

`text.rs:13-20`：

> **Not a general music format.** It has **no bars, no key signature, no time signature and no
> per-voice rhythmic independence** beyond what `Gesture` can express — a score where all four
> voices move in different rhythms **is not writable here**, and is exactly what the MIDI
> importer is for. **The two front ends are deliberately different shapes**: this one is for
> **writing a chorale by hand and reading it back**, that one is for **anything a notation
> editor can produce.**

而那句关于自文档的话很值得学（`text.rs:9-11`）：

> `scores/wistful.duckscore` **is the grammar's own documentation** and is embedded as
> `Score::wistful`, so **the shipped piece and the worked example are the same file and cannot
> drift apart.**

**"船载的那首曲子，和那份语法示例，是同一个文件，所以它们不可能漂开。"**

还有一条关于报错的（`text.rs:22-26`）：

> **Every failure carries the line number and the text of the line**, because the alternative —
> "invalid score" — sends someone back to stare at forty lines of chords. A score is
> **hand-written data**, so **a parse error is the normal way to find out you mistyped a note
> name.**

### 9.10 音量：为什么是 0.55

`robotd/src/sound.rs:55-63` —— 这是 `sounds/` 之外的代码，但它解释了 `sounds/` 里的一个常量：

> How loud one voice of an ensemble sings.
>
> **Under full scale, and not for headroom: four ducks in a room sum acoustically.** The offline
> preview divides its mix by the square root of the voice count for exactly this reason; **on
> real hardware nothing divides anything, so each duck has to arrive already knowing it is one
> of several.** A single duck singing alone is therefore **a little quiet, which is the right
> way round** — the alternative was **a quartet that saturated, which is what the first run on
> the robot sounded like.**

**"每只鸭子必须事先就知道自己是好几个里的一个。"**

而 `SPEAKER_ROLLOFF_HZ`（`sound.rs:65-70`）记了一个**耳朵测出来的**数字：

> Measured **by ear** rather than from a datasheet: the chorale's **130 Hz bass line did not
> come through the driver**, and this is where it starts to. `Stream::set_speaker_rolloff` uses
> it to **carry a low note on harmonics the driver can make instead of a fundamental it cannot.**

**"用一个喇叭发得出来的泛音，去代替它发不出来的基频。"** —— 这就是低音能听见的原因。

---

## 10. 特雷门（theremin）：同一个合成器，翻过来用

特雷门 = 手在鸭子嘴前面的距离 → 音高。它由 `robotd/src/theremin.rs`（489 行）驱动，
声音由 `sounds/src/stream.rs` 实时合成。

### 10.1 三个速率相遇

`robotd/src/theremin.rs:3-9`：

> Three things have to meet for that, and **they run at three different rates.** The depth
> frames arrive from `tofd` at **15 Hz** over a socket this daemon does not own. The control
> loop runs at **50 Hz** and is **the only thing allowed to touch the mouth.** The audio is
> rendered at **48 kHz** in a writer thread. **This module is where the first two meet**: a
> reader thread parks on the depth socket and leaves the newest frame in a slot, and
> `Theremin::tick` — called from the control loop, **never blocking** — turns whatever is in
> that slot into a note, a mouth opening, and a line of state for clients to watch.

### 10.2 ⭐ 一个手势，三个输出

`theremin.rs:11-15`：

> **One gesture, three outputs.** Closeness (0 at the far end of the playable band, 1 at the
> near end, from `kinematics::hand`) drives **the pitch, the level, *and* how far the mouth
> opens.** **Not three tunings of the same thing but literally one number**, because **a duck
> whose mouth opens on a different curve from its pitch reads as a mouth animation playing over
> a sound rather than as an animal making one.**

**"一个嘴型和音高用不同曲线的鸭子，读起来像是一段嘴部动画配了个音，而不是一只动物在发声。"**

### 10.3 ⭐ 为什么舍掉了"自动识别手"

`theremin.rs:17-24`：

> **An explicit mode, and nothing clever inside it.** The first version **armed**: it captured
> what was in front of the duck as a background so it could tell a hand from a wall **without
> being told**. **On a bench that worked; on a duck the same gesture armed one moment and was
> refused the next**, because ***which zones carry a usable status varies frame to frame*** and
> **a background is only as stable as the frames it was averaged from.** So the mode is now
> **something you turn on**, and while it is on **the nearest return in the band is the hand.**

**"一个背景只有它被平均的那些帧那么稳定。"**

### 10.4 速率不匹配 = 淡出，不是闸门

`theremin.rs:26-30`：

> **Rate mismatch is a fade, not a gate.** A depth frame that stops arriving — `tofd`
> restarted, the sensor dropped off the bus — **must not leave a note sounding forever, and must
> not chop one off either.** A frame older than `FRAME_STALE` takes **the level to zero and
> leaves everything else alone**, so **the instrument goes quiet and comes back when the frames
> do.** Short dropouts never reach here at all: `hand::Tracker` bridges those.

`FRAME_STALE` = **500 ms**（`theremin.rs:46`）。

### 10.5 `stream.rs` 和离线路径的四处不同

`stream.rs:22-36` 逐条列了，每一条都是"离线能做的事，实时做不到"：

| # | 差别 | 为什么 |
|---|---|---|
| **①** | **归一化是静态的** | *"a stream has no finished buffer, and **a per-block normalise would pump the level with every block**"*。改用谐波权重的**最坏同相求和**推导增益，再用 `tanh` 软削波兜住 |
| **②** | **参数会滑行** | *"Depth arrives every ~67 ms and the mouth servo is slower still; **stepping the frequency on frame boundaries would stair-step audibly**"*。每个参数用音频速率的一极滤波器滑向目标 |
| **③** | **抖动和呼吸滤波器是递归的** | 离线版卷整个缓冲区（居中滑动平均），实时版**看不到未来也看不到过去**，所以变成同样时间常数的一极滤波器。*"**The character is the same; the sample values are not**"* |
| **④** | **`Stream::block` 携带全部跨块状态** | 振荡器相位、LFO 相位、滤波器状态、被滑行的参数本身 —— *"**Concatenating its blocks gives one continuous signal with no seam, whatever the block sizes were**"* |

### 10.6 ⭐ 它还是同一只鸭子

`stream.rs:16-20`：

> **It is the same duck.** **Not a resample of the bank and not a second voice**: the harmonic
> weights are `Personality::harmonics`, the vibrato, jitter, breath and quack-AM are that
> personality's, and `Stream::wheee` applies the same softening the joy-ride recipe does.
> **A duck's theremin sounds like that duck's wheee, held for as long as the hand stays.**

**"一只鸭子的特雷门，听起来就像那只鸭子的 `wheee`，按手停留的时间一直持续下去。"**

### 10.7 写线程的领先量：0.03 秒对 0.25 秒

`robotd/src/sound.rs:22-24`：

> Its writer thread pulls blocks from a live `sounds::Stream` … and **stays much closer behind
> playback than the ride does: a ride's 250 ms lead only delays its release, while the same lead
> on an instrument is the gap between moving your hand and hearing it.**

```rust
/// How far ahead of playback the theremin writer stays. **An instrument's whole quality is
/// this number** — see the module docs for why it is not the ride's 250 ms.
const SYNTH_LEAD_S: f64 = 0.03;
```

而 block 大小也是为同一件事（`sound.rs:44-50`）：

> Audio block the theremin writer renders at a time: **10 ms**. **Short, because it bounds how
> stale the parameters can be by the time they are heard**, and the stream is **deliberately
> indifferent to block size** so this is **a latency choice and nothing else.**

---

## 11. 命令行

`sounds` 有 7 个子命令（`main.rs:25-130`）。**除了 `ensure-bank`，其余全是台面工具。**

| 子命令 | 干什么 |
|---|---|
| **`ensure-bank`** | ⭐ **发布时由 `hooks/postinstall:79-81` 调用**，幂等 |
| `show` | 打印一个 seed 背后的 23 个性格参数 |
| `render` | 渲染一个声音到 wav |
| `render-all` | 渲染全部 82 个到目录 |
| `play` | 合成一个声音并**通过 `aplay` 放出来** |
| `theremin` | **脚本化的手部扫过**，用实时合成器放出来 |
| `chorale` | 在笔记本上渲染整个四声部合唱 |

### 11.1 `ensure-bank` 为什么幂等

`main.rs:117-126`：

> Make sure this robot's voice bank exists and is current — render it if not.
>
> **Idempotent: a marker records the seed and bank version, and a matching bank is left alone**,
> so this can (and does) **run on every release install.**

`hooks/postinstall:74-76` 复述了这一点：

> `sounds ensure-bank` … **Idempotent — a marker records the seed and bank version, and a
> current bank is a no-op — so this runs on every install and only actually renders on the first
> one (or when the synth's bank version bumps).**

### 11.2 `--theremin` 是"没有手也能听"

`main.rs:60-67`：

> Audition the live theremin voice: **a scripted hand sweep** through the streaming synth.
>
> The theremin's pitch is a hand's distance and **there is no hand on a bench**, so this plays
> **the gesture instead** — approach, hold, wobble, retreat — driving `sounds::Stream` **exactly
> as `robotd` does at the frame rate the ToF actually delivers.** **It is the only way to hear a
> voice change without a robot in front of you.**

### 11.3 三个默认值都在说"目标硬件"

`play` / `theremin` / `chorale` 的 `--device` 默认都是 **`plughw:aic3104`** —— 机器人上那个 codec。
而 `chorale` 的 `--rolloff` 默认 **300 Hz**（`main.rs:108-109`）：

> Where the playback speaker stops reproducing, hertz. **Defaults to the duck's own driver, which
> is the target**; `--rolloff 0` renders for a full-range system instead.

---

## 12. 几处读者会绊到的地方

按仓库的规矩，这里只**陈述事实**，不判断该怎么办。

### 12.1 `alarm` 和 `inquire` 没有任何东西触发

7 个 tag 都被渲染进 bank，但**只有 5 个有内部触发点**（见 §4.1 的表）：
`greet` `peck` `chirp` `coo` `wheee`。

**`alarm` 和 `inquire` 在全仓库范围内，除了 `sounds/` 自己和 `duck-ipc-proto` 的枚举定义，
没有任何生产代码播放它们。**

它们**不是死的** —— `robot.sound` 这个 RPC 接受任意 `SoundTag`，所以客户端
（一个 app、一段脚本）可以放它们。但**机器人自己永远不会**。
`duck-ipc-proto/src/lib.rs:2135-2153` 的文档串就是这么写的（*"Sharp honk."* / *"Rising question."*），
而对应 `chirp` 的那条明确说了它的触发者（*"`robotctl quack` plays this."*）——
另外两个没有这样的话。

如果你在找"鸭子为什么会尖叫"的行为，它不存在；这两个是留给客户端的词汇。

### 12.2 ⚠️ `deploy/robotd.toml:301` 那个注释显示了一个不是默认值的值

`deploy/robotd.toml:293-303`：

```toml
# Listen for petting on the onboard mic and coo about it. Unset means off — the always-on
# coo wore thin — so this is an opt-in. The model ships in the release
# (models/pet_detect.onnx); thresholds are the classifier's hysteresis (enter above, leave
# below).
#
# The mic is read whenever [audio] is on, but the classifier only runs on audio that stands
# out from the room: in a quiet one this costs nothing beyond the envelope the ambient-sound
# watcher is measuring anyway.
# pet_detect = true          ← :301
# pet_model = ".../current/models/pet_detect.onnx"
# pet_enter_threshold = 0.95
# pet_exit_threshold = 0.85
```

**注释正文说 "Unset means off"（不设置就是关闭），而它下面展示的那一行是 `= true`。**
这份文件里注释掉的键**惯例上是展示默认值**，所以这一处读起来像是默认打开。

（同一个形状在 `[duck_detector]` 上已经出现过一次 —— 见 [`pet-detect-primer.md`](pet-detect-primer.md)。）

### 12.3 `Vowel::open()` 的注释在讲一个不存在的场景

`chorale/mod.rs:161-163`：

> the shipped piece **opens with six beats of `oo`**, and an `oo` of 0.15 is a duck audibly
> singing through a closed beak

而实际值（`mod.rs:163`）是 `Vowel::Oo => 0.35`，不是 0.15。**那 0.15 是被改掉之前的旧值**，
句子没跟着改。

### 12.4 `sounds/src/lib.rs:22-23` 提到的 `parrot` 模块不存在

> Not ported: the `parrot` module (mic → learned-phrase squawks) — an experiment nothing in the
> runtime shipped; **it can follow if it ever graduates.**

这是**有意**的一条记录（说明"我们没搬这个"），不是错误。但它会让读者去找一个不存在的模块 ——
提一句在这里，省得你找。

### 12.5 `render_all` 的注释说 82 个文件，但没说 `wheee` 的三段是分开的目录结构

`lib.rs:100-102` 说 *"Segmented tags write `<tag>_start_<letter>.wav` / `_loop_` / `_end_`
triads instead"*，而 `robotd/src/sound.rs:710` 是 `let dir = self.bank.join("wheee");` ——
**三段都在 `wheee/` 目录下**，靠文件名区分。这是对的，只是"triads instead"稍微绕。

---

## 13. 阅读路线

**5,900 行，但主干只有 500 行左右。**

### 路径 A：我想知道"鸭子为什么是这个声音"（约 30 分钟）

| 步 | 读什么 | 为什么 |
|---|---|---|
| 1 | §3 这张图 | 种子 → 性格 → wav |
| 2 | `sounds/src/lib.rs:1-30` | 整个 crate 的论点 |
| 3 | `sounds/src/lib.rs:120-175` | `hardware_seed` + 那个钉住身份的测试 |
| 4 | `sounds/src/personality.rs:1-30` + `:69-120` | 一个整数怎么变成 23 个参数 |
| 5 | `sounds/src/voices.rs:111-150`（`greet`）| 一个 recipe 长什么样 |
| 6 | 跑一次 `sounds show` | 亲眼看一眼 |

### 路径 B：我想改一个叫声（约 1 小时）

1. `voices.rs` 里挑一个 recipe（`voices.rs:64-404`）
2. `synth.rs:1-40`（原语和那两个 22.05 kHz 的常数）
3. **改完记得想 `BANK_VERSION`**（`lib.rs:41-43`）
4. `sounds render chirp /tmp/x.wav --seed 42` 听一下
5. `sounds show --seed 42` 看参数

### 路径 C：我只关心特雷门（约 45 分钟）

1. `sounds/src/stream.rs:1-40`（为什么需要它）
2. `robotd/src/theremin.rs:1-35`（三个速率）
3. `robotd/src/sound.rs:44-53`（两个领先量：0.03 s 对 0.25 s）
4. `sounds theremin --out /tmp/t.wav`

### 路径 D：我关心合唱（约 1.5 小时）

1. `sounds/src/chorale/mod.rs:1-40`（音色 vs 音高、完美同步是错的目标）
2. `sounds/src/chorale/beat.rs:1-45`（信标 + 相位平均 + 那次失败）
3. `robotd/src/chorale.rs:1-31`（指挥、座位、时间基准）
4. `scores/wistful.duckscore`（读一遍，它是语法文档）
5. `sounds chorale --out /tmp/c.wav`

### 三条贯穿全文的主线

1. **推导，不存储。** 声音不是一个资产，是一个**函数**。这决定了 RNG 必须自己写、
   `BANK_VERSION` 必须存在、身份和嗓音必须是同一个东西。

2. **每种声音的形状，在什么时候被知道。** 这是这个目录真正的分类轴 ——
   提前知道 → wav；长度不定 → 分段流；永远不知道 → 实时合成；别人决定 → 合奏。
   **§4 那张表比任何模块列表都重要。**

3. **在真实硬件上学到的东西，被写成了注释。** 0.55 是因为四只鸭子会声学求和；
   300 Hz 是耳朵测出来的；10 ms block 是"手到耳朵的延迟"；"自动识别手"被删掉是因为
   **一个背景只有它被平均的那些帧那么稳定**。**这些数字没有一个是猜的。**

**如果只有十分钟**：读 §2 那张表和 §8 那段 RNG 注释。

---

## 14. 术语表

| 词 | 意思 |
|---|---|
| **bank** | 预先渲染好的一整套 wav，在 `/var/lib/robot/sounds/` |
| **tag** | 声音的类别（`chirp` `coo` …），不是具体文件 |
| **variant** | 同一个 tag 的一个变体，播放时随机挑 |
| **seed** | 一个 u32，一只鸭子的全部身份 |
| **Personality** | 从 seed 推导出的 23 个嗓音参数 |
| **recipe** | 一个 tag 的合成函数：`(Personality, variant) → Vec<f32>` |
| **SR** | sample rate，采样率。这里 48,000 |
| **PCM** | 未压缩的音频样本流。`aplay` 吃这个 |
| **codec** | 音频编解码芯片。这里是 TLV320AIC3104 |
| **I²S** | 芯片之间传音频的串行总线 |
| **ALSA** | Linux 的音频层。`plughw:aic3104` 是设备名 |
| **aplay** | ALSA 的播放命令行工具 |
| **exclusive / single-client** | 同一时刻只能有一个进程占着 PCM |
| **xoshiro256++ / splitmix64** | 两个公有领域的伪随机算法 |
| **Box–Muller** | 把均匀分布变成正态分布的标准方法 |
| **谐波 / harmonic** | 基频的整数倍。音色就是各次谐波的配比 |
| **formant** | 共振峰。决定元音听起来是"啊"还是"呜" |
| **vibrato / jitter / breath** | 颤音 / 音高毛刺 / 气声 |
| **AM** | 振幅调制。`quackiness` 就是它 |
| **包络 / envelope** | 一个音的起、持、落 |
| **一极滤波器 / one-pole** | 最简单的一阶低通，用来做平滑 |
| **Slew** | 让一个参数缓慢滑向目标，避免跳变 |
| **block** | 实时合成一次渲染的一小段（这里 10 ms） |
| **软削波 / tanh** | 超过上限时平滑压住，而不是硬切 |
| **chorale** | 四声部合唱 |
| **SATB** | Soprano / Alto / Tenor / Bass，四个声部 |
| **声部 / part** | 合唱里的一条旋律线 |
| **casting** | 按嗓音给鸭子分配声部 |
| **A4_HZ** | 标准音高 440 Hz，所有鸭子共用的参考 |
| **平均律 / equal temperament** | 相邻半音频率比恒定的调音法 |
| **音分 / cent** | 半音的百分之一 |
| **拍频 / beating** | 两个接近的频率叠加产生的周期性音量起伏 |
| **强拍 / downbeat** | 一个小节的第一拍。这里指"信标计数器变了" |
| **BLE 广播 / advertisement** | 蓝牙的"我在"信号，不需要连接 |
| **被动扫描 / passive scan** | 只听广播、不发起连接 |
| **信标 / beacon** | 这里指那个携带节拍计数的广播包 |
| **相位 / phase** | 你相对节拍走到哪了。这里被平均的那个量 |
| **ToF** | Time of Flight，测距传感器。每帧 15 Hz |
| **特雷门 / theremin** | 靠手的位置控制音高的乐器 |
| **`FRAME_STALE`** | 一帧深度数据超过 500 ms 就算过期 |
| **`.duckscore`** | 这个项目自己的文本乐谱格式 |
| **MIDI** | 通用乐谱文件格式。这里自己解析 |
| **`ensure-bank`** | 那个幂等的"确保 bank 存在且是最新的"命令 |

---

## 延伸阅读

| 想知道什么 | 去哪 |
|---|---|
| **谁播放、什么时候播放、意图怎么走（姊妹篇）** | [`robotd-primer.md`](robotd-primer.md) |
| 按键怎么变成叫声（姊妹篇） | [`padd-primer.md`](padd-primer.md) |
| 合唱的信标契约（姊妹篇） | [`duck-ble-primer.md`](duck-ble-primer.md) |
| 鸭子怎么"听"（姊妹篇） | [`pet-detect-primer.md`](pet-detect-primer.md) |
| 特雷门用的 `hand` 模块（姊妹篇） | [`kinematics-primer.md`](kinematics-primer.md) |
| 音频硬件是怎么 bring-up 的 | [`deploy-primer.md`](deploy-primer.md) · [`project/media-bringup.md`](project/media-bringup.md) |
| 更新时 hook 会跑什么 | [`hooks-primer.md`](hooks-primer.md) · [`scripts-primer.md`](scripts-primer.md) |
| 所有参数的完整清单 | [`robotd-params-primer.md`](robotd-params-primer.md) · [`../deploy/robotd.toml`](../deploy/robotd.toml) |
| 底盘是怎么动的（另一个"实时"系统） | [`duck-control-primer.md`](duck-control-primer.md) |
| 装完之后你用的那个 CLI（姊妹篇） | [`robotctl-primer.md`](robotctl-primer.md) |
| 蓝牙门房：广播、连接、那个单车道的电台（姊妹篇） | [`btd-primer.md`](btd-primer.md) |
| wifi、身份、手柄配对（姊妹篇） | [`configd-primer.md`](configd-primer.md) |
| 深度矩阵与障碍检测（姊妹篇） | [`duck-detect-primer.md`](duck-detect-primer.md) |
| 仿真的假电台（姊妹篇） | [`duck-ether-primer.md`](duck-ether-primer.md) |
| 公共线上契约：它说的那门语言（姊妹篇） | [`duck-ipc-proto-primer.md`](duck-ipc-proto-primer.md) |
| 笔记本上那个客户端（姊妹篇） | [`duckctl-primer.md`](duckctl-primer.md) |
| 摄像头、WebRTC、远程网关（姊妹篇） | [`mediad-primer.md`](mediad-primer.md) |
| 里程计与那张地图（姊妹篇） | [`odometry-primer.md`](odometry-primer.md) |
| 手柄自己的 IMU：姿态与零偏（姊妹篇） | [`pad-imu-primer.md`](pad-imu-primer.md) |
| Hugging Face 上那三个网页应用（姊妹篇） | [`spaces-primer.md`](spaces-primer.md) |
| 头部的两个传感器：深度与 IMU（姊妹篇） | [`tof-primer.md`](tof-primer.md) |
| 永不砖机：签名、健康门、回滚（姊妹篇） | [`updater-primer.md`](updater-primer.md) |
| 摄像头的像素：旋转与采样（姊妹篇） | [`uyvy-primer.md`](uyvy-primer.md) |
| 发布与自检：打包、签名、晋升（姊妹篇） | [`xtask-primer.md`](xtask-primer.md) |
| 构建、测试、仓库约定、发布 | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
