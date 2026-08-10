# WCH CH32V4x7 评估板使用手册

## 1. 概述

本评估板应用于 CH32V4x7 芯片的开发，IDE 使用 MounRiver 2 编译器，可使用 WCH-Link 进行仿真和下载，并提供了芯片资源相关的应用参考示例及演示。

## 2. 评估板硬件

评估板的原理图请参考 CH32V4x7SCH.pdf 文档

![](static/images/2026-08-10-17-33-48-image.png)**模块说明**

- 1、网口 

- 2、按键 

- 3、LED 

- 4、LCD 接口

- 5、SWD 接口 

- 6、USBHS2 接口 

- 7、主控 MCU 

- 8、USBHS1 接口

- 9、低压降理想二极管 

- 10、电源开关 

- 11、DCDC 电路 

- 12、IO 口

上图 CH32V407VET6 评估板配有以下资源：**主板 - CH32V4x7V-R0**

1. 网口：主芯片的网络通讯接口

2. USER 按键和复位按键：连接主控 MCU 的 IO 口进行按键控制和用于外部手动复位主控 MCU。

3. LED：通过插针连接主控 MCU 的 IO 口进行控制

4. LCD 接口：用于扩展显示屏幕

5. SWD 接口：用于下载仿真调试

6. USBHS2 接口：连接主芯片 USBHS2 通信接口

7. 主控 MCU：主控芯片为 CH32V407VET6

8. USBHS1 接口：连接主芯片 USBHS1 通信接口

9. 低压降理想二极管：用于上游 USB 电源的过流和短路保护。CH213 是一款具有限流功能的低压降理想二极管芯片。

10. 电源开关: 用于切断或连接外部 5V 供电或 USB 供电

11. DCDC 电路: 降压器芯片为 CH2003V，用于实现将 5V 电压转成芯片可用的 3.3V 电压

12. MCU IO 口: 主控 MCU 的 IO 引出接口

## 3. 软件开发

### 3.1 EVT 包目录结构

![](static/images/2026-08-10-17-34-37-image.png)

### 3.2 IDE 使用 –MounRiver

下载 MounRiver_Studio， 双击安装， 安装后即可使用。
（MounRiver_Studio 使用说明详见,路径：MounRiver\MounRiver_Studio\ MounRiver_Help.pdf 和 MounRiver_ToolbarHelp.pdf）

**打开工程**

1）在相应的工程路径下直接双击.wvproj 后缀名的工程文件；
2）在 MounRiver IDE2 中点击 File，点击 Load Project，选择相应路径下.project 文件，点击Confirm 应用即可。

**编译**

MounRiver 包含三个编译选项，如下图所示：

![](static/images/2026-08-10-17-35-11-image.png)

- 编译选项 1 为增量编译，对选中工程中修改过的部分进行编译；

- 编译选项 2 为 ReBuild，对选中工程进行全局编译；

- 编译选项 3 为增量编译并下载，对选中工程中修改过的部分进行编译随后执行下载；

- 编译选项 4 为 All Build，对所有的工程进行全局编译。

**下载-调试器下载**

通过 WCH-Link 连接硬件（WCH-Link 使用说明详见,路径：MounRiver\MounRiver_Studio\ WCH-Link 使用说明.pdf） ，点击 IDE 上 Download 按钮，在弹出的界面选择下载，如下图所示：

![](static/images/2026-08-10-17-35-41-image.png)

- 1-为查询芯片读保护状态；

- 2-为设置芯片读保护，重新上电配置生效；

- 3-为解除芯片读保护，重新上电配置生效；

- 4-查询显示当前芯片类型

- 5-设置 link 模式

- 6-设置 FLASH，RAM 配置

- 7-power-off 擦除整片用户区 flash

- 8-设置下载地址

- 9-选择单双线模式

- 10-选择下载文件

- 11-下载配置选项

**仿真**

打开 MounRiver Studio 软件进行调试配置

![](static/images/2026-08-10-17-36-17-image.png)

选择合适的调试选项，应用并保存设置

![](static/images/2026-08-10-17-36-43-image.png)

点击 Start Debug 或者调试图标开始调试

**1）工具栏说明**

点击菜单栏的调试按键进入下载，见下图所示，下载工具栏

![](static/images/2026-08-10-17-37-07-image.png)

详细功能如下：

- 1.复位（Restart）：复位之后程序回到最开始处。
- 2.继续：点击继续调试。
- 3.终止：点击退出调试。
- 4.单步跳入：每点一次按键，程序运行一步，遇到函数进入并执行。
- 5.单步跳过：跳出该函数，准备下一条语句。
- 6.单步返回：返回所跳入的函数
- 7.指令集单步模式：点击进入指令集调试（需与 4、5、6 功能配合使用）。

**2）设置断点**

双击代码左侧可设置断点，再次双击取消断点，设置断点如下图所示;

![](static/images/2026-08-10-17-37-33-image.png)

**3）界面显示**

（1）指令集界面
点击指令集单步调试可进入指令调试，以单步跳入为例，每点击一次，可运行一次，运行光标会发生移动，以查看程序运行，指令集界面如下图所示：

![](static/images/2026-08-10-17-38-02-image.png)

（2）程序运行界面
可与指令集单步调试配合使用，仍以单步跳入为例，每点击一次，可运行一次，运行光标会发生
移动，以查看程序运行，程序运行界面如下图所示：

![](static/images/2026-08-10-17-38-28-image.png)

**4）变量**

鼠标悬停在源码中变量之上会显示详细信息，或者选中变量，然后右键单击 add to watch

![](static/images/2026-08-10-17-38-48-image.png)

![](static/images/2026-08-10-17-38-59-image.png)

填写变量名 ，将刚才选中的变量加入到窗口：

![](static/images/2026-08-10-17-39-18-image.png)

5）外设寄存器
在IDE 界面左下角Peripherals 界面显示有外设列表，选择外设则在Memory 窗口显示其具体的寄存器名称、地址、数值。

![](static/images/2026-08-10-17-39-40-image.png)

Tips：(1)调试时，点击右上角图标可进入原始界面。

![](static/images/2026-08-10-17-40-01-image.png)

## 4. WCH-LinkUtility.exe 下载

使用 WCH-LinkUtility 工具对芯片进行下载流程为：

- 1）连接 WCH-Link；
- 2）选择芯片信息；
- 3）添加固件；
- 4）设置配置，若芯片为读保护需解除芯片读保护；
- 5）执行

![](static/images/2026-08-10-17-40-29-image.png)

## 5. WCHISPTool.exe 下载

使用 WCHISPTool 工具对芯片进行下载，支持 USB 和串口两种下载方式。USB 管脚为 PA11（USB1DM） 、PA1（USB1DP） ，PB6（USB2DM） 、PB7（USB2DP）;串口管脚为 PA9(TX)、PA10（RX） 。**LQFP64封装不支持 BOOT 功能，具体芯片型号 CH32V407RET6、CH32V467RET6。** 

下载流程如下：

- (1) BOOT0 接 VCC，BOOT1 接地，通过串口或者 USB 连接 PC；
- (2) 打开 WCHISPTool 工具，选择相应下载方式，选择下载固件，勾选芯片配置，点击下载；
- (3) BOOT0 接地，重新上电，运行 APP 程序。

WCHISPTool 工具界面如图所示：

![](static/images/2026-08-10-17-41-05-image.png)

- 1.选择USB 或串口下载方式；

- 2.设备列表选择，识别设备，一般自动识别，如未能识别，需手动选择；

- 3.选择固件，选择下载的.hex 或.bin 目标程序文件；

- 4.根据要求选择下载配置；

- 5.解除代码保护

- 6.点击下载。

## 6. 资源

- SDK

- 原理图

- 其它：请到[xpulabs.taobao.com](https://xpulabs.taobao.com)购买
