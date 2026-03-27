# LSM6DS3R
          
hardware.c 文件解析（mio_i3c_lsm6d）

## 1. 文件概述

`hardware.c` 是一个用于 **I3C 接口与 LSM6DS 传感器通信** 的硬件测试程序，通过 CH32H417 的 I3C 外设实现与 LSM6DS 传感器的通信，并读取传感器的 ID。

- **作者**: WCH (Nanjing Qinheng Microelectronics Co., Ltd.)
- **版本**: V1.0.0
- **日期**: 2025/03/01
- **功能**: 实现 I3C 初始化、动态地址分配和传感器 ID 读取功能

## 2. 核心功能模块

### 2.1 全局变量与定义

```c
// LSM6DSX 相关定义
#define LSM6DSX_I3C_ADDRESS     0x6A  // LSM6DSX I3C地址
#define LSM6DSX_WHO_AM_I_REG    0x0F  // WHO_AM_I寄存器地址
#define LSM6DSX_EXPECTED_ID     0x6B  // 预期的ID

#define target_daa1 (0x6A)  // LSM6DS sensor I3C address

#define I3C_TX_mux  (83)
#define I3X_RX_mux  (84)

uint8_t trasmit_buf[10] = {};
uint8_t recive_buf[10]  = {};
```

- **LSM6DS 相关定义**:
  - `LSM6DSX_I3C_ADDRESS`: 传感器的静态 I3C 地址
  - `LSM6DSX_WHO_AM_I_REG`: 传感器 ID 寄存器地址
  - `LSM6DSX_EXPECTED_ID`: 预期的传感器 ID 值
- **I3C 配置**:
  - `target_daa1`: 目标动态地址分配值
  - `I3C_TX_mux`/`I3X_RX_mux`: DMA 多路复用通道配置
- **数据缓冲区**:
  - `trasmit_buf`: 发送数据缓冲区
  - `recive_buf`: 接收数据缓冲区

### 2.2 GPIO 配置函数 (GPIO_Config)

**功能**: 配置 I3C 接口的 GPIO 引脚

```c
static void GPIO_Config(void)
{
    GPIO_InitTypeDef GPIO_InitStructure = {0};

    RCC_HB2PeriphClockCmd(RCC_HB2Periph_AFIO, ENABLE);
    RCC_HB2PeriphClockCmd(RCC_HB2Periph_GPIOC, ENABLE);

    // SCL PC4(AF7)
    GPIO_PinAFConfig(GPIOC, GPIO_PinSource4, GPIO_AF7);
    GPIO_InitStructure.GPIO_Pin   = GPIO_Pin_4;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_Very_High;
    GPIO_InitStructure.GPIO_Mode  = GPIO_Mode_AF_PP;
    GPIO_Init(GPIOC, &GPIO_InitStructure);

    // SDA PC5(AF7)
    GPIO_PinAFConfig(GPIOC, GPIO_PinSource5, GPIO_AF7);
    GPIO_InitStructure.GPIO_Pin   = GPIO_Pin_5;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_Very_High;
    GPIO_InitStructure.GPIO_Mode  = GPIO_Mode_AF_PP;
    GPIO_Init(GPIOC, &GPIO_InitStructure);
}
```

- **引脚配置**:
  - SCL (PC4): I3C 时钟线，AF7 功能，推挽输出
  - SDA (PC5): I3C 数据线，AF7 功能，推挽输出
- **时钟配置**: 启用 AFIO 和 GPIOC 时钟

### 2.3 I3C 配置函数 (I3C_Config)

**功能**: 配置 I3C 外设为控制器模式

```c
void I3C_Config()
```

**执行流程**:

1. **时钟配置**:
   ```c
   RCC_HB2PeriphClockCmd(RCC_HB2Periph_I3C, ENABLE);
   ```
   - 启用 I3C 外设时钟

2. **总线参数配置**:
   ```c
   I3C_Ctrl_BusInit.SDAHoldTime        = I3C_SDAHoldTime_1_5;
   I3C_Ctrl_BusInit.WaitTime           = I3C_WaitTime_State_2;
   I3C_Ctrl_BusInit.SCLPPLowDuration   = 0x89;
   I3C_Ctrl_BusInit.SCLI3CHighDuration = 0x88;
   I3C_Ctrl_BusInit.SCLODLowDuration   = 0x88;
   I3C_Ctrl_BusInit.SCLI2CHighDuration = 0x88;
   I3C_Ctrl_BusInit.BusFreeDuration    = 0x77;
   I3C_Ctrl_BusInit.BusIdleDuration    = 0x8e;
   I3C_Ctrl_Init(&I3C_Ctrl_BusInit);
   ```
   - 配置 SDA 保持时间、等待时间和各种时钟周期参数

3. **控制器配置**:
   ```c
   I3C_CtrlConfInit.DynamicAddr       = 0x22;
   I3C_CtrlConfInit.StallTime         = 0x10;
   I3C_CtrlConfInit.HotJoinAllowed_EN = DISABLE;
   I3C_CtrlConfInit.ACKStallState     = DISABLE;
   I3C_CtrlConfInit.CCCStallState     = DISABLE;
   I3C_CtrlConfInit.TxStallState      = DISABLE;
   I3C_CtrlConfInit.RxStallState      = DISABLE;
   I3C_Ctrl_Config(&I3C_CtrlConfInit);
   ```
   - 配置动态地址、延迟时间和各种暂停状态

4. **FIFO 配置**:
   ```c
   I3C_FifoConfInit.RxFifoThreshold = I3C_RXFIFO_THRESHOLD_1_4;
   I3C_FifoConfInit.TxFifoThreshold = I3C_TXFIFO_THRESHOLD_1_4;
   I3C_FifoConfInit.ControlFifo     = I3C_CONTROLFIFO_DISABLE;
   I3C_FifoConfInit.StatusFifo      = I3C_STATUSFIFO_DISABLE;
   I3C_SetConfigFifo(&I3C_FifoConfInit);
   ```
   - 配置接收和发送 FIFO 阈值，禁用控制和状态 FIFO

5. **启用 I3C**:
   ```c
   I3C_Cmd(ENABLE);
   ```
   - 启用 I3C 外设

### 2.4 I3C CCC 命令处理函数

#### 2.4.1 重置动态地址分配 (I3C_RSTDAA)

**功能**: 发送 RSTDAA (Reset Dynamic Address Assignment) CCC 命令，重置总线上所有设备的动态地址

```c
uint32_t I3C_RSTDAA()
{
    uint32_t res = 0;
    I3C_ControllerHandleCCC(0x06, 0, I3C_GENERATE_STOP);

    // 等待完成或错误标志
    while ((I3C_GetFlagStatus(I3C_EVR_FCF) == RESET) && (I3C_GetFlagStatus(I3C_EVR_ERRF) == RESET)) {}

    // 处理完成和错误标志
    if (I3C_GetFlagStatus(I3C_EVR_FCF)) I3C_ClearFlag(I3C_FLAG_FCF);
    if (I3C_GetFlagStatus(I3C_EVR_ERRF)) { I3C_ClearFlag(I3C_CEVR_CERRF); res = 1; }

    return res;
}
```

- **CCC 命令**: 0x06 (RSTDAA)
- **处理流程**:
  - 发送 CCC 命令并生成停止条件
  - 等待命令完成或错误标志
  - 清除标志并返回结果

#### 2.4.2 进入动态地址分配 (I3C_ENTDAA)

**功能**: 发送 ENTDAA (Enter Dynamic Address Assignment) CCC 命令，为总线上的设备分配动态地址

```c
uint32_t I3C_ENTDAA(uint8_t tgt_daa)
```

**执行流程**:

1. **发送 ENTDAA 命令**:
   ```c
   I3C_ControllerHandleCCC(0x07, 0, I3C_GENERATE_STOP);
   ```
   - CCC 命令: 0x07 (ENTDAA)

2. **处理设备响应**:
   ```c
   do {
       if (I3C_GetFlagStatus(I3C_EVR_TXFNFF)) {
           // 读取设备的静态地址
           for (uint32_t index = 0; index < 8; index++) {
               while (I3C_GetFlagStatus((I3C_EVR_RXFNEF)) == RESET) {}
               payload |= (uint64_t)((uint64_t)I3C_ReadByte() << (index * 8));
           }

           // 发送动态地址
           I3C_WriteByte(tgt_daa++);
           target_payload[tgt_cnt] = payload;
           tgt_cnt++;
       }
   } while ((I3C_GetFlagStatus(I3C_EVR_FCF) == RESET) && (I3C_GetFlagStatus(I3C_EVR_ERRF) == RESET));
   ```
   - 读取设备的静态地址（8 个字节）
   - 为每个设备分配动态地址
   - 存储设备的静态地址信息

3. **处理完成和错误**:
   ```c
   if (I3C_GetFlagStatus(I3C_EVR_FCF)) I3C_ClearFlag(I3C_FLAG_FCF);
   if (I3C_GetFlagStatus(I3C_EVR_ERRF)) { I3C_ClearFlag(I3C_CEVR_CERRF); res = 1; }
   ```

### 2.5 DMA 配置函数

#### 2.5.1 发送 DMA 初始化 (DMA_Tx_Init)

**功能**: 初始化 DMA 用于 I3C 数据发送

```c
void DMA_Tx_Init(DMA_Channel_TypeDef *DMA_CHx, u32 ppadr, u32 memadr, u16 bufsize)
```

- **配置参数**:
  - 外设地址: I3C->TDBR (发送数据缓冲区寄存器)
  - 内存地址: 发送缓冲区地址
  - 传输方向: 从内存到外设
  - 数据大小: 字节 (8位)
  - 模式: 普通模式
  - 优先级: 极高

#### 2.5.2 接收 DMA 初始化 (DMA_Rx_Init)

**功能**: 初始化 DMA 用于 I3C 数据接收

```c
void DMA_Rx_Init(DMA_Channel_TypeDef *DMA_CHx, u32 ppadr, u32 memadr, u16 bufsize)
```

- **配置参数**:
  - 外设地址: I3C->RDBR (接收数据缓冲区寄存器)
  - 内存地址: 接收缓冲区地址
  - 传输方向: 从外设到内存
  - 数据大小: 字节 (8位)
  - 模式: 普通模式
  - 优先级: 高

### 2.6 I3C DMA 数据传输函数

#### 2.6.1 I3C DMA 发送 (I3C_DMA_Transmit)

**功能**: 使用 DMA 向 I3C 设备发送数据

```c
uint32_t I3C_DMA_Transmit(uint8_t addr, uint8_t *send_buf, uint16_t send_len)
```

**执行流程**:

1. **初始化 DMA**:
   ```c
   DMA_Tx_Init(DMA1_Channel4, (uint32_t)(&(I3C->TDBR)), (uint32_t)send_buf, send_len);
   DMA_MuxChannelConfig(DMA_MuxChannel4, I3C_TX_mux);
   ```

2. **配置 I3C 和 DMA**:
   ```c
   I3C_DMAReq_TXCmd(ENABLE);
   I3C_ControllerHandleMessage(addr, send_len, I3C_Direction_WR, I3C_CONTROLLER_MTYPE_PRIVATE, I3C_GENERATE_STOP);
   DMA_Cmd(DMA1_Channel4, ENABLE);
   ```

3. **等待传输完成**:
   ```c
   while (DMA_GetFlagStatus(DMA1, DMA1_FLAG_TC4) == RESET) {}
   ```

4. **等待 I3C 操作完成**:
   ```c
   while ((I3C_GetFlagStatus(I3C_EVR_FCF) == RESET) && (I3C_GetFlagStatus(I3C_EVR_ERRF) == RESET)) {
       // 超时检查
   }
   ```

#### 2.6.2 I3C DMA 接收 (I3C_DMA_Recive)

**功能**: 使用 DMA 从 I3C 设备接收数据

```c
uint32_t I3C_DMA_Recive(uint8_t addr, uint8_t *recv_buf, uint16_t recv_len)
```

**执行流程**:

1. **初始化 DMA**:
   ```c
   DMA_Rx_Init(DMA1_Channel5, (uint32_t)(&(I3C->RDBR)), (uint32_t)recv_buf, recv_len);
   DMA_MuxChannelConfig(DMA_MuxChannel5, I3X_RX_mux);
   ```

2. **配置 I3C 和 DMA**:
   ```c
   I3C_DMAReq_RXCmd(ENABLE);
   I3C_ControllerHandleMessage(addr, recv_len, I3C_Direction_RD, I3C_CONTROLLER_MTYPE_PRIVATE, I3C_GENERATE_STOP);
   DMA_Cmd(DMA1_Channel5, ENABLE);
   ```

3. **等待接收完成**:
   ```c
   while (DMA_GetFlagStatus(DMA1, DMA1_FLAG_TC5) == RESET) {}
   ```

4. **等待 I3C 操作完成**:
   ```c
   while ((I3C_GetFlagStatus(I3C_EVR_FCF) == RESET) && (I3C_GetFlagStatus(I3C_EVR_ERRF) == RESET)) {
       // 超时检查
   }
   ```

### 2.7 主函数 (Hardware)

**功能**: 初始化系统并实现 I3C 与 LSM6DS 传感器的通信

```c
void Hardware(void)
```

**执行流程**:

1. **系统初始化**:
   ```c
   printf("I3C TEST - Read LSM6DS ID\r\n");
   GPIO_Config();
   I3C_Config();
   Delay_Ms(50);
   ```

2. **动态地址分配**:
   ```c
   res = I3C_RSTDAA();  // 重置动态地址
   res = I3C_ENTDAA(target_daa1);  // 进入动态地址分配
   ```

3. **读取 LSM6DS ID**:
   ```c
   // 发送 WHO_AM_I 寄存器地址
   trasmit_buf[0] = 0x0F;
   res = I3C_DMA_Transmit(target_daa1, trasmit_buf, 1);
   
   // 接收传感器 ID
   res = I3C_DMA_Recive(target_daa1, recive_buf, 1);
   printf("LSM6DS ID: 0x%x\r\n", recive_buf[0]);
   ```

4. **无限循环**:
   ```c
   while (1) ;
   ```

## 3. I3C 通信原理与时序

### 3.1 I3C 协议概述

I3C (Improved Inter-Integrated Circuit) 是一种高性能、双向、两线串行总线协议，是 I2C 协议的演进版本，具有以下特点：

- **更高的数据速率**: 支持高达 12.5 Mbps 的数据传输
- **动态地址分配**: 自动为设备分配唯一地址，避免地址冲突
- **向后兼容**: 支持与 I2C 设备的通信
- **热插拔支持**: 允许设备在总线运行时加入
- **CCC 命令**: 支持广播命令控制所有设备

### 3.2 动态地址分配流程

1. **RSTDAA (0x06)**: 重置所有设备的动态地址
2. **ENTDAA (0x07)**: 进入动态地址分配模式
   - 控制器发送 ENTDAA 命令
   - 每个设备广播其静态地址
   - 控制器为每个设备分配动态地址
3. **设备使用动态地址进行后续通信**

### 3.3 I3C 通信时序

**关键信号**:
- **SCL**: 串行时钟线
- **SDA**: 串行数据线

**基本通信流程**:
1. **起始条件**: SDA 在 SCL 高电平期间从高到低跳变
2. **地址阶段**: 发送 7 位设备地址 + 1 位读写位
3. **数据阶段**: 发送/接收数据字节
4. **确认位**: 每个字节后接收确认位
5. **停止条件**: SDA 在 SCL 高电平期间从低到高跳变

## 4. LSM6DS 传感器介绍

LSM6DS 是 STMicroelectronics 生产的一款高性能惯性测量单元 (IMU)，集成了:
- **3 轴加速度计**
- **3 轴陀螺仪**
- **数字温度传感器**
- **I3C/I2C/SPI 接口**
- **可编程中断**

**关键特性**:
- 加速度范围: ±2g/±4g/±8g/±16g
- 陀螺仪范围: ±125dps/±250dps/±500dps/±1000dps/±2000dps
- 工作温度: -40°C 至 +85°C
- 电源电压: 1.71V 至 3.6V

## 5. 代码优化建议

### 5.1 增加错误处理和超时机制

```c
// 改进的超时检查
uint32_t timeout = 0;
while ((I3C_GetFlagStatus(I3C_EVR_FCF) == RESET) && (I3C_GetFlagStatus(I3C_EVR_ERRF) == RESET)) {
    timeout++;
    if (timeout > 10000) {  // 更长的超时时间
        res = 2;  // 超时错误码
        break;
    }
    __NOP();
}
```

### 5.2 增加传感器 ID 验证

```c
// 验证传感器 ID
if (res == 0) {
    printf("I3C DMA Recive (WHO_AM_I value) Success\r\n");
    printf("LSM6DS ID: 0x%x\r\n", recive_buf[0]);
    
    // 验证 ID 是否匹配预期值
    if (recive_buf[0] == LSM6DSX_EXPECTED_ID) {
        printf("Sensor ID matches expected value (0x%x)\r\n", LSM6DSX_EXPECTED_ID);
    } else {
        printf("Warning: Sensor ID (0x%x) does not match expected value (0x%x)\r\n", 
               recive_buf[0], LSM6DSX_EXPECTED_ID);
    }
} else {
    printf("I3C DMA Recive (WHO_AM_I value) Fail\r\n");
}
```

### 5.3 增加重复传输机制

```c
// 带有重试机制的 I3C 传输函数
uint32_t I3C_DMA_Transmit_WithRetry(uint8_t addr, uint8_t *send_buf, uint16_t send_len, uint8_t retry_count)
{
    uint32_t res;
    for (uint8_t i = 0; i < retry_count; i++) {
        res = I3C_DMA_Transmit(addr, send_buf, send_len);
        if (res == 0) {
            return 0;  // 成功
        }
        Delay_Ms(5);  // 等待后重试
    }
    return 1;  // 多次尝试后失败
}
```

### 5.4 增加数据结构优化

```c
// 使用结构体管理 I3C 配置和状态
typedef struct {
    uint8_t target_daa;
    uint8_t tx_mux;
    uint8_t rx_mux;
    uint8_t tx_buf[10];
    uint8_t rx_buf[10];
    uint32_t last_error;
} I3C_Device_Handle;

I3C_Device_Handle lsm6ds_handle = {
    .target_daa = 0x6A,
    .tx_mux = 83,
    .rx_mux = 84,
    .last_error = 0
};
```

### 5.5 增加函数参数验证

```c
// 增加参数验证
uint32_t I3C_DMA_Transmit(uint8_t addr, uint8_t *send_buf, uint16_t send_len)
{
    // 参数验证
    if (send_buf == NULL || send_len == 0 || send_len > sizeof(trasmit_buf)) {
        return 1;  // 参数错误
    }
    
    // 原有函数代码...
}
```

## 6. 总结

这个程序实现了基于 CH32H417 I3C 外设的传感器通信功能，主要特点：

1. **完整的 I3C 协议实现**: 支持动态地址分配和基本数据传输
2. **DMA 加速**: 使用 DMA 实现高效的数据传输，减少 CPU 占用
3. **模块化设计**: 代码结构清晰，功能模块划分合理
4. **错误处理**: 包含基本的错误检测和处理机制
5. **易于扩展**: 可以方便地扩展支持更多传感器和功能

该程序展示了如何利用 CH32H417 的高级 I3C 外设功能实现与现代传感器的通信，具有较高的学习和参考价值。适合用于 I3C 协议学习和传感器应用开发。
        