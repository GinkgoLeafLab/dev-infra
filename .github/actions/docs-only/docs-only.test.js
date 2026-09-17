/* 纯文档判定的回归测试：node .github/actions/docs-only/docs-only.test.js

   跟着组合动作走，**不同步进任何消费仓**——它验的是这份判定本身，
   而判定只有这一份。各仓那边该有的是另一种测试，见本文件末尾那段。

   这段代码判错一次的后果不是「测试红了」，而是**一版没跑过测试的代码拿到绿的必需检查**，
   所以它的边界要钉死，尤其是这两条：

   - **非 ASCII 路径。** git 默认把 docs/云服务器验证说明.md 输出成
     "docs/\344\272..."（带引号的八进制转义）——**路径里有一个中文字符就够了**。
     少了 -z 判定会当场失效，而且失效方向不确定，所以这里用真 git 跑一遍，
     光测纯函数是测不出来的
   - **重命名。** 少了 --no-renames，「src/x.js 改名成 docs/x.md」只会看到目标路径，
     被误判成纯文档改动

   **下面那张表只放通用的路径类别**，别往里加某个仓才有的路径（vendor 进来的产物、
   数据集、语言包……）：这份表所有仓共用，写进来的仓库专属路径对别的仓毫无意义。

   **代价要说清楚，别当它不存在**：判定搬成组合动作之后，消费仓里没有这份实现了，
   那边**写不出「拿真的 isDocsOnly 判一遍本仓这几类路径」的测试**。
   照着白名单在那个仓里重写一遍规则**更糟**——那是第二处真相，会静默漂开。
   所以「白名单朝某个仓的路径扩张」这件事，拦它的地方从「那个仓的测试当场红」
   变成了**那个仓升 `uses:` 版本号时的那一次评审**。弱了一档，但它是有人看的一档。 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CLI = path.join(__dirname, "docs-only.js");
const { isDocsOnly } = require("./docs-only.js");

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`  ✗ ${name}：期望 ${want}，实际 ${got}`); }
}

/* —— 纯函数：白名单的边界 —— */
/* [说明, 文件列表, 是不是纯文档] */
const CASES = [
  ["docs 下的中文文件名",        ["docs/云服务器验证说明.md"],              true],
  ["docs 下的非 md 文件",        ["docs/图.png"],                          true],
  ["docs 的子目录",              ["docs/方案/2026-08-某方案.md"],           true],
  ["仓库根的 md",                ["CLAUDE.md", "README.md"],               true],
  [".claude 下的角色与规则",      [".claude/rules/ci-dev.md"],              true],
  ["多个文档一起改",             ["docs/部署.md", "CHANGELOG.md"],          true],
  ["源码",                       ["src/app.js"],                           false],
  ["文档 + 一个源码",            ["docs/部署.md", "src/app.js"],            false],
  ["测试本身",                   ["test.js"],                              false],
  ["判定脚本自己",               [".github/actions/docs-only/docs-only.js"], false],
  ["workflow",                   [".github/workflows/test.yml"],           false],
  ["本地 hook 与权限配置",        [".claude/settings.json"],                false],
  ["构建脚本",                   ["scripts/build.js"],                     false],
  ["数据文件",                   ["data/x.json"],                          false],
  ["名字里带 docs 但不在 docs/",  ["src/docs_helper.js"],                   false],
  ["嵌套目录里的 docs",           ["sub/docs/x.txt"],                       false],
  ["空列表按跑测试处理",          [],                                       false],
];
for (const [name, files, want] of CASES) check(name, isDocsOnly(files), want);
check("不是数组", isDocsOnly(null), false);
check("列表里混进 null", isDocsOnly(["docs/a.md", null]), false);

/* —— 真 git：-z 与 --no-renames 这两条只有跑起来才测得出 —— */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docsonly-"));
  const run = (...a) => execFileSync("git", ["-c", "core.hooksPath=" +
    (process.platform === "win32" ? "NUL" : "/dev/null"), ...a], { cwd: dir, encoding: "utf8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@t");
  run("config", "user.name", "t");
  fs.mkdirSync(path.join(dir, "docs"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "app.js"), "x");
  fs.writeFileSync(path.join(dir, "docs", "部署.md"), "x");
  run("add", "-A");
  run("commit", "-qm", "init");
  return { dir, run };
}

/* 跑一次 CLI，返回它写进 GITHUB_OUTPUT 的值（CI 读的就是这个，不是 stdout）。
   输出文件放在仓库外：放进去会被后面的 git add -A 一起提交，
   自己污染自己要判定的那个 diff。 */
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "docsonly-out-"));
function cli(dir, args) {
  const outFile = path.join(OUT_DIR, "gh_output");
  fs.writeFileSync(outFile, "");
  const stdout = execFileSync(process.execPath, [CLI, ...args], {
    cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: outFile },
  });
  const written = fs.readFileSync(outFile, "utf8").trim();
  return { value: written.replace(/^docs_only=/, ""), stdout };
}

const { dir, run } = makeRepo();
const sha = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
const base = sha();

/* 只动中文名的文档 → 纯文档 */
fs.writeFileSync(path.join(dir, "docs", "云服务器验证说明.md"), "改了");
run("add", "-A"); run("commit", "-qm", "docs");
check("真 git：中文文件名的文档改动", cli(dir, [base, sha()]).value, "true");

/* 同一段历史里再动源码 → 不是纯文档 */
const mid = sha();
fs.writeFileSync(path.join(dir, "src", "app.js"), "改了");
run("add", "-A"); run("commit", "-qm", "src");
check("真 git：文档之后又改了源码", cli(dir, [base, sha()]).value, "false");
check("真 git：只看后一段就是纯源码", cli(dir, [mid, sha()]).value, "false");

/* 把源码改名成文档：--no-renames 保证原路径也出现在列表里 */
const beforeRename = sha();
run("mv", "src/app.js", "docs/app.md");
run("commit", "-qm", "rename");
check("真 git：源码改名成文档不算纯文档", cli(dir, [beforeRename, sha()]).value, "false");

/* 失败方向：拿不准一律跑测试，而且要出声 */
const bad = cli(dir, ["0000000000000000000000000000000000000000", sha()]);
check("全零 SHA 按跑测试处理", bad.value, "false");
check("全零 SHA 有 ::warning::", /::warning::/.test(bad.stdout), true);
check("缺参数按跑测试处理", cli(dir, []).value, "false");
check("SHA 不存在按跑测试处理", cli(dir, ["deadbeef", sha()]).value, "false");

/* --merge-base：PR 的 diff 是「相对分叉点」，不是「相对 base 分支的最新提交」。
   base 分支自己往前走了一步不该把 PR 判成非纯文档。 */
run("switch", "-q", "-c", "feat/x", base);
fs.writeFileSync(path.join(dir, "docs", "新文档.md"), "x");
run("add", "-A"); run("commit", "-qm", "docs on branch");
const prHead = sha();
run("switch", "-q", "main");
const mainTip = sha();                       // main 上有源码改动，且不在 PR 的改动里
check("--merge-base：只看分叉点之后", cli(dir, [mainTip, prHead, "--merge-base"]).value, "true");
check("不给 --merge-base 会把 base 的改动算进来", cli(dir, [mainTip, prHead]).value, "false");

/* —— --skipped：只管那条 ::notice:: 的措辞 ——
   各仓、各条流水线跳过的东西不一样，而这条 notice 是检查页上唯一写着
   「绿不代表做了」的地方。措辞说不准，它就从对冲变成了新的误导。 */
const dflt = cli(dir, [mainTip, prHead, "--merge-base"]);
check("默认 notice 说的是 npm test", /::notice::[^\n]*已跳过 npm test。/.test(dflt.stdout), true);

const custom = cli(dir, [mainTip, prHead, "--merge-base", "--skipped=npm test 与部署"]);
check("--skipped 改得掉 notice 的措辞", /::notice::[^\n]*已跳过 npm test 与部署。/.test(custom.stdout), true);
/* 判定逻辑不许被这个参数碰到：它必须仍然被当成 flag 过滤掉，
   而不是当成第三个位置参数、或者顶掉 base/head。 */
check("--skipped 不影响判定结果", custom.value, "true");
check("--skipped 不会被当成 base/head", cli(dir, ["--skipped=x", mainTip, prHead, "--merge-base"]).value, "true");
/* 不是纯文档时一条 notice 都不该有——那句话只在「跳过了」的时候才成立 */
check("不是纯文档就没有 notice", /::notice::/.test(cli(dir, [mainTip, prHead]).stdout), false);

/* —— 组合动作那一层：把 action.yml 里那段 run 原样跑一遍 ——
   各仓 workflow 里只剩一行 `uses:`，**参数是这段 bash 拼的**，
   所以拼错了没有任何一个仓看得见。这里跑的是从 action.yml 里**抽出来的**那段文本，
   不是照抄一份——照抄的那份改了 YAML 也不会红。

   为什么值得跑而不是 grep 几个关键字：踩过的坑是「`"${args[@]}"` 掉了引号」，
   那时 `--skipped=npm test 与内测部署` 会被词分割成三个参数，
   判定结果一个字都不变、只有那条 notice 从「已跳过 npm test 与内测部署」变成
   「已跳过 npm」——**grep 关键字看不见这种，跑一遍看得见**（做过变异验证）。 */
function extractRun() {
  const text = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");
  const lines = text.split("\n");
  const i = lines.findIndex((l) => /^\s*run:\s*\|\s*$/.test(l));
  if (i < 0) throw new Error("action.yml 里找不到 `run: |`");
  const keyIndent = lines[i].match(/^\s*/)[0].length;
  const body = [];
  let blockIndent = null;
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === "") { body.push(""); continue; }
    const ind = lines[j].match(/^\s*/)[0].length;
    if (ind <= keyIndent) break;
    if (blockIndent === null) blockIndent = ind;
    body.push(lines[j].slice(blockIndent));
  }
  return body.join("\n");
}
const RUN_BODY = extractRun();
/* 抽空了的解析器会让下面每一条都变成空跑，而且全绿——先把这件事排除掉。 */
check("抽得出 action.yml 里那段 run", /node "\$GITHUB_ACTION_PATH\/docs-only\.js"/.test(RUN_BODY), true);

if (process.platform === "win32") {
  /* 出声地跳过：这个仓的 CI 只有 ubuntu，而这段是 bash（数组语法）。
     静默跳过才是问题，跳过本身不是。 */
  console.log("  （组合动作那一层在 Windows 上跳过：需要 bash）");
} else {
  const RUN_FILE = path.join(OUT_DIR, "action-run.sh");
  fs.writeFileSync(RUN_FILE, RUN_BODY);
  /* 和 runner 上一样：组合动作里的 `shell: bash` 就是这几个参数。 */
  function act({ base: b, head: h, mergeBase = "", skipped = "" }) {
    const outFile = path.join(OUT_DIR, "gh_output");
    fs.writeFileSync(outFile, "");
    let stdout = "", code = 0;
    try {
      stdout = execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", RUN_FILE], {
        cwd: dir, encoding: "utf8",
        env: { ...process.env, GITHUB_ACTION_PATH: __dirname, GITHUB_OUTPUT: outFile,
               DOCS_ONLY_BASE: b, DOCS_ONLY_HEAD: h,
               DOCS_ONLY_MERGE_BASE: mergeBase, DOCS_ONLY_SKIPPED: skipped },
      });
    } catch (e) { code = e.status; stdout = (e.stdout || "") + (e.stderr || ""); }
    return { value: fs.readFileSync(outFile, "utf8").trim().replace(/^docs_only=/, ""), stdout, code };
  }

  /* 带空格的中文 --skipped 要原样到达那条 notice——掉了引号这一条就红。 */
  const spaced = act({ base: mainTip, head: prHead, mergeBase: "true", skipped: "npm test 与内测部署" });
  check("动作层：带空格的中文 skipped 原样进 notice",
    /::notice::[^\n]*已跳过 npm test 与内测部署。/.test(spaced.stdout), true);
  check("动作层：merge_base=true 走三点 diff", spaced.value, "true");
  check("动作层：退出码是 0", spaced.code, 0);

  /* 认不出的值落在两点 diff 那一侧——也就是「更容易判成不是纯文档」那一侧。
     这条钉的是失败方向，不是某个具体写法。 */
  check("动作层：merge_base 认不出的值按两点 diff",
    act({ base: mainTip, head: prHead, mergeBase: "yes" }).value, "false");

  /* 调用方忘了 fetch-depth: 0 时 base 取不到。**方向必须是「跑测试」并且出声。** */
  const shallow = act({ base: "0".repeat(40), head: prHead });
  check("动作层：base 取不到按跑测试处理", shallow.value, "false");
  check("动作层：base 取不到要出声", /::warning::/.test(shallow.stdout), true);
  check("动作层：判定失败也不让这一步红", shallow.code, 0);
}

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(OUT_DIR, { recursive: true, force: true });

console.log(`纯文档判定：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
