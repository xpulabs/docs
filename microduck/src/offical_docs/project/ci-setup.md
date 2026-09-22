# CI 配置文档
状态：草案 · 日期：2026-07-28 · 负责人：pierre

这是发布流水线的一次性配置。密钥保管参见 `updater-design.md` 第5.4节，预发布环境转正式稳定版的模型参见第16.3节。

## 决策：两套密钥、两类触发方式，本方案暂不设置审批门禁
决议日期：2026-07-29。
分支提交使用 `team.dev` 密钥签名；带标签发布与版本升级转正使用 `release-1` 密钥。两把密钥都存放于CI中。

| 触发事件 | 工作流 | 密钥 | 是否推送到客户机器人 |
| ---- | ---- | ---- | ---- |
| 提交代码至任意分支 | dev.yml | team.dev（仓库级密钥） | 否：`allow_dev_keys = false`，可信公钥文件名后缀必须为 `.dev.pub` |
| 打标签 daemon-staging-v* | release.yml | release-1（release环境密钥） | 转正前不会推送；仅作为预发布版发布 |
| 手动版本转正 | promote.yml | release-1 | 是 |

这套划分相比早期方案更加清晰：在预发布转稳定版本的链路中，密钥不会交叉混用。因此版本转正操作仍然可以对**完全相同的二进制文件**重新生成清单并签名（见16.3节）。
由 `team.dev` 签名的制品**不能被转正**：转正流程会读取预发布制品上已有的签名地址。这也是为什么开发构建产物只能停留在开发版本，不会升级为候选发布版。

## 原本的设计目标，以及未能实现的原因
原本计划：给 `release-1` 密钥增加release环境的**必需评审人**保护规则。但无法创建该规则：
> HTTP 422: Failed to create the environment protection rule.
> Please ensure the billing plan supports the required reviewers protection rule.

尝试使用标签保护作为替代方案，同样不可用：
> 403: Upgrade to GitHub Pro or make this repository public to enable this feature.

私有仓库下，必需评审人、部署分支策略、分支保护与规则集均属于Team/Pro付费功能。pollen-robotics组织当前使用免费方案。release环境已创建，但没有任何保护规则。

## 明确说明：接受的风险
**拥有代码推送权限的任何人都可以读取release-1密钥**。
将密钥限定在release环境内，只能阻止未声明该环境的工作流读取密钥；但任何协作者都可以编写一个声明该环境的工作流来读取密钥。
因此，“仅用于版本发布”只是团队内部互信约定，**并非访问控制机制**；工作流文件本身不能作为安全边界。

团队是主动选择接受该风险：团队规模小、成员彼此信任，目前所有机器人都还未出厂。另一种方案（每次发布手动签名）在当前没有真实威胁的场景下，并不能带来实际安全收益。

出现下面任一情况时，需要重新评估本方案（风险代价将急剧上升，且一旦泄露造成的损害无法撤销）：
> 密钥泄露意味着必须向所有机器人推送由release-2签名的更新包；**任何没收到该更新的机器人会永久信任已泄露的密钥**。
1. 机器人部署到用户家中；
2. 拥有推送权限的人员，本不应该直接拿到签名私钥。

届时修复方案二选一：
- 将组织升级为GitHub Team，保留当前密钥划分，同时增加审批门禁；
- 将release-1签名操作改回本地笔记本执行。

## 密钥分级（保持不变，用于控制泄密后的影响范围）
无论上述决策如何，**密钥泄露造成的损失边界**由密钥的可访问范围决定：

| 密钥 | 是否存放于CI | 用途 |
| ---- | ---- | ---- |
| release-1 | 现状如上所述 | 所有发布与版本转正操作的签名密钥 |
| release-2 | 否 | CI或release-1泄露时，优先轮换使用的备用密钥 |
| release-3 | 否，理想情况下永不联网 | 终极应急密钥 |
| team.dev | 计划存放，仅dev工作流使用 | 分支构建签名；无法作用于客户机器人（`allow_dev_keys=false`） |

所有公钥在机器人镜像出厂时就内置到固件。机器人仅校验镜像内预置的公钥集合。这是**无需物理重刷固件**，就能支持密钥轮换的唯一方案。

## 密钥与环境变量
GitHub Secrets是只写机制：一旦设置，任何人（包括配置者本人）都无法回读。密钥只是部署副本，不作为原始存储。密码管理器才是权威记录；如果原始密钥丢失，所有信任该密钥的机器人将无法再接收签名更新。

密钥**作用域限定到release环境，不要限定在整个仓库**。
仓库级密钥可被仓库内所有工作流任务读取；环境密钥仅能被声明使用该环境的任务读取。
本方案中，该隔离只能阻止无关工作流读取密钥（边界限制有限，见上文），但属于零成本的安全增强：
```bash
gh secret set MINISIGN_SECRET_KEY --env release < ~/.duck-keys/release-1.key
gh secret set MINISIGN_PASSWORD --env release
```
第二条命令交互式输入密码，保证口令不会出现在shell历史或日志记录中。

### 密钥（加密，不可回读）当前状态
| 名称 | 作用域 | 值 | 是否已配置 |
| ---- | ---- | ---- | ---- |
| MINISIGN_SECRET_KEY | release环境 | ~/.duck-keys/release-1.key（完整两行） | ✅ |
| MINISIGN_PASSWORD | release环境 | release-1密钥的口令 | ✅ |
| MINISIGN_DEV_SECRET_KEY | 仓库 | ~/.duck-keys/team.dev.key | ✅ |

`MINISIGN_DEV_SECRET_KEY` 刻意设置为仓库级别：所有分支提交都要用该密钥签名。如果把它绑定到环境，开发工作流就需要声明release环境。
开发密钥不需要口令密钥：开发密钥不加密，方便CI无交互签名。`xtask keycheck` 工具会校验：开发密钥无加密是合规的，但发布密钥不能无加密。

### 环境变量（明文可读，公钥不属于密钥）
| 名称 | 值 |
| ---- | ---- |
| MINISIGN_PUBLIC_KEY | ~/.duck-keys/release-1.pub内的公钥行 |

release.yml在发布前，会使用该公钥通过机器人原生代码路径校验发布包。
**刻意将公钥存为普通变量而非密钥**：如果把公钥当作密钥保管，容易混淆公私钥的安全边界。

> 不要添加release-2、release-3到此处。它们的安全价值就是不在CI中存在。

## release发布环境
`release.yml` 和 `promote.yml` 都声明使用 `release` 环境。在【设置→环境】中创建该环境，并添加必需评审人。

如果没有该环境：任何能推送 `daemon-staging-v*` 标签的人，都可以给全量机器人固件签名。
配置评审人后，想要使用签名密钥必须经过第二人审批。基本可以达到本地签名的安全效果，代价是每次发布多一次点击确认。

Fork仓库提交的PR永远无法获取密钥，外部贡献者的PR无论如何都访问不到密钥。

## 密钥处理逻辑
每个工作流**仅有一步**会将密钥写入磁盘，并且使用后立刻删除：
```bash
umask 077
printf '%s' "$MINISIGN_SECRET_KEY" > "$RUNNER_TEMP/secret.key"
cargo run -p xtask -- sign --dir dist --key "$RUNNER_TEMP/secret.key"
shred -u "$RUNNER_TEMP/secret.key" || rm -f "$RUNNER_TEMP/secret.key"
```
选择写入文件，而不是命令行传参：命令行参数会被运行机上其他进程在进程列表中看到。

release.yml的校验步骤**不需要密钥**：`xtask package` 生成第二份清单（用于本地目录LocalDir，使用裸文件名URL），`xtask sign`一次性对两份清单完成签名。
如果为了校验而重复签名，会在同一个任务中两次加载签名密钥，没有收益。

## 执行版本发布
GitHub发布页面是操作入口。你创建的发布类型决定CI行为，release.yml读取标签自动区分模式：

| 操作 | 模式 | CI执行动作 |
| ---- | ---- | ---- |
| 创建预发布，标签 daemon-staging-v0.4.0 | staging预发布 | 交叉编译aarch64、打包、release-1签名、通过机器人原生引擎校验、发布预发布版本 |
| 创建正式发布，标签daemon-v0.4.0，且存在对应的staging 0.4.0 | promote转正 | 基于预发布校验过的完全相同制品，重新生成稳定版清单并签名；不重新编译；归档预发布版本 |
| 创建正式发布，标签daemon-v0.4.0，无对应staging 0.4.0 | stable稳定版 | 直接编译0.4.0并发布为稳定版；发布说明标注该版本未经过灰度验证 |

运行摘要会标明本次执行属于上面哪一种。版本异常时，首先要确认的就是本次发布属于哪一类流程。

在终端推送标签效果相同，系统会自动创建发布对象：
```bash
git tag daemon-staging-v0.4.0 && git push --tags
```
**必须先升级workspace版本号**：`xtask package`会拒绝与Cargo.toml版本不一致的标签。

两条关键特性，也是这套流程划分的目的：
1. 普通`update apply`更新命令会跳过预发布版本。**未转正的构建包，不会被没有指定`--staging`参数的机器人拉取**。两次发布步骤都会重新覆写版本标记：
    - 如果有人手动创建预发布但没勾选预发布标记，全量机器人都可以安装该包；
    - 如果稳定版被错误标记为预发布，则不会推送给任何机器人。
2. 版本转正**绝不重新编译**。稳定发布包是自包含的（清单、签名、制品、引导二进制），转正完成后预发布包可以删除。
> 早期版本（daemon-v0.3.0）不满足该特性，它的url仍然指向预发布包，这类旧版本对应的staging制品**不能删除**。

手动转正流程，不需要预先创建发布记录，同时这里配置最低支持版本`min_supported`（§8.1）：强制低于该版本的机器人升级，无需等待客户端主动请求更新。
```bash
gh workflow run promote --field version=0.4.0
```

## 工作流清单
```
release.yml            入口工作流：区分staging / promote / stable三种模式
_build-release.yml     编译 · 打包 · 签名 · 校验 · 发布（被调用）
_promote-release.yml   复制二进制 · 校验sha · 重签名 · 归档预发布版本（被调用）
promote.yml            手动触发 → 调用_promote-release.yml
dev.yml                每次代码提交：面向开发的构建包，使用team.dev密钥，不可用于客户设备
```

核心逻辑放在两个子工作流中，保证预发布和稳定发布的交付内容不会出现偏差。
`xtask`打包校验逻辑读取`_build-release.yml`和`dev.yml`的打包包含列表。单元文件、钩子脚本、sysusers配置如果没有被打包，会在测试阶段直接失败，而不是等到机器人运行时报错。

两次发布操作仅在发布不存在时创建发布，上传时使用`--clobber`覆盖。中途失败的任务可以直接重跑。
旧版本流程不支持该特性：创建发布之后任务崩溃，只能手动删除发布与标签，才能重试。

## 密钥轮换
如果release-1或者CI环境被攻陷：
1. 使用release-2替换`MINISIGN_SECRET_KEY`与`MINISIGN_PASSWORD`；
2. 发布由release-2签名的固件。机器人内置信任该公钥（这就是镜像出厂就预装多套公钥的原因）；
3. 在后续版本中，从`trusted_keys_dir`移除`release-1.pub`，停止接受已泄露密钥；
4. 生成新的备用密钥，维持密钥储备：`cargo xtask keygen --kind release --name release-4 --out ~/.duck-keys`

步骤3刻意滞后于步骤2：**不能在所有机器人完成新版本更新前吊销旧密钥**，否则没收到更新的机器人会无法继续更新。

