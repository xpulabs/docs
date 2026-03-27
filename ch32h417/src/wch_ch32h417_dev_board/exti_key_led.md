# hardware.c 文件解析（mio_gpio_exti）

## 1. 文件概述

`hardware.c` 是一个用于 **GPIO 外部中断（EXTI）测试** 的硬件控制程序，实现了通过按键触发外部中断来控制 LED 灯状态翻转的功能。

- **作者**: WCH (Nanjing Qinheng Microelectronics Co., Ltd.)
- **版本**: V1.0.0
- **日期**: 2025/03/01
- **功能**: 利用外部中断检测按键按下事件，并控制对应 LED 灯的亮灭状态翻转

## 2. 核心功能模块

### 2.1 全局变量定义

```c
// LED状态变量
uint8_t LED1_State = 0;  // 0: 熄灭, 1: 点亮
uint8_t LED2_State = 0;
uint8_t LED3_State = 0;
uint8_t LED4_State = 0;

void EXTI7_0_IRQHandler(void) __attribute__((interrupt("WCH-Interrupt-fast")));
```

- 定义了4个LED状态变量，用于记录每个LED的当前状态
- 声明了外部中断处理函数，并使用 `__attribute__((interrupt("WCH-Interrupt-fast")))` 关键字指定为快速中断处理函数

### 2.2 GPIO 引脚初始化 (GPIO_Key_LED_Init)

**功能**: 初始化按键和 LED 相关的 GPIO 引脚

```c
void GPIO_Key_LED_Init(void)
```

**初始化步骤**:

1. **关闭外部低速晶振(LSE)**
   ```c
   RCC_LSEConfig(RCC_LSE_OFF);
   while(RCC_GetFlagStatus(RCC_FLAG_LSERDY) != RESET);
   ```
   - 因为 PB3/PB4 引脚默认复用为 LSE 晶振引脚，需要禁用 LSE 才能将其用作普通 GPIO 按键

2. **使能 GPIO 端口时钟**
   ```c
   RCC_HB2PeriphClockCmd(RCC_HB2Periph_GPIOA | RCC_HB2Periph_GPIOB | 
                        RCC_HB2Periph_GPIOC | RCC_HB2Periph_GPIOF | RCC_HB2Periph_GPIOD |
                        RCC_HB2Periph_AFIO, ENABLE);
   ```
   - 使能所有使用到的 GPIO 端口时钟
   - 特别注意使能了 `RCC_HB2Periph_AFIO`，这是外部中断功能所必需的

3. **配置 LED 引脚(推挽输出)**
   - LED1: PA1
   - LED2: PA2
   - LED3: PF10
   - LED4: PC15
   
   配置为 **GPIO_Mode_Out_PP**（推挽输出模式），速度为 **GPIO_Speed_Very_High**（最高速度）

4. **配置按键引脚(上拉输入)**
   - Key1: PB3
   - Key2: PB4
   - Key3: PB5
   - Key4: PD6
   
   配置为 **GPIO_Mode_IPU**（带内部上拉电阻的输入模式）

5. **初始化 LED 状态**
   - 所有 LED 初始化为熄灭状态（Bit_SET 为高电平）

### 2.3 外部中断初始化 (EXTI_Key_Init)

**功能**: 为按键配置外部中断功能

```c
void EXTI_Key_Init(void)
```

**初始化步骤**:

1. **配置按键与 EXTI 线的映射**
   - Key1 (PB3) -> EXTI_Line3
   - Key2 (PB4) -> EXTI_Line4
   - Key3 (PB5) -> EXTI_Line5
   - Key4 (PD6) -> EXTI_Line6

2. **配置 EXTI 中断参数**
   ```c
   EXTI_InitStructure.EXTI_Mode = EXTI_Mode_Interrupt;
   EXTI_InitStructure.EXTI_Trigger = EXTI_Trigger_Falling;  // 下降沿触发
   EXTI_InitStructure.EXTI_LineCmd = ENABLE;
   ```
   - 设置为中断模式
   - 选择下降沿触发（按键按下时产生下降沿）
   - 使能 EXTI 线

3. **配置 NVIC（嵌套向量中断控制器）**
   ```c
   NVIC_SetPriority(EXTI7_0_IRQn, 0);
   NVIC_EnableIRQ(EXTI7_0_IRQn);
   ```
   - 设置中断优先级为最高（0）
   - 使能 EXTI7_0 中断通道

### 2.4 LED 状态翻转函数 (LED_Toggle)

**功能**: 根据指定的 LED 索引翻转其状态

```c
void LED_Toggle(uint8_t led_index)
```

**实现逻辑**:
- 使用 switch 语句根据 led_index 选择对应的 LED
- 翻转相应的 LED 状态变量（0 变 1，1 变 0）
- 根据新的状态变量设置 GPIO 引脚状态：
  - 状态为 1 时，LED 点亮（Bit_RESET 低电平）
  - 状态为 0 时，LED 熄灭（Bit_SET 高电平）

### 2.5 外部中断处理函数 (EXTI7_0_IRQHandler)

**功能**: 处理 EXTI0-7 线的中断请求

```c
void EXTI7_0_IRQHandler(void)
```

**处理流程**:
1. **检测中断源**：通过 `EXTI_GetITStatus()` 函数检查哪个 EXTI 线触发了中断
2. **执行相应操作**：根据不同的中断源调用 `LED_Toggle()` 函数翻转对应的 LED 状态
3. **清除中断标志**：通过 `EXTI_ClearITPendingBit()` 函数清除中断标志，确保下次中断可以正确触发

**中断源与处理对应关系**:
- EXTI_Line3 (Key1) -> LED1 翻转
- EXTI_Line4 (Key2) -> LED2 翻转
- EXTI_Line5 (Key3) -> LED3 翻转
- EXTI_Line6 (Key4) -> LED4 翻转

### 2.6 主函数 (Hardware)

**功能**: 程序入口函数，完成初始化并进入主循环

```c
void Hardware(void)
```

**执行流程**:
1. 打印测试信息 "GPIO-EXTI TEST"
2. 调用 `GPIO_Key_LED_Init()` 初始化 GPIO 引脚
3. 调用 `EXTI_Key_Init()` 初始化外部中断
4. 进入无限循环 `while(1);`，等待中断事件发生

## 3. 硬件连接关系

| 按键 | 引脚 | EXTI线 | 对应LED | 引脚 |
|------|------|--------|---------|------|
| Key1 | PB3  | EXTI3  | LED1    | PA1  |
| Key2 | PB4  | EXTI4  | LED2    | PA2  |
| Key3 | PB5  | EXTI5  | LED3    | PF10 |
| Key4 | PD6  | EXTI6  | LED4    | PC15 |

## 4. 工作原理

1. **初始化阶段**:
   - 禁用 LSE 晶振，使能 GPIO 和 AFIO 时钟
   - 配置 LED 引脚为推挽输出，按键引脚为带内部上拉的输入
   - 配置外部中断，将按键引脚映射到 EXTI 线，设置下降沿触发
   - 初始化 LED 状态为熄灭

2. **运行阶段**:
   - 程序进入无限循环，等待中断事件
   - 当按键被按下时，产生下降沿信号
   - 下降沿触发对应的 EXTI 线中断
   - 中断处理函数被调用，检测到对应的 EXTI 线中断
   - 调用 LED_Toggle 函数翻转对应的 LED 状态
   - 清除中断标志，等待下一次按键按下

## 5. 与其他 GPIO 测试程序的对比

| 特性 | mio_gpio_exti | mio_gpio_test | mio_gpio_toggle |
|------|---------------|---------------|-----------------|
| 控制方式 | 外部中断 | 轮询 | 轮询 |
| CPU 占用率 | 低（仅中断时工作） | 中（需要不断轮询） | 低（固定延迟轮询） |
| 响应速度 | 快（立即响应） | 中（取决于轮询间隔） | 固定（250ms 间隔） |
| 实现复杂度 | 中等（需要配置中断） | 简单（仅轮询） | 简单（仅轮询） |
| 资源占用 | 中断资源 | 无额外资源 | 无额外资源 |

## 6. 代码优化建议

### 6.1 使用宏定义简化代码

可以使用宏定义来表示引脚和端口的对应关系，提高代码可读性和可维护性：

```c
// LED定义
#define LED1_PORT    GPIOA
#define LED1_PIN     GPIO_Pin_1
#define LED2_PORT    GPIOA
#define LED2_PIN     GPIO_Pin_2
#define LED3_PORT    GPIOF
#define LED3_PIN     GPIO_Pin_10
#define LED4_PORT    GPIOC
#define LED4_PIN     GPIO_Pin_15

// 按键定义
#define KEY1_PORT    GPIOB
#define KEY1_PIN     GPIO_Pin_3
#define KEY1_EXTI    EXTI_Line3
#define KEY2_PORT    GPIOB
#define KEY2_PIN     GPIO_Pin_4
#define KEY2_EXTI    EXTI_Line4
// ... 其他按键定义
```

### 6.2 增加按键去抖动处理

虽然外部中断方式比轮询方式对抖动更不敏感，但在实际应用中仍建议添加去抖动处理：

```c
void EXTI7_0_IRQHandler(void)
{
    // 按键1 (PB3) - EXTI_Line3
    if(EXTI_GetITStatus(EXTI_Line3) != RESET)
    {
        Delay_Ms(10);  // 10ms去抖动
        if(GPIO_ReadInputDataBit(GPIOB, GPIO_Pin_3) == Bit_RESET)  // 确认按键仍被按下
        {
            LED_Toggle(1);
        }
        EXTI_ClearITPendingBit(EXTI_Line3);  // 清除中断标志
    }
    // ... 其他按键处理类似
}
```

### 6.3 使用数组优化 LED_Toggle 函数

可以使用数组来存储 LED 端口和引脚信息，减少重复代码：

```c
GPIO_TypeDef* led_ports[] = {GPIOA, GPIOA, GPIOF, GPIOC};
uint16_t led_pins[] = {GPIO_Pin_1, GPIO_Pin_2, GPIO_Pin_10, GPIO_Pin_15};

void LED_Toggle(uint8_t led_index)
{
    if(led_index >= 1 && led_index <= 4)
    {
        uint8_t idx = led_index - 1;
        LED_States[idx] = !LED_States[idx];
        GPIO_WriteBit(led_ports[idx], led_pins[idx], LED_States[idx] ? Bit_RESET : Bit_SET);
    }
}
```

### 6.4 注释优化

可以增加一些注释来解释关键的硬件连接和设计思路，特别是对于不熟悉 EXTI 配置的开发者。

## 7. 应用场景

- **低功耗应用**: 中断方式可以使 CPU 在没有按键操作时进入低功耗模式，只在按键按下时唤醒
- **实时响应要求高的应用**: 中断方式可以立即响应按键操作，而不需要等待轮询周期
- **多任务系统**: 在多任务系统中，使用中断可以避免长时间占用 CPU 资源进行轮询

## 8. 总结

这个程序实现了一个基于外部中断的按键控制 LED 系统，具有以下特点：

1. **高效性**: 使用外部中断方式，CPU 资源占用低，响应速度快
2. **可靠性**: 配置了适当的 GPIO 模式和中断触发方式
3. **可扩展性**: 代码结构清晰，便于扩展更多的按键和 LED
4. **学习价值**: 完整展示了外部中断的配置和使用方法，适合作为 EXTI 学习示例

通过这个程序，可以很好地理解 CH32H417 微控制器的 GPIO 外部中断功能的使用方法和编程技巧。
        