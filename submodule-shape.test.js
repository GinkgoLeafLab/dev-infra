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

/* —— 3. 钩子目录是白名单 ——
   core.hooksPath 指向这个目录，所以**放进去的任何一个按钩子命名的文件都会在每个消费仓
   自动生效**。把清单钉在这儿，加一个钩子就必须同时改这一行——那正是要的显式性。
   （这也是为什么钩子不直接放 shared/ 根下：那样这条白名单就得把守卫、测试、
   同步脚本全列进来，而它们和「哪些钩子生效」根本不是一回事。） */
const HOOKS_ALLOWED = ["pre-commit"];
const inDir = git("ls-files", "--", "shared/githooks/").split("\n").filter(Boolean)
  .map((p) => p.replace(/^shared\/githooks\//, "")).sort();
check("shared/githooks/ 里只有白名单上的那些", inDir.join(","), HOOKS_ALLOWED.slice().sort().join(","));

console.log(`submodule 形态：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
