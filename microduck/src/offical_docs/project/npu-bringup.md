# NPU与搭载其上的小鸭检测器
RK3566内置一枚小型INT8 NPU：算力0.8 TOPS，单核。本文记录如何将训练好的小鸭检测器部署到该NPU上：可运行的内容、预期效果，以及在机器人行为模块能够调用该检测器之前，尚缺失的功能。

该模型在`duck_detector`项目中完成训练，导出为量化后的`.rknn`文件。参考首版模型：YOLO11n，输入分辨率320×320，单类别；使用3组采集会话共150帧图像，在预留测试集上mAP50为0.976。经过INT8量化后模型大小3.9MB；在桌面测试中，该量化模型与浮点模型相比，2个目标检测框的交并比仍可维持95%。

## 模型来源
模型托管在Hub平台，和策略模型的分发方式一致。`duck_detector`会将每一轮训练结果发布至`pollen-robotics/microduck-duck-detector`仓库：NPU使用`duck_detect.rknn`，CPU降级备用版本为`duck_detect.onnx`，文件固定放在仓库根目录，每一轮训练对应一个版本标签。
本仓库**不存储模型权重**：`mediad`服务从`/opt/robot/detector/current`读取权重，填充该目录的工具如下：
- `scripts/seed-detector.sh`：由版本安装后的后置钩子执行；在空白设备上写入`[workspace.metadata.detector]`锁定版本，不会修改非本脚本安装的配置
- `robotctl duck-detector check`：对比本地已安装版本与仓库可用版本
- `sudo robotctl duck-detector update [--version <tag>]`：安装指定版本，重启mediad加载新模型

其逻辑和`seed-policies.sh`、`robotctl policy check/update`完全一致，只是根目录与固定文件列表不同，底层复用`updaterd`接口（`detector.check`、`detector.install`）。文档`docs/design/policy-channel-design.md`第9节说明了这套设计思路：锁定版本作为最低基线，不部署半成品；重新训练模型只新增版本标签，无需发布守护进程新版本。

两点重要说明：
模型仓库与数据集仓库同名；机器人仅访问模型资源（`…/resolve/<rev>/…`、`api/models/…`），数据集存放于`datasets/`目录，因此机器人侧不会意外加载数据集图像。
更新逻辑里的“最新版本”依靠版本标签判定（v2优先级高于v1；`experimental`这类名称不计入版本排序）。面向机器人部署的版本需要使用`vN`格式标签。首轮训练标记为`duck-v1`，可通过名称直接安装，但该标签无法用于版本优先级排序。

## 代码内容
- `duck-detect`：图像等比例填充预处理（letterbox）、运行时绑定、解码逻辑，附带`duck-bench`基准测试工具
- `scripts/setup-npu.sh`：启用NPU设备节点、安装`librknnrt.so`库，并输出驱动状态

阅读前需要了解两项关键设计决策：
1. **采用dlopen动态加载，而非编译链接**。`librknnrt.so`是厂商闭源二进制库，Debian官方软件源不包含该库。如果Rust crate直接链接该库，CI流水线将无法完成交叉编译。`robotd`调用ONNX Runtime也使用同样方式。代价是需要维护`duck-detect/src/rknn.rs`；好处是在笔记本电脑上仍然可以执行`cargo board --bins`编译。
2. **运行时做反量化**。量化模型输出张量为int8类型，附带缩放系数与零点。`rknn_outputs_get`可按需转换为浮点数，代码里启用了该转换；另一种方案是把缩放系数传入解码器，但容易静默出错。

## 运行基准测试
驱动是前置条件：它属于厂商内核补丁，主线Linux内核没有该驱动，用户空间程序无法绕过驱动缺失问题。

常规`robotctl update`更新流程会自动处理。安装前置钩子会执行版本自带脚本，和`setup-gstreamer.sh`、`setup-rkaiq.sh`一同运行，不会造成致命故障，执行日志写入更新记录。因此在NPU功能出现前就出厂的设备，只需一次更新即可修复，无需人工手动执行命令。手动执行仅用于重试：
```bash
sudo sh /opt/robot/daemon/current/scripts/setup-npu.sh
```
首次包含该脚本的更新会要求重启。Armbian系统在所有Radxa Zero 3开发板上默认将`npu@fde40000`状态设为`disabled`。原厂硬件、内核、驱动全部存在，但NPU并未启用。脚本写入设备树覆盖层完成配置并打印提示；重启后设备节点绑定生效。
`--no-enable-node`参数仅安装运行库，不启用节点；配置完成后用`dmesg | grep rknpu`验证。

**务必使用版本包内自带脚本，不要调用`/usr/local/sbin/robot-setup-npu`**：设备树覆盖源文件和脚本放在同一目录，首次运行时`/usr/local/sbin`下的副本没有配套文件。

然后在本地克隆的代码仓库执行：
```bash
cargo board --bins -p duck-detect
scp target/aarch64-unknown-linux-gnu/release/duck-bench microduck@<robot>:/var/tmp/
scp <模型文件>.rknn microduck@<robot>:/var/tmp/duck.rknn
scp -r datasets/raw/<采集会话文件夹> microduck@<robot>:/var/tmp/frames
```
`duck-bench`不会打包进正式发布包：它只是性能测量工具，打包会让所有机器人都附带这个仅少数开发者使用的程序。在行为模块接入检测器之前，只能通过scp上传；正式部署时，检测器会集成在`mediad`内部，不再使用该工具。

```bash
/var/tmp/duck-bench --model /var/tmp/duck.rknn --frames /var/tmp/frames
```
工具按优先级依次验证三件事：
1. **能否正常运行？** 如果运行库加载失败、模型平台不匹配、驱动版本低于运行库，会在此处直接报错，而不是在守护进程内部崩溃。
2. **能否识别小鸭？** 输出每一帧检测结果。模型成功跑通但无任何检测框，从现象上看和正常模型完全一样，需要验证。
3. **资源开销多少？** 输出延迟分位数与进程CPU占用。使用NPU的目的是不干扰`robotd`50Hz主循环，这一点需要实测验证。

`--threshold`是优先调整的参数。量化模型置信度使用独立刻度：浮点模型的0.5阈值并不适用于量化模型。运行无检测结果时，大概率是阈值设置问题，而非模型转换出错。先尝试设为0.2再排查其他问题。

## 测试数据
Radxa Zero 3开发板，`duck-bench`限速2Hz，3轮测试共30帧图像：

| 测量项 | 数值 | 备注 |
| ---- | ---- | ---- |
| 驱动 / 运行库 | 0.9.8 / 2.3.2 | setup-npu.sh会打印这两项 |
| 延迟 P50 / P95 | 25.7 ms / 58.4 ms | 推理+解码耗时，不含JPEG解码 |
| 单帧CPU耗时 | 20.7 ms | 见下文，并非全部推理开销 |
| 检测结果 | — | 对照人工标注帧验证 |
| SoC温度 | 63 °C | 限速测试结束时 |

> CPU耗时不等于NPU开销，该指标容易被误读。延迟列统计的是推理+解码；CPU耗时是整个循环的进程总CPU除以帧数，其中包含`letterbox_rgb`：1280×720缩放至320×320，该缩放在CPU上执行，不计入上面的推理延迟。剩余CPU开销是否来自`rknn_run`忙等待（把NPU等待时间计入CPU负载）目前尚不明确。2Hz工况下占用约单核4%。在引用该数值作为感知模块开销前，需要将两者分开测量。

## 待实现功能
`mediad`已有一路原始图像分流分支，专门用于该功能，见`architecture.md`第5.3节。两条路线可并行开发，互不排斥：

1. **media.frame（已完成）**：调用接口返回单帧图像，通过`mediad`的Unix套接字`/run/mediad/media.sock`提供，和其他观测套接字一样支持组读权限。用途远超感知任务（控制台快照、bug报告截图）；采集数据集时不再需要停止mediad来获取相机画面。
接口先返回JSON-RPC头部，声明二进制字节长度，随后传输原始图像数据：单帧原始图像约1.8MiB，不适合放在base64编码的控制应答内。接口从图像分流通道获取下一帧，不使用缓存帧，不会返回相机停止时定格的旧画面。

2. **mediad内置检测器**：订阅原始图像分流通道，以数赫兹频率运行模型，在状态流上发布检测结果。这是最终形态：感知计算靠近传感器，提取特征而不是传输原始像素，供机器人行为模块使用。

一旦检测结果作为状态数据可用，`docs/ideas/autonomous_behavior.md`里现有的依赖蓝牙的行为逻辑（“附近有小鸭”）就可以改成视觉触发（“小鸭在那里”）：靠近、跟随、面向目标，以及多只小鸭对视鸣叫的合唱交互。

## 获取图像快照
机器人端执行：
```bash
robotctl frame --output frame.uyvy
```
保存一帧新鲜UYVY打包图像，JSON元数据输出到标准错误输出：宽度、高度、字节数、采集时间戳、`rotate`旋转参数——相机相对竖直安装的顺时针旋转角度，和`media.video`传给WebRTC对等端的参数一致。
转换图像时要使用该分辨率并应用旋转。示例：90°安装、1280×720采集：
```bash
ffmpeg -f rawvideo -pixel_format uyvy422 -video_size 1280x720 -i frame.uyvy -frames:v 1 -vf transpose=1 frame.png
```
修改相机模式或安装角度后，不能假定分辨率和旋转参数不变。文件只有完整接收数据后才会写入磁盘。

像素为传感器原始输出；`rotate`只做上报，不自动旋转图像。图像流水线不再做画面翻转，因为`videoflip`会破坏编码器零拷贝路径，导致板端帧率下降22fps，因此由每个消费端自行处理旋转。如果去掉`-vf`，图片会侧置，且没有任何信息说明旋转原因，`rotate`参数正是用来解决这个问题。若使用`--flip-in-pipeline`在流水线内完成旋转，则`rotate`值为0。

在机器人局域网内浏览器打开：`http://<robot>:8080/frame`，或curl保存：
```bash
curl --fail http://<robot>:8080/frame -o frame.png
```
返回自动摆正的PNG图片，响应头`Cache-Control: no-store`。该接口是上面规则的特例：PNG格式无法携带角度信息。90度安装会交换宽高，旋转开销发生在每次请求，而非每一帧。相机停止或不可用时返回HTTP 503，永远不返回上一张缓存图片。PNG保留RGB转换结果，无JPEG压缩；但不是原始UYVY数据的逐字节等价替代。
该接口和控制台、相机流共享局域网访问边界，**没有额外身份验证**。

本地套接字连接先执行hello握手，之后可在同一连接调用`media.frame`。套接字路径可配置：`mediad --frame-socket <路径>`以及`robotctl --media-socket <路径> frame`。套接字抢占失败会直接终止启动；已存在文件或其他监听进程不会被覆盖。
本地连接最多16路，单连接最长5秒；HTTP快照任务最多4个。HTTP采集超时3秒，响应元数据上限4KiB。非法分辨率、载荷大于16MiB的请求都会被拒绝。

`media.frame`刻意不支持Call/service-lane通道：JSON头部后面紧跟二进制流。WebRTC控制数据通道、当前`duckctl`蓝牙传输都不支持快照传输。只能使用本地套接字或控制台HTTP接口；远程视频传输是独立链路。未来可通过共享套接字组工具重构重复的句柄管理代码，而不需要把该功能绑定到多守护进程重构。

> 术语注释：
> - NPU：神经网络处理器
> - INT8：8位整型量化
> - TOPS：每秒万亿次运算
> - mAP50：IoU阈值0.5下的平均精度
> - RKNN：瑞芯微模型推理框架
> - letterbox：图像等比例缩放+补黑边预处理
> - dlopen：动态加载库函数
> - tee分流：图像流复制分支
> - UYVY：原始YUV图像格式
> - SoC：片上系统
> - daemon：后台守护进程
