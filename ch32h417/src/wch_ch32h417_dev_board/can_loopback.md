# CAN回环

mio_can13_loop/Common/Common/hardware.c文件解析

## 文件概述
该文件是WCH（南京沁恒微电子有限公司）开发的CAN1和CAN3接口硬件测试程序，版本为V1.0.0，发布于2025/03/01。主要功能是实现CH32H417系列微控制器的CAN1和CAN3接口的初始化、数据发送和接收功能，并通过中断方式处理接收到的数据。

## 核心功能模块

### 1. 全局定义与配置
```c
/* CAN通信参数 */
#define CAN1_FILTER_NUM 0
#define CAN3_FILTER_NUM 28

/* 收发缓冲区 */
volatile uint8_t CAN1_TxBuff[8] = {0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08};
volatile uint8_t CAN1_RxBuff[8];
volatile uint8_t CAN3_TxBuff[8] = {0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01};
volatile uint8_t CAN3_RxBuff[8];

/* CAN引脚配置结构体 */
typedef struct
{
    CAN_TypeDef *CANx;
    GPIO_TypeDef *PORT;
    uint8_t Pin;
    uint8_t AF;
} CANPinTable_t;

/* CAN引脚配置 */
const CANPinTable_t CAN1_RxPin = {CAN1, GPIOA, 11, GPIO_AF9};
const CANPinTable_t CAN1_TxPin = {CAN1, GPIOA, 12, GPIO_AF9};
const CANPinTable_t CAN3_RxPin = {CAN3, GPIOF, 4, GPIO_AF2};
const CANPinTable_t CAN3_TxPin = {CAN3, GPIOF, 3, GPIO_AF2};

/* CAN初始化结构体 */
CAN_InitTypeDef CAN_InitStructure = {0};
CAN_FilterInitTypeDef CAN_FilterInitStructure = {0};
```
- 定义了CAN1和CAN3的过滤器编号
- 创建了收发数据缓冲区
- 定义了CAN引脚配置结构体和具体的引脚配置
- 声明了CAN初始化所需的结构体变量

### 2. CAN引脚初始化
```c
void CAN_Pin_Init(CAN_TypeDef *CANx, const CANPinTable_t *RxPin, const CANPinTable_t *TxPin)
{
    GPIO_InitTypeDef GPIO_InitStructure = {0};

    /* 使能时钟 */
    RCC_HB2PeriphClockCmd(RCC_HB2Periph_AFIO | 
                         (RCC_HB2Periph_GPIOA << ((RxPin->PORT - GPIOA) / sizeof(GPIO_TypeDef))) |
                         (RCC_HB2Periph_GPIOA << ((TxPin->PORT - GPIOA) / sizeof(GPIO_TypeDef))), 
                         ENABLE);

    /* 使能CAN时钟 */
    if(CANx == CAN1)
    {
        RCC_HB1PeriphClockCmd(RCC_HB1Periph_CAN1, ENABLE);
    }
    else if(CANx == CAN3)
    {
        RCC_HB1PeriphClockCmd(RCC_HB1Periph_CAN3, ENABLE);
    }

    /* 配置引脚复用 */
    GPIO_PinAFConfig(RxPin->PORT, RxPin->Pin, RxPin->AF);
    GPIO_PinAFConfig(TxPin->PORT, TxPin->Pin, TxPin->AF);

    /* 配置发送和接收引脚 */
    // ...
}
```
- 初始化CAN通信所需的GPIO引脚
- 使能相应的时钟（GPIO时钟、AFIO时钟、CAN时钟）
- 配置引脚复用功能
- 设置发送引脚为推挽输出，接收引脚为上拉输入

### 3. CAN初始化配置
```c
void CAN_Init_Func(CAN_TypeDef *CANx, uint8_t FilterNum)
{
    /* CAN寄存器复位 */
    CAN_DeInit(CANx);
    CAN_StructInit(&CAN_InitStructure);

    /* CAN配置 */
    CAN_InitStructure.CAN_TTCM = DISABLE;
    CAN_InitStructure.CAN_ABOM = ENABLE;
    CAN_InitStructure.CAN_AWUM = DISABLE;
    CAN_InitStructure.CAN_NART = DISABLE;
    CAN_InitStructure.CAN_RFLM = DISABLE;
    CAN_InitStructure.CAN_TXFP = DISABLE;
    CAN_InitStructure.CAN_Mode = CAN_Mode_Normal;
    CAN_InitStructure.CAN_SJW = CAN_SJW_1tq;
    CAN_InitStructure.CAN_BS1 = CAN_BS1_6tq;
    CAN_InitStructure.CAN_BS2 = CAN_BS2_8tq;
    CAN_InitStructure.CAN_Prescaler = 3;  // 波特率1Mbps (72MHz / (3*(1+6+8))) = 1Mbps
    CAN_Init(CANx, &CAN_InitStructure);

    /* 过滤器配置 */
    CAN_FilterInitStructure.CAN_FilterNumber = FilterNum;
    CAN_FilterInitStructure.CAN_FilterMode = CAN_FilterMode_IdMask;
    CAN_FilterInitStructure.CAN_FilterScale = CAN_FilterScale_32bit;
    CAN_FilterInitStructure.CAN_FilterIdHigh = 0x0000;
    CAN_FilterInitStructure.CAN_FilterIdLow = 0x0000;
    CAN_FilterInitStructure.CAN_FilterMaskIdHigh = 0x0000;
    CAN_FilterInitStructure.CAN_FilterMaskIdLow = 0x0000;
    CAN_FilterInitStructure.CAN_FilterFIFOAssignment = CAN_Filter_FIFO0;
    CAN_FilterInitStructure.CAN_FilterActivation = ENABLE;
    CAN_FilterInit(&CAN_FilterInitStructure);

    /* 配置中断 */
    // ...
    CAN_ITConfig(CANx, CAN_IT_FMP0, ENABLE);
}
```
- 初始化CAN控制器，配置为正常模式
- 设置波特率为1Mbps（基于72MHz系统时钟）
- 配置CAN过滤器，使用32位ID掩码模式，接收所有CAN帧
- 启用CAN接收中断

### 4. CAN数据发送
```c
uint8_t CAN_Send_Msg(CAN_TypeDef *CANx, uint8_t *TxBuff, uint8_t Len)
{
    uint8_t mbox;
    uint16_t i = 0;
    CanTxMsg TxMessage;

    TxMessage.StdId = 0x123;
    TxMessage.ExtId = 0x00;
    TxMessage.IDE = CAN_Id_Standard;
    TxMessage.RTR = CAN_RTR_Data;
    TxMessage.DLC = Len;

    for(i = 0; i < Len; i++)
    {
        TxMessage.Data[i] = TxBuff[i];
    }

    mbox = CAN_Transmit(CANx, &TxMessage);
    i = 0;
    while((CAN_TransmitStatus(CANx, mbox) != CAN_TxStatus_Ok) && (i < 0xFFF))
    {
        i++;
    }

    if(i == 0xFFF)
    {
        return 1;
    }
    else
    {
        return 0;
    }
}
```
- 发送CAN数据帧，使用标准ID 0x123
- 支持最多8字节数据发送
- 等待发送完成，超时时间约为4095个循环

### 5. CAN数据接收
```c
uint8_t CAN_Receive_Msg(CAN_TypeDef *CANx, uint8_t *RxBuff)
{
    uint8_t i;
    CanRxMsg RxMessage;

    if(CAN_MessagePending(CANx, CAN_FIFO0) == 0)
    {
        return 0;
    }

    CAN_Receive(CANx, CAN_FIFO0, &RxMessage);

    for(i = 0; i < RxMessage.DLC; i++)
    {
        RxBuff[i] = RxMessage.Data[i];
    }

    return RxMessage.DLC;
}
```
- 接收CAN数据帧
- 检查FIFO中是否有未处理的消息
- 将接收到的数据存储到指定的缓冲区
- 返回接收到的数据长度

### 6. CAN中断处理
```c
__attribute__((interrupt("WCH-Interrupt-fast"))) void CAN1_RX0_IRQHandler()
{
    uint8_t len;

    if(CAN_GetITStatus(CAN1, CAN_IT_FMP0) != RESET)
    {
        len = CAN_Receive_Msg(CAN1, (uint8_t *)CAN1_RxBuff);
        printf("CAN1 received: ");
        for(uint8_t i = 0; i < len; i++)
        {
            printf("%02X ", CAN1_RxBuff[i]);
        }
        printf("\r\n");

        CAN_ClearITPendingBit(CAN1, CAN_IT_FMP0);
    }
}

__attribute__((interrupt("WCH-Interrupt-fast"))) void CAN3_RX0_IRQHandler()
{
    // 类似CAN1_RX0_IRQHandler的实现
    // ...
}
```
- 处理CAN1和CAN3的接收中断
- 读取接收到的数据
- 打印接收到的数据
- 清除中断标志位

### 7. 主测试函数
```c
void Hardware(void)
{
    printf("CH32H417 CAN1-CAN3 Loopback Example\r\n");
    printf("SystemClk: %d MHz\r\n", SystemClock / 1000000);

    /* 配置系统电源电压为3.3V */
    RCC_HB1PeriphClockCmd(RCC_HB1Periph_PWR, ENABLE);
    PWR_VIO18ModeCfg(PWR_VIO18CFGMODE_SW);
    PWR_VIO18LevelCfg(PWR_VIO18Level_MODE3); // 输出3.3V

    /* 初始化CAN1 */
    CAN_Pin_Init(CAN1, &CAN1_RxPin, &CAN1_TxPin);
    CAN_Init_Func(CAN1, CAN1_FILTER_NUM);

    /* 初始化CAN3 */
    CAN_Pin_Init(CAN3, &CAN3_RxPin, &CAN3_TxPin);
    CAN_Init_Func(CAN3, CAN3_FILTER_NUM);

    /* 循环发送数据 */
    while(1)
    {
        Delay_Ms(1000);
        printf("CAN1 sending data...\r\n");
        CAN_Send_Msg(CAN1, (uint8_t *)CAN1_TxBuff, 8);
        Delay_Ms(1000);
        printf("CAN3 sending reply...\r\n");
        CAN_Send_Msg(CAN3, (uint8_t *)CAN3_TxBuff, 8);
    }
}
```
- 打印程序信息和系统时钟频率
- 配置系统电源电压为3.3V
- 初始化CAN1和CAN3接口
- 进入循环，每隔1秒交替发送CAN1和CAN3的数据

## 关键技术点分析

### 1. CAN通信参数配置
- 波特率：1Mbps（系统时钟72MHz，预分频器3，时间段1为6个时间量子，时间段2为8个时间量子）
- 通信模式：正常模式
- 过滤器：32位ID掩码模式，接收所有CAN帧

### 2. 引脚配置
- CAN1：
  - 接收引脚：PA11，复用功能9
  - 发送引脚：PA12，复用功能9
- CAN3：
  - 接收引脚：PF4，复用功能2
  - 发送引脚：PF3，复用功能2

### 3. 中断处理
- 使用快速中断（WCH-Interrupt-fast）提高响应速度
- 中断处理函数中完成数据接收和打印功能
- 及时清除中断标志位，避免重复触发

### 4. 数据流向
CAN1发送数据 → CAN总线 → CAN3接收并打印  
CAN3发送数据 → CAN总线 → CAN1接收并打印

## 代码优化建议

1. **增加错误处理**：
   ```c
   // 在CAN_Init_Func中增加初始化结果检查
   if (CAN_Init(CANx, &CAN_InitStructure) != CAN_InitStatus_Success)
   {
       // 处理初始化失败
       return 1;
   }
   ```

2. **改进时钟使能方式**：
   ```c
   // 当前代码中时钟使能方式较为复杂，可以简化为：
   if (RxPin->PORT == GPIOA) RCC_HB2PeriphClockCmd(RCC_HB2Periph_GPIOA, ENABLE);
   else if (RxPin->PORT == GPIOF) RCC_HB2PeriphClockCmd(RCC_HB2Periph_GPIOF, ENABLE);
   // 对TxPin同样处理
   ```

3. **增加超时机制**：
   ```c
   // 在CAN_Receive_Msg中增加超时检查
   uint32_t timeout = 1000; // 1ms timeout
   while (CAN_MessagePending(CANx, CAN_FIFO0) == 0 && timeout > 0)
   {
       Delay_Us(1);
       timeout--;
   }
   if (timeout == 0) return 0; // timeout
   ```

4. **使用动态ID**：
   ```c
   // 可以将CAN ID作为参数传递，增加灵活性
   uint8_t CAN_Send_Msg(CAN_TypeDef *CANx, uint16_t stdId, uint8_t *TxBuff, uint8_t Len)
   {
       // ...
       TxMessage.StdId = stdId;
       // ...
   }
   ```

## 总结
该文件实现了CH32H417微控制器CAN1和CAN3接口的完整测试程序，包括初始化、数据发送和接收功能。程序采用了模块化设计，各个功能函数职责明确，代码结构清晰。通过中断方式处理CAN接收数据，提高了系统的实时性。程序中使用的波特率为1Mbps，适合大多数CAN通信应用场景。

该测试程序可以作为CH32H417系列微控制器CAN接口开发的参考，用户可以根据实际需求修改波特率、ID和数据内容等参数。
        