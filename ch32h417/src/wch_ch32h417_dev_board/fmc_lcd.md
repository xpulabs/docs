# FMC驱动LCD

mio_fmc_lcd/Common/Common/hardware.c文件解析

## 文件概述
该文件是WCH（南京沁恒微电子有限公司）开发的FMC（Flexible Memory Controller）操作TFTLCD的硬件测试程序，版本为V1.0.0，发布于2025/05/24。主要功能是通过FMC接口驱动TFTLCD屏幕，实现颜色切换和文本显示。

## 核心功能模块

### 1. LCD引脚定义
```c
/*
 *@Note
   FMC routine to operate TFTLCD-:
  LCD--PIN:
    PD11--FMC_A16
    PD12--FMC_A17
    PD5 --FMC_NEW
    PD4 --FMC_NOE
    PD3 --LCDRST#
    PD14--FMC_D0
    PD15--FMC_D1
    PD0 --FMC_D2
    PD1--FMC_D3
    PE7--FMC_D4
    PE8 --FMC_D5
    PE9 --FMC_D6
    PE10--FMC_D7
    PE11--FMC_D8
    PE12--FMC_D9
    PE13--FMC_D10
    PE14--FMC_D11
    PE15--FMC_D12
    PD8 --FMC_D13
    PD9--FMC_D14
    PD10--FMC_D15
    PB14--IO_BLCTR
*/
```
详细定义了TFTLCD与FMC接口的引脚连接关系，包括地址线、数据线、控制信号和复位信号等。

### 2. LCD复位GPIO初始化
```c
void LCD_Reset_GPIO_Init(void)
{
    GPIO_InitTypeDef  GPIO_InitStructure={0};

    RCC_HB2PeriphClockCmd(RCC_HB2Periph_GPIOD, ENABLE);
    GPIO_InitStructure.GPIO_Pin = GPIO_Pin_3;
    GPIO_InitStructure.GPIO_Mode = GPIO_Mode_Out_PP;
    GPIO_InitStructure.GPIO_Speed = GPIO_Speed_Very_High;
    GPIO_Init(GPIOD, &GPIO_InitStructure);
    GPIO_SetBits(GPIOD,GPIO_Pin_3);
}
```
初始化LCD复位引脚PD3为输出模式，初始状态为高电平（未复位）。

### 3. 主测试函数
```c
void Hardware(void)
{
	u8 x=0;
    RCC_HB1PeriphClockCmd(RCC_HB1Periph_PWR, ENABLE);
    PWR_VIO18ModeCfg(PWR_VIO18CFGMODE_SW);
    PWR_VIO18LevelCfg(PWR_VIO18Level_MODE3);
	LCD_Reset_GPIO_Init();
	//LCD reset
	GPIO_ResetBits(GPIOD,GPIO_Pin_3);
	Delay_Ms(100);
	GPIO_SetBits(GPIOD,GPIO_Pin_3);

    LCD_Init();
	POINT_COLOR=RED;		 
	 
    while(1) 
	{		 
		switch(x)
		{
			case 0:LCD_Clear(WHITE);break;
			case 1:LCD_Clear(BLACK);break;
			case 2:LCD_Clear(BLUE);break;
			case 3:LCD_Clear(RED);break;
			case 4:LCD_Clear(MAGENTA);break;
			case 5:LCD_Clear(GREEN);break;
			case 6:LCD_Clear(CYAN);break;
			case 7:LCD_Clear(YELLOW);break;
			case 8:LCD_Clear(BRRED);break;
			case 9:LCD_Clear(GRAY);break;
			case 10:LCD_Clear(LGRAY);break;
			case 11:LCD_Clear(BROWN);break;
		}
		POINT_COLOR=RED;	  
		LCD_ShowString(30,40,210,24,24,"CH32H417");
		LCD_ShowString(30,70,200,16,16,"TFTLCD TEST");
		LCD_ShowString(30,90,200,16,16,"WCH");
	    x++;
		if(x==12)x=0;			   		 
		Delay_Ms(1000);	
	} 
}
```
主函数实现了以下功能：
- 配置系统电源电压为3.3V
- 初始化LCD复位GPIO
- 执行LCD复位操作
- 初始化LCD控制器
- 设置文本颜色为红色
- 循环切换LCD背景颜色（白色、黑色、蓝色、红色等12种颜色）
- 在每种背景色下显示"CH32H417"、"TFTLCD TEST"和"WCH"文本
- 每种颜色显示1秒后切换到下一种颜色

## 关键技术点分析

### 1. FMC接口
FMC（Flexible Memory Controller）是一种灵活的存储器控制器，用于连接外部存储器和显示设备。该程序通过FMC接口与TFTLCD进行通信，实现高速数据传输。

### 2. 电源配置
程序首先配置了系统电源电压为3.3V，这是TFTLCD和FMC接口的标准工作电压。

### 3. LCD复位时序
程序实现了标准的LCD复位时序：
- 先将复位引脚拉低100ms
- 然后将复位引脚拉高
- 确保LCD正确初始化

### 4. 颜色显示
程序支持12种不同的背景颜色，并在每种颜色下显示红色文本，展示了LCD的基本显示功能。

## 总结
该文件实现了一个完整的FMC TFTLCD测试程序，包括初始化、复位、颜色显示等功能。程序结构清晰，功能完整，可以作为CH32H417系列微控制器FMC接口和LCD驱动开发的参考。
        

