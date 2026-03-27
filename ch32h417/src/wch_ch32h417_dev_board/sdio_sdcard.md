# SD卡

          
mio_sdio_sdcard/Common/Common/hardware.c文件解析

## 文件概述
该文件是WCH（南京沁恒微电子有限公司）开发的SDIO SD卡硬件测试程序，版本为V1.0.0，发布于2025/03/01。主要功能是测试CH32H417系列微控制器的SDIO接口与SD卡的通信功能。

## 核心功能模块

### 1. SD卡信息显示
```c
void show_sdcard_info(void)
{
    switch(SDCardInfo.CardType)
    {
        case SDIO_STD_CAPACITY_SD_CARD_V1_1:
            printf("Card Type:SDSC V1.1\r\n");
            break;
        // ... 其他卡类型处理
    }
    printf("Card ManufacturerID:%d\r\n",SDCardInfo.SD_cid.ManufacturerID);
    printf("Card RCA:%d\r\n",SDCardInfo.RCA);
    printf("Card Capacity:%d MB\r\n",(u32)(SDCardInfo.CardCapacity>>20));
    printf("Card BlockSize:%d\r\n\r\n",SDCardInfo.CardBlockSize);
}
```
该函数用于显示SD卡的详细信息，包括卡类型、制造商ID、相对卡地址(RCA)、容量和块大小。

### 2. 全局变量
```c
u8 buf[512];     // 写缓冲区
u8 Readbuf[512]; // 读缓冲区
```
定义了两个512字节的缓冲区，用于存储SD卡读写操作的数据。

### 3. 主测试函数
```c
void Hardware(void)
{
    u32 i;
    u32 Sector_Nums;
    
    // 配置电源电压为3.3V
    RCC_HB1PeriphClockCmd(RCC_HB1Periph_PWR, ENABLE);
    PWR_VIO18ModeCfg(PWR_VIO18CFGMODE_SW);
    PWR_VIO18LevelCfg(PWR_VIO18Level_MODE3);
    Delay_Ms(100);
    
    // 初始化延时和串口
    Delay_Init();
    USART_Printf_Init(115200);
    printf("SystemClk:%d\r\n",SystemCoreClock);
    printf( "ChipID:%08x\r\n", DBGMCU_GetCHIPID() );
    
    // 初始化SD卡
    while(SD_Init())
    {
        printf("SD Card Error!\r\n");
        delay_ms(1000);
    }
    show_sdcard_info();
    
    printf("SD Card OK\r\n");
    
    // 计算扇区数量
    Sector_Nums = ((u32)(SDCardInfo.CardCapacity>>20))*2048;
    printf("Sector_Nums:0x%08x\n", Sector_Nums);
    
    // 准备测试数据
    for(i=0; i<512; i++){
        buf[i] = i;
    }
    
    // 测试所有扇区
    for(i=0; i<Sector_Nums; i++){
        if(SD_WriteDisk(buf,i,1)) 
            printf("Wr %d sector fail\n", i);
            
        if(SD_ReadDisk(Readbuf,i,1)) 
            printf("Rd %d sector fail\n", i);

        if(memcmp(buf, Readbuf, 512)){
            printf(" %d sector Verify fail\n", i);
            break;
        } else {
            printf("sector %d is OK\r\n", i);
        }
    }
    printf("end\n");
    while(1);
}
```
该函数是整个测试程序的核心，实现了以下功能：
- 配置系统电源电压为3.3V
- 初始化延时和串口通信
- 检测并初始化SD卡
- 显示SD卡信息
- 计算SD卡的总扇区数
- 向SD卡写入测试数据并读取验证
- 打印测试结果

## 关键技术点分析

### 1. 电源配置
程序首先配置了系统电源电压为3.3V，这是SD卡通信的标准工作电压。

### 2. SD卡初始化
使用`SD_Init()`函数初始化SDIO接口和SD卡，该函数会自动识别SD卡类型并进行相应配置。

### 3. 扇区读写
使用`SD_WriteDisk()`和`SD_ReadDisk()`函数进行扇区级别的读写操作，这是SD卡操作的基本单位。

### 4. 数据验证
通过`memcmp()`函数比较写入和读取的数据，确保数据传输的正确性。

## 总结
该文件实现了一个完整的SDIO SD卡测试程序，包括初始化、信息显示、数据读写和验证等功能。程序结构清晰，功能完整，可以作为CH32H417系列微控制器SDIO接口开发的参考。
        