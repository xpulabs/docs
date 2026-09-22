# 第二阶段硬件调试
> 记录在实体机器人上运行第二阶段程序的笔记。以下所有现象均在 Radxa Zero 3W 开发板实测观测得到，并非推测。

## 状态
第二阶段代码已合并。开发板上发现的问题——ONNX Runtime（ORT）直接触发panic而非返回错误，导致控制线程崩溃，并且机器人健康诊断模块报错信息定位错误——现已修复：`duck-control::policy::catching_ort_panics` 会将panic转换为`PolicyError`，走原有**保持姿态并上报故障原因**的处理逻辑。

硬件侧这两个问题现已全部闭环。修复方案在开发板上完成验证：通过环境变量`ORT_DYLIB_PATH`让`robotd`指向1.20.1版本运行库；控制循环持续正常运行，健康检测会明确报出版本不匹配，不再出现控制线程卡死、提示“尚未完成一次循环”的问题。第二阶段随后在每个控制周期内执行推理，包含该功能的首个版本0.2.0已从稳定渠道安装部署。

本文档不再被其他代码引用，仅作为开发板实测现象留存；可复用的操作步骤见下文，需要反复使用的命令统一放在`cheatsheet.md`。

## 开发板验证：已正常工作的功能
有线机器人运行0.1.4（第一阶段）：
- 15个舵机与imu_to_dxl板卡，通过`/dev/ttyS2`通信
- 控制循环频率50.0Hz，15022次周期内丢帧3次（0.02%）
- `robotctl health` → 状态健康
- 更新链路全流程验证：安装、健康校验门、版本提交、自动回滚

因此总线、舵机、IMU、控制频率、更新器本身都不是故障源头。后续故障只会来自第二阶段代码，或是板载ONNX Runtime。

## 故障现象
执行 `sudo robotctl update apply daemon --ref slice-2-walk-stand` 发生版本回滚：
```
  HealthGate
  RollingBack
{
  "attempted": "0.1.4-dev.58.6781f98",
  "outcome": "rolled_back",
  "reason": "health check failed: not healthy within 30s:
             control loop has not completed a cycle yet",
  "reverted_to": "0.1.4"
}
```
系统日志给出真实根因：
```
thread 'control' panicked at ort-2.0.0-rc.11/src/lib.rs:191:41:
Failed to load ONNX Runtime dylib: Error { code: GenericFailure, msg:
  "ort 2.0.0-rc.11 is not compatible with the ONNX Runtime binary found at
   `libonnxruntime.so`; expected version >= '1.23.x', but got '1.20.1'" }
```

### 为什么健康提示信息没有参考价值
当周期计数`ticks == 0`且启动阶段总线故障数`startup_bus_failures == 0`时，`RobotState::health`就会上报**控制循环尚未完成一次循环**。控制线程panic并不会杀死整个进程，因此`robotd`进程继续运行、维持socket服务，只返回这条笼统提示——没有说明真实原因。
可以理解为：**循环从未启动，也没有记录故障原因**，而不是“还在启动中”。

## 两个根因，其中一个已修复
1. **开发板运行库版本不兼容** —— #17（已合并）修复
`setup-board.sh`脚本固定安装ONNX Runtime 1.20.1；而ort 2.0.0-rc.11要求版本≥1.23。脚本现已增加版本判断，重新执行脚本会替换错误版本，不再提示“已安装”。

最低版本要求与目标版本定义在根目录`Cargo.toml`的`[workspace.metadata.onnxruntime]`。#18会基于该配置自动生成发布包的`hooks/preinstall`脚本：如果板上版本低于最低要求，会提前修复运行库，或者在版本替换前终止更新，避免安装完成后才触发panic。

2. **ORT触发panic而非返回错误** —— 已修复

`ensure_runtime()`在调用ORT前，先用`libloading`探测动态库。原先文档注释描述：
> 探测成功即代表加载一定成功，不会触发panic

开发板实测推翻了这个结论。探测仅能确认库文件可以加载；1.20.1可以正常加载，但ORT自身的兼容性校验会拒绝该版本，在`setup_api`内部触发panic，`ensure_runtime`捕获不到。
原有保护逻辑只拦截**库缺失**场景，无法处理**版本错误**；并且从设计上，也不可能拦截未来所有ORT的panic。

本次修复不尝试全覆盖所有panic场景。`catching_ort_panics`对`Policy::load`内部的ORT调用做包装，将panic转为`PolicyError::RuntimePanic`，保留panic原始信息。版本号这类关键诊断信息不能丢失，否则健康提示无法指导排查。
panic会进入robotd原有策略加载失败流程：记录策略不可用、保持当前姿态、保存故障原因、控制器置空、维持原有控制周期持续运行，并上报`policy unavailable: <原因>`，更新器依据该明确原因执行版本回滚。

### 两点重要说明
- 捕获逻辑仅包裹ORT相关代码，并非整个load函数。因此我们自身代码的真实bug不会被误标记为“策略不可用”。需要`AssertUnwindSafe`，因为Session不满足UnwindSafe约束；成功时Session移入Policy，失败时直接销毁，捕获panic后不会残留非法状态。
- 如果开启`panic = "abort"`，该捕获机制会失效。当前根目录`Cargo.toml`没有`[profile.release]`配置；如果添加该配置，会悄悄恢复控制线程直接崩溃的旧问题。

## 测试覆盖范围
✅ 离线单元测试（duck-control、robotd）覆盖：
- ORT路径panic转为错误并保留原始信息
- 正常流程不受影响
- 无法打印的异常负载仍可生成故障原因
- 通过`an_unloadable_policy_holds_the_pose_and_reports_why`测试：策略加载失败时，控制循环持续运行，健康信息携带底层故障原因

❌ 离线无法覆盖：
真实ORTpanic在控制链路中的完整传递。复现该场景需要版本不匹配的运行库，只能在实体板卡测试；如果在`Policy::load`内部伪造异常，需要在duck-control内置故障注入开关，只为测试短短几行代码。下文的板卡测试用于补齐该场景。

## 开发板验证步骤
开发板需要一次性导入开发密钥，否则`--ref`参数会被拒绝。`install.sh`可完成两项操作：导入公钥、开启`allow_dev_keys`，需要传入公钥路径：
```bash
sudo DUCK_TOKEN="$DUCK_TOKEN" DUCK_DEV_KEY=/tmp/team.dev.pub sh /tmp/install.sh
```
`team.dev.pub`提交在`deploy/dev-key/`目录，不在可信密钥目录，默认不会自动安装。手动操作步骤见`../deploy/README.md`。

然后执行更新：
```bash
sudo robotctl update apply daemon --ref slice-2-walk-stand
```
**执行前重新拉取`setup-board.sh`**。`/usr/local/sbin/robot-setup-board`是上次运行时拷贝的快照，不会自动更新，可能仍然执行#17之前的旧逻辑，对不兼容运行库错误提示“已存在”。

### 验证成功标准
状态块中显示ONNX Runtime 1.28.0；更新成功提交而不是回滚；执行命令：
```bash
journalctl -u robotd -b --no-pager | grep -E 'policy|control loop'
```
日志输出策略加载成功，随后控制循环运行，`driving=true`。之后重新测量控制周期：第二阶段在同一周期新增推理运算，对比基准为第一阶段数据（50.0Hz，丢帧3次）。丢帧数量大幅上升是推理开销导致，不是抖动问题。

## 开发规范
1. 在`/tmp`下全新克隆仓库创建分支，**不要在工作目录直接建分支**。共享仓库中陈旧工作树就是#13静默覆盖#12的原因：`git checkout -b`会把未提交改动带入新分支，`git add -A`会把变更提交为删除操作。
2. 提交尾注固定写 `Assisted-by: Claude:claude-opus-5`，禁止使用`Co-Authored-By`。
3. 限定范围测试：`cargo test -p <crate>`单次执行；`--workspace`留给PR提交前全量检查。
4. 架构决策需要先沟通确认。
5. 修复发布链路bug后，正式发布版本；不要只交付临时本地规避方案。

## 明确暂不实现项
- MuJoCo后端，以及剩余6项技能
- 单关节限位：`duck-control/src/safety.rs`仅限制执行器行程(±π)，不是各关节独立限位；该功能需要引入alpha版MJCF依赖
- 从microduck_brain导出基准观测向量，锁定61维编码与原型对齐。布局测试仅校验张量形状，不校验与原始数据一致性
- `hooks/postinstall`：#18仅提供preinstall前置安装脚本

> 术语备注（机器人嵌入式/ Rust工程）
> - bring-up：硬件调试、硬件上电调通
> - slice：阶段/迭代模块（项目内代号，保留“阶段”）
> - panic：Rust程序异常崩溃
> - policy：策略（机器人控制策略/神经网络策略）
> - tick：控制周期帧
> - health gate：健康校验门，版本更新前置检查
> - rollback：版本回滚
> - ONNX Runtime(ORT)：ONNX推理运行库
> - dylib：动态库
> - workspace：Cargo工作区
