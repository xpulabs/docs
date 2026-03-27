# LED Blink

## 1. 文件概述

`hardware.c` 是一个用于 **LED 交替闪烁控制** 的硬件测试程序，实现了 4 个 LED 以固定间隔交替亮灭的功能。

- **作者**: XPU Labs
- **版本**: V1.0.0
- **日期**: 2026/03/11
- **功能**: 初始化 LED 引脚并实现 LED 交替闪烁效果

## 2. 核心函数分析

### 2.1 LED_GPIO_Init()

**功能**: 初始化 LED 相关的 GPIO 引脚

```c
void LED_GPIO_Init(void)
```

**初始化步骤**:

1. **关闭外部低速晶振(LSE)**
   
   ```c
   RCC_LSEConfig(RCC_LSE_OFF);
   while(RCC_GetFlagStatus(RCC_FLAG_LSERDY) != RESET);
   ```
   
   - 这是因为部分引脚默认复用为 LSE 晶振功能
   - 必须先禁用 LSE 才能将相关引脚用作普通 GPIO

2. **使能 GPIO 端口时钟**
   
   ```c
   RCC_HB2PeriphClockCmd(RCC_HB2Periph_GPIOA | RCC_HB2Periph_GPIOC | RCC_HB2Periph_GPIOF, ENABLE);
   ```
   
   - 使能所有使用到的 GPIO 端口时钟
   - 配置了3个GPIO端口：A、C、F

3. **配置 LED 引脚(推挽输出)**
   
   - LED1: PA1
   - LED2: PA2
   - LED3: PF10
   - LED4: PC15
   
   配置为 **GPIO_Mode_Out_PP**（推挽输出模式），速度为 **GPIO_Speed_Very_High**（最高速度）

4. **初始化 LED 状态**
   
   ```c
   GPIO_WriteBit(GPIOA, GPIO_Pin_1, Bit_SET);
   GPIO_WriteBit(GPIOA, GPIO_Pin_2, Bit_SET);
   GPIO_WriteBit(GPIOF, GPIO_Pin_10, Bit_SET);
   GPIO_WriteBit(GPIOC, GPIO_Pin_15, Bit_SET);
   ```
   
   - 初始状态下，所有 LED 熄灭（Bit_SET 为高电平）

### 2.2 LED_GPIO_Toggle(u8 i)

**功能**: 根据参数控制 LED 的开关状态

```c
void LED_GPIO_Toggle(u8 i)
```

**实现逻辑**:

- 当参数 `i == 0` 时，所有 LED 熄灭（Bit_SET）
- 当参数 `i != 0` 时，所有 LED 点亮（Bit_RESET）
- 与传统的 "toggle" 函数不同，这里不是逐个翻转状态，而是根据参数统一控制所有 LED

### 2.3 Hardware(void)

**功能**: 主循环函数，实现 LED 交替闪烁

```c
void Hardware(void)
```

**工作流程**:

1. **初始化 LED**
   
   ```c
   LED_GPIO_Init();
   ```
   
   调用初始化函数配置 GPIO 引脚

2. **主循环实现闪烁效果**
   
   ```c
   while(1) {
       Delay_Ms(250);
       LED_GPIO_Toggle(i);
       i = !i;
   }
   ```
   
   - 使用 `Delay_Ms(250)` 创建 250ms 的延迟
   - 通过 `LED_GPIO_Toggle(i)` 控制 LED 状态
   - 通过 `i = !i` 翻转状态变量，实现交替效果

## 3. 硬件连接关系

| LED 编号 | 引脚   | 控制方式 |
| ------ | ---- | ---- |
| LED1   | PA1  | 推挽输出 |
| LED2   | PA2  | 推挽输出 |
| LED3   | PF10 | 推挽输出 |
| LED4   | PC15 | 推挽输出 |

## 4. 代码优化建议

### 4.1 改进 LED_GPIO_Toggle 函数

当前的 `LED_GPIO_Toggle` 函数并不是真正的 "翻转" 函数，而是根据参数设置 LED 状态。可以修改为：

```c
void LED_GPIO_Toggle(void)
{
    GPIO_WriteBit(GPIOA, GPIO_Pin_1, (BitAction)(1 - GPIO_ReadOutputDataBit(GPIOA, GPIO_Pin_1)));
    GPIO_WriteBit(GPIOA, GPIO_Pin_2, (BitAction)(1 - GPIO_ReadOutputDataBit(GPIOA, GPIO_Pin_2)));
    GPIO_WriteBit(GPIOF, GPIO_Pin_10, (BitAction)(1 - GPIO_ReadOutputDataBit(GPIOF, GPIO_Pin_10)));
    GPIO_WriteBit(GPIOC, GPIO_Pin_15, (BitAction)(1 - GPIO_ReadOutputDataBit(GPIOC, GPIO_Pin_15)));
}
```

这样函数名更符合实际功能，而且不需要参数。

### 4.2 使用数组优化重复代码

可以使用数组存储 LED 信息，减少重复代码：

```c
// 在函数外部定义LED配置数组
GPIO_TypeDef* led_ports[] = {GPIOA, GPIOA, GPIOF, GPIOC};
uint16_t led_pins[] = {GPIO_Pin_1, GPIO_Pin_2, GPIO_Pin_10, GPIO_Pin_15};

// 初始化函数可以修改为
for(int i = 0; i < 4; i++) {
    GPIO_InitStructure.GPIO_Pin = led_pins[i];
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_Very_High;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_Out_PP;
    GPIO_Init(led_ports[i], &GPIO_InitStructure);
    GPIO_WriteBit(led_ports[i], led_pins[i], Bit_SET);
}

// 翻转函数可以修改为
for(int i = 0; i < 4; i++) {
    GPIO_WriteBit(led_ports[i], led_pins[i], 
                 (BitAction)(1 - GPIO_ReadOutputDataBit(led_ports[i], led_pins[i])));
}
```

### 4.3 增加注释说明

虽然代码已经有一些注释，但可以增加更多说明，特别是关于硬件连接和工作原理的部分。

## 5. 工作原理总结

1. **初始化阶段**：禁用 LSE 晶振，使能 GPIO 端口时钟，配置 LED 引脚为推挽输出模式，并将所有 LED 初始化为熄灭状态。

2. **运行阶段**：进入无限循环，每隔 250ms 调用一次 `LED_GPIO_Toggle` 函数，通过翻转状态变量 `i` 实现 LED 的交替闪烁效果。

3. **控制逻辑**：当 `i` 为 0 时，所有 LED 熄灭；当 `i` 为 1 时，所有 LED 点亮。通过 `i = !i` 实现状态交替。

这个程序实现了一个简单但完整的 LED 闪烁功能，适合作为 GPIO 输出功能的基础测试程序。