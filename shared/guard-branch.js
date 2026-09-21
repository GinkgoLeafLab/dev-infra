/* 分支守卫：禁止在受保护分支（main/master）上直接提交，禁止把任何东西直推受保护分支。

   **这份文件是 `GinkgoLeafLab/dev-infra` 的一个 git submodule（挂在 `vendor/dev-infra`）
   带进来的，不是同步来的副本。** 在消费仓里改它一个字节都进不了消费仓自己的历史——
   能改的只有 dev-infra 这边的提交，改了也会在下次移动 submodule 指针时被冲掉。
   要改它去那边走 PR、打新 tag，再回来把这个 submodule 的指针挪到新 tag。

   两个入口共用这一份逻辑：
   1. Claude Code 的 PreToolUse hook —— 从 stdin 读 hook JSON，拦住 agent 的 Bash 调用。
      **它不直接指这份文件**，走各仓自己那份 tracked 的转接脚本 require 到这儿：
      子模块可以是空的，而空的时候 `node <缺失路径>` 是「非零退出、stdout 零字节」，
      PreToolUse 把它当 non-blocking error —— 命令照常执行
   2. githooks/pre-commit —— 和本文件同层的那个钩子目录，消费仓的 core.hooksPath
      指着它（按相对位置算，不写死挂载路径）；带 --pre-commit 参数，
      拦住任何绕过 agent 的本地提交

   用 node 而不是 shell：Windows 的 npm 走 cmd，没有 bash。见 CLAUDE.md「运行环境约束」。

   ## 设计要点（都是第一版栽过的跟头）

   **push 类必须无视当前分支。** 第一版在函数开头写了「当前不在 main 上就整体放行」，
   于是 `git push origin HEAD:main` —— 从特性分支绕开 PR 直推 main 的标准写法 —— 一路畅通。
   agent 平时就待在特性分支上，等于守卫对它最该拦的事完全无感。现在分成两类：
   提交类看当前分支，推送类永远看目标 refspec。

   **判定用 token 全等，不用正则抠子命令。** 第一版拿正则找「git 后面第一个非选项词」，
   `git -C <dir> commit` 和 `git -c k=v commit` 这类「选项 + 独立值」会让它错位到值上面，
   直接放行 —— 而这两种恰恰是 agent 的常用写法。现在把段落切成 token，任一 token 全等于
   危险子命令就拦。`git log --grep=commit` 的 token 是 `--grep=commit`，全等比较不会误伤。

   **宁可误伤，不可漏判。** 这是安全控制：漏判会让人以为受保护而实际没有。
   所以 `echo "git commit"` 这类也会被拦 —— 代价是偶尔要换个写法，比静默失效便宜得多。
   写文档提到提交命令是唯一高频的误伤场景，靠剥 heredoc 正文解决。

   **失败必须 fail-closed。** PreToolUse 的 exit 1 属于 non-blocking error，工具照常执行。
   所以内部任何异常都要在 stdout 上吐出 deny JSON，绝不能靠非零退出码表达「拦住」。

   注意这只是本地约束，改 settings.json 或 git commit --no-verify 都能绕过。
   真正不可绕过的是 GitHub 上的 branch protection / ruleset，见 CLAUDE.md。 */
const { execFileSync } = require("child_process");

const PROTECTED = ["main", "master"];

/* 会在当前分支上造出提交 —— 看当前分支 */
const COMMIT_LIKE = ["commit", "cherry-pick", "revert", "am", "rebase"];
/* 同上，但带 --ff-only 时不产生新提交，是正当的同步操作，要放行 */
const MERGE_LIKE = ["merge", "pull"];
/* 会把东西送上远端 —— 无论当前在哪个分支都要看目标 */
const PUSH = "push";

const ALL_DANGER = [...COMMIT_LIKE, ...MERGE_LIKE, PUSH];

/* 用 -C / --git-dir 指向别的仓库，当前分支就不代表命令实际操作的仓库 */
const GIT_REDIRECTS = ["-C", "--git-dir", "--work-tree"];
/* cd / pushd 出现在命令里任何一段，后面的 git 都可能跑在别的仓库上。
   要看整条命令而不是单段 —— `cd /other && git commit` 里 cd 和 git 分属两段。 */
const SHELL_REDIRECTS = ["cd", "pushd"];

function currentBranch() {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (e) {
    return "";           // 不在 git 仓库里，或者 HEAD 还没出生
  }
}

/* heredoc 正文是数据不是命令。写一份提到 git 的文档（比如 CLAUDE.md 里的分支规则）
   不该被当成真的要提交 —— 这个误伤在加守卫的当天就撞上了。
   终止符允许前置空白（<<- 形式），引号允许 '、"、\ 三种写法。 */
function stripHeredocs(cmd) {
  /* 开界符四种写法：<<EOF、<<'EOF'、<<"EOF"、<<\EOF。
     注意 <<\EOF 的反斜杠只在前面出现，终止符那边没有，所以它不能进反向引用组。

     **正文是从下一行才开始的。** 上一版从 <<EOF 之后就开吃，把开界符同一行上
     `&&` 后面的真命令一起吞掉了 —— `cat > msg <<EOF && git commit -F msg` 因此
     全程放行，而这恰恰是写多行提交信息的标准写法。所以要单独捞出开界符所在行
     的剩余部分（$4）保留下来，只吞真正的正文。 */
  return cmd.replace(
    /(<<-?[ \t]*\\?(['"]?)([A-Za-z_]\w*)\2)([^\n]*)\n[\s\S]*?^[ \t]*\3[ \t]*$/gm,
    (m, opener, quote, name, restOfLine) => "<<HEREDOC" + restOfLine
  );
}

/* 去掉包裹的引号，便于 token 全等比较 */
function unquote(t) {
  return t.replace(/^['"`]+/, "").replace(/['"`]+$/, "");
}

/* 这个 token 是不是在调 git？覆盖 git、git.exe、/usr/bin/git、C:/…/git.exe */
function isGitToken(t) {
  return /^(?:[^\s]*[\\/])?git(?:\.exe)?$/i.test(unquote(t));
}

/* 按 shell 的语句分隔符切段，命令替换的边界也算。

   切之前先把反斜杠续行折成空格：`git \<换行>  commit -m x` 里 git 和 commit
   会被换行切到两段，一段有 git 没危险词、另一段有危险词没 git，两边都不触发。
   先折再切。heredoc 已经剥过，所以正文里的续行不会被误折。 */
function segments(cmd) {
  return stripHeredocs(cmd).replace(/\\\r?\n/g, " ").split(/\|\||&&|[;|&\n()`]|\$\(/);
}

function tokenize(seg) {
  return seg.trim().split(/\s+/).filter(Boolean).map(unquote);
}

/* 推送目标里有没有受保护分支。
   rest = push 之后的 token（已去引号）。branch = 当前分支，用于裸 push 的判定。 */
function pushTargetsProtected(rest, branch) {
  /* --mirror / --all 会把本地全部分支推上去，必然包含受保护分支 */
  if (rest.some(t => t === "--mirror" || t === "--all")) return true;

  /* --delete main：删远端的受保护分支 */
  const delIdx = rest.findIndex(t => t === "--delete" || t === "-d");
  if (delIdx >= 0) {
    return rest.slice(delIdx + 1).some(t => !t.startsWith("-") && isProtectedRef(t));
  }

  const positional = rest.filter(t => !t.startsWith("-"));
  const refs = positional.slice(1);            // 第一个是 remote
  if (!refs.length) {
    /* 裸 git push = 推当前分支。当前分支受保护就拦 */
    return PROTECTED.includes(branch);
  }
  return refs.some(r => {
    /* `src:dst` 取 dst；`:dst` 是删除，同样取 dst；没有冒号就是 src=dst */
    const dst = r.includes(":") ? r.slice(r.lastIndexOf(":") + 1) : r;
    if (dst === "HEAD" || dst === "") return PROTECTED.includes(branch);
    return isProtectedRef(dst);
  });
}

/**
 * 「把 main 同步到 origin/main」是正当操作，该放行。但豁免必须收得很紧 ——
 * 上一版只看「这段里有没有 --ff-only 这个 token」，于是两条都漏了：
 *
 *   git merge --no-ff feat/x -m "was --ff-only"   提交信息里出现就免检，
 *                                                  而它实实在在造了个合并提交
 *   git merge --ff-only feat/x                     名副其实，但把 main 快进到
 *                                                  未评审的分支头上 —— 不产生提交，
 *                                                  却改变了 main 指向，正是要防的事
 *
 * 所以：必须有 --ff-only、不能有 --no-ff/--squash/-m，且目标只能是受保护分支的
 * 远程跟踪引用（origin/main 这种）。
 */
function isSafeFastForward(sub, tokens) {
  if (!tokens.includes("--ff-only")) return false;
  if (tokens.some(t => t === "--no-ff" || t === "--squash" || t === "-m" || t === "--message")) return false;

  const i = tokens.indexOf(sub);
  const positional = tokens.slice(i + 1).filter(t => !t.startsWith("-"));

  if (sub === "pull") {
    /* `git pull --ff-only`（跟上游）或 `git pull --ff-only <remote> <受保护分支>` */
    if (positional.length === 0 || positional.length === 1) return true;
    return positional.length === 2 && PROTECTED.includes(positional[1]);
  }
  /* merge：目标必须写成 origin/main 这样的远程跟踪引用，且只能有一个 */
  if (positional.length !== 1) return false;
  const m = positional[0].match(/^[\w.-]+\/(.+)$/);
  return !!m && PROTECTED.includes(m[1]);
}

/* 剥掉强推的 `+` 前缀和 refs/heads/ 前缀再比对 —— `git push origin +main` 曾因此漏判 */
function isProtectedRef(ref) {
  const name = ref.replace(/^\+/, "").replace(/^refs\/heads\//, "");
  return PROTECTED.includes(name);
}

/**
 * 判断一条命令该不该拦。
 * @returns {{what: string, why: string} | null}
 */
function violation(branch, cmd) {
  const onProtected = PROTECTED.includes(branch);
  const segs = segments(cmd);
  /* 整条命令里任何一段有 cd/pushd，后面的 git 就可能跑在别的仓库上 */
  const shellRedirected = segs.some(s => tokenize(s).some(t => SHELL_REDIRECTS.includes(t)));

  for (const seg of segs) {
    const tokens = tokenize(seg);
    if (!tokens.some(isGitToken)) continue;

    const hit = tokens.find(t => ALL_DANGER.includes(t));
    if (!hit) continue;

    if (hit === PUSH) {
      const i = tokens.indexOf(PUSH);
      if (pushTargetsProtected(tokens.slice(i + 1), branch)) {
        return { what: "git push", why: "这次推送会写到受保护分支" };
      }
      continue;
    }

    if (MERGE_LIKE.includes(hit) && isSafeFastForward(hit, tokens)) continue;

    /* cd 到别处或 -C 指向别的仓库时，当前分支不代表实际操作的仓库 —— fail-closed */
    if (shellRedirected || tokens.some(t => GIT_REDIRECTS.includes(t))) {
      return {
        what: "git " + hit,
        why: "命令里有 cd / -C / --git-dir，无法确定它操作的是哪个仓库的哪个分支",
        /* 这时作者很可能本来就在特性分支上，让他「去开个特性分支」是答非所问 */
        hint: "请去掉 cd / -C / --git-dir，直接在目标仓库的根目录里执行。",
      };
    }
    if (onProtected) return { what: "git " + hit, why: "当前在受保护分支上" };
  }
  return null;
}

function reason(branch, what, why, hint) {
  const head = `已阻止：${why}（当前分支 ${branch || "未知"}），不允许直接 ${what}。`;
  if (hint) return head + "\n" + hint;
  return [
    head,
    "所有改动必须走特性分支 → Pull Request → code-reviewer 评审 → 合并：",
    "  git switch -c <类型>/<简述>     # feat/ fix/ chore/ docs/ refactor/",
    "  git commit ...",
    "  git push -u origin <分支名>",
    "  然后开 PR：GitHub MCP 的 create_pull_request（没挂 MCP 时在网页上点）",
    "",
    "同步 main 用 `git merge --ff-only origin/main`（只快进、不产生提交，不会被拦）。",
  ].join("\n");
}

function deny(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: text,
    },
  }));
}

/* --pre-commit：作为 git 钩子运行，没有 stdin JSON，直接看当前分支 */
if (process.argv.includes("--pre-commit")) {
  const branch = currentBranch();
  if (PROTECTED.includes(branch)) {
    console.error(reason(branch, "git commit", "当前在受保护分支上"));
    process.exit(1);
  }
  process.exit(0);
}

let raw = "";
process.stdin.on("data", d => (raw += d));
process.stdin.on("end", () => {
  try {
    let cmd = "";
    try { cmd = JSON.parse(raw || "{}").tool_input?.command || ""; }
    catch (e) { process.exit(0); }        // 不是合法 hook 输入，不是我们该管的事
    if (!cmd) process.exit(0);

    const branch = currentBranch();
    const v = violation(branch, cmd);
    if (v) deny(reason(branch, v.what, v.why, v.hint));
    process.exit(0);
  } catch (e) {
    /* fail-closed：内部出错时宁可拦住也不能静默放行。
       exit 1 会被当成 non-blocking error 而放行，所以必须走 stdout 的 deny JSON。 */
    deny("分支守卫自身出错，保险起见拦下这条命令：" + (e && e.message));
    process.exit(0);
  }
});

module.exports = { violation, pushTargetsProtected, stripHeredocs, PROTECTED };
