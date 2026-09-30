#!/usr/bin/env node
/* 判断一次改动是不是「纯文档」——CI 用它决定要不要真跑那些花时间的步骤
   （跑测试、部署、校验部署配置之类）。

   **消费仓不再有这份文件的副本。** 它跟着组合动作 `.github/actions/docs-only`
   一起下发到 runner 上（路径 `$GITHUB_ACTION_PATH`），各仓的 workflow 里只有一行
   `uses: GinkgoLeafLab/dev-infra/.github/actions/docs-only@<tag>`。
   所以改这里就是改了所有仓——**打了新 tag、各仓把那一行升上去之后**。

   用法（组合动作替调用方拼好，本地与测试也可以直接这么调）：
   node docs-only.js <base-sha> <head-sha> [--merge-base] [--skipped=<描述>] [--not-docs=<glob 列表>]

   **它在调用方的工作区里跑 `git diff`**，所以那个 job 必须先 checkout，
   而且要 `fetch-depth: 0`——浅克隆里 base 那个对象根本不存在。
   忘了的后果不是判错，是 `hasCommit` 取不到 base → 打 ::warning:: → 按「跑测试」处理
   （见下面「失败方向」那段）。

   --skipped 只改那条 ::notice:: 里「跳过了什么」的措辞，**判定逻辑不受它影响**。
   哪几条流水线在调它、各自跳过了什么，是各仓自己的事，写在各仓的 CI 文档里；
   这份文件只管判定，不认识任何一条具体的流水线。

   --not-docs 是**调用方声明「这些路径不算文档」**：换行分隔的 glob 列表，命中的文件
   一律判成「不是文档」，**先于**下面 docs/ 与 .md 两条规则。它只能把判定往「跑测试」
   那边推，不给它行为一个字节都不变；写法不认识时整个参数按解析失败处理
   （见 parseNotDocs），方向同样是「跑测试」。这份文件仍然不认识任何一个仓的具体路径。

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
   - 任何位置的 .md，**`.claude/` 目录之下的除外**

   **这两条成立靠一个前提，而那个前提在每个用这个动作的仓里各自成立、各自会坏**：
   那个仓里没有任何构建或测试去读 docs/ 与 .md，发布件也不含它们。
   哪天某个仓开始拿 docs/ 当测试夹具、或者把某份 .md 打进产物，**这条白名单在那个仓
   当场作废**，要么收窄、要么那个仓不该用这个动作。**这份文件替谁都断言不了这件事**：
   它下发到所有仓、看不见任何一个仓的构建。第一次接上的时候核一遍，别默认它成立。

   **`.claude/` 下的 .md 已经在至少一个消费仓里坏掉了，这条不是假设性的：**
   `GTO-Trainer` 的 `scripts/agents-skills.test.js`（`npm test` 会跑）把
   `.claude/agents/` 下每份角色定义的 frontmatter、各份 `SKILL.md` 的 description 与
   `disable-model-invocation`、`.claude/rules/` 下每份规则的 `paths:` 当输入读——
   那儿的 `.md` 是**配置**，不是文档。一个只改角色定义 `skills:` 那一行、
   或只改某份 `SKILL.md` 的 PR 全是 `.md`，原白名单会把它判成纯文档，
   `npm test` 因此被跳过，而**这条守卫恰好在它唯一要守的那类改动上不跑**——
   `test` 检查照样绿，PR 却带着一个从没跑过的四条门禁（frontmatter、skill 名、
   `disable-model-invocation`、`paths:`）合了进去。收窄之后这类改动落回「跑测试」
   那一侧，代价是**别的消费仓**（`.claude/` 下没有类似断言的那些）改这类 `.md`
   也要多跑一遍测试——方向没错：白名单本来就只该放「绝无可能让测试变红」的路径，
   而 `.claude/` 已经不在这一档了，多花的几分钟是刻意换来的，不是误伤。
   见 `GinkgoLeafLab/GTO-Trainer` 的 `.claude/skills/ci-dev-rules/SKILL.md`。

   刻意不含 .claude/settings.json（它配的是本地 hook 与权限）、.github/ 下的
   **非 .md 文件**（workflow 定义）、.gitignore ——它们不是文档，
   也不是「绝无可能」的那一档。.github/pull_request_template.md 这类 .md 会被算成文档，
   那是对的：它改了不影响任何断言。 */
function isDocFile(f, notDocs) {
  if (typeof f !== "string" || f === "") return false;
  /* 调用方声明的「不算文档」最先判，**在 docs/ 与 .md 两条规则之前**：
     一个 docs/ 下的、或者 .md 结尾的路径正是它要拦的对象，排在后面就永远轮不到它。
     notDocs 是 parseNotDocs 的返回值（RegExp 数组）；不给就是老行为，一个字节都不变。
     **给了但不是那个形状——一律按「不是文档」**：能到这里说明调用方传错了，
     而传错的参数不许让任何东西被判成文档。 */
  if (notDocs !== undefined) {
    if (!Array.isArray(notDocs) || !notDocs.every((r) => r instanceof RegExp)) return false;
    /* NFC 之后再比：git diff -z 给的是磁盘上的原始字节路径（macOS 上可能是 NFD），
       而调用方在 YAML 里敲的是 NFC，两边不规范化，同一个名字会互相认不出来。
       只用来比对 not-docs——下面几条规则全是 ASCII，不受规范化影响。 */
    const nf = f.normalize("NFC");
    if (notDocs.some((re) => re.test(nf))) return false;
  }
  if (f.startsWith("docs/")) return true;
  /* 路径段匹配，不是「开头是不是 .claude/」。理由不在「Claude Code 会不会加载
     子目录里那一份」上——**本仓 README 写着 `.claude/skills/` 只在项目根那一层被扫**，
     别在这儿留一句和它对着来的话。理由是判定这一侧的：`sub/` 底下同样可能是
     另一个项目根（monorepo、嵌套的克隆）的配置目录，那儿的 .md 一样是配置不是文档，
     而判成非文档是安全的那一侧——最多多跑一遍测试。
     反过来 `src/my.claude.md`、`.claudeignore.md` 只是文件名里带这几个字符，
     不构成这个目录段，不该被误伤。 */
  if (f.endsWith(".md")) return !/(^|\/)\.claude\//.test(f);
  return false;
}

// 把 not-docs 的原文（换行分隔的 glob 列表）解析成 RegExp 数组。
//
// 语义只有三条，**别往里加**（每加一种通配写法，就多一种「写了却没命中」的可能）：
// - `**/` 是零个或多个目录段（`**/矩阵.md` 命中根目录的 `矩阵.md`，也命中 `a/b/矩阵.md`）
// - `*` 是一段之内的任意个字符，**不跨 `/`**
// - 其余字符原样匹配，`. ? [ ] { } ( ) + ^ $ | \` 全部转义——`?` 与 `[` 不是通配符
// 整条模式从头到尾匹配，区分大小写（git 路径就是区分的）。
// 空行、行首尾的空白（含 CRLF 的 \r）忽略。模式与路径都做 NFC 规范化。
//
// **拿不准就抛，由 main 按「跑测试」处理：** 宁可整个参数作废，也不留一条
// 「写了却永远命不中」的规则——那会让本该被拦下的路径悄悄落回「文档」那一档。
// 会抛的写法（每一种都是「写了却永远命不中」）：
// - 按 `/` 切开之后有一段是空的或是 `.` / `..`：开头的 `/`、结尾的 `/`（`src/modules/`、
//   `**/`）、中间的 `//`、`./x`、`a/./b`、`a/../b`。git 给的路径是规范化的文件路径，
//   不会有这几种段，也不会以 `/` 结尾（模式匹配的是文件，不是目录）
// - `**` 不是「一段的开头、后面紧跟 /」的形状（`docs/**`、`a**b`、`***/x`）
// 传进来不是字符串同样抛。空原文（或全是空行）返回空数组，等价于没传。
function parseNotDocs(raw) {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "string") throw new TypeError("not-docs 不是字符串");
  const out = [];
  for (const line of raw.split("\n")) {
    const pat = line.trim().normalize("NFC");
    if (pat === "") continue;
    // 逐段查，不只查开头：以 / 结尾的模式（`src/modules/`）和 `docs/**` 是同一种错——
    // 想拦一整个目录，却写成了永远命不中的形状。模式匹配的是文件路径，
    // 要拦目录下的文件就得写到文件名（例如 `src/modules/x/矩阵.md`）。
    for (const seg of pat.split("/")) {
      if (seg === "" || seg === "." || seg === "..") {
        throw new Error(`not-docs 里的模式有空段或 . / .. 段（开头或结尾的 /、//、./、../ 都命不中任何文件路径）：${pat}`);
      }
    }
    let src = "";
    for (let i = 0; i < pat.length; ) {
      if (pat.startsWith("**", i)) {
        if ((i !== 0 && pat[i - 1] !== "/") || pat[i + 2] !== "/") {
          throw new Error(`not-docs 里 ** 只认「**/」这一种写法（一段的开头、后面紧跟 /）：${pat}`);
        }
        src += "(?:[^/]+/)*";
        i += 3;
      } else if (pat[i] === "*") {
        src += "[^/]*";
        i += 1;
      } else {
        src += pat[i].replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
        i += 1;
      }
    }
    out.push(new RegExp(`^${src}$`));
  }
  return out;
}

/* 空列表返回 false：一个文件都没变的 diff 说明前提就不对（SHA 取错、强推），
   这时候跑一遍测试是便宜的那一边。 */
function isDocsOnly(files, notDocs) {
  return Array.isArray(files) && files.length > 0 && files.every((f) => isDocFile(f, notDocs));
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
  /* --not-docs 的值里有换行与中文，所以不用 /^--x=(.+)$/ 那种（`.` 不匹配换行）。
     给了几次就并集：多出来的规则只会让更多路径变成「不是文档」，方向是安全的。 */
  const notDocsRaw = flags.filter((a) => a.startsWith("--not-docs=")).map((a) => a.slice("--not-docs=".length));

  let docsOnly = false;
  let why = "";
  try {
    /* 光秃秃的 --not-docs（漏了 =）会被当成没传——调用方以为声明了、其实没有，
       这一档正是不许静默的：按解析失败处理。 */
    if (flags.includes("--not-docs")) throw new Error("--not-docs 后面要带 =<glob 列表>");
    /* 参数先解析：解析失败整个判定作废，落在下面的 catch 里 → docs_only=false + ::warning::。
       绝不退回「当没传」——那会把调用方明说不算文档的路径判成文档。 */
    const notDocs = notDocsRaw.length ? parseNotDocs(notDocsRaw.join("\n")) : undefined;
    if (!base || !head) throw new Error("没给 base/head SHA");
    if (!hasCommit(base, process.cwd())) throw new Error(`base 对象取不到：${base}`);
    if (!hasCommit(head, process.cwd())) throw new Error(`head 对象取不到：${head}`);
    const files = changedFiles(base, head, mergeBase, process.cwd());
    docsOnly = isDocsOnly(files, notDocs);
    const others = files.filter((f) => !isDocFile(f, notDocs));
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

module.exports = { isDocFile, isDocsOnly, parseNotDocs, changedFiles, main };
