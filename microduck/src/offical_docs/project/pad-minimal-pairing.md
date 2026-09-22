# 游戏手柄蓝牙绑定的最小环境
记录时间：2026-08-18；硬件：Radxa Zero 3W（MAC：50:37:CD:16:2A:39），Xbox无线手柄（MAC：78:86:2E:92:47:67）。已在另一块搭载同款网卡的Zero 3W开发板复现验证。

## 可成功绑定的操作流程
烧录Radxa Zero 3专用极简版Armbian镜像。在镜像烧录器内预先配置WiFi与用户名，**不额外安装任何软件**：不部署后台守护进程、不执行设备初始化配置。

```bash
sudo sed -i -E 's|^[[:space:]]*#?[[:space:]]*Privacy[[:space:]]*=.*|Privacy = device|' /etc/bluetooth/main.conf
grep -n "^Privacy" /etc/bluetooth/main.conf
sudo reboot
```
> 这里**必须重启，不能只执行`systemctl restart bluetooth`**：单纯重启蓝牙服务有时会导致内核占用hci0，报“无默认控制器”，只有整机重启才能清除该异常。

按住手柄配对键直到指示灯快速闪烁，然后执行：
```bash
bluetoothctl
scan on
```
等待日志出现 `[NEW] Device 78:86:2E:92:47:67 Xbox Wireless Controller`，继续：
```bash
scan off
connect 78:86:2E:92:47:67
```
授权请求选择`yes`，然后执行：
```bash
trust 78:86:2E:92:47:67
```
**全程不需要输入`pair`命令**。

## 绑定成功后的验证现象
```bash
ls /dev/input/js*
dmesg | tail -3
```
内核输出示例：
```
input: Xbox Wireless Controller as /devices/virtual/misc/uhid/0005:045E:0B13.0001/input/input5
microsoft 0005:045E:0B13.0001: input,hidraw0: BLUETOOTH HID v5.09 Gamepad [Xbox Wireless Controller]
```
验证输入数据流：全程拨动左摇杆，跳过前184字节，查找类型0x02、时间戳持续递增的事件包：
```bash
sudo timeout 5 cat /dev/input/js0 | od -Ad -tx1 | head -20
```
绑定关系可承受手柄断电重启（长按Xbox键约6秒关机，再重新开机）：
```bash
ls /dev/input/js*; bluetoothctl info 78:86:2E:92:47:67 | grep -E "Connected|Bonded|Trusted"
```

## 测试成功的开发板配置
该配置并非预期标准方案，因此全部参数记录如下：
- `cat /sys/module/aic8800_bsp/srcversion`：`738316A2E9D9825966BDB6B (86016)`
- 最小/最大连接间隔 `conn_min_interval / conn_max_interval`：24 / 40（内核默认值，对应30–50ms）
- `/etc/bluetooth/main.conf`：`Privacy = device`
- 运行的守护进程：无

文档`design/pad-bond-failure.md`中标记此驱动存在缺陷；本次测试未修改连接间隔。但这两项都不是决定手柄能否绑定的关键因素。

## 失败场景汇总
| 测试环境 | 结果 |
| ---- | ---- |
| 纯净Armbian，Privacy = off（或不配置该项，BlueZ默认为off） | connect返回`le-connection-abort-by-local`；配对状态为否，完全不执行SMP安全交换 |
| 纯净Armbian，无Privacy配置行，先执行pair再connect | 可完成绑定，但每次重连都会报`Encryption Change: PIN or Key Missing (0x06)`，连接每秒反复断开重连 |
| 已初始化配置的开发板（确认第99行Privacy=device），停止padd、btd，手动connect | 授权请求通过，随后`ServicesResolved: no`，手柄立刻断连，不会生成js0设备 |

第三行是待定位的疑点：**完全相同镜像、相同Privacy参数，一旦设备完成初始化配置就会失败**。问题根源是初始化脚本修改了系统持久态配置，而非正在运行的进程；就算停止padd和btd，配对依然无法恢复。

## 新建绑定和维持已有绑定是两回事
在完整部署、全部后台服务运行的设备上：**已经完成绑定的手柄可以正常连接、操控**。
但执行`robotctl pad pair`（先forget清除旧绑定，手柄进入配对模式，新建配对）会失败。

也就是说：现有绑定不会被系统破坏；但系统内某个组件会阻止**创建新的蓝牙绑定**。configd与btd日志没有给出有效排查信息。

## 测试计划：逐个叠加组件
将开发板重新烧录镜像，确认上面最小流程可正常配对；**每次只新增一项组件，重启，尝试新建配对，再继续叠加下一项**。

脚本复制到家目录`~`，不要放到`/tmp`：每一步都要重启，`/tmp`内容重启后丢失；btmon抓包文件同理。
```bash
scp scripts/setup-board.sh scripts/migrate-network.sh pierre@BOARD:~/
```

| 步骤 | 新增内容 | 手柄能否配对 | 备注 |
| ---- | ---- | ---- | ---- |
| 0 | 无，上面最小环境 | 是 | 对照组 |
| 1 | `sudo sh ~/setup-board.sh`：设备树覆盖层、console=display、getty掩码、onnxruntime | 是 | |
| 2 | `sudo sh ~/migrate-network.sh`：netplan迁移至NetworkManager | 是 | |
| 3 | `sudo -E sh ~/install.sh` | 否 | 首轮测试；守护进程全部启动 |
| 3b | 设置`DUCK_NO_START=1`，重启 | 是 | 证明install.sh写入磁盘的文件本身没问题 |
| 4 | `systemctl enable --now updaterd` | | |
| 5 | 启动robotd | | |
| 6 | 启动configd | | |
| 7 | 启动btd | | |
| 8 | 启动padd | | |

测试执行时间：2026-08-19。每一步都用bluetoothctl手动配对，测试完成后删除手柄设备。
步骤1、2配对正常；到install.sh环节配对失效。
结论：设备板级初始化、设备树覆盖层、控制台重定向、NetworkManager迁移均不是故障原因。

2026-08-19拆分install.sh内部逻辑：设置`DUCK_NO_START=1`并重启后，手柄可以正常绑定。
说明install.sh写入磁盘的内容都没问题：系统单元、用户、用户组、发布目录、token配置片段都排除嫌疑。**问题来自五个守护进程中正在运行的某一个**。

本次测量前浪费三次测试，根源相同：发布包内`hooks/postinstall`会在updaterd安装阶段提前执行`systemctl enable --now`启用所有服务单元，早于install_units。测试过程中守护进程一直处于运行状态；就算之后执行`systemctl disable --now`，也无法撤销它已经写入蓝牙适配器硬件的状态。btd会保留“可配对”标志、广播实例，以及默认配对代理设置给适配器的IO能力。**测量前必须重启**。

## 定位到元凶：btd
2026-08-19，单一变量对照，在MAC尾号2A:39设备上双向可复现：
- btd启用 → 重启 → 手柄重置 → 新建配对：失败
- btd禁用 → 重启 → 手柄重置 → 新建配对：成功

成功测试时没有清空`/var/lib/bluetooth`目录。btd驱动BlueZ生成的两个持久文件（attributes：本地GATT数据库；identity：适配器本地IRK身份密钥）均排除嫌疑，其他持久存储数据同样无关。

早期有一轮测试，关闭btd仍然无法配对，原因是手柄自身的绑定槽：Xbox手柄仅保存一个主机绑定记录。一次未完成的配对会让手柄保留一份主机密钥，但开发板这边密钥已经不存在。**每次测试前需要在电脑上重置手柄**，否则故障现象和被污染的绑定记录完全一致，这个问题耗费了近两天排查时间。

> 重点：所有后台服务运行时，**已经存在的绑定不受影响**，绑定好的手柄可以正常连接操控；仅新建绑定失败。

## 原理猜想（尚未实测验证）
btd作为外设持续广播。当`Privacy = device`时，广播使用可解析私有地址；但同一蓝牙适配器又作为中心设备尝试与手柄建立绑定。SMP DHKey校验会基于两端设备地址计算，这种场景会触发`DHKey check failed (0x0b)`错误。当初项目正是因为这个报错，在btd运行的环境下把Privacy设置改成off。抓取失败配对的btmon日志，查看地址类型与SMP失败原因，即可确认猜想。

## 两个独立故障，曾被误判为同一个
测试前重置手柄，保证结果不受残留绑定记录干扰：
1. **开发板个体差异**：全新纯净Armbian，部分Zero3W在BlueZ默认`Privacy=off`下可以绑定手柄；另一部分完全无法绑定，只能用`Privacy=device`。十块板子中两类大约各一半，暂时没有找到可量化区分的硬件参数。
2. **Privacy配置与btd冲突**：设置`Privacy=device`时，只要btd在广播，就无法新建手柄绑定。

两者叠加，就会出现当初`DHKey check failed (0x0b)`报错：当时在一块需要`Privacy=device`才能配对的板子上测出故障，误判定是Privacy=device本身破坏配对。导致连续两周，半数开发板无法完成手柄绑定。

仅仅停止btd进程还不够：进程退出后，它写入蓝牙控制器的配置仍然保留。所有成功的手动配对操作，都是在停止btd后执行了重启。
替代方案：蓝牙适配器电源循环 `bluetoothctl power off && power on`，可以代替重启。2026-08-19验证：完整部署的板子，执行该命令后首次配对即可成功，这也是把配对操作简化为单条命令的基础。

两套修复逻辑都封装在`provision-board.sh --weird-ble`，不需要该方案的板子不会启用：该参数自动设置`Privacy=device`，并写入标记文件`/var/lib/robot/weird-ble`；`robotctl pad pair`仅在带有该标记的板子上临时暂停btd。优先在不带该标记的板子测试。aic8800网卡更换后，这两个问题都会消失。

> 测试规范：每一步操作后重启；每次配对尝试前清空两端绑定记录：开发板执行pad forget / bluetoothctl remove，手柄进入配对模式。Xbox手柄只能保存一个主机绑定，半完成的配对会残留密钥，现象和真实故障一模一样。

步骤3需要install.sh读取的环境变量：
```bash
export DUCK_TOKEN=github_pat_replace_with_your_token
export DUCK_REF=pad-privacy-device-not-off
export DUCK_DEV_KEY=$HOME/team.dev.pub
```
步骤1、2不需要token和网络。

## 和microduck_runtime对比，存在尚未验证的差异
microduck_runtime安装脚本会在NetworkManager活跃WiFi连接上关闭WiFi省电（install.sh:244、:383）：
```bash
sudo nmcli con mod "$WIFI_CON" wifi.powersave 2
```
scripts目录没有对应的配置。aic8800是WiFi+蓝牙二合一芯片，共用SDIO射频通道，因此这是一个可疑候选因素。但之前能正常配对的纯净板没有读取该项参数，仅为推测，尚未证实。
查看WiFi省电状态命令：
```bash
iw dev wlan0 get power_save
```

## 故障3：手机已连接时，已绑定手柄无法重连（实测，2026-09-17）
前面两个故障都是**新建绑定**问题；本故障是**重连**，相互独立，也是手机APP用户最先碰到的问题。

测试设备lavandiere：使用`--weird-ble`初始化，`Privacy=device`，Xbox手柄已绑定并信任。

| 场景 | 现象 |
| ---- | ---- |
| APP先连接，再打开手柄电源 | 手柄始终无法连上开发板 |
| 退出APP，再打开手柄电源 | 手柄立刻连接成功 |
| 先连接手柄，再打开APP | 两者都正常工作 |

结论：绑定记录、手柄本身没有问题。**先建立的链路会被保留，第二条链路可以附加；但btd作为外设广播链路存在时，无法发起新的中心设备连接**。

开发板主动执行connect会直接返回明确错误，而不是单纯超时：
```
Failed to connect: org.bluez.Error.Failed le-connection-abort-by-local
```
这是本地主机主动终止连接，不是手柄拒绝。BlueZ后台对可信设备的自动重连逻辑同样报这个错，这就是手柄无响应的根本原因。

发生该故障时btd**并没有广播**：当存在中心设备连接时，btd会停止广播，这也是手机APP连上机器人后，duckctl扫描不到该机器人的原因。
因此这不是故障2的变体：广播已经关闭，发起连接仍然失败。指向**蓝牙控制器硬件限制：工作在外设角色时，不能作为发起端**，不是守护进程软件逻辑选择。

### 不值得开发的修复方案
直观方案：configd/padd轮询检测可信但离线的手柄，主动发起连接。不可行，因为该调用就会触发上面的报错。

另外两套可行方案在当前射频芯片上都存在严重取舍：
1. 手柄请求连接时，btd主动断开手机链路。手机会随机掉线；并且btd没有办法感知手柄是否正在请求连接。
2. 将配对、重连逻辑交给APP控制，由APP主动断开链路后再执行配对。需要大量开发工作量，而本项目后续计划直接更换这块aic8800芯片。

### 替代使用方案
**先打开手柄，再打开手机APP**。按这个顺序两者都可正常工作，这就是全部规避办法。
`pad.status`接口分开上报“已绑定”和“已连接”状态。客户端可以识别这种状态：已绑定、已信任、未连接，并提示用户，而不是让用户反复按Xbox按键，机器人却无响应。

和前两个故障一样，更换aic8800网卡后，该问题会一并消失。

---
术语注释
- Bond：蓝牙绑定（长期密钥配对）
- BlueZ：Linux蓝牙协议栈
- SMP：安全管理协议，蓝牙用于密钥交换
- IRK：身份解析密钥（可解析私有地址用）
- peripheral / central：蓝牙外设角色 / 中心角色
- AIC8800：WiFi+蓝牙二合一SDIO无线芯片
- btd、padd、configd、robotd、updaterd：项目自定义后台守护进程
- js0：Linux输入子系统游戏手柄设备节点
