## FAQ001 - 到哪里下载开发板的SDK
您可以在WCH官方网站下载CH32H417Q开发板的SDK。

访问以下链接获取最新的SDK版本与技术手册：
- [WCH CH32H417Q SDK](https://www.wch.cn/downloads/CH32H417EVT_ZIP.html)
- [WCH CH32H417Q 技术手册](https://www.wch.cn/downloads/CH32H417RM_PDF.html)

推荐使用MounRiver Studio II作为开发环境，它提供了对CH32H417Q开发板的完整支持。
- [MounRiver Studio II IDE](https://www.mounriver.com/download.html)


## FAQ002 - 开发板第一次下载固件总是失败
当你收到板子后，想烧录一个点灯的程序，发现无论如何都烧录不了，这是为什么？

原因是已经烧录了USB3.0的测试程序，程序中会禁用SWD接口，因为这个PB8，PB9(SWDIO，SWCLK)是与USB3.0接口上HS的D+/D-是复用的。
所以在USB3.0程序初始化时使用下面的代码禁用了SWD接口。

```c
    /* Disable SWD */
    RCC_HB2PeriphClockCmd(RCC_HB2Periph_AFIO | RCC_HB2Periph_GPIOB, ENABLE);
    GPIO_PinRemapConfig(GPIO_Remap_SWJ_Disable, ENABLE);
```
解决办法：使用WCH LINK-E调试器将Code Flash擦除。
具体步骤如下：
1. 连接WCH LINK-E调试器到开发板的SWD接口，并通过调试器供电。
2. 打开MounRiver Studio II IDE，选择“下载”->“下载配置”
3. 在“Erase Code Flash”选项中，选择“By Power off”, 点击“应用”。下面对话框中会显示成功。
4. 拔掉WCH LINK-E调试器给开发板断电，然后重新连接调试器给开发板上电。
5. 再使用MounRiver Studio II IDE烧录固件，应该就可以成功了。