# 合并时自动打 tag（tag-on-merge）

- **日期**：2026-09
- **状态**：已落地——本体 GinkgoLeafLab/dev-infra#43（随 `v1.19.0` 发布，那是最后一个手打的 tag）；本仓接上 `self-tag-on-merge.yml` 在紧接着的那个 PR
- **触发**：dev-infra 每次合并之后都要人手打一个新 tag，agent 在会话环境里打 tag 拿 403；
  dev-agents、dev-standards 是同一件事。这份方案是**补写的**——实现和它在同一个 PR 里，
  不是动手之前写的，这一点照实写在这里。

## 要解决什么问题

**「合并之后打一个新 tag」这一步只有人做得了，而它漏掉的代价在 dev-infra 身上最贵。**

README「改这里的东西之后」规定了顺序：**先打 tag，再合各仓的 caller**。反过来，caller 指向
一个不存在的版本，而 `pull_request_target` 取默认分支的定义，那之后**每个 PR 都撞同一件事，
包括来修它的那个**（v1.1.0 就是这么发坏的）。这条顺序今天完全靠人记得：

| 仓库 | 手打过的 tag | 打法 |
|---|---|---|
| dev-infra | v1.1.0 ~ v1.18.0（十八个） | 全是 minor，纯 README 的合并不打 |
| dev-agents | v1.0.0 ~ v1.3.0（四个） | 全是 minor，每个 PR 一个 |
| dev-standards | v1.0.0 | — |

（数据来自各仓的 `git tag` 与 `git log --decorate`，2026-09-30。）

## 调研

> 每一条都读过原文或实调过；拿不到的写「拿不到」。

### 事实一：`GITHUB_TOKEN` 给「不是分支 tip 的 commit」建 tag 会被拒

GitHub 把「新建一个 tag」当成「按那个 commit 的内容创建 workflow 文件」，拿它和分支 tip 比；
只要 `.github/workflows/` 不一样，就要求 `workflows` 权限，而 `GITHUB_TOKEN` 拿不到这个权限：

- <https://github.com/orgs/community/discussions/151442>（原话："It is not possible to push a git tag
  from GitHub Actions using the `GITHUB_TOKEN` if the tag points to a commit where the contents of
  `.github/workflows/` are not identical to the contents of `.github/workflows/` on the latest commit
  of any branch"）
- <https://github.com/blinkbitcoin/shared-workflows/issues/29>（同一个现象，走的是 REST `POST git/refs`，
  修法是「趁 commit 还是 tip 的时候建」）

**这条直接决定了「打在哪」**：打在触发这次运行的那个 commit 上，一旦中间又合了一个改
workflow 的 PR，补打就不通了。所以打在**运行那一刻 main 的 tip**。

### 事实二：「这个 commit 是哪个 PR 合进来的」有现成接口，标签也在返回里

`GET /repos/{owner}/{repo}/commits/{sha}/pulls`：对默认分支上的 commit 返回把它合进来的 PR。
实调 `GinkgoLeafLab/dev-infra` 的 `ca50398`（2026-09-30）：返回 `#41`，`merged_at` 有值，
`base.ref = main`，`labels = []`——脚本读的就是这几个字段。

### 事实三：caller 和被调用的可复用工作流撞同一个并发组会死锁

被调用方里 `github.workflow` 解析成 caller 的名字，两边声明同一个组时，caller 占着那个组、
被调用方永远等不到，GitHub 在启动时直接取消。多个仓库踩过并各自修过，例如
<https://github.com/TE-ToshiakiTanaka2/tarnished/issues/322>、
<https://github.com/alcash55/ac-composite-actions/issues/68>。所以并发组只写在 caller。

### 事实四：嵌套在子目录里的 `.github/workflows/` 不是 workflow

dev-agents 的根树会被 subtree 拉进各仓的 `.claude/agents/common/`，它的 caller 也会跟着进去。
GitHub Actions 只认仓库根下的 `.github/workflows/`（<https://github.com/actions/runner/issues/2102>，
<https://github.com/orgs/community/discussions/143998>）；Dependabot 的 github-actions 生态
`directory: "/"` 只扫根下的 `/.github/workflows`
（<https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference>）。
**Renovate 例外**：它 github-actions 管理器的默认匹配是 `(^|/)(workflow-templates|\.(?:github|gitea|forgejo)/(?:workflows|actions))/.+\.ya?ml$`，
嵌套的也认（<https://docs.renovatebot.com/modules/manager/github-actions/>）。

### 现成的东西：查了，为什么不用

| 现成方案 | 它怎么定版本号 | 为什么不用 |
|---|---|---|
| [Conventional Commits](https://www.conventionalcommits.org/) + [semantic-release](https://github.com/semantic-release/semantic-release) / [release-please](https://github.com/googleapis/release-please) | 从 commit 信息的 `feat:` / `fix:` / `BREAKING CHANGE` 推 | 这几个仓的提交信息是**中文自由写法的 squash 标题**（`docs-only 加可选输入 not-docs：…`），没有类型前缀。用它就要改所有仓的提交约定，而一个写错的前缀会**静默**推出错的版本号——标签至少是一个看得见、合并后还能改的东西 |
| [release-drafter](https://github.com/release-drafter/release-drafter) | **按 PR 标签**，`version-resolver` 取最高一级，默认 `patch` | **最接近的一个**，思路相同。不用的理由：① 它的产物是 GitHub Release 草稿，要 `publish` 了才有 tag，而这几个仓不用 Release；② 它的 `commitish` 默认是触发运行的那个分支/commit，照样撞事实一；③ 一个第三方动作要拿 `contents: write` 进每一个仓的供应链，而这个仓库的做法是「判错会出事的逻辑自己持有、自己的测试钉着」（README「为什么有组合动作这一层」）；④ 标签矛盾时它取最高，不报错 |
| [mathieudutour/github-tag-action](https://github.com/mathieudutour/github-tag-action) 这一类 | 从 commit 信息推，默认 patch | 同第一行，而且默认 patch 和这几个仓的实际做法（全是 minor）对不上 |

## 备选方案

| 方案 | 结论 |
|---|---|
| **什么都不做**：继续人手打 | 代价就是上面那张表：每次合并都要人在场，顺序没人兜着；agent 做不了。**不选**，但它是失败时的兜底——自动那条路红了，就回到人手打 |
| 各仓各放一份自己的脚本 | 这正是这个仓库存在要消灭的东西（「逻辑只有这一份」）。**不选** |
| 必须挂标签（不挂就红） | 每个 PR 多一道手续，而历史上 23 个 tag 全是 minor——绝大多数 PR 挂的都会是同一个标签。**不选**：默认值照抄实际做法，只让例外去挂 |
| 按路径猜「纯文档不打」 | `adopt/SKILL.md` 这种 `.md` 是各仓顺着子模块真的会读到的。**不选**：给 `release/skip`，让人说 |
| **可复用工作流 + 组合动作 + caller 模板，按 PR 标签定级，默认 minor** | **选定** |

## 选定方案

### 不变式

1. **只建不改。** 只调 `POST /git/refs`（已存在返回 422，不覆盖），没有 PATCH、没有 force。
   tag 不移动是整套「钉 tag」的前提，测试里有一条专门钉源码里不许出现这几样
2. **判不了就不打，而且出声**（非零退出）。不打的代价是「这一版暂时没有 tag」，打错的代价是
   **一个收不回来的版本号**——两边不对称
3. **打在运行那一刻 main 的 tip 上**（事实一）；建的那一刻 tip 又动了，重新 fetch、按新 tip 重算
4. **看的是「上一个 tag 到 tip」之间合进来的所有 PR，取最高一级**：被并发组挤掉、或者红过的
   那几次，下一次会一起算进来

### 版本号

| PR 上挂的标签 | 打出来的 tag |
|---|---|
| （不挂） | 升 minor |
| `release/major` | breaking change，升 major |
| `release/patch` | 很小的改动，升 patch |
| `release/skip` | 不打；跟着下一个要打 tag 的 PR 进那一版 |

恰好一个，挂两个判矛盾。标签按名字认，所以名字只许一处真相：清单
`labels.release.json` 和脚本常量由 `labels.test.js` 的 1c 比对；由 labels-sync 新的
`release-labels` input 建进各仓（默认 `false`，和 `qa-labels` 同一条理由）。

### 形状

和 qa-gate / labels-sync 同形：`.github/workflows/tag-on-merge.yml`（`workflow_call`）内层用 `$/`
调 `.github/actions/tag-on-merge`；各仓一个 caller（`adopt/templates/tag-on-merge.yml`），
由 `lintCaller('tag-on-merge')` 体检；adopt 加 `--tag-on-merge`。和另外三份 caller 不同的两处：
**push 触发**（跑在合并之后，读的是 main 上评审过的东西）、**要 `contents: write`**（要 checkout
调用方仓库读 git 历史，还要往里建 tag——这是唯一一条要读调用方 git 历史的共享流水线）。

### 明确不做什么

- **不建 GitHub Release、不写 CHANGELOG。** 这几个仓都不用它们
- **不在 PR 上做「你挂的标签对不对」的检查。** 默认值就是答案，不挂不算错
- **不支持 main 以外的默认分支、不支持 `vX.Y.Z` 以外的 tag 形状。** 撞上会出声地判不了，不会猜
- **本仓自己这一侧这次不接。** 本仓 caller 按 tag 钉自己，第一个带本体的 tag 要人手打，
  之后一个 PR 加 `self-tag-on-merge.yml`（README「本仓自己是怎么接上的」）

### 已知边界（写下来，而不是让它静默）

1. **`release/*` 标签没建之前挂不上**，一律按默认 minor 打——GitHub 对打一个不存在的标签
   是静默不打。缓解：`--check` 判「装了 tag-on-merge」和「`release-labels: true`」一致
2. **组织设置 / tag ruleset 会不会拦 github-actions 建 tag，拿不到**（会话里没有仓库设置的读权限）。
   拦了的表现是合并后那次运行 403 变红、这一版没有 tag——失败方向是安全那边，且看得见
3. **开了 Renovate 的消费仓**会看见 dev-agents 那份随 subtree 进来的 caller（事实四），
   要 `ignorePaths: [".claude/agents/common/**"]`。消费仓都是私有的，**有没有哪个开了没有查**
4. commit 刚合进来的那几秒，「它是哪个 PR 合进来的」偶尔还查不到：等 5 秒重查，三次都没有才算判不了

## 代价

- **Actions 时间**：每次合并一次约半分钟的 job（checkout 全历史 + 每个新 commit 一次 API 调用）。
  dev-infra / dev-agents / dev-standards 都是公开仓库，Actions 分钟数不计费；私有仓接了才算钱，
  量级是「每次合并半分钟」
- **维护**：一份约 380 行的脚本 + 约 460 行的测试。它判错的后果不可逆，所以测试比脚本长：真 git 仓库 +
  假 API 的端到端（含「建 tag 那一刻 tip 往前走」），每一条关键判定都做过变异验证
- **新的失效方式**：以前「漏打」是人忘了；现在「漏打」是一次红掉的运行——**更好找，但前提是
  有人看 Actions**。它红着的时候去合各仓升 `uses:` 的 PR，结果和以前忘了打 tag 一模一样
- **一个默认值替人做了判断**：不挂标签就是 minor。一次真的 breaking change 忘了挂 `release/major`，
  会被打成 minor，而且 tag 收不回来。这是用「每个 PR 少一道手续」换来的，历史数据说这个交换划算

## 怎么算做完了

1. dev-infra 手打 v1.19.0 之后，`self-tag-on-merge.yml` 那个 PR 合并的那一刻，dev-infra 自动打出下一个 tag
2. dev-agents、dev-standards 接上两份 caller（tag-on-merge + labels-sync `release-labels: true`），
   各自合并后自动打出下一个 tag、`release/*` 三个标签出现在各自仓库里
3. 那之后任意一个挂了 `release/patch` 的 PR 合并，打出来的是 patch
