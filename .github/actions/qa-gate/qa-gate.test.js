/* QA 门禁判定的回归测试：node .github/actions/qa-gate/qa-gate.test.js
   （本仓 .github/workflows/test.yml 跑的就是它）

   这段代码判错一次的后果不是「测试红了」，而是**一个标了「必须测」的 PR 拿到绿的必需检查**，
   而且表面上毫无症状：检查绿着、PR 合得掉、没人会去看那条 output。所以这里钉死两件事：

   - **「需要 QA 但还没测过」必须是 `failure`。** `neutral` 和 `skipped` 在必需检查里
     都算「过」（GitHub 官方原文见同目录 qa-gate.js 的注释），把这一格写成它们中的任何一个，
     这道门就不存在了——**这是整个门禁唯一严重的失效方式**
   - **CLI 的失败方向是「拦住」。** 环境变量缺了、JSON 坏了、SHA 不像 SHA，
     必须非零退出且**不吐出任何检查体**：job 红 → 那个 SHA 上没有 `qa` → PR 停在
     "Expected — waiting for status"。改成「出错就当没标记」是静默放行 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CLI = path.join(__dirname, "qa-gate.js");
const { decide, statusBody, checkDesc, REQUIRED_LABEL, PASSED_LABEL, ACTIONS, DESC_MAX } = require("./qa-gate.js");

const SHA = "0123456789abcdef0123456789abcdef01234567";

/* 默认走「唯一会认 qa-passed 的那条路」——labeled 且打的就是 qa-passed；
   别的组合在下面「只认这一条路」那一节里逐个试。 */
const D = (labels, action = "labeled", label = PASSED_LABEL) => decide(labels, action, label);
const B = (labels, action = "labeled", label = PASSED_LABEL) => statusBody(labels, action, label, "");

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`  ✗ ${name}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`); }
}
function ok(name, cond) { check(name, !!cond, true); }

/* —— 两个标签名是跨系统的契约，必须钉字面量 —— */
/* 这两个名字同时活在四个地方：人在 Issues → Labels 里手建的那两个、
   各仓 caller 的 `if` 里那个 `qa-` 前缀、各仓 `.github/labels.json` 里的那两条、
   以及 `.claude/rules/qa-tester.md` 里写的那两个。**套件里其余每一条用的都是导入进来的常量，
   所以改了常量它们照样全绿**——改这里不改那边的后果是：GitHub 上打的还是 `qa-required`，
   脚本认的已经是别的字符串，于是每个 PR 都落进 `neutral`，整道门形同虚设而且没有症状。 */
check("要测的标签名（人在仓库设置里手建的那个）", REQUIRED_LABEL, "qa-required");
check("放行的标签名（qa-tester 打的那个）", PASSED_LABEL, "qa-passed");
ok("workflow 的 `qa-` 前缀能盖住这两个", [REQUIRED_LABEL, PASSED_LABEL].every((l) => l.startsWith("qa-")));

/* —— 三种标签组合各是什么结论 —— */
/* [说明, 标签, 期望结论] */
const CASES = [
  ["没有任何标签",                 [],                                          "neutral"],
  ["只有别的标签",                 ["review-passed", "documentation"],          "neutral"],
  ["标了要测、还没测过",           [REQUIRED_LABEL],                            "failure"],
  ["标了要测、也测过了",           [REQUIRED_LABEL, PASSED_LABEL],              "success"],
  ["测过了但没标要测",             [PASSED_LABEL],                              "success"],
  ["顺序反过来",                   [PASSED_LABEL, REQUIRED_LABEL],              "success"],
  ["夹在别的标签中间",             ["a", REQUIRED_LABEL, "b"],                  "failure"],
];
for (const [name, labels, want] of CASES) {
  check(name, D(labels).conclusion, want);
}

/* —— 这一条是这个套件存在的理由 —— */
/* 「需要 QA 但没测过」必须是 failure。**不能只断言 !== "success"**：
   neutral 和 skipped 也都算「过」，漏掉它们的话把 failure 改成 neutral 这个套件照样全绿。 */
const waiting = D([REQUIRED_LABEL]).conclusion;
for (const green of ["success", "neutral", "skipped"]) {
  check(`等待 QA 时不许是「${green}」（那都算放行）`, waiting === green, false);
}
check("等待 QA 时就是 failure", waiting, "failure");

/* —— qa-passed 只在「这个事件本身就是在打它」时才认 —— */
/* 要判的是「**这一版**有没有被人打过 `qa-passed`」，而 payload 里的标签是**事件创建那一刻**
   的快照。快照过没过期和事件类型无关，所以不能拿事件类型当键：`qa-passed` 从被打上到被
   workflow 摘掉之间，**任何一个 `qa-` 标签动作**（补打 `qa-required`、摘掉它）产生的事件，
   快照里都还带着 `qa-passed`——而 head 可能已经是一个没人测过的新 SHA。
   照单全收就是在那个 SHA 上写 success，**且表面上毫无症状**。

   下面这张表就是「除了 labeled + qa-passed，其余全都不认」。**别把它删剩一条 synchronize**
   ——只挡 synchronize 会漏掉上面那条标签动作的路径，两者是同一个失效、只是入口不同。 */
const NOT_FRESH = [
  ["推了新 commit", "synchronize", ""],
  ["PR 刚开", "opened", ""],
  ["PR 被重开", "reopened", ""],
  ["打的是另一个 qa- 标签", "labeled", REQUIRED_LABEL],
  ["摘掉的是另一个 qa- 标签", "unlabeled", REQUIRED_LABEL],
  ["摘掉的正是 qa-passed", "unlabeled", PASSED_LABEL],
];
for (const [name, action, label] of NOT_FRESH) {
  const d = D([REQUIRED_LABEL, PASSED_LABEL], action, label);
  check(`${name}：标签还挂着也不算数 → 拦住`, d.conclusion, "failure");
  /* 摘标签这一下要留给打标签那个 run：两边同时 DELETE 就是一个 404，把绿 job 打红。 */
  check(`${name}：不去摘标签（会撞 404）`, d.removeLabel, null);
  check(`${name}：没标要测时照旧放行`, D([PASSED_LABEL], action, label).conclusion, "neutral");
}
/* 新往 `ACTIONS` 里加一个事件类型时，这条逼着你把它归到某一边——
   漏归的那一边默认是「认 qa-passed」，也就是危险的那一边。 */
const covered = new Set([...NOT_FRESH.map(([, a]) => a), "labeled"]);
for (const a of ACTIONS) ok(`事件类型 ${a} 在上面被归过类`, covered.has(a));

ok("拦住时要说清楚「不是这个事件打上的」",
   B([REQUIRED_LABEL, PASSED_LABEL], "synchronize", "").status.description.includes("不是这个事件打上的"));

/* 正对照：唯一会认它的那条路必须真的认，否则这个标签就永远放不了行了。 */
const fresh = D([REQUIRED_LABEL, PASSED_LABEL], "labeled", PASSED_LABEL);
check("打上 qa-passed 那一下：放行", fresh.conclusion, "success");
check("打上 qa-passed 那一下：把它摘掉", fresh.removeLabel, PASSED_LABEL);

/* —— 标签摘不摘 —— */
check("通过之后要摘 qa-passed", D([REQUIRED_LABEL, PASSED_LABEL]).removeLabel, PASSED_LABEL);
check("等待时没有要摘的标签", D([REQUIRED_LABEL]).removeLabel, null);
check("免测时没有要摘的标签", D([]).removeLabel, null);
/* qa-required 是「这个 PR 属于要测的那一类」这个事实，不随版本变，永远不摘。
   摘了它，下一版就会静默变成免测——和把 failure 改成 neutral 一个后果。 */
for (const [name, labels] of [["通过", [REQUIRED_LABEL, PASSED_LABEL]], ["等待", [REQUIRED_LABEL]]]) {
  check(`${name}时不摘 ${REQUIRED_LABEL}`, D(labels).removeLabel === REQUIRED_LABEL, false);
}

/* 标签名是用户随手填的文本，带引号、反引号、换行都不许把请求体拼坏。 */
const nasty = ['a"b', "`whoami`", "$(id)", "行\n尾"];
const nastyBody = B([...nasty, REQUIRED_LABEL]).status;
check("恶心的标签名不影响结论", nastyBody.state, "failure");
ok("恶心的标签名之后请求体仍是合法 JSON", (() => {
  try { return JSON.parse(JSON.stringify(nastyBody)).context === "qa"; } catch { return false; }
})());

/* —— commit status 那一半 —— */
/* —— commit status：判定唯一的产物 —— */
/* **在同组织的产品仓（GTO-Trainer）上实测过**：那边的必需检查**不匹配**用 Checks API
   现写的 check run（#67 / #68 上 `review` 与 `qa` 都存在于 head SHA，merge box 照样说
   「Waiting for status to be reported」；换成 commit status 之后 #69 当场变 `clean`）。
   **那是那一个仓库的实测，别的仓库没有各自复现过**——这份文件现在所有仓共用，
   照抄它的是「结论」不是「本仓现象」。commit status **没有 neutral**，
   「不需要 QA」那一格因此是 `success`。 */
const ST = (labels, action = "labeled", label = PASSED_LABEL) => B(labels, action, label).status;

check("上下文名必须是 qa（必需检查按名字匹配）", ST([]).context, "qa");
check("免测 → success（status 没有 neutral 这一档）", ST([]).state, "success");
check("测过了 → success", ST([REQUIRED_LABEL, PASSED_LABEL]).state, "success");
/* 这一条和 check run 那半边同等重要：`success` 直接放行，
   而 `pending` 会让人以为「还在跑」——两个都不行，必须是 failure。 */
const waitState = ST([REQUIRED_LABEL], "opened", "").state;
for (const green of ["success", "pending", "error"]) {
  check(`等待 QA 时不许是「${green}」`, waitState === green, false);
}
check("等待 QA 时就是 failure", waitState, "failure");
check("新推的一版也是 failure", ST([REQUIRED_LABEL, PASSED_LABEL], "synchronize", "").state, "failure");

/* 描述字段 GitHub 限 140 字符，超了整个请求会被拒——那会让一条本该拦住的检查
   根本没写上去，也就是静默放行。四种情况逐个量。 */
for (const [name, labels, action, label] of [
  ["免测", [], "opened", ""],
  ["等待", [REQUIRED_LABEL], "opened", ""],
  ["通过", [REQUIRED_LABEL, PASSED_LABEL], "labeled", PASSED_LABEL],
  ["过期", [REQUIRED_LABEL, PASSED_LABEL], "synchronize", ""],
]) {
  const d = ST(labels, action, label).description;
  ok(`${name}的描述不超过 ${DESC_MAX} 字符（实际 ${d.length}）`, d.length > 0 && d.length <= DESC_MAX);
}
/* 长度守卫自己也要被验：现有描述都很短，删掉它测试照样全绿——
   那就成了一句「声称有用」的注释，比没有守卫更糟。 */
ok(`${DESC_MAX} 字符可以`, checkDesc("x".repeat(DESC_MAX)) === "x".repeat(DESC_MAX));
for (const [name, bad] of [["超一个字符", "x".repeat(DESC_MAX + 1)], ["空字符串", ""], ["不是字符串", null]]) {
  let threw = false;
  try { checkDesc(bad); } catch { threw = true; }
  ok(`描述${name}要抛（整个请求会被拒 = 检查根本没写上）`, threw);
}

/* 上面那几条只验得动 `checkDesc` **自己**。**产出请求体的那条路走不走它，是另一件事**——
   把 `description: checkDesc(d.desc)` 改成 `description: d.desc`，上面全部照旧全绿（评审实测）。
   这正是 GinkgoLeafLab/GTO-Trainer 的 .claude/rules/code-reviewer.md 里记着的 C40e
   那次的形状：变异做了、也红了，红的却是不会出事的那条路径。

   所以扫源码钉住调用点。**边界要说清**：扫的是 `qa-gate.js` 全文、**不剥注释**，
   而且断言的是「恰好一次」——所以注释里再写一遍这个模式会让它红。这是刻意的：
   模式写错时命中数是 0，同样红，「零命中」不会被当成「干净了」。 */
const SRC = fs.readFileSync(CLI, "utf8");
check("生产路径真的过了这道守卫（变异落点：改成 `d.desc`）",
      (SRC.match(/description:\s*checkDesc\(/g) || []).length, 1);

/* target_url 传了才带，没传就不带——空字符串会被 GitHub 拒。 */
ok("没给 target_url 时不带这个字段", !("target_url" in ST([])));
ok("给了就带上", statusBody([], "opened", "", "https://x/run").status.target_url === "https://x/run");

/* —— CLI：真的起一个进程跑 —— */
function runCLI(env) {
  /* 默认给一个合法事件，专门试它的那几条用例自己覆盖掉 */
  env = { QA_GATE_EVENT: "labeled", QA_GATE_LABEL: PASSED_LABEL, ...env };
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qa-gate-")), "out");
  fs.writeFileSync(outFile, "");
  try {
    const stdout = execFileSync(process.execPath, [CLI], {
      env: { ...process.env, GITHUB_OUTPUT: outFile, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, output: fs.readFileSync(outFile, "utf8") };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, stdout: e.stdout || "", output: fs.readFileSync(outFile, "utf8") };
  }
}

const good = runCLI({ QA_GATE_SHA: SHA, QA_GATE_LABELS: JSON.stringify([REQUIRED_LABEL, PASSED_LABEL]) });
check("CLI 正常退出", good.code, 0);
check("CLI 吐出的就是那份 status 请求体", JSON.parse(good.stdout).state, "success");
check("带着 context", JSON.parse(good.stdout).context, "qa");
check("CLI 把要摘的标签写进 GITHUB_OUTPUT", good.output.trim(), `remove_label=${PASSED_LABEL}`);

const nothingToRemove = runCLI({ QA_GATE_SHA: SHA, QA_GATE_LABELS: "[]" });
check("没有标签要摘时写的是空值", nothingToRemove.output.trim(), "remove_label=");

/* 失败方向：全都要非零退出，而且**不许吐出检查体**——
   吐了的话 `gh api --input -` 会拿着半截 JSON 去创建检查，那才是最糟的一种。 */
const goodSync = runCLI({ QA_GATE_EVENT: "synchronize", QA_GATE_LABEL: "", QA_GATE_SHA: SHA, QA_GATE_LABELS: JSON.stringify([REQUIRED_LABEL, PASSED_LABEL]) });
check("CLI 把事件类型带进判定", JSON.parse(goodSync.stdout).state, "failure");
check("CLI 在那条路径上不摘标签", goodSync.output.trim(), "remove_label=");

const otherLabel = runCLI({ QA_GATE_EVENT: "labeled", QA_GATE_LABEL: REQUIRED_LABEL, QA_GATE_SHA: SHA, QA_GATE_LABELS: JSON.stringify([REQUIRED_LABEL, PASSED_LABEL]) });
check("CLI 把「打的是哪个标签」带进判定", JSON.parse(otherLabel.stdout).state, "failure");

const BAD = [
  ["缺事件类型",       { QA_GATE_EVENT: undefined, QA_GATE_SHA: SHA, QA_GATE_LABELS: "[]" }],
  ["labeled 缺标签名", { QA_GATE_EVENT: "labeled", QA_GATE_LABEL: "", QA_GATE_SHA: SHA, QA_GATE_LABELS: "[]" }],
  ["unlabeled 缺标签名", { QA_GATE_EVENT: "unlabeled", QA_GATE_LABEL: "", QA_GATE_SHA: SHA, QA_GATE_LABELS: "[]" }],
  ["认不得的事件类型", { QA_GATE_EVENT: "ready_for_review", QA_GATE_SHA: SHA, QA_GATE_LABELS: "[]" }],
  ["缺 SHA",           { QA_GATE_LABELS: "[]" }],
  ["SHA 不像 SHA",     { QA_GATE_SHA: "main", QA_GATE_LABELS: "[]" }],
  ["SHA 被截短",       { QA_GATE_SHA: SHA.slice(0, 7), QA_GATE_LABELS: "[]" }],
  ["缺标签",           { QA_GATE_SHA: SHA }],
  ["标签不是 JSON",    { QA_GATE_SHA: SHA, QA_GATE_LABELS: "qa-required" }],
  ["标签不是数组",     { QA_GATE_SHA: SHA, QA_GATE_LABELS: '{"a":1}' }],
  ["数组里不是字符串", { QA_GATE_SHA: SHA, QA_GATE_LABELS: "[1,2]" }],
];
for (const [name, env] of BAD) {
  /* 环境变量要真的删掉，不能靠不传——父进程里可能有同名的 */
  const e = { QA_GATE_SHA: undefined, QA_GATE_LABELS: undefined, QA_GATE_LABEL: undefined, ...env };
  const r = runCLI(e);
  ok(`${name} → 非零退出（失败方向是拦住）`, r.code !== 0);
  check(`${name} → 不吐检查体`, r.stdout.trim(), "");
}

/* ---- 共用之后，这个 job 的形状本身要钉住 ----

   这一段守的不是判定逻辑，是**这套接线到底跑不跑得起来**，而且它守的东西
   在搬进 dev-infra 之后换了一个：

   以前各仓的 `qa-gate.yml` 第一步是 `actions/checkout`（去 main 上取
   `scripts/qa-gate.js`），所以那份 job 必须自己写 `contents: read`，
   漏了就报 `remote: Repository not found`——看起来像仓库没了或者 token 过期，
   和「权限少一条」一点关系都看不出来。**那个坑现在是结构性地没有了**：
   脚本跟着组合动作一起下发，这条路上一次 checkout 都不做。
   所以这里不再断言 `contents: read`，改成断言**别把 checkout 加回来**。

   为什么加回来是危险的：可复用工作流的权限**取自 caller，且只能降不能升**
   （官方原文见 .github/workflows/qa-gate.yml 顶部），而各仓 caller 只给
   `statuses: write` + `pull-requests: write`。所以在这里加一个 checkout，
   会在**所有**消费仓同时以那条指不到权限上的报错红掉。

   源码断言的边界照例说准：它读的是文本，认得的只有下面这几个模式。
   有人换一种取文件的方式、或者把 `uses:` 拆成别的写法，这几条就看不见了——
   那时该问的是「这个 job 还需不需要 contents」，不是把这条改绿。 */
{
  const dir = path.join(__dirname, "..", "..");
  const wf = fs.readFileSync(path.join(dir, "workflows", "qa-gate.yml"), "utf8");
  const act = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");

  /* 每条都先摆一个正对照：一次「无命中」同时兼容「真的没问题」和「正则压根匹配不到
     任何东西」，没有正对照分不开这两种——我们在这上面栽过，必查项见
     GinkgoLeafLab/GTO-Trainer 的 .claude/rules/code-reviewer.md「新增守卫必查」。 */
  ok("W1 读到的确实是那份可复用工作流（正对照：`on: workflow_call`）",
    /^on:\n\s*workflow_call:/m.test(wf));
  ok("W2 正对照：这份工作流里确实有 `uses:` 这种写法（下面 W3 的模式不是凭空的）",
    /^\s*uses: /m.test(wf));
  /* W3 的模式**必须是完整的 `vX.Y.Z`**，不能只要求 `@v\d+`。

     这不是收紧了一点点：这条断言最早写成 `@v\d+\b` 时，本仓的 tag 策略还是
     「挪 `v1`」，那时 `@v1` 是对的。策略换成**不可变 tag** 之后这一行没跟着改，
     于是 `v1.1.0` 带着 `@v1` 发了出去，而 `v1` 指着动作还不存在的那个 commit——
     那一版的 qa-gate 在每个消费仓上都跑不起来，`qa` 永远停在
     "Expected — waiting for status"，**连来修它的那个 PR 自己也合不了**。
     **守卫跟不上策略变更，比没有守卫更糟**：它绿着，看起来这件事有人管。 */
  ok("W3 **它按不可变 tag 引用同仓的组合动作**——不能是 `./` 相对路径（被调用方所在的" +
     "仓库根本没被 checkout 到工作区，相对路径会指到 caller 的空工作区上），" +
     "不能是 `@main`，**也不能是 `@v1` 这种会动的名字**",
    /uses: GinkgoLeafLab\/dev-infra\/\.github\/actions\/qa-gate@v\d+\.\d+\.\d+\s*$/m.test(wf));
  ok("W4 **这条路上不许有 checkout**——权限取自 caller 且只能降不能升，" +
     "caller 没给 `contents`，加了会在所有消费仓同时以 `Repository not found` 红掉",
    !/actions\/checkout@/.test(wf));

  ok("W5 正对照：组合动作里确实有 `run:`（下面 W6 的模式不是凭空的）", /^\s*run: /m.test(act));
  ok("W6 **组合动作跑的是跟着它一起下发的那份脚本**（`$GITHUB_ACTION_PATH`）——" +
     "写成工作区相对路径会指到 caller 那个没 checkout 过的空目录上",
    /node "\$GITHUB_ACTION_PATH\/qa-gate\.js"/.test(act));
  /* W9：**`outputs:` / `runs:` 之前不许出现 `${` + `{` 那种表达式。**
     清单里的 `description` 也会被 runner 当模板解析，而那个位置没有 `github`
     上下文——写进去是整份清单加载失败、一步都跑不到，不是「注释里的一句话」。
     **labels-sync 那份 v1.3.0 真的这么坏过**（三个消费仓一起红，
     `Unrecognized named-value: 'github'`）；这一份今天是干净的，
     这条守卫是防它变成第二个。合法位置只有 `outputs.*.value` 与 `runs:` 里面。 */
  {
    const head = act.slice(0, act.search(/^(outputs|runs):/m));
    const EXPR = "${" + "{";   /* 拆开写，免得这份文件自己被同一条规则扫出来 */
    /* 正对照拿 `description:`，**不是 `inputs:`**：这一份清单没有 inputs 段
       （它的输入全走 env），拿 inputs 当正对照会让这条在基线上就红。 */
    ok("W9 正对照：`outputs:` 之前确实有内容（顶层 `description:` 那一段），不是扫了个空字符串",
       head.length > 0 && /^description:/m.test(head));
    ok("W9 **`outputs:` / `runs:` 之前不许出现 " + EXPR + "**——那儿没有 github 上下文，" +
       "整份清单会加载失败（labels-sync 的 v1.3.0 就是这么坏的）",
       !head.includes(EXPR));
  }

  ok("W7 组合动作确实是 composite（不是 node20 那种，它没有 bundler）",
    /^\s*using: ["']?composite["']?\s*$/m.test(act));

  /* W8 补的是 W3 看不见的那一半：W3 只验**引用的形状**，验不了**那个 tag 上到底有没有
     这个动作**——今天这个失效正是从这条缝里漏过去的（`@v1` 形状合法、内容没有）。

     判据故意是「**已经存在的** tag 必须含有这个动作」，而不是「这个 tag 必须存在」：
     正常的发布流程里这一行是**前向引用**（合并时 tag 还没打，见 README），
     要求它存在会让每个 PR 都红。所以这条拦的是「引用了一个已经发出去、
     而且内容对不上的旧 tag」——也就是今天这一次。

     **说准它拦不住什么**：拼错一个还不存在的版本号（`v1.2.O`、`v1.20`）它看不见，
     那一条靠的是发布流程本身——README 写明「内层 `uses:` 写的是哪个 tag 就打哪个」，
     人照着那一行打 tag，打错就是当场跑不起来、看得见。

     **「这个 tag 本地没有」有两种完全不同的原因，必须分开，不许合成一条。**
     第一版就是合成一条的，而且**它在 CI 里恒为跳过**——`actions/checkout` 默认
     `fetch-tags: false`，工作副本里一个 tag 都没有，于是 W8 每次都走「前向引用」
     那条分支，**还把这句假话打出来**（`v1` 明明存在）。评审在 dev-infra#3 上抓到的：
     按 CI 的取法重做变异，退回 `@v1` 时只有 W3 红，而 W8 独占的那条路径
     （形状合法、内容没有）一次都没被覆盖。
     **守卫绿着、还宣称自己在看——那正是这个 PR 要修的那个形状，它自己犯了一遍。**

     所以现在分三种：
     - **一个 tag 都没有** → **红**，并说清是取法的问题。有了 `fetch-tags: true`
       这种状态就不该出现，谁把它拿掉，这条当场响
     - **有 tag、但没有这一个** → 前向引用，跳过。**这时那句话才是真的**
     - **不是 git 仓库 / 没有 git** → 跳过并说明，这是唯一一种真的验不了的情况 */
  const ref = (wf.match(/uses: GinkgoLeafLab\/dev-infra\/\.github\/actions\/qa-gate@(\S+)/) || [])[1];
  const root = path.join(dir, "..");   /* dir 是 .github/，再上一层是仓库根 */
  const git = (args) => require("child_process")
    .spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  const inRepo = git(["rev-parse", "--git-dir"]).status === 0;
  const anyTag = inRepo && (git(["tag", "-l"]).stdout || "").trim() !== "";
  const known = ref && inRepo && git(["rev-parse", "--verify", "--quiet", `refs/tags/${ref}`]).status === 0;

  if (!ref) {
    ok("W8 前提：读得出内层引用的那个 tag", false);
  } else if (!inRepo) {
    /* 唯一一种真的验不了的情况：没有 git，或者这份代码不是从仓库里来的 */
    console.log(`  · W8 跳过：这儿不是 git 仓库（或没有 git），验不了 tag \`${ref}\` 的内容`);
  } else if (!anyTag) {
    ok("W8 前提：**本地取到了 tag**——一个都没有说明 checkout 没带 tag 下来" +
       "（`actions/checkout` 默认 `fetch-tags: false`），那样 W8 会把每一次都当成" +
       "「前向引用」放过去，**包括引用了一个真实存在、但内容对不上的旧 tag**。" +
       "修法是给 checkout 加 `fetch-tags: true`，不是把这条改绿",
      false);
  } else if (!known) {
    /* 有 tag 但没有这一个 —— 到这儿「前向引用」才是一句真话 */
    console.log(`  · W8 跳过：tag \`${ref}\` 还不存在（前向引用，发布时才打）`);
  } else {
    const tree = git(["ls-tree", "--name-only", ref, ".github/actions/qa-gate/"]).stdout || "";
    ok(`W8 **内层引用的 tag \`${ref}\` 上真的有这个组合动作**——` +
       "形状合法不等于内容对得上，`v1.1.0` 引用 `@v1` 时就是形状全绿、内容根本没有",
      /action\.yml/.test(tree));
  }
}


console.log(`\nQA 门禁判定：${pass} 条通过${fail ? `，${fail} 条失败` : ""}`);
process.exit(fail ? 1 : 0);
