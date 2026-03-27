# MAX98357

## 1. 文件概述

`hardware.c` 是一个用于 **SAI (Serial Audio Interface) 驱动 MAX98357A 音频放大器** 的硬件测试程序，通过 CH32H417 的 SAI 外设实现音频输出功能。

- **作者**: WCH (Nanjing Qinheng Microelectronics Co., Ltd.)
- **版本**: V1.0.0
- **日期**: 2025/03/01
- **功能**: 实现 SAI 音频输出，驱动 MAX98357A 放大器播放正弦波音频

## 2. 核心功能模块

### 2.1 音频配置与数据定义

```c
#include "hardware.h"
#include "math.h"

#define PI          3.1415926535f
#define TAU         (2.0f * PI)
#define SAMPLE_RATE (8000)
#define DATA_SIZE   SAMPLE_RATE

s16 SAI_Data[DATA_SIZE];
```

- 包含数学库用于生成音频波形
- 定义了 π 和 2π (TAU) 常量用于正弦波计算
- 设置采样率为 8000Hz (SAMPLE_RATE)
- 数据大小等于采样率，即 8000 个采样点
- 定义了一个 16 位有符号整数数组用于存储音频采样数据

### 2.2 GPIO 配置函数 (GPIO_Config)

**功能**: 配置 SAI 和音频放大器控制的 GPIO 引脚

```c
static void GPIO_Config(void)
{
    GPIO_InitTypeDef GPIO_InitStructure = {0};
    RCC_HB2PeriphClockCmd(RCC_HB2Periph_AFIO, ENABLE);
    RCC_HB2PeriphClockCmd(RCC_HB2Periph_GPIOB | RCC_HB2Periph_GPIOC, ENABLE);
	
    // FS_A PC3(AF7) - 帧同步信号
    GPIO_PinAFConfig(GPIOC, GPIO_PinSource3, GPIO_AF7);
    GPIO_InitStructure.GPIO_Pin   = GPIO_Pin_3;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_Very_High;
    GPIO_InitStructure.GPIO_Mode  = GPIO_Mode_AF_PP;
    GPIO_Init(GPIOC, &GPIO_InitStructure);

    // SCK_A PC2(AF7) - 串行时钟信号
    GPIO_PinAFConfig(GPIOC, GPIO_PinSource2, GPIO_AF7);
    GPIO_InitStructure.GPIO_Pin   = GPIO_Pin_2;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_Very_High;
    GPIO_InitStructure.GPIO_Mode  = GPIO_Mode_AF_PP;
    GPIO_Init(GPIOC, &GPIO_InitStructure);

    // SD_A PC1(AF6) - 串行数据信号
    GPIO_PinAFConfig(GPIOC, GPIO_PinSource1, GPIO_AF6);
    GPIO_InitStructure.GPIO_Pin   = GPIO_Pin_1;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_Very_High;
    GPIO_InitStructure.GPIO_Mode  = GPIO_Mode_AF_PP;
    GPIO_Init(GPIOC, &GPIO_InitStructure);

    // // MCLK_A PC0(AF7) - 主时钟信号 (当前被注释)
    // GPIO_PinAFConfig(GPIOC, GPIO_PinSource0, GPIO_AF7);
    // GPIO_InitStructure.GPIO_Pin   = GPIO_Pin_0;
    // GPIO_InitStructure.GPIO_Speed = GPIO_Speed_Very_High;
    // GPIO_InitStructure.GPIO_Mode  = GPIO_Mode_AF_PP;
    // GPIO_Init(GPIOC, &GPIO_InitStructure);

    // MAX98357A 使能引脚 PB15
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_15;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_Very_High;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_Out_PP;
    GPIO_Init(GPIOB, &GPIO_InitStructure);

    // 设置音频放大器使能引脚为高电平 (启用放大器)
    GPIO_WriteBit(GPIOB, GPIO_Pin_15, Bit_SET);
}
```

- **SAI 引脚配置**:
  - FS_A (PC3): 帧同步信号，AF7 功能
  - SCK_A (PC2): 串行时钟信号，AF7 功能
  - SD_A (PC1): 串行数据信号，AF6 功能
  - MCLK_A (PC0): 主时钟信号，当前被注释
- **音频放大器控制**:
  - PB15: 推挽输出，控制 MAX98357A 的使能端
  - 默认设置为高电平，启用音频放大器

### 2.3 SAI 配置函数 (SAI_Config)

**功能**: 配置 SAI 外设为音频输出模式

```c
void SAI_Config(uint32_t SampleRate)
```

**执行流程**:

1. **时钟配置**:
   ```c
   /* SAI 时钟配置计算公式:
   SAI_CK_x  = SysClk / 6
   MCLK_x = SAI_CK_x / MCKDIV[5:0] with MCLK_x = 256 * FS
   FS = SAI_CK_x / (MCKDIV[5:0] * 256)
   MCKDIV[5:0] = (SysClk / 6) / (FS * 256) */

   RCC_ClocksTypeDef RCC_ClocksStatus = {0};
   RCC_GetClocksFreq(&RCC_ClocksStatus);
   const uint32_t tmpdiv = (RCC_ClocksStatus.SYSCLK_Frequency / 6) / (SampleRate * 256);
   ```
   - 计算 SAI 主时钟分频值，确保 MCLK = 256 * FS (采样率)
   - 获取系统时钟频率并计算相应的分频系数

2. **SAI 基本配置**:
   ```c
   SAI_InitStructure.SAI_NoDivider     = SAI_MasterDivider_Enabled;
   SAI_InitStructure.SAI_MasterDivider = tmpdiv;
   SAI_InitStructure.SAI_AudioMode     = SAI_Mode_MasterTx;
   SAI_InitStructure.SAI_Protocol      = SAI_Free_Protocol;
   SAI_InitStructure.SAI_DataSize      = SAI_DataSize_16b;
   SAI_InitStructure.SAI_FirstBit      = SAI_FirstBit_MSB;
   SAI_InitStructure.SAI_ClockStrobing = SAI_ClockStrobing_RisingEdge;
   SAI_InitStructure.SAI_Synchro       = SAI_Asynchronous;
   SAI_InitStructure.SAI_FIFOThreshold = SAI_Threshold_FIFOEmpty;
   SAI_Init(SAI_Block_A, &SAI_InitStructure);
   ```
   - 启用主分频器并设置计算得到的分频值
   - 配置为主动发送模式，16位数据，MSB 优先
   - 时钟上升沿采样，异步模式

3. **帧配置**:
   ```c
   SAI_FrameInitStructure.SAI_FrameLength       = 32;
   SAI_FrameInitStructure.SAI_ActiveFrameLength = 16;
   SAI_FrameInitStructure.SAI_FSDefinition      = SAI_FS_StartFrame;
   SAI_FrameInitStructure.SAI_FSPolarity        = SAI_FS_ActiveHigh;
   SAI_FrameInitStructure.SAI_FSOffset          = SAI_FS_BeforeFirstBit;
   SAI_FrameInit(SAI_Block_A, &SAI_FrameInitStructure);
   ```
   - 帧长度 32 位，有效长度 16 位
   - 帧同步信号在帧开始时有效，高电平有效

4. **插槽配置**:
   ```c
   SAI_SlotInitStructure.SAI_FirstBitOffset = 0;
   SAI_SlotInitStructure.SAI_SlotSize       = SAI_SlotSize_16b;
   SAI_SlotInitStructure.SAI_SlotNumber     = 2;
   SAI_SlotInitStructure.SAI_SlotActive     = SAI_SlotActive_ALL;
   SAI_SlotInit(SAI_Block_A, &SAI_SlotInitStructure);
   ```
   - 插槽大小 16 位，共 2 个插槽
   - 两个插槽都处于激活状态（立体声配置）

### 2.4 DMA 初始化函数 (Tx_DMA_Init)

**功能**: 初始化 DMA 用于音频数据传输

```c
void Tx_DMA_Init(DMA_Channel_TypeDef *DMAy_Channelx, uint32_t pAddr, uint32_t mAddr, uint16_t Length)
```
- `DMAy_Channelx`: DMA 通道
- `pAddr`: 外设地址
- `mAddr`: 内存地址
- `Length`: 数据长度

**执行流程**:

```c
DMA_InitStructure.DMA_PeripheralBaseAddr = pAddr;
DMA_InitStructure.DMA_Memory0BaseAddr    = mAddr;
DMA_InitStructure.DMA_DIR                = DMA_DIR_PeripheralDST;
DMA_InitStructure.DMA_BufferSize         = Length;
DMA_InitStructure.DMA_PeripheralInc      = DMA_PeripheralInc_Disable;
DMA_InitStructure.DMA_MemoryInc          = DMA_MemoryInc_Enable;
DMA_InitStructure.DMA_PeripheralDataSize = DMA_PeripheralDataSize_HalfWord;
DMA_InitStructure.DMA_MemoryDataSize     = DMA_MemoryDataSize_HalfWord;
DMA_InitStructure.DMA_Mode               = DMA_Mode_Circular;
DMA_InitStructure.DMA_Priority           = DMA_Priority_VeryHigh;
DMA_InitStructure.DMA_M2M                = DMA_M2M_Disable;
DMA_Init(DMAy_Channelx, &DMA_InitStructure);
```

- 配置 DMA 从内存到外设的数据传输
- 外设地址固定，内存地址自增
- 半字 (16位) 数据大小
- 循环模式，极高优先级
- 禁用内存到内存传输

### 2.5 主函数 (Hardware)

**功能**: 初始化系统并生成音频输出

```c
void Hardware(void)
```

**执行流程**:

1. **系统初始化**:
   ```c
   printf("MIO SAI MAX98357A TEST\r\n");

   RCC_HB1PeriphClockCmd(RCC_HB1Periph_PWR, ENABLE);
   PWR_VIO18ModeCfg(PWR_VIO18CFGMODE_SW);
   PWR_VIO18LevelCfg(PWR_VIO18Level_MODE3);    // PWR_VIO18Level_MODE3 = 3.3V
   Delay_Ms(100);
   ```
   - 打印测试信息
   - 配置电源管理：启用 PWR 时钟，设置 VIO18 电压为 3.3V

2. **生成正弦波数据**:
   ```c
   // 生成正弦波数据，频率 440Hz(A4)，采样率 8000Hz
   for (int i = 0; i < DATA_SIZE; i += 2)
   {
       float t         = ((float)i) / ((float)SAMPLE_RATE);
       SAI_Data[i]     = 1000.0f * sinf(440.0f * TAU * t);
       SAI_Data[i + 1] = SAI_Data[i];
   }
   ```
   - 生成 440Hz (A4 音符) 的正弦波数据
   - 振幅为 1000 (16位有符号整数)
   - 左右声道数据相同 (立体声)

3. **硬件初始化**:
   ```c
   SAI_Config(SAMPLE_RATE);
   GPIO_Config();
   ```
   - 配置 SAI 和 GPIO 外设

4. **DMA 配置与启动**:
   ```c
   Tx_DMA_Init(DMA1_Channel1, (uint32_t)(&SAI_Block_A->DATAR), (uint32_t)SAI_Data, DATA_SIZE);
   DMA_MuxChannelConfig(DMA_MuxChannel1, 112);

   DMA_Cmd(DMA1_Channel1, ENABLE);
   SAI_DMACmd(SAI_Block_A, ENABLE);
   ```
   - 初始化 DMA 通道 1，连接 SAI Block A 的数据寄存器
   - 配置 DMA 多路复用通道
   - 启用 DMA 和 SAI 的 DMA 功能

5. **启动音频输出**:
   ```c
   SAI_Cmd(SAI_Block_A, ENABLE);
   ```
   - 启用 SAI Block A，开始音频输出

## 3. 工作原理与时序分析

### 3.1 SAI 音频输出原理

SAI (Serial Audio Interface) 是一种用于音频数据传输的串行接口，采用时分复用技术传输多个音频通道的数据。

**关键信号时序**:

1. **SCK (Serial Clock)**: 串行时钟，用于同步数据传输
2. **FS (Frame Sync)**: 帧同步信号，指示一个音频帧的开始
3. **SD (Serial Data)**: 串行数据信号，传输音频数据

**音频帧结构**:
- 帧长度: 32 位
- 有效帧长度: 16 位
- 每帧包含两个插槽 (Slot 0 和 Slot 1)，分别对应左右声道
- 每个插槽包含 16 位音频数据

### 3.2 MAX98357A 工作原理

MAX98357A 是一款单声道 D 类音频放大器，支持 I2S/PCM 接口：
- 内置 DAC 和放大器
- 3.2W 输出功率
- 支持 16-24 位音频数据
- 3.0-5.5V 电源电压
- 仅需极少的外部组件

### 3.3 音频数据流程

1. **数据生成**: CPU 在 `Hardware` 函数中生成正弦波数据并存入 `SAI_Data` 数组
2. **DMA 传输**: DMA1_Channel1 将 `SAI_Data` 数组中的数据自动传输到 SAI Block A 的数据寄存器
3. **SAI 输出**: SAI 将数据转换为串行音频信号 (SCK, FS, SD)
4. **音频放大**: MAX98357A 接收串行音频信号，进行数模转换和功率放大
5. **音频输出**: 驱动扬声器产生声音

## 4. 与其他音频应用的对比

| 特性 | mio_sai_max98357 | 普通 I2S 音频 |
|------|------------------|---------------|
| 接口类型 | SAI | I2S |
| 数据传输 | DMA 自动传输 | CPU 或 DMA |
| 采样率 | 8000Hz | 可变 (通常 44.1kHz/48kHz) |
| 音频格式 | 16位立体声 | 16-32位单/立体声 |
| 放大器 | MAX98357A D类 | 外接放大器或无 |
| 音频质量 | 基础音频输出 | 高质量音频输出 |

## 5. 代码优化建议

### 5.1 增加采样率灵活性

```c
// 允许动态调整采样率和音频频率
#define DEFAULT_SAMPLE_RATE 8000
#define DEFAULT_FREQUENCY   440.0f

void generate_sine_wave(s16* buffer, uint32_t size, float frequency, uint32_t sample_rate)
{
    for (int i = 0; i < size; i += 2)
    {
        float t = ((float)i) / ((float)sample_rate);
        buffer[i] = 1000.0f * sinf(frequency * TAU * t);
        buffer[i + 1] = buffer[i]; // 立体声复制左声道
    }
}
```

### 5.2 增加音频效果

```c
// 增加音量控制和不同波形生成
void generate_square_wave(s16* buffer, uint32_t size, float frequency, uint32_t sample_rate, float amplitude)
{
    for (int i = 0; i < size; i += 2)
    {
        float t = ((float)i) / ((float)sample_rate);
        float sine_val = sinf(frequency * TAU * t);
        buffer[i] = (sine_val >= 0) ? amplitude : -amplitude;
        buffer[i + 1] = buffer[i];
    }
}

// 音量控制函数
void adjust_volume(s16* buffer, uint32_t size, float volume_gain)
{
    for (int i = 0; i < size; i++)
    {
        buffer[i] = (s16)((float)buffer[i] * volume_gain);
    }
}
```

### 5.3 改进错误处理

```c
// 增加 SAI 初始化状态检查
uint8_t SAI_Config(uint32_t SampleRate)
{
    // 现有配置代码...
    
    // 初始化后检查状态
    if(SAI_GetFlagStatus(SAI_Block_A, SAI_FLAG_OVRUN) != RESET)
    {
        printf("SAI Overrun Error!\r\n");
        return 1;
    }
    return 0;
}
```

### 5.4 增加音频播放控制

```c
// 暂停/恢复音频播放
void SAI_PlayControl(uint8_t enable)
{
    if(enable)
    {
        GPIO_WriteBit(GPIOB, GPIO_Pin_15, Bit_SET); // 启用放大器
        SAI_Cmd(SAI_Block_A, ENABLE);
        DMA_Cmd(DMA1_Channel1, ENABLE);
    }
    else
    {
        SAI_Cmd(SAI_Block_A, DISABLE);
        DMA_Cmd(DMA1_Channel1, DISABLE);
        GPIO_WriteBit(GPIOB, GPIO_Pin_15, Bit_RESET); // 禁用放大器
    }
}
```

## 6. 总结

这个程序实现了基于 CH32H417 SAI 外设的音频输出功能，主要特点：

1. **硬件加速**: 利用 SAI 外设和 DMA 传输，实现高效的音频数据输出
2. **简洁设计**: 代码结构清晰，易于理解和扩展
3. **可配置性**: 支持不同的采样率和音频频率
4. **低功耗**: 使用 DMA 传输减少 CPU 占用，支持低功耗运行
5. **集成度高**: 与 MAX98357A 音频放大器完美配合，只需极少的外部组件

该程序展示了如何利用 CH32H417 的高级外设功能实现音频输出，具有较高的学习和参考价值。适合用于音频应用的原型开发和学习。
        