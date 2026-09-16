/* 把 git 指到仓库内的 .githooks/，这样分支守卫能跟着仓库走。
   .git/hooks 不进版本控制，所以必须靠 core.hooksPath 才能对每个克隆生效。
   由 package.json 的 prepare 钩子在 npm install 时自动执行。

   **这份文件是从 GinkgoLeafLab/dev-infra 同步进来的，不要手改。**
   改它去那边走 PR、打 tag，再回来 `node scripts/vendor-infra.js --sync <tag>`。

   顺带**把钩子文件补成可执行**。git 只会执行有 x 位的钩子，而 x 位丢得掉：
   在 Windows 上检出、或者这个文件是经 GitHub 的 Contents API 建出来的（那条路
   一律写成 100644），拿到的就是不可执行的一份。**丢了不会有任何提示**——
   `git commit` 照常成功，只是那一层守卫从此不存在，而所有人都以为它在。
   chmod 在 Windows 上是空操作，那儿 git 本来就不看 x 位，所以这一步只在 POSIX 上有意义。 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HOOK = path.join(__dirname, "..", ".githooks", "pre-commit");

try {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
  console.log("git hooks 已指向 .githooks/（分支守卫生效）");
} catch (e) {
  console.log("跳过 git hooks 配置（不在 git 仓库里？）");
}

/* 失败要说出来，不许静默：静默的后果正好是「以为受保护，其实没有」。 */
try {
  if (fs.existsSync(HOOK)) {
    const before = fs.statSync(HOOK).mode & 0o777;
    if (!(before & 0o111)) {
      fs.chmodSync(HOOK, 0o755);
      console.log(".githooks/pre-commit 补上了可执行位");
    }
  } else {
    console.warn("警告：找不到 .githooks/pre-commit，本地分支守卫这一层是关着的");
  }
} catch (e) {
  console.warn("警告：给 .githooks/pre-commit 加可执行位失败，本地分支守卫可能不生效：" + e.message);
}
