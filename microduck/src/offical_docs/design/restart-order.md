# 哪些进程会重启、何时重启
本文档是**修改current符号链接以及系统启动**所有流程的权威时序说明。编写背景：对于“哪个守护进程在哪个阶段重启”，三份文档给出了三种不同说法，而该时序直接决定版本不一致问题（skew）的排查方式。

本文全部内容均来自代码，每个步骤标注对应的归属函数。若其他地方的描述注释与本文冲突，以注释存在bug论。

## 1. 七个守护进程，以及不属于守护进程的系统单元
一个软件版本包内置7个守护进程：`robotd`、`configd`、`btd`、`padd`、`mediad`、`tofd`、`updaterd`。每个进程的启动路径都指向`/opt/robot/daemon/current/bin/`下的程序。一旦符号链接发生切换，这些进程就变成旧版本；它们要么在升级过程中被重启，要么在升级应答返回之后再重启。

版本包还附带`robot-boot-check.service`，**不属于这7个守护进程，升级流程绝对不能重启它**。该单元负责校验本次启动所用版本是否正常拉起，一旦失败则转入`robot-rescue`救援流程。如果在升级中途运行它，回滚校验会检测到守护进程正在正常重启，引发误判。该单元不带`[Install]`配置段，因此不会被纳入升级管理，详见§1.1。

| 系统单元 | 升级过程中重启 | 应答返回约5秒后重启 |
| ---- | ---- | ---- |
| robotd | 是 | — |
| configd | 是 | — |
| padd | 是 | — |
| mediad | 是 | — |
| tofd | 是 | — |
| updaterd | 永不（它本身就是执行升级的进程） | 是 |
| btd | 永不（升级报文可能通过该传输通道送达） | 是 |

两组重启规则由同一套逻辑决定，有测试用例`every_unit_held_back_is_restarted_once_the_answer_is_out`校验`engine.rs`里的两个集合`NEVER_RESTART`与`RESTART_AFTER_REPLYING`内容完全一致。

不存在“等到下次重启才延后重启”的逻辑。早在`RESTART_AFTER_REPLYING`机制出现前就是如此，这也是关于本系统流传最广的错误认知。

**调度重启 ≠ 重启成功执行**。因此每次`updaterd`启动时，都会对比每个单元的运行版本与当前生效版本，重启所有版本不一致的进程，详见§5。

### 1.1 升级流程会管理哪些systemd单元
满足条件：存在`[Install]`段的`systemd/*.service`文件。没有该段的单元由其他触发源拉起（定时器、其他单元依赖拉起），生命周期不由升级流程控制，判断逻辑在`engine.rs::has_install_section`。

采用**规则判定而非硬编码名称列表**，原因是之前两处逻辑实现不一致：
`hooks/postinstall`拒绝对无`[Install]`段的单元执行`enable --now`，注释描述：“对这类单元执行enable --now会在升级中途触发回滚校验，而此时守护进程本就处于合法重启阶段”；但引擎代码仍然读取全部`.service`文件并稍后尝试重启。
基于配置段做判断，两处逻辑天然保持一致；新增同类单元时无需人工维护列表。

**无法读取的单元文件，同样纳入待重启集合**。该情况大概率是权限问题，而非故意不设置触发条件；重启时报错抛出明显异常，比静默跳过更容易发现问题。

#### 待重启单元集合计算方式
两个集合，由同一个函数区分。`engine.rs::units_shipped`代表当前版本包提供的全部单元：
> （版本自带的systemd/*.service单元） ∪ （`/etc/robot/updater.toml`中的`on_apply.units`）
结果去重并排序。
`engine.rs::units_to_restart` = 上面集合剔除`NEVER_RESTART`集合：
> units_shipped(…) − {updaterd, btd}

升级流程会重启`units_to_restart`集合内单元；§5的启动校验读取`units_shipped`全集，因为升级不能触碰的两个单元，恰恰是该模块需要监控的对象。

当前版本的`units_to_restart`集合为：
`configd, mediad, padd, robotd, tofd`
按字母顺序排列，所有主板、所有测试环境顺序保持一致。
不需要在`deploy/updater.toml`添加配置把`mediad`、`tofd`加入列表：二者自带带`[Install]`段的单元文件，完全遵循该规则。

从版本包而非主板配置文件推导集合，带来两个结果：
1. `padd`会被重启，哪怕`deploy/updater.toml`没有配置。配置列表是追加补充，不是权威全集；仅用于声明版本包**不自带**的单元。
2. 主板上`updater.toml`文件早于某个守护进程发布，该守护进程依然会被重启。该配置文件归属运维人员，`install.sh`会保留旧文件。这也是曾经`configd`未被纳入重启列表的根源（参考`../project/install-path-gap.md` §4）。

每个单元独立执行`systemctl restart <unit>`，**不批量执行**。批量命令`systemctl restart a b`只要其中一个单元不存在，整条命令直接失败，存在的单元也不会重启。
如果systemd返回单元`LoadState=not-found`，则打印警告并跳过；单元存在但重启失败 → 升级失败，触发回滚。

## 2. 通过BLE执行 robotctl update apply / update.apply
调用链路：`engine.rs::apply → apply_inner → stage_and_swap → post_swap`。**第8步之前，不会修改正在运行的版本路径**。

| 序号 | 步骤 | 是否重启进程 |
| ---- | ---- | ---- |
| 1 | 前置检查：时钟校验、机器人停止、无活跃会话 | 否 |
| 2 | 拉取清单、校验签名、通道/配对PIN/降级/兼容性校验 | 否 |
| 3 | 再次前置检查：磁盘空间（要求来自版本清单） | 否 |
| 4 | 下载至 releases/.staging-<ver>/dl/ | 否 |
| 5 | 校验sha256哈希，再校验制品签名 | 否 |
| 6 | 解压到 releases/.staging-<ver>/root/，写入 .updater-manifest.json | 否 |
| 7 | hooks/preinstall（工作目录为暂存目录）：版本低于最低要求则安装ONNX Runtime，然后执行版本包脚本setup-gstreamer.sh，部署mediad依赖栈 | 否 |

> 钩子脚本来自待安装新版本；执行钩子的代码仍然是旧版本。`updaterd`不会在升级过程重启（§1），本表全部步骤由**旧版本的updaterd**执行。
> 因此钩子的执行、日志、限制逻辑的修改，要等到updaterd重启到新版本之后，**下一次升级才生效**。
> 曾因此出现“钩子执行了但无日志”的问题；执行`cat /run/updaterd/identity.json`可以查看即将运行钩子的程序版本。

| 8 | 将暂存目录重命名为 releases/<ver>/ | 否 |
| 9 | 激活启动计数器（pending.json），发生在符号链接切换之前 | 否 |
| 10 | 切换current符号链接 → releases/<ver> | 否 |
| 11 | hooks/postinstall（工作目录 releases/<ver>） | 启动新版本自带单元 |
| 12 | on_apply：逐个执行systemctl重启§1定义的单元 | configd, mediad, padd, robotd, tofd |
| 13 | 执行 releases/<ver>/bin/updaterd --self-test | 否 |
| 14 | 健康校验：每隔500ms通过套接字轮询robotd，最长30秒 | 否 |
| 15 | 确认启动计数器，清理旧版本包 | 否 |
| 16 | 释放升级锁，调度延迟重启任务 | 调度updaterd、btd延迟重启 |
| 17 | 向robotctl/APP返回应答 | — |
| 18 | 第16步之后约5秒 | 执行updaterd、btd重启 |

**第11步及之后任何失败，都会触发回滚**：恢复current符号链接，基于旧版本重新执行on_apply，确认启动计数器并写入系统日志。
1–10步失败时，旧版本仍在运行，无需回滚操作。

第2步也可能终止流程，**不一定完全不触发任何重启**：
如果清单版本就是当前已安装版本，直接终止并返回`already_current`，不下载、不切换版本。但在返回应答前，会执行§5逻辑读取单元状态，标记所有运行版本不匹配的进程；这些进程按16–18步骤同样调度延迟重启。
因此对版本已是最新的机器人执行apply，大部分场景无动作；但守护进程版本与安装版本不一致时，会触发重启。对主板已激活版本执行select切换版本，逻辑相同。

#### 第11步详细说明 — hooks/postinstall
该钩子内置在签名安装包内，以版本目录作为工作目录，按顺序执行：
1. 将所有`systemd/sysusers.d/*.conf`安装至`/usr/lib/sysusers.d/`，执行`systemd-sysusers`。**先创建账号，再启动单元**。单元配置引用不存在User=会启动失败，被判定为进程异常。
2. 将所有`systemd/*.service`覆盖安装到`/etc/systemd/system/`，包含`updaterd.service`、`btd.service`；钩子没有排除列表，也不需要。
3. `systemctl daemon-reload`
4. 对所有带`[Install]`段的单元执行`systemctl enable --now`（§1.1）；不带该段的单元仅安装不启动；`.timer`定时器执行enable，不带--now。

第4步解释了§1的排除逻辑：`--now`代表启动，启动一个已经运行的单元是空操作，**不会重启updaterd和btd**。
该钩子的作用是启动主板从未部署过的新单元；因此新版本新增的守护进程，会在该版本中启动两次：一次在这里，一次在第12步。

钩子内部大部分失败仅输出警告；**单元或sysusers文件安装失败会返回非0退出码，触发升级回滚**。
服务启动失败不直接判定升级失败：例如蓝牙硬件尚未就绪时，btd启动失败属于合法场景。

#### 第13步 — 自检self-test
updaterd不会在升级中自重启。否则一个无法启动的新版本二进制，会等到下一次开机提交升级后才被发现，而此时故障进程本身负责恢复逻辑。
因此执行新版本`bin/updaterd --self-test`：加载`/etc/robot/updater.toml`，初始化引擎，**在修改任何状态前退出**。超时上限10秒。

自检失败返回`Error::SelfTest`，携带程序stderr最后一行日志，触发回滚。
版本包不含`bin/updaterd`（模型组件场景）会直接通过自检。
仅当on_apply配置为重启模式才执行自检，避免干扰首次引导安装流程。

#### 16–18步：延迟重启任务
`engine.rs::schedule_deferred_restarts`，依次调度updaterd、btd：
```bash
systemd-run --on-active=5s --timer-property=AccuracySec=100ms -- systemctl restart <unit>
```
4个关键细节：
1. 使用**临时单元**，不是子进程。`systemctl restart updaterd`会杀死updaterd整个cgroup；如果是子进程，在重启父进程中途就会被杀。systemd-run定时器独立于该cgroup。
2. **先释放升级锁（第16步），再创建定时器**。fork会复制全部打开文件描述符；持有锁时创建子进程，会把锁副本交给子进程。
3. 两种场景会触发：升级成功，或者`already_current`但存在版本不一致单元。由`engine.rs::restarts_owed`唯一判定。前者固定重启这一对进程；后者重启§2检测到版本错误的进程，通常是updaterd。回滚场景不调度：此时当前运行的updaterd版本已经匹配current，重启只会产生无意义抖动。
4. 所有单元都走定时器调度，包括第12步原地重启的单元。如果给configd、robotd单独增加立即重启分支，只能节省5秒，但增加一套独立机制。

调度失败仅记录日志，**不会上报升级失败**。升级成功不会因为调度重启失败而标记失败；代价是该守护进程继续运行旧二进制，直到下次开机。

定时器在应答返回**之前**创建（引擎运行在update.apply调用内），因此5秒计时起点是第16步，不是客户端收到应答的时刻。客户端收到结果后连接断开；BLE场景下客户端会自动重连。

#### 重启后的updaterd行为
属于正常启动流程，完整执行§4的启动序列：清理暂存目录、记录启动信息、执行§5版本一致性校验（这里会捕获btd未成功重启的情况），之后对外提供服务。两个容易忽略的点：
1. 启动计数器统计**updaterd进程启动次数，不是物理开机次数**。成功apply会在第15步确认本次试升级，计数器不再增加；但之前中断升级留下的未确认试升级，会在本次updaterd重启时推进计数。
2. 周期性检查时钟重置。`INITIAL_CHECK_DELAY`从进程启动开始计时60秒，后续检查间隔基于该起点。

## 3. 其他版本切换流程
`select`、`rollback`、`reset-to-golden`共用`engine.rs::transition_to`：激活试升级标记、切换符号链接、执行on_apply、健康校验、失败回滚。**不执行钩子，不自检**；没有解压安装包，不存在新组件需要安装或验证。

| 操作 | 执行钩子 | on_apply（§1） | 自检 | 延迟重启updaterd/btd |
| ---- | ---- | ---- | ---- | ---- |
| update apply | 是 | 是 | 是 | 是 |
| update select <ver> | 否 | 是 | 否 | 是 |
| update rollback | 否 | 是 | 否 | 否 |
| update reset-to-golden | 否 | 是 | 否 | 否 |
| 升级失败自动回滚 | 否 | 是 | 否 | 否 |
| 开机计数器触发回滚 | 否 | 是 | 否 | 否 |

表格底部两行的“No”是设计必然：升级失败、开机计数器回滚场景，updaterd和btd从未被重启，仍然运行待回退版本的二进制。

**手动rollback/reset-to-golden的No是另一种场景，需要注意**：
如果回退前的版本曾经apply成功，updaterd、btd已经切换到该版本。执行回滚后，robotd、configd、padd会切回旧版本；**updaterd、btd继续运行更高版本**。
该问题会在下一次updaterd启动时自动修复，而非等待重启：§5双向对比版本，版本高于current的btd同样判定为过期并重启。updaterd设计上不会自动修复自身版本不一致。

由于select和回滚流程不执行`hooks/postinstall`，**不会删除任何单元文件**。降级到早于某个守护进程的旧版本时，该守护进程的单元文件仍然保留，指向旧版本不存在的二进制文件。单元启动失败；由于它在重启集合内，重启失败会直接导致版本切换失败（参考`../project/install-path-gap.md`）。

## 4. 开机流程
systemd在`multi-user.target`阶段启动守护进程；`robot-boot-check.timer`在开机180秒后触发恢复检查。
守护进程之间只有少量顺序约束：
- `padd`依赖robotd（仅建议约束：socket不存在时padd每5秒退出重试）
- `btd`依赖dbus/bluetooth
没有单元等待updaterd；updaterd仅依赖`network-online.target`，是Wants弱依赖而非Requires强依赖。

本主板上电后大约73秒hci0蓝牙设备才就绪，因此btd会持续重试等待适配器，而不是直接失败。

### updaterd开机启动顺序（main.rs::serve）
1. warn级别日志输出启动身份信息：版本、修订号、可执行文件路径、PID。exe路径用于确定进程实际加载的版本目录。
2. 加载`/etc/robot/updater.toml`与可信密钥；任一加载失败直接致命退出。
3. 创建引擎实例。
4. 执行`--self-test`会在此处返回，不修改任何状态。
5. `Engine::recover_on_start`，**在监听套接字之前执行**。这样机器人启动进入坏版本时，在外部请求到达前就开始回滚：
    - 清理所有组件暂存目录：删除`releases/.staging-*`
    - record_rescue：如果`<state_dir>/rescued`存在，说明开机救援流程在无进程运行时把current切到golden基准版本。将本次动作记录为回滚写入升级日志，清除该组件试升级标记，删除rescued文件。**刻意放在record_boot之前**：救援流程已经完成试升级的后续步骤，如果保留试升级标记，后续开机又会把current切离golden。删除文件同时释放救援循环保护锁。
    - refresh_golden_links：把每个组件配置的golden基准版本创建golden符号链接，和current并列。救援逻辑只需一次readlink读取，无需解析器。
    - record_boot：对pending.json中所有激活的试升级，增加启动计数。
    - 对所有`boots >=2`（MAX_BOOT_ATTEMPTS）的试升级：回退至上一版本；上一版本不存在、磁盘丢失或已标记回滚，则回退到golden基准。操作包含切换符号链接、确认试升级标记、重新执行on_apply。因此开机计数器回滚会重启configd、padd、robotd。**不执行钩子，不调度延迟重启**，systemd刚拉起的updaterd、btd继续运行即将被放弃的版本。后续§6校验会捕获btd版本不一致；updaterd仅告警，保持旧版本直到下次开机。
    - 记录结果到系统日志。此处失败仅记录日志，继续提供服务：停止服务会失去修复机器人的唯一途径。
6. `Engine::reconcile_running_units` — §5。放在恢复流程之后，因为恢复会修改当前生效版本；如果先执行，单元会和即将废弃的版本对比。**该步骤可以重启单元**。
    > `--check-only`模式在此处返回。注意该模式同时执行恢复和版本一致性校验；它是运维工具，不是单纯探测，**可以触发版本回滚和守护进程重启**。
7. 监听`/run/updaterd.sock`套接字。
8. 如果配置`check_interval`，启动定时调度器：进程启动60秒后首次执行，之后按周期运行。`auto_apply`决定无客户端连接时可自动安装哪些版本。

> 试升级（trial）仅发生在apply流程在§2第9~15步之间中断：断电、kill -9、符号链接切换后RPC取消。升级提交成功后不会保留激活的试升级标记。
> 失败判定条件：boots >=2，激活标记写入boots=0。中断升级后updaterd第一次启动打印“update still on trial”，第二次启动触发回滚。

上面所有步骤前提是updaterd能正常启动。如果updaterd无法启动，还有兜底机制：
`robot-boot-check.timer`在开机180s触发，检查robotd、configd、btd、updaterd是否成功拉起；一旦失败，进入/bin/sh救援脚本，将current切到golden基准并重启。该机制独立于本文所有进程，由`boot-recovery-net.md`定义，包含为何采用超时机制，而不是给单元配置OnFailure。

## 5. 启动一致性校验 — 确认重启是否成功
`systemd-run`返回成功仅代表临时定时器创建成功。**不代表重启命令执行成功，更不代表新二进制启动成功**；§2第16步刻意吞掉这类失败。这会造成一种静默故障：机器人运行一个并非已安装的版本，风险落在没有其他监控的两个单元上。`updater/src/reconcile.rs`解决该问题。

### 读取信息来源
每个守护进程启动时上报自身身份：`duck_ipc_proto::publish_identity`，所有守护进程启动时通过宏`log_startup_identity!`调用。
文件路径：`/run/<service>/identity.json`
```json
{ "service", "version", "revision", "built_at", "exe", "pid" }
```
exe字段取自`/proc/self/exe`，跟随current符号链接解析，得到进程实际启动的版本目录。`Identity::release()`从中提取`releases/<ver>`版本号。

**由进程自上报，而非外部读取**：进程无需root权限读取自身版本与exe路径；读取其他用户进程信息需要root。
每个单元配置`RuntimeDirectory=<service>`，目录归属该单元User=用户，支持`ProtectSystem=strict`；单元停止时systemd自动删除目录。**停止的守护进程不会残留身份文件谎称正在运行**。

### 判断逻辑
按组件，遍历`units_shipped`全集（§1，包含updaterd、btd，这是核心目的），对比上报版本与组件当前生效版本。`verdict_for`是纯函数；所有系统调用剥离在外。

| 判定结果 | 触发条件 | 动作 |
| ---- | ---- | ---- |
| Current | 上报版本 == 当前生效版本 | 无动作，静默 |
| Restarted | 版本不一致 | 打印warn日志，执行systemctl重启单元 |
| ReportedOnly | 版本不一致，且单元是updaterd | 记录日志，绝不执行重启 |
| RestartFailed | 尝试重启但失败 | error级别日志 |
| Unknown | 无身份文件 | 无动作 |

三条刻意不执行的规则：
1. updaterd不会在这里自重启。如果新版本updaterd判定版本不一致，重启后又判定不一致，进入死循环。updaterd是唯一负责恢复的进程，一旦死循环系统没有办法终止。仅做日志上报是安全的：进程刚启动，版本不一致的状态在本次代码运行前就已存在。由其他场景修复，见下文。
2. 已停止单元保持停止。无身份文件代表进程停止，或版本太旧不支持上报；两种情况在这里处理逻辑一致。每次updaterd启动自动拉起被人为停止的单元属于越权行为。
3. 没有上报身份的守护进程，不判定为过期。未经用户许可，不能因为版本旧就自动重启机器人守护进程；下一次升级后该进程才支持上报身份。

对比是双向的：**任何版本差异都判定为过期**。因此可以覆盖手动回滚后进程版本高于current的场景，不仅仅处理进程版本落后的情况。

该逻辑在每次updaterd启动都会运行；开机时一般无动作：全部进程从同一个符号链接启动。代价是每个单元读取一次文件。

### apply流程中复用该读取逻辑
`reconcile::stale_units`复用同样身份文件与`verdict_for`，去掉自动执行重启的逻辑。apply和select在`already_current`分支调用。
设计目的：处理上面的例外规则——过期的updaterd，本模块不会自动修复。只有运维人员执行apply发现守护进程异常时，才会触发检查。旧版本此处仅返回already_current，不做任何调度，让人误以为一切正常。

两个特性防止§5要规避的死循环：
1. 在**收到请求时触发**，不是每次进程启动自动执行。
2. 通过systemd-run调度，**不会在待重启进程内部调用systemctl**。
同时输出报告：`already_current`结果中列出所有过期单元，客户端（robotctl、APP）可以看到哪些守护进程版本和系统安装版本不一致。

Restarted与ReportedOnly都属于过期；二者区别是**谁有权限执行重启**，而不是故障本身。表格其余规则不变：停止的单元、无身份上报的单元不判定为过期。

## 6. 首次安装
裸板执行`scripts/install.sh`，主流程顺序：
1. 写入`/etc/robot/updater.toml`与可信密钥。
2. bootstrap_first_release：拉取独立updaterd二进制，执行`updaterd install [--from <dir>]`。本质是普通`Engine::apply`，强制两个配置：
    - `on_apply = none`（单元文件在待安装版本包内）
    - `health = none`（不存在robotd用于探测）
    §2流程运行，但跳过12、13、14步骤；**第11步仍然执行**，`hooks/postinstall`安装单元并对所有带`[Install]`段的单元执行enable --now。守护进程第一次在这里启动。第16步不跳过：引导安装会调度updaterd、btd在5秒后重启，install.sh脚本继续运行。
3. install_units：再次复制单元文件，daemon-reload，依次enable --now：updaterd, robotd, configd, btd, padd, mediad。
    - 顺序：configd在btd前面（btd需要向configd读取配对PIN）；mediad放最后，因为它的单元After依赖其他三个。
    - btd、padd、mediad启动失败**不会导致安装失败**：没有蓝牙、游戏手柄、相机的机器人，依然可以升级和运行。
    - 启用`robot-boot-check.timer`，不带--now。该步骤和钩子存在冗余但无害，也用于兼容早于钩子的旧版本。版本自带但本函数未识别的单元，会记录日志，不做处理。tofd已知，但不单独enable_unit：钩子提前启用，没有依赖，无需在这里控制顺序。
4. install_token_dropin：写入GITHUB_TOKEN配置片段，daemon-reload，执行`systemctl try-restart updaterd`。仅daemon-reload不会把token注入正在运行的updaterd进程，所有主板都需要这一步。

设置`DUCK_FORCE_REINSTALL=1`会在第2步前增加`stop_for_reinstall`：依次停止 padd, tofd, btd, configd, robotd, updaterd。符号链接切换期间无活跃进程，并且不执行健康校验。

## 7. 版本不一致（skew）排查
两个版本号存在合法不一致的场景，根据组合判断故障类型。

| 现象 | 含义 |
| ---- | ---- |
| 升级完成后数秒内，updaterd或btd版本低于安装版本 | 预期现象，延迟重启任务还未执行 |
| btd / robotd / configd / padd / mediad / tofd 持续与current版本不一致 | 重启未生效，§5校验也未能修复。要么updaterd之后从未重启，要么重启失败。查看journal错误日志 |
| updaterd持续版本落后 | 延迟重启任务从未执行成功，§5不会自动修复该单元。执行`robotctl update apply daemon`修复，返回already_current并调度重启；手动执行`systemctl restart updaterd`效果相同。journal日志记录失败原因 |
| 任意守护进程状态为restarting | 进程退出，systemd正在重试拉起。升级后几秒属于正常重启；持续该状态代表进程完全无法启动。典型场景：mediad相机排线断开。进程停止则无身份文件，§5不会处理。`journalctl -u <name> -b`查看退出原因 |
| 任意守护进程状态failed | 启动失败，systemd停止重试。同样查看journal；该状态不是人为停止 |
| 守护进程上报build unknown | 进程正在运行，但没有上报身份。版本早于上报机制，或是刚exec还未执行到上报代码。§5不处理；下一次升级后新版本支持身份上报 |

优先查询机器人，不要仅凭猜测推断：
```bash
robotctl health
```
units模块会打印每个守护进程的实际运行版本，当运行版本与安装版本不一致时输出警告。

手动直接读取守护进程上报文件，核对版本链接：
```bash
cat /run/configd/identity.json; readlink /opt/robot/daemon/current
```
