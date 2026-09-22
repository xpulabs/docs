# 速查手册 — 开发板

本页命令仅适用于按照 `install-dev.md` 配置完成的开发板。机器人日常运维相关命令见 `cheatsheet.md`。

## 开发更新通道

安装CI上对应分支最近一次编译产物：

```bash
sudo robotctl update apply --ref <branch> daemon
sudo robotctl update apply --ref main daemon
```

`--version` 用于锁定指定版本。除非你确实要切到稳定版，否则请带上上述其中一个参数。

不带 `--ref` 执行 `apply daemon` 会安装最新稳定版，**在开发板上通常是版本降级**。它不是“安装最新版本”，而是“安装稳定通道提供的版本”。
分支代码合并之后，稳定版依然会比你正在测试的版本旧。如果稳定版内的守护进程对应的systemd单元文件已经在板上存在，但旧版本程序包不含该二进制文件，则`ExecStart`指向的程序不存在，重启失败，更新会自动回滚。这正是健康校验门限在生效，但触发该问题的命令看起来却很像正常命令。

标签 `daemon-dev-<branch>` 会跟随分支动态更新，因此没有固定版本号可供复制。内部版本号每次构建唯一，例如 `0.1.0-dev.42.c719ec8`，同一分支的两次构建不会混淆。
`--ref main` 可以让开发板切回主分支，同时保留在开发通道；直接执行不带参数的 `apply daemon` 会退出开发通道。原因是预发布版本在版本排序上低于正式发布版，且没有单独的退出开关。

代码合并不会立刻发布：CI需要先完成main分支编译，`--ref main` 才能获取到新版本。

```bash
gh run list --branch main
```

## 发布候选版本

由 `release.yml` 发布到staging预发布环境、尚未正式推广的版本。金丝雀测试机器人在版本正式上线前运行该版本：

```bash
sudo robotctl update apply --staging daemon
sudo robotctl update apply --staging --version 0.3.0 daemon
```

候选版本和正式版本一样使用发布密钥签名，并且携带未来正式发布时使用的版本号。
不加`--staging`无法访问它，因为候选版本标记为预发布；普通`apply`命令会跳过预发布包，避免机器人意外升级到未验证构建。
`--staging`仅对当前这一条命令生效，执行完毕不会保留任何开关状态。

## 更新后 — 容易踩坑的部分

`robotd`、`configd`、`padd` 在更新过程中重启。
`updaterd` 和 `btd` 在更新应答完成5秒后重启：前者无法在更新过程中自重启，后者可能正在处理应答报文。
所以btd相关修复会在几秒后自动生效，无需手动操作，重连即可使用。

如果这两个服务的自动重启没有触发，下一次`updaterd`启动时会自动修复。唯独`updaterd`自身不会自动重启，只会上报版本不一致。
此时再次执行`apply`：命令返回`already_current`，列出未匹配的守护进程，并调度重启。手动执行`sudo systemctl restart updaterd`效果相同。

如果开发板上`updaterd`版本低于0.4.0，则没有这套自动逻辑，两个服务会一直运行旧二进制，需要手动重启。执行一次更新即可修复，之后的更新才会具备该能力。

当你指定的版本和板上现有版本一致时，`robotctl update apply` 会返回`already_current`，不安装任何文件，但命令并非无动作。它会检查各守护进程实际运行版本，重启版本不匹配的进程，并在`stale`字段列出。
**当你确认修复代码已经打包，但功能不生效时，就用这条命令**：要么自动修复，要么`stale`为空，说明该版本根本没有包含这个修复。

典型现象：修复代码已经安装，但功能无效。查看每个守护进程正在运行的版本：

```bash
robotctl health
```

units模块下每行输出一个守护进程，显示进程启动时对应的版本；如果运行版本和安装版本不一致，会输出警告并提示需要重启。
`build unknown`：守护进程正在运行，但没有上报版本标识，大概率是旧构建；重启后即可正常上报。
`restarting`：进程退出，systemd正在尝试拉起。更新后几秒内属于正常现象；长时间停留在该状态代表服务启动失败。

如果某个守护进程确实版本陈旧，手动重启（正常情况本不需要手动操作，建议查看系统日志定位根因）：

```bash
sudo systemctl restart configd
```

`updaterd`不会自行修复，需要手动重启：

```bash
sudo systemctl restart updaterd
```

无需手动修改板上`updater.toml`，重启列表由发布包自带的systemd单元定义。完整重启顺序见 `../design/restart-order.md`。

## 在笔记本操作：本地编译，远程安装到开发板

完全跳过CI流程：本机编译，通过SSH安装到开发板，耗时约一分钟。

```bash
scripts/dev-push.sh radxa@<board>
```

该方式同样会触发健康校验更新，前面提到的服务重启机制依然生效。
`dev-push.md`文档包含环境准备、容器编译、`--dry-run`预演、向低于0.5.0版本的板子首次推送，以及失败排查方案。

## 在笔记本操作：手柄遥控机器人

手柄在电脑端，机器人放置在测试台，两边都不用安装padd服务：`padd`只是普通客户端，可以在本地仓库中运行，通过套接字转发控制机器人。

**先停止机器人板上的padd，否则两个进程争夺摇杆**：

```bash
sudo systemctl stop padd
```

转发套接字并保持连接：

```bash
ssh -L /tmp/robotd.sock:/run/robotd.sock radxa@192.168.1.42
```

新开终端，在本地仓库执行：

```bash
cargo run -p padd -- --socket /tmp/robotd.sock
```

执行下面命令恢复机器人板上自带的padd服务：

```bash
systemctl start padd
```

padd的常用参数：`--max-linear`（m/s 最大线速度）、`--max-angular`（rad/s 最大角速度）、`--max-head`（rad 头部最大转角）以及`--deadzone`死区。模拟摇杆很难完全归零，不设置死区机器人会自行缓慢漂移。
systemd单元默认使用内置参数；想要修改参数，需要手动运行二进制（本地或板上都可以）：

```bash
sudo -u padd /opt/robot/daemon/current/bin/padd --max-linear 0.25
```

## 在笔记本操作：duckctl

通过低功耗蓝牙BLE访问机器人，无需网络、无需SSH。全部命令参考`duckctl.md`。
