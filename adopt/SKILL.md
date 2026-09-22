---
name: dev-infra
description: 给一个仓库接上（或事后体检、升级）GinkgoLeafLab 的共享开发基础设施——dev-infra 的可复用工作流与组合动作、分支守卫与 git 钩子，以及 dev-agents 的 agent 角色定义。涉及"接入共享基础设施""新仓库要装门禁""装分支守卫""review / qa 检查不生效""升级 uses 版本号""移子模块指针""agent 角色定义从哪来"时用它。
---

# 接共享开发基础设施

**先读这一条**：这套东西的失效几乎全是**静默**的——钩子少一位可执行位 git 直接跳过、
caller 少一个事件那条路永远不跑、标签没建出来 GitHub 静默不打、必需检查名字钉错了
PR 永远停在 "Expected"。**没有一处会报错**。所以这份技能里的每一步都有「漏了会怎样」，
那不是装饰，是判断该不该省的唯一依据。

## 一条命令就够

```bash
git switch -c chore/接入共享基础设施          # 必须在特性分支上：脚本会让 subtree 造提交

# 全新仓库：先把脚本弄到盘上（它自己会把子模块挂好、钉在最新 tag 上）
git clone --depth 1 https://github.com/GinkgoLeafLab/dev-infra /tmp/dev-infra
node /tmp/dev-infra/adopt/adopt.js            # 要装 QA 门禁就加 --qa

# 已经接过的仓库（体检 / 补齐 / 升级）：用自己那份，它就在子模块里
node vendor/dev-infra/adopt/adopt.js --check  # 只体检，一个字节都不写
```

脚本跑完会逐项打出 ✅ / ℹ️ / ❌ 和一张**只有人点得了**的清单。**退出码 0 = 一条 ❌ 都没有**；
判不了（取不到上游 tag、读不出文件）算 ❌ 不算通过——这是刻意的，
「大概没问题」正是这套东西要消灭的东西。

前提四条，缺一条脚本会直接拒绝，别绕：

| 前提 | 为什么 |
|---|---|
| 在**特性分支**上 | 脚本唯一会造提交的是 `git subtree add`（那两个提交是 subtree 自己造的，绕不开），而在受保护分支上提交正是守卫要拦的事 |
| **工作区干净** | `git subtree add` 自己的 `ensure_clean` 要求索引干净，它没有 `--force` 之类的口子。只想接另外两层就加 `--no-agents` |
| 目标仓库已经是 git 仓库 | 子模块、subtree、gitlink 都是 git 的东西 |
| 目标**不是 dev-infra 自己** | 在那个仓库里 `review-gate.yml` 这三个名字是**可复用工作流本体**，不是 caller，脚本判出来的每一条都是反的，所以它会当场拒绝跑（两种模式都拒绝）。那个仓库自己那一侧接的是同一套东西、形状不一样，由它的 `self-adopt.test.js` 钉着，理由见它 README 的「这个仓库自己也接着这套东西」 |

## 它装的是三层里的哪两层

| 层 | 装什么 | 怎么进来 | 谁能动 |
|---|---|---|---|
| 第一层 | `review-gate` / `qa-gate` / `labels-sync` 三份 caller，`docs-only` 那个步骤 | 各 workflow 里一行 `uses: …@vX.Y.Z` | 脚本写，人评审 |
| 第二层 | 分支守卫、git 钩子、`setup-hooks.js`（submodule）+ agent 角色定义（subtree） | `vendor/dev-infra` 挂 submodule；`.claude/agents/common` 走 subtree | 脚本写，人评审 |
| **第三层** | **仓库设置**：ruleset、必需检查、Environment 凭据 | **人去网页上点** | **agent 改不了，脚本也不会假装它做了** |

**第三层没做完，前两层等于没装**：`review` / `qa` 不是必需检查时，那两个门写出来的
commit status 只是「看得见」，不是「拦得住」。脚本最后那张清单就是这一层，逐条点完。

## 报告里每一条 ❌ 怎么办

| 报的是 | 意思与该做的事 |
|---|---|
| **子模块钉在一个不是 tag 的 commit** | 升级只能靠移到某个 tag 上。`git -C vendor/dev-infra fetch --tags && git -C vendor/dev-infra checkout <tag>`，再 `git add vendor/dev-infra` |
| **gitlink 在，但工作树是空的** | `git submodule update --init --recursive`（这条命令在守卫缺席时是被放行的，就是为了这一刻） |
| **守卫入口和上游模板不一致** | 各仓不该各有一份不一样的守卫入口。确认那些手改真的要留，否则 `--force` 覆盖回去。**在这套脚本之前就接过的仓库第一次跑会报这一条**——那几份是手写的，判定逻辑一致、注释不一致，`--force` 覆盖之后行为不变 |
| **ESM 仓里守卫入口是 `.js`** | `"type": "module"` 的仓库里 `.js` 会被当 ESM 加载，`require` 当场 ReferenceError；而 PreToolUse 把非零退出当 **non-blocking error——命令照常执行**。必须是 `.cjs`。脚本会写对的那一份，旧的要自己 `git rm` 并把 `settings.json` 里那一行改过去 |
| **PreToolUse 直接指进子模块** | 同一个坑的另一半：子模块为空时它非零退出 = 静默放行。改成指 `scripts/guard-hook.cjs`（或 `.js`），**那一份必须是本仓 tracked 的文件** |
| **caller 少了 `synchronize` / 少半个 `if`** | 那条路永远不跑，而且不报错。按脚本重写那份 caller（`--force`），或照它说的补 |
| **钉到 `@main` / `@v1`** | 等于上游一次未经本仓评审的改动当场在这里生效。钉三段式 tag |
| **`qa-labels` 和有没有 qa-gate 对不上** | 给了 `true` 却没 qa-gate = 建两个没人读的标签；有 qa-gate 却没给 = 那两个标签在本仓根本不存在，而 GitHub 对打一个不存在的标签是**静默不打**，QA 那条路从此形同虚设 |
| **`scripts.prepare` 已经是别的内容** | 脚本不覆盖别人的 prepare。自己把 `git submodule update --init --recursive && node vendor/dev-infra/shared/setup-hooks.js` 接进去 |
| **`npm test` 里没有 test:guard** | 守卫那一百多条断言在本仓一次都不会跑。怎么挂逐仓不同（有的是 `test-all.js` 的清单，有的是一串 `&&`），所以脚本只报告 |
| **agent 定义和上游对不上** | 要么有人在本仓改了那几份（改了也传不出去，下次重接原样覆盖），要么 `.claude/agents-common.VERSION` 记的 tag 是假的。别在本仓改那几份，去 `dev-agents` 改 |

## 开 PR 的时候

- **subtree 那三步（`git rm -r` + 提交 → 重新 `add` → 改 `agents-common.VERSION`）必须在同一个 PR 里。**
  第一步之后那个提交的树上**一个角色都没有**；第三步落单的话是树换了、记录停在旧 tag，
  **比没有记录更糟**，因为下一个人会信它
- 这种 PR 在 Files changed 里可能**只看得到 VERSION 改了一行**（上游没变内容时那几份净 diff 为零），
  所以 PR 正文要自己说清这一版做了什么
- 改动都留在工作区，**脚本不提交也不推送**。提交前看一遍 `git diff`
- 合并之后再跑一次 `--check` 验收，并把第三层那张清单点完

## 永远不要做的几件事

- **不要把 `uses:` 钉到 `@main` 或 `@v1`。** 那条不可变 tag 是「未经本仓评审的改动不会生效」的全部依据
- **不要改 `vendor/dev-infra/` 里的任何文件。** 改动进不了本仓的历史（父仓记的是一个 commit id），
  要改去 dev-infra 走 PR、打新 tag，再回来移指针
- **不要在本仓删掉用不上的 agent 角色。** subtree 拉的是上游**整棵根树**，拿不到子集；
  删了验收判据当场红，而下一次重接会原样带回来、**不报错**。「不派某个角色」写在本仓 CLAUDE.md 的角色表里
- **不要给必需检查钉 job 名**（`review-gate / gate` 那种）。要钉的是被调用方用 API 写出来的
  `review` / `qa`，钉错了 PR 永远停在 "Expected — waiting for status"
- **不要给 `test` / `qa-gate` 加 `paths` / `paths-ignore`。** 必需检查被 workflow 级过滤跳过的 PR 上
  根本不会产生这个检查，表现为永远 pending、永远合不了。（`labels-sync` 可以，它永远不是必需检查）
- **不要先合 caller 再打 tag。** dev-infra 那边永远是**先打 tag，再合各仓的 caller**；
  反了的话 `pull_request_target` 取默认分支的定义，之后每个 PR 都撞同一件事，包括来修它的那个

## 升级（和接入是同一个脚本）

| 升什么 | 怎么升 |
|---|---|
| 第一层 | 改各 caller 里那一行 `uses:` 的版本号（各入口钉不同 tag 是正常的，tag 钉的是内容）。**改 `labels-sync.yml` 那一行是标签清单传进本仓的唯一路径**——手动触发、定时重跑都只会重跑同一份旧清单，而且是绿的 |
| 第二层 submodule | `git -C vendor/dev-infra fetch --tags && git -C vendor/dev-infra checkout <新 tag> && git add vendor/dev-infra` |
| 第二层 subtree | `node vendor/dev-infra/adopt/adopt.js --force --agents-tag <新 tag>`（它替你跑那三步；**不要用 `git subtree pull`**：squash 合并会把 subtree 认路用的那两行尾注一起吞掉） |

上游 dev-infra 自己怎么改、tag 怎么打，见那个仓库的 README「改这里的东西之后」。
**打 tag 是人做的**，agent 在会话环境里会拿到 403。
