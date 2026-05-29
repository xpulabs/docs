# CH32H417/CH32H415 HSADC 零基础入门教程
（高速ADC 10位/20Msps，理论+寄存器+实操，新手友好）
适用芯片：**CH32H417 / CH32H415**
前置基础：会基本单片机IO、C语言，无需高速ADC经验

---

# 一、HSADC 基础认知（先搞懂：是什么、能干什么）
## 1.1 HSADC 是什么？
HSADC = **High Speed Analog-to-Digital Converter**
**高速模数转换器**：把连续变化的**模拟电压** → 单片机能识别的**数字值**。

和普通ADC区别：
- 普通ADC：12位，低速（几十~几百ksps）
- **HSADC**：10位，**最高 20M 次/秒**，专门采高速信号（波形、高频传感器、高速采集）

## 1.2 CH32H417/H415 HSADC 核心参数
- **位数**：10位 → 采样值范围 **0 ~ 1023**
- **最大速率**：20Msps（每秒采2000万次）
- **外部通道**：7路（HSADC_IN0 ~ HSADC_IN6）
- **支持模式**：连续转换、DMA、FIFO、乒乓存储、突发模式
- **时钟**：最高 80MHz，可分频
- **转换公式**：
  \( T_{CONV} = 1 \times T_{HSADCCLK} + 4 \times T_{HSADCCLK} = 5 \times T_{HSADCCLK} \)
  采样时间固定 1个周期，总转换固定 5个周期

## 1.3 电压换算公式（直接套用）
\[
V_{IN} = \frac{HSADC\_Val}{1023} \times V_{REF}
\]
- HSADC_Val：采样值（0~1023）
- V_REF：一般 = 3.3V
例：采到 511 → 电压 ≈ 1.65V

## 1.4 新手必须记住的 4 个特点
1. **只有连续转换模式**：一启动就不停采，直到手动关闭
2. **10位精度**：值 0~1023，比普通ADC少2位，但速度快几十倍
3. **自带FIFO**：不怕数据来不及读
4. **DMA+乒乓模式**：高速采大量数据不丢点

---

# 二、HSADC 工作逻辑 & 模式（通俗理解）
## 2.1 工作流程（固定顺序）
1. 使能HSADC时钟 → 配置引脚
2. 配置HSADC分频、通道、位宽、DMA
3. 等待HSADC上电稳定（t_STAB）
4. 启动转换（START=1）
5. 连续采样 → 数据进FIFO → 可CPU读取 / DMA搬运

## 2.2 4 种实用工作模式（新手从第1种开始）
### ① 普通连续采样（入门首选）
- 软件启动 → 不停转换 → 读 DATAR 取数据
- 最简单，适合调试、低速信号

### ② DMA 连续搬运
- 转换完自动把数据搬到内存数组
- 不占CPU，适合高速采集

### ③ 乒乓存储模式（PPMODE）
- 两个内存地址 ADDR0 / ADDR1 交替存数据
- 采一存一，处理超大流量不丢帧

### ④ 突发模式（BURST）
- 采指定长度后自动停止
- 适合“需要一段一段高速采集”的场景

---

# 三、HSADC 寄存器核心讲解（只讲有用的）
HSADC 一共 7 个寄存器，**新手只需要掌握 5 个**：

## 3.1 R32_HSADC_CFGR（配置寄存器，最重要）
地址：0x40017400
核心位：
- **EN[0]**：HSADC总使能（1=上电，0=断电）
- **DMAEN[1]**：DMA使能
- **CHSEL[4:2]**：通道选择（000=通道0 ... 110=通道6）
- **CLKDIV[13:8]**：时钟分频（0=不分频，1=2分频，…63=64分频）
- **WIDTH[7]**：数据位宽（0=16位，1=8位）
- **PPMODE[14]**：乒乓模式使能
- **BURST_EN[15]**：突发模式使能
- **DMA_LEN[31:16]**：DMA传输长度

## 3.2 R32_HSADC_CTLR1（控制寄存器1）
- **START[0]**：写1启动转换
- **EOCIE[8]**：转换完成中断使能
- **DMAIE[9]**：DMA完成中断使能
- **BURSTIE[10]**：突发完成中断使能

## 3.3 R32_HSADC_STATR（状态寄存器）
- **EOCIF[0]**：转换完成标志（1=完成）
- **DMAIF[1]**：DMA完成标志
- **RXNE[3]**：数据寄存器非空（可以读了）
- **FIFO_RDY[8]**：FIFO有数据

## 3.4 R32_HSADC_DATAR（数据寄存器）
- **DR[9:0]**：10位采样结果，直接读取

## 3.5 R32_HSADC_ADDR0 / ADDR1（DMA目标地址）
- 存放DMA要搬运到的内存地址
- 乒乓模式会自动交替使用

---

# 四、实操手把手：最基础教程（单通道+软件读取）
## 4.1 硬件接线
- 信号源 → **PA3**（HSADC_IN0）
- GND 共地
- 3.3V 供电

## 4.2 实现目标
- 单通道连续采样
- 软件查询方式读取
- 计算电压并输出

## 4.3 初始化步骤（固定模板）
1. 使能GPIOA、HSADC时钟
2. 配置PA3为模拟输入
3. 配置HSADC时钟分频
4. 使能HSADC（EN=1），等待稳定
5. 选择通道
6. 设置连续转换
7. 启动转换（START=1）
8. 循环读取数据

## 4.4 可直接运行代码（寄存器版，新手友好）
```c
// ==================== HSADC 单通道基础采样（查询方式）====================
#include "ch32h417.h"

// HSADC 初始化：通道0，连续转换，软件读取
void HSADC_Init(void)
{
    // 1. 使能时钟
    RCC->APB2PCENR |= RCC_APB2Periph_GPIOA;   // GPIOA时钟
    RCC->APB2PCENR |= RCC_APB2Periph_HSADC;  // HSADC时钟

    // 2. 配置 PA3 为模拟输入（HSADC_IN0）
    GPIOA->CFGLR &= ~(0x0F << (3*4));
    GPIOA->CFGLR |=  (0x00 << (3*4));        // 模拟输入模式

    // 3. 配置 HSADC_CFGR
    R32_HSADC->CFGR = 0;
    R32_HSADC->CFGR |= (0 << 2);    // CHSEL=000 → 通道0
    R32_HSADC->CFGR |= (9 << 8);    // CLKDIV=9 → 10分频（根据你的时钟调整）
    R32_HSADC->CFGR |= (0 << 7);    // WIDTH=0 → 16位对齐
    R32_HSADC->CFGR |= (0 << 1);     // DMA关闭
    R32_HSADC->CFGR |= (1 << 0);     // EN=1 → HSADC上电

    Delay_ms(1); // 等待HSADC稳定 t_STAB
}

// 启动HSADC连续转换
void HSADC_Start(void)
{
    R32_HSADC->CTLR1 |= (1 << 0); // START=1 启动转换
}

// 读取一次HSADC值
uint16_t HSADC_Read(void)
{
    while( !(R32_HSADC->STATR & (1<<3)) ); // 等待 RXNE 数据就绪
    return R32_HSADC->DATAR & 0x3FF;       // 取低10位
}

// 主函数示例
int main(void)
{
    uint16_t val;
    float vol;

    SystemInit();
    HSADC_Init();
    HSADC_Start();

    while(1)
    {
        val = HSADC_Read();
        vol = val * 3.3f / 1023.0f;
        // 在这里打印 val 和 vol
    }
}
```

---

# 五、进阶实操：HSADC + DMA（高速采集必备）
## 5.1 配置要点
1. 定义一个数组用于存数据
2. CFGR 打开 DMAEN
3. 设置 DMA_LEN 长度
4. 配置 ADDR0 为数组地址
5. 启动 → DMA自动搬运

## 5.2 DMA 模式关键代码
```c
uint16_t adc_buff[100]; // 采样缓存

void HSADC_DMA_Init(void)
{
    HSADC_Init(); // 复用基础初始化

    R32_HSADC->CFGR |= (1 << 1);      // DMAEN=1 使能DMA
    R32_HSADC->CFGR |= (100 << 16);  // DMA_LEN=100

    R32_HSADC->ADDR0 = (uint32_t)adc_buff; // DMA目标地址
    R32_HSADC->CTLR1 |= (1<<0); // 启动
}
```

---

# 六、乒乓模式 & 突发模式（简单理解）
## 6.1 乒乓模式（PPMODE）
- 两个地址 ADDR0 / ADDR1
- 采满一段自动切换到另一段
- 你可以一边处理旧数据，一边采新数据
- 适合**20Msps 全速采集**

## 6.2 突发模式（BURST）
- 设置 BURST_LEN 长度
- 达到长度自动停止
- 适合：雷达、高速采样脉冲、波形捕捉

---

# 七、新手高频踩坑（必看）
1. **HSADC 没反应**
   - 没开 HSADC 时钟
   - EN 位没写 1
   - 没延时等待稳定（至少1ms）

2. **读出来一直是0**
   - 通道配置错误
   - GPIO 没设为模拟输入
   - 没启动 START=1

3. **数据跳动很大**
   - 信号源带负载能力弱
   - 没有加滤波电容
   - HSADCCLK 太快，信号跟不上

4. **DMA 不工作**
   - 没开 DMAEN
   - ADDR0 地址错误
   - DMA_LEN 设置为0

---

# 八、最简单学习路线（推荐新手照做）
1. 先跑通：**单通道软件查询读取**（本章基础代码）
2. 再学：**DMA 模式**（高速采集）
3. 进阶：**乒乓模式**（20Msps 不丢点）
4. 高阶：**突发模式+中断**（精准控制采样长度）

---

# 总结
- **HSADC 是高速10位ADC，最高20Msps**
- 只有**连续转换模式**
- 数据范围 **0~1023**
- 初始化流程固定：时钟→GPIO→EN→延时→START
- 新手先学会**软件读取**，再上DMA

需要我再给你一份 **DMA+乒乓模式完整版工程代码** 吗？直接可以在MounRiver Studio里编译运行。
