# 策略清单（Policy Manifest），Schema 2 规范
本文说明 Microduck 的 ONNX 模型配套 `manifest.json` 的含义，以及机器人如何解析每个字段。一套描述规范支持两种仓库结构：
1. **单策略仓库**：Hugging Face Hub 上 `<user>/microduck-<name>`，仅包含一个 `policy.onnx`，所有字段放在JSON顶层；
2. **官方策略集合**：`pollen-robotics/microduck-policies`，包含多个模型文件，在 `policies` 数组内，每个条目复用同一套字段。

同一个解析器可以读取两种格式。向策略发布方提出需求时，只需**新增字段**，而不是要求对方切换格式。

在 `pollen-robotics/microduck_rl` 仓库执行 `uv run publish`，可以从检查点或ONNX文件生成符合规范的单策略仓库。
`robotctl policy load <slot> <repo>` 和 `robotctl policy add <name> <repo>` 用于读取该清单。
设计原理见 `docs/design/policy-channel-design.md` 第9节；本文件为正式契约规范。

## 两大维度
`kind`（类型）：定义**谁来终止策略执行**

| kind | 含义 | 最终用途 |
| ---- | ---- | ---- |
| episodic（阶段性） | 运行 `duration_s` 指定时长，之后自动回到安全姿态 | 若指令为常量，则作为技能（skill） |
| perpetual（永续） | 持续运行直到收到停止指令，例如步态、需要人工终止的姿态 | 插槽步态（`policy load`加载）；搭配`unwind_s`时，可作为带`--hold`保持模式的技能 |
| scripted（脚本式） | 属于阶段性策略，但支持中断：守护进程可在运行中途修改指令 | 录制动作；机器人守护进程自主控制时序 |

`command.encoding`（指令编码）：定义守护进程向模型输入的扭转指令格式

| encoding | 扭转（twist）定义 | 适用场景 |
| ---- | ---- | ---- |
| 缺省 / constant（常量） | 窗口内固定扭转值，结束后回到空闲状态 | 所有踢腿、空翻，以及目前社区所有一次性动作 |
| phase（相位） | $[\cos2\pi\varphi,\sin2\pi\varphi,0]$，$\varphi$从0随`period_s`秒递增，在`end_phase`回到初始姿态 | 地面拾取、滚轮蹲伏 |
| posture_flag（姿态标记） | 单个插槽承载“坐下”或“站立”状态 | 坐立/站立切换 |

> 只有**常量指令的阶段性策略**可以作为通用一次性动作。
> 相位模式、姿态标记模式的策略，无法通过 `policy add` 添加；只能由守护进程在对应插槽中加载（`policy load ground_pick …`、`policy load sitstand …`）。
> 守护进程依靠**编码类型**做校验，而非策略名称。

## 字段说明
除策略集合内的`file`字段以外，其余字段均为可选。
缺失字段不会触发校验失败；机器人**仅当存在字段且取值非法时**，才拒绝加载该策略。

| 字段 | 类型 | 读取方 | 含义 |
| ---- | ---- | ---- | ---- |
| schema_version | int | display | 2。是Schema1的超集；不会仅凭此字段拦截加载 |
| model_api | int | fetch | 策略依赖的守护进程API版本；版本高于守护进程则拒绝 |
| obs_len | int | fetch | 61；与机器人不匹配则拒绝 |
| action_len | int | fetch | 14；不匹配则拒绝 |
| robot.model | str | fetch | microduck；非该机器人型号则拒绝 |
| robot.hw_rev, robot.servos, robot.control_hz |  | display | 1、xl330、50 |
| name | str | skills | 客户端调用名称；默认使用文件名主干 |
| description | str | display | 单行描述，不可信；策略搜索展示的简介，拉取策略时一并读取 |
| kind | str | skills, slots | 见上文 |
| duration_s | float | skills | 运行时长（秒）；相位策略为 `period_s × end_phase` |
| chain | bool | skills | 按住按键时，当前策略结束后自动启动下一轮 |
| action_scale | float | skills | 策略运行期间输出动作缩放系数 |
| unwind_s | float | skills, sitstand | 交还控制权前，维持`command.idle`空闲指令的秒数；坐立切换中用于起身动作 |
| ramp_s | float | sitstand | 座椅稳定就位耗时；关机坐下动作等待两倍该时长 |
| mode | str | set | walk（默认）或 roller；标记相位条目属于哪种模式的地面拾取动作 |
| slot | str | display | 永续步态使用：所属插槽（walk、stand等），对应安装命令 `policy load <slot> <repo>` |
| entry_pose | str | display | 策略要求的起始姿态，例如 standing（站立） |
| command.encoding | str | skills | 见上文 |
| command.idle | [3] | skills | 代表“停止动作”的扭转向量 |
| command.period_s, command.end_phase | float | ground pick | 相位周期参数 |
| command.sit, command.stand, command.slot |  | display | 标记的取值与作用插槽 |
| command.twist, command.head, command.body | 文本 | display | 各模块的人工可读说明 |
| training | object | display | task_id、仓库地址、commit、分支、是否未提交改动、运行记录、检查点、导出时间 |
| eval | object | display | 自由格式：测试项、仿真环境、评估结果 |
| policies[] | array | set | 每个文件对应一条记录，包含file字段以及上面任意策略字段 |

> 循环LSTM导出模型需要 `model_api: 2`；原有的前馈网络导出模型保持API版本1。
> 循环策略相关张量契约、内存生命周期、离线回放详见循环策略文档。

## 单策略仓库示例
```json
{
  "schema_version": 2,
  "model_api": 1,
  "obs_len": 61,
  "action_len": 14,
  "robot": { "model": "microduck", "hw_rev": 1, "servos": "xl330", "control_hz": 50 },
  "name": "polite-bow",
  "kind": "episodic",
  "duration_s": 4.0,
  "chain": false,
  "entry_pose": "standing",
  "description": "Bows from a two-foot stand and comes back up.",
  "command": { "encoding": "constant", "idle": [0, 0, 0],
               "twist": "unused (zeros)", "head": "unused (zeros)", "body": "unused (zeros)" },
  "training": { "task_id": "Mjlab-PoliteBow-Flat-MicroDuck", "repo": "pollen-robotics/microduck_rl",
                "commit": "0bf9897", "branch": "bow", "dirty": false,
                "run": "pollen-robotics/mjlab_microduck/abc123", "checkpoint": 3000,
                "exported": "2026-09-02T14:05:00Z" }
}
```
该仓库仅包含一个ONNX文件：`policy.onnx`。
执行 `robotctl policy add polite-bow <user>/microduck-polite-bow` 时，会读取 `duration_s`、`chain`、`action_scale`、`command.idle`、`unwind_s`；
若 `obs_len`、`action_len`、`model_api`、`robot.model` 不匹配，或编码不是常量模式，则拒绝加载，并生成对应的技能。

示例永续策略：`RemiFabre/microduck-flamingo-cycle`，无`duration_s`，加载时必须加`--hold`；其`command.idle`用于收尾回退动作。

## 官方策略集合
字段同上，所有策略条目放在 `policies` 数组下，额外增加`file`字段。
在线文件地址：https://huggingface.co/pollen-robotics/microduck-policies/blob/main/manifest.json

集合内的相位条目配置各模式地面拾取时序；脚本条目定义坐立切换时序。
基于更长周期重新训练的拾取动作，仅需打标签版本，**不需要发布守护进程新版本**。

所有文件名只能是纯文件名，**不能带目录、不能以点开头**。
如果清单中某条目包含路径，种子加载器与`robotctl policy update`都会跳过该条目。

清单会安装到策略集合目录，`/opt/robot/policies/current/manifest.json` 是 `robotd` 读取技能配置的文件。
同时它也是下载清单：新增策略等价于在此处增加条目并打上版本标签；开发板首次种子部署，以及后续所有策略更新，都从目标版本读取这份清单。

## 预览视频（不属于清单字段）
仓库可以附带策略运行视频，`robotctl policy search` 会在描述旁展示视频链接。
视频仅靠文件路径识别，**不是manifest内的字段**。这是沿用现有发布方与策略预览平台的习惯；如果新增预览字段，所有人都需要重复填写路径信息。

优先查找顺序：
1. `media/preview.mp4`
2. `preview.mp4`
3. 任意目录下，文件名以preview开头的 `.mp4` / `.webm` / `.mov`
4. 所有 `.mp4` / `.webm` / `.mov`
5. 所有 `.gif`

同优先级多个文件时，按规则选择：路径层级最浅 → 文件名最短 → 字母升序。
例如仓库内同时存在 `10cm/preview.mp4` 和 `100cm/preview.mp4`，每次搜索都会选出同一个，而不是取决于Hub的文件列表顺序。

第4条规则说明：如果仓库只有一段查看器录屏，也会被当作预览视频。发布者主动打包的视频优先，系统无法识别视频内容。若不想展示预览，不要上传视频文件到Hub仓库。

搜索直接读取Hub返回的文件列表，获取预览视频**无需额外网络请求**。
读取策略描述需要对每个仓库发起一次`manifest.json` GET请求；请求数量有限制，超过数秒未响应会直接放弃，策略列表的时效性优先于完整描述加载。

## Schema 1 → Schema 2 的变更
Schema1是官方策略集合最初版本：`kind`取值为perpetual、episodic、scripted。当时scripted含义为“守护进程生成指令”，用于地面拾取。
Schema2做了调整：
- 将原含义迁移至`command.encoding`；
- scripted改为**可中断的阶段性策略**，用于坐立切换；
- 新增字段：`chain`、`ramp_s`、`mode`、`entry_pose`、`training`、`eval`，以及`command.*`时序字段。

守护进程读取Schema1文件时，会使用原型默认时序，支持原有三类技能；**不会因为版本号拒绝加载**。
