/* 分支守卫的回归测试：npm run test:guard

   **这份文件是 `GinkgoLeafLab/dev-infra` 的一个 git submodule（挂在 `vendor/dev-infra`）
   带进来的，不是同步来的副本。** 在消费仓里改它一个字节都进不了消费仓自己的历史——
   能改的只有 dev-infra 这边的提交，改了也会在下次移动 submodule 指针时被冲掉。
   要改它去那边走 PR、打新 tag，再回来把这个 submodule 的指针挪到新 tag。

   守卫靠扫命令文本判断，天然有边界。这些用例把边界钉死。
   **表里带「第一版漏判」标记的每一条，都是代码评审实测出来的真漏洞** ——
   第一版的守卫对它们全部放行，其中 `git push origin HEAD:main` 是从特性分支
   绕开 PR 直推 main 的标准写法，等于守卫对最该拦的事完全无感。

   在临时仓库里跑，因为判定依赖「当前分支是什么」。
   断言要 JSON.parse 后逐字段查：只查 '"deny"' 子串的话，JSON 结构写错
   （字段名拼错、hookEventName 写错）Claude Code 会忽略这次决定照常放行，
   而测试仍然全绿 —— 这正是第一版测试的毛病。 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const GUARD = path.join(__dirname, "guard-branch.js");
const NL = "\n";
const G = "g" + "it ";   // 拆开写，免得这个文件自己被守卫拦住

function makeRepo(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
  const run = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  run("init", "-q", "-b", branch);
  run("config", "user.email", "t@t");
  run("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "f"), "x");
  run("add", "f");
  run("-c", "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
      "commit", "-qm", "init");
  return dir;
}

/** 跑一次 hook，返回 true=拦住。顺带校验 deny JSON 的结构完整性。 */
function denied(cwd, command) {
  const out = execFileSync(process.execPath, [GUARD], {
    cwd, input: JSON.stringify({ tool_input: { command } }), encoding: "utf8",
  });
  if (!out.trim()) return false;
  const j = JSON.parse(out);                       // 不合法 JSON 直接抛，测试失败
  const h = j.hookSpecificOutput;
  if (!h) throw new Error("缺少 hookSpecificOutput");
  if (h.hookEventName !== "PreToolUse") throw new Error("hookEventName 错：" + h.hookEventName);
  if (h.permissionDecision !== "deny") throw new Error("permissionDecision 错：" + h.permissionDecision);
  if (!h.permissionDecisionReason) throw new Error("deny 没给理由");
  return true;
}

/* [说明, 命令, 在 main 上该拦?, 在 feat/x 上该拦?] */
const CASES = [
  // —— 提交类：看当前分支 ——
  ["真提交",                  G + "commit -m x",                       true,  false],
  ["复合命令里的提交",         "npm test && " + G + "commit -m x",       true,  false],
  ["--no-verify 不豁免",       G + "commit --no-verify -m x",           true,  false],
  ["--amend",                 G + "commit --amend --no-edit",          true,  false],
  ["cherry-pick",             G + "cherry-pick abc123",                true,  false],
  ["revert（第一版漏判）",      G + "revert --no-edit HEAD",             true,  false],
  ["rebase（第一版漏判）",      G + "rebase chore/x",                    true,  false],
  ["am（第一版漏判）",          G + "am 0001.patch",                     true,  false],
  ["merge",                   G + "merge feature/x",                   true,  false],
  ["pull（第一版漏判）",        G + "pull --no-rebase origin main",      true,  false],

  // —— -C / -c 带值选项：第一版正则会错位到值上面，全部放行 ——
  ["-C 指向别处（第一版漏判）",  G + "-C /repo commit -m x",              true,  true],
  /* -c 只设 config，不改仓库，所以特性分支上是正当提交，只在 main 上拦 */
  ["-c 设身份（第一版漏判）",    G + "-c user.email=a@b commit -m x",     true,  false],
  ["cd 到别处（第一版漏判）",    "cd /other && " + G + "commit -m x",     true,  true],

  // —— push：无论当前在哪个分支，都要看目标 refspec ——
  ["裸推送",                   G + "push",                              true,  false],
  ["显式推 main",              G + "push origin main",                  true,  true],
  ["HEAD:main（第一版漏判）",   G + "push origin HEAD:main",             true,  true],
  ["feat:main（第一版漏判）",   G + "push origin feat/x:main",           true,  true],
  ["强推 HEAD:main（第一版漏判）", G + "push -f origin HEAD:main",       true,  true],
  ["+main（第一版漏判）",       G + "push origin +main",                 true,  true],
  ["+refs/heads/main",         G + "push origin +refs/heads/main",      true,  true],
  ["删除 main",                G + "push origin :main",                 true,  true],
  ["--delete main",            G + "push origin --delete main",         true,  true],
  ["--mirror",                 G + "push --mirror origin",              true,  true],
  ["--all",                    G + "push --all origin",                 true,  true],
  ["推特性分支",                G + "push origin feat/x",                false, false],
  ["推特性分支（-u）",          G + "push -u origin feat/x",             false, false],

  // —— 同步 main 是正当操作，不产生提交，必须放行 ——
  ["merge --ff-only origin/main", G + "merge --ff-only origin/main",    false, false],
  ["pull --ff-only",           G + "pull --ff-only origin main",        false, false],
  ["pull --ff-only 无参",       G + "pull --ff-only",                    false, false],

  // —— --ff-only 豁免不能被骗（第二轮评审实测漏判）——
  ["--ff-only 出现在消息里",    G + 'merge --no-ff feat/x -m "was --ff-only"', true, false],
  ["--ff-only 混 -m",          G + 'merge --ff-only feat/x -m "--ff-only"',   true, false],
  ["--ff-only 快进到特性分支",  G + "merge --ff-only feat/x",            true,  false],
  ["--ff-only 快进到别人的 main", G + "merge --ff-only upstream/main",   false, false],
  ["pull --ff-only 拉特性分支", G + "pull --ff-only origin feat/x",      true,  false],

  // —— 命令被切散导致漏判（第二轮评审实测）——
  ["heredoc 同行 && 提交",      "cat > msg <<EOF && " + G + "commit -F msg" + NL + "标题" + NL + "EOF", true, false],
  ["heredoc 同行 && 推送",      "cat <<EOF && " + G + "push origin main" + NL + "x" + NL + "EOF",       true, true],
  ["反斜杠续行",                G + "\\" + NL + "  commit -m x",         true,  false],
  ["反斜杠续行 + push",         G + "push \\" + NL + "  origin main",    true,  true],

  // —— 不该误伤 ——
  ["git log --grep=commit",    G + "log --grep=commit",                 false, false],
  ["git status",               G + "status",                            false, false],
  ["git diff",                 G + "diff main...HEAD",                  false, false],
  ["git fetch",                G + "fetch -p origin",                   false, false],
  ["无关命令",                  "npm test",                              false, false],
  ["名字含 commit 的分支",      G + "push origin feat/add-commit-hook",  false, false],
  ["heredoc 正文提到",         "cat > a <<'EOF'" + NL + G + "commit -m z" + NL + G + "push" + NL + "EOF", false, false],
  ["heredoc 缩进终止符",       "cat > a <<-EOF" + NL + G + "commit -m z" + NL + "\tEOF",                  false, false],
  ["heredoc 反斜杠引号",       "cat > a <<\\EOF" + NL + G + "commit -m z" + NL + "EOF",                   false, false],
  ["heredoc 后接真提交",       "cat > a <<'EOF'" + NL + "x" + NL + "EOF" + NL + G + "commit -m x",        true,  false],
];

let pass = 0, fail = 0;
const protectedRepo = makeRepo("main");
const featureRepo = makeRepo("feat/x");

for (const [name, cmd, wantMain, wantFeat] of CASES) {
  for (const [where, dir, want] of [["main", protectedRepo, wantMain], ["feat/x", featureRepo, wantFeat]]) {
    let got, err = null;
    try { got = denied(dir, cmd); } catch (e) { err = e; }
    if (err) { fail++; console.error(`  ✗ [${where}] ${name}：${err.message}`); }
    else if (got === want) pass++;
    else { fail++; console.error(`  ✗ [${where}] ${name}：期望${want ? "拦住" : "放行"}，实际${got ? "拦住" : "放行"}`); }
  }
}

/* --pre-commit 入口（第一版完全没测） */
for (const [where, dir, want] of [["main", protectedRepo, 1], ["feat/x", featureRepo, 0]]) {
  let code = 0;
  try { execFileSync(process.execPath, [GUARD, "--pre-commit"], { cwd: dir, stdio: "pipe" }); }
  catch (e) { code = e.status; }
  if (code === want) pass++;
  else { fail++; console.error(`  ✗ [--pre-commit ${where}]：期望退出码 ${want}，实际 ${code}`); }
}

/* 非法 stdin 与非仓库目录：都该安静放行，不该崩 */
for (const [name, input] of [["非法 JSON", "not json"], ["空输入", ""], ["没有 command", "{}"]]) {
  const out = execFileSync(process.execPath, [GUARD], { cwd: protectedRepo, input, encoding: "utf8" });
  if (!out.trim()) pass++;
  else { fail++; console.error(`  ✗ [${name}]：应放行，实际输出 ${out.slice(0, 60)}`); }
}

console.log(`分支守卫：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
