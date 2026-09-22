/* **这个仓库自己也是消费者**：它的 PR 也走 `review` 门禁，它的克隆也要有分支守卫，
   它也用 dev-agents 那几份角色定义。但它这一侧的形状和别的仓不一样，原因只有一条——
   在这儿 `.github/workflows/review-gate.yml` 这几个名字被**可复用工作流本体**占着。
   所以 caller 一律叫 `self-*.yml`，守卫入口指**树里**的 `shared/`（不挂指回自己的子模块）。
   形状与逐条理由见 README「这个仓库自己也接着这套东西」。

   于是 `adopt/adopt.js --check` 在这个仓库里判不了（它按「那三个名字是 caller」写的，
   在这儿每一条都是反的），它会当场拒绝跑。**本仓这一侧的接线就由这份测试钉着。**
   跑法：node self-adopt.test.js

   钉的全是**漏了不报错**的东西：caller 少一个事件、`paths:` 和文件名对不上、
   守卫入口指到一个不存在的路径、PreToolUse 那一行没接上——每一条失效时
   这个仓库看上去一切正常，只是那道门安静地不在。

   判定逻辑一条都不在这儿自己写：caller 的形状用 adopt.js 里那份 `lintCaller`
   （各仓共用同一份、有自己的测试钉着），守卫入口用 `renderShim`，
   PreToolUse 用 `mergeSettings`。这份文件只负责说「本仓这一侧应该长什么样」。 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const A = require("./adopt/adopt.js");

const ROOT = __dirname;
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" });
const tryGit = (...a) => { try { return { ok: true, out: git(...a).trim() }; } catch (e) { return { ok: false, out: ((e.stdout || "") + (e.stderr || "")).trim() }; } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`  ✗ ${name}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`); }
}

/* 本仓这一侧的两份 caller。**装的是 review + labels-sync，没有 qa-gate**：
   本仓的改动由 test.yml 那一排自动测试覆盖，没有「要人手点一遍」的东西，
   所以不装 qa 门禁、labels-sync 的 `qa-labels` 也必须是 false——给了 true 等于在这个
   仓库里建两个没有任何东西在读的标签。这两半的一致性由 lintCaller 判（传 qa: false）。 */
const WANT_QA = false;
const CALLERS = {
  "review-gate": ".github/workflows/self-review-gate.yml",
  "labels-sync": ".github/workflows/self-labels-sync.yml",
};

/* —— 1. 两份 caller 的形状 ——
   少一个事件、少半个 if、少一个权限、钉到会动的名字：全是「那条路永远不跑、
   而且不报错」的形状。判据复用各仓共用的那一份。 */
for (const [kind, file] of Object.entries(CALLERS)) {
  if (!exists(file)) { fail++; console.error(`  ✗ ${file} 不在`); continue; }
  const { problems } = A.lintCaller(kind, read(file), { qa: WANT_QA });
  check(`${file} 的形状`, problems.join(" / "), "");
}

/* —— 2. 本体没有被 caller 盖掉 ——
   这是这个仓库独有的失效方式，而且是最贵的那一种：谁在这儿跑了写入模式的 adopt，
   或者照着它那份「不是 pull_request_target」的报告去「修」，改的就是**各仓共用的那一份逻辑**。
   所以这三个名字必须一直是 `workflow_call`。 */
for (const f of ["review-gate", "qa-gate", "labels-sync"]) {
  const p = `.github/workflows/${f}.yml`;
  check(`${p} 仍然是可复用工作流本体`, /^\s*workflow_call:/m.test(read(p)), true);
}

/* —— 3. labels-sync caller 的 paths 和它自己的文件名是同一处真相的两半 ——
   那条 push 触发只认这一个路径，而**改那一行 `uses:` 的版本号是标签清单传进本仓的唯一路径**。
   两半对不上时的表现是「升了版本号，这条流水线根本没触发」——绿的，Actions 里
   连一条失败记录都没有。别的仓这两半天生一致（文件名就是模板里那个），本仓改了名，
   所以要单独钉。 */
{
  const text = read(CALLERS["labels-sync"]);
  const paths = [...text.matchAll(/^\s*-\s*'(\.github\/workflows\/[^']+)'/gm)].map((m) => m[1]);
  check("labels-sync caller 的 paths 指着它自己", paths.join(","), CALLERS["labels-sync"]);
}

/* —— 4. 守卫入口 ——
   逐字节等于「上游模板 + 本仓那条路径」。各仓不该各有一份不一样的守卫入口，本仓也一样：
   模板改了而这份没跟着重新生成，这条当场红。
   重新生成：node -e 'const A=require("./adopt/adopt.js"),fs=require("fs");
   fs.writeFileSync("scripts/guard-hook.js",A.renderShim(fs.readFileSync("adopt/templates/guard-hook.js","utf8"),A.SELF_GUARD_REL))' */
const SHIM = "scripts/guard-hook.js";
{
  const want = A.renderShim(read("adopt/templates/guard-hook.js"), A.SELF_GUARD_REL);
  check(`${SHIM} 逐字节等于按本仓那条路径渲染出来的模板`, exists(SHIM) && read(SHIM) === want, true);

  /* 扩展名不是风格问题：本仓 package.json 说 `"type": "commonjs"` 时 `.js` 才成立。
     哪天它变成 `"type": "module"`，这份 `.js` 会被当 ESM 加载、第一行 require 就
     ReferenceError，而 PreToolUse 把非零退出当 non-blocking error——**命令照常执行**。
     所以这两件事必须一起改（改成 scripts/guard-hook.cjs）。 */
  const pkg = JSON.parse(read("package.json"));
  check("守卫入口的扩展名跟本仓的模块系统对得上", "scripts/" + path.basename(SHIM), A.shimPathFor(pkg));

  /* 那条相对路径真的指到一个存在的文件上。指错了 guard-hook 会走「缺席」那一支——
     它是 fail-closed 的（拦住并说话），所以不是灾难，但那等于守卫整层不工作。 */
  const rel = path.join(...A.SELF_GUARD_REL);
  check("守卫入口指着的判定逻辑真的在", exists(path.join("scripts", rel)), true);
}

/* —— 5. PreToolUse ——
   `.claude/settings.json` 里没有指向守卫入口的那一条时，agent 经 Bash 发的 git 命令
   没有任何人拦，而这件事同样不报错。判据复用 mergeSettings：它说 `ok` 才算接上了。 */
{
  const cur = JSON.parse(read(A.SETTINGS_FILE));
  const m = A.mergeSettings(cur, { shimPath: SHIM });
  check("PreToolUse 接着守卫入口", m.state, "ok");
}

/* —— 6. npm 接线 ——
   本仓**不挂子模块**，所以 prepare 只有 setup-hooks 这一步（消费仓那条 `git submodule
   update --init --recursive &&` 在这儿没有对象）。它负责把 core.hooksPath 指到
   shared/githooks——没有它，`git commit` 那一层守卫在每个新克隆里都是关着的，
   而 git 对没配 hooksPath 一个字都不报。 */
{
  const pkg = JSON.parse(read("package.json"));
  const s = pkg.scripts || {};
  check("package.json 声明了模块系统", pkg.type, "commonjs");
  check("prepare 装 git 钩子", s.prepare, "node shared/setup-hooks.js");
  check("setup:hooks 在", s["setup:hooks"], "node shared/setup-hooks.js");
  check("test:guard 在", s["test:guard"], "node shared/guard-branch.test.js");
}

/* —— 7. 不挂指回自己的子模块 ——
   形状声明，防的是「照着别的仓的样子把这儿也补齐」：本仓挂一个指回自己的
   vendor/dev-infra，等于让本仓的钩子跑的是**钉在某个旧 tag 上的那一版守卫**，
   而不是工作区里正在改的这一版——守卫改坏了本仓自己反而感觉不到，
   那正是这套东西要消灭的静默失效。 */
check("没有 vendor/dev-infra 这个自引用子模块", exists("vendor/dev-infra"), false);

/* —— 8. agent 角色定义 ——
   subtree 拉进来的整棵根树 + 一份记着「现在是哪个 tag」的 VERSION。
   **树换了而 VERSION 停在旧 tag 比没有记录更糟**，因为下一个人会信它。 */
{
  const inHead = tryGit("ls-tree", "--name-only", "HEAD", A.AGENTS_PREFIX + "/").out;
  const mdCount = inHead.split("\n").filter((l) => l.endsWith(".md")).length;
  check(`${A.AGENTS_PREFIX} 里有角色定义`, mdCount > 0, true);

  let ver = null;
  try { ver = JSON.parse(read(A.VERSION_FILE)); } catch (e) { /* 下面那条会报 */ }
  check(`${A.VERSION_FILE} 记着 tag 与 commit`, !!(ver && ver.tag && ver.commit && ver.repo), true);

  /* 和上游那个 tag 逐字节比一遍。**这一条要联网**，而「联不上就算过」正是这份测试
     最不该干的事，所以取不到就是失败，不是跳过。真要在没网的地方跑，显式给
     SELF_ADOPT_OFFLINE=1——它会出声地说这条没验过。 */
  if (!ver || !ver.tag) {
    /* 上面那条已经报过了，不重复计数 */
  } else if (process.env.SELF_ADOPT_OFFLINE === "1") {
    console.log(`  （跳过：没跟上游比对 ${A.AGENTS_PREFIX} 的内容——SELF_ADOPT_OFFLINE=1，**这条不算验过**）`);
  } else {
    const url = "https://github.com/" + ver.repo;
    const f = tryGit("fetch", "--quiet", url, "refs/tags/" + ver.tag);
    if (!f.ok) {
      fail++;
      console.error(`  ✗ 取不到 ${url} 的 ${ver.tag}，比不了内容：${f.out.split("\n")[0]}` +
        "（没网的话显式给 SELF_ADOPT_OFFLINE=1，别把它当成过了）");
    } else {
      const d = tryGit("diff", "--quiet", "FETCH_HEAD:", "HEAD:" + A.AGENTS_PREFIX);
      check(`${A.AGENTS_PREFIX} 和上游 ${ver.tag} 逐字节相同`, d.ok, true);
    }
  }
}

/* —— 9. adopt 脚本在这个仓库里必须拒绝跑 ——
   上面那些形状全靠「没有人在这儿跑写入模式的 adopt」才立得住。
   detectSelfHost 判据一旦被改窄（比如有人把它换成看 remote url），
   这个仓库就又能被当成普通消费仓处理了，而那一步是会动本体的。 */
check("adopt 认得出这个仓库是它自己", A.detectSelfHost({
  reviewGateYml: read(".github/workflows/review-gate.yml"),
  hasSharedGuard: exists("shared/guard-branch.js"),
  hasAdoptScript: exists("adopt/adopt.js"),
}), true);

console.log(`本仓自己这一侧的接线：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
