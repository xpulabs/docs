# WS2812B

## 1. 文件概述

`hardware.c` 是一个用于 **WS2812B RGB LED 控制** 的硬件测试程序，通过 CH32H417 的 PIOC（可编程 I/O 控制器）接口实现 WS2812B LED 灯带的控制。

- **作者**: WCH (Nanjing Qinheng Microelectronics Co., Ltd.)
- **版本**: V1.0.0
- **日期**: 2025/03/01
- **功能**: 初始化 PIOC 接口并实现 WS2812B LED 灯带的颜色显示与切换

## 2. 核心功能模块

### 2.1 RGB 颜色数据缓冲区

```c
u8 RGBpbuf[] = {
    0x00, 0x00, 0xFF,  // LED1: Blue
    0xFF, 0x00, 0x00,  // LED2: Red
    0x00, 0xFF, 0x00,  // LED3: Green
    0x00, 0x00, 0xFF,  // LED4: Blue
    0xFF, 0x00, 0x00,  // LED5: Red
    0x00, 0xFF, 0x00,  // LED6: Green
    0x00, 0x00, 0xFF,  // LED7: Blue
    0xFF, 0x00, 0x00,  // LED8: Red
};

u8 RGBpbuf1[] = {
    0xFF, 0x00, 0x00,  // LED1: Red
    0x00, 0xFF, 0x00,  // LED2: Green
    0x00, 0x00, 0xFF,  // LED3: Blue
    0xFF, 0x00, 0x00,  // LED4: Red
    0x00, 0xFF, 0x00,  // LED5: Green
    0x00, 0x00, 0xFF,  // LED6: Blue
    0xFF, 0x00, 0x00,  // LED7: Red
    0x00, 0xFF, 0x00,  // LED8: Green
};

u8 RGBpbuf2[] = {
    0xFF, 0x00, 0x00,  // LED1: Red
    0x00, 0xFF, 0x00,  // LED2: Green
    0x00, 0x00, 0xFF,  // LED3: Blue
    0xFF, 0x00, 0x00,  // LED4: Red
    0x00, 0xFF, 0x00,  // LED5: Green
    0x00, 0x00, 0xFF,  // LED6: Blue
    0xFF, 0x00, 0x00,  // LED7: Red
    0x00, 0xFF, 0x00,  // LED8: Green
};
```

- 定义了三个不同的 RGB 颜色缓冲区，每个缓冲区包含 8 个 WS2812B LED 的颜色数据
- 每个 LED 需要 3 个字节数据：红(R)、绿(G)、蓝(B)，共 24 字节
- 三个缓冲区定义了不同的颜色序列模式

### 2.2 全局配置定义

```c
#define     rgb_source_addr         ((uint8_t *)RGBpbuf2)
#define     rgb_data_bytes          sizeof(RGBpbuf2)  // 8 RGB LEDs, 24 bytes data
#define     timer_to_run            1               // start by timer
```

- `rgb_source_addr`: 默认使用 RGBpbuf2 作为数据源
- `rgb_data_bytes`: RGB 数据总字节数 (24 字节，对应 8 个 LED)
- `timer_to_run`: 定时器运行模式开关 (1=启用定时器触发)

### 2.3 主函数 (Hardware)

**功能**: 初始化硬件并实现 WS2812B LED 控制的主循环

```c
void Hardware(void)
```

**执行流程**:

1. **初始化与配置**:
   ```c
   printf("MIO WS2812B TEST\r\n");
   
   RCC_HB1PeriphClockCmd(RCC_HB1Periph_PWR, ENABLE);
   PWR_VIO18ModeCfg(PWR_VIO18CFGMODE_SW);
   PWR_VIO18LevelCfg(PWR_VIO18Level_MODE3);    // PWR_VIO18Level_MODE3 = 3.3V
   Delay_Ms(100);
   
   RGB1W_Init();
   stat = 0x80;    //free
   ```
   - 打印测试信息
   - 配置电源管理：启用 PWR 时钟，设置 VIO18 电压为 3.3V
   - 初始化 WS2812B 控制接口
   - 设置状态变量为 0x80 (空闲状态)

2. **主循环**:
   ```c
   while (1) {
       total_bytes = rgb_data_bytes;
       
       Delay_Ms(200);
       stat = 0x80;                //free
       if (stat != 0xFF) {         //RGB1W completed
           if (stat < 0x80) {      //got status in interrupt
               if (stat == RGB1W_ERR_OK) 
                   printf("1-wire finished\r\n");
               else 
                   printf("1-wire error %02x\r\n", stat);
               stat = 0x80;    //free
           }
           if (stat == 0x80 && total_bytes && timer_to_run) {    //RAM mode for 1~3072 bytes data
               stat = 0xFF;    //wait
               if (t1 == 0) {
                   t1 = 1;
                   RGB_RAM = RGBpbuf;
               } else if (t1 == 1) {
                   t1 = 2;
                   RGB_RAM = RGBpbuf1;
               } else if (t1 == 2) {
                   t1 = 0;
                   RGB_RAM = RGBpbuf2;
               }
               
               RGB1W_SendRAM(total_bytes, RGB_RAM, 1);
               total_bytes = 0;
           }
       }
       if (PIOC->D8_SYS_CFG & RB_INT_REQ) {  //query if disable interrupt
           stat = PIOC->D8_CTRL_RD;            //auto remove interrupt request after reading
       }
   }
   ```
   - 每隔 200ms 执行一次 RGB 数据更新
   - 循环使用三个不同的 RGB 缓冲区 (RGBpbuf → RGBpbuf1 → RGBpbuf2 → 重复)
   - 使用 `RGB1W_SendRAM` 函数发送 RGB 数据到 LED 灯带
   - 处理传输状态和可能的错误
   - 检查 PIOC 中断状态

## 3. WS2812B 控制原理

WS2812B 是一种智能 RGB LED，采用单总线协议，具有以下特点：

1. **通信协议**:
   - 单根数据线 (DI)
   - 每个 LED 包含红、绿、蓝三个 8 位颜色通道
   - 采用归零码 (NRZ) 编码方式
   - 严格的时序要求：
     - 逻辑 1: 0.8μs 高电平 + 0.45μs 低电平
     - 逻辑 0: 0.4μs 高电平 + 0.85μs 低电平
     - 重置信号: 大于 50μs 低电平

2. **控制实现**:
   - 利用 CH32H417 的 PIOC (Programmable I/O Controller) 外设
   - PIOC 提供精确的硬件时序控制，避免软件实现的时序误差
   - 支持 RAM 模式和 SFR 模式发送数据
   - RAM 模式适合发送较长数据 (1~3072 字节)
   - SFR 模式适合发送较短数据 (1~32 字节)

## 4. 关键技术点分析

### 4.1 电源配置

```c
RCC_HB1PeriphClockCmd(RCC_HB1Periph_PWR, ENABLE);
PWR_VIO18ModeCfg(PWR_VIO18CFGMODE_SW);
PWR_VIO18LevelCfg(PWR_VIO18Level_MODE3);    // PWR_VIO18Level_MODE3 = 3.3V
Delay_Ms(100);
```

- 配置 VIO18 为 3.3V，确保 WS2812B 获得正确的工作电压
- WS2812B 通常工作在 3.5-5.3V，但 3.3V 也能正常工作

### 4.2 RGB 数据发送机制

```c
if (stat == 0x80 && total_bytes && timer_to_run) {    //RAM mode for 1~3072 bytes data
    stat = 0xFF;    //wait
    // 切换 RGB 缓冲区
    RGB1W_SendRAM(total_bytes, RGB_RAM, 1);
    total_bytes = 0;
}
```

- 使用 RAM 模式发送数据，适合批量发送多个 LED 的颜色信息
- 发送前检查状态，确保上一次发送完成
- 发送完成后将 `total_bytes` 清零

### 4.3 状态管理

```c
if (stat < 0x80) {      //got status in interrupt
    if (stat == RGB1W_ERR_OK) 
        printf("1-wire finished\r\n");
    else 
        printf("1-wire error %02x\r\n", stat);
    stat = 0x80;    //free
}
```

- 状态变量 `stat` 用于跟踪 WS2812B 数据发送状态
- 0x80: 空闲状态
- 0xFF: 等待状态
- <0x80: 中断返回的状态码
- RGB1W_ERR_OK: 发送成功

## 5. 与其他 GPIO 应用的对比

| 特性 | mio_pioc_ws2812b | mio_gpio_test | mio_gpio_exti |
|------|------------------|---------------|---------------|
| 控制对象 | WS2812B LED 灯带 | 普通 LED | 普通 LED |
| 通信协议 | 单总线 (1-Wire) | 普通 GPIO 输出 | 外部中断 |
| 时序要求 | 极高 (微秒级) | 低 | 中 |
| 硬件依赖 | PIOC 外设 | 通用 GPIO | 通用 GPIO + EXTI |
| 数据量 | 批量数据 (RGB 序列) | 单个状态 | 单个状态 |

## 6. 代码优化建议

### 6.1 增加颜色效果函数

可以增加一些颜色效果生成函数，如彩虹渐变、呼吸灯等：

```c
void generateRainbowEffect(uint8_t* buffer, uint8_t num_leds, uint8_t offset) {
    for (uint8_t i = 0; i < num_leds; i++) {
        uint8_t hue = (i * 32 + offset) % 256;
        // HSL to RGB conversion
        buffer[i*3] = ...;  // R
        buffer[i*3+1] = ...;  // G
        buffer[i*3+2] = ...;  // B
    }
}
```

### 6.2 使用定时器中断优化

可以使用定时器中断代替延迟函数，提高系统响应性：

```c
void TIM2_IRQHandler(void) {
    if (TIM_GetITStatus(TIM2, TIM_IT_Update) != RESET) {
        // 发送 RGB 数据
        RGB1W_SendRAM(total_bytes, current_buffer, 1);
        // 切换缓冲区
        // ...
        TIM_ClearITPendingBit(TIM2, TIM_IT_Update);
    }
}
```

### 6.3 增加错误处理机制

增强错误处理，提高系统稳定性：

```c
if (stat != RGB1W_ERR_OK) {
    printf("1-wire error %02x\r\n", stat);
    // 重试发送或恢复默认状态
    RGB1W_Init();
    Delay_Ms(100);
}
```

### 6.4 注释完善

增加更多注释，特别是关于 WS2812B 通信协议和 PIOC 配置的细节：

```c
// WS2812B 时序要求：
// - 逻辑 1: 0.8μs 高电平 + 0.45μs 低电平
// - 逻辑 0: 0.4μs 高电平 + 0.85μs 低电平
// - 重置信号: 大于 50μs 低电平
RGB1W_Init();
```

## 7. 总结

这个程序实现了基于 CH32H417 PIOC 外设的 WS2812B LED 灯带控制功能，主要特点：

1. **硬件加速**：利用 PIOC 外设提供的精确时序控制能力，确保 WS2812B 通信协议的正确实现

2. **多模式支持**：提供 RAM 模式和 SFR 模式两种数据发送方式，适应不同数据量需求

3. **状态管理**：完善的状态跟踪和错误处理机制，确保系统稳定运行

4. **可扩展性**：通过切换不同的 RGB 缓冲区实现颜色模式变化，便于扩展更多颜色效果

该程序展示了如何利用 CH32H417 的高级外设功能实现对时序要求严格的智能 LED 设备的控制，具有较高的学习和参考价值。
        