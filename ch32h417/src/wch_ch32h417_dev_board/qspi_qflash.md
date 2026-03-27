# QFlash

mio_qflash_test/Common/Common/hardware.c文件解析

## 文件概述
该文件是WCH（南京沁恒微电子有限公司）开发的QSPI（Quad Serial Peripheral Interface）与Flash存储器通信的硬件固件函数库，版本为V1.0.0，发布于2025/03/01。该文件主要实现了CH32H417系列微控制器的QSPI接口配置和Flash存储器操作功能。

## 核心功能模块

### 1. 宏定义与全局变量
```c
#define FLASH_CMD_WriteEnable                0x06
#define FLASH_CMD_WriteDisable               0x04
#define FLASH_CMD_ReadStatus_REG1            0x05
#define FLASH_CMD_ManufactDeviceID           0x90
// ... 其他Flash命令宏定义

uint8_t readBuffer[256] = {0};    // 读缓冲区
uint8_t writeBuffer[256] = {0};   // 写缓冲区
uint8_t verifyBuffer[256] = {0};  // 验证缓冲区
```
定义了QSPI Flash常用命令和数据缓冲区，用于存储读写操作的数据。

### 2. GPIO配置
```c
void GPIO_Config(void)
{
    GPIO_InitTypeDef GPIO_InitStructure = {0};
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOB | RCC_APB2Periph_GPIOA,
                           ENABLE);
    // ... GPIO引脚配置
    GPIO_PinAFConfig(GPIOB, GPIO_PinSource2, GPIO_AF_9);
    // ... 其他引脚复用配置
}
```
配置了QSPI通信所需的GPIO引脚，包括CLK、CS、D0-D3等，并将其复用为QSPI功能。

### 3. QSPI配置
```c
void QSPI1_Config(void)
{
    QSPI_InitTypeDef QSPI_InitStructure = {0};
    RCC_AHB3PeriphClockCmd(RCC_AHB3Periph_QSPI, ENABLE);
    // ... QSPI基本配置
    QSPI_Init(QSPI1, &QSPI_InitStructure);
}
```
配置了QSPI1的基本参数，包括时钟极性、相位、数据顺序等。

### 4. QSPI命令处理
```c
void QSPI_WriteCmd(uint8_t cmd)
{
    // ... 发送命令配置
    QSPI_Start(QSPI1);
    // ... 等待命令发送完成
}

void QSPI_CmdWithAddress(uint8_t cmd, uint32_t addr)
{
    // ... 带地址的命令配置
    QSPI_SetAddress(QSPI1, addr);
    QSPI_Start(QSPI1);
    // ... 等待命令发送完成
}
```
实现了基本的QSPI命令发送功能，包括单纯命令和带地址的命令。

### 5. Flash操作函数
```c
void QSPI_EraseSector(uint32_t addr)
{
    QSPI_WriteEnable();
    QSPI_CmdWithAddress(FLASH_CMD_SectorErase, addr);
    QSPI_WaitForBsy();
}

void QSPI_WritePage(uint32_t addr, uint8_t* data, uint16_t len)
{
    // ... 页写入配置
    QSPI_Send(data, len);
    // ... 等待写入完成
}
```
提供了Flash存储器的擦除、写入等基本操作函数。

### 6. ID读取与验证
```c
uint32_t QSPI_GetManufacturerID()
{
    // ... 制造商ID读取配置
    QSPI_ReceiveData8(QSPI1);
    // ... 处理接收数据
    return res;
}

uint32_t QSPI_GetManufacturerID_DualIO()
{
    // ... 双线模式ID读取
}

uint32_t QSPI_GetManufacturerID_QuadIO()
{
    // ... 四线模式ID读取
}
```
实现了三种模式（单线、双线、四线）下的Flash制造商和设备ID读取功能。

### 7. 数据读写测试
```c
void QSPI_GetData(uint32_t addr, uint8_t* data, uint32_t len)
{
    // ... 单线数据读取
}

void QSPI_GetData_DualIO(uint32_t addr, uint8_t* data, uint32_t len)
{
    // ... 双线数据读取
}

void QSPI_GetData_QuadIO(uint32_t addr, uint8_t* data, uint32_t len)
{
    // ... 四线数据读取
}
```
提供了三种模式下的数据读取功能，用于测试不同模式的通信效果。

### 8. 主函数
```c
void Hardware(void)
{
    printf("MIO QSPI TEST\n");
    GPIO_Config();
    QSPI1_Config();
    // ... 设备复位和初始化
    printf("GetManufacturerID %x\n", QSPI_GetManufacturerID());
    // ... 写入测试数据
    // ... 不同模式下的读取测试
}
```
主函数实现了完整的测试流程，包括初始化、ID读取、数据写入和不同模式下的读取验证。

## 关键技术点分析

### 1. QSPI通信模式
- **单线模式**：传统SPI通信方式，使用CLK、CS和一根数据线
- **双线模式**：使用两根数据线同时传输数据，提高了通信速率
- **四线模式**：使用四根数据线同时传输数据，通信速率最高

### 2. Flash操作流程
- **擦除操作**：先发送写使能命令，再发送扇区擦除命令，最后等待操作完成
- **写入操作**：先发送写使能命令，再发送页写入命令和数据，最后等待操作完成
- **读取操作**：直接发送读取命令和地址，然后接收数据

### 3. 错误处理
文件中实现了基本的状态检查和等待机制，确保QSPI操作在正确的时机进行。

## 代码优化建议

1. **增加超时机制**：在等待标志位变化时，可以添加超时计数，避免死循环
2. **优化缓冲区管理**：可以根据实际需求动态分配缓冲区，减少内存占用
3. **增强错误处理**：增加返回值来标识操作结果，便于上层应用处理错误
4. **支持更多Flash型号**：可以添加不同Flash型号的命令集和参数配置
5. **优化性能**：对于大量数据的读写操作，可以考虑使用DMA来提高效率

## 总结
该文件实现了CH32H417微控制器的QSPI接口与Flash存储器的通信功能，支持多种通信模式和Flash操作，是一个功能完整的QSPI固件库。通过该库，可以方便地实现对QSPI Flash的读写操作，适用于需要高速数据存储的应用场景。
        