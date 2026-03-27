# QFlash DMA      

          
mio_qflash_dma/Common/Common/hardware.c 文件解析

## 文件概述

这是一个由南京沁恒微电子有限公司（WCH）开发的QSPI（Quad Serial Peripheral Interface）与DMA（Direct Memory Access）硬件固件函数文件，用于与外部SPI Flash进行高速通信。文件版本为V1.0.0，日期为2025/03/01。

## 核心功能模块

### 1. 宏定义与全局变量

```c
// Flash命令定义
#define FLASH_CMD_EnableReset             0x66
#define FLASH_CMD_ResetDevice             0x99
#define FLASH_CMD_JedecID                 0x9F
#define FLASH_CMD_WriteEnable             0X06
// ... 其他命令定义

// Flash硬件参数
#define FLASH_SECTOR_SIZE                 (4096U)  // 扇区大小4KB
#define FLASH_PAGE_SIZE                   (256U)   // 页大小256B

// 数据缓冲区
uint8_t readBuffer[512];
uint8_t verifyBuffer[512];
uint8_t writeBuffer[256];
```

这些宏定义了SPI Flash的各种操作命令和硬件参数，全局变量用于数据传输的缓冲区。

### 2. GPIO配置

```c
static void GPIO_Config(void)
{
    GPIO_InitTypeDef GPIO_InitStructure = {0};

    RCC_HB2PeriphClockCmd(RCC_HB2Periph_AFIO, ENABLE);
    // ... 开启相关GPIO时钟

    // 配置QSPI引脚：SCK、SCSN、SIO0-3
    GPIO_PinAFConfig(GPIOB, GPIO_PinSource2, GPIO_AF9);  // SCK - PB2
    // ... 其他引脚配置
}
```

该函数配置QSPI相关的GPIO引脚，包括时钟线（SCK）、片选线（SCSN）和数据I/O线（SIO0-3），设置为复用推挽输出模式，支持高速数据传输。

### 3. QSPI配置

```c
static void QSPI1_Config(void)
{
    QSPI_InitTypeDef QSPI_InitStructure = {0};

    RCC_HB1PeriphClockCmd(RCC_HB1Periph_QSPI1, ENABLE);
    RCC_HBPeriphClockCmd(RCC_HBPeriph_DMA1, ENABLE);

    QSPI_InitStructure.QSPI_Prescaler = 1;            // 时钟预分频
    QSPI_InitStructure.QSPI_CKMode    = QSPI_CKMode_Mode0;  // SPI模式0
    QSPI_InitStructure.QSPI_CSHTime   = QSPI_CSHTime_8Cycle; // 片选保持时间
    QSPI_InitStructure.QSPI_FSize = 22;               // Flash大小：2^23=8MB
    // ... 其他配置

    QSPI_Init(QSPI1, &QSPI_InitStructure);
    // ... 设置FIFO阈值和数据长度
}
```

该函数初始化QSPI外设，配置时钟参数、Flash大小等基本设置，为后续通信做准备。

### 4. DMA配置

```c
void QSPI_Rx_DMA(uint8_t* buffer, uint32_t len)
{
    DMA_InitTypeDef DMA_InitStructure = {0};

    DMA_DeInit(DMA1_Channel1);
    DMA_InitStructure.DMA_PeripheralBaseAddr = (u32) & (QSPI1->DR);  // QSPI数据寄存器
    DMA_InitStructure.DMA_Memory0BaseAddr    = (u32)buffer;         // 内存缓冲区
    DMA_InitStructure.DMA_DIR                = DMA_DIR_PeripheralSRC;  // 外设到内存
    DMA_InitStructure.DMA_BufferSize         = len / 4;             // 缓冲区大小（按字计算）
    // ... 其他配置

    DMA_Init(DMA1_Channel1, &DMA_InitStructure);

    // QSPI1 CHANNEL
    DMA_MuxChannelConfig(DMA_MuxChannel1, 71);
}
```

DMA配置函数用于设置QSPI的数据传输通道，支持从外设到内存（接收）和从内存到外设（发送）的高速数据传输，提高系统效率。

### 5. QSPI命令处理

文件实现了多种QSPI命令处理函数，包括：
- `QSPI_Send`/`QSPI_Receive`：基本数据收发
- `QSPI_CmdWithAddress`：带地址的命令发送
- `QSPI_WriteCmd`：写命令
- `QSPI_CmdWithData`：带数据的命令发送
- `QSPI_ReadSR`：读取状态寄存器
- `QSPI_WaitForBsy`：等待Flash就绪

这些函数封装了QSPI通信的各种模式，方便上层应用调用。

### 6. Flash操作函数

```c
void QSPI_EraseSector(uint32_t addr)
{
    QSPI_WriteEnable();               // 写使能
    QSPI_CmdWithAddress(FLASH_CMD_SectorErase, addr);  // 发送扇区擦除命令
    QSPI_WaitForBsy();                // 等待操作完成
}

void QSPI_ProgramPage(uint32_t addr, uint8_t* data, uint16_t len)
{
    // ... 页编程实现
    QSPI_DMACmd(QSPI1, ENABLE);       // 启用DMA
    QSPI_Tx_DMA(data, len);           // 配置DMA发送
    DMA_Cmd(DMA1_Channel1, ENABLE);   // 启动DMA
    // ... 等待传输完成
}
```

这些函数实现了Flash的基本操作：
- 扇区擦除（4KB）
- 页编程（256B），支持普通模式和Quad IO模式
- 数据读取，支持单IO、Dual IO和Quad IO模式

### 7. ID读取与验证

```c
uint32_t QSPI_GetManufacturerID()
{
    // ... 读取厂商和设备ID
    return res;
}

uint32_t QSPI_GetManufacturerID_DualIO()
{
    // ... 以Dual IO模式读取ID
    return res;
}

uint32_t QSPI_GetManufacturerID_QuadIO()
{
    // ... 以Quad IO模式读取ID
    return res;
}
```

这些函数用于读取Flash的厂商和设备ID，支持多种IO模式，用于验证Flash的存在和兼容性。

### 8. 数据读写测试

```c
void write_data(uint32_t addr, uint8_t* data, size_t len)
{
    uint32_t current_addr = addr;
    // ... 按页编程数据到Flash
}

int32_t Buffer_Cmp(uint8_t* buf1, uint8_t* buf2, uint32_t len)
{
    // ... 比较两个缓冲区是否相同
}
```

这些辅助函数用于数据的批量写入和验证，确保数据传输的正确性。

### 9. 主函数

```c
void Hardware(void)
{
    printf(__TIME__ "\n");
    printf("QSPI DMA TEST\n");

    GPIO_Config();
    QSPI1_Config();

    QSPI_Cmd(QSPI1, ENABLE);

    // 复位Flash
    QSPI_WriteCmd(FLASH_CMD_EnableReset);
    QSPI_WriteCmd(FLASH_CMD_ResetDevice);
    Delay_Us(100);

    // 读取ID和状态寄存器
    printf("GetManufacturerID %x\n", QSPI_GetManufacturerID());
    printf("GetManufacturerID_DualIO %x\n", QSPI_GetManufacturerID_DualIO());
    printf("GetManufacturerID_QuadIO %x\n", QSPI_GetManufacturerID_QuadIO());

    // 准备测试数据
    unsigned char data[256] = { 0xaa };
    for (i = 0; i < 256; i++ ){
        data[i] = i;
    }

    // 写入数据
    write_data(0, data, 256);

    // 测试不同模式的读取
    printf("one line read\n");
    QSPI_GetData(rd_addr, verifyBuffer, rd_len);
    Print_Buffer(verifyBuffer, rd_len);

    printf("DualIO read\n");
    // ... 测试Dual IO读取

    printf("QuadIO read\n");
    // ... 测试Quad IO读取

    printf("read test and verify end\n");

    while (1);
}
```

主函数演示了整个QSPI DMA通信的流程：
1. 初始化GPIO和QSPI
2. 复位Flash设备
3. 读取Flash ID和状态寄存器
4. 准备测试数据并写入Flash
5. 测试不同IO模式（单IO、Dual IO、Quad IO）的读取功能
6. 验证读取数据的正确性

## 关键技术点分析

### 1. QSPI通信模式

文件支持三种QSPI通信模式：
- **单IO模式**：使用一根数据线，兼容性好但速度较慢
- **Dual IO模式**：使用两根数据线，速度翻倍
- **Quad IO模式**：使用四根数据线，速度达到单IO的四倍

通过`QSPI_EnableQuad(QSPI1, ENABLE)`函数切换到Quad IO模式，实现高速数据传输。

### 2. DMA加速

使用DMA（直接内存访问）技术进行数据传输，减少CPU干预，提高系统效率。DMA配置函数`QSPI_Rx_DMA`和`QSPI_Tx_DMA`分别用于接收和发送数据。

### 3. Flash操作流程

Flash操作遵循严格的流程：
1. 写使能（Write Enable）
2. 发送操作命令（擦除/编程）
3. 等待操作完成（通过状态寄存器或自动轮询）

### 4. 错误处理

通过`Buffer_Cmp`函数比较写入和读取的数据，验证传输的正确性。如果发现错误，会打印错误位置和数据。

## 优化建议

1. **增加超时机制**：在等待Flash就绪的函数中（如`QSPI_WaitForBsy`）增加超时检查，避免死等。

2. **优化DMA配置**：考虑使用循环模式（Circular Mode）进行连续数据传输，减少配置开销。

3. **增加错误处理**：在各个函数中增加错误返回值，方便上层应用进行错误处理。

4. **支持更多Flash容量**：目前代码固定支持8MB Flash，可考虑增加配置选项支持不同容量的Flash。

5. **优化内存管理**：当前使用静态缓冲区，可考虑使用动态内存分配或提供缓冲区参数选项。

6. **增加更多操作模式**：可考虑增加块擦除、芯片擦除等功能，提高灵活性。

## 总结

该文件实现了一套完整的QSPI DMA通信库，用于与外部SPI Flash进行高速通信。它支持多种通信模式（单IO、Dual IO、Quad IO）和完整的Flash操作功能（擦除、编程、读取），并通过DMA技术提高了数据传输效率。主函数提供了一个完整的测试示例，展示了如何使用这些函数进行Flash通信。

代码结构清晰，功能完整，适合作为嵌入式系统中QSPI Flash通信的基础库使用。
        