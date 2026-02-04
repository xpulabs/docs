# FAQ001 - 到哪里下载开发板的SDK
您可以在WCH官方网站下载CH32H417Q开发板的SDK。

访问以下链接获取最新的SDK版本与技术手册：
[WCH CH32H417Q SDK](https://www.wch.cn/downloads/CH32H417EVT_ZIP.html)
[WCH CH32H417Q 技术手册](https://www.wch.cn/downloads/CH32H417RM_PDF.html)

推荐使用MounRiver Studio II作为开发环境，它提供了对CH32H417Q开发板的完整支持。
[MounRiver Studio II IDE](https://www.mounriver.com/download.html)


# FAQ002 - 开发板第一次下载固件总是失败
当你收到板子后，想烧录一个点灯的程序，发现无论如何都烧录不了，这是为什么？
原因是已经烧录了USB3.0的测试程序，程序中会禁用SWD接口，因为这个PB8，PB9是与USB3.0接口上HS的D+/D-是复用的。
```c
    /* Disable SWD */
    RCC_HB2PeriphClockCmd(RCC_HB2Periph_AFIO | RCC_HB2Periph_GPIOB, ENABLE);
    GPIO_PinRemapConfig(GPIO_Remap_SWJ_Disable, ENABLE);
```
解决办法：