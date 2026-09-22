# duckctl — 全部命令
在笔记本上与机器人通信，**无需网络，无需SSH**。它是手机App的替代工具，也是访问从未接入过WiFi网络的机器人的方式。

当前底层使用低功耗蓝牙（BLE）通信，但工具名称刻意没有带上蓝牙字样：`mediad` 为机器人提供了第二种传输通道，可调用另一组接口。因此该工具以**通信对象**命名，而非当前使用的无线链路。在仅有BLE作为通信方案的阶段，它曾命名为 `duck-btctl`。

> ⚠️ **不要在机器人板端运行 duckctl**。正式发布固件不依赖该工具；板端预装的工具是 `robotctl`，命令参考 `cheatsheet.md`，其中大部分命令都有对应的 duckctl 版本，见下文。

## 安装方式
在本仓库克隆目录内直接运行：
```bash
cargo run -q -p duckctl -- --name <robot-name> info
```
或者一次性安装（缺点：安装后是固定快照，不会跟随代码分支自动更新）：
```bash
cargo install --path duckctl
duckctl --name <robot-name> info
```
下文所有命令均采用**已安装**的写法。如果想在源码目录直接运行，在命令前加上 `cargo run -q -p duckctl -- `。

该工具旧版本会安装为 `btctl`。如果执行 `which btctl` 仍然能找到该程序，那是你之前安装的旧版本，不会自动更新：
```bash
cargo uninstall btd --bin btctl
```

## 查找机器人
```bash
duckctl scan
```
```
1 robot(s) advertising the duck service:
  aa:bb:cc:dd:ee:ff duck-c51b — 192.168.1.42, 1 service(s)  ← DUCK_ROBOT

7 other device(s) in range, not listed. …
```
扫描结果**只列出机器人**，其他在无线范围内的设备仅做计数，不展示。加上 `--verbose` 参数会展开完整设备列表；当目标机器人不在首条结果时，建议开启该参数。

每台机器人会广播自身IPv4地址，这也是SSH连接所用IP的来源。**无需建立连接，不需要PIN码**。
- 行内无IP地址：机器人未接入网络；
- 整条记录没有IP：固件版本较旧，当时机器人还不支持广播IP，可使用 `duckctl wifi status` 查看网络状态。

SSID不会出现在扫描列表里——广播数据包容量不足以承载。`duckctl wifi status` 可以查看SSID、信号强度与双地址信息。

只获取IP地址，用于命令替换：
```bash
ssh radxa@$(duckctl ip)
```
`ip` 子命令仅输出IP地址，方便脚本替换。它读取蓝牙广播包，**不建立连接、无需PIN**，耗时约1秒。地址信息不会过时：`btd` 每5秒重新读取地址，网络变更时会重新广播。

或者直接使用内置ssh封装：
```bash
duckctl ssh
duckctl ssh -- sudo robotctl pad pair
```
`ssh` 子命令和 `ip` 一样自动获取IP，然后直接调用原生ssh。交互提示、终端会话、退出码都由ssh本身提供。
登录用户名优先使用 `--user` 参数；其次读取环境变量 `DUCK_BOARD_USER`（`dev-push.sh` 也读取该变量，配置过dev推送的笔记本可直接复用）；默认用户为 `radxa`。
`--` 后面的内容会直接在机器人上执行，不会打开交互式shell。

文件传输用法类似：
```bash
duckctl scp report.md :/tmp/
duckctl scp :/var/log/robotd.log .
```
路径以 `:` 开头代表机器人板端路径：相当于scp的`host:path`，主机部分由工具自动查找。其余参数原样传给scp，包括 `-r` 等选项，进度条、退出码均为scp原生行为。用户名解析规则和ssh一致。

> 工具自身参数放在路径前面：
```bash
duckctl --name ducky scp -r logs/ :/tmp/
```
如果整条命令中没有 `:`，扫描阶段就直接拒绝执行：判定为本机到本机拷贝，不涉及机器人，scp本身不会提示该问题。如果本地文件名字真的是`:foo`，写成 `./:foo`。

当笔记本和机器人已蓝牙绑定后，机器人经常会停止向本机广播服务。此时 `ip` 会建立连接调用 `net.status` 查询地址，速度更慢，**需要PIN码**，但一定能返回结果。`--verbose` 会打印当前使用的是广播方式还是查询方式。

没有网络地址的机器人，不会直接返回空结果，而是给出处理方案。因为配置网络必须走无线链路；WebRTC设计上不允许通过它调用 `net.connect`。

从未重命名的机器人命名规则：`duck-` + 由序列号生成的4位字符，例如 `duck-c51b`。macOS可能同时展示两个名称，如 `radxa-zero3 [duck-c51b]`，**两个名称都可以作为 --name 的参数**。

现象：扫描显示名称为`duck-c51b`，一次连接后扫描只显示`radxa-zero3`。
原因：固件只在广播包写入机器人名称，但适配器名称没有更新，客户端缓存了适配器名称。
解决：升级机器人固件；固件升级不会清除客户端缓存，需要手动清理：Linux执行`bluetoothctl remove <mac>`，macOS在蓝牙设置里忽略该设备。

不指定名称（无`--name`，也未设置`DUCK_ROBOT`）：默认选用扫描找到的第一台机器人。
指定名称，但有多台机器人匹配该名称 → 直接报错，不会自动选择：
```
2 robots answer to "radxa-zero3": radxa-zero3, radxa-zero3
```
成因：板子bootloader序列号为空，主机名被用作机器人名称，同一镜像烧录的所有板子名字相同。
解决：在机器人板端重命名，使用新名称：
```bash
robotctl system set-name ducky
```

## 网页控制台
机器人内置网页，可预览摄像头画面、远程控制机器人：
```bash
duckctl open
```
自动查找机器人，在浏览器打开 `http://<address>:8080/`。
- `--print`：只输出URL，不打开浏览器，适合无浏览器机器或脚本；
- `--port`：用于`mediad`使用非默认web端口启动的机器人。

**无需额外安装服务**：页面内嵌在`mediad`守护进程中，只要机器人运行该服务，就自带网页控制台。

网页功能：
- 摄像头画面，附带链路码率、帧率、丢包、往返延迟；
- 双虚拟手柄，W/A/S/D、Q/E按键控制，速度0.3m/s，角速度1.5rad/s；可拖动画面定点观察；
- 启用、初始化、松弛、停止、关机按钮；
- 语音库菜单，机器人动态填充技能菜单：机器人拥有哪些技能是配置项，页面会查询`robot.policies`，而非写死预设列表；
- 2Hz状态流 + `robot.health`，展示舵机过热、电池低电量、控制环路卡顿等告警。

> `stop`只是清零网页下发的控制指令，**不是急停**。本系统无法通过浏览器切断舵机电源，按钮仅为普通停止指令。

页面底部折叠面板：原始JSON窗口、日志、WebRTC连接拒绝的调用信息，用于验证路由表，**不直接驱动机器人**。

涉及两个端口，只有网页端口需要手动关注：页面通过自身所在主机连接8443信令服务器。页面加载成功但提示信令端口无响应，代表机器人正常运行，但你的电脑与机器人8443端口之间被阻断，**通常是防火墙**。

摄像头与运动控制依赖WebRTC。**无网络地址的机器人无法打开网页控制台**。需要先通过蓝牙配置WiFi，下面的`duckctl wifi connect`不需要本机已有网络。

## 固定目标机器人
把机器人名称写入环境变量，不用每次命令都带`--name`：
```bash
export DUCK_ROBOT=duck-c51b
```
写入`~/.zshrc`可以永久生效。之后命令可以省略`--name`：
```bash
duckctl info
```
`DUCK_PIN`同理，用于需要配对PIN码的机器人：
```bash
export DUCK_PIN=418299
```
单次命令临时切换其他机器人，`--name`优先级更高：
```bash
duckctl --name duck-ffff info
```
单次执行清空默认机器人（工作台存在别人的机器人场景）：
```bash
DUCK_ROBOT= duckctl scan
```
`scan`会标记`DUCK_ROBOT`指定的机器人并放在列表首位；所有查找机器人的命令，扫描前都会打印目标名称。

## 身份管理
```bash
duckctl --name <robot-name> info
```
查看名称、序列号、运行时长。

```bash
duckctl --name <robot-name> name <new-name>
```
重命名，最多24字符。几秒内生效，**无需重启**。但Mac会缓存旧蓝牙名称，所以macOS蓝牙设置和scan结果会滞后。后续所有命令使用新名称。
> ⚠️ 重命名**不会自动更新环境变量`DUCK_ROBOT`**，需要手动修改该变量，否则后续命令会查找不存在的旧名称。

```bash
duckctl --name <robot-name> reboot
```
重启机器人。

## WiFi相关
```bash
duckctl --name <robot-name> wifi status
```
查看SSID、信号强度、网络地址。

```bash
duckctl --name <robot-name> wifi scan
```
扫描WiFi，耗时数秒：机器人会重新扫描无线信道，不是直接返回上次缓存结果。

```bash
duckctl --name <robot-name> wifi connect <ssid> --psk <passphrase>
```
开放网络去掉`--psk`参数。连接新网络会断开原有WiFi，正在运行的SSH会话会断开，属于正常现象。最多等待45秒返回结果。

```bash
duckctl --name <robot-name> wifi forget <ssid>
```
删除保存的WiFi配置。

## 健康与状态
```bash
duckctl --name <robot-name> health
```
查看控制环路健康状态。

```bash
duckctl --name <robot-name> status
```
版本握手信息与更新状态。

## 查询运行版本
```bash
duckctl --name <robot-name> version
```
输出API版本、固件发行版本、构建所用git修订号。revision为`null`代表该版本是在开发者笔记本本地编译，不是CI流水线构建。

## 日志
```bash
duckctl --name <robot-name> logs robotd
```
查看本次开机后`robotd`最近40行系统日志。查看更多行，或上一次开机日志：
```bash
duckctl --name <robot-name> logs robotd -n 200
duckctl --name <robot-name> logs btd --boot -1
```
支持查看的单元：`updaterd`、`robotd`、`configd`、`btd`、`padd`、`mediad`、`tofd`，外加`bluetooth`、`NetworkManager`。`.service`后缀可省略；其它名称会直接拒绝并列出可用单元。

日志输出到stdout，其余诊断信息输出到stderr，支持管道过滤：
```bash
duckctl --name <robot-name> logs robotd -n 200 | grep -i panic
```
超长日志会被截断至无线链路可承载的大小，优先输出旧日志，附带截断提示。
日志跨进程重启时会标记分隔：
```
2026-09-09T12:27:20+00:00 systemd[1]: Starting robotd.service - Robot control daemon...
-- new robotd process, pid 3227 --
2026-09-09T12:27:21+00:00 robotd[3227]: control loop running joints=15 hz=50.0 driving=true
```
升级后这种分隔很重要，40行日志可能包含两个不同版本的输出。`-- … --`之间的内容由机器人主动输出，并非系统日志原生内容。

`logs`**不支持 `-f`、`--since`和内置搜索**，需要实时跟踪日志请SSH进板端：
```bash
ssh radxa@$(duckctl --name <robot-name> ip)
journalctl -u robotd -f
```

## 固件更新
命令语法和`robotctl update`完全一致，板端学会的命令可以直接复用。所有更新命令支持`--component <name>`，默认`daemon`，也是机器人当前唯一组件。

```bash
duckctl --name <robot-name> update check
duckctl --name <robot-name> update status
duckctl --name <robot-name> update versions
duckctl --name <robot-name> update log --limit 20
```
安装更新需要数分钟，实时打印进度：
```bash
duckctl --name <robot-name> update apply
· daemon: preflight
· daemon: downloading 12%
· daemon: downloading 47%
· daemon: verifying
· daemon: swapping
· daemon: health_gate
{
  "outcome": "applied",
  "from": "0.5.1",
  "to": "0.6.0"
}
```
> 注意：机器人会重启后台服务，`btd`会在返回后约5秒重启，因此连接会断开，**这是更新正常现象，不是报错**。重新连接，执行`duckctl update status`；`last_attempt`字段记录本次更新结果。

指定分支构建、精确版本、预发布候选版：
```bash
duckctl --name <robot-name> update apply --ref my-branch
duckctl --name <robot-name> update apply --version 0.5.1
duckctl --name <robot-name> update apply --staging
```
`--dry-run`：完整校验所有条件，在版本切换前停止。`--ref`与`--version`互斥，同时传入会被拒绝。

版本回滚（上一版本，或`update versions`列出的指定版本）：
```bash
duckctl --name <robot-name> update rollback
duckctl --name <robot-name> update select 0.5.1
```
回滚同样经过健康门控，新版本启动失败会自动复原，不会删除任何文件。

监控别人或机器人自身触发的更新进度：
```bash
duckctl --name <robot-name> update watch
```
持续打印正在执行的更新进度，不会自动退出，按`Ctrl-C`终止。

## Hugging Face账号登录
```bash
duckctl account login
```
输出验证码并打开 https://hf.co/oauth/device，你手动输入验证码。HF设备授权页面不支持URL携带验证码，打开页面仅省去跳转，仍需手动输入。机器人等待授权，工具打印验证码后就断开连接；在弹出浏览器（或其他设备）完成授权。
```bash
duckctl account status
duckctl account logout
```
**这是唯一可以在完全无网络机器人上执行的功能**：无WiFi就没有网页控制台与局域网，仅蓝牙可用。BLE登录流程和开机引导向导完全相同。

```bash
duckctl account login --no-open
```
只输出验证码与链接，不打开浏览器。脚本运行时会自动启用该模式。
机器人已登录、或等待授权未完成时，再次执行login会拒绝并提示当前账号；`--force`强制覆盖，旧未确认验证码失效。

## 策略与技能（Policy & Skills）
查看各策略槽位运行内容，以及机器人可用技能列表：
```bash
duckctl policy list
```
`skills`数组就是机器人能执行的动作集合。技能属于配置项，不同机器人不一样，不能写死预设列表；展示按钮前建议先读取该列表。

执行一个技能：
```bash
duckctl do roulade
```
机器人需要处于驱动就绪状态，先按下手柄Start键，否则会返回提示。**不需要持续按住手柄**：安全死区机制会自动清零运动指令，无人操控时机器人保持静止并执行动作。

动态更换行走策略模型：
```bash
duckctl policy load walk /opt/robot/policies/current/alpha_walking.onnx
```
恢复该槽位默认策略：
```bash
duckctl policy reset walk
```
一次仅操作一个槽位，接口限制如此；一次性重置全部7个槽位需要在板端使用`robotctl policy reset`。路径为**机器人板端绝对路径**。

通过`duckctl policy load`加载的策略**重启后保留**，行为和板端`robotctl policy load`一致：后台进程在切换策略前写入`robotd.toml`。`duckctl policy reset <slot>`用于撤销。

重新从配置文件加载全部槽位（配置被外部修改时使用）：
```bash
duckctl policy reload
```
机器人先回到带扭矩的初始姿态，加载策略后恢复运动，耗时数秒，命令内置超时等待。模型张量不符合`obs[1,61] -> actions[1,14]`会直接拒绝，加载失败会保留原有运行策略。

### Hub模型相关
查询Hub上为此机器人发布的策略，检查官方策略包更新：
```bash
duckctl policy search microduck
duckctl policy check
```
安装最新官方策略包；`--version v1`回退旧版本：
```bash
duckctl policy update
```
下载他人策略包（不执行）：
```bash
duckctl policy fetch RemiFabre/microduck-flamingo-cycle
```
返回结果给出文件保存路径。`load`接收本地路径，不再需要`组织/仓库名`；`fetch`和`load`是两条独立调用（`robotctl`可一条命令完成）。

### 自定义技能命名
`fetch`只下载模型文件；下面命令把模型注册为可被`robot do`调用的技能：
```bash
duckctl policy skill polite-bow --path /var/lib/robot/policies/fffiloni/microduck-polite-bow-b1d864/main/policy.onnx --duration 4
duckctl do polite-bow
```
单条命令完成：机器人写入配置并重载，**无需重启服务**。`--duration`首次注册必填，后续持久保存；修改参数只需要提交变更字段。
```bash
duckctl policy skill polite-bow --command 1,0,0
```
`--command`：策略运行时输入的扭转指令，默认0；flamingo模型格式为`[flag, side, 0]`。`--unwind`、`--unwind-s`用于终止持续保持姿态的策略。

查看机器人可执行技能及每个技能的时序参数：
```bash
duckctl policy skills
```
返回中的`built_in`包含`ground_pick`、`sit_toggle`，同样支持`robot do`调用，但属于机器人内置逻辑，不在技能配置表内。

删除自定义技能注册项：
```bash
duckctl policy unskill polite-bow
```
删除后，固件自带的同名内置技能会恢复生效；该操作仅移除覆盖配置，不会删除原始内置技能。

> ⚠️ 第三方发布的策略包没有官方验证。保障安全的是下载前清单校验、加载时张量形状校验、关节限位、跌倒保护，不是描述文字。首次运行务必把机器人放在支架上。

## 手柄按键绑定
```bash
duckctl pad bindings
duckctl pad bind x polite-bow
duckctl pad reset x
```
无需重启，`padd`会在1秒内重读配置。绑定前校验技能名称；拼写错误会返回提示可用技能，不会绑定一个无效果的按键。

列表会标记两类状态：
- `overridden`：覆盖默认配置，不查默认值就能看到自定义修改；
- `error`：按键绑定到一个机器人已不存在的技能；通常是技能被删除，而非手敲错名字。

赋值空字符串`""`用于关闭按键，和`pad reset`恢复出厂默认不是同一个操作。
可绑定按键共5个：`a`、`x`、`lb`、`rb`、`dpad_down`；`lb/rb`是肩键，模拟扳机保留为嘴和鸣笛功能。

> 手柄配对属于另一命名空间，由`configd`管理，用`call`调用`pad.pair` / `pad.forget`；按键绑定属于`robotd`，绑定前需要读取技能列表校验。

## 通用底层调用 call
```bash
duckctl --name <robot-name> call <method> '<json-params>'
```
参数默认`{}`。这些接口可通过蓝牙访问，没有封装成独立子命令：

| 调用 | 说明 |
| ---- | ---- |
| call system.services | 查看所有后台服务状态、各自运行版本 |
| call pad.status | 手柄是否已绑定、是否在线 |
| call pad.pair '{"timeout_seconds":30}' | 绑定处于配对模式的手柄 |
| call pad.forget '{"mac":"<address>"}' | 删除手柄绑定 |

`call` 等待60秒返回结果。上面的更新命令使用静默超时（3分钟无响应），因此**更新操作推荐用update子命令，而不是call调用update.apply**。

## 全局选项
`--name <robot-name>`：指定目标机器人。无该参数则读取`DUCK_ROBOT`；变量未设置则选用扫描到第一台机器人。**建议始终带上**，可以跳过Mac上缓慢的兜底扫描（会遍历所有已连接外设，包括耳机）。

`--pin <六位数字>`：配对PIN码，优先读取`DUCK_PIN`，默认`000000`。板端`robotctl system pin`查看真实PIN。

`--verbose`：打印全部收发报文，`scan`列出全部设备。程序卡住时优先添加该参数排查。

## 输出规则
返回结果以格式化JSON输出到stdout；进度、诊断、无线报文信息输出到stderr。
`logs`例外：直接输出文本行（JSON转义后的日志难以阅读），但日志报错仍然返回JSON。
```bash
duckctl ... info > reply.json
```
可以把JSON结果单独保存；机器人返回JSON-RPC错误时，退出码非0。
进度行以`·`开头，单行输出，因此：
```bash
duckctl ... update apply > outcome.json
```
进度信息留在屏幕，最终结果保存在文件。

**一条命令建立一次连接**：查找机器人、按需配对、校验PIN、执行请求、断开连接。

所有命令使用**静默超时**，不是固定总时长。长时间更新不会被中途切断；机器人无应答会在数秒上报错。链路断开会立刻上报；更新apply后断开是正常重启导致。
正在执行的更新不会因为连接断开而终止：由机器人后台拉取更新，无人监控也会继续执行，后续用`update status`查看结果。

## 蓝牙接口禁止调用的功能
遥操作（`robot.move`、`robot.head`、`robot.enable`、`robot.stop`、`robot.init`、`robot.relax`）、高频遥测（`robot.subscribe`）、高危更新指令（`update.pin`、`update.resetToGolden`）、配对PIN读写（`system.pairingPin`、`system.setPairingPin`），**由btd直接拦截，不会转发到后台服务**。

`robot.do`不在拦截列表，虽然会驱动机器人：遥操作是每秒50次高频小数据包，BLE通知通道带宽上限20字节无法承载；技能执行是单次请求。这类调用返回错误码14：**“蓝牙通道不可用”**。

这是安全边界，不是功能缺失。拒绝原因写在`btd/src/route.rs`；设计文档 `app-path-design.md §3.1`。这些功能需要在机器人板端使用`robotctl`。

## 找不到机器人时排查
```bash
duckctl --verbose scan
```
扫描结果为空（连耳机都没有）：问题在Mac端，蓝牙未开启，或者终端没有蓝牙权限。

扫描列表没有目标机器人：问题在机器人。机器人名称在扫描响应包广播，有可能丢失；扫描显示无名称无服务的设备，有可能就是目标机器人；`--name`仍然可以尝试连接。
macOS显示机器人已配对，但连接/首次读取卡住：配对状态不完整。
```bash
sudo pkill bluetoothd
```
macOS蓝牙设置里忽略该设备效果相同。
在机器人板端执行：`journalctl -u btd -b`，查看GATT服务是否成功注册。

---
术语注释：
- daemon：后台守护进程
- BLE：低功耗蓝牙
- policy：运动策略模型
- skill：机器人技能
- teleop：实时遥操作
- GATT：蓝牙通用属性配置文件
- deadman：安全死区保护
- WebRTC：网页实时音视频通信
