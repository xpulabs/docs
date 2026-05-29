


          
我来帮你解析 `EXAM/HSADC/HSADC` 例子并编写一个完整的 HSADC 教程。首先让我查看这个项目的代码结构。


        
            
toolName: file_search
            
status: success
          
          
让我读取主要的源代码文件来解析这个 HSADC 例子。



        
            
toolName: view_files
            
status: success
          
            
filePath: /data/programming/wch/ch32h417_sdk15/EXAM/HSADC/HSADC/V5F/User/main.c
          

        
            
toolName: view_files
            
status: success
          
            
filePath: /data/programming/wch/ch32h417_sdk15/EXAM/HSADC/HSADC/Common/hardware.c
          

        
            
toolName: view_files
            
status: success
          
            
filePath: /data/programming/wch/ch32h417_sdk15/EXAM/HSADC/HSADC/Common/hardware.h
          
# CH32H417 HSADC（高速ADC）教程

## 一、HSADC 概述

### 1.1 什么是 HSADC

**HSADC（High-Speed ADC）** 是 CH32H417 内置的高速模数转换器，具有以下特点：

| 特性 | 参数 |
|------|------|
| 分辨率 | 12位 |
| 最大采样率 | 1MSPS（每秒百万次采样） |
| 通道数 | 4个模拟输入通道 |
| 工作模式 | 突发模式（Burst Mode） |
| 数据传输 | DMA 双缓冲 |

### 1.2 与普通 ADC 的区别

| 对比项 | 普通 ADC | HSADC |
|--------|----------|-------|
| 采样速度 | 最高 36MHz | 最高 1MSPS |
| 工作模式 | 规则/注入通道 | 突发模式 |
| 数据传输 | 中断/轮询 | DMA 双缓冲 |
| 适用场景 | 普通精度采集 | 高速数据采集 |

---

## 二、硬件连接

### 2.1 引脚分配

| 通道 | 引脚 | 功能描述 |
|------|------|----------|
| HSADC_CH0 | PC0 | 高速模拟输入通道0 |
| HSADC_CH1 | PC1 | 高速模拟输入通道1 |
| HSADC_CH2 | PC2 | 高速模拟输入通道2 |
| HSADC_CH3 | PC3 | 高速模拟输入通道3 |

### 2.2 电路示意图

```
          [模拟信号源]
              ↓
          ┌───────┐
          │  PC0  │←── HSADC_CH0
          │ CH32H │
          │  417  │
          │  HSADC│
          └───────┘
```

---

## 三、核心工作原理

### 3.1 突发模式（Burst Mode）流程

```
┌─────────────────────────────────────────────────────────────┐
│                   HSADC 突发模式流程                        │
├─────────────────────────────────────────────────────────────┤
│  软件触发  →  连续采样N个数据  →  DMA传输  →  BurstEnd中断   │
│               (BurstMode_TransferLen)                      │
│                      ↓                                     │
│            重复上述过程直到完成                              │
│            (DMA_TransferLen 指定总长度)                     │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 DMA 双缓冲机制

HSADC 支持 **双缓冲模式**，当一个缓冲区满时自动切换到另一个缓冲区，实现无缝数据传输：

```
┌──────────────┐         ┌──────────────┐
│   Buffer 0   │←──┐   ┌→│   Buffer 1   │
│  (txbuf)     │   │   │  │  (txbuf1)    │
└──────────────┘   │   │  └──────────────┘
     ↑             │   │        ↑
     │             │   │        │
     └─────────────┴───┴────────┘
              DMA 交替传输
```

---

## 四、代码详解

### 4.1 数据缓冲区定义

```c
__attribute__((aligned(32))) u16 txbuf[1024];
__attribute__((aligned(32))) u16 txbuf1[1024];
```

- `__attribute__((aligned(32)))`：确保缓冲区按32字节对齐，满足DMA传输要求
- `txbuf` 和 `txbuf1`：双缓冲数组，各1024个元素

### 4.2 HSADC 初始化（核心）

```c
void HSADC_Function_Init(void)
{
    HSADC_InitTypeDef HSADC_InitStructure = {0};
    GPIO_InitTypeDef GPIO_InitStructure = {0};
    
    // 1. 使能时钟
    RCC_HB2PeriphClockCmd(RCC_HB2Periph_GPIOC | RCC_HB2Periph_HSADC, ENABLE);
    RCC_HSADCCLKConfig(RCC_HSADCSource_PLLCLK);  // 选择PLL作为HSADC时钟源

    // 2. 配置PC0为模拟输入
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_0;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_AIN;
    GPIO_Init(GPIOC, &GPIO_InitStructure);

    // 3. HSADC核心配置
    HSADC_InitStructure.HSADC_BurstMode = ENABLE;  // 使能突发模式
    HSADC_InitStructure.HSADC_DMA_TransferLen = 255;  // DMA总传输长度
    HSADC_InitStructure.HSADC_BurstMode_TransferLen = 3;  // 每次突发传输长度
    HSADC_InitStructure.HSADC_BurstMode_DMA_LastTransferLen = 16;  // 最后一次传输长度
    
    HSADC_InitStructure.HSADC_ClockDivision = 3;  // 时钟分频
    HSADC_InitStructure.HSADC_DMA = ENABLE;       // 使能DMA
    HSADC_InitStructure.HSADC_RxAddress0 = (u32)txbuf;   // 缓冲区0地址
    HSADC_InitStructure.HSADC_RxAddress1 = (u32)txbuf1;  // 缓冲区1地址
    
    HSADC_InitStructure.HSADC_DualBuffer = ENABLE;  // 使能双缓冲
    HSADC_InitStructure.HSADC_FirstConversionCycle = HSADC_First_Conversion_Cycle_8;
    HSADC_InitStructure.HSADC_DataSize = HSADC_DataSize_16b;  // 数据宽度16位
    HSADC_Init(&HSADC_InitStructure);

    // 4. 使能相关功能
    HSADC_BurstEndCmd(ENABLE);  // 使能突发结束功能
    HSADC_Cmd(ENABLE);          // 使能HSADC
    HSADC_ChannelConfig(HSADC_Channel_0);  // 选择通道0

    // 5. 中断配置
    NVIC_EnableIRQ(HSADC_IRQn);
    NVIC_SetPriority(HSADC_IRQn, 2);
    HSADC_ITConfig(HSADC_IT_BurstEnd, ENABLE);  // 使能突发结束中断
}
```

### 4.3 关键参数说明

| 参数 | 示例值 | 说明 |
|------|--------|------|
| `HSADC_BurstMode` | ENABLE | 使能突发模式 |
| `HSADC_DMA_TransferLen` | 255 | DMA总传输长度（单位：突发次数） |
| `HSADC_BurstMode_TransferLen` | 3 | 每次突发采样数 |
| `HSADC_BurstMode_DMA_LastTransferLen` | 16 | 最后一次突发采样数 |
| `HSADC_ClockDivision` | 3 | 时钟分频系数 |
| `HSADC_DualBuffer` | ENABLE | 使能双缓冲 |

### 4.4 主函数调用

```c
void Hardware(void)
{
    u16 i = 0;
    HSADC_Function_Init();       // 初始化HSADC
    HSADC_SoftwareStartConvCmd(ENABLE);  // 软件触发开始转换
    
    while(HS_FLAG == 0) {        // 等待BurstEnd中断
    } 
    
    // 打印缓冲区1数据（512个）
    for(i = 0; i < 512; i++) {
        printf("Addre1_dat %d\r\n", txbuf1[i]);
        Delay_Ms(10);
    }
    
    // 打印缓冲区0数据（528个）
    for(i = 0; i < 528; i++) {
        printf("Addre0_dat %d\r\n", txbuf[i]);
        Delay_Ms(10);
    }
    
    while(1);
}
```

### 4.5 中断服务函数

```c
void HSADC_IRQHandler()
{
    if(HSADC_GetITStatus(HSADC_IT_BurstEnd)) {
        HS_FLAG = 1;  // 设置标志位，表示采样完成
    }
    HSADC_ClearITPendingBit(HSADC_IT_BurstEnd);  // 清除中断标志
}
```

---

## 五、工作流程分析

### 5.1 采样过程计算

根据示例配置：
- `HSADC_DMA_TransferLen = 255`（总突发次数）
- `HSADC_BurstMode_TransferLen = 3`（正常突发采样数）
- `HSADC_BurstMode_DMA_LastTransferLen = 16`（最后突发采样数）

**总采样数计算：**
```
总采样数 = (255 - 1) × 3 + 16 = 254 × 3 + 16 = 762 + 16 = 778
```

**缓冲区分配：**
- Buffer 0 (txbuf)：528 个数据
- Buffer 1 (txbuf1)：512 个数据

### 5.2 时序图

```
时间轴 →
    │
    ├─ 软件触发
    │
    ├─ 突发1: 采样3个 → DMA到Buffer0
    ├─ 突发2: 采样3个 → DMA到Buffer1
    ├─ 突发3: 采样3个 → DMA到Buffer0
    ├─ ... (重复)
    │
    ├─ 突发255: 采样16个 → DMA到Buffer0
    │
    └─ 产生BurstEnd中断
```

---

## 六、配置要点

### 6.1 时钟配置

```c
RCC_HSADCCLKConfig(RCC_HSADCSource_PLLCLK);
```

HSADC 支持多种时钟源：

| 时钟源 | 宏定义 | 说明 |
|--------|--------|------|
| PLL时钟 | `RCC_HSADCSource_PLLCLK` | 最高采样率 |
| HSI | `RCC_HSADCSource_HSI` | 内部高速时钟 |
| HSE | `RCC_HSADCSource_HSE` | 外部高速时钟 |

### 6.2 通道选择

```c
HSADC_ChannelConfig(HSADC_Channel_0);
```

支持4个通道：
- `HSADC_Channel_0`（PC0）
- `HSADC_Channel_1`（PC1）
- `HSADC_Channel_2`（PC2）
- `HSADC_Channel_3`（PC3）

### 6.3 首次转换周期

```c
HSADC_InitStructure.HSADC_FirstConversionCycle = HSADC_First_Conversion_Cycle_8;
```

| 周期选项 | 说明 |
|----------|------|
| `HSADC_First_Conversion_Cycle_8` | 首次转换8个周期 |
| `HSADC_First_Conversion_Cycle_16` | 首次转换16个周期 |
| `HSADC_First_Conversion_Cycle_32` | 首次转换32个周期 |
| `HSADC_First_Conversion_Cycle_64` | 首次转换64个周期 |

---

## 七、常见问题解答

### Q1：为什么使用双缓冲？

**A**：双缓冲允许在一个缓冲区被读取的同时，另一个缓冲区继续接收数据，避免数据丢失，实现连续高速采集。

### Q2：采样率如何计算？

**A**：采样率 = HSADC时钟频率 / (时钟分频 × 转换周期)

### Q3：BurstEnd中断何时触发？

**A**：当完成 `HSADC_DMA_TransferLen` 指定的突发次数后触发。

### Q4：如何选择合适的缓冲区大小？

**A**：缓冲区大小应根据采样率和处理速度来确定，确保在下次DMA传输完成前能处理完当前缓冲区数据。

---

## 八、实践建议

1. **电源稳定性**：HSADC对电源噪声敏感，建议使用独立的模拟电源并添加去耦电容
2. **信号调理**：输入信号应进行适当滤波，避免高频噪声
3. **DMA优化**：确保缓冲区按32字节对齐，提高DMA效率
4. **中断优先级**：HSADC中断应设置较高优先级，避免数据丢失
5. **多通道采集**：可轮流切换通道实现多通道高速采集

---

## 九、总结

本教程基于 `EXAM/HSADC/HSADC` 示例，详细讲解了 CH32H417 HSADC 的使用方法：

1. **初始化流程**：时钟配置 → GPIO配置 → HSADC参数配置 → DMA配置 → 中断配置
2. **核心模式**：突发模式 + DMA双缓冲
3. **数据读取**：通过BurstEnd中断判断采样完成，然后读取双缓冲区数据

HSADC 适用于需要 **高速、连续采样** 的应用场景，如音频采集、高速数据采集系统等。
        
