#!/usr/bin/env node
/* 判断一次改动是不是「纯文档」——CI 用它决定要不要真跑那些花时间的步骤
   （跑测试、部署、校验部署配置之类）。

   **消费仓不再有这份文件的副本。** 它跟着组合动作 `.github/actions/docs-only`
   一起下发到 runner 上（路径 `$GITHUB_ACTION_PATH`），各仓的 workflow 里只有一行
   `uses: GinkgoLeafLab/dev-infra/.github/actions/docs-only@<tag>`。
   所以改这里就是改了所有仓——**打了新 tag、各仓把那一行升上去之后**。

   用法（组合动作替调用方拼好，本地与测试也可以直接这么调）：
   node docs-only.js <base-sha> <head-sha> [--merge-base] [--skipped=<描述>]

   **它在调用方的工作区里跑 `git diff`**，所以那个 job 必须先 checkout，
   而且要 `fetch-depth: 0`——浅克隆里 base 那个对象根本不存在。
   忘了的后果不是判错，是 `hasCommit` 取不到 base → 打 ::warning:: → 按「跑测试」处理
   （见下面「失败方向」那段）。

   --skipped 只改那条 ::notice:: 里「跳过了什么」的措辞，**判定逻辑不受它影响**。
   哪几条流水线在调它、各自跳过了什么，是各仓自己的事，写在各仓的 CI 文档里；
   这份文件只管判定，不认识任何一条具体的流水线。

   为什么不用 workflow 级的 paths / paths-ignore：如果这个判定服务的是一个**必需检查**，
   GitHub 官方文档写明「工作流因 path 过滤被跳过时，它的检查会停在 Pending」，
   那个 PR 就永远合不了。所以 job 照常跑，跳过的是 job 里面那几步，检查每次都会真正变绿。
   调研与出处见 GinkgoLeafLab/GTO-Trainer 仓的 docs/方案/2026-08-文档改动跳过测试.md。

   为什么是一段 node 脚本而不是写进 workflow 的 run：
   多于一行的逻辑不许留在 YAML 里（见各仓的 .claude/agents/common/ci-dev.md），
   而且写成脚本它才能被 docs-only.test.js 钉住——这段代码判错一次的后果，
   是一版没跑过测试的代码拿到绿的必需检查。

   **失败方向是刻意选的：拿不准就跑测试。** 缺 SHA、git 报错、diff 为空、
   自己抛异常——一律输出 docs_only=false 并打 ::warning::，让测试照常跑。
   反过来（拿不准就跳过）省下的几分钟换的是漏网的回归，不划算。 */
const { spawnSync } = require("child_process");

/* 纯文档的判定。**只放绝无可能让测试变红的路径**，这条是白名单不是黑名单：
   新增一类文件默认走「跑测试」那边，要它被跳过得有人显式加进来并补上断言。

   - docs/ 下的一切
   - 任何位置的 .md：CLAUDE.md、README.md、.claude/ 下的角色与规则都在这儿

   **这两条成立靠一个前提，而那个前提在每个用这个动作的仓里各自成立、各自会坏**：
   那个仓里没有任何构建或测试去读 docs/ 与 .md，发布件也不含它们。
   哪天某个仓开始拿 docs/ 当测试夹具、或者把某份 .md 打进产物，**这条白名单在那个仓
   当场作废**，要么收窄、要么那个仓不该用这个动作。**这份文件替谁都断言不了这件事**：
   它下发到所有仓、看不见任何一个仓的构建。第一次接上的时候核一遍，别默认它成立。

   刻意不含 .claude/settings.json（它配的是本地 hook 与权限）、.github/ 下的
   **非 .md 文件**（workflow 定义）、.gitignore ——它们不是文档，
   也不是「绝无可能」的那一档。.github/pull_request_template.md 这类 .md 会被算成文档，
   那是对的：它改了不影响任何断言。 */
function isDocFile(f) {
  if (typeof f !== "string" || f === "") return false;
  if (f.startsWith("docs/")) return true;
  if (f.endsWith(".md")) return true;
  return false;
}

/* 空列表返回 false：一个文件都没变的 diff 说明前提就不对（SHA 取错、强推），
   这时候跑一遍测试是便宜的那一边。 */
function isDocsOnly(files) {
  return Array.isArray(files) && files.length > 0 && files.every(isDocFile);
}

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function hasCommit(sha, cwd) {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false;
  if (/^0+$/.test(sha)) return false;               // 全零 = 新分支的第一次推送，没有 before
  return git(["cat-file", "-e", sha + "^{commit}"], cwd).status === 0;
}

/* -z 输出以 NUL 分隔且**不做路径转义**。默认输出会把非 ASCII 路径转成
   "docs/\344\272..." 这种带引号的八进制形式——**路径里有一个中文字符就够了**，
   少了 -z 判定会当场失效。--no-renames 让重命名两侧的路径都出现在列表里，
   否则「把 src/x.js 改名成 docs/x.md」只会看到目标路径，被误判成纯文档。 */
function changedFiles(base, head, mergeBase, cwd) {
  const range = mergeBase ? `${base}...${head}` : `${base}..${head}`;
  const r = git(["diff", "-z", "--name-only", "--no-renames", range], cwd);
  if (r.status !== 0) throw new Error(`git diff ${range} 失败：${(r.stderr || "").trim()}`);
  return r.stdout.split("\0").filter(Boolean);
}

function main(argv) {
  const flags = argv.filter((a) => a.startsWith("--"));
  const [base, head] = argv.filter((a) => !a.startsWith("--"));
  const mergeBase = flags.includes("--merge-base");
  /* 默认措辞是「跑测试」那条路的——不给这个参数的调用方（以及本地手跑）
     行为一个字都不变。 */
  const m = flags.map((a) => /^--skipped=(.+)$/.exec(a)).find(Boolean);
  const skipped = m ? m[1] : "npm test";

  let docsOnly = false;
  let why = "";
  try {
    if (!base || !head) throw new Error("没给 base/head SHA");
    if (!hasCommit(base, process.cwd())) throw new Error(`base 对象取不到：${base}`);
    if (!hasCommit(head, process.cwd())) throw new Error(`head 对象取不到：${head}`);
    const files = changedFiles(base, head, mergeBase, process.cwd());
    docsOnly = isDocsOnly(files);
    const others = files.filter((f) => !isDocFile(f));
    why = docsOnly
      ? `${files.length} 个改动文件全部是文档`
      : files.length === 0
        ? "diff 为空，按「跑测试」处理"
        : `${others.length} 个非文档改动，例如：${others.slice(0, 5).join("、")}`;
  } catch (e) {
    /* 静默降级是这套东西最危险的失败方式——真出错时必须看得见，
       但方向仍然是「跑测试」，不是「放行」。 */
    console.log(`::warning::判定纯文档改动失败，按「跑测试」处理：${e.message}`);
    docsOnly = false;
    why = "判定失败";
  }

  console.log(`docs_only=${docsOnly}（${why}）`);
  /* ::notice:: 会显示在 PR 的检查页上。绿的检查在这种情况下**不代表那件事真的做了**——
     `test` 绿不代表测试跑过，`deploy` 绿不代表产物发出去了。这句话就是防它被误读的，
     不要因为「日志里已经写了」就把它删掉，没人会点进日志。 */
  if (docsOnly) {
    console.log(`::notice::本次改动只有文档，已跳过 ${skipped}。这个检查是绿的，但它这次并没有执行 ${skipped}。`);
  }
  if (process.env.GITHUB_OUTPUT) {
    require("fs").appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${docsOnly}\n`);
  }
  return docsOnly;
}

if (require.main === module) {
  main(process.argv.slice(2));
  /* 永远 exit 0：判定本身不该是让 PR 变红的理由。 */
  process.exit(0);
}

module.exports = { isDocFile, isDocsOnly, changedFiles, main };
