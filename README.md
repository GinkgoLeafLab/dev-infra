# dev-infra

组织里各仓库共用的 **GitHub Actions 可复用工作流与组合动作**。逻辑只有这一份，
各仓库留一个十几二十行的 caller。

| 在这儿 | 是什么 | 各仓库怎么用 |
|---|---|---|
| `.github/workflows/review-gate.yml` | 可复用工作流 | caller 调它 |
| `.github/workflows/qa-gate.yml` | 可复用工作流 | caller 调它 |
| `.github/actions/qa-gate/` | 组合动作 + 判定脚本 + 它的测试 | **不直接用**，由上面那份工作流调 |
| `.github/workflows/test.yml` | 本仓自己的测试 | 不适用 |

取舍见 `GinkgoLeafLab/GTO-Trainer` 的 `docs/方案/2026-09-跨仓库基础设施复用.md`。
一句话：那份方案把要复用的东西按「**能不能没有本地副本**」分三层，
**这个仓库装的是第一层**——GitHub 侧的可执行逻辑，它真的只有一份，改这里就是改了所有仓。

（第一层之外还有两层：必须躺在各仓库里才会被读到的文本走 vendor + sha256 校验；
仓库设置只做只读审计。它们不在这个仓库里，也不该搬进来。）

## 和 `GinkgoLeafLab/.github` 是两回事，别混

| 仓库 | 装什么 | 名字能不能换 | agent 能不能写 |
|---|---|---|---|
| **`.github`**（公开） | issue 表单、PR 模板（GitHub 的「默认社区健康文件」） | **不能**，GitHub 钉死要叫这个名字 | **不能**，只能人手推 |
| **`dev-infra`**（私有，就是这里） | 可复用工作流 + 组合动作 | 能 | 能，正常走 PR |

## 为什么有「组合动作」这一层

可复用工作流**带不了文件**。`qa-gate` 的判定是一段 node 脚本（它判错一次的后果是
「一个标了必须测的 PR 拿到绿检查」，所以必须待在有测试钉着的地方，不能写进 YAML），
而脚本要真的躺在 runner 的磁盘上才跑得起来。

以前各仓的办法是 `actions/checkout` 自己的仓库去取 `scripts/qa-gate.js`——
于是那份脚本在每个仓库里各存一份（**实测过：`GTO-Trainer` 与 `GTO-Trainer-studio`
的两份逻辑一个字节都不差，差的只是注释里写的是哪个仓**），而且那个 job 必须自己写
`contents: read`，漏了会报 `remote: Repository not found`，指不到权限上。

组合动作可以带文件：GitHub 会把这个仓库在指定 tag 上的内容取到 runner 上，
路径是 `$GITHUB_ACTION_PATH`。所以现在：

- 脚本只有这一份，各消费仓**不再需要 `scripts/qa-gate.js`**
- 这条路上**一次 checkout 都不做**，`contents: read` 那个坑结构性地没有了
- 版本号出现两次（caller → 工作流，工作流 → 动作），而**两处各钉各的**——
  tag 不移动，所以内层那一行必须写**这个 commit 自己打算被发成的那个 tag**，
  是个前向引用：合并的那一刻它还不存在，打上 tag 它才解析得开

**这两条混用过一次，代价很大**：`v1.1.0` 的内层写的是 `@v1`（那是「挪 tag」时代
留下来的写法），而 `v1` 指着组合动作还不存在的那个 commit——**那一版的 qa-gate
在每个消费仓上都跑不起来**，`qa` 这个必需检查永远停在
"Expected — waiting for status"，而 `pull_request_target` 取默认分支的定义，
所以**连来修它的那个 PR 自己也合不了**。`.github/actions/qa-gate/qa-gate.test.js`
的 W3（必须是完整的 `vX.Y.Z`，不许 `@v1` 这种会动的名字）与 W8
（这个 tag 如果已经存在，它必须真的含有这个动作）现在钉着这一条，做过变异验证。

**代价说清楚**：在 dev-infra 的特性分支上，那一行指着一个还没打的 tag，
所以「新动作 + 新工作流」这套接线**在打 tag 之前没有任何一条流水线验得到**。
兜底的是本仓 `.github/workflows/test.yml`：判定逻辑和接线形状
（不许加 checkout、按不可变 tag 引用、脚本走 `$GITHUB_ACTION_PATH`）
都有源码断言钉着，做过变异验证。

## 前提：私有仓的可复用工作流与动作要显式放行

官方原话：

> The called workflow is stored in a private repository and the settings for that repository allow it to be accessed.

**同一个开关同时管动作**——官方那一页标题就叫
*Sharing actions and workflows from your private repository*，原话：

> You can share an action or reusable workflow with your organization without publishing
> the action or workflow publicly.

> When you configure this setting, workflows in other repositories that are part of the
> 'ORGANIZATION NAME' organization can access the actions and reusable workflows in this repository.

所以组合动作不需要另配 PAT。落地是这个仓库的 **Settings → Actions → General → Access**，
要选 "Accessible from repositories in the 'GinkgoLeafLab' organization"。
**这一步是人点的，agent 改不了仓库设置。**

漏点的表现：各仓的 gate job 直接失败 → 检查写不上 → PR 被拦住。
**失败方向是安全那边**（不会静默放行），但会红一片。

## 怎么用

各仓库放一个 caller，例如 `.github/workflows/review-gate.yml`：

```yaml
name: review-gate
on:
  pull_request_target:
    types: [labeled]
permissions: {}
concurrency:
  group: review-gate-${{ github.event.pull_request.number }}
  cancel-in-progress: false
jobs:
  gate:
    if: github.event.label.name == 'review-passed'
    permissions:
      statuses: write       # 写 `review` 这个 commit status
      pull-requests: write  # 摘标签
    uses: GinkgoLeafLab/dev-infra/.github/workflows/review-gate.yml@v1.2.0
```

`qa-gate` 的 caller 多两样，**每一样都不能省**：

```yaml
name: qa-gate
on:
  pull_request_target:
    # synchronize 一条都不能少：推了新 commit 就是新 SHA，新 SHA 上必须重新报告一次。
    # 漏报一次，那个 PR 永远停在 "Expected — waiting for status"。
    # 同理不许加 paths / paths-ignore。
    types: [opened, reopened, synchronize, labeled, unlabeled]
permissions: {}
concurrency:
  group: qa-gate-${{ github.event.pull_request.number }}
  cancel-in-progress: false
jobs:
  gate:
    # 标签事件只认 qa-* 那两个，别的标签连 runner 都不起。
    if: >-
      (github.event.action != 'labeled' && github.event.action != 'unlabeled')
      || startsWith(github.event.label.name, 'qa-')
    permissions:
      statuses: write       # 写 `qa` 这个 commit status
      pull-requests: write  # 摘 qa-passed 标签
    uses: GinkgoLeafLab/dev-infra/.github/workflows/qa-gate.yml@v1.2.0
```

**这里没有 `contents: read`，也不该有**——见上面「为什么有组合动作这一层」。

### caller 里那三样必须留在 caller

搬进被调用的那份文件，**每一样的失效都是静默的**：

| 留在 caller 的 | 搬走会怎样 |
|---|---|
| `on:` | 可复用工作流没有自己的触发器，事件永远来自 caller——**搬不走** |
| **job 级的 `if:`** | job 级的 if 为 false 时 runner 根本不会起、不计分钟数；搬进去就变成「起了 runner 再判断」。**功能完全正常，只有账单变了** |
| `permissions:` | 官方明写权限取自 calling job，被调用方**只能降不能升**——写在被调用方是没用的 |

### 按 tag 钉，不要按分支

```yaml
uses: GinkgoLeafLab/dev-infra/.github/workflows/review-gate.yml@v1.2.0 # ✅
uses: GinkgoLeafLab/dev-infra/.github/workflows/review-gate.yml@main   # ❌
```

`@main` 意味着这里一次未经各仓评审的改动**当场在所有仓生效**。
`{ref}` 可以是 SHA、tag 或分支名，我们用 tag。

## 改这里的东西之后

**tag 不移动，永远是打一个新的。** 这正是「未经各仓评审的改动不会生效」那句话成立的
原因：升级只能靠改各仓 caller 里那一行 `uses:`，而那一行要在各仓被评审。

1. 在这个仓库走 PR、评审、合并。**改 qa-gate 时，PR 里就要把
   `.github/workflows/qa-gate.yml` 内层那一行 `uses:` 改成这次要发的版本号**——
   那一行就是「该打哪个 tag」的唯一真相
2. **在合并后的 commit 上打那个 tag。** 照着上面那一行写的版本号打，别另想一个。
   **这一步是人做的**（agent 在这个环境里打不了 tag，会拿到 403）
3. 各仓库把自己 caller 里的 `uses:` 升到新版本，走各自的 PR 与评审

**顺序反了会红一片**：消费仓的 caller 先合、tag 后打，那些 caller 指向一个不存在的
版本，job 当场失败——而 `pull_request_target` 取默认分支的定义，所以那之后
**每个 PR 都撞同一件事，包括来修它的那个**。所以永远是**先打 tag，再合 caller**。

## 这里放什么、不放什么

| 放 | 不放 |
|---|---|
| `on: workflow_call` 的可复用工作流 | **任何凭据**：token、密钥、`.env`、证书 |
| 组合动作，以及它们要跑的脚本**和那些脚本的测试** | 只对某一个仓库成立的逻辑——那属于那个仓库 |
| | **只对某一个仓库成立的「事实」**：具体 PR 号当现象引用、某个仓的文件路径、某个仓才有的约定。这里的注释会被所有仓读到，写成「在 X 上实测过」而不是「在这个仓库实测过」 |
| | issue / PR 模板（那是 `.github` 仓的活，机制完全不同） |
