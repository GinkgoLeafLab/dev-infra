# dev-infra

组织里各仓库共用的**可复用 GitHub Actions 工作流**。逻辑只有这一份，各仓库留一个十几行的 caller。

取舍见 `GinkgoLeafLab/GTO-Trainer` 的 `docs/方案/2026-09-跨仓库基础设施复用.md`。
一句话：那份方案把要复用的东西按「**能不能没有本地副本**」分三层，
**这个仓库装的是第一层**——GitHub 侧的可执行逻辑，它真的只有一份，改这里就是改了所有仓。

（第一层之外还有两层：必须躺在各仓库里才会被读到的文本走 vendor + sha256 校验；
仓库设置只做只读审计。它们不在这个仓库里，也不该搬进来。）

## 和 `GinkgoLeafLab/.github` 是两回事，别混

| 仓库 | 装什么 | 名字能不能换 | agent 能不能写 |
|---|---|---|---|
| **`.github`**（公开） | issue 表单、PR 模板（GitHub 的「默认社区健康文件」） | **不能**，GitHub 钉死要叫这个名字 | **不能**，只能人手推 |
| **`dev-infra`**（私有，就是这里） | 可复用工作流 | 能 | 能，正常走 PR |

## 前提：私有仓的可复用工作流要显式放行

官方原话：

> The called workflow is stored in a private repository and the settings for that repository allow it to be accessed.

落地是这个仓库的 **Settings → Actions → General → Access**，
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
    uses: GinkgoLeafLab/dev-infra/.github/workflows/review-gate.yml@v1
```

### caller 里那三样必须留在 caller

搬进被调用的那份文件，**每一样的失效都是静默的**：

| 留在 caller 的 | 搬走会怎样 |
|---|---|
| `on:` | 可复用工作流没有自己的触发器，事件永远来自 caller——**搬不走** |
| **job 级的 `if:`** | job 级的 if 为 false 时 runner 根本不会起、不计分钟数；搬进去就变成「起了 runner 再判断」。**功能完全正常，只有账单变了** |
| `permissions:` | 官方明写权限取自 calling job，被调用方**只能降不能升**——写在被调用方是没用的 |

### 按 tag 钉，不要按分支

```yaml
uses: GinkgoLeafLab/dev-infra/.github/workflows/review-gate.yml@v1   # ✅
uses: GinkgoLeafLab/dev-infra/.github/workflows/review-gate.yml@main # ❌
```

`@main` 意味着这里一次未经各仓评审的改动**当场在所有仓生效**。
`{ref}` 可以是 SHA、tag 或分支名，我们用 tag。

## 改这里的东西之后

1. 在这个仓库走 PR、评审、合并
2. **把 tag 挪到新的 commit 上**（或者打一个新 tag），否则各仓库仍然在用旧的那一版
3. 各仓库不需要改任何文件——除非 caller 的形状变了（多了 `with:` 之类）

## 这里放什么、不放什么

| 放 | 不放 |
|---|---|
| `on: workflow_call` 的可复用工作流 | **任何凭据**：token、密钥、`.env`、证书 |
| 这些工作流要用的脚本 | 只对某一个仓库成立的逻辑——那属于那个仓库 |
| | issue / PR 模板（那是 `.github` 仓的活，机制完全不同） |
