# 在开发板上安装

从零配置一块开发板，直到你可以向这个机器人推送代码分支。
开发板信任团队开发密钥，因此它会安装团队任意成员编译出的程序。客户机器人的配置完全不同，会主动拒绝这类开发构建产物——本文所有操作均针对**开发板**，**绝对不能用于客户机器人**。
开发构建并不会放宽安全校验：签名与哈希校验、健康检查门限、自动回滚机制全部保留。唯一区别是用于签名的密钥，这也是客户机器人会拒绝开发构建的原因：客户机器人双重拦截开发密钥。配置项 `allow_dev_keys = false`；并且只有文件名以 `.dev.pub` 结尾的可信密钥，才会被识别为开发密钥。下文整套配置的目的，就是修改这两项规则。

## 烧录开发板镜像

使用 Armbian 镜像烧录工具。选择 Radxa Zero 3，镜像版本选择 Armbian 26.2.1 Minimal。
写入镜像前，在烧录工具的配置文件中填写：WiFi 名称与密码，以及你想要使用的用户名和密码。提前在这里配置，后续就不用串口控制台：开发板首次启动后会自动接入网络，可以直接通过 SSH 访问。
然后添加你的 SSH 密钥，这样配置脚本在重启开发板后可以自动重连：

```bash
ssh-copy-id radxa@192.168.1.42
```

## 所需准备

1. 开发板IP地址。该镜像上的 mDNS 不稳定，`.local` 域名解析时好时坏。`duckctl ip` 通过蓝牙向机器人查询IP，不需要你本地网络，也不需要DHCP租约；如果开发板还未广播自身信息，可以查看路由器的DHCP租约表作为备选方案。
2. SSH密钥登录权限，即上一步配置。配置流程会重启开发板并自动重连，密码登录无法满足该场景。
3. GitHub令牌：当前仓库为私有仓库，没有令牌无法获取发布资产。仓库公开后令牌变为可选，仅用于提升API访问速率限制（文档 docs/design/updater-design.md 6.1节）。
4. 克隆一份本仓库。所需开发密钥已提交在 `deploy/dev-key/team.dev.pub`，无需向他人索要。
   
   ## 安装
   
   在你本地电脑的仓库克隆目录中，执行两条命令：
   
   ```bash
   export DUCK_TOKEN=github_pat_replace_with_your_token
   ./scripts/provision-board.sh --pause-btd-on-pair --name <MY_COOL_ROBOT_NAME> radxa@192.168.1.42
   ```
   
   该命令会上传开发密钥、启动配置流程、等待设备重启、实时输出日志，最终执行 `robotctl health` 检查。
   
   ### 命令中 `--pause-btd-on-pair` 参数的作用
   
   在 aic8800 蓝牙芯片上，当 btd（蓝牙守护进程）处于广播状态时，手柄无法建立新配对。该参数会写入标记，`robotctl pad pair` 会暂停btd、重启适配器，留出配对窗口期，之后重新启动蓝牙服务。
   已建立的配对连接不受影响：已配对的手柄可以正常连接、驱动，完整协议栈正常运行；代价仅为配对期间该守护进程短暂停止。
   这里默认带上该参数，是因为：如果开发板需要该参数但配置时未添加，现象就是手柄无法配对；而你排查时最先想到的各类原因都不是真正根源。
   
   ## 三种配置模式，以及判断当前属于哪一种
   
   存在两类独立问题，因此对应两个参数。配对手柄，观察报错现象，选择对应配置：
   
   | 现象                                                                                                                                                                 | 开发板所需配置                                        |
   | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
   | 手柄成功配对并正常工作                                                                                                                                                        | 无需参数，直接执行配置                                    |
   | 手柄无法配对，SMP最后步骤一直无法完成                                                                                                                                               | `--pause-btd-on-pair`                          |
   | 即使暂停btd，手柄依旧无法配对                                                                                                                                                   | `--weird-ble`（自动包含暂停逻辑，并开启 `Privacy = device`） |
   | 手柄配对成功后频繁断连：提示PIN或密钥缺失(0x06)，无输入设备                                                                                                                                 | **该板不要使用 `--weird-ble`**，移除该参数，保留暂停参数          |
   | 需要重点留意最后一行。仅需要暂停蓝牙的开发板，如果开启 `Privacy = device`，配对会立刻失效，比直接无法配对更难定位。实测MAC地址`50:37:CD:16:1D:90`设备：关闭隐私+暂停蓝牙可以稳定保持配对；开启device隐私模式45秒内断连46次。因此 `--weird-ble` 不再作为默认参数。 |                                                |
   | 将开发板从 `--weird-ble` 切换为仅暂停蓝牙（保留标记）：                                                                                                                                |                                                |
   
   ```bash
   sudo sed -i 's/^Privacy = device/Privacy = off/' /etc/bluetooth/main.conf && sudo reboot
   ```
   
   反向切换（使用配置脚本在板上留下的副本）：
   
   ```bash
   sudo DUCK_WEIRD_BLE=1 /usr/local/sbin/robot-setup-board && sudo reboot
   ```
   
   检查开发板两个参数都不需要，清空配置并配对手柄：
   
   ```bash
   sudo rm /var/lib/robot/weird-ble
   sudo sed -i '/^Privacy = /d' /etc/bluetooth/main.conf && sudo reboot
   ```
   
   **修改Privacy配置后必须重新配对**：该设置会改变密钥派生对应的蓝牙地址，旧配对信息不再匹配，会持续报PIN/密钥缺失，需要重建配对。
   以上全部是 aic8800 蓝牙芯片的临时兼容方案，并非系统原生设计；更换芯片后该方案即可移除。详细信息见 `pair-a-gamepad.md`。
   你可以随时退出日志查看：配置流程会安装 systemd 服务单元，开机自动继续执行，无论你是否保持终端连接。按 `Ctrl-C` 不会中断板上任务，后续可以重新查看日志：
   
   ```bash
   ssh -t radxa@192.168.1.42 'sudo tail -f /var/lib/robot/provision.log'
   ```
   
   `--ref BRANCH` 从指定分支进行配置：脚本执行系统初始化，并在之上安装该分支版本的守护程序。
   `golden` 保持为稳定发布版本，作为启动恢复网络的兜底版本；如果把分支构建设为golden，分支一旦损坏，兜底恢复也会失效；`current` 指向当前分支。
   如果构建包无法安装，或者安装后被健康检查回滚，则配置失败。**最难以排查的故障**：你指定分支，但开发板悄悄继续运行稳定版。看起来一切安装正常，但被测代码根本没有运行。配置前等待CI执行1~2分钟；如果卡住，可以用 `gh run list --branch BRANCH` 查看CI状态。
   其他实用参数：
- `--name Ducky`：给机器人命名，而不是使用基于序列号自动生成的 `duck-7f3a`（后续 `robotctl system set-name` 也可以改名，该参数仅省一条命令）
- `--local`：使用本地仓库内的 `provision.sh`，而不是远程拉取，适合在合并代码前测试配置脚本改动
- `--no-dev-key`：配置后的开发板仅能安装正式发布包，不接受开发构建
  
  ## 验证是否配置成功
  
  ```bash
  robotctl health
  ```
  
  只有密钥成功安装，这块板子才会被识别为开发板，可以通过命令校验，而不是靠记忆：
  
  ```bash
  grep -c 'DEV BOARD' /var/lib/robot/provision.log
  ```
  
  返回`1`代表成功；返回`0`代表密钥未写入。后续使用`--ref`会报错，报错信息类似发布包损坏。这个检查就是为了提前捕获该故障。
  然后做真实测试，部署分支版本：
  
  ```bash
  sudo robotctl update apply --ref main daemon
  ```
  
  ## 重烧镜像后SSH无法连接
  
  重烧镜像会重新生成开发板主机密钥，你上次使用的IP现在对应新密钥。`StrictHostKeyChecking=accept-new` 无法处理这种场景：主机IP没变，但密钥更新。SSH原始报错会输出一大段文字，提示可能存在中间人攻击。
  使用脚本自动清除旧主机密钥：
  
  ```bash
  ./scripts/provision-board.sh radxa@192.168.1.42 --forget-host-key
  ```
  
  这点很重要，因为DHCP租约会复用：上周分配给A开发板的IP，本周可能分配给另一块新板子，密钥完全不同。
  
  ## 开发板重启后IP发生变化
  
  配置流程中途WiFi切换，开发板可能获取到和你指定地址不同的DHCP租约。`provision-board.sh`会自动查找：等待SSH连接的同时，通过蓝牙查询机器人当前IP，并自动切换目标地址。
  
  ```
  bluetooth: the robot reports 192.168.1.57, and 192.168.1.42 was its old lease.
  ```
  
  无需手动操作，后续流程自动使用新IP。
  有三种情况会导致蓝牙查询IP失效，脚本会给出提示：
1. 需要cargo和本地仓库，`duckctl`是示例程序，不是预装二进制。
2. 必须等btd蓝牙服务启动后才能查询；首次配置的开发板，要等到第二阶段运行几分钟后。
3. 查询返回的是WiFi地址，通过网线连接的开发板不支持该查询。
   `--no-ble` 关闭蓝牙查询功能。如果机器人设置了配对PIN，需要在环境变量`DUCK_PIN`中填入。
   
   ## 将已有开发板改为支持开发构建
   
   适用于其他方式初始化的板子，或是在获取开发密钥前已经配置好的板子。**两项配置缺一不可**，只改其中一项，板子依旧拒绝分支构建。
   简便方式：重新运行安装脚本并带上密钥，一次性完成密钥校验与配置开关：
   
   ```bash
   sudo DUCK_TOKEN="$DUCK_TOKEN" DUCK_DEV_KEY=/tmp/team.dev.pub sh /tmp/install.sh
   ```
   
   无论源文件叫什么，脚本都会将密钥安装为 `team.dev.pub`。文件名至关重要：`.dev.` 标识这是开发密钥；其他名称的密钥会被当作正式发布密钥信任。
   如果你希望手动分步执行：
   
   ```bash
   sudo cp team.dev.pub /etc/robot/trusted_keys/team.dev.pub
   sudo sed -i 's/^allow_dev_keys.*/allow_dev_keys = true/' /etc/robot/updater.toml
   sudo systemctl restart updaterd
   ```
   
   ### 手动配置GitHub令牌
   
   传入`DUCK_TOKEN`时，`scripts/install.sh`会自动完成这部分配置。手动配置场景：板子是其他方式初始化；仅在仓库私有，或者板子频繁拉取更新、需要更高API速率限制时才需要。
   `updaterd`从自身环境读取`GITHUB_TOKEN`，你在shell里export的环境变量无法传递给守护进程，需要systemd覆盖配置文件：
   
   ```bash
   sudo mkdir -p /etc/systemd/system/updaterd.service.d
   ```
   
   将下面代码块内的令牌替换为你自己的（唯一占位符）：
   
   ```bash
   sudo tee /etc/systemd/system/updaterd.service.d/token.conf > /dev/null <<'EOF'
   [Service]
   Environment=GITHUB_TOKEN=ghp_replace_with_your_token
   EOF
   ```
   
   覆盖配置文件默认全局可读，该文件存放凭证，需要修改权限：
   
   ```bash
   sudo chmod 600 /etc/systemd/system/updaterd.service.d/token.conf
   sudo systemctl daemon-reload
   sudo systemctl restart updaterd
   ```
   
   开发板存放令牌没问题，但客户机器人不能存放。镜像内全集群凭证一旦写入，不重烧镜像就无法轮换，因此方案是使用公开仓库，而不是预装令牌（docs/design/updater-design.md §6.1）。没有令牌的板子依旧可以从本地目录或者开发推送安装程序。
   
   ## 无网络环境安装
   
   已经装有正式版本的板子，可以常规方式从本地目录安装：通过守护进程，保留健康检查门限与自动回滚：
   
   ```bash
   sudo robotctl update apply daemon --from /media/usb/release
   ```
   
   `scripts/dev-push.sh`脚本最终执行的就是这条命令；`dev-push.md`描述从笔记本推送至板子的流程。
   本节余下内容适用于裸板场景：工厂或离线安装，此时守护进程还未部署。因此使用`updaterd`而非`robotctl`，并且`updaterd`默认不在系统PATH路径中：
   
   ```bash
   sudo /opt/robot/daemon/current/bin/updaterd install --from /media/usb/release
   ```
   
   目录内包含完整发布包：`<version>.manifest.json`、对应的`.minisig`签名文件、程序制品以及制品的`.minisig`。签名、哈希、兼容性校验逻辑和在线下载完全一致；`--from`仅修改文件来源，不改变信任校验规则。
   该命令**不允许在系统已有可用版本时直接运行**，因为它强制开启`on_apply`并关闭健康检查；对正常运行的机器人执行会静默关闭自动回滚。只有一种场景需要，且`robotctl update apply`无法解决：板子内置的`updaterd`版本太旧，无法安装修复该旧版本问题的新版本。每次安装新版本都会被回滚，而负责校验的程序本身就是待替换对象。需要停止机器人服务并强制安装：
   
   ```bash
   sudo systemctl stop robotd
   sudo /opt/robot/daemon/current/bin/updaterd install --from /media/usb/release --force
   ```
   
   只要`robotd`还在运行，`--force`参数会被拒绝，因为正常运行的机器人不能失去安全兜底机制。
   `--force`仅在本次安装关闭自动回滚；签名、哈希、兼容性校验依旧保留。如果新版本运行异常，可执行 `sudo robotctl update rollback daemon` 回滚恢复。
   
   ## 深入了解
   
   `deploy/README.md`是完整参考文档，描述整套机制：信任链、文件部署位置、其他部署方式（不带仓库克隆，在板上手动一步步操作）、日志存放位置、重启后哪些配置会保留。
