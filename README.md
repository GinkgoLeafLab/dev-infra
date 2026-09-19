# dev-infra

组织里各仓库共用的 **GitHub Actions 可复用工作流与组合动作**。逻辑只有这一份，
各仓库留一个十几二十行的 caller。

| 在这儿 | 是什么 | 各仓库怎么用 |
|---|---|---|
| `.github/workflows/review-gate.yml` | 可复用工作流 | caller 调它 |
| `.github/workflows/qa-gate.yml` | 可复用工作流 | caller 调它 |
| `.github/workflows/labels-sync.yml` | 可复用工作流 | caller 调它 |
| `.github/actions/qa-gate/` | 组合动作 + 判定脚本 + 它的测试 | **不直接用**，由上面那份工作流调 |
| `.github/actions/labels-sync/` | 组合动作 + 同步脚本 + 它的测试 + **共享的标签清单** | **不直接用**，由上面那份工作流调 |
| `.github/actions/docs-only/` | 组合动作 + 纯文档判定 + 它的测试 | **各仓的 workflow 直接 `uses:` 它**，当成一个步骤用 |
| `shared/` | **第二层的源文件**：必须躺在各仓里才会被读到的那几份脚本与它们的测试 | 各仓 `node scripts/vendor-infra.js --sync <tag>` 拉过去。**落点按清单逐份记**，不是统一放一个目录：脚本落 `scripts/`，`pre-commit` 落 `.githooks/` |
| `.github/workflows/test.yml` | 本仓自己的测试，连同 `shared/` 里那些套件 | 不适用 |
| `submodule-shape.test.js` + `.gitattributes` | 钉住「各仓把这里当 submodule 挂上会拿到什么」 | 不适用 |

取舍见 `GinkgoLeafLab/GTO-Trainer` 的 `docs/方案/2026-09-跨仓库基础设施复用.md`。
一句话：那份方案把要复用的东西按「**能不能没有本地副本**」分三层，
**这个仓库装的是第一层**——GitHub 侧的可执行逻辑，它真的只有一份，改这里就是改了所有仓。

**第二层的源文件也在这里**，装在 `shared/`——那一层的东西必须躺在各仓库里才会被读到，
所以各仓各有一份副本，但**副本的来处只有一个**，就是这里的 `shared/`，靠 sha256 对齐。
边界要说准，两件事不一样：

| 在这个仓库里 | 不在，也不该搬进来 |
|---|---|
| 第一层的可复用工作流与组合动作 | **第二层在各仓的那一半**：清单 `vendor/infra/VERSION`、把那条套件挂进 `npm test` 的接线、各仓自己的 `.gitattributes` 规则——它们**逐仓不同**，而且必须待在那个仓里才生效 |
| **第二层的源文件**（`shared/`），**同步机制 `vendor-infra.js` 自己也在里面** | **第三层**（仓库设置的只读审计）整层 |

## 和 `GinkgoLeafLab/.github` 是两回事，别混

| 仓库 | 装什么 | 名字能不能换 | agent 能不能写 |
|---|---|---|---|
| **`.github`**（公开） | issue 表单、PR 模板（GitHub 的「默认社区健康文件」） | **不能**，GitHub 钉死要叫这个名字 | **不能**，只能人手推 |
| **`dev-infra`**（公开，就是这里） | 可复用工作流 + 组合动作 | 能 | 能，正常走 PR |

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
- **`labels-sync` 连数据也跟着走**：`labels.json` / `labels.qa.json` 和脚本一起下发。
  各仓因此连标签清单都不再各存一份——这是这套机制唯一一处共享的不是逻辑而是**数据**，
  单独说清楚见下面「这里放什么、不放什么」
- 这条路上**一次 checkout 都不做**，`contents: read` 那个坑结构性地没有了
- **`qa-gate.yml` / `labels-sync.yml` 内层引用它们各自的组合动作时，用的是
  GitHub 的自引用语法 `$/`**（`uses: $/.github/actions/qa-gate`），不是
  `owner/repo/path@tag`。`$/` 解析到「这份文件自己所在的仓库，运行时那个
  commit」——官方原文点名了这个形状："if a reusable workflow in one repository
  is called by a workflow in another repository, a `$/` reference in the called
  workflow resolves to the called workflow's repository"。所以这条路上**没有
  第二个版本号要人对齐**，也没有「这个 commit 打算被发成哪个 tag」那种前向引用：
  内层引用永远和这份文件本身是同一个 commit（调研与取舍见
  `GinkgoLeafLab/GTO-Trainer` 的 `docs/方案/2026-09-第一层要不要也走-subtree.md`）。
  **这只管内层这三行**——各消费仓的 caller 仍然要按不可变 tag 钉，见下面「按
  tag 钉，不要按分支」

**组合动作有两种用法，别把第二种当成第一种读。** `qa-gate` 与 `labels-sync`
只被本仓的可复用工作流调，各仓看不见它们；`docs-only` 是**各仓的 workflow 直接
`uses:` 的一个步骤**——判定完各仓自己用 `if:` 决定跳过哪几步，而「跳哪几步」逐仓不同
（跑测试、部署、校验部署配置），判定这件事所有仓一模一样。**`docs-only` 是真跨仓
引用，各仓按不可变 tag 钉；`qa-gate` / `labels-sync` 的内层是同仓自引用，用 `$/`
——两者形状不同是因为调用方不同，别把其中一种的写法套到另一种上。**

跟着这种用法来的还有一条：**`docs-only` 要调用方先 checkout，而且 `fetch-depth: 0`**。
它在调用方的工作区里跑 `git diff`，浅克隆里 base 那个对象根本不存在。
忘了不会静默判错——取不到 base 就打 `::warning::` 并输出 `docs_only=false`，
也就是照常跑测试。**这一层的失败方向永远是「跑测试」那一边。**

**`$/` 之前不是这样，而且代价很大**：`v1.1.0` 的内层写的是 `@v1`（那是「挪 tag」
时代留下来的写法），而 `v1` 指着组合动作还不存在的那个 commit——**那一版的
qa-gate 在每个消费仓上都跑不起来**，`qa` 这个必需检查永远停在
"Expected — waiting for status"，而 `pull_request_target` 取默认分支的定义，
所以**连来修它的那个 PR 自己也合不了**。`$/` 结构性地消灭了这整类失效——
它不看任何 tag，不存在「引用了一个还不存在的 tag」或「引用了一个已经存在、
但内容对不上的旧 tag」这两种可能。`.github/actions/qa-gate/qa-gate.test.js`
的 W3（内层必须精确是 `$/.github/actions/qa-gate`，不许带 `@{ref}`）与 W8
（`$/` 引用的路径在这个仓库里真的存在 `action.yml`）现在钉着这一条，
做过变异验证；`labels.test.js` 的 L3/L9 是同一个形状。

**这也改变了「打 tag 之前验不验得到」这件事，是一处实打实的改善**：以前内层
写的是前向引用，在 dev-infra 的特性分支上指着一个还没打的 tag，所以「新动作 +
新工作流」这套接线**在打 tag 之前没有任何一条流水线验得到**——本仓
`.github/workflows/test.yml` 只能靠拉下 tag 去读一个还不存在的东西，那条路
天然验不动前向引用（`test.yml` 里因此曾经要 `fetch-tags: true`）。换成 `$/`
之后**不再有前向引用**：内层引用和这份文件本身永远同一个 commit，
`test.yml` 在合并前的每一次 PR 上就能验到「新动作 + 新工作流」这套接线，
`fetch-tags: true` 也因此不再需要。

## 这个仓库是公开的

所以各仓的 caller 直接 `uses:` 就行，**不需要配 PAT，也不需要任何放行设置**。

反过来也成立、而且要记住：**任何人都能 `uses:` 这三条可复用工作流。**
那不构成风险——它们跑在调用方自己的仓库里、用调用方自己的 `GITHUB_TOKEN`，
碰不到我们的任何东西。**别因为看见这一条就把仓库改回私有。**

**万一哪天真的改回私有**（或者照这套东西新建一个私有的共享仓），
那就必须去 **Settings → Actions → General → Access** 选
"Accessible from repositories in the 'ORGANIZATION' organization"——
官方原话，同一个开关同时管可复用工作流与组合动作：

> When you configure this setting, workflows in other repositories that are part of the
> 'ORGANIZATION NAME' organization can access the actions and reusable workflows in this repository.

**这一步是人点的，agent 改不了仓库设置。** 漏点的表现：各仓的 gate job 直接失败 →
检查写不上 → PR 被拦住。**失败方向是安全那边**（不会静默放行），但会红一片。

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

`labels-sync` 的 caller 又是另一个形状，**两处差异都正好是会写错的地方**：

```yaml
name: labels-sync
on:
  # 清单不在这个仓里了，所以这个仓的日常 push 不改变该同步什么。
  # **真正会改变结果的只有一件事：下面那一行 `uses:` 的版本号变了。**
  # 清单是跟着组合动作在那个 tag 上下发的，而 tag 不移动——dev-infra
  # 那边改了清单，也要等这一行升上去才传得过来。见下面那段。
  push:
    branches: [main]
    paths:
      - .github/workflows/labels-sync.yml
  workflow_dispatch:
permissions: {}
jobs:
  sync:
    permissions:
      issues: write   # 建标签、改标签。**不是** statuses/pull-requests
    uses: GinkgoLeafLab/dev-infra/.github/workflows/labels-sync.yml@v1.4.0
    with:
      # **只有真的装了 qa-gate 的仓才给 true。** 给了 true 却没有 qa-gate，
      # 等于在这个仓里建两个没有任何东西在读的标签、还给了它们一份正式定义。
      qa-labels: true
```

**这条流水线可以用 `paths`**：`test.yml` / `qa-gate.yml` 上那条禁令的理由是
「必需检查被 workflow 级过滤跳过会停在 `Expected — waiting for status`」，
而这条**永远不是必需检查、也不在 PR 上跑**。**那个理由不可外推**，
别拿它去给别的流水线加 `paths`。

**清单改了不会自己传到各仓，而且只有一条路传得过去：升 caller 里那一行 `uses:`。**
caller 钉的是 `…/workflows/labels-sync.yml@vX.Y.Z`；那个 tag 上的工作流内层用
`$/` 引用它自己的组合动作，`$/` 解析到「这份文件所在的仓库，运行时那个
commit」——也就是 caller 钉的**同一个** tag 指向的那个 commit，不需要再钉第二个
版本号（内层以前按 `…/actions/labels-sync@vX.Y.Z` 单独钉一次，见上面「为什么有
组合动作这一层」）。清单**跟着组合动作在那同一个 commit 上**下发
（`action.yml` 里 `BASE: ${{ github.action_path }}/labels.json`）。tag 不移动，
所以**不升 caller 那一行版本号就永远是那份旧清单**——`workflow_dispatch` 是这样，
`schedule` 也是这样（它追的始终是自己钉着的那个 tag，追不上一个更新的清单）。

**走错这条路是绿的**：run 成功，dry-run 那一步照常打印一份「没什么要做」的计划，
没有任何东西会说它算的是旧清单。

`workflow_dispatch` 仍然留着，但它的用途是另一件事：**把有人在网页上手改出的偏差，
按当前钉着的那份清单对回来。**（同理，想定期对偏差就加 `schedule`，
代价约一分钟 Actions 时间——但它买到的是纠偏，不是追新清单。）

**三份 caller 都没有 `contents: read`，也都不该有**——见上面「为什么有组合动作这一层」。
`permissions` 三份各不相同（`review-gate` / `qa-gate` 要
`statuses: write` + `pull-requests: write`，`labels-sync` 要 `issues: write`），
**照着自己那一份抄，别抄隔壁那份**。

### `docs-only` 不是 caller，是一个步骤

上面三份都是「caller 调一条可复用工作流」。`docs-only` 是另一种形状：
**各仓在自己已有的 job 里，把它当一个步骤用**，判定完自己决定跳过哪几步。

```yaml
      - uses: actions/checkout@v7
        with:
          # 判定要 diff base 和 head 两个 commit，浅克隆里 base 根本不存在。
          # **这一行是前提，不是优化。**
          fetch-depth: 0

      - name: 判断是不是纯文档改动
        id: scope
        uses: GinkgoLeafLab/dev-infra/.github/actions/docs-only@v1.7.0
        with:
          base: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before }}
          head: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}
          # PR 的改动要相对**分叉点**算（三点 diff），否则 base 分支自己往前走一步，
          # 别人的改动就会被算进这个 PR。推送到主干是两点 diff。
          merge-base: ${{ github.event_name == 'pull_request' }}
          # 只改那条 ::notice:: 的措辞，判定逻辑不受它影响。不给就是「npm test」。
          skipped: npm test 与内测部署

      - run: npm ci
        if: steps.scope.outputs.docs_only != 'true'
      - run: npm test
        if: steps.scope.outputs.docs_only != 'true'
```

三条容易写错的：

- **跳过的是 job 里的步骤，不是 job**，更不是 `paths` / `paths-ignore`。
  `test` 那条是必需检查，被 workflow 级过滤跳过的 PR 上这个检查根本不会产生，
  表现为永远 pending、那个 PR 永远合不了。这条禁令在各仓的 `test.yml` 上是同一条
- **这个 job 要 checkout，所以它确实需要 `contents: read`**——
  上面那句「三份 caller 都没有 `contents: read`」说的是那三份 caller，别推广到这里
- **判定绿了不代表那件事做了。** 跳过时它会在检查页上打一条 `::notice::` 说明这一点，
  各仓的 `skipped:` 就是那句话里的宾语，写准它

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

1. 在这个仓库走 PR、评审、合并。**`qa-gate.yml` / `labels-sync.yml` 内层那三行
   自引用用的是 `$/`，这一步不用再改它们**——`$/` 自动跟着这个 commit 走，
   没有第二个版本号要在 PR 里对齐（以前按 `@vX.Y.Z` 引用时，那一行写的就是
   「该打哪个 tag」的唯一真相；这一条随着换成 `$/` 一起作废，见上面「为什么有
   组合动作这一层」）
2. **在合并后的 commit 上打一个新 tag。** 打哪个版本号是普通的语义化版本判断
   （这个改动是不是破坏性变更、只是加功能还是纯修 bug），不再从内层引用的哪一行读出来。
   **这一步是人做的**（agent 在这个环境里打不了 tag，会拿到 403）
3. 各仓库把自己 caller 里的 `uses:` 升到新版本，走各自的 PR 与评审

**顺序反了会红一片**：消费仓的 caller 先合、tag 后打，那些 caller 指向一个不存在的
版本，job 当场失败——而 `pull_request_target` 取默认分支的定义，所以那之后
**每个 PR 都撞同一件事，包括来修它的那个**。所以永远是**先打 tag，再合 caller**。

## `shared/`：第二层的源文件

这里面装的是**必须躺在各消费仓里才会被读到的可执行文本**——今天是分支守卫
（连同 `shared/githooks/pre-commit` 那个钩子）、装 hook 那个脚本、**同步机制自己**，
以及**它们各自的测试**。

**钩子单独一个目录 `shared/githooks/`，不散在 `shared/` 根下**，这是刻意的：
消费仓的 `core.hooksPath` 将来指向那个目录，所以**放进去的任何一个按钩子命名的文件
都会在每一个消费仓自动生效**。目录里装什么由 `submodule-shape.test.js` 的白名单钉着，
加一个钩子必须同时改那一行——这个显式性不能丢。
它们没法做成组合动作，判据是**谁在调它**：这几份的调用方都是各仓本地的一条路径——
`guard-branch.js` 由 `.claude/settings.json`（PreToolUse hook）与 `.githooks/pre-commit`
调用，`setup-hooks.js` 由 `npm prepare` 调用，`vendor-infra.js` 是把这一切拉进来的
那一下——**那几条路都读不到别的仓库**。

反过来也是同一条判据：**只被 CI 的 `run:` 调用的东西不属于这一层**，
它做得成组合动作。`docs-only` 原来在这儿，正是按这条判据搬走的
（`qa-gate.js` 更早一步，各仓现在连那个文件都没有了）。

所以这一层**有副本**，而这里是副本的唯一来处。

**机制落地了，但只落在一个仓。** `GTO-Trainer` 已经接上（它的 `npm test` 里有这条），
`GTO-Trainer-engine` 与 `GTO-Trainer-studio` **还没有**。
**在没接的那两个仓里，`shared/` 只是来处，没有任何东西拦得住有人手改它们的副本。**

接上了的仓是这样：那个仓的 `vendor/infra/VERSION` 逐份记着
**落点路径 + 来处 + sha256 + 文件模式**，`node scripts/vendor-infra.js --check`
在那个仓的 `npm test` 里对一遍，手改副本 → 那个仓的测试红。

**「文件模式」是单独一项，不是多余的**：sha256 只比内容，**永远比不到可执行位**。
而 `.githooks/pre-commit` 少了那一位，git 直接跳过、**不报任何错**。
所以那一位必须由清单载着、由 `--sync` 显式打上、由 `--check` 对着查——
靠源文件自己的模式传不过去（`fs.writeFileSync` 新建出来的文件本来就不带它）。

**钩子在这个仓库里现在是 `shared/githooks/pre-commit`，而且是 `100755`。**
它曾经是 `shared/pre-commit` / `100644`——推文件用的 GitHub Contents API 一律写 100644，
而这套工具里没有能设模式的口子，所以那一位是**人手动打上去的**，一次。
打上之后它活在这个仓库的对象库里，**submodule 那条路直接载着它走**。

**`--sync` 那条路不是这样，别把两者混成一句**：它照**消费仓清单里那一项**打模式
（`shared/vendor-infra.js` 里那句注释写得很直白——「模式是清单说了算，不是上游那份源文件
说了算，它载不动这一位」），上游这一位在那条路上一次都不会被读到。
所以清单里的 `mode` 字段**不能因为上游打了这一位就去掉**。

`submodule-shape.test.js` 钉着这一位，做过变异验证：打回 `100644` 当场红。

### 同步机制自己也在 `shared/` 里

`vendor-infra.js` 和它的测试**就住在这里**，和被它们校验的那几份文件并排。
不这么做的话它会在每个消费仓里各有一份逐字相同的副本——**正是这一层要治的病**。

落法和别的没两样：各仓清单里有它自己的一行，`--check` 拿 sha256 把自己也对一遍。
两件事要说准，别把它想得比实际强：

- **第一次接进一个新仓时手里还没有它。** 那一次要人工放进来（连同清单），
  之后它就自己管自己了
- **「自己校验自己」的边界比直觉窄。** 它是**唯一的检查者**，所以绕过它
  **只要动这一个文件、清单一个字节都不用碰**：把 `checkFiles` 掏空就行，
  `--check` 照样打印「OK（N 份）」并且 `exit=0`，而这时失效的**不是它自己那一行，
  是全部 N 份一起**（实测过）。同一份实现自己验自己，这条防不住、也加不出防御来，
  是固有性质不是缺陷。所以判据只有一条，而且它不依赖读者认出某种 diff 形状：
  **任何碰 `scripts/vendor-infra.js` 的 diff，都当成「在拆守卫」来审。**
  这一层真正挡得住的是**无意的漂移**——手改了一份副本、丢了可执行位、忘了某个仓还没跟上

**它的测试在这个仓库里跑不了**，这是刻意的：那份测试有一条断言要对
**真的这个仓库**跑一次 `check()`，而这里是来处、不是消费者，没有 `vendor/infra/VERSION`。
所以 `test.yml` 对这两份只做 `node --check` 的语法检查，真套件在各消费仓里跑。
**别为了让它在这儿也能跑而把那条断言改成「有清单才验」**——
那样一个消费仓弄丢清单之后它会静默跳过。

**判据和「共享的数据清单」那条一样：各仓应该完全一致的才放这儿。**
所以这些文件里不许出现只对某一个仓成立的东西——具体路径、某个仓的流水线清单、
「这个仓库的 docs/ 下全是中文文件名」这种。写成条件（「接这份文件的仓库要自己确认……」）
或者干脆挪回那个仓自己的文件里。**这一条没有自动检查，靠评审。**

### 往 `shared/` 加一份文件，各仓不会自动拿到

和上面 labels 清单那条是同一个形状，但拦法不同、**这条不是绿的**：
各仓的清单里有一项 `source_files`，记着同步那一刻这里有哪些文件。
`--check` 要求 `source_files` 里每一条**恰好**出现在「拿了」或「刻意不拿」之一——
所以那个仓下次 `--sync` 时，多出来的这一份会让它**报错停下**，
由人决定拿还是显式写明不拿（`skipped` 里必须写理由，没理由的不算数）。

**「刻意不拿」和「漂了」必须分得开**，这是这套机制存在的前提之一：
今天 `GTO-Trainer-engine` 只有四个通用角色文件而别的仓有八个，那是**有意的**。
机制表达不了这件事，它就会把两者混成一类，然后被人一起忽略。

## 这里放什么、不放什么

| 放 | 不放 |
|---|---|
| `on: workflow_call` 的可复用工作流 | **任何凭据**：token、密钥、`.env`、证书 |
| 组合动作，以及它们要跑的脚本**和那些脚本的测试** | 只对某一个仓库成立的逻辑——那属于那个仓库 |
| **`shared/`**：各仓应该完全一致、却必须有本地副本的可执行文本。判据与边界见上一节，**这里不重复一遍**（两处写同一件事必然漂） | |
| **共享的数据清单**（`labels.json` / `labels.qa.json`）——判据是「各仓应该完全一致」。标签就是这样：名字是跨系统契约（issue 表单、caller 的 `if`、各仓 CLAUDE.md 都按名字引用），各存一份的结果是静默漂开 | **某个仓才需要的那一份数据**。一旦某个仓需要自己的清单，它就不属于这里——`qa-*` 单独一份而不是塞进基础清单，就是这条边界的第一次生效 |
| | **只对某一个仓库成立的「事实」**：具体 PR 号当现象引用、某个仓的文件路径、某个仓才有的约定。这里的注释会被所有仓读到，写成「在 X 上实测过」而不是「在这个仓库实测过」 |
| | issue / PR 模板（那是 `.github` 仓的活，机制完全不同） |
