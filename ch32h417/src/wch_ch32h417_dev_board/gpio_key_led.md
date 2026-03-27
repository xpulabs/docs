# Chapter 1 - GPIO

## 1. 文件概述

`hardware.c` 是一个用于 GPIO 按键和 LED 控制的硬件测试程序，主要实现按键输入与 LED 输出的交互功能。

- **功能**: 实现 4 个按键控制 4 个 LED 的基本功能测试

## 2. 核心函数分析

### 2.1 GPIO_Key_LED_Init()

**功能**: 初始化 GPIO 引脚，配置按键和 LED 的工作模式

```c
void GPIO_Key_LED_Init(void)
```

**初始化步骤**:

1. **关闭外部低速晶振(LSE)**
   
   ```c
   RCC_LSEConfig(RCC_LSE_OFF);
   while(RCC_GetFlagStatus(RCC_FLAG_LSERDY) != RESET);
   ```
   
   这是因为 PB3/PB4 引脚默认复用为 LSE 晶振引脚，需要禁用 LSE 才能将其用作普通 GPIO。

2. **使能 GPIO 端口时钟**
   
   ```c
   RCC_HB2PeriphClockCmd(RCC_HB2Periph_GPIOA | RCC_HB2Periph_GPIOB | 
                        RCC_HB2Periph_GPIOC | RCC_HB2Periph_GPIOF | RCC_HB2Periph_GPIOD, ENABLE);
   ```
   
   使能所有使用到的 GPIO 端口时钟。

3. **配置 LED 引脚(推挽输出)**
   
   - LED1: PA1
   - LED2: PA2
   - LED3: PF10
   - LED4: PC15
   
   配置为 **GPIO_Mode_Out_PP** (推挽输出模式)，速度为 **GPIO_Speed_Very_High** (最高速度)。

4. **配置按键引脚(上拉输入)**
   
   - Key1: PB3
   - Key2: PB4
   - Key3: PB5
   - Key4: PD6
   
   配置为 **GPIO_Mode_IPU** (带内部上拉电阻的输入模式)。

5. **初始化 LED 状态**
   
   ```c
   GPIO_WriteBit(GPIOA, GPIO_Pin_1, Bit_SET);
   GPIO_WriteBit(GPIOA, GPIO_Pin_2, Bit_SET);
   GPIO_WriteBit(GPIOF, GPIO_Pin_10, Bit_SET);
   GPIO_WriteBit(GPIOC, GPIO_Pin_15, Bit_SET);
   ```
   
   初始状态下，所有 LED 熄灭 (Bit_SET 为高电平)。

### 2.2 Key_Control_LED()

**功能**: 读取按键状态并控制对应的 LED

```c
void Key_Control_LED(void)
```

**工作原理**:

1. **按键检测**
   
   - 使用 `GPIO_ReadInputDataBit()` 读取按键引脚状态
   - 按键按下时，引脚状态为 **Bit_RESET** (低电平)
   - 按键松开时，引脚状态为 **Bit_SET** (高电平，由内部上拉电阻维持)

2. **按键去抖动**
   
   ```c
   if (GPIO_ReadInputDataBit(GPIOB, GPIO_Pin_3) == Bit_RESET) {
       Delay_Ms(10);  // 10ms 去抖动
       if (GPIO_ReadInputDataBit(GPIOB, GPIO_Pin_3) == Bit_RESET) {
           // 按键确实被按下
       }
   }
   ```
   
   通过两次检测并添加 10ms 延迟，有效消除按键机械抖动带来的误触发。

3. **LED 控制**
   
   - 按键按下时: 对应的 LED 点亮 (Bit_RESET 低电平)
   - 按键松开时: 对应的 LED 熄灭 (Bit_SET 高电平)

4. **串口反馈**
   
   - 按下按键时，通过 `printf()` 输出按键状态信息
   - 松开按键时的信息被注释掉，减少串口输出量

### 2.3 Hardware()

**功能**: 主硬件测试函数，包含测试主循环

```c
void Hardware(void)
```

**工作流程**:

1. **打印测试信息**
   
   ```c
   printf("GPIO Key LED TEST\r\n");
   ```
   
   向串口输出测试开始信息。

2. **初始化硬件**
   
   ```c
   GPIO_Key_LED_Init();
   ```
   
   调用初始化函数配置 GPIO 引脚。

3. **主循环**
   
   ```c
   while(1) {
       Key_Control_LED();
       Delay_Ms(10);
   }
   ```
   
   - 持续调用 `Key_Control_LED()` 检测按键并控制 LED
   - 循环中添加 10ms 延迟，减少 CPU 占用率

## 3. 硬件连接关系

| 按键   | 引脚  | 对应 LED | 引脚   |
| ---- | --- | ------ | ---- |
| Key1 | PB3 | LED1   | PA1  |
| Key2 | PB4 | LED2   | PA2  |
| Key3 | PB5 | LED3   | PF10 |
| Key4 | PD6 | LED4   | PC15 |

## 4. 代码优化建议

1. **使用宏定义引脚映射**
   
   ```c
   #define KEY1_PIN     GPIO_Pin_3
   #define KEY1_PORT    GPIOB
   #define LED1_PIN     GPIO_Pin_1
   #define LED1_PORT    GPIOA
   ```
   
   增加代码可读性和可维护性。

2. **使用数组优化重复代码**
   
   ```c
   GPIO_TypeDef* key_ports[] = {GPIOB, GPIOB, GPIOB, GPIOD};
   uint16_t key_pins[] = {GPIO_Pin_3, GPIO_Pin_4, GPIO_Pin_5, GPIO_Pin_6};
   GPIO_TypeDef* led_ports[] = {GPIOA, GPIOA, GPIOF, GPIOC};
   uint16_t led_pins[] = {GPIO_Pin_1, GPIO_Pin_2, GPIO_Pin_10, GPIO_Pin_15};
   ```
   
   减少重复代码，提高可扩展性。

3. **增加状态变量**
   
   ```c
   uint8_t led_states[4] = {1, 1, 1, 1};  // 1: 熄灭, 0: 点亮
   ```
   
   避免不必要的 GPIO 写入操作，提高效率。

## 5. 应用场景

- **硬件调试**：快速测试 GPIO 输入输出功能
- **学习示例**：适合初学者学习 GPIO 配置和按键处理
- **产品原型**：可作为简单交互产品的基础代码

该程序实现了一个基础但完整的 GPIO 交互功能，展示了嵌入式系统中常见的输入输出控制模式。
