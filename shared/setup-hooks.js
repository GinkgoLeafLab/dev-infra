/* 把 git 的 core.hooksPath 指到这个 submodule 里的 githooks/，让分支守卫跟着仓库走。
   .git/hooks 不进版本控制，所以必须靠 core.hooksPath 才能对每个克隆生效。
   由消费仓 package.json 的 prepare 钩子在 npm install / npm ci 时自动执行。

   **路径全部相对这个文件自己算**，不写死消费仓的任何目录结构：
   各仓可以把这个 submodule 挂在任何位置，这里用 git rev-parse --show-toplevel
   问出仓库根，再算出 githooks/ 相对它的路径。
   **上一版是写死 ".githooks" 的，那在 submodule 布局下指向一个不存在的目录——
   而 core.hooksPath 指错了 git 一个字都不报，钩子就那么静默地没了。**

   顺带**把钩子文件补成可执行**。git 只会执行有 x 位的钩子，而 x 位丢得掉：
   Windows 上检出、或者这份文件是经 GitHub 的 Contents API 建出来的（那条路一律写
   100644），拿到的就是不可执行的一份。**丢了不会有任何提示**——`git commit` 照常成功，
   只是那一层守卫从此不存在，而所有人都以为它在。
   chmod 在 Windows 上是空操作，那儿 git 本来就不看 x 位，所以这一步只在 POSIX 上有意义。 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HOOKS_DIR = path.join(__dirname, "githooks");
const HOOK = path.join(HOOKS_DIR, "pre-commit");

try {
  /* 仓库根由 git 自己说了算：消费仓可能把这个 submodule 挂在任何深度。 */
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  /* core.hooksPath 存相对路径：绝对路径会把某个人机器上的目录写进 .git/config，
     换台机器或换个克隆位置就失效。posix 分隔符是给 Windows 上的 git 用的。 */
  const rel = path.relative(top, HOOKS_DIR).split(path.sep).join("/");
  execFileSync("git", ["config", "core.hooksPath", rel], { stdio: "ignore" });
  console.log(`git hooks 已指向 ${rel}/（分支守卫生效）`);
} catch (e) {
  console.log("跳过 git hooks 配置（不在 git 仓库里？）");
}

/* 失败要说出来，不许静默：静默的后果正好是「以为受保护，其实没有」。 */
try {
  if (fs.existsSync(HOOK)) {
    const before = fs.statSync(HOOK).mode & 0o777;
    if (!(before & 0o111)) {
      fs.chmodSync(HOOK, 0o755);
      console.log("githooks/pre-commit 补上了可执行位");
    }
  } else {
    console.warn("警告：找不到 githooks/pre-commit，本地分支守卫这一层是关着的");
  }
} catch (e) {
  console.warn("警告：给 githooks/pre-commit 加可执行位失败，本地分支守卫可能不生效：" + e.message);
}
