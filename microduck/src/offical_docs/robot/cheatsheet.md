# 速查手册
`robotctl` 在机器人本体上运行。本文所有命令均取自对应发布分支的 `--help` 帮助信息，并非凭记忆整理。

只读类命令无需权限。任何会修改机器人状态的操作都需要 `sudo`（或者对于 `configd`，使用配置在 `--allow-user`/`--allow-group` 内的用户；对于 `updaterd`，使用 `updater.toml` 中 `allow_uids/allow_gids` 指定的用户）。

分支构建版本、发布候选版以及更新后的服务重启限制，参见 `cheatsheet-dev.md`，这些功能需要开发板。在笔记本电脑通过蓝牙（无网络、无SSH）控制同一台机器人的命令见 `duckctl.md`。

## 在机器人端 — robotctl
### 优先执行的命令
```bash
robotctl version
```
查看各个守护进程**实际运行版本**与**已安装版本**，版本不一致时会输出警告。在采信任何其他诊断结果前先运行这条命令：更新后守护进程仍运行旧代码的现象，看起来和刚发布修复引入的bug完全一样。参见下文「更新后」小节。

```bash
robotctl health
```
软硬件综合状态报告。机器人异常或无法访问时返回非0退出码，可用于脚本流程阻断。电机过热、部件卡死只会上报状态，不会判定为故障，不影响退出码。加上 `--json` 可导出用于问题排查的完整数据包。

### 观测控制环路
```bash
robotctl monitor
```
展示客户端请求指令与实际执行值，二者不一致时会标注原因。安全限制会持续介入，例如「摇杆向前，但机器人不动」，不看该信息就无法定位。限制会直接写明，而不是简单命名：**deadman（死亡开关）**：近期未收到控制指令，速度清零。

界面同时展示：每个关节的指令值与实测值、IMU解算的重力矢量、基于重力矢量判定的跌倒状态，以及闭环控制的实际帧率（即使卡顿已经恢复，依然能追溯到该抖动）。重力投影是该数据流里唯一的IMU数据；直立姿态约为 `[0, 0, -1]`，跌倒判定依据就是该矢量。过期读取计数器和相关比率在 `robotctl health` 中查看。

标题最后一行展示机器人状态，而非运动行为：电池电压与电量百分比、温度最高的舵机以及板载温度。数据取自 `robot.health`，每2秒轮询一次，不属于状态数据流。所有异常信息在此处展示，例如：`unhealthy: control loop at 43.9 Hz`（控制环路43.9Hz，不健康）、`degraded: no robot on the motor bus after 3 attempts`（降级：3次尝试后电机总线无机器人响应）、`orientation frozen — 25 stale reads`（姿态冻结，25次过期读取）。最后这条信息仅在本行展示，不出现在画面其他位置：当板子停止融合姿态数据，但总线仍正常应答，不会抛出报错，重力矢量会长期维持一个看似合理的姿态。

电量0%对应 `BATTERY_EMPTY_V`，到达该电压时 `robotd` 会让机器人坐下并断电。因此该数值是倒计时，不是普通电量表：30%变黄，15%变红。尚未读取电池时显示 `batt not read yet`，而不是0.00V，开机首秒或者总线无应答都会出现该提示。**即使没有任何状态数据，这一行依然会绘制**，这也是该场景最重要的信息：舵机断电的板子永远无法完成控制周期，数据流不会有任何内容，故障原因只能在health状态中查看。

底部边框展示当前加载的策略：`.onnx` 模型文件，以及站立网络是否启用。行走是一种运行模式，两个使用不同步态的发布包都会上报行走模式。无策略的机器人会直接提示；策略加载失败也会单独提示，数据流里的保持状态无法区分这两种情况。

界面右侧绘制机器人实时姿态，使用策略训练时的同一可视化模型，由实测关节角度定位、IMU重力矢量倾斜。腿部弯折异常、头部前倾贴地、机器人侧躺，在关节表格里只是一堆数字，但在这里可以直观看到。默认开启，终端宽度足够（约110列）才会渲染：表格优先展示，剩余空间绘制机器人模型。`d` 关闭模型；`[` 和 `]`（或左右方向键）旋转视角。

当ToF（飞行时间深度传感器）输出帧时，画面会叠加深度检测结果：黄色代表检测到物体，绿色代表地面；会对机器人本体做深度遮挡检测，喙后方的点会被遮挡。用来判断「传感器看到的是人手，还是机器人自身」。无需按键控制：有帧就显示，无帧自动消失。

在模型下方，终端高度足够时，会绘制机器人运动轨迹地图：基于足端接触与IMU的里程计轨迹，使用盲文点阵绘制。画布尺寸固定，世界随轨迹向外缩放，保证整条路径都在画面内。`+` 是起点，● 代表机器人，短线表示朝向；屏幕上方为开机初始朝向。**无磁力计，属于相对运动，存在漂移**，只能判断「是否在原地转圈」，无法给出绝对坐标。

按键操作：
- `q`：退出
- ↑/↓：窗口高度不足时滚动关节列表
- `u`：角度在角度制/弧度制之间切换
- `t`：打开ToF深度矩阵
- `c`：打开摄像头画面
- `d`：切换机器人模型显示；`[` / `]` 旋转视角
- `p`：打开手柄原始输入流，输出游戏手柄所有evdev事件包以及包间隔，无线链路卡顿只能在这里观察（手柄配对文档 pair-a-gamepad.md）

带IMU的手柄（Pro Controller克隆款有，Xbox手柄没有）会额外增加面板：线框手柄随实物同步倾斜旋转，显示俯仰、横滚、带漂移的偏航角、原始加速度与角速度，以及陀螺仪静态偏置是否完成校准（保持静止半秒完成）。黄色横线代表手柄前端。屏幕上关节、头部、偏航速率使用角度单位。
如果重定向输出或管道输出，每个控制周期只打印一行，适合 `> run.log` 或者 `| grep FALLEN`，此时数值始终为弧度，不受屏幕单位切换影响。
关节矢量可以用 `--json` 输出，每行一个JSON对象，包含完整状态：
```bash
robotctl monitor --json --hz 50 > run.jsonl
```

### 机器人配置
```bash
sudo robotctl configure
```
查看当前机器人上所有被修改过的配置项：
```bash
robotctl configure --list
```
未做任何修改的机器人输出为空。加 `--json` 导出诊断数据包。无需root，也不需要交互式终端。机器人行为异常时优先执行这条命令，过去只能通过SSH全屏编辑器查看。

交互式编辑器，编辑 `/etc/robot/robotd.toml`：列出守护进程识别的全部配置键，功能开关优先展示（策略开关、行走/轮式模式、跌倒瘫软、音频、宠物检测、电池断电、相机与视频质量等），同时显示当前值与默认值，附带单行说明。
- 空格：切换布尔开关
- 回车：输入参数值
- `u`：将配置项恢复默认
- `ctrl+f`：模糊搜索，输入实时定位，回车或ESC保持选中

黄色标记（•）代表该机器人与默认配置不同；其余为内置默认值，未设置的可选参数展示解析后的默认值（auto）。

编辑器三大可靠特性：
1. 配置与守护进程保持一致：校验规则、默认值、验证逻辑与 `robotd` 读取配置的代码库同源；配置项清单由测试锁定完整。守护进程新增配置段，编辑器会同步识别，否则构建失败。
2. 不会损坏配置文件：注释、顺序、其他版本遗留的键完整保留；仅写入修改过的配置项。恢复默认会直接删除该键（连同附属注释），而不是写入默认值，配置文件只记录人为改动，不是默认配置副本。
3. 不会写出导致robotd启动失败的配置：每次保存都会先用守护进程自带加载器校验，原子写入（临时文件+重命名），校验失败会返回原因拒绝保存。

保存时会提示改动需要的操作，由对应守护进程决定：
- 大部分配置需要重启：`[media]`、`[duck_detector]` 属于mediad；`[head_imu]` 属于tofd
- `[policy]` 仅需重载robotd，电机不断电
- `[pad]`、`[pad_imu_head_control]` 无需任何重启，`padd` 1秒内自动识别

需要`sudo`，因为配置文件属主为root；不加sudo会以只读模式打开，首次写入时报错。`--file` 指定其他路径，用于测试副本。工程发布的 `deploy/robotd.toml` 作为所有参数的参考文档；本命令用于快速切换开关。

#### 视频质量
```bash
sudo robotctl configure
```
设置 `media.quality`：`1080p30`、`720p30`、`720p15`、`360p30`，保存后按提示重启。
`media.source` 设置为 `test` 会输出测试图，适合无相机的板子。WebRTC控制通道复用视频流，流水线启动失败会同时丢失控制通道。测试图忽略 `media.quality`，固定 256×144@5fps，仅用来维持会话；渲染720p测试图CPU占用是真实相机的5倍。
`media.bitrate` 如不手动设置，会跟随画质档位，单位bit/s。

`media.congestion_control` 是该节另一个关键参数，显著影响CPU占用：关闭后禁用带宽估算器（mediad里最大的CPU消耗项，占单个核心7.6%，采集仅0.3%），此时`media.bitrate`为固定码率，不再是起始参考值。代价是自适应能力丢失：链路变差时画面卡顿，而不是自动降码率。

720p30是流水线标定档位；达不到该性能会自动降速，不会直接失败。`robotctl monitor`底部边框会显示实际帧率，低于目标90%时黄色标注。查看媒体服务日志：
```bash
journalctl -u mediad -b | grep streaming
```

### 策略与技能
**插槽（slot）**：机器人默认运行的模型，行走步态、站立网络。
**技能（skill）**：收到指令才执行的动作，踢腿、前滚翻、鞠躬。
两者都存放在Hub仓库，更新策略不需要升级守护进程，修改后一般无需重启。

查看机器人当前加载策略：
```bash
robotctl policy list
```
输出两个表格：7个插槽，然后是技能。展示默认运行项和可触发动作。
```
   SKILL        RUNS FOR  POLICY
   kick_left       0.5 s  ball_kick_left.onnx
   roulade           1 s  roulade.onnx
 * polite-bow        4 s  fffiloni/microduck-polite-bow-b1d864/main/policy.onnx
   ground_pick         —  driven by the robot itself
   sit_toggle          —  driven by the robot itself
```
`*` 标记被配置修改过的条目，底部统计数量。被关闭的插槽显示 `switched off`，而不是像不存在一样。路径去掉目录信息，因为ORIGIN列记录来源仓库。

`ground_pick` 和 `sit_toggle` 没有时长，由机器人内部驱动。同样支持 `robot do` 调用，但用户不能修改。

#### 更新官方策略集
机器人行走使用的策略托管在Hub，独立版本管理：
```bash
robotctl policy check
sudo robotctl policy update
```
`check` 打印已安装版本、最新版本与仓库可用内容，不会修改系统；无法访问Hub时明确提示。`update` 默认拉取最新版本；`--version v1` 回退旧版本。机器人回到初始姿态，重新加载全部插槽。**手动加载的策略不受影响**，因为指向自定义路径。

#### 更新鸭子检测器模型
mediad用来识别其他机器人的模型，同样托管在Hub（`pollen-robotics/microduck-duck-detector`），独立版本：
```bash
robotctl duck-detector check
sudo robotctl duck-detector update
```
用法和policy命令一致；`--version <tag>` 指定版本。`update` 会重启mediad，终端视频短暂中断。检测器是否启用由 `robotctl configure` 的 `[duck_detector]` 开关控制。

#### 加载本地自定义模型
无需发布包，不用编辑配置文件，无需重启：
```bash
sudo robotctl policy load walk /home/radxa/my_walking.onnx
```
机器人正在行走时，会回到初始姿态，加载模型继续运行。如果处于坐/静止站立，不会移动：被替换的网络不是当前正在运行的，替换在后台完成。
```bash
sudo robotctl policy reset walk
```
恢复该插槽默认策略；不带插槽名则重置全部7个插槽。

#### 加载社区他人发布策略
社区可发布机器人策略模型：
```bash
robotctl policy search microduck
sudo robotctl policy load walk RemiFabre/microduck-flamingo-cycle
```
只需要仓库名，一键拉取加载。追加`@v2`指定版本，`:policy.onnx`用于仓库含多个模型。`policy list`标记为community社区模型。

> 社区模型无官方验证。安全保障来自关节限位、跌倒保护与形态校验，不是描述文字。首次测试务必把机器人放置在支架上。
> 如果模型清单声明不兼容（观测维度不对、守护进程版本过高、机器人型号不匹配），下载前直接拒绝。无清单的模型会正常下载，加载阶段做校验。

#### 添加技能
walk插槽替换行走步态；**技能并行加载，收到指令才运行**，适合一次性动作：
```bash
sudo robotctl policy add polite-bow fffiloni/microduck-polite-bow-b1d864
robotctl robot do polite-bow
```
时长从仓库manifest读取。持续动作（单脚站立）无固定时长，手动指定时长与控制指令：
```bash
sudo robotctl policy add flamingo RemiFabre/microduck-flamingo-cycle --hold 5 --command 1,1,0
```
`--command` 是模型运行期间输入的控制向量。大多数技能不需要，在全零指令下训练，选中即为触发。部分模型读取自定义控制向量（flamingo使用`[flag, side, 0]`），含义参考对应README。

删除技能：
```bash
sudo robotctl policy remove <name>
```
系统自带技能删除条目只会移除用户覆盖，重新出现。
> 技能运行前提：机器人处于驱动模式。先按手柄Start，否则请求拒绝。

#### 绑定技能到手柄按键
```bash
robotctl pad bindings
a           ground_pick
x           roulade
lb          kick_left
rb          kick_right
dpad_down   sit_toggle
```
修改按键绑定：
```bash
robotctl pad bind <button> <skill>
sudo robotctl pad bind x polite-bow
a           ground_pick
x           polite-bow
lb          kick_left
rb          kick_right
dpad_down   sit_toggle
```
仅写入对应一行配置：
```toml
[pad]
x = "polite-bow"
```
恢复默认绑定：
```bash
sudo robotctl pad reset
```
无需重启，padd 1秒内自动识别。绑定不存在的技能会在列表中标注，按下按键不会静默失效。

可绑定按键共5个：`a, x, lb, rb, dpad_down`。`lb/rb`是肩键，不是模拟扳机；扳机用于嘴部和叫声。空名称可以关闭按键；`pad reset <button>`恢复单个按键。默认是原型机映射，配置文件没有`[pad]`段时保持原生行为。

其余按键不可自定义：Start切换策略；Y/B修改摇杆功能；长按Select关机。停止机器人的按键不能被配置覆盖。按键名称会做有效性校验，拼写错误直接拒绝，不会变成无效按键。

#### 全部恢复默认
```bash
sudo robotctl policy reset
sudo robotctl pad reset
robotctl configure --list
```
最后一条查看所有偏离默认的配置；无修改时输出一行提示。机器人行为异常不确定残留配置时优先执行。

##### 插槽重要说明
插槽：`walk, stand, sitstand, ground_pick, kick_left, kick_right, roulade`。
`load`写入 `/etc/robot/robotd.toml`，**重启、升级守护进程后依然保留**：发布包只会替换自带二进制和内置策略，不会修改指向自定义模型的配置行。
- 重置已经默认的配置不会报错，无任何改动，无需sudo。
- 模型必须满足输入输出维度 `obs[1,61] -> actions[1,14]`，否则在修改前拒绝。加载校验时机器人仍运行旧模型。
- 加载失败时保持原有策略，加载步态不会丢失旧可用模型。
- 下次开机模型文件丢失：该插槽回退到内置策略，`robotctl health`标记降级并提示缺失文件；`policy reset <slot>`清除配置。官方策略加载失败会标记不健康，更新程序自动回滚。
- `none` 关闭插槽，walk插槽不能关闭，作为其他插槽的回退。部分自维持站立模型需要关闭stand网络，否则指令为0时会被站立策略接管。

##### 发布策略给所有机器人
官方策略集可以分发到全部机器人，新增策略**不需要发布守护进程**，4步：
1. 将 `.onnx` 上传到 `pollen-robotics/microduck-policies`
2. 在 `manifest.json` 添加条目：
```json
{ "file": "polite-bow.onnx", "kind": "episodic", "duration_s": 4.0 }
```
策略集清单schema_version:2；一次性动作仅需要这三个字段。
3. 打标签：`hf repos tag create pollen-robotics/microduck-policies v4`
4. 在机器人执行：`sudo robotctl policy update`

一次性动作（episodic），带时长，在全零指令训练，可通过名字调用、绑定按键，无需额外修改。持续步态模型需要绑定到插槽。

需要守护进程持续驱动的模型（时序相位、姿态标志切换）在`command.encoding`定义，数值作为时序参数，不作为新技能。`ground pick` 和 `sit↔stand` 属于此类，配置条目填写错误风险较高。

完整清单字段：`../policy-manifest.md`
模型加载校验规则：`../design/robotd-design.md §2.3`
策略来源、官方定义、技能声明：`../design/policy-channel-design.md`

### 关节动力控制（robotd）
```bash
sudo robotctl robot init
sudo robotctl robot relax --yes
sudo robotctl robot reboot-motors           # 全部舵机；或 reboot-motors 3 11 指定舵机。扭矩关闭，之后执行init/Start
```
`init`上电，约2秒平缓回到初始姿态，所有关节运动，务必放在支架上。不需要策略，就是手柄Start按键的动作，多用于台架测试。

`relax`切断电机扭矩，无支撑机器人会倒下，因此必须加`--yes`确认。除了直接拔电源，这是唯一进入瘫软模式的方式。再次按Start停止策略并保持站立；`robot.stop`清零速度并维持站立。

两条命令都由`robotd`接管电机总线。守护进程未运行时，保留独立子命令`robotd init`，**必须先停止robotd**，同一UART两个写入端会互相破坏报文：
```bash
sudo systemctl stop robotd && sudo /opt/robot/daemon/current/bin/robotd init && sudo systemctl start robotd
```

更换舵机无需配置工具。全新舵机直接安装（ID1，57600波特率），上电后`robotd`/`robotd init`会检测失联关节，烧录新舵机ID、写入寄存器并重启舵机。日志提示`factory-fresh servo on the bus`，完成后提示`replacement servo adopted`。**一次只能更换一个舵机**，两个同时丢失无法分配ID，等待并提示。

`init`默认在跌倒后依然可用；跌倒仅上报（robotctl monitor可见），不阻断流程，与原型一致。如果在`robotd.toml`设置`[safety] fall_limp`或`fall_recover`，开启安全锁：跌倒后机器人瘫软，拒绝init/启用/技能，直到扶起。

### 游戏手柄（configd）
按键绑定参考上面「策略与技能」`robotctl pad bindings`。本节讲手柄连接。
```bash
robotctl pad status
sudo robotctl pad pair
sudo robotctl pad pair 78:86:2E:BB:13:28
sudo robotctl pad forget 78:86:2E:BB:13:28
```
配对一次即可。详细操作文档 `pair-a-gamepad.md`：手柄进入配对模式的按键、新增第二个手柄、配对失败排查（`/etc/bluetooth/main.conf`的Privacy配置是最常见原因）。

`padd.service`开机自启，自动驱动已连接手柄，配对是唯一步骤。按键映射沿用原型机：

|按键|功能|
| ---- | ---- |
|左摇杆|移动：前后/横移；头部：偏航俯仰；身体姿态：起身/下蹲|
|右摇杆|转向；头部：颈部俯仰横滚；身体姿态：俯仰侧倾|
|Start|第一次按下：开扭矩，2秒回初始姿态保持；第二次：策略驱动；之后切换策略|
|Y / 三角键|头部模式：摇杆控制头部，身体不动。开启`[pad_imu_head_control]`且手柄带IMU：手柄倾斜控制头部，摇杆继续控制机身|
|B / 圆圈键|身体姿态模式：摇杆控制站立机器人倾斜下蹲|
|A / 叉键|拾取动作ground pick|
|X / 方块键|前滚翻roulade；长按连续翻滚|
|LB / RB|左踢 / 右踢|
|DPad-Down|坐/站立切换|
|RT / LT|嘴部；RT触发鸭子叫声；LT长按发出“wheee”音效|
|DPad-Up，长按3秒|切换行走/轮式模式|
|DPad-Right|重启全部舵机：过载保护触发后，不用拔电池复位。扭矩关闭，之后按Start|
|Select，短按|松开时切断扭矩（紧急停机），机器人会倒下，务必托住；Start恢复站立|
|Select，长按2秒|坐下、断扭矩、整机断电，松开后不再执行其他动作|

**手柄IMU控制头部**：Pro Controller内置IMU，开启：
```bash
sudo robotctl configure      # Controller-IMU head control → enabled
```
Y键功能变化：第一次按下，头部跟随手柄姿态，摇杆继续控制机身；再次按下头部锁定；第三次重新跟随手柄。偏航仅依靠陀螺仪，存在漂移，每次启用时重新置零，无需磁力计。同配置段`gain`为手柄弧度对应头部弧度，默认1。Xbox手柄或该功能关闭时，Y回到摇杆头部模式。`padd`1秒内识别配置变更，无需重启。

无独立停止按键：松开摇杆机器人保持站立；padd进程崩溃时robotd的死亡开关自动停机。轮式模式（`robotd.toml mode = "roller"`）摇杆自动适配轮式控制：非对称推/刹车，无横移；A下蹲。踢腿、翻滚、坐下等技能在轮式模式同样可用。

长按DPad-Up切换行走/轮式：切换时鸭子叫一声（行走）两声（轮式），回到初始姿态，加载对应策略，全程保持扭矩，**不重启**。不会修改`robotd.toml`，重启会回到配置模式；如需永久保存，使用`robotctl configure`（或`[policy] mode`）。长按设计避免操控时误触。

`pad status`分开展示两层状态，因为手柄物理连接和驱动失效在外表现一致：
```
pad     Xbox Wireless Controller 78:86:2E:BB:13:28  connected
padd    active — driving whatever pad connects
```

使用自定义速度限制，先停止服务，否则双进程争夺摇杆：
```bash
sudo systemctl stop padd
sudo -u padd /opt/robot/daemon/current/bin/padd --max-linear 0.25
```

怀疑无线链路问题：`robotctl monitor`，按`p`实时查看手柄数据流。舵机断电/robotd停止时依然可以查看手柄面板。复制链路测试脚本到板上：
```bash
scp scripts/pad-link-test.sh radxa@<board>:/tmp/
```
查看历史丢包（无需连接手柄，立即输出）：
```bash
sudo sh /tmp/pad-link-test.sh --history
```
实时测试，两分钟内持续移动摇杆：
```bash
sudo sh /tmp/pad-link-test.sh
```
统计丢包和内核原因，统计手柄输入报文间隔。链路在线但指令过期的隐性故障，padd无法直接捕获。结果解读参考`pair-a-gamepad.md`。

同一手柄两块板子行为不一致，抓取协议栈信息：
```bash
scp scripts/pad-stack-report.sh radxa@<board>:/tmp/
sudo sh /tmp/pad-stack-report.sh
```
输出内核、BlueZ、控制器固件、BLE/BR/EDR、手柄固件版本，保存日志`/tmp/pad-stack-<host>-<when>.log`。`--fingerprint`仅输出对比关键字段，用于diff。`pair-a-gamepad.md`包含对比方法。

### 语音
```bash
robotctl quack
```
区分机器人的发声命令。每台机器人语音库基于SoC序列号生成（`sounds ensure-bank`在每次发布安装时执行）。SSH连接的机器人会使用独有的声音。关闭音频/无语音库时提示信息，不会输出🦆，无声音代表操作的不是目标机器人。

robotd启动时会发出问候，关机前发出提示音；开启后，麦克风检测到头被抚摸时会发出低鸣。该功能默认关闭，`audio.pet_detect = true`开启；分类器随发布包内置。常开模式会误触发，所以默认关闭。开机提示音独立开关，适合反复重启守护进程场景：
```bash
sudo robotctl configure
```
设置`audio.greet = false`，保存后按提示重启。仅关闭开机叫声，保留触发音与麦克风；`audio.enabled = false`会完全关闭音频。音频硬件初始化（编解码器驱动、设备树覆盖、混音器）在`setup-board.sh`音频段，每块板子仅需一次。

试听语音或者手动重新生成语音库，发布包内置工具：
```bash
/opt/robot/daemon/current/bin/sounds show
sudo /opt/robot/daemon/current/bin/sounds ensure-bank --force
```
```bash
sounds theremin
```
试听实时合成音，模拟手在ToF传感器前扫动。`--out sweep.wav`导出音频文件，无需机器人即可试听音色。

### 多鸭合唱
```bash
robotctl chorale
```
同一房间两只机器人合唱四声部乐曲；更多机器人加入正在进行的演奏。`Ctrl-C`终止，`--off`停止本机合唱。

默认关闭，需要在参与机器人的`robotd.toml`开启`[chorale] accept`。合唱会驱动嘴部与头部运动，避免机器人在别的鸭子进入时自动动作。关闭状态下机器人不会广播任何信息，不会礼貌拒绝。

工作原理：
- 无主节点，ID更小的机器人担任指挥，基于BLE广播信标，无需消息可靠送达。
- 无统一时钟，无NTP/RTC同步。指挥节拍计数器作为时间基准，每拍在BLE广播更新一字节；新值到达即为强拍。跟随机器人平均约25拍相位，把无线抖动控制在合奏需要的±20ms以内。
- 声部动态分配，不是预先指定。ID最低的唱低音。指挥广播成员列表，所有机器人同步声部，避免两个机器人唱同一声部。
- 加入不改变任何人声部。机器人离开后保留原有声部，该声部静音；演出中途不重新分配声部。

输出会显示声部，保留在回滚日志：
```
listening for other ducks — Ctrl-C to stop
  singing tenor    with 3 voices
  tenor    bar   12  beat  45.2  3 voices
```
指挥每轮选择曲目；乐曲结束后全部回到监听，短暂停顿后开启新曲目。`robotctl chorale --piece 2`指定本机作为指挥时的曲目；跟随机器人使用广播指定曲目，多机全部设置保证曲目一致。非法ID拒绝，查看机器人曲目库。曲目ID：1 wistful，2 duck-strut，3 outer-wilds（测试资源，不发布）。环境变量`DUCK_CHORALE_PIECE=<id>`作为robotd的默认配置，**必须设置在robotd环境，不是robotctl命令行**。

无需实体机器人，单机渲染完整合奏音频：
```bash
sounds chorale --voices 4                 # 或者 --seeds 100,7,42 指定机器人音色
sounds chorale --score my-piece.mid       # 任意乐谱编辑器导出MIDI
sounds chorale --rolloff 0                # 全频扬声器使用，不是鸭子自带喇叭
```
乐谱来源：`sounds/scores/*.duckscore`（分行文本格式，`wistful.duckscore`为示例），或者MIDI文件，推荐MuseScore编辑器。每个声部独立乐器，不是钢琴总谱；按平均音高匹配声部，命名为Soprano的轨道优先识别。

### 鸭子特雷门琴（ToF深度传感器）
```bash
robotctl theremin
```
头部深度传感器变成乐器：喙前方手距离决定音调，越近音调越高；嘴部随音符张开，最高开度在高音区。`Ctrl-C`退出，退出时关闭乐器。`--off`关闭其他客户端遗留的特雷门会话。

默认关闭，在`robotd.toml`配置`[theremin] enabled`，通过`robotctl configure`开启，保存后重启robotd。不开启时`robotctl theremin`拒绝执行并提示配置键。开启特雷门不影响tofd服务，深度网格功能依然可用。

工作模式：检测演奏区间内最近的物体。对准空旷空间静音；对准40cm墙面持续单音。坐、站立、行走都可以演奏；嘴部动作不属于策略模型。

输出最后一列是传感器帧状态，用于排查停止演奏的原因：
```
  0.34 m    438.1 Hz   60% ██████    14 usable · 255:38 4*:9 5*:5 1:12
```
展示可信状态的区域数量，以及每个ST状态码计数，带*代表可信状态。音符前带`~`代表维持音，填补传感器丢包间隙，不是实时测量。

该列用于发现传感器逻辑缺陷：ST文档5、9标记为有效测距。如果仅采信这两个码，大约30cm外识别不到手；移动手返回4或13（一致性失败，sigma过高），距离数值本身可用于音调。探测距离不够，在`[theremin] statuses`增加状态码；空场景误触发，则删减。`hold_ms`防抖，平滑闪烁的区域。

> 注意：`robotctl monitor`的ToF网格校验更严格，5/9以外标记x（无法测量）。网格大量x不等于传感器损坏，只是校验策略保守。

### ToF深度传感器（tofd）
头部传感器输出8×8深度矩阵。`robotctl monitor`，按`t`打开：
```
┌ tof VL53L8CX · 15 Hz · 8×8 · 48/64 ranged · 0.12–3.54 m ─────────────┐
│ 0.12 0.15    x 1.44 1.86    · 2.70 3.12                              │
└ · nothing in range · x could not measure · near→far ── seq 412 · 6 ms ┘
```
单位米，暖色近、冷色远。两个标记含义：
- `·`：已测量，无物体（空旷，有效信息）
- `x`：无法测量，不代表场景有无物体

画面是传感器原始帧，没有运动学重投影，适合检查安装倾角。

tofd独占传感器总线，其他程序不能读取。普通systemd服务：`sudo systemctl stop tofd`安全，无依赖。monitor提示`no depth stream`继续运行。三种状态区分：

|面板提示|含义|
| ---- | ---- |
|connecting to tofd… / no depth stream|守护进程未启动|
|no sensor: …|tofd运行，总线无传感器应答（多数鸭子）|
|waiting for the first frame…|传感器测距，首帧约66ms|

手动查看I2C总线，或无终端UI采集帧：
```bash
sudo i2cdetect -y -r 3
journalctl -u tofd -b
```
传感器和音频编解码器共用I2C总线，`setup-board.sh`音频段已经配置总线；ToF步骤仅创建稳定设备名 `/dev/i2c-pihat`。两代传感器VL53L5CX / VL53L8CX板上可互换，守护进程读取ID自动选择驱动。

### 头部IMU（head_imu.stream）
tofd同时管理头部BMI088，陀螺仪、加速度计、Madgwick姿态解算，**默认关闭**。`robotd.toml`开启`[head_imu] enabled`，`robotctl configure`设置，保存后重启tofd。100Hz读取占用单核约4%，暂无订阅者，未建图的机器人开机持续占用。关闭状态订阅会返回配置提示，而不是传感器未安装的静默。
```bash
tofd --imu
```
单次读取IMU，不修改配置；`--imu-hz`频率与负载线性权衡。
IMU不影响深度测量，ToF测距不受开关影响，上面的深度网格在IMU关闭时照常工作。

### 摄像头（mediad）
终端内展示头部相机画面，`robotctl monitor`，按`c`：
```
camera 1280×720 · mount 90° · answered in 41 ms                    0.5 s ago
```
每个字符单元格绘制2像素，自动校正安装角度。画面尺寸小；机器人旋转90度后画面竖版，宽度约16像素，足够定性判断：头部朝向、环境亮度、镜头污渍。

面板关闭时不会拉取帧。一帧1.84MiB，mediad仅在请求时复制采集帧。monitor面板关闭时不消耗相机资源；打开后每秒请求两次。`answered in 41 ms`代表相机活性：健康30fps相机大约1帧延时，停止的相机等待超时失败。关闭面板清空画面，重新打开获取最新帧，不缓存旧画面。

|面板提示|含义|
| ---- | ---- |
|asking mediad for a frame…|首个请求等待响应|
|no picture: connection refused|mediad未运行|
|no picture: no frame arrived within the capture timeout|mediad运行，相机无输出|

获取完整原始帧，非缩略图：
```bash
robotctl frame --output /tmp/frame.uyvy
```
输出单帧UYVY原始图像，几何信息与安装角度打印到stderr。mediad在:8080提供HTTP接口，`GET /frame`返回直立校正后的PNG。

### WiFi（configd）
```bash
robotctl net status
robotctl net scan
sudo robotctl net connect <ssid> --psk <passphrase>
sudo robotctl net connect <ssid> --psk-stdin
sudo robotctl net forget <ssid>
```
`--psk-stdin`避免密码出现在进程列表`ps`，多用户设备优先使用。

连接新网络会断开当前WiFi，SSH会话掉线，属于正常现象。扫描耗时数秒，无线电扫描，不会返回缓存旧结果。

### Hugging Face账号（updaterd）
登录机器人，可外网访问机器人，目前其他功能暂不需要。
```bash
sudo robotctl account login
```
输出验证码，打开 https://hf.co/oauth/device 在任意设备输入验证码：
```
Open https://hf.co/oauth/device and enter this code:

    A6MY-0314

Waiting for approval…
Signed in as PierreRouanet.
```
```bash
robotctl account status
sudo robotctl account logout
```
等待授权时`Ctrl-C`无副作用，机器人持续轮询，`account status`查看授权状态。验证码有效期5分钟，超时重新登录。
已登录机器人拒绝再次登录；强制登录：
```bash
sudo robotctl account login --force
```
强制登录会作废等待中的旧验证码，旧码后续授权无效。
token有效期30天，机器人自动续期。关机超过30天，需要重新登录，`account status`提示。

### 身份与电源管理（configd）
```bash
robotctl system info
robotctl system pin
sudo robotctl system set-name <name>
sudo robotctl system set-pin <six-digits>
sudo robotctl system reboot
```
出厂名称`duck-`+序列号衍生4字符，同镜像烧录的板子蓝牙列表名称不同。改名蓝牙几秒生效，手机需要重新扫描。
PIN码用于手机蓝牙认证，出厂默认`000000`，阅读该仓库的人都可以认证。

### 系统更新（updaterd）
```bash
robotctl update status
robotctl update check daemon
sudo robotctl update apply daemon
sudo robotctl update rollback daemon
robotctl update log
robotctl update show
robotctl update watch
```
`log`列出更新记录，每行一条，最新在前，首列为运行编号。`show`加编号查看单次更新完整日志，不带编号取最近一次，并附带对应时段journal日志。
```
run 42 · daemon · 2025-08-27 13:06:40 UTC
  applied 0.1.3 → 0.1.4
  asked for latest, from github.com/pollen-robotics/microduck, onto 0.1.3
  requested by uid=1000 gid=1000 pid=2317

  13:06:41      +1s  manifest     0.1.4 · 184.2 MB · sha256 3f9a1c2b… · signed by release.pub · rev 88efc03
  13:06:41           downloading
  13:07:58   +1m17s  note         downloaded 184.2 MB to /opt/robot/daemon/staging/0.1.4/dl/…
  13:08:02      +4s  note         hash matches; signature verifies against release.pub
  13:08:20     +18s  pre-hook
  13:10:12   +1m52s  hook         hooks/preinstall
                                 │ onnxruntime 1.20.1 already present
                                 │ gstreamer: h264 encode ok
  13:10:12           swapping     0.1.3 → 0.1.4
  13:10:14      +1s  unit         robotd: restart
  13:10:23      +8s  health       the robot reported healthy
  13:10:24           ended        applied 0.1.3 → 0.1.4

  ── journal · 2025-08-27 13:06:40 to 2025-08-27 13:11:24 UTC ──
```
时间为UTC，journal日志同样UTC。`+`列是距离上一行的时间差。
读取journal日志需要root权限，robot用户组权限不足，不加sudo后半段为空。`--no-journal`跳过journal读取；`--json`仅输出更新记录文本。

组件名`daemon`，包含全部二进制程序。`apply daemon`安装稳定通道版本；分支构建、候选版本看`cheatsheet-dev.md`。

#### 不下载，切换本地已解压版本
无需网络，切换板子已缓存的版本：
```bash
sudo robotctl update select daemon 0.1.4
sudo robotctl update rollback daemon
sudo robotctl update reset-to-golden daemon
```
`select`激活已安装版本；`rollback`回退上一个版本；`reset-to-golden`回退永久保留的基准稳定版本。

锁定版本禁止升级：
```bash
sudo robotctl update pin daemon 0.1.4
sudo robotctl update pin daemon
```
第二条解除锁定。

#### updaterd无法启动时
上面所有更新命令依赖updaterd，守护进程宕机全部失效。查看服务状态：
```bash
systemctl status updaterd robotd btd configd
```
不依赖updaterd回退基准版本：
```bash
sudo robot-rescue --dry-run
sudo robot-rescue --reboot
```
`--dry-run`模拟，不改动系统。不带`--reboot`替换版本，打印重启命令而不执行：所有守护进程从`current`软链接加载，**必须重启才会生效**，站立的机器人务必先保护。

没有基准版本或者当前已经是golden版本会拒绝执行。golden版本本身守护进程也失败时，回滚无效，查看日志：
```bash
journalctl -b -u robotd -u updaterd -u btd -u configd
```

#### 机器人自动自救
每次开机3分钟，定时器检测守护进程是否正常拉起，失败自动回退golden。机器人无故重启、版本低于你安装版本，大概率是自动救援。查看记录：
```bash
robotctl update log
```
日志记录rollback，写明失败的守护进程。查看判断过程：
```bash
journalctl -b -u robot-boot-check
sudo robot-boot-check --dry-run
```
自动救援单次触发；记录未清除前拒绝二次救援。updaterd下次启动清除记录。golden版本本身也启动失败，救援会拒绝，查看日志而不是反复重启。确认后强制救援：
```bash
sudo robot-rescue --force --reboot
```

##### 容易踩坑三点
1. rollback需要前置版本，更新操作会生成前置版本。全新板子只有一个版本，直接rollback无旧版本可回退，会提示。自动回滚不受该限制：安装新版本解压并存旧版本，健康校验时两个版本都存在，回滚目标为旧版本。`rollback_target`选择低于当前版本、未标记故障的最高版本。**板子第一次更新后就拥有完整保护**。
2. 引导安装阶段没有前置版本，天然无保护。golden基准版本计划在1.0.0正式启用，当前未配置，`reset-to-golden`如实提示无基准版本，不会异常操作。
3. `version`显示当前运行版本，不是仓库所有版本列表，不会列出多个共存包。直接查看本地目录：
```bash
ls -l /opt/robot/daemon/releases/ /opt/robot/daemon/current
```
`apply --version`要求上游仓库保留该版本；`select`只依赖本地文件。GitHub会删除已知坏版本，`apply --version 0.1.3`会故意失败；但本地已经解压的板子依然可以`select 0.1.3`。该不对称设计：新板子无法拉取坏版本；已有坏版本的板子保留逃生通道。

#### 离线安装
侧载、工厂烧录，或者updaterd版本过低无法在线升级修复包。参考`install-dev.md`，使用`updaterd install --from`，`--force`参数使用前阅读条件。

### 日志
```bash
journalctl -u configd -b --no-pager | tail -40
journalctl -u btd -f
```
替换服务名 `robotd` / `updaterd`。`-f`实时跟踪；`-b`仅本次开机日志。
启动日志行包含版本、git修订号、进程启动目录，warn级别，不受日志级别过滤。

更新日志独立于系统journal，每条`fsync`持久化，路径`/var/lib/robot/updater/`，在日志易丢失的系统上断电不丢失。
```bash
robotctl update log
```
最近20次更新完整记录保存在`runs/`目录，按发生顺序写入：
```bash
robotctl update show 42
```
更新记录可以承受版本切换、回滚、断电。`/var/log`在这块板子是zram，系统journal断电丢失。如果`robotctl`本身损坏，记录是换行分隔JSON，直接cat读取：
```bash
sudo cat /var/lib/robot/updater/runs/000042.jsonl
```

### Tab自动补全
`install.sh`配置bash补全，放在`/usr/share/bash-completion/completions/`，加载器调用二进制获取补全项。**随发布包更新，新增命令自动生效**，不会陈旧。放在该路径，仅第一次输入`robotctl<TAB>`加载，而不是每次登录。直接从target目录运行或其他shell：
```bash
eval "$(robotctl completions bash)"
```
支持zsh、fish、elvish、powershell替换bash。
