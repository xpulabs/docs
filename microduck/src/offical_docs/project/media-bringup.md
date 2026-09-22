# 硬件媒体调试（Media bring-up on hardware）
Radxa Zero 3W 的视频能力说明。下文所有结论均为板上实测，并非推测；如果内容仍属于假设，会专门注明。

## 已确认结论
mediad 必须使用硬件 H.264 编码：软件编码不只是速度慢，而是**根本不可行**。在这款 SoC 上，仅靠 jpegenc 无法在 640×480 分辨率下维持 30 帧（代码位置：microduck_runtime/src/camera.rs:500）。H.264 每帧开销高于 JPEG，而 4 核 Cortex‑A55 还要被 robotd 的 50Hz 控制循环占用。

VPU 负责 H.264 编码，输出码流合法；编码器通过瑞芯微 MPP 调用，而非 V4L2。需要从源码编译两个 GStreamer 插件才能使用该功能，不存在未知阻塞问题。

|项目|结果|
| ---- | ---- |
|VPU 720p H.264编码|是，通过mpi_enc_test测试：60帧，428KB|
|当前内核下码流有效性|是，avdec_h264可正常解码，High profile 4.0级别，4:2:0 8bit|
|调用入口|/dev/mpp_service（瑞芯微MPP），**不是V4L2 M2M**|
|GStreamer 1.x跨版本插件ABI|无风险，1.14版本编译的插件可在1.26.2正常注册|
|mpph264enc元素|必须源码编译（见「需要编译的组件」章节）|
|webrtcsink / webrtcsrc|需要单独编译|

## 开发板预装环境
刚完成初始化部署的开发板上没有预装任何媒体组件。`scripts/setup-gstreamer.sh` 脚本负责安装媒体组件并输出硬件能力；该脚本就是本文档的可执行版本，所有需要重复执行的命令都应当写进这个脚本。

GStreamer 直接使用 Debian trixie 官方源；`apt-cache policy` 显示源为 deb.debian.org、security.debian.org，没有 Armbian 多媒体叠加包，因此完全使用发行版自带版本：

|软件包|版本|
| ---- | ---- |
|gstreamer1.0-plugins-bad（包含webrtcbin）|1.26.2-3+deb13u3|
|libgstreamer-plugins-bad1.0-dev（包含gstreamer-webrtc-1.0.pc）|1.26.2-3+deb13u3|
|gstreamer1.0-nice|0.1.22-1|
|gstreamer1.0-plugins-rs|Debian所有版本均无此包|

内核版本：`6.1.115-vendor-rk35xx`。该内核至关重要，两点原因：相机 MIPI‑CSI ISP 采集驱动、VPU 设备节点仅存在于 Armbian 的厂商内核分支。`setup-board.sh` 已经安装该内核（最初是为音频编解码器 I²S 子系统，并非视频），所以在开发视频前依赖项已经就绪。**如果误执行 apt upgrade 升级内核并改写 /boot，相机和VPU节点都会丢失。**

### 相机需要设备树叠加层，并且要增加前缀镜像
CSI 相机插上后，如果没有启用设备树叠加层，不会生成 `/dev/video*`，dmesg 也无相关日志——现象和相机没插上完全一样。

启用叠加层这里有个坑：Armbian 提供的叠加层文件名为 `radxa-zero3-rpi-camera-v2.dtbo`，不带 `rk3568-` 前缀，但开发板配置 `overlay_prefix=rk3568`。于是 `overlays=` 配置项会去查找 `rk3568-radxa-zero3-rpi-camera-v2.dtbo`，加载器找不到文件，开发板正常启动，但相机完全不可用。这和 `configure_overlay` 为 uart2-m0 规避的静默失败属于同类问题。
解决办法：先把dtbo文件复制一份，加上前缀命名，再写入 overlays 配置。`microduck_runtime/install.sh` 已经处理了这个逻辑。

`setup-board.sh` 中的 `configure_camera` 会完成上述操作，文件放到厂商内核的叠加层目录。MIPI‑CSI 采集驱动只在该分支存在，这也是厂商内核不能替换的第二个理由。
`DUCK_CAMERA_OVERLAY` 用来选择传感器对应的叠加层；Armbian 一个传感器对应一个dtbo。本板支持：
- radxa-zero3-rpi-camera-v2：Pi Cam v2 / IMX219（本项目只用这一款）
- radxa-zero3-rpi-camera-v1.3：Pi Cam v1.3 / OV5647

### 编码器是MPP，不是V4L2
系统没有 `v4l2h264enc`，也不存在 `/dev/video*`，这**不是故障**：
在瑞芯微BSP厂商内核中，VPU暴露为 `/dev/mpp_service`，而不是V4L2 M2M编码器。`gstreamer1.0-plugins-good` 只有探测到V4L2编码器节点才会注册 `v4l2h264enc`，所以该元素缺失属于预期现象，不是缺少软件包。
完全没有 `/dev/video*` 也是相机未探测到传感器的正常表现；rkisp采集节点只有传感器被成功枚举后才会出现。

这点非常关键，是整个方案的分水岭：如果内核将VPU暴露为V4L2编码器，硬件H.264编码完全不需要内核外的额外组件。

### 权限陷阱
`/dev/mpp_service` 默认权限 `crw------- root root`，mode=0600。非root进程无法打开。用 `mpi_enc_test` 测试时，会生成空文件，退出码0。**没有报错、没有日志。退出码0不代表成功，文件大小才是判断依据。**

mediad 和其他守护进程一样，以独立用户运行（tofd 访问I2C、padd访问输入、btd访问蓝牙）。VPU也需要同样配置：通过udev规则给设备节点分配用户组，并且在systemd单元配置`SupplementaryGroups=`。
`scripts/setup-gstreamer.sh` 安装该规则（99-robot-mpp.rules，组video，权限0660），参考`setup-board.sh`里tof的i2c udev规则。

选用`video`组而不是`robot`组：robot组用于我们自定义的IPC套接字（app-path-design.md，套接字权限+用户组分层）。内核设备节点不能随意重定义，`video`是发行版对这类硬件设备的标准用户组，开发者用gst-launch调试时，权限逻辑和mediad保持一致。

## Radxa软件源提供的包
Debian官方源不包含瑞芯微MPP。Radxa通过GitHub Pages提供apt软件源；本项目**直接下载deb包**，不把源加入sources.list。`microduck_runtime/radxa_setup/setup_rkaiq.sh`已经在板子上用该方式安装rkaiq_3A_server。
基础地址：https://radxa-repo.github.io/bullseye/pool/main

|包名|版本|用途|
| ---- | ---- | ---- |
|m/mpp/librockchip-mpp1|1.5.0-1|MPP用户态库|
|m/mpp/librockchip-vpu0|1.5.0-1|rockchip-mpp-demos强依赖此版本|
|m/mpp/rockchip-mpp-demos|1.5.0-1|mpi_enc_test，无需GStreamer即可验证VPU|
|m/mpp/librockchip-mpp-dev|1.5.0-1|头文件，用于编译编码器插件|
|libr/librga/librga2|2.2.0-1|瑞芯微2D硬件加速，rockchip插件依赖|
|libr/librga/librga-dev|2.2.0-1|头文件，用于编译|
|g/gstreamer1.0-rockchip/gstreamer1.0-rockchip1|1.14-4|MPP的GStreamer插件，下文详述|

这些包是bullseye版本编译产物，但可以在trixie的glibc 2.41环境正常配置。

`dpkg -i`不会自动解决依赖，因为这些包不在apt源内。所有缺失依赖都需要手动补齐，不会自动修复，所以安装时必须一次性补齐全部依赖链，这个坑踩了三轮才摸清楚。

### Radxa预编译插件并非只有解码器（本文之前的描述有误）
`gstreamer1.0-rockchip1_1.14-4` 在GStreamer1.26.2中可以正常安装注册，只显示 `mppvideodec`、`mppjpegdec`，看起来只有解码器，本文之前错误地认为它不含编码器。
对so文件执行strings查看，里面包含`mpph264enc`、`mpph265enc`、`mppjpegenc`、`mppvp8enc`，编码器全部存在。

根源就是前面的**权限陷阱**，由此产生4个误导性现象：

|表面现象|真实原因|
| ---- | ---- |
|mpi_enc_test无输出，退出码0|设备节点无法打开；退出码0无参考意义|
|Radxa的deb包只有解码器|插件内置全部编码器，只是未注册|
|第三方1.14-8的deb同样看不到mpph264enc|同样是权限问题|
|CI构建产物只列出两个解码器|容器环境不存在/dev/mpp_service，属于预期现象，不是编译失败|

MPP插件会无条件注册解码器，注册编码器前会探测MPP设备。当 `/dev/mpp_service` 权限0600，属主root:root时，探测静默失败，插件内的编码器虽然存在，但不会对外注册。

> 结论：插件只展示解码器，说明设备节点权限异常，不是插件本身缺少编码器。在udev规则生效前，`gst-inspect-1.0 mpph264enc` 的结果没有参考价值。

本次安装验证了一点：基于GStreamer1.14编译的插件，在1.26.2中可正常注册。之前担心插件ABI不兼容而不敢源码编译，该风险实际不存在。

## 需要编译的组件
一共两个插件，原因相互独立，二者不能互相替代。

|插件|源码来源|提供元素|无法直接安装的原因|
| ---- | ---- | ---- | ---- |
|gstreamer-rockchip|JeffyCN/mirrors分支 gstreamer-rockchip，meson构建|mpph264enc硬件编码器|Debian官方没有瑞芯微编码器插件。Radxa预编译包虽然带编码器，但我们自行编译可以锁定版本、移除libx11-6依赖，并且和下面插件一起打包|
|gst-plugin-webrtc|gst-plugins-rs 0.15.3版本，cargo-c构建|webrtcsink, webrtcsrc|Debian所有发行版都没有打包gst-plugins-rs|

选用0.15.3而不是reachy_mini SDK文档写的0.14.5：0.14.5是最低底线，低于该版本，`webrtcsink` 在远端SDP和ICE处理存在死锁bug，现象是客户端一直卡在「connecting」。0.15.3只是更新版本。两个版本最低要求GStreamer v1.22，机器人运行1.26.2，升级无成本。

系统已通过`gstreamer1.0-plugins-bad`安装`webrtcbin`。**不编译第二个插件也可以跑WebRTC会话，但需要自己实现信令协议。** 优先选用`webrtcsink`，因为它自带的信令协议可以由中继代理转发，实现信令服务器复用。

### 为什么不直接使用预编译包
硬件、内核驱动、MPP用户态库无需编译就能工作：mpi_enc_test来自deb包，第一次运行就能完成720p H.264编码。缺失的只是GStreamer绑定层：插件把librockchip-mpp封装成流水线可用的GStreamer元素。mpi_enc_test是独立程序，GStreamer不知道它存在。类比ONNX Runtime：libonnxruntime.so从tar包解压即用，ort绑定层才让程序可以调用。

预编译绑定包汇总：
|来源|包含内容|
| ---- | ---- |
|Radxa bullseye软件池|gstreamer1.0-rockchip1_1.14-4，安装后仅能看到mppvideodec + mppjpegdec|
|Radxa rk3588s2-bookworm软件池|同样1.14-4，二进制完全一致|
|numbqq/gstreamer-rockchip-debs|1.14-8，包含全部编码器|

第三方numbqq的deb包值得在源码编译前先测试。它bookworm/arm64/<board>目录是软链接指向jammy/arm64，实际是Ubuntu22.04编译，上游来自rockchip-linux/gstreamer-rockchip（现已404），维护者Jeffy Chen，和Radxa用的是同一个上游源码，该版本开启了编码器。so内包含mpph264enc、mpph265enc、mppjpegenc、mppvp8enc。

它的DT_NEEDED依赖项，板子安装上述deb包后全部满足：librockchip_mpp.so.1, librga.so.2, libgstreamer-1.0.so.0, libgstvideo, libgstallocators, libgstpbutils, libdrm2, libglib2.0-0, libx11-6，libc6 >=2.33，适配glibc2.41。
插件本身不绑定RK3588，SoC差异由MPP库内部处理，插件只要求GStreamer >=1.14。

我们自己的插件放在独立仓库`microduck-gst-plugins`，刻意这样设计：
1. **不在开发板上编译**：RK3566编译Rust代码速度极慢，无法等待。
2. **也不使用交叉编译**：守护进程使用cargo-zigbuild交叉编译；`scripts/ci-cross-deps.sh`提到，仅有的C依赖是这个特例，新增C依赖需要慎重。GStreamer会是第二个巨大的依赖；x86多架构、带meson交叉文件的sysroot，链接的库都是目标平台近似版本，不是真实环境。
3. **原生编译**：arm64 CI runner，debian:trixie容器，和机器人用户态完全一致，无近似模拟。公共仓库arm64 runner免费。
4. **公开构建产物**：部署阶段、更新器预安装钩子会下载产物，执行环境干净，无访问令牌。和守护进程获取ONNX Runtime机制一致。

构建脚本一次性编译两个插件，在`pins.env`锁定上游commit/tag；禁用`rkximage`和`kmssrc`（X11、KMS输出sink，无头机器人不需要，也是Radxa预编译包依赖libx11-6的原因）。发布tar包、sha256校验文件，附带MANIFEST清单记录每个插件对应的上游版本，这是第三方deb包无法提供的。

该方案规避两个隐患（阅读源码发现，不是跑崩后才发现）：
1. `gst/rockchipmpp/meson.build`逻辑：如果找不到mpp依赖，直接`subdir_done()`跳过插件，meson返回编译成功，不会报错。缺少librockchip-mpp-dev会静默跳过插件。
2. 直接下载deb包时dpkg不会自动处理依赖，所以Radxa相关依赖包需要一次性批量安装。

`mediad.service`必须配置`GST_PLUGIN_PATH`。插件安装到`/usr/local/lib/gstreamer-1.0`，GStreamer默认不会扫描该目录；默认搜索路径是发行版的`/usr/lib/aarch64-linux-gnu/gstreamer-1.0`。刻意避开该目录，防止apt操作覆盖/删除插件。
systemd单元需要增加两行：
```ini
Environment=GST_PLUGIN_PATH=/usr/local/lib/gstreamer-1.0
SupplementaryGroups=video
```
两行都极易遗忘，并且故障现象完全一致：编码器消失，无任何报错提示。

`scripts/setup-gstreamer.sh`使用锁定版本，永远不用latest。相隔一天两次部署得到不同插件版本，没有版本记录，会产生难以复现的媒体bug。版本锁定写在Cargo.toml的`[workspace.metadata.gst-plugins]`；脚本直接硬编码版本号（curl独立拉取），xtask单元测试校验版本一致性，和ONNX_VERSION的设计思路相同。

测试第三方deb包不等于依赖它。这是个人维护的分发包，来源不可控，仓库删除就会失效。它的价值是低成本验证核心问题：插件能否兼容我们的MPP与GStreamer版本。验证通过后，自行基于同源码编译，降低风险，最终方案仍然是我们自己锁定版本的构建产物。

**备选方案**：完全不编译插件，mediad通过Rust FFI直接调用MPP C API（mpi_enc_test证明可行）。代价是手写、手动维护厂商库绑定代码，取舍上不如GStreamer插件。但如果插件和GStreamer1.26冲突，该方案是可行退路，不是死路。

### 上游源码说明
`rockchip-linux/gstreamer-rockchip`仓库已失效（404）。`JeffyCN/mirrors@gstreamer-rockchip`是可用镜像，最后提交2026-05-21；`gst/rockchipmpp`目录包含`gstmpph264enc.c`、`gstmpph265enc.c`、`gstmppjpegenc.c`、`gstmppvp8enc.c`。存在大量fork分支；无论选用哪个fork和tag，都必须锁定并记录版本，理由和gst-plugin-webrtc最低版本锁定（≥0.14.5）一致。

### gst-plugin-webrtc版本锁定
**0.14.5及以上，不要用0.14.4**。更早版本的`webrtcsink`存在远端SDP和ICE处理死锁bug，现象是客户端无限卡在「connecting」。reachy_mini SDK安装文档记录了该问题；reachy-mini-desktop-app内置0.14.4，因此存在该缺陷。

Pollen项目已经为x86_64构建该插件：cargo cinstall原生编译、strip精简、按架构提交；CI锁定commit+sha256使用。在同一仓库新增aarch64版本，工作量可能小于新建一套流水线。

### 编译好的插件放在哪里
放到守护进程发布包内，`GST_PLUGIN_PATH`指向当前版本目录。**不要放入apt包，也不要放到每台机器的/opt**。

插件版本和mediad代码强耦合：上面0.14.5的例子说明，插件版本直接决定守护进程是否需要打补丁。版本不一致属于mediad的bug，需要跟随mediad生命周期：原子替换、回滚、健康检测。
`librockchip-mpp`则相反：属于和内核配对的系统库，所有访问VPU的程序都依赖，应当交给包管理器管理。

## 实测项 & 未实测项
板上实测内容：
GStreamer1.26.2及其来源；webrtcbin存在；webrtcsink/webrtcsrc缺失；v4l2h264enc缺失，无/dev/video*；`/dev/mpp_service`权限0600 root:root；非root执行mpi_enc_test无输出，root执行生成428KB码流；码流可以正常High 4.0解码；Radxa deb包依赖链；rockchip插件加载成功，仅加载两个解码器元素。

编码链路硬件端到端调通，验证步骤：
1. 从公开发布包下载v1版本，sha256校验，安装到`/usr/local/lib/gstreamer-1.0`
2. `gst-inspect-1.0 mpph264enc`显示来源：`/usr/local/lib/gstreamer-1.0/libgstrockchipmpp.so`（我们编译的版本。提前删除第三方deb包，保证结果归属正确）
3. 编码测试：`videotestsrc ! mpph264enc profile=baseline header-mode=each-idr bps=2000000 ! h264parse ! filesink`。720p 60帧耗时0.44s（包含视频源生成、流水线初始化），输出476KB，性能远超实时。输出码流avdec_h264可正常解码。
4. 非root可用：udev规则设置`/dev/mpp_service`权限660 root:video，用户加入video组后，普通用户可执行gst-inspect。mediad就是以该用户运行，此前所有测试都用sudo。

完整媒体链路硬件调通：从传感器到WebRTC协商码流

|步骤|证据|
| ---- | ---- |
|叠加层加载|csi2-dphy0探测成功，rkisp启动，生成10个/dev/videoN设备|
|传感器识别|imx219 2-0010：Model ID 0x0219，Lot ID 0x5a8e73，Chip ID 0x0773|
|采集节点|/dev/video0，card名称rkisp_mainpath，支持最高3280×2464|
|帧数据|720p NV12，--stream-count=10帧总字节13,824,000，数值精确|
|硬件编码|v4l2-ctl … --stream-to=-输出原始帧送入 fdsrc ! rawvideoparse ! mpph264enc|
|码流|正常解码；h264parse识别为1280×720 constrained-baseline|

设备节点编号每次开机不固定，因此采集节点通过匹配`/sys/class/video4linux/*/name`下的rkisp_mainpath卡名查找，camera.rs:219就是该逻辑。

### 三个设备节点都需要video用户组，不止一个
前后三轮调试，每轮报错现象都指向不同问题：

|设备节点|仅root访问时的现象|
| ---- | ---- |
|/dev/mpp_service|mpi_enc_test无输出，退出码0；mpph264enc完全不注册|
|/dev/rga|元素存在，流水线启动，之后报错`Try to use uninit rgaCtx=(nil)`，大量rga blit调用失败|
|/dev/video0|默认已经root:video，不会踩坑|

`setup-gstreamer.sh`安装一条udev规则覆盖前两个节点。mediad.service配置`SupplementaryGroups=video`，配合`Environment=GST_PLUGIN_PATH`。就这两行配置，决定流水线能否正常工作，故障现象有4种不同迷惑性报错。

## 旋转操作导致帧率损失22fps
相机安装旋转90度。直观方案：tee之前加videoflip，让所有接收端直接拿到正向画面。在机器人上实测，该方案是错误选择：

|RGA故障数|v4l2src丢帧|帧率|SoC温度|
| ---- | ---- | ---- | ---- |
|不加翻转|0|0|~30|正常|
|加videoflip翻转|单次会话5522次|1565|7–8|97℃，CPU锁408MHz|

mpph264enc会把UYVY→NV12转换交给芯片2D硬件引擎，无CPU开销。而videoflip输出的buffer，RGA硬件不支持：报错`10000 unsupport format`、`RGA_BLIT fail: Bad address`。MPP只能切为软件逐帧转换，CPU满载，芯片触发热限频，降到408MHz，相机丢帧。**旋转本身开销只是次要问题，软件转换才是性能杀手。**

因此流水线内**不做图像旋转**。上报相机安装姿态（media.video，每个控制通道上报一次），由显示端做旋转：控制台用CSS transform（零开销），感知算法在重采样阶段完成旋转。`--flip-in-pipeline`参数可以恢复旧行为，留给有能力承受性能损失、无法自行旋转画面的消费端。

如果后续确实需要流水线输出正向画面，正确方案：在插件中增加RGA元素，由2D硬件引擎完成旋转，编码器可以零成本使用。

## 3A引擎必须在码流启动前就绪
`rkaiq_3A_server`挂载到ISP，等待流启动事件；如果流已经启动，会错过事件。mediad正在推流时重启rkaiq，进程会一直卡在：
`DBG: /dev/media0: wait stream start event...`
不再运行统计循环，自动曝光、白平衡失效，画面发绿。重启能“修复”只是巧合：重启刚好让两个服务启动顺序正确。

这会造成无明显诱因的回归bug：robotctl更新应用时，会在推流运行中重启3A引擎。预安装钩子执行setup-rkaiq.sh，脚本重启rkaiq_3A，脚本提示“重启相机流才能生效”，但没有强制机制，没人手动执行。

现在脚本安装的systemd配置增加约束：
```ini
ExecStartPost=-/bin/systemctl --no-block try-restart mediad.service
```
每次3A引擎启动，都会重启mediad推流，让3A等待的流事件重新产生。`try-restart`保证mediad未运行时不会启动；`--no-block`防止systemd单元互相等待造成死锁。

手动恢复板子的操作顺序至关重要：
```bash
sudo systemctl stop mediad && sudo systemctl restart rkaiq_3A && sleep 2 && sudo systemctl start mediad
```

### rkaiq自动曝光仅在捕获流启动时触发一次
`scripts/setup-rkaiq.sh`最初默认开启rkaiq的AE：原型机关闭AE，是为了防止3A引擎和自研曝光控制冲突；mediad没有接管曝光，所以交给3A引擎。引擎**可以写入传感器参数，但不会持续跟踪调整**。

机器人开机顺序正确的实测记录（rkaiq_3A 17:24:01启动，mediad 17:24:11，17:24:17成功捕获流启动事件）：

|项目|数值|
| ---- | ---- |
|mediad在17:24:17写入|exposure=600 analogue_gain=1024|
|数分钟后读取/dev/v4l-subdev3|exposure:1589 analogue_gain:1536|
|手动写入exposure=300 analogue_gain=256，观察25秒|300 / 256，保持不变|

引擎只在流启动收敛一次曝光值，之后不再响应画面变化：画面变暗4倍，曝光完全不调整。仅启动时一次收敛，**不是真正自动曝光**；机器人从窗边走到走廊，曝光仍然保留窗边参数。

如果开机3A错过流启动事件，连这一次收敛都不会执行。最早的测试误判现象：传感器参数固定600/1024，手动修改参数也保持不变，以为AE完全失效；实际是3A从未收到流事件。只读取传感器参数，无法区分这两种状态，所以两个修复必须配套：调整服务启动顺序，才能观察到差异。

`mediad::exposure`闭环控制逻辑，移植自原型ae_loop：每秒两次从tee原始分支读取平均亮度，目标亮度90；阻尼乘法调节，按噪声优先级依次控制：快门到600行（≈11ms，足够防止行走机器人运动模糊）→模拟增益最高11倍→快门到1200行→ISP数字增益。
快门存在硬上限：驱动不会截断长曝光，而是直接拉长帧时长；3500行会静默降到15fps。

相比原型，两点改进：
1. 亮度采样复用已经分流给目标检测的帧，不需要JPEG解码，也不会二次打开相机。原型最初版本并行v4l2-ctl采样ISP通路，驱动层和采集抢占资源，流水线偶发崩溃。
2. 写入参数后回读校验：避免各种失败场景（节点无该控制项、权限拒绝、缺少v4l2-ctl）导致相机卡死在固定曝光，和要修复的bug现象一模一样。

`setup-rkaiq.sh`现在强制设置`CommCtrl.Enable = 0`。不是因为3A引擎AE完全无效，而是它仅在流启动时刻生效，刚好和mediad曝光环路初始收敛撞在一起，**两个写者争抢同一个控制参数**。

v4l2-ctl的坑：只要一个控制名称未知，整条`--set-ctrl`/`--get-ctrl`直接失败。`--get-ctrl=exposure,analogue_gain,digital_gain`会提示`unknown control 'digital_gain'`，并且不返回曝光值，让人误以为节点没有曝光控制。mediad分开两次调用，分别写入传感器曝光增益和ISP数字增益。

## 两项尚未完成的工作
码率实测值约为目标的1/50。3.3秒采集，bps=2000000配置下，总字节15553，码率约37kbps。两种可能性：
1. 画面静止，CBR码率自动压缩（可能性较高；ISP初始默认参数，在运行setup-rkaiq.sh前图像偏绿噪声大）
2. 采集帧率远低于30fps，尚未统计帧数。如果是该原因，怀疑传感器模式：IMX219上电默认3280×2464，原型机每次采集前用media-ctl锁定分辨率（camera.rs:277）。

`rawvideoparse blocksize=1382400`只是调试临时方案，不是正式设计。它依赖v4l2-ctl输出紧密打包NV12，尺寸是人工计算。一旦切换分辨率出现行填充stride padding，该参数就会静默出错；camera.rs中已经标注该风险。mediad自行实现V4L2 mmap循环送入appsrc，直接从驱动读取真实行宽，不再硬编码假设。

## 流水线需要确定的两个方案
采集**不能使用v4l2src**。rkisp驱动给v4l2src分配双buffer池，buffer重入队列太慢，每3帧丢1帧；30fps传感器只能跑出~20fps，日志提示lost frames detected。`v4l2-ctl --stream-mmap`可以维持满帧率。microduck_runtime使用该方案，原始帧通过管道送入fdsrc流水线（camera.rs:487）。mediad二选一：沿用子进程调用v4l2-ctl，或者自己实现V4L2 mmap循环喂给appsrc。

mpph264enc四个属性需要流水线主动配置，不能直接继承默认值：

|属性|默认值|mediad应设置值|说明|
| ---- | ---- | ---- | ---- |
|profile|high|baseline|WebRTC最低兼容等级是Constrained Baseline（profile-level-id 42e01f）。现代浏览器支持High，老客户端不支持。设为baseline后，h264parse识别为constrained-baseline，实测验证。枚举项仅写baseline，但实际满足约束基线要求|
|header-mode|first-frame|each-idr|仅首帧带SPS/PPS：晚加入的客户端或者丢包后无法解码。Reachy mini Pi流水线在v4l2h264enc使用repeat_sequence_header=1实现同样需求，参数名不同|
|rotation|0|alpha阶段设180|IMX219倒装。microduck_runtime用videoflip rotate-180，CPU逐帧处理，占用robotd共享SoC资源。编码器硬件旋转零开销|
|bps|0自动|显式目标码率|rc-mode默认CBR，适合有损链路；码率不能交给自动计算|

无需决策的两点：
1. 没有B帧开关，天然满足§5.5「无B帧」要求，无需配置。
2. sink pad接受NV12，正好是rkisp采集输出格式，采集到编码之间不需要videoconvert，也不需要RGA色彩转换。

关键帧策略：使用`min-force-key-unit-interval`，而不是固定GOP周期。WebRTC由对端PLI请求触发关键帧；GOP默认每秒生成IDR，不管接收端是否需要。

### 约束标识值得仔细阅读，pad模板问题造成一次排坑
本文之前计划需要验证：profile枚举是baseline(66)，WebRTC协商Constrained Baseline；Baseline流只要不使用FMO、ASO、冗余切片，就符合Constrained Baseline解码器预期。

板上实测命令：
```bash
gst-launch-1.0 -v videotestsrc num-buffers=60 ! video/x-raw,format=NV12,width=1280,height=720,framerate=30/1 ! mpph264enc profile=baseline ! h264parse ! fakesink
```
h264parse在src pad协商得到`profile=(string)constrained-baseline`。所以码流正确：profile=baseline关闭CABAC和8x8变换，MPP不输出FMO/ASO/冗余切片，SPS的profile_idc=66并且constraint_set1_flag置位。

问题根源是pad模板，花费一天排查。mpph264enc的src模板只列出`profile = { baseline, main, high }`，缺少`constrained-baseline`，而WebRTC恰恰需要这个profile。
只有编码器放在webrtcsink内部时该问题才暴露，之前单独测试编码器没有触发：
1. webrtcsink的codec探测构建编码链，不带输出caps，force_profile=true，插入capsfilter强制要求profile=constrained-baseline。
2. h264parse在caps查询时，剥离alignment、stream-format、parsed，但保留profile；约束传递到编码器src pad。
3. 模板无交集，GstVideoEncoder sink getcaps返回空，报错向上传递四层，videorate提示`could not transform NV12 … in anything we support`。
4. 探测放弃H.264，协商VP8，会话在rtpvp8pay阶段中断。**所有日志都不提示profile不匹配。**

两条经验：插件仓库打了一行补丁扩充模板，发布v3版本；mediad必须把GStreamer日志、流水线总线事件接入系统journal，否则媒体故障全部静默，包括协商中途断开。

## 不再采用预编码方案
本文旧版本说明：webrtcsink sink pad支持预编码H.264，`appsrc ! mpph264enc ! h264parse ! webrtcsink`可以让编码器脱离WebRTC协商。该方案确实能跑，但有两个难以补救的缺陷：
webrtcsink无法管理不属于自己的编码器，拥塞控制不能根据链路动态调整码率；对端PLI请求无法生成关键帧，丢帧后画面卡死，只能等到下一个周期性GOP。

因此mediad送入原始NV12，交给webrtcsink内部构建编码链路，通过`encoder-setup`信号配置编码器参数，使用上表参数。代价是编码器参与编解码协商，也正是这个机制，发现了上面pad模板缺陷。

