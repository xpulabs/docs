# CH32H417系列ADC（模拟/数字转换）入门到精通教程

# 前言

ADC（Analog-to-Digital Converter，模拟/数字转换器）是嵌入式系统中连接模拟信号与数字信号的核心模块，负责将传感器、模拟电路输出的连续模拟电压，转换为单片机可识别、处理的离散数字信号。CH32H417系列MCU内置2个12位ADC，支持最高80MHz输入时钟，具备多通道、多转换模式、模拟看门狗等丰富功能，可广泛应用于数据采集、传感器监测、电压检测等场景。

本教程将基于CH32H417系列MCU的ADC模块手册，从基础认知、核心功能、配置流程、实操要点、寄存器详解五个维度，手把手教你掌握ADC的使用方法，兼顾理论深度与实操可落地性，适合嵌入式初学者及进阶开发者参考。

# 第一章：ADC基础认知

## 1.1 什么是ADC

ADC是模拟信号到数字信号的转换桥梁，其核心作用是将连续变化的模拟电压（如温度传感器输出的电压、电位器调节的电压），转换为离散的二进制数字（0~4095，对应12位分辨率），供MCU进行运算、存储或传输。

CH32H417系列ADC的核心参数：

- 分辨率：12位（可区分的最小电压间隔 = 参考电压/4096）；

- 输入时钟：最高80MHz，由HCLK分频得到；

- 采样通道：16个外部通道（ADC_IN0~ADC_IN15）+ 2个内部通道（温度传感器ADC_IN16、内部参考电压V_REFINT ADC_IN17）；

- 输入范围：VSS ≤ VIN ≤ VDDIO；

- 核心功能：单次/连续转换、通道扫描、外部触发、模拟看门狗、双重ADC模式等。

## 1.2 ADC核心概念

### 1.2.1 分辨率

分辨率是ADC区分不同模拟电压的能力，单位为“位（bit）”。CH32H417的ADC为12位，意味着其可将参考电压范围内的电压划分为2¹²=4096个等级，每个等级对应一个数字值（0~4095）。

举例：若参考电压为3.3V，12位ADC的最小分辨电压为3.3V/4096 ≈ 0.805mV，即模拟电压每变化约0.8mV，数字值就会变化1。

### 1.2.2 采样时间与转换时间

采样时间：ADC对输入模拟电压的“采集时间”，需通过寄存器配置，每个通道可独立设置，范围为1.5~239.5个ADCCLK周期；

转换时间：完成一次模拟到数字转换的总时间，计算公式为：T_CONV = 采样时间 + 12.5×T_ADCCLK（12.5个周期为ADC内部转换固定耗时）。

举例：若ADCCLK为80MHz（T_ADCCLK=12.5ns），采样时间设为1.5个周期，则转换时间 = 1.5×12.5ns + 12.5×12.5ns = 175ns，对应采样率约5.7MHz。

### 1.2.3 转换组：规则组与注入组

CH32H417的ADC支持两种转换组，用于实现多通道的灵活转换：

- 规则组：最多16个通道，转换顺序由ADCx_RSQRx寄存器配置，转换总数由ADCx_RSQR1寄存器的L[3:0]定义，适用于常规的多通道连续采集；

- 注入组：最多4个通道，转换顺序由ADCx_ISQR寄存器配置，转换总数由JL[1:0]定义，优先级高于规则组，可在规则组转换过程中“插入”转换，适用于紧急场景（如异常电压检测）。

### 1.2.4 数据对齐

ADC转换后的12位数字值，可通过ADCx_CTLR2寄存器的ALIGN位配置两种对齐方式：

- 右对齐（默认）：12位有效数据占据寄存器的低12位，高4位补0，适合常规数据处理；

- 左对齐：12位有效数据占据寄存器的高12位，低4位补0，适合需要高位精度的场景。

# 第二章：ADC核心功能详解

## 2.1 转换模式（重点）

CH32H417的ADC支持多种转换模式，可通过ADCx_CTLR1和ADCx_CTLR2寄存器的控制位组合配置，满足不同场景需求：

### 2.1.1 单次单通道模式

配置：CONT=0（禁止连续转换）、SCAN=0（禁止扫描），通过ADON位（软件）或外部触发启动转换；

特点：仅对规则组/注入组中排序第1的通道执行一次转换，转换完成后停止，需重新触发才能再次转换；

适用场景：单次采集单个模拟信号（如按键电压检测）。

### 2.1.2 单次扫描模式

配置：CONT=0、SCAN=1，可配合JAUTO位选择“触发注入”或“自动注入”；

特点：按配置顺序，对规则组/注入组的所有通道逐个执行一次转换，转换完成后停止；

触发注入（JAUTO=0）：规则组转换时，若收到注入组触发信号，暂停规则组，先完成注入组转换，再恢复规则组；

自动注入（JAUTO=1）：规则组转换完成后，自动启动注入组转换，无需外部触发；

适用场景：一次性采集多个通道的模拟信号（如多传感器数据采集）。

### 2.1.3 单次间断模式

配置：CONT=0、SCAN=1，同时设置DISCEN（规则组）或JDISCEN（注入组）为1，通过DISCNUM[2:0]定义每次触发转换的通道数；

特点：将一组通道分为多个短序列，每次外部触发仅转换一个短序列，直到所有通道转换完成，下一次触发重新开始；

注意：规则组和注入组不能同时开启间断模式；

适用场景：需分批次采集多通道数据，避免单次转换耗时过长。

### 2.1.4 连续转换模式

配置：CONT=1、SCAN可设为0（单通道）或1（多通道），通过ADON位或外部触发启动；

特点：转换完成后立即启动下一次转换，循环往复，直到CONT位清0；

适用场景：需要持续采集模拟信号（如实时温度监测、电压监控）。

## 2.2 外部触发源

ADC的转换可通过外部事件触发，无需软件持续控制，配置方式如下：

- 规则组：设置ADCx_CTLR2的EXTTRIG=1，通过EXTSEL[2:0]选择触发源（如定时器1的CC1事件、EXTI线11等）；

- 注入组：设置ADCx_CTLR2的JEXTTRIG=1，通过JEXTSEL[2:0]选择触发源（如定时器1的TRGO事件、EXTI线15等）；

- 注意：外部触发仅上升沿可启动转换。

## 2.3 模拟看门狗

模拟看门狗用于监测ADC通道的输入电压，当电压超出设定的高/低阈值时，触发AWD标志位，可配置中断提醒，步骤如下：

1. 通过ADCx_WDHTR（高阈值）和ADCx_WDLTR（低阈值）寄存器设置阈值（12位有效）；

2. 通过ADCx_CTLR1的AWDEN（规则组）、JAWDEN（注入组）、AWDSGL（单通道/所有通道）、AWDCH[4:0]（指定通道）配置警戒范围；

3. 设置AWDIE=1，开启模拟看门狗中断，当电压超出阈值时，触发中断处理。

适用场景：电压异常监测（如电池欠压、传感器故障）。

## 2.4 温度传感器与内部参考电压

CH32H417内置温度传感器（连接ADC_IN16）和内部参考电压V_REFINT（连接ADC_IN17），配置方法：

1. 设置ADCx_CTLR2的TSVREFE=1，唤醒内部通道；

2. 配置温度传感器通道（ADC_IN16）的采样时间（推荐17.1us）；

3. 启动ADC转换，读取转换数据，通过公式换算温度：

温度（℃）= （V_SENSE - V25）/ Avg_Slope + 25

说明：V25是25℃时温度传感器的输出电压，Avg_Slope是电压与温度的平均斜率，具体值参考CH32H417数据手册的电气特性章节。

## 2.5 双ADC模式

CH32H417内置2个ADC，可配置为双ADC模式，ADC1为主ADC，ADC2为从ADC，通过ADC1_CTLR1的DUALMOD[3:0]选择模式，核心模式包括：

- 独立模式：两个ADC独立工作，互不影响；

- 同步规则/注入模式：两个ADC同步触发，同时转换规则组/注入组通道；

- 快速/慢速交替模式：两个ADC交替转换同一规则通道，提高采样率；

- 交替触发模式：两个ADC交替转换注入组通道，适用于高频注入采集。

注意：双ADC模式中，仅ADC1支持DMA功能，ADC2的转换数据需通过ADC1的DMA传输。

## 2.6 DMA功能

规则组转换支持DMA功能，可自动将转换数据传输到指定存储地址，避免CPU占用，配置步骤：

1. 配置DMA控制器，指定传输源地址（ADCx_RDATAR）、目的地址（SRAM缓冲区）、传输长度；

2. 设置ADCx_CTLR2的DMA=1，开启ADC的DMA功能；

3. 启动ADC转换，转换完成后（EOC置位），硬件自动触发DMA传输。

注意：注入组转换不支持DMA功能。

## 2.7 低功耗模式

通过ADCx_CTLR2的ADC_LP位配置：

- ADC_LP=0（默认）：高功耗模式，适用于6MHz及以上采样率，要求VDD33A>3V；

- ADC_LP=1：低功耗模式，适用于2MHz以下采样率，功耗更低。

# 第三章：ADC配置步骤（实操核心）

以“单次扫描模式+规则组+DMA传输”为例，讲解CH32H417 ADC的完整配置流程（以ADC1为例，基于标准库），适用于多通道数据采集场景。

## 3.1 配置前提

- 初始化系统时钟，确保HCLK正常工作（CH32H417默认HCLK为168MHz）；

- 配置ADC通道对应的GPIO引脚（外部通道需配置为模拟输入模式，GPIO_MODE_AIN）；

- 开启ADC和DMA的时钟（RCC_APB2PeriphClockCmd(RCC_APB2Periph_ADC1, ENABLE)；RCC_AHBPeriphClockCmd(RCC_AHBPeriph_DMA1, ENABLE)）。

## 3.2 具体配置步骤

### 步骤1：配置ADC时钟

ADCCLK由HCLK分频得到，通过RCC_CFGR0的ADCPRE[1:0]配置，最大不超过80MHz，示例：

RCC_ADCCLKConfig(RCC_PCLK2_Div2); // HCLK=168MHz，ADCCLK=84MHz（略高于80MHz，实际可设为RCC_PCLK2_Div3，ADCCLK=56MHz）

### 步骤2：初始化ADC参数

1. 初始化ADC结构体（ADC_InitTypeDef），配置分辨率、数据对齐、转换模式等；

2. 配置规则组通道（如ADC_IN0、ADC_IN1），设置转换顺序和总数；

3. 配置采样时间（每个通道独立设置）。

示例代码片段：

```c
ADC_InitTypeDef ADC_InitStructure;
// ADC初始化配置
ADC_InitStructure.ADC_Mode = ADC_Mode_Independent; // 独立模式
ADC_InitStructure.ADC_ScanConvMode = ENABLE; // 开启扫描模式
ADC_InitStructure.ADC_ContinuousConvMode = DISABLE; // 单次转换模式
ADC_InitStructure.ADC_ExternalTrigConv = ADC_ExternalTrigConv_None; // 禁止外部触发，软件启动
ADC_InitStructure.ADC_DataAlign = ADC_DataAlign_Right; // 右对齐
ADC_InitStructure.ADC_NbrOfChannel = 2; // 规则组2个通道
ADC_Init(ADC1, &ADC_InitStructure);

// 配置规则组通道（ADC_IN0、ADC_IN1），转换顺序1：ADC_IN0，顺序2：ADC_IN1
ADC_RegularChannelConfig(ADC1, ADC_Channel_0, 1, ADC_SampleTime_28Cycles5); // 采样时间28.5周期
ADC_RegularChannelConfig(ADC1, ADC_Channel_1, 2, ADC_SampleTime_28Cycles5);
```

### 步骤3：配置DMA（可选）

1. 初始化DMA结构体（DMA_InitTypeDef），指定传输方向、缓冲区地址、传输长度；

2. 关联ADC1和DMA通道（ADC1的规则组对应DMA1_Channel1）；

3. 开启DMA传输。

示例代码片段：

```c
DMA_InitTypeDef DMA_InitStructure;
uint16_t ADC_Buffer[2]; // 存储2个通道的转换数据

// DMA初始化
DMA_InitStructure.DMA_PeripheralBaseAddr = (uint32_t)&ADC1->RDATAR; // 外设地址（ADC1规则数据寄存器）
DMA_InitStructure.DMA_MemoryBaseAddr = (uint32_t)ADC_Buffer; // 内存地址（缓冲区）
DMA_InitStructure.DMA_DIR = DMA_DIR_PeripheralSRC; // 外设->内存
DMA_InitStructure.DMA_BufferSize = 2; // 传输长度（2个通道）
DMA_InitStructure.DMA_PeripheralInc = DMA_PeripheralInc_Disable; // 外设地址不递增
DMA_InitStructure.DMA_MemoryInc = DMA_MemoryInc_Enable; // 内存地址递增
DMA_InitStructure.DMA_PeripheralDataSize = DMA_PeripheralDataSize_HalfWord; // 外设数据宽度16位
DMA_InitStructure.DMA_MemoryDataSize = DMA_MemoryDataSize_HalfWord; // 内存数据宽度16位
DMA_InitStructure.DMA_Mode = DMA_Mode_Circular; // 循环模式
DMA_InitStructure.DMA_Priority = DMA_Priority_Medium; // 优先级中等
DMA_InitStructure.DMA_M2M = DMA_M2M_Disable; // 禁止内存到内存传输
DMA_Init(DMA1_Channel1, &DMA_InitStructure);

// 开启DMA
DMA_Cmd(DMA1_Channel1, ENABLE);
```

### 步骤4：ADC校准（必做）

ADC上电后需进行校准，确保转换精度，步骤：

```c
// ADC上电
ADC_Cmd(ADC1, ENABLE);
// 等待ADC稳定
delay_ms(1);
// 初始化校准寄存器
ADC_ResetCalibration(ADC1);
while(ADC_GetResetCalibrationStatus(ADC1)); // 等待校准初始化完成
// 启动校准
ADC_StartCalibration(ADC1);
while(ADC_GetCalibrationStatus(ADC1)); // 等待校准完成
```

### 步骤5：启动ADC转换

开启ADC的DMA功能（若使用），启动转换：

```c
// 开启ADC DMA功能
ADC_DMACmd(ADC1, ENABLE);
// 软件启动ADC转换
ADC_SoftwareStartConvCmd(ADC1, ENABLE);
```

### 步骤6：读取转换数据

DMA传输完成后，直接读取缓冲区数据；若未使用DMA，需等待EOC标志位置1后，读取ADCx_RDATAR寄存器：

```c
// 方法1：DMA方式（推荐）
while(DMA_GetFlagStatus(DMA1_FLAG_TC1) == RESET); // 等待DMA传输完成
DMA_ClearFlag(DMA1_FLAG_TC1); // 清除传输完成标志
uint16_t adc_val0 = ADC_Buffer[0]; // ADC_IN0转换值
uint16_t adc_val1 = ADC_Buffer[1]; // ADC_IN1转换值

// 方法2：非DMA方式
while(ADC_GetFlagStatus(ADC1, ADC_FLAG_EOC) == RESET); // 等待转换完成
uint16_t adc_val = ADC_GetConversionValue(ADC1); // 读取转换值
```

# 第四章：实操注意事项（避坑重点）

- 校准注意：启动校准前，ADC必须上电（ADON=1）且稳定至少2个ADCCLK周期；校准期间，采样时间至少1us；

- 通道配置：转换期间修改ADCx_RSQRx或ADCx_ISQR寄存器，会终止当前转换，需重新启动；

- 触发注意：外部触发仅上升沿有效，触发间隔需大于转换总时间，避免触发丢失；

- 双ADC模式：主从ADC的外部触发需配置正确，从ADC需设为软件触发，避免误触发；

- 低功耗注意：低功耗模式仅适用于2MHz以下采样率，且需确保VDD33A电压符合要求；

- 采样时间：采样率高于1MHz时，采样时间不建议小于3.5个ADCCLK周期，避免采样精度下降；

- 温度传感器：上电后需等待建立时间，可同时设置ADON和TSVREFE位，缩短等待时间。

# 第五章：常用寄存器速查（重点寄存器）

CH32H417的ADC寄存器较多，以下列出实操中最常用的寄存器，详细位定义参考手册：

## 5.1 控制寄存器

- ADCx_CTLR1（控制寄存器1）：配置扫描模式（SCAN）、间断模式（DISCEN/JDISCEN）、双ADC模式（DUALMOD）、模拟看门狗（AWDEN/JAWDEN）等；

- ADCx_CTLR2（控制寄存器2）：配置ADON（ADC上电）、CONT（连续转换）、ALIGN（数据对齐）、DMA（DMA使能）、TSVREFE（内部通道使能）、外部触发（EXTTRIG/JEXTTRIG）等。

## 5.2 采样时间配置寄存器

- ADCx_SAMPTR1：配置ADC_IN8~ADC_IN17的采样时间；

- ADCx_SAMPTR2：配置ADC_IN0~ADC_IN7的采样时间。

## 5.3 序列配置寄存器

- ADCx_RSQR1~ADCx_RSQR3：配置规则组通道的转换顺序和总数；

- ADCx_ISQR：配置注入组通道的转换顺序和总数。

## 5.4 数据寄存器

- ADCx_RDATAR：规则组转换数据寄存器（双模式下，高16位存储ADC2数据）；

- ADCx_IDATAR1~ADCx_IDATAR4：注入组转换数据寄存器。

## 5.5 看门狗阈值寄存器

- ADCx_WDHTR：模拟看门狗高阈值寄存器（12位有效）；

- ADCx_WDLTR：模拟看门狗低阈值寄存器（12位有效）。

# 第六章：常见问题排查

1. 转换数据为0或固定值：
        

    - 排查GPIO引脚是否配置为模拟输入模式；

    - 检查ADC是否上电、校准是否完成；

    - 确认通道配置正确，未混淆规则组和注入组。

2. 转换数据波动过大：


    - 增加采样时间，降低采样率；

    - 检查输入信号是否稳定，增加滤波电路；

    - 重新执行ADC校准，确保校准成功。

3. DMA传输失败：
        

    - 检查DMA通道是否正确关联（ADC1规则组对应DMA1_Channel1）；

    - 确认DMA缓冲区地址、传输长度配置正确；

    - 检查ADC的DMA功能是否开启（ADC_DMACmd）。

4. 外部触发无法启动转换：
        

    - 检查EXTTRIG/JEXTTRIG位是否置1；

    - 确认触发源配置正确（EXTSEL/JEXTSEL）；

    - 检查触发信号是否为上升沿，触发间隔是否足够。

# 总结

CH32H417系列ADC的核心优势的是高分辨率、多通道、多模式、低功耗，掌握其使用方法的关键的是：理解规则组与注入组的区别、熟练配置转换模式、做好校准和时钟配置。本教程覆盖了从基础认知到实操配置、问题排查的全流程，可作为嵌入式开发中ADC应用的参考手册。

实际开发中，可根据具体场景（如采样率、通道数量、功耗要求）灵活选择转换模式和配置参数，结合DMA功能减少CPU占用，提升系统效率。如需更复杂的应用（如双ADC同步采集、模拟看门狗中断处理），可结合手册进一步深入研究。
