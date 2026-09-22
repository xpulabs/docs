# 游戏手柄配对
每个手柄只需配对一次。配对完成后，`padd.service` 会在开机后接管所有已连接的手柄；无需手动启动服务，也不会随着你的SSH会话结束而停止。

## 将手柄设为配对模式
Xbox手柄需要两步操作，第二步最容易出错：
1. 短按Xbox键开机。**不要长按**，长按会直接关闭手柄。
2. 按下手柄顶端、USB‑C口旁的小同步键，直到Xbox指示灯快速闪烁。慢闪烁代表手柄已开机，但未进入配对模式。

DualSense手柄：同时按住**创建键（Create）**和**PS键**，直到灯带闪烁。

Switch Pro手柄（无品牌Switch样式手柄，`bluetoothctl`会识别为Pro Controller）：按住顶端USB‑C口旁边的小同步键，直到玩家指示灯来回滚动。
> 说明：它属于经典蓝牙（BR/EDR）手柄；Xbox手柄则是低功耗蓝牙（LE）。机器人配对这两类手柄的流程顺序相反；`pad pair`命令会自动识别并使用正确流程。如果需要手动配对，就需要留意配对顺序。

## 执行配对
```bash
sudo robotctl pad pair
```
提示：正在寻找处于配对模式的游戏手柄。Xbox手柄请按顶端的小同步键（**不是Xbox键**，按Xbox键会关机）
```
paired  Xbox Wireless Controller 78:86:2E:BB:13:28
```
`padd`现已接管该手柄。

无需填写MAC地址：机器人会搜索处于配对模式的手柄，并配对找到的那一个。手柄不仅完成配对，同时被标记为**信任设备**，这样无人登录时，重启后手柄也能自动重连。

如果同时有两个手柄处于配对模式，命令不会猜测选择，而是直接拒绝配对并打印两个设备地址。
你也可以指定MAC地址，配对机器人无法自动识别为游戏手柄的硬件：
```bash
sudo robotctl pad pair 78:86:2E:BB:13:28
```

添加第二个手柄**不需要先删除旧手柄**。已经绑定的手柄只要在信号范围内，每次扫描都能被发现；程序会优先选择处于配对模式的手柄。配对完成后两个手柄都会保留，`padd`会接管任意一个成功连接的手柄。
缺点：如果重新运行命令，但没有新手柄进入配对模式，程序会等待完整搜索超时后，才返回已存在手柄的信息。如果仅需要修复信任关系，可以加参数 `--timeout 5`。

## 检查手柄状态
```bash
robotctl pad status
```
示例输出：
```
pad     Xbox Wireless Controller 78:86:2E:BB:13:28  connected
padd    active — driving whatever pad connects
```
两行信息代表两个独立组件，故障互不影响：手柄显示已连接，但驱动失效时，现象就像机器人正常运行却完全无视你的操作。

Switch Pro手柄内置六轴IMU，内核会把它暴露成**第二个输入设备**，和手柄按键摇杆的输入设备分开。
在`robotctl monitor`界面按`p`调出手柄面板，只有手柄带有IMU时才会显示：面板里会显示线框手柄模型，姿态和真实手柄同步；俯仰、横滚由重力计算，偏航角仅依靠陀螺仪（存在漂移，手柄本身无法获取绝对航向），还有陀螺仪静态偏移量。需要等待校准，画面才不会自行旋转。将手柄静置半秒，面板会提示已稳定。
监控窗口未打开时，IMU数据流不占用资源；`padd`仅在程序订阅采集，或是用IMU控制机器人头部时才读取IMU节点。

同样的姿态数据还可以控制机器人头部：
```bash
sudo robotctl configure
```
找到 `Controller-IMU head control` 选项，设为启用`Y`：此时摇杆继续控制移动，手柄倾斜将控制机器人头部；再次按`Y`锁定头部；第三次按`Y`，以手柄当前姿态重新置中并继续跟随。完整操作流程见速查表。
监控画面里的虚拟手柄和机器人头部共用同一个滤波器，虚拟手柄指向哪里，机器人头部就转向哪里。

> 重要状态：**已配对但未信任**。此时手柄能临时工作，但重启后不会自动重连。因为重连授权需要配对代理，开机阶段没有代理程序。重新执行 `pad pair` 即可修复。

## 删除手柄绑定
```bash
sudo robotctl pad forget 78:86:2E:BB:13:28
```
这条命令只会删除机器人这边的绑定记录（机器人仅能删除本地这一半绑定）。手柄内部仍然保留绑定信息，因此再次配对时，必须重新把手柄切到配对模式；否则手柄会携带机器人已删除的密钥，连接被拒绝。

Xbox手柄仅能保存一个主机绑定记录。一次未完成的配对会让手柄保存一块机器人主板不再识别的密钥，故障现象和主板硬件损坏一模一样。
如果配对反复失败，可以先把手柄连到笔记本电脑，在电脑上删除该设备；以此释放手柄的绑定槽位。仅仅把手柄切到配对模式，不一定能可靠释放旧绑定。

## 手柄完全无法建立绑定（bond）
aic8800蓝牙芯片存在一个问题：当`btd`正在广播时，手柄无法新建绑定。给这类主板重新部署时，增加参数`--pause-btd-on-pair`：
```bash
./scripts/provision-board.sh --pause-btd-on-pair pierre@192.168.1.42
```
该命令会在 `/var/lib/robot/weird-ble` 留下标记，其余配置不变。带有该标记的主板，执行`sudo robotctl pad pair`会自动处理后续流程：停止`btd`、蓝牙适配器断电重启、完成配对、再启动`btd`，过程会打印日志。已有的绑定不受影响，已配对手柄依旧可以正常连接、控制机器人。

部分设备即使暂停`btd`，在BlueZ默认配置`Privacy = off`下依旧无法绑定。这类主板需要`--weird-ble`参数，该参数自动包含暂停`btd`，同时设置`Privacy = device`。

**优先尝试仅暂停btd方案**。如果主板只需要暂停btd，却加上`--weird-ble`，会引发更严重故障：手柄绑定成功后反复断开，报错`Encryption Change: PIN or Key Missing (0x06)`，最终无法生成输入设备。出现这个报错时，去掉`--weird-ble`，保留暂停btd参数。`install-dev.md`文档里有对照表和切换命令。

在这类主板上手动配对，需要这两步：
```bash
sudo systemctl stop btd
sudo bluetoothctl power off && sudo bluetoothctl power on
```
配对完成后执行：
```bash
sudo systemctl start btd
```
适配器断电重启这一步不可省略。仅停止`btd`，广播和配对代理分配的IO能力仍然残留，手柄依旧无法绑定；重启主板也能达到同样效果，这个问题就是这样发现的。**不要使用 `systemctl restart bluetooth`**，在该主板上执行这条命令会直接丢失蓝牙适配器，只能重启主板恢复。

`install-dev.md`文档默认开启`--weird-ble`，因为大约一半主板需要它，且无法提前判断。但不需要这个参数的主板不建议启用：每次配对都会触发停止`btd`、适配器断电重启，带来额外开销。文档同时提供检查和移除该标记的方法。

这两个参数都只是aic8800蓝牙芯片的临时规避方案，不是设计本身的特性；更换蓝牙模块后就不再需要。

## 经典蓝牙手柄与 bluetoothd CPU占用
Switch Pro手柄无论是否操作，每个数据包都会发送IMU采样，每秒约200包。BlueZ默认`UserspaceHID=true`时，每个数据包都由`bluetoothd`通过uhid转发；在graphite平台，手柄静置时就占用一个CPU核心16%算力。
`scripts/setup-board.sh`会在所有主板的`/etc/bluetooth/input.conf`中将`UserspaceHID=false`，把通道交给内核hidp驱动，让`bluetoothd`退出数据传输链路。实测CPU占用降到接近0%，驱动、输入节点、绑定关系均不变。修改在下一次开机生效。
Xbox这类低功耗（LE）手柄不受这个配置影响：GATT上的HID协议不走`input.conf`。
在脚本发布前部署的主板，重新运行脚本即可启用：
```bash
sudo sh scripts/setup-board.sh && sudo reboot
```

## 手动配对Switch Pro手柄
仅在`pad pair`命令不可用时才手动操作。配对顺序很关键，**和Xbox手柄相反**：
```bash
bluetoothctl pair 98:B6:E9:28:06:09
bluetoothctl connect 98:B6:E9:28:06:09
bluetoothctl trust 98:B6:E9:28:06:09
```
> 警告：先执行connect会附带建立绑定，会进入一个很难排查的异常状态：手柄灯常亮，`pad status`显示已连接，`bluetoothctl info`显示Paired: yes、Connected: yes，但系统没有生成输入设备。`padd`会卡在“等待padd打开手柄”，完全无法控制。
> 恢复方法：`sudo robotctl pad forget <地址>`，把手柄切回配对模式重新配对。
> 使用`pad pair`不会出现该问题：它通过BlueZ上报的设备类型识别出这是经典蓝牙手柄，**先配对，再连接**。

## 每次配对都失败
检查`/etc/bluetooth/main.conf`中的Privacy配置，推荐值为 `Privacy = device`。
如果配置是`Privacy = off`，主板可能完全无法绑定手柄；连接会终止，提示`le-connection-abort-by-local`，手柄永远无法进入Paired状态。

如果抓包日志显示配对报错`DHKey check failed (0x0b)`，属于相反故障，可以尝试设置`Privacy = off`。修改配置前先用`btmon`抓包，两种故障对应的解决方案不一样。
```bash
sudo sh scripts/setup-board.sh
sudo reboot
```
`setup-board.sh`会自动修正配置，修改需要重启才生效。

其他常见原因：配对流程启动前手柄就退出了配对模式。重新按下同步键，在指示灯快速闪烁时再次执行配对命令。
查看蓝牙配对交互日志：
```bash
sudo btmon -t > /tmp/btmon.log 2>&1 &
```
执行配对，之后执行 `sudo pkill btmon`，搜索 `SMP: Pairing Failed` 以及后面的错误原因。这是唯一能区分「主板配置错误」和「手柄未进入监听状态」的工具。

## 操控过程中手柄断开
直接在主板上查看手柄原始输入流：
```bash
robotctl monitor
```
按`p`打开面板。面板展示`padd`读取的原始evdev数据流，每一条上报都带有内核时间戳：
```
┌ pad Xbox Wireless Controller · /dev/input/event5 · 78:86:2e:bb:13:28 ─────────────┐
│ cadence  124/s while driving · last 8 ms ago · worst 84 ms · over 100 ms 0 · …    │
│ gap ms                                       ▁▁▁▁▂▁▁▁▁▃▁▁▁▁▁▁▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ │
│ X     ····│██··   -8734 Y     ····│····       0 Z     ·········       0 …         │
│ held     BTN_START                                                                │
└ 4213 reports · gap ≤100 ms ───────────────────────────────── reports intact ──────┘
```
推动摇杆，面板里的进度条会跟着变化。
该面板重点看上面的间隔行：每一条上报对应一条竖线，卡顿会表现为尖峰；即使已经恢复，尖峰仍然保留。满高代表100ms，超过这个延迟就能感受到操控卡顿；超过500ms时`robotd`会将速度置零，机器人停止运动。

机器人其他工具无法观测这个底层数据。`padd`会以50Hz重复发送上一次摇杆数值，所以无线链路中断时，上层系统看起来仍然正常：`robot.state`持续有控制指令，紧急停止不会触发，机器人会继续执行一条已经不存在的指令。上方面板的目标指令列看起来完好，而这个输入面板曲线会拉平。

手柄静置时不会发送任何数据，所以无数据仅在你正在操控时才算故障。面板会区分：摇杆保持不动超过5秒和链路中断，分开统计。

如果需要一段时间内的统计报告（而非实时画面），从代码仓库克隆目录把脚本传到主板：
```bash
scp scripts/pad-link-test.sh radxa@<board>:/tmp/
```
查看历史记录，读取`padd`日志，不需要手柄工作，立刻返回结果：
```bash
sudo sh /tmp/pad-link-test.sh --history
```
实时测试链路：保持手柄开机、`padd`运行，**两分钟内持续推动摇杆**。手柄静止时不发送数据，静默会被误判为链路卡死。
```bash
sudo sh /tmp/pad-link-test.sh
```
脚本统计丢包和连接状态下输入上报的间隔。间隔超过500ms机器人就会停止，`robotd`清零速度。每次丢包附带内核错误码：
- `0x08`：监管超时，代表距离太远或存在无线干扰
- `0x13`：手柄被手动关机

把手柄放下不算卡顿，不会计入故障。但这段时间没有有效数据，报告会标注实际操控时长，不会依据少量采样评判链路质量。
可以一边运行测试一边远离机器人，以此测试有效通信距离。

## 对比两块主板的软件栈
同一个手柄在一台机器人卡顿、另一台正常，问题通常不是手柄本身。两块主板生产时间相差几周，内核、BlueZ、蓝牙控制器固件、手柄固件版本都可能不一样，这些信息在`pad status`里看不到。

将检测脚本传到每块主板（仓库克隆目录执行）：
```bash
scp scripts/pad-stack-report.sh radxa@<board>:/tmp/
sudo sh /tmp/pad-stack-report.sh
```
脚本打印完整软件栈信息，并保存日志到 `/tmp/pad-stack-<host>-<when>.log`，内容包含：内核版本、BlueZ版本、适配器HCI版本、蓝牙芯片型号、开机加载的固件、HID传输方式、绑定密钥、当前传输协议、手柄固件版本。大部分信息无需root，少数权限不足的项标记为不可读。

对比两块主板，只提取需要匹配的指纹信息：
```bash
ssh radxa@<board-a> sudo sh /tmp/pad-stack-report.sh --fingerprint > /tmp/a.fp
ssh radxa@<board-b> sudo sh /tmp/pad-stack-report.sh --fingerprint > /tmp/b.fp
diff /tmp/a.fp /tmp/b.fp
```
没有输出=软件栈完全一致。指纹不含时间戳和MAC地址，`diff`输出的差异都是真实配置区别。

重点看两行：
- `transport`：目前测试的手柄大多是LE；如果显示BR/EDR，代表手柄走内核经典HID通道，不是BlueZ，驱动、按键编号都会不一样。
- `input`：总线/厂商/产品/版本四元组，SDL和gilrs会哈希生成映射GUID。两块主板该项不同，则摇杆、按键映射不一样，即使其他参数全部相同。

操控相关（按键、速度限制）在速查表；通过转发Socket，从笔记本远程运行`padd`的方法在开发速查表。

