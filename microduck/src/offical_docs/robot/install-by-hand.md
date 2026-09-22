# 手动分步安装

把 `scripts/provision-board.sh` 脚本所做的操作拆成独立命令。适合需要单独调试某一步的场景；如果你只想直接得到一块可用开发板，请直接使用 `provision-board.sh`。

## 上传文件

在本地仓库克隆目录操作。文件上传到用户家目录 `~`，**不要放到 /tmp**：流程中间会重启设备，`/tmp` 目录重启后内容会丢失。

```bash
scp scripts/setup-board.sh scripts/migrate-network.sh pierre@192.168.1.42:~/
scp scripts/install.sh deploy/dev-key/team.dev.pub pierre@192.168.1.42:~/
```

## 重启前操作

先创建 robot 用户组，这样用户组权限在重启后直接生效，无需再次重启：

```bash
sudo groupadd --system robot
sudo usermod -aG robot "$USER"
```

开发板初始化：加载设备树覆盖层、关闭电机串口的内核控制台、配置getty屏蔽、开启 `Privacy = device`、安装onnxruntime：

```bash
sudo sh ~/setup-board.sh
```

网络配置：将 netplan 迁移至 NetworkManager

```bash
sudo sh ~/migrate-network.sh
sudo reboot
```

**重启不可省略**：正在运行的内核下，无法切换设备树覆盖层与网络协议栈。

## 重启之后

再次执行上面两条脚本。脚本具备幂等性；第二次执行 `migrate-network.sh` 会移除WiFi回退机制，否则WiFi启动缓慢时，板子会在开机时回退到 netplan。

```bash
sudo sh ~/setup-board.sh
sudo sh ~/migrate-network.sh
```

接下来安装守护进程。`install.sh` 从环境变量读取配置，`sudo -E` 用于保留环境变量：

```bash
export DUCK_TOKEN=github_pat_replace_with_your_token
export DUCK_REF=main
export DUCK_DEV_KEY=$HOME/team.dev.pub
sudo -E sh ~/install.sh
```

如果板子只允许安装正式发布包，删掉 `DUCK_DEV_KEY` 环境变量。把 `DUCK_REF` 设置为分支名，即可安装该分支最新构建产物。

> 在上面执行 `setup-board.sh` 时添加 `DUCK_WEIRD_BLE=1` 等价于参数 `--weird-ble`：适用于蓝牙完全无法和游戏手柄建立配对的开发板。详情参见 `pair-a-gamepad.md`。
> `DUCK_NO_START=1`：安装发布包、systemd单元、用户与用户组，但**不会启用任何服务**，下次开机也不会自动启动。同时会停止并禁用之前安装残留的所有守护进程。无论SD卡是全新还是已经配置过，执行后状态一致。
> 用途：区分板子硬件故障和守护进程故障；重启后所有机器人相关服务都不运行，完成测试后再逐个启动服务。

```bash
sudo -E DUCK_NO_START=1 sh ~/install.sh
sudo reboot
```

重启是必要步骤，不是可选清理操作。发布包自带的安装钩子`hooks/postinstall`会在`install.sh`执行停止操作**之前**启用并启动所有守护进程。因此本次开机内服务依然会运行；并且守护进程退出时不会撤销它对系统子模块的改动。例如btd会保留“可配对”状态、蓝牙广播实例，以及默认配对代理给适配器设置的IO能力。
恢复机器人正常运行：

```bash
sudo systemctl enable --now updaterd robotd configd btd padd
```

如果你需要自定义机器人名称：

```bash
robotctl system set-name duck-01
```

## GStreamer（用于视频推流的开发板）

自动化配置脚本默认会安装GStreamer；在`provision-board.sh`添加`--no-gstreamer`（对应这里`DUCK_GSTREAMER=0`）可跳过安装。无论是否安装，都不需要重启，跳过安装的板子可以随时手动执行。

```bash
scp scripts/setup-gstreamer.sh pierre@192.168.1.42:~/
sudo sh ~/setup-gstreamer.sh
```

脚本会打印板子的编码能力：已注册的webrtc系列插件、可用H.264编码器、当前内核是否暴露VPU硬件。
在 Zero 3W 上，输出会显示 `/dev/mpp_service`，没有`v4l2h264enc`，这是Rockchip BSP内核的预期行为：VPU通过MPP调用，而不是V4L2。输出信息会列出两个Radxa软件包，用来验证编码能力。
**内核变更后需要重新运行**，内核改动会改变硬件上报信息：

```bash
sudo /usr/local/sbin/robot-setup-gstreamer
```

加上 `--dev` 参数会额外安装头文件，用于在板上编译 `gst-plugin-webrtc`，或者在aarch64 sysroot中交叉编译。

## 校验

```bash
robotctl health
robotctl version
```

测试台的板子舵机未上电时，`robotd`上报不健康属于正常现象，**不代表安装失败**。
然后配置游戏手柄，参考 `pair-a-gamepad.md`：

```bash
sudo robotctl pad pair
```

如果你需要，我可以把这段手动步骤提取成**纯命令清单**（删除所有说明文字，只保留代码块），方便直接复制执行。


