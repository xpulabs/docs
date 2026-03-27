# 串口输出OV2640图像

mio_dvp_uart/Common/Common/hardware.c文件解析

## 文件概述
该文件是WCH（南京沁恒微电子有限公司）开发的DVP（Digital Video Port）与UART通信的硬件固件函数库，版本为V1.0.0，发布于2025/03/01。主要功能是通过DVP接口接收摄像头数据（JPEG格式），并通过UART接口发送出去。

## 核心功能模块

### 1. 全局变量与配置
```c
__attribute__ ((aligned(32))) UINT32  JPEG_DVPDMAaddr0 = 0x2011A000;
__attribute__ ((aligned(32))) UINT32  JPEG_DVPDMAaddr1 = 0x2011A000 + OV2640_JPEG_WIDTH;

volatile UINT32 frame_cnt = 0;   // 帧计数器
volatile UINT32 addr_cnt = 0;    // 地址计数器
volatile UINT32 href_cnt = 0;    // 行计数器
```
定义了JPEG数据的DMA缓冲区地址（32字节对齐）和各种计数器，用于跟踪DVP数据传输状态。

### 2. UART数据发送
```c
void USART_Send_Byte(u8 t)
{
    while (USART_GetFlagStatus(USART1, USART_FLAG_TC) == RESET);
    USART_SendData(USART1, t);
}
```
实现了通过USART1发送单字节数据的功能，发送前等待上一个字节发送完成。

### 3. DVP初始化配置
```c
void DVP_Function_Init(void)
{
    DVP_InitTypeDef DVP_InitStructure = {0};
    RCC_HBPeriphClockCmd(RCC_HBPeriph_DVP, ENABLE);

    DVP_DeInit();
    DVP_InitStructure.DVP_DataSize = DVP_DataSize_8b;
    DVP_InitStructure.DVP_COL_NUM = OV2640_JPEG_WIDTH;
    // ... 其他DVP配置
    DVP_InitStructure.DVP_JPEGMode = ENABLE;
    DVP_Init(&DVP_InitStructure);

    // ... 中断和DMA配置
    DVP_DMACmd(ENABLE);
    DVP_Cmd(ENABLE);
}
```
初始化DVP接口，配置为8位数据宽度，JPEG模式，设置了DMA缓冲区地址和帧捕获率等参数，并启用了相关中断。

### 4. DVP中断处理
```c
void DVP_IRQHandler(void)
{
    if (DVP_GetITStatus(DVP_IT_ROW_DONE) != RESET)
    {
        // 行数据传输完成处理
        href_cnt++;
        if (addr_cnt%2)     /* buf1 done */
        {
            addr_cnt++;
            DVP->DMA_BUF1 += OV2640_JPEG_WIDTH *2;
        }
        else                /* buf0 done */
        {
            addr_cnt++;
            DVP->DMA_BUF0 += OV2640_JPEG_WIDTH *2;
        }
    }

    if (DVP_GetITStatus(DVP_IT_FRM_DONE) != RESET)
    {
        // 一帧数据传输完成处理
        DVP_ClearITPendingBit(DVP_IT_FRM_DONE);
        DVP_Cmd(DISABLE);
        
        // 通过UART发送JPEG数据
        UINT32 i;
        UINT8 val;
        href_cnt = href_cnt*OV2640_JPEG_WIDTH;
        for(i=0; i<href_cnt; i++){
            val = *(UINT8*)(0x2011A000+i);
            USART_Send_Byte(val);
        }
        
        DVP_Cmd(ENABLE);
        // 重置DMA缓冲区地址和计数器
        DVP->DMA_BUF0 = JPEG_DVPDMAaddr0;
        DVP->DMA_BUF1 = JPEG_DVPDMAaddr1;
        href_cnt = 0;
        addr_cnt =0;       
    }

    // ... 其他中断处理（帧开始、帧停止、FIFO溢出等）
}
```
DVP中断处理函数，处理各种DVP中断事件：
- 行完成中断：更新行计数器和DMA缓冲区地址
- 帧完成中断：通过UART发送完整的JPEG数据，并重置相关参数
- 帧开始/停止中断：更新帧计数器
- FIFO溢出中断：清除溢出标志

### 5. 主测试函数
```c
void Hardware(void)
{
    RCC_HB1PeriphClockCmd(RCC_HB1Periph_PWR, ENABLE);
    PWR_VIO18ModeCfg(PWR_VIO18CFGMODE_SW);
    PWR_VIO18LevelCfg(PWR_VIO18Level_MODE3); 
    
    while(OV2640_Init())
    {
        printf("Camera Model Error\r\n");
        Delay_Ms(1000);
    }
    Delay_Ms(1000);
    RGB565_Mode_Init();
    Delay_Ms(1000);

#if (DVP_Work_Mode == JPEG_MODE)
    printf("JPEG Mode\r\n");
    JPEG_Mode_Init();
    Delay_Ms(1000);
#endif
    DVP_Function_Init();
    while(1);
}
```
主函数实现了以下功能：
- 配置系统电源电压为3.3V
- 初始化OV2640摄像头
- 配置摄像头为RGB565模式
- 如果工作在JPEG模式，则切换摄像头为JPEG模式
- 初始化DVP接口
- 进入循环，等待DVP中断事件

## 关键技术点分析

### 1. DVP接口工作原理
DVP（Digital Video Port）是一种高速视频接口，用于连接图像传感器和微控制器。该程序中DVP工作在JPEG模式，直接接收压缩后的JPEG图像数据。

### 2. DMA双缓冲区机制
程序使用了两个DMA缓冲区（buf0和buf1）交替存储DVP接收的数据，提高了数据传输效率，避免了FIFO溢出。

### 3. 中断处理机制
DVP中断处理函数负责管理整个数据传输过程，包括行数据接收、帧数据接收完成和数据发送等。通过中断机制，可以及时响应DVP的各种状态变化。

### 4. 数据流向
摄像头 → DVP接口 → DMA缓冲区 → UART发送

## 总结
该文件实现了一个完整的DVP摄像头数据采集和UART传输系统，主要功能包括：
- DVP接口初始化和配置
- OV2640摄像头初始化和模式切换（RGB565/JPEG）
- DMA双缓冲区数据接收
- 中断驱动的数据传输
- UART数据发送

程序结构清晰，功能完整，可以作为CH32H417系列微控制器DVP接口和摄像头应用开发的参考。
        