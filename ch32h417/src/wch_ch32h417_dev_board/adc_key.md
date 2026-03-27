# ADC按键

## 1. 文件概述

`hardware.c` 是一个用于 **ADC 定时器触发采样** 的硬件测试程序，通过 CH32H417 的定时器和 ADC 外设实现定时触发的模拟信号采样功能。

- **作者**: WCH (Nanjing Qinheng Microelectronics Co., Ltd.)
- **版本**: V1.0.0
- **日期**: 2025/03/01
- **功能**: 实现定时器触发的 ADC 采样功能，包括定时器 PWM 配置、ADC 初始化和中断处理

## 2. 核心功能模块

### 2.1 全局变量定义

```c
u16 ADC_val;
```
- 定义了一个 16 位无符号整数，用于存储 ADC 采样的结果值

### 2.2 ADC 初始化函数 (ADC_Function_Init)

**功能**: 初始化 ADC1 为定时器触发的注入通道采样模式

```c
void ADC_Function_Init(void)
```

**执行流程**:

1. **时钟配置**:
   ```c
   RCC_HB2PeriphClockCmd(RCC_HB2Periph_ADC1|RCC_HB2Periph_GPIOA, ENABLE );
   RCC_ADCCLKConfig(RCC_ADCCLKSource_HCLK);
   RCC_ADCHCLKCLKAsSourceConfig(RCC_PPRE2_DIV4,RCC_HCLK_ADCPRE_DIV8);
   ```
   - 启用 ADC1 和 GPIOA 时钟
   - 配置 ADC 时钟源为 HCLK
   - 设置 ADC 时钟预分频：APB2 预分频为 4，HCLK ADC 预分频为 8

2. **GPIO 配置**:
   ```c
   GPIO_InitStructure.GPIO_Pin = GPIO_Pin_0;
   GPIO_InitStructure.GPIO_Mode = GPIO_Mode_AIN;
   GPIO_Init(GPIOA, &GPIO_InitStructure);
   ```
   - 配置 PA0 为模拟输入模式 (AIN)，作为 ADC 通道 0 的采样引脚

3. **ADC 基本配置**:
   ```c
   ADC_InitStructure.ADC_Mode = ADC_Mode_Independent;
   ADC_InitStructure.ADC_ScanConvMode = DISABLE;
   ADC_InitStructure.ADC_ContinuousConvMode = DISABLE;
   ADC_InitStructure.ADC_ExternalTrigConv = ADC_ExternalTrigInjecConv_None;
   ADC_InitStructure.ADC_DataAlign = ADC_DataAlign_Right;
   ADC_InitStructure.ADC_NbrOfChannel = 1;
   ADC_Init(ADC1, &ADC_InitStructure);
   ADC_LowPowerModeCmd(ADC1, ENABLE);
   ```
   - 配置为独立模式，单通道采样
   - 禁用扫描模式和连续转换模式
   - 右对齐数据
   - 启用低功耗模式

4. **ADC 注入通道配置**:
   ```c
   ADC_ExternalTrigInjectedConvConfig(ADC1, ADC_ExternalTrigInjecConv_T2_CC1);  
   ADC_InjectedSequencerLengthConfig(ADC1, 1);
   ADC_InjectedChannelConfig(ADC1, ADC_Channel_0, 1, ADC_SampleTime_CyclesMode5);
   ADC_ExternalTrigInjectedConvCmd(ADC1, ENABLE);
   ```
   - 配置注入通道外部触发源为 TIM2_CC1
   - 注入通道序列长度为 1
   - 配置通道 0 为注入通道 1，采样时间为模式 5（最长采样时间）
   - 启用注入通道外部触发转换

5. **中断配置**:
   ```c
   NVIC_EnableIRQ(ADC1_2_IRQn);
   NVIC_SetPriority(ADC1_2_IRQn, 0);
   ADC_ITConfig(ADC1, ADC_IT_JEOC, ENABLE);
   ```
   - 启用 ADC1_2 中断
   - 设置最高中断优先级 (0)
   - 启用注入通道转换结束中断

6. **ADC 校准**:
   ```c
   ADC_ResetCalibration(ADC1);
   while(ADC_GetResetCalibrationStatus(ADC1));
   ADC_StartCalibration(ADC1);
   while(ADC_GetCalibrationStatus(ADC1));
   ADC_BufferCmd(ADC1, DISABLE);
   ```
   - 执行 ADC 校准
   - 禁用 ADC 缓冲模式

### 2.3 定时器 PWM 初始化函数 (TIM1_PWM_In)

**功能**: 初始化 TIM2 为 PWM 模式，用于触发 ADC 采样

```c
void TIM1_PWM_In(u16 arr, u16 psc, u16 ccp)
```
- `arr`: 自动重载值
- `psc`: 预分频器值
- `ccp`: 捕获比较值 (PWM 占空比)

**执行流程**:

```c
RCC_HB1PeriphClockCmd(RCC_HB1Periph_TIM2, ENABLE);

TIM_TimeBaseInitStructure.TIM_Period = arr;
TIM_TimeBaseInitStructure.TIM_Prescaler = psc;
TIM_TimeBaseInitStructure.TIM_ClockDivision = TIM_CKD_DIV1;
TIM_TimeBaseInitStructure.TIM_CounterMode = TIM_CounterMode_Up;
TIM_TimeBaseInit(TIM2, &TIM_TimeBaseInitStructure);

TIM_OCInitStructure.TIM_OCMode = TIM_OCMode_PWM1;
TIM_OCInitStructure.TIM_OutputState = TIM_OutputState_Enable;
TIM_OCInitStructure.TIM_Pulse = ccp;
TIM_OCInitStructure.TIM_OCPolarity = TIM_OCPolarity_Low;
TIM_OC1Init(TIM2, &TIM_OCInitStructure);

TIM_CtrlPWMOutputs(TIM2, ENABLE);
TIM_OC1PreloadConfig(TIM2, TIM_OCPreload_Disable);
TIM_ARRPreloadConfig(TIM2, ENABLE);
TIM_SelectOutputTrigger(TIM2, TIM_TRGOSource_Update);
TIM_Cmd(TIM2, ENABLE);
```

- 启用 TIM2 时钟
- 配置定时器基本参数：向上计数模式，预分频值和自动重载值
- 配置 PWM 模式：PWM1 模式，低极性
- 启用 TIM2 PWM 输出
- 配置更新事件作为触发源
- 启用 TIM2

### 2.4 主函数 (Hardware)

**功能**: 初始化定时器和 ADC，启动整个系统

```c
void Hardware(void)
{
    TIM1_PWM_In(7200, 1000-1, 3600);
    ADC_Function_Init();  
}
```

- 调用 `TIM1_PWM_In` 函数初始化 TIM2，参数配置：
  - 自动重载值: 7200
  - 预分频值: 999 (1000-1)
  - PWM 占空比: 50% (3600/7200)
- 调用 `ADC_Function_Init` 函数初始化 ADC1

### 2.5 ADC 中断处理函数 (ADC1_2_IRQHandler)

**功能**: 处理 ADC1 注入通道转换结束中断

```c
void ADC1_2_IRQHandler()
{
    if(ADC_GetITStatus( ADC1, ADC_IT_JEOC)){
        printf("ADC Extline trigger conversion...\r\n");
        ADC_val = ADC_GetInjectedConversionValue(ADC1, ADC_InjectedChannel_1);
        printf("JADC %04d\r\n", ADC_val);
    }

    ADC_ClearITPendingBit( ADC1, ADC_IT_JEOC);
}
```

- 检查注入通道转换结束中断标志
- 如果中断发生，打印采样信息
- 获取注入通道 1 的采样值并存储到 `ADC_val`
- 打印采样结果
- 清除中断标志位

## 3. 工作原理与时序分析

### 3.1 系统工作流程

1. **初始化阶段**:
   - `Hardware` 函数首先调用 `TIM1_PWM_In` 初始化 TIM2 为 PWM 模式
   - 然后调用 `ADC_Function_Init` 初始化 ADC1 为定时器触发的注入通道采样模式

2. **运行阶段**:
   - TIM2 以 PWM 模式运行，产生周期性的触发信号
   - 当 TIM2_CC1 事件发生时，触发 ADC1 注入通道采样
   - ADC 完成采样后，产生注入通道转换结束中断
   - 中断处理函数读取采样值并打印结果

### 3.2 关键时序参数计算

假设系统时钟 HCLK 为 72MHz：

1. **TIM2 时钟频率**:
   - HCLK = 72MHz
   - 预分频值 psc = 1000-1 = 999
   - TIM2 时钟 = HCLK / (psc + 1) = 72MHz / 1000 = 72kHz

2. **PWM 周期**:
   - 自动重载值 arr = 7200
   - PWM 周期 = arr / TIM2 时钟 = 7200 / 72kHz = 100ms
   - PWM 频率 = 1 / 100ms = 10Hz

3. **ADC 采样频率**:
   - ADC 采样由 TIM2_CC1 事件触发
   - 采样频率等于 PWM 频率，即 10Hz (每 100ms 采样一次)

4. **ADC 采样时间**:
   - 配置为 ADC_SampleTime_CyclesMode5，这是最长的采样时间模式
   - 确保了更高的采样精度

## 4. 与其他 ADC 应用的对比

| 特性 | mio_adc_timer | 普通 ADC 应用 |
|------|---------------|---------------|
| 触发方式 | 定时器触发 | 软件触发或连续转换 |
| 采样频率 | 固定频率 (10Hz) | 灵活配置或连续 |
| 功耗特性 | 低功耗模式 | 正常模式 |
| 精度优先级 | 高 (长采样时间) | 根据需求调整 |
| 中断处理 | 注入通道中断 | 规则通道中断 |

## 5. 代码优化建议

### 5.1 增加采样频率配置

```c
// 增加采样频率配置参数
void TIM1_PWM_In(u16 sample_rate)
{
    u32 timer_clock = 72000000 / 1000;  // 72kHz
    u16 arr = timer_clock / sample_rate;
    u16 ccp = arr / 2;  // 50% duty cycle
    
    // 保留原有初始化代码...
}
```

### 5.2 使用宏定义简化配置

```c
// 采样参数宏定义
#define SAMPLE_FREQUENCY   10      // Hz
#define TIMER_PRESCALER    999     // 72MHz / (999+1) = 72kHz
#define PWM_PERIOD         (72000 / SAMPLE_FREQUENCY)  // 72kHz / 10Hz = 7200
#define PWM_DUTY_CYCLE     (PWM_PERIOD / 2)  // 50% duty cycle
```

### 5.3 增加采样结果处理

```c
// 在中断处理函数中增加数据处理
void ADC1_2_IRQHandler()
{
    if(ADC_GetITStatus(ADC1, ADC_IT_JEOC)){
        ADC_val = ADC_GetInjectedConversionValue(ADC1, ADC_InjectedChannel_1);
        
        // 增加数据处理，如平均值计算、阈值判断等
        static u16 adc_sum = 0;
        static u8 sample_count = 0;
        adc_sum += ADC_val;
        sample_count++;
        
        if(sample_count >= 10) {  // 每10个样本计算一次平均值
            u16 avg_val = adc_sum / sample_count;
            printf("Avg ADC: %04d\r\n", avg_val);
            adc_sum = 0;
            sample_count = 0;
        }
    }
    ADC_ClearITPendingBit(ADC1, ADC_IT_JEOC);
}
```

### 5.4 增加错误处理

```c
// 在初始化函数中增加错误检查
if(ADC_GetCalibrationStatus(ADC1) != 0) {
    // 校准失败处理
    printf("ADC Calibration Failed!\r\n");
}
```

## 6. 总结

这个程序实现了基于 CH32H417 的定时器触发 ADC 采样功能，主要特点：

1. **定时器触发**: 使用 TIM2 PWM 信号触发 ADC 采样，确保采样频率精确可控

2. **注入通道模式**: 利用 ADC 注入通道功能，实现外部事件触发的高精度采样

3. **低功耗设计**: 启用 ADC 低功耗模式，降低系统功耗

4. **中断处理**: 通过中断方式处理采样结果，提高系统响应性

5. **高精度采样**: 使用最长的采样时间模式，确保采样精度

该程序展示了如何结合定时器和 ADC 外设实现定时触发的模拟信号采样功能，适用于需要精确控制采样频率的应用场景，如数据采集系统、传感器信号处理等。
        