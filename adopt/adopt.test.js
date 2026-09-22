/* adopt 脚本的测试。跑法：node adopt/adopt.test.js

   **这个脚本判错的后果是「报告说装好了，其实没装」**，而它装的每一层失效都是静默的
   （少一个事件、钉到会动的 tag、守卫入口指进空子模块）。所以这份测试分两半：

   1. 纯函数那一半——尤其是 `lintCaller`：它要在**注释里逐字写着那些词**的文件上
      仍然判得出接线真的少了什么（模板的注释就是在解释那几条，照原文判必然漏判）
   2. 端到端那一半——在临时目录里真的 git init 一个消费仓、真的挂子模块、真的
      subtree、真的再跑一次 `--check`。形态对、接线错是这套东西栽过的地方，
      所以这一半不问形状，直接问结果 */
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const A = require("./adopt.js");
const ROOT = path.join(__dirname, "..");
const TPL = (n) => fs.readFileSync(path.join(__dirname, "templates", n + ".yml"), "utf8");

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`  ✗ ${name}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`); }
}
function throws(name, fn, re) {
  try { fn(); fail++; console.error(`  ✗ ${name}：没抛异常`); }
  catch (e) { if (re.test(e.message)) pass++; else { fail++; console.error(`  ✗ ${name}：抛了但对不上——${e.message}`); } }
}

/* —— 参数解析：认不出的开关必须炸，不许静默忽略 —— */
throws("认不出的参数会炸", () => A.parseArgs(["--no-agent"]), /认不出的参数/);
throws("带值的参数少了值会炸", () => A.parseArgs(["--infra-tag"]), /要跟一个值/);
throws("--offline 不给 tag 会炸", () => A.parseArgs(["--offline"]), /--offline/);
check("--offline + 两个 tag 能过", A.parseArgs(["--offline", "--infra-tag", "v1.0.0", "--agents-tag", "v1.0.0"]).offline, true);
check("--no-agents 下 --offline 只要 infra-tag", A.parseArgs(["--offline", "--no-agents", "--infra-tag", "v1.0.0"]).noAgents, true);

/* —— ls-remote：annotated tag 要取剥出来的那个 commit ——
   记成 tag 对象的 SHA 时，VERSION 文件看上去完全正常，而拿它去比内容永远对不上。 */
{
  const m = A.parseLsRemote([
    "1111111111111111111111111111111111111111\trefs/tags/v1.0.0",
    "2222222222222222222222222222222222222222\trefs/tags/v1.0.0^{}",
    "3333333333333333333333333333333333333333\trefs/heads/main",
  ].join("\n"));
  check("annotated tag 取剥出来的 commit", m.get("v1.0.0"), "2".repeat(40));
  check("分支不进 tag 表", m.has("main"), false);
}

/* —— 选 tag：数字比大小，且不认会动的名字 —— */
check("v1.14.0 > v1.9.0（不是字典序）", A.pickTag(["v1.9.0", "v1.14.0", "v1.2.0"]), "v1.14.0");
check("`v1` 这种会动的 tag 不参选", A.pickTag(["v1", "v1.2.0"]), "v1.2.0");
throws("一个三段式 tag 都没有就炸", () => A.pickTag(["v1", "latest"]), /接不了/);
check("isImmutableTag 认 vX.Y.Z", A.isImmutableTag("v1.14.0"), true);
check("isImmutableTag 不认 main", A.isImmutableTag("main"), false);
check("isImmutableTag 不认 v1", A.isImmutableTag("v1"), false);

/* —— 渲染：永远不会写出一个钉不住的 caller —— */
{
  const out = A.renderCaller(TPL("labels-sync"), { tag: "v1.14.0", qa: true });
  check("占位符都换掉了", /__[A-Z_]+__/.test(out), false);
  check("qa-labels 跟着 --qa 走", /qa-labels:\s*true/.test(out), true);
  check("qa-labels 默认 false", /qa-labels:\s*false/.test(A.renderCaller(TPL("labels-sync"), { tag: "v1.14.0", qa: false })), true);
  throws("钉到分支名当场炸", () => A.renderCaller(TPL("review-gate"), { tag: "main", qa: false }), /不是不可变 tag/);
}
{
  const shim = A.renderShim(fs.readFileSync(path.join(__dirname, "templates", "guard-hook.js"), "utf8"));
  check("守卫入口指向子模块里的 guard-branch.js",
    shim.includes('path.join(__dirname, "..", "vendor", "dev-infra", "shared", "guard-branch.js")'), true);
  check("守卫入口渲染完没有占位符", shim.includes("__GUARD_REL__"), false);
}

/* —— caller 体检：先在自家模板上必须全绿 —— */
for (const kind of ["review-gate", "qa-gate", "labels-sync"]) {
  const text = A.renderCaller(TPL(kind), { tag: "v1.14.0", qa: true });
  const { problems } = A.lintCaller(kind, text, { qa: true });
  check(`${kind} 模板自己过体检`, problems.join(" | "), "");
}

/* —— 然后每一条都要真的判得出来（变异） —— */
function lint(kind, mutate, tag = "v1.14.0", qa = true) {
  return A.lintCaller(kind, mutate(A.renderCaller(TPL(kind), { tag, qa })), { qa }).problems.join(" | ");
}
check("types 里少了 synchronize 判得出来",
  /synchronize/.test(lint("review-gate", (t) => t.replace("types: [labeled, synchronize]", "types: [labeled]"))), true);
check("job 级 if 少了 synchronize 那一半判得出来",
  /synchronize 那一半/.test(lint("review-gate", (t) => t.replace(/if: github\.event\.label\.name.*\n/, "if: github.event.label.name == 'review-passed'\n"))), true);
check("少了 pull-requests: write 判得出来",
  /pull-requests/.test(lint("review-gate", (t) => t.replace(/^\s*pull-requests: write.*$/m, ""))), true);
check("钉在带洞的旧版本判得出来",
  /写锁/.test(lint("review-gate", (t) => t, "v1.12.0")), true);
check("钉到 @main 判得出来",
  /不是不可变 tag/.test(lint("review-gate", (t) => t.replace("@v1.14.0", "@main"))), true);
check("qa-gate 少一个事件判得出来",
  /unlabeled/.test(lint("qa-gate", (t) => t.replace(", unlabeled]", "]"))), true);
check("qa-gate 加了 paths 判得出来",
  /paths/.test(lint("qa-gate", (t) => t.replace("permissions: {}", "permissions: {}\n    paths:\n      - src/**"))), true);
check("给 caller 加 contents: read 判得出来",
  /contents: read/.test(lint("qa-gate", (t) => t.replace("statuses: write", "contents: read\n      statuses: write"))), true);
check("labels-sync 抄了隔壁的 statuses 判得出来",
  /statuses/.test(lint("labels-sync", (t) => t.replace(/^(\s+)issues: write$/m, "$1issues: write\n$1statuses: write"))), true);
check("labels-sync 少了 issues: write 判得出来",
  /issues: write/.test(lint("labels-sync", (t) => t.replace(/^(\s+)issues: write$/m, "$1pull-requests: write"))), true);

/* —— 剥注释那一步的正对照：**两个方向各一条** ——
   这儿上一版是一条选错了路径的变异（「把接线删掉、只留注释里提过，看它还报不报」），
   评审实打出来它在剥与不剥两种实现下**都是绿的**：不剥注释的失效方式不是少报、
   是**多报**——`synchronize` / `review-passed` 在注释里也出现，所以「这两条在不在
   problems 里」根本区分不出两种实现。而那条断言上面当时还写着「一旦丢了当场红」。
   **失效的守卫 + 一句声称它有用的注释**是最糟的组合：下一个人会读着那句话，
   以为剥注释这一步有专门的守卫钉着。所以换成真正会出事的那两条路径。 */

/* 方向一（误报）：接线完全正确，注释里逐字写着 contents: read → 必须绿。
   注释是这儿自己加的，不依赖模板里恰好有那么一句——那样这条断言会随模板措辞变绿变红。 */
check("注释里提到 contents: read 不算接线上有",
  lint("review-gate", (t) => t.replace(/^permissions: \{\}$/m, "# 这条路上一次 checkout 都不做，所以没有 contents: read\npermissions: {}")), "");

/* 方向二（漏报）：接线真的坏了，而注释里带着那个字面量 → 必须红。 */
check("接线坏了而注释里带着字面量时照样判得出来",
  /synchronize 那一半/.test(lint("review-gate", (t) => t.replace(/^(\s+)if: github\.event\.label\.name.*$/m,
    "$1# 这一行必须带 github.event.action == 'synchronize' 那一半，否则写锁永远不跑\n$1if: github.event.label.name == 'review-passed'"))), true);

/* qa-labels 那条一致性判定的正对照，同样两个方向。
   它曾经住在 run.js 里拿文件原文判，于是**一行注释就能把结论翻过来**：
   装了 qa-gate、文件写的是 false、注释里出现 true → 体检报绿，也就是
   「报告说装好了，其实没装」，而实际后果是那两个标签在那个仓里根本不存在。 */
check("qa-labels 只在注释里为 true 时，不算本仓传了 true",
  /装了 qa-gate 却没传/.test(A.lintCaller("labels-sync",
    A.renderCaller(TPL("labels-sync"), { tag: "v1.14.0", qa: false })
      .replace(/^(\s+)qa-labels: false$/m, "$1# 升级时记得把 qa-labels: true 打开\n$1qa-labels: false"),
    { qa: true }).problems.join(" | ")), true);
check("同一份文件在没装 qa-gate 的仓里是对的，不许因为那行注释报错",
  A.lintCaller("labels-sync",
    A.renderCaller(TPL("labels-sync"), { tag: "v1.14.0", qa: false })
      .replace(/^(\s+)qa-labels: false$/m, "$1# 升级时记得把 qa-labels: true 打开\n$1qa-labels: false"),
    { qa: false }).problems.join(" | "), "");

/* 不告诉它本仓装没装 qa-gate 就抛：**静默少一条判定**正是上面那个洞的形状。 */
throws("labels-sync 不给 qa 就抛", () => A.lintCaller("labels-sync", A.renderCaller(TPL("labels-sync"), { tag: "v1.14.0", qa: true })), /必须告诉它/);

/* —— 守卫入口该叫什么名字 ——
   **这条是端到端那一节抓出来的真实 bug**：守卫入口住在消费仓里，所以 node 按消费仓
   自己那份 package.json 决定模块系统。ESM 仓里 `.js` 被当成 ESM → 第一行 require
   就 ReferenceError → PreToolUse 收到「非零退出 + 空 stdout」→ 当成 non-blocking
   error → **命令照常执行**。绿着的、坏的。 */
check("CJS 仓用 .js", A.shimPathFor({}), A.SHIM_PATH);
check("没有 package.json 时用 .js", A.shimPathFor(null), A.SHIM_PATH);
check("ESM 仓必须用 .cjs", A.shimPathFor({ type: "module" }), A.SHIM_PATH_CJS);

/* —— 认出「目标仓库就是 dev-infra 自己」——
   判错的方向在这一条上是不对称的：判成消费仓（漏判）会让脚本去动**可复用工作流本体**
   那三个文件名，而那是各仓共用的唯一一份逻辑；判成自己（误判）最多是拒绝跑一次。
   所以三条都在才算，而且判的是内容不是 remote url——镜像、fork、改过名字的克隆
   都还是这个仓库，url 判据在那几种情况下正好往漏判的方向错。 */
{
  const REUSABLE = "name: review-gate (reusable)\non:\n  workflow_call:\n";
  const CALLER = "name: review-gate\non:\n  pull_request_target:\n    types: [labeled, synchronize]\n";
  const self = { reviewGateYml: REUSABLE, hasSharedGuard: true, hasAdoptScript: true };
  check("三条都在 = 是 dev-infra 自己", A.detectSelfHost(self), true);
  check("消费仓的 caller 不会被认成本体", A.detectSelfHost({ ...self, reviewGateYml: CALLER }), false);
  check("挂了子模块但根上没有 adopt/ 的消费仓不算", A.detectSelfHost({ ...self, hasAdoptScript: false }), false);
  check("没有 shared/guard-branch.js 不算", A.detectSelfHost({ ...self, hasSharedGuard: false }), false);
  check("连 review-gate.yml 都没有的新仓不算", A.detectSelfHost({ ...self, reviewGateYml: null }), false);
  /* 注释里提过 workflow_call 不算数：可复用工作流的 caller 模板里逐字写着这个词
     （它在解释「为什么触发器必须留在 caller」），照原文判会把消费仓判成本体，
     于是脚本在一个真的消费仓里拒绝跑——那一头也不能错。 */
  check("注释里写着 workflow_call 不算",
    A.detectSelfHost({ ...self, reviewGateYml: "# 可复用工作流没有自己的触发器（workflow_call:）\n" + CALLER }), false);
}

/* —— 守卫入口的那条相对路径可以换 ——
   dev-infra 自己那一侧指的是树里的 shared/（它不挂指回自己的子模块）。
   渲染出来的两份除了那一行必须完全一样：各仓不该各有一份不一样的守卫入口，
   本仓那份由 self-adopt.test.js 逐字节钉着。 */
{
  const tpl = fs.readFileSync(path.join(__dirname, "templates", "guard-hook.js"), "utf8");
  const consumer = A.renderShim(tpl);
  const self = A.renderShim(tpl, A.SELF_GUARD_REL);
  check("默认还是消费仓那条路径", consumer.includes('"vendor", "dev-infra"'), true);
  check("本仓那条路径指到树里的 shared/", self.includes('path.join(__dirname, "..", "shared", "guard-branch.js")'), true);
  check("两份只差那一行",
    consumer.split("\n").filter((l) => !l.includes("const GUARD = ")).join("\n"),
    self.split("\n").filter((l) => !l.includes("const GUARD = ")).join("\n"));
  throws("模板里没有那个占位符时要炸，不许静默出一份指不到任何地方的入口",
    () => A.renderShim("const GUARD = 1;\n"), /渲染没命中/);
}

/* —— settings.json 的接线 —— */
{
  const a = A.mergeSettings({});
  check("空 settings 会被接上", a.state, "changed");
  check("接上之后再判一次是 ok", A.mergeSettings(a.next).state, "ok");
  check("不会重复加一条", A.mergeSettings(a.next).next.hooks.PreToolUse.length, 1);

  const other = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node", args: ["x.js"] }] }] } };
  const b = A.mergeSettings(other);
  check("本仓已有别的 Bash hook 时并排加", b.next.hooks.PreToolUse.length, 2);

  /* 直接指进子模块的那种是**反模式**，不是「已经装好了」：子模块为空时它静默放行。 */
  const direct = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node", args: ["vendor/dev-infra/shared/guard-branch.js"] }] }] } };
  const c = A.mergeSettings(direct);
  check("直接指进子模块要报冲突，不许并排加一条了事", c.state, "bad");
  check("报冲突时一个字都不改", JSON.stringify(c.next), JSON.stringify(direct));

  /* 指着另一个扩展名的那份是**装错了**，不是「没装」：并排再加一条的话，
     那条坏的仍然在，而报告会说「接好了」。 */
  const esm = A.mergeSettings(a.next, { shimPath: A.SHIM_PATH_CJS });
  check("扩展名不对要报出来", esm.state, "bad");
  check("扩展名不对时不并排加一条", JSON.stringify(esm.next.hooks.PreToolUse.length), "1");
  check("接进来的那一行用的是要的那个名字",
    JSON.stringify(A.mergeSettings({}, { shimPath: A.SHIM_PATH_CJS }).next).includes(A.SHIM_PATH_CJS), true);
}

/* —— package.json 的接线：一条都不覆盖已有的 —— */
{
  const a = A.mergePackageJson({});
  check("空仓库补三条脚本", a.next.scripts.prepare, A.PREPARE);
  check("补完还会提醒把 test:guard 挂进 npm test", /npm test/.test(a.notes.join("")), true);
  const b = A.mergePackageJson({ scripts: { prepare: "husky install" } });
  check("已有的 prepare 不覆盖", b.next.scripts.prepare, "husky install");
  check("已有的 prepare 要报出来", b.state, "bad");
  const c = A.mergePackageJson({ scripts: { prepare: A.PREPARE, "setup:hooks": "node " + A.SUBMODULE_PATH + "/shared/setup-hooks.js", "test:guard": "node " + A.SUBMODULE_PATH + "/shared/guard-branch.test.js", test: "npm run test:guard" } });
  check("全都接好了就是 ok", c.state, "ok");
}

/* —— adopt/ 自己的模块系统 ——
   消费仓是**以路径直接 `node vendor/dev-infra/adopt/adopt.js`** 调它的，node 按离文件
   最近的 package.json 决定模块系统。没有这一份，`"type": "module"` 的消费仓里
   这个脚本第一行 require 就 ReferenceError——和 shared/ 栽过的是同一个坑。
   下面端到端那一节里有它的正对照（真的删掉它，真的跑，必须炸）。 */
check("adopt/package.json 声明 commonjs",
  JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).type, "commonjs");

/* ==================================================================== 端到端 */

const G = (cwd, ...a) => execFileSync("git",
  ["-c", "protocol.file.allow=always", "-c", "user.email=t@t", "-c", "user.name=t",
   "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...a],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function node(cwd, args, extraEnv) {
  try {
    return { ok: true, out: execFileSync(process.execPath, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always", ...extraEnv } }) };
  } catch (e) {
    return { ok: false, out: ((e.stdout || "") + (e.stderr || "")).trim() };
  }
}

function upstream(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  G(dir, "init", "-q");
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  }
  G(dir, "add", "-A"); G(dir, "commit", "-qm", "init");
  return dir;
}

/* 两种消费仓都要真的跑一遍：CJS（没有 type 的那种）和 **`"type": "module"`**。
   守卫入口住在消费仓里，模块系统跟着消费仓走——所以「它到底拦不拦得住」这件事
   在两种仓库里是两条不同的路，只跑一种等于只验了一半。
   `deep` 那一节（变异、幂等、模块系统的正对照）只在 ESM 那一轮跑，跑两遍不多买到东西。 */
function e2e(variant, consumerPkg, wantShim, deep) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adopt-"));
  try {
    /* 假的 dev-infra：真的把本仓的 shared/ 与 adopt/ 拷进去——消费仓挂上之后
       跑的就是这一份，所以模块系统那一条在这儿是真跑出来的，不是断言出来的。 */
    const infra = path.join(tmp, "infra");
    fs.mkdirSync(infra);
    fs.cpSync(path.join(ROOT, "shared"), path.join(infra, "shared"), { recursive: true });
    fs.cpSync(path.join(ROOT, "adopt"), path.join(infra, "adopt"), { recursive: true });
    G(infra, "init", "-q"); G(infra, "add", "-A"); G(infra, "commit", "-qm", "init");
    G(infra, "tag", "v9.9.0");

    /* 假的 dev-agents：根目录就是那几份角色定义，一个别的文件都没有 */
    const agents = upstream(path.join(tmp, "agents"), Object.fromEntries(
      ["code-reviewer", "qa-tester", "backend-dev"].map((n) => [n + ".md", `---\nname: ${n}\n---\n`])));
    G(agents, "tag", "v1.0.0");

    /* 消费仓：**"type": "module"**，就是 adopt/package.json 那条要防的形状 */
    const repo = path.join(tmp, "consumer");
    fs.mkdirSync(repo);
    G(repo, "init", "-q");
    /* 真仓库里身份是配好的（全局或仓库本地）。**配在仓库本地而不是靠 `-c` 传**：
       adopt 跑的是自己的 git 子进程，`-c` 传给测试这个 helper 的那几个它看不见——
       CI 上正是这么红的（`fatal: empty ident name`）。 */
    G(repo, "config", "user.email", "t@t"); G(repo, "config", "user.name", "t");
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify(consumerPkg, null, 2) + "\n");
    G(repo, "add", "-A"); G(repo, "commit", "-qm", "init");
    G(repo, "switch", "-q", "-c", "chore/接入共享基础设施");

    const base = [path.join(ROOT, "adopt", "adopt.js"), "--repo", repo, "--offline",
      "--infra-url", infra, "--infra-tag", "v9.9.0", "--agents-url", agents, "--agents-tag", "v1.0.0"];

    /* 受保护分支上不许写东西 */
    G(repo, "switch", "-q", "main");
    const onMain = node(repo, base);
    check(`${variant}：main 上拒绝动手`, onMain.ok, false);
    check(`${variant}：拒绝的理由是分支，不是别的`, /受保护分支/.test(onMain.out), true);
    G(repo, "switch", "-q", "chore/接入共享基础设施");

    /* **提交要有身份，而接 agent 定义那一步会提交**（subtree 自己造那两个提交）。
       没身份的机器上 git 是 `fatal: empty ident name`——dev-infra 自己的 runner
       上实测撞到过。要在**动手之前**拒绝：升级那条路会先 `git rm -r` 并提交，
       在那之后失败留下的是「一个角色都没有」的那一版。 */
    const noIdent = node(repo, [...base, "--qa"], { GIT_COMMITTER_NAME: "", GIT_AUTHOR_NAME: "" });
    check(`${variant}：说不出提交者是谁时拒绝动手`, noIdent.ok, false);
    check(`${variant}：而且是在写任何东西之前拒绝的`, fs.existsSync(path.join(repo, ".github/workflows/review-gate.yml")), false);

    /* 接入 */
    const run1 = node(repo, [...base, "--qa"]);
    check(`${variant}：接入跑成` + (run1.ok ? "" : `（${run1.out.split("\n").filter((l) => /❌/.test(l)).join(" / ")}）`), run1.ok, true);

    /* 读不到就返回空串，**不抛**：一条断言失败不该把后面所有断言连跑的机会都拿走
       （CI 上就是这样——subtree 一挂，ESM 那一轮整轮没跑，而报告里只有一条 ✗）。 */
    const read = (p) => { try { return fs.readFileSync(path.join(repo, p), "utf8"); } catch (e) { return ""; } };
    const readJson = (p) => { try { return JSON.parse(read(p)); } catch (e) { return {}; } };
    const has = (p) => fs.existsSync(path.join(repo, p));
    check(`${variant}：写了 review-gate caller`, /@v9\.9\.0\s*$/m.test(read(".github/workflows/review-gate.yml")), true);
    check(`${variant}：写了 qa-gate caller`, has(".github/workflows/qa-gate.yml"), true);
    check(`${variant}：qa-labels 跟着 --qa 置 true`, /qa-labels:\s*true/.test(read(".github/workflows/labels-sync.yml")), true);
    check(`${variant}：守卫入口的扩展名跟着模块系统走`, has(wantShim), true);
    check(`${variant}：PreToolUse 指向守卫入口`,
      JSON.stringify(readJson(".claude/settings.json")).includes(wantShim), true);
    check(`${variant}：package.json 接上 prepare`, (readJson("package.json").scripts || {}).prepare, A.PREPARE);
    check(`${variant}：子模块是 gitlink（160000）`, G(repo, "ls-files", "-s", "--", "vendor/dev-infra").trim().split(/\s+/)[0], "160000");
    check(`${variant}：子模块钉在那个 tag 上`,
      G(repo, "ls-files", "-s", "--", "vendor/dev-infra").trim().split(/\s+/)[1],
      G(infra, "rev-parse", "v9.9.0^{commit}").trim());
    const roles = (p) => { try { return fs.readdirSync(path.join(repo, p)).filter((f) => f.endsWith(".md")).length; } catch (e) { return 0; } };
    check(`${variant}：agent 定义接进来了`, roles(".claude/agents/common"), 3);
    check(`${variant}：VERSION 记着 tag`, readJson(".claude/agents-common.VERSION").tag, "v1.0.0");
    check(`${variant}：装了 skill 存根`, has(".claude/skills/dev-infra/SKILL.md"), true);

    /* 守卫真的拦得住吗：不问形状，直接喂一条 hook JSON 进去。
       这一条同时验了**模块系统**——消费仓是 ESM，adopt/ 与 shared/ 各自那份
       package.json 少一个，这里都会是 ReferenceError 而不是 deny。 */
    G(repo, "add", "-A"); G(repo, "commit", "-qm", "接上共享基础设施");
    /* 喂的是**推送类**命令：它无视当前分支、只看目标 refspec，所以不用切回 main
       （切过去那一版树上还没有这些文件，测的就成了「文件在不在」）。
       `git push origin HEAD:main` 正是绕开 PR 直推主干的标准写法。 */
    const hookIn = JSON.stringify({ tool_input: { command: "git push origin HEAD:main" } });
    const hook = execFileSync(process.execPath, [path.join(repo, wantShim)],
      { cwd: repo, input: hookIn, encoding: "utf8" });
    check(`${variant}：直推受保护分支被守卫拦下`, /"permissionDecision":"deny"/.test(hook), true);
    check(`${variant}：拦它的是守卫本身，不是加载失败或找不到文件`, /受保护分支/.test(hook), true);

    /* 体检：**经消费仓那条路径调**，也就是 ESM 消费仓里的真实跑法 */
    const viaSub = [path.join(repo, "vendor/dev-infra/adopt/adopt.js"), "--check", "--offline",
      "--infra-url", infra, "--infra-tag", "v9.9.0", "--agents-url", agents, "--agents-tag", "v1.0.0"];
    const chk = node(repo, viaSub);
    check(`${variant}：接完之后体检是绿的` + (chk.ok ? "" : `（${chk.out.split("\n").filter((l) => /❌/.test(l)).join(" / ")}）`), chk.ok, true);

    if (!deep) return;

    /* 正对照：把 adopt/package.json 从子模块检出里删掉，同一条命令必须炸，
       而且炸在模块系统上——这就是那一份存在的全部理由。 */
    fs.rmSync(path.join(repo, "vendor/dev-infra/adopt/package.json"));
    const noPkg = node(repo, viaSub);
    check("少了 adopt/package.json 就跑不起来", noPkg.ok, false);
    /* 认的是「ESM 作用域里没有 CJS 那套全局量」这一类，不钉死是 require 还是 module.exports：
       两者都是同一个病（消费仓那份 `"type": "module"` 传染进来了），钉死哪一个先炸
       会让这条断言随着文件里语句的顺序变绿变红。 */
    check("而且炸的正是模块系统", /is not defined in ES module scope|ERR_REQUIRE_ESM/.test(noPkg.out), true);
    fs.writeFileSync(path.join(repo, "vendor/dev-infra/adopt/package.json"), '{\n  "type": "commonjs"\n}\n');

    /* 接线被人改坏时体检必须红 */
    const yml = path.join(repo, ".github/workflows/review-gate.yml");
    const good = fs.readFileSync(yml, "utf8");
    fs.writeFileSync(yml, good.replace("@v9.9.0", "@main"));
    const bad1 = node(repo, viaSub);
    check("钉回 @main 时体检变红", bad1.ok, false);
    check("红的理由说得出是 tag", /不是不可变 tag/.test(bad1.out), true);
    fs.writeFileSync(yml, good.replace("types: [labeled, synchronize]", "types: [labeled]"));
    const bad2 = node(repo, viaSub);
    check("少了 synchronize 时体检变红", bad2.ok, false);
    fs.writeFileSync(yml, good);

    /* 守卫入口被手改时也要红：各仓不该各有一份不一样的守卫入口 */
    const shim = path.join(repo, wantShim);
    fs.writeFileSync(shim, fs.readFileSync(shim, "utf8") + "\n// 手改一行\n");
    check("守卫入口漂了体检变红", node(repo, viaSub).ok, false);

    /* 幂等：清干净再跑一次接入，什么都不该重复 */
    G(repo, "checkout", "--", ".");
    const run2 = node(repo, [...base, "--qa"]);
    check("再跑一次仍然是绿的", run2.ok, true);
    check("PreToolUse 没有被加第二条", (readJson(".claude/settings.json").hooks || {}).PreToolUse.length, 1);
    check("再跑一次不重复接 subtree", roles(".claude/agents/common"), 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.platform === "win32") {
  console.log("  （端到端那一节在 Windows 上跳过：要真的跑 git 钩子与 sh）");
} else {
  /* `git subtree -h` 打完 usage 就非零退出，所以问的是**输出**而不是退出码——
     拿退出码当「装没装」会把端到端整节判成跑不了，而那一节正是这份测试的另一半。 */
  let subtree = "";
  try { subtree = execFileSync("git", ["subtree", "-h"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { subtree = (e.stdout || "") + (e.stderr || ""); }
  if (/usage: git subtree/.test(subtree)) {
    e2e("CJS 消费仓", { name: "c", scripts: { test: "node t.js" } }, "scripts/guard-hook.js", false);
    e2e("ESM 消费仓", { name: "c", type: "module", scripts: { test: "node t.js" } }, "scripts/guard-hook.cjs", true);
  }
  else {
    /* 出声地失败，不是跳过：这一半验的是「真的接得上」，没跑等于没验。 */
    fail++;
    console.error("  ✗ 端到端跑不了：这台机器上没有 git subtree");
  }
}

console.log(`adopt：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
