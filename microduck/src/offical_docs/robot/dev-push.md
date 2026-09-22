# 本地编译，板端安装
修改一行代码，就能看到机器人运行修改后的代码，**无需代码推送、无需CI流水线、无需打标签**。克隆本仓库后，一条命令即可完成：为开发板编译、对产物签名，并通过SSH安装到板端。增量编译大约只需1分钟；如果走代码推送+CI流水线，则要耗时数分钟。

`scripts/dev-push.sh` 就是这条命令。下面所有参数都是传给该脚本的选项。

## 首次推送前（仅需执行一次，之后不再需要）
需要完成三项前置准备，一次性配置好即可。

1. 开发板必须是**开发版样机**。编译产物使用团队开发密钥签名，客户版机器人会拒绝该签名包，和拒绝`--ref`版本包的机制一致。`install-dev.md`文档介绍如何将普通板子配置为开发板。
2. 开发签名密钥存放路径：`~/.duck-keys/team.dev.key`。这是CI用于分支构建签名的密钥私钥，由团队成员保管。如果密钥放在其他位置，设置环境变量`DUCK_DEV_SECRET_KEY`指向它。
3. 准备适配开发板的编译工具链。二选一：
    - 方案A：安装交叉编译器
    ```bash
    cargo install cargo-zigbuild --locked
    brew install zig
    ```
    - 方案B：不安装任何工具，每次执行`dev-push.sh`时附加`--docker`参数。仅要求本地Docker守护进程正常运行。该方式启动速度较慢，适合**手边暂时没有开发板**的场景，详见容器内编译章节。

## 开发迭代流程
指定机器人名称，脚本自动查找设备：
```bash
scripts/dev-push.sh --name duck-c51b
```
或者在当前shell会话一次性设置环境变量：
```bash
export DUCK_ROBOT=duck-c51b
scripts/dev-push.sh
```
这个名称就是`duckctl scan`列出、`robotctl system set-name`设置的名称，工具读取的`DUCK_ROBOT`变量与之相同（参考`duckctl.md`）。
脚本通过蓝牙查询机器人网络地址（由机器人自身`net.status`返回）并缓存。只有缓存地址无法连通时，才会重新走蓝牙查询。因此DHCP续租、重新烧录固件、更换网络环境，都无需额外操作即可自动适配。

SSH登录用户名默认为`radxa`。如果你的板子用户名不同：
```bash
export DUCK_BOARD_USER=pierre
```
也可以直接写IP地址，完全跳过蓝牙查询：
```bash
scripts/dev-push.sh radxa@192.168.1.42
export DUCK_BOARD=radxa@192.168.1.42
```

脚本执行流程：对工作区交叉编译 → 打包成和正式发布包完全相同的产物 → 使用开发密钥签名 → 将包传到板端`~/duck-sideload`目录 → 调用`robotctl update apply --from`在板端安装。之后等待各个后台服务上报新版本状态：
```
==> building 0.5.1-dev.local.1763400000.g7fc1444 for the board (zigbuild)
==> packaging
==> signing with /Users/you/.duck-keys/team.dev.key
==> copying to radxa@192.168.1.42:/home/radxa/duck-sideload
==> applying on radxa@192.168.1.42
==> 0.5.1-dev.local.1763400000.g7fc1444 is live on radxa@192.168.1.42
==> checking every daemon is running it
    current -> 0.5.1-dev.local.1763400000.g7fc1444
    [ok] robotd
    [ok] configd
    [ok] padd
    [ok] updaterd
    [ok] btd
    [ok] mediad
    [ok] tofd
==> every daemon on radxa@192.168.1.42 is running 0.5.1-dev.local.1763400000.g7fc1444
```

`updaterd`和`btd`会在安装指令返回5秒后重启，所以这两项状态上报会稍慢。
`[--] padd published nothing`**不是报错**：停止/手动禁用的后台服务、无摄像头板子上的`mediad`都会显示该状态。

`[--] tofd published nothing`代表当前版本较旧，`tofd`服务尚未上报身份标识，**不是传感器缺失**，再执行一次推送即可修复；无论是否接入传感器，`tofd`都会正常运行。

在板端可通过下面命令查看当前版本号：
```bash
robotctl version
```
同一未提交修改的代码目录多次推送不会版本冲突：版本号携带推送时间戳，而不只是commit哈希。本场景允许代码目录存在未提交改动。

这是一套完整的更新流程：签名校验、产物哈希、兼容性检测、健康检查、自动回滚全部生效。如果新版本启动失败，会自动回滚，板子恢复到上一可用版本。手动回滚命令：
```bash
sudo robotctl update rollback daemon
```

## 查看刚推送版本的日志
新开终端，在推送前执行，这样重启日志会被捕获：
```bash
ssh radxa@192.168.1.42 'journalctl -f -u robotd -u configd -u btd -u padd'
```
单独查看`updaterd`，可以看到更新全流程、健康检查、定时重启事件：
```bash
ssh radxa@192.168.1.42 'journalctl -f -u updaterd'
```
后台服务发生panic崩溃时，会输出完整调用栈；二进制文件没有去除调试符号，栈帧带有函数名。

查看后台服务健康状态：
```bash
ssh radxa@192.168.1.42 robotctl health
```
可以查看控制环路是否正常，以及每个后台服务正在运行的版本。`cheatsheet.md`包含更多机器人调试命令。

## 日志级别：从info改为debug
所有systemd单元默认日志级别`RUST_LOG=info`。想要查看`debug!`调试日志，可以添加systemd覆盖配置，以`robotd`为例（在板端执行）：
```bash
sudo mkdir -p /etc/systemd/system/robotd.service.d
sudo tee /etc/systemd/system/robotd.service.d/log.conf > /dev/null <<'EOF'
[Service]
Environment=RUST_LOG=debug
EOF
sudo systemctl daemon-reload && sudo systemctl restart robotd
```
该配置文件存放在`/etc`目录，不受后续dev推送覆盖。调试完成后删除配置：
```bash
sudo rm /etc/systemd/system/robotd.service.d/log.conf
sudo systemctl daemon-reload && sudo systemctl restart robotd
```

## 仅校验，不实际安装
```bash
scripts/dev-push.sh --dry-run radxa@192.168.1.42
```
执行编译、签名、传输，并执行完整校验流程（签名、哈希、兼容性、解压、检查所有服务不引用不存在的二进制），**但不会切换运行版本**。板子保持原有程序，不会重启后台服务。

## 使用容器编译
```bash
scripts/dev-push.sh --docker radxa@192.168.1.42
```
无需安装zig、cargo-zigbuild，也不需要从开发板拷贝`libudev`库。
Apple Silicon Mac上容器目标架构与宿主机一致，不做交叉编译；x86笔记本上会启用模拟器运行，脚本会给出提示。生成产物和普通编译完全一致，`--dry-run`、`--bootstrap`参数同样可用。

两种编译模式使用独立的`target/`目录，来回切换会触发完整重编译。默认本地编译日常速度更快，也是CI流水线使用的方式。

## 重新安装板端已有的安装包
dev推送会将产物保留在板端`~/duck-sideload`目录，无需重新编译即可再次安装：
```bash
sudo robotctl update apply daemon --from ~/duck-sideload
```
该命令可读取任意存放发布包的目录，例如U盘。每次推送会覆盖该目录，不会追加文件。

## 无开发板，仅做板端目标编译
在手边没有开发板时，验证代码改动能否编译（含C绑定crate、Linux专属逻辑）：
```bash
cargo board --bins
```
`cargo board`本质是配置好目标架构与glibc最低版本的`cargo zigbuild`，配置定义在`.cargo/config.toml`。需要和默认推送相同的zig工具链；`padd`依赖首次推送从板子拷贝的`libudev`库。使用`--docker`则不需要该库。

## 向0.5.0旧版本板子做首次推送
`apply --from`需要API版本7，该版本从0.5.0开始引入。低于0.5.0的板子，`updaterd`不支持该接口，调用会直接拒绝，不会静默从原有源安装。一次性使用无健康门控方式部署：
```bash
scripts/dev-push.sh --bootstrap radxa@192.168.1.42
```
该操作会停止`robotd`，**本次安装跳过健康检查**。后续所有推送都可以使用常规命令。

## 常见故障排查
1. **no dev signing key at ...**
板子校验安装包和正式包规则一致，必须签名。向团队成员获取`team.dev.key`，或设置`DUCK_DEV_SECRET_KEY`指向密钥。
2. **cargo-zigbuild is not installed**
安装cargo-zigbuild与zig，或者使用`--docker`。
3. **no libudev.so.1 on <board>**
首次推送会从板子拷贝该库用于链接`padd`。板子未开机则无法提供库文件；`--docker`模式不需要。
4. **重烧录板子后，报libudev链接错误**
库文件存在本地缓存。删除缓存，下次推送会重新拉取：
```bash
rm -rf ~/.cache/duck-cross/aarch64
```
5. **apply failed (exit 2)，robotctl/updaterd提示API不匹配**
板子旧版本不支持`apply --from`，执行一次`--bootstrap`即可。
6. **preflight check failed: SideloadDir: ... is not there for updaterd**
安装包放在`/tmp`或`/var/tmp`。`updaterd.service`开启`PrivateTmp=yes`，后台服务拥有独立的tmp目录，和shell不是同一个。使用其他路径，默认`~/duck-sideload`是推荐选项。旧版本固件会报另一个错误：`no manifest for version <version> in <dir>`，即使目录里能看到清单文件。
7. **verification failed: signature did not verify against any of N usable trusted key(s)**
看起来像包损坏，大多是板子不是开发板：开发密钥未写入，或者`allow_dev_keys`关闭，导致密钥不在可信列表。在板端执行：
```bash
grep -c 'DEV BOARD' /var/lib/robot/provision.log
```
返回0代表缺失开发板密钥，`install-dev.md`文档有完整修复方案。
8. **could not reach <name> over Bluetooth**
机器人需要开启广播且在蓝牙范围内，才能通过名称解析地址。
```bash
duckctl scan
```
扫描无结果：机器人关机、超出距离，或已连接手机。直接填写IP地址，绕过蓝牙：
```bash
scripts/dev-push.sh radxa@192.168.1.42
```
9. **蓝牙能搜到机器人名称，但无WiFi地址**
机器人已上电，但未接入网络，无法SSH连接。通过蓝牙配置WiFi：
```bash
duckctl --name duck-c51b wifi connect <ssid> --psk <passphrase>
```
10. **IP地址不变，但SSH无法连接**
地址本身没问题，一般是板子重烧录导致主机密钥变更，执行：
```bash
./scripts/provision-board.sh radxa@192.168.1.42 --forget-host-key
```
11. **版本已切换成功，但部分服务没有跑新版本**
版本替换与健康检查通过，但个别后台进程仍运行旧二进制。脚本会列出异常服务。板端查看：
```bash
robotctl health
```
服务列表会显示每个daemon运行版本。查看updaterd日志：
```bash
journalctl -u updaterd -b | tail
```
查找定时重启记录或者失败原因。手动重启updaterd：
```bash
sudo systemctl restart updaterd
```
正常流程不需要手动重启，建议查看日志定位根因。`cheatsheet-dev.md`详细记录重启相关坑点，`../design/restart-order.md`是完整重启顺序文档。

## 环境变量配置
| 变量 | 说明 |
| ---- | ---- |
| DUCK_ROBOT | 机器人名称，脚本通过蓝牙查询并缓存网络地址 |
| DUCK_BOARD_USER | 蓝牙查询模式下，SSH登录板端用户名，默认radxa，duckctl ssh/scp同样读取 |
| DUCK_PIN | 机器人配对PIN码，非出厂默认000000时配置，duckctl读取 |
| DUCK_BOARD_CACHE | 网络地址缓存目录，默认`~/.cache/duck/boards` |
| DUCK_BOARD | 直接指定板端地址，替代命令行参数，示例`radxa@192.168.1.42` |
| DUCK_DEV_SECRET_KEY | 开发签名私钥路径，默认`~/.duck-keys/team.dev.key` |
| DUCK_SIDELOAD_DIR | 安装包在板端存放目录，默认`~/duck-sideload`。**禁止放在/tmp、/var/tmp**，updaterd使用独立私有临时目录 |
| DUCK_CROSS_SYSROOT | libudev库缓存目录，默认`~/.cache/duck-cross/aarch64` |

## 本工具明确不具备的能力
**不提供正式版本发布所需的溯源能力**。版本号使用时间戳而非git标签；产物使用客户机器人不认可的开发密钥签名；不会上传发布包。其他人无法安装你本地推送的版本。正式版本发布依旧需要打标签，通过`release.yml`流水线构建（参考`../../README.md`）。
