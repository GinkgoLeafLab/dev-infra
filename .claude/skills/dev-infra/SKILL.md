---
name: dev-infra
description: 这个仓库（GinkgoLeafLab/dev-infra）自己和共享开发基础设施之间的接线——它既是那套东西的上游，也是它自己的消费者，两侧的规矩不一样。涉及"改这里之后怎么打 tag""本仓自己那一侧的门禁/守卫""adopt 脚本为什么在这儿拒绝跑""agent 角色定义从哪来"时用它。
---

# 共享基础设施：这个仓库两侧的规矩

**这个仓库是上游本身**，所以它有别的仓没有的两条：

1. **改了这里的东西，tag 是人打的、而且永远是打一个新的**（agent 在会话环境里拿 403）。
   顺序永远是**先打 tag，再合各仓的 caller**——反了的话那些 caller 指向一个不存在的
   版本，而 `pull_request_target` 取默认分支的定义，之后每个 PR 都撞同一件事，
   包括来修它的那个。正文见本仓 README「改这里的东西之后」。
2. **本仓自己作为消费者的那一侧形状和别的仓不一样**（caller 叫 `self-*.yml`、
   守卫入口指树里的 `shared/`、不挂子模块），因为这儿那三个 caller 名字被
   **可复用工作流本体**占着。逐条理由见 README「这个仓库自己也接着这套东西」。
   **`adopt/adopt.js` 在这个仓库里会当场拒绝跑**，接线由 `node self-adopt.test.js` 钉着。

**把一个别的仓接上来**（或体检、升级）看 `adopt/SKILL.md`——正文在那儿，
这份**刻意不抄**：抄一份就会漂，而漂了没有任何东西会报错。

**不要在本仓改 `.claude/agents/common/` 里那几份角色定义**：它们是 subtree 从
`GinkgoLeafLab/dev-agents` 拉来的整棵根树，在这儿改传不出去，下次重接原样覆盖，
而且 `self-adopt.test.js` 会当场判出和上游对不上。要改去 dev-agents 走 PR、打新 tag，
再回来重接（`.claude/agents-common.VERSION` 记着现在是哪个 tag）。
