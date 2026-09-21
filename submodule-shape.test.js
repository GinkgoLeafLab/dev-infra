/* 这个仓库被各消费仓当 **git submodule** 挂着，所以「上游长什么样」就是「各仓拿到什么」。
   这份测试钉住三件**只在消费仓那边才暴露、而且失效是静默的**事。
   跑法：node submodule-shape.test.js

   为什么这三件事非要有测试：它们失效的时候，这个仓库自己一切正常。
   钩子少了可执行位 → git 直接跳过、不报错；CRLF 混进去 → 只有 Windows 上的人撞到；
   往钩子目录里多放一个文件 → 它在**每一个**消费仓自动生效，而没有任何一处会提到它。 */
const { execFileSync } = require("child_process");
const path = require("path");

const ROOT = __dirname;
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" });

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`  ✗ ${name}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`); }
}

/* —— 1. 钩子的可执行位 ——
   sha256 比不到这一位，所以消费仓那套清单曾经为它单独记一项；换成 submodule 之后
   它由这个仓库的对象库直接载着。少了它 git 跳过钩子且**不报任何错**。
   读的是索引不是盘上的 stat：Windows 上 core.fileMode=false 会让盘上那个值不可信。 */
const HOOK = "shared/githooks/pre-commit";
const entry = git("ls-files", "-s", "--", HOOK).trim();
check(`${HOOK} 在索引里存在`, entry !== "", true);
check(`${HOOK} 是 100755`, entry.split(/\s+/)[0], "100755");

/* —— 2. 行尾 ——
   问的是 .gitattributes 实际生效成什么，不是「文件里有没有那一行」：
   grep 那一行会被一条更靠后的规则悄悄推翻，check-attr 不会。 */
function eolOf(p) {
  const m = /:\s*eol:\s*(\S+)\s*$/.exec(git("check-attr", "eol", "--", p).trim());
  return m ? m[1] : "(没有)";
}
check(`${HOOK} 的 eol`, eolOf(HOOK), "lf");
check("shared/guard-branch.js 的 eol", eolOf("shared/guard-branch.js"), "lf");

/* **上面那条不够，必须再看一眼提交进去的字节。**
   `eol=lf` 的规范化只发生在 **checkin**（`git add` 走 clean 过滤器）；checkout 那一侧
   `eol=lf` 只是「不转成 CRLF」，**不会把已经是 CRLF 的字节转回 LF**。
   而这个仓库的文件**是用 GitHub Contents API 推的**——那条路把给它的字节直接做成 blob，
   一个过滤器都不走。所以一份带 CRLF 的钩子完全可能躺进对象库，
   而 check-attr 那条照样绿：属性是对的，字节是坏的。
   落到消费仓就是 `#!/bin/sh\r` 起不来，git 静默跳过钩子。 */
const raw = git("cat-file", "blob", ":" + HOOK);
check(`${HOOK} 提交进去的字节里没有 CR`, raw.includes("\r"), false);

/* —— 3. 钩子目录是白名单 ——
   core.hooksPath 指向这个目录，所以**放进去的任何一个按钩子命名的文件都会在每个消费仓
   自动生效**。把清单钉在这儿，加一个钩子就必须同时改这一行——那正是要的显式性。
   （这也是为什么钩子不直接放 shared/ 根下：那样这条白名单就得把守卫、测试、
   同步脚本全列进来，而它们和「哪些钩子生效」根本不是一回事。） */
const HOOKS_ALLOWED = ["pre-commit"];
const inDir = git("ls-files", "--", "shared/githooks/").split("\n").filter(Boolean)
  .map((p) => p.replace(/^shared\/githooks\//, "")).sort();
check("shared/githooks/ 里只有白名单上的那些", inDir.join(","), HOOKS_ALLOWED.slice().sort().join(","));

/* —— 4. shared/ 自己声明模块系统 ——
   shared/ 下全是 CommonJS（require），但消费仓是**以路径直接 `node <文件>`** 调它们的
   （pre-commit 钩子、npm 的 prepare、PreToolUse 入口）——node 按**离文件最近的
   package.json** 决定模块系统，而沿着目录往上找到的第一份是**消费仓自己**那份。
   消费仓是 `"type": "module"` 时（dsh 插件仓都是），这里的每一份都会被当成 ESM，
   `require` 当场 ReferenceError。PreToolUse 把非零退出当 non-blocking error——
   **命令照常执行，守卫静默放行**；prepare 在 npm install 时直接炸掉。
   所以模块系统必须由 shared/ 自己声明，不许继承消费仓的默认值。
   失效只发生在消费仓那边、本仓一切正常——正是这份测试管的那一类事。 */
const SHARED_PKG = "shared/package.json";
check(`${SHARED_PKG} 在索引里存在`, git("ls-files", "--", SHARED_PKG).trim() !== "", true);
check(`${SHARED_PKG} 声明 commonjs`,
  JSON.parse(git("cat-file", "blob", ":" + SHARED_PKG)).type, "commonjs");

/* —— 5. 端到端：真的挂成 submodule，真的跑一次提交 ——
   前面三条验的是**形态**（模式、行尾、目录白名单）。形态对、接线错，是这套东西
   已经栽过一次的地方：钩子从 shared/ 挪进 shared/githooks/ 那一版里，
   pre-commit 里那行 `../scripts/guard-branch.js` 和 setup-hooks.js 里写死的
   ".githooks" 都没跟着改，**而三条形态断言全绿**。
   所以这一条不问形状，直接问结果：挂上去、跑 setup-hooks、然后真的提交一次，
   守卫拦不拦得住。 */
/* 两种消费仓都要跑一遍：不带 package.json 的（CJS 默认，今天三个消费仓的形状）
   和 "type": "module" 的（dsh 插件仓的形状）。后者是 shared/package.json 存在
   的全部理由——没有那一行，ESM 消费仓里下面每一条都会红（实测过：
   setup-hooks 第一步就 ReferenceError，守卫经 non-blocking error 静默放行）。 */
function e2e(variant, consumerPkgJson) {
  const fs2 = require("fs"), os = require("os"), cp = require("child_process");
  const dir = fs2.mkdtempSync(path.join(os.tmpdir(), "smwire-"));
  /* protocol.file.allow：git 2.38 起默认禁止从本地路径加 submodule（CVE-2022-39253）。
     这里挂的是本仓自己，不是外来仓库。 */
  const G = (cwd, ...a) => cp.execFileSync("git",
    ["-c", "protocol.file.allow=always", "-c", "user.email=t@t", "-c", "user.name=t", ...a],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    G(dir, "init", "-q", "-b", "main");
    fs2.writeFileSync(path.join(dir, "a.txt"), "1\n");
    G(dir, "add", "-A"); G(dir, "commit", "-qm", "init");
    if (consumerPkgJson) {
      fs2.writeFileSync(path.join(dir, "package.json"), JSON.stringify(consumerPkgJson) + "\n");
      G(dir, "add", "-A"); G(dir, "commit", "-qm", "声明消费仓的模块系统");
    }
    /* 挂在一个**有深度的**路径下：写死 ".githooks" 那种 bug 在浅路径上可能碰巧不暴露 */
    G(dir, "submodule", "add", "-q", ROOT, "vendor/dev-infra");
    G(dir, "commit", "-qm", "挂上 submodule");

    cp.execFileSync(process.execPath, [path.join(dir, "vendor/dev-infra/shared/setup-hooks.js")],
      { cwd: dir, encoding: "utf8" });
    const hooksPath = G(dir, "config", "core.hooksPath").trim();
    check(`${variant}：setup-hooks 把 core.hooksPath 指进了 submodule`, hooksPath, "vendor/dev-infra/shared/githooks");

    /* 在 main 上提交——守卫必须拦下，而且要是**守卫拦的**，不是「找不到文件」那种报错 */
    fs2.writeFileSync(path.join(dir, "a.txt"), "2\n");
    G(dir, "add", "-A");
    let blocked = false, why = "";
    try { G(dir, "commit", "-qm", "该被拦下"); }
    catch (e) { blocked = true; why = ((e.stdout || "") + (e.stderr || "")).trim(); }
    check(`${variant}：在 main 上提交被拦下`, blocked, true);
    /* 这一条是关键：钩子找不到 guard-branch.js 时 node 报的是 MODULE_NOT_FOUND，
       那也会让提交失败——**看起来也像「拦住了」**。所以要认守卫自己的话。
       ESM 消费仓里没有 shared/package.json 时撞的是另一条：require is not defined——
       同样不是守卫自己的话，同样不许混过去。 */
    check(`${variant}：拦它的是守卫本身，不是「找不到文件」或「模块系统错了」`,
      /受保护分支|不允许|守卫/.test(why) && !/Cannot find module|MODULE_NOT_FOUND|require is not defined|ERR_REQUIRE_ESM/.test(why), true);

    /* 反向：特性分支上要放行。只会拦不会放的守卫等于把仓库锁死。 */
    G(dir, "switch", "-q", "-c", "feat/x");
    let ok = true;
    try { G(dir, "commit", "-qm", "特性分支上该放行"); } catch (e) { ok = false; }
    check(`${variant}：特性分支上放行`, ok, true);
  } finally {
    fs2.rmSync(dir, { recursive: true, force: true });
  }
}
if (process.platform === "win32") {
  /* 出声地跳过：钩子是 sh 脚本，这个仓的 CI 只有 ubuntu。静默跳过才是问题。 */
  console.log("  （端到端那一节在 Windows 上跳过：钩子要 sh）");
} else {
  e2e("CJS 消费仓", null);
  e2e("ESM 消费仓", { type: "module" });
}

console.log(`submodule 形态：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
