# LCD显示OV2640图像

mio_dvp_tft/Common/Common/hardware.c文件解析

## 文件概述
该文件是WCH（南京沁恒微电子有限公司）开发的DVP（Digital Video Port）与TFT LCD显示的硬件固件函数库，版本为V1.0.0，发布于2025/03/01。主要功能是实现OV2640摄像头图像采集并通过DVP接口实时显示在TFT LCD上。

## 核心功能模块

### 1. 全局变量定义
```c
__attribute__ ((aligned(32))) uint16_t ImageDataOv2640[2 * OV2640_RGB565_WIDTH] = {0};
volatile UINT32 frame_cnt = 0;   // 帧计数器
volatile UINT32 href_cnt = 0;    // 行计数器
```
- `ImageDataOv2640`：32字节对齐的图像数据缓冲区，用于存储DVP采集的RGB565格式图像数据
- 计数器用于跟踪DVP数据传输状态

### 2. DMA配置函数
```c
void DMA_SRAMLCD_Enable(void)
{
    DMA_Cmd(DMA1_Channel3, DISABLE);
    DMA_SetCurrDataCounter(DMA1_Channel3, lcddev.width);
    DMA_Cmd(DMA1_Channel3, ENABLE);
}

void DMA_SRAMLCD_Init(u32 addr)
{
    DMA_InitTypeDef DMA_InitStructure = {0};
    RCC_HBPeriphClockCmd(RCC_HBPeriph_DMA1, ENABLE);

    // ... DMA配置
    DMA_InitStructure.DMA_PeripheralBaseAddr = addr;
    DMA_InitStructure.DMA_Memory0BaseAddr = (u32)&LCD->LCD_RAM;
    DMA_InitStructure.DMA_DIR = DMA_DIR_PeripheralSRC;
    // ... 其他配置
    DMA_Init(DMA1_Channel3, &DMA_InitStructure);
    // ... 
}
```
- `DMA_SRAMLCD_Enable`：使能LCD DMA传输并设置传输长度
- `DMA_SRAMLCD_Init`：初始化DMA通道3，配置为从SRAM到LCD RAM的内存到内存传输模式

### 3. DVP接口初始化
```c
void DVP_Function_Init(void) 
{
    DVP_InitTypeDef DVP_InitStructure = {0};
    RCC_HBPeriphClockCmd(RCC_HBPeriph_DVP, ENABLE);

    DVP_DeInit();
    DVP_InitStructure.DVP_DataSize = DVP_DataSize_8b;
    DVP_InitStructure.DVP_COL_NUM = OV2640_RGB565_WIDTH * 2;
    DVP_InitStructure.DVP_ROW_NUM = OV2640_RGB565_HEIGHT;
    DVP_InitStructure.DVP_JPEGMode = DISABLE;  // 使用RGB565模式
    // ... 其他DVP配置
    DVP_Init(&DVP_InitStructure);

    // ... 中断配置
    NVIC_EnableIRQ(DVP_IRQn);
    NVIC_SetPriority(DVP_IRQn, 0);

    DVP_DMACmd(ENABLE);
    DVP_Cmd(ENABLE);
}
```
- 初始化DVP接口为8位数据宽度，RGB565模式
- 设置图像分辨率、同步信号极性和DMA缓冲区地址
- 配置DVP中断优先级并启用DVP

### 4. LCD初始化
```c
void LCD_Reset_GPIO_Init(void)
{
    GPIO_InitTypeDef GPIO_InitStructure = {0};

    RCC_HB2PeriphClockCmd(RCC_HB2Periph_GPIOD, ENABLE);
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_3;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_Out_PP;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_Very_High;
    GPIO_Init(GPIOD, &GPIO_InitStructure);

    GPIO_ResetBits (GPIOD, GPIO_Pin_3);
    Delay_Ms(100);
    GPIO_SetBits (GPIOD, GPIO_Pin_3);
}
```
- 初始化LCD复位引脚PD3为输出模式
- 执行LCD复位操作：拉低100ms后拉高

### 5. 主函数
```c
void Hardware(void)
{  
    LCD_Reset_GPIO_Init();
    LCD_Init();   
    
    while(OV2640_Init())
    {
        printf("Camera Initialize failed.\r\n");
        Delay_Ms(1000);
    }
    printf("Camera Initialize Success.\r\n");

    Delay_Ms(1000);
    OV2640_RGB565_Mode_Init();
    Delay_Ms(1000);   
    printf("RGB565 Mode...\r\n");

    DMA_SRAMLCD_Init((u32)ImageDataOv2640);
    DVP_Function_Init();
    
    while(1);
}
```
- 初始化LCD和OV2640摄像头
- 配置摄像头为RGB565模式
- 初始化DMA和DVP接口
- 进入循环等待中断事件

### 6. DVP中断处理
```c
void DVP_IRQHandler(void)
{
    if(DVP_GetITStatus(DVP_IT_ROW_DONE) != RESET)
    {
        DVP_ClearITPendingBit(DVP_IT_ROW_DONE);

        if(href_cnt % 2)
        {
            /* Send DVP data to LCD */
            DMA_Cmd(DMA1_Channel3, DISABLE);    
            DMA_SetCurrDataCounter(DMA1_Channel3, OV2640_RGB565_WIDTH * 2);
            DMA1_Channel3->PADDR = (uint32_t)(ImageDataOv2640);     
            DMA_Cmd(DMA1_Channel3, ENABLE);
        }
        href_cnt++;
    }

    // ... 其他中断处理
}
```
- 行完成中断处理：将采集的图像数据通过DMA传输到LCD
- 帧完成中断处理：重置行计数器
- 帧开始/停止中断处理：更新帧计数器

## 关键技术点分析

### 1. DVP双缓冲机制
使用两个缓冲区交替存储DVP采集的图像数据，提高数据传输效率：
- `DVP_DMA_BUF0_Addr = (uint32_t)(ImageDataOv2640)`
- `DVP_DMA_BUF1_Addr = (uint32_t)(ImageDataOv2640 + OV2640_RGB565_WIDTH)`

### 2. RGB565图像格式
配置DVP和摄像头为RGB565模式，每个像素占2字节，格式为R[4:0]G[5:0]B[4:0]，适合LCD直接显示。

### 3. DMA传输优化
使用DMA1_Channel3实现从SRAM到LCD RAM的高速数据传输，采用内存到内存模式，无需CPU干预，提高显示效率。

### 4. 中断驱动设计
通过DVP中断事件（行完成、帧完成等）触发图像数据处理和显示，实现实时图像采集和显示。

## 数据流向
OV2640摄像头 → DVP接口 → ImageDataOv2640缓冲区 → DMA1_Channel3 → LCD RAM → TFT LCD显示

## 总结
该文件实现了一个完整的DVP图像采集和LCD显示系统，主要功能包括：
- OV2640摄像头初始化和RGB565模式配置
- DVP接口配置和双缓冲图像采集
- DMA高速图像数据传输
- TFT LCD初始化和图像显示

程序采用中断驱动和DMA传输的设计方式，实现了摄像头图像的实时采集和显示，适合嵌入式视频应用开发。
        