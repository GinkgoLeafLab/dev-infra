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

   - **not-docs（调用方声明「这些路径不算文档」）。** 其余输入写错了，判定只会往
     「跑测试」那边偏；只有它不是：声明了却没命中，本该跑的测试就被跳过。所以命中语义
     （优先级先于 docs/ 与 .md、`*` 不跨目录、NFC）逐条钉死，而且「写法不认识」
     必须落在「跑测试」那边并出声

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
const { isDocsOnly, isDocFile, parseNotDocs } = require("./docs-only.js");

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
  [".claude 下的角色与规则（配置，不是文档）", [".claude/rules/ci-dev.md"],        false],
  [".claude 下的 skill",         [".claude/skills/ci-dev-rules/SKILL.md"], false],
  [".claude 下的共享角色定义",    [".claude/agents/common/ci-dev.md"],      false],
  ["嵌套目录里的 .claude",        ["sub/.claude/x.md"],                     false],
  ["多个文档一起改",             ["docs/部署.md", "CHANGELOG.md"],          true],
  ["名字带 .claude 但不是目录段——仍是文档", ["src/my.claude.md"],          true],
  ["目录名以 .claude 结尾但不是它——仍是文档", ["x/my.claude/y.md"],       true],
  ["以 .claudeignore.md 结尾——仍是文档",   [".claudeignore.md"],          true],
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

/* —— not-docs：命中语义 ——
   不传 not-docs 的那一整张表（上面 CASES）就是「不给参数行为不变」的断言，一条没改。
   这里的表多一列 glob 原文。
   [说明, 文件列表, not-docs 原文, 是不是纯文档] */
const NL = "\n";
const MATRIX = "**/矩阵.md";
const ND_CASES = [
  // 优先级：docs/ 与 .md 两条规则都在它后面。主用例 `**/矩阵.md` 命中的路径按理全是 .md，
  // 所以「先于 .md 规则」是这里每一条 false 的前提，「先于 docs/ 规则」是 docs/ 那两条。
  ["模块目录下的矩阵不算文档",                 ["src/modules/x/矩阵.md"],   MATRIX, false],
  ["docs/ 下的矩阵也不算（先于 docs/ 规则）",  ["docs/方案/矩阵.md"],       MATRIX, false],
  ["docs/ 根下的矩阵也不算",                   ["docs/矩阵.md"],            MATRIX, false],
  ["仓库根的矩阵不算（** 可以是零段）",         ["矩阵.md"],                MATRIX, false],
  ["很深的目录也命中（** 可以是多段）",         ["a/b/c/d/矩阵.md"],         MATRIX, false],
  ["普通 src 下的 md 仍是文档",                ["src/a.md"],                MATRIX, true],
  ["普通 docs 下的 md 仍是文档",               ["docs/a.md"],               MATRIX, true],
  ["根目录的 README 仍是文档",                 ["README.md"],               MATRIX, true],
  ["文档 + 矩阵 → 整体不是纯文档",             ["docs/a.md", "src/modules/x/矩阵.md"], MATRIX, false],
  [".claude 下的 md 仍不是文档（老规则不变）", [".claude/rules/x.md"],      MATRIX, false],
  // 从头到尾匹配：不许只命中一段
  ["前缀不算命中：名字里多了字符",              ["docs/x矩阵.md"],           MATRIX, true],
  ["后缀不算命中：名字后面多了字符",            ["docs/矩阵.md.txt"],        MATRIX, true],
  ["同名的目录不算命中",                        ["docs/矩阵.md/b.md"],       MATRIX, true],
  // 转义：`.` 不是「任意字符」
  ["点号按字面匹配",                            ["docs/矩阵Xmd"],            MATRIX, true],
  ["区分大小写",                                ["docs/A.md"],               "**/a.md", true],
  // `*` 不跨目录
  ["* 匹配一段之内",                            ["src/x/矩阵.md"],           "src/*/矩阵.md", false],
  ["* 不跨 /（两层就不命中）",                  ["src/x/y/矩阵.md"],         "src/*/矩阵.md", true],
  ["* 不能凭空吞掉一段",                        ["src/矩阵.md"],             "src/*/矩阵.md", true],
  ["文件名里的 *",                              ["src/a.md"],                "src/*.md", false],
  ["文件名里的 * 也不跨 /",                     ["src/x/a.md"],              "src/*.md", true],
  // 中间的 **/
  ["中间的 **/ 可以是零段",                     ["src/矩阵.md"],             "src/**/矩阵.md", false],
  ["中间的 **/ 可以是多段",                     ["src/a/b/矩阵.md"],         "src/**/矩阵.md", false],
  ["中间的 **/ 不改变前缀",                     ["lib/矩阵.md"],             "src/**/矩阵.md", true],
  // 其余元字符按字面：`?` `[` `(` `+` 不是通配符或分组
  ["? 按字面匹配（不是单字符通配）",            ["docs/ab.md"],              "docs/a?.md", true],
  ["? 字面命中",                                ["docs/a?.md"],              "docs/a?.md", false],
  ["[ ] 按字面匹配（不是字符类）",              ["docs/a.md"],               "docs/[a].md", true],
  ["( + 按字面匹配",                            ["docs/a(1)+.md"],           "docs/a(1)+.md", false],
  // 多行：换行分隔，空行与首尾空白（含 CRLF）忽略
  ["多行：第一行命中",                          ["a/矩阵.md"],               "**/矩阵.md" + NL + "**/SPEC.md", false],
  ["多行：第二行命中",                          ["a/SPEC.md"],               "**/矩阵.md" + NL + "**/SPEC.md", false],
  ["多行：都不命中的仍是文档",                  ["a/x.md"],                  "**/矩阵.md" + NL + "**/SPEC.md", true],
  ["多行：空行与首尾空白被忽略",                ["a/SPEC.md"],               NL + "  **/矩阵.md  " + NL + NL + "\t**/SPEC.md\t" + NL, false],
  ["多行：行尾空白被忽略（只有尾部，模式本身合法）", ["a/矩阵.md"],       "**/矩阵.md   ", false],
  ["多行：行尾制表符被忽略",                    ["a/矩阵.md"],               "**/矩阵.md\t", false],
  ["多行：CRLF",                                ["a/SPEC.md"],               "**/矩阵.md\r\n**/SPEC.md\r\n", false],
  ["多行：模式里的空格保留",                    ["a/my matrix.md"],          "**/my matrix.md", false],
  // 空原文 = 没传
  ["空原文等于没传（docs 仍是文档）",           ["docs/矩阵.md"],            "", true],
  ["全是空行等于没传",                          ["docs/矩阵.md"],            NL + "  " + NL, true],
];
for (const [name, files, raw, want] of ND_CASES) {
  /* 解析抛了要记成这一条红，而不是让整个测试脚本带着堆栈崩掉后面几百条 */
  let got;
  try { got = isDocsOnly(files, parseNotDocs(raw)); } catch (e) { got = "抛了：" + e.message; }
  check("not-docs：" + name, got, want);
}
/* 空传与不传等价：这是「不给参数一个字节都不变」在纯函数层的落点 */
for (const [name, files, want] of CASES) {
  check("not-docs 为空数组时旧断言照旧：" + name, isDocsOnly(files, []), want);
  check("not-docs 为 undefined 时旧断言照旧：" + name, isDocsOnly(files, undefined), want);
}

/* NFC：git diff -z 给的是磁盘上的原始字节，模式是人在 YAML 里敲的。
   这里选的字符**必须真的会被规范化改变**，否则这几条对着不变的字符串比，
   拿掉规范化也照样绿——先用 sanity 排除这个空跑。
   é：NFC 是一个码位，NFD 是 e + 组合重音符；U+F900 是 CJK 兼容表意字，NFC 之后变成 U+8C48。
   **两个非 NFC 的值一律用 String.fromCodePoint 造出来，不写字面字符**：写成字面字符，任何一次编辑器保存或传输做了规范化，
   这几条就退化成「拿两个相同的字符串比」——sanity 会红，但红的原因是文件被改了，不是判定坏了。 */
const E_NFC = "café";
const E_NFD = "cafe" + String.fromCodePoint(0x0301);   // e + U+0301 组合重音符
const CJK_COMPAT = String.fromCodePoint(0xF900);   // U+F900 兼容表意字，NFC 归一成 U+8C48
check("NFC sanity：é 的两种形式确实不同", E_NFC !== E_NFD, true);
check("NFC sanity：NFD 规范化之后等于 NFC", E_NFD.normalize("NFC") === E_NFC, true);
check("NFC sanity：兼容表意字确实会变", CJK_COMPAT.normalize("NFC") !== CJK_COMPAT, true);
check("NFC：路径是 NFD、模式是 NFC",
  isDocsOnly([`src/${E_NFD}矩阵.md`], parseNotDocs(`**/${E_NFC}矩阵.md`)), false);
check("NFC：路径是 NFC、模式是 NFD",
  isDocsOnly([`src/${E_NFC}矩阵.md`], parseNotDocs(`**/${E_NFD}矩阵.md`)), false);
check("NFC：docs/ 下的 NFD 路径也命中（先于 docs/ 规则）",
  isDocsOnly([`docs/${E_NFD}/矩阵.md`], parseNotDocs(`docs/${E_NFC}/矩阵.md`)), false);
check("NFC：中文路径里的兼容表意字（路径原始字节）",
  isDocsOnly([`docs/${CJK_COMPAT}矩阵.md`], parseNotDocs(`**/${CJK_COMPAT.normalize("NFC")}矩阵.md`)), false);
check("NFC：换一个字符就不命中（不是万能匹配）",
  isDocsOnly([`docs/${E_NFD}矩阵.md`], parseNotDocs(`**/cafa矩阵.md`)), true);

/* 「写法不认识」——parseNotDocs 必须抛，main 才能接住并按跑测试处理。
   每一条都对应一种「写了却永远命不中」的写法。 */
function throws(name, raw) {
  let threw = false;
  try { parseNotDocs(raw); } catch { threw = true; }
  check("parseNotDocs 拒绝：" + name, threw, true);
}
throws("结尾的 ** 不成 **/（docs/**）", "docs/**");
throws("** 夹在名字中间（a**b）", "a**b/c.md");
throws("** 不在段首（src/x**/y）", "src/x**/y");
throws("三个星号", "***/x.md");
throws("整个模式就是 **", "**");
throws("多行里有一行坏了整个参数作废", "**/矩阵.md" + NL + "docs/**");
throws("以 / 开头", "/矩阵.md");
throws("以 ./ 开头", "./矩阵.md");
throws("不是字符串", 42);
check("parseNotDocs：不给就是空列表", parseNotDocs(undefined).length, 0);
check("parseNotDocs：一行一条", parseNotDocs("a/*.md" + NL + NL + "**/b.md").length, 2);

/* isDocFile 收到形状不对的 not-docs：不许判成文档（传错的参数只能往「跑测试」那边错） */
check("isDocFile：not-docs 不是数组 → 不是文档", isDocFile("docs/a.md", "**/矩阵.md"), false);
check("isDocFile：not-docs 里混进字符串 → 不是文档", isDocFile("docs/a.md", ["**/矩阵.md"]), false);
check("isDocFile：not-docs 是 null → 不是文档", isDocFile("docs/a.md", null), false);

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

/* —— not-docs：真 git（-z 给出的原始字节路径）+ 走 main() ——
   纯函数那一节验的是匹配语义；这里验的是「参数经过 main 的 flag 解析、真的 git diff -z
   之后，还是那个语义」。每一组都先跑一遍**不带 --not-docs** 的正对照：矩阵这类路径
   在今天的白名单下就是纯文档，不先证明这一点，「带了参数变 false」就可能是别的原因。 */
const ND = makeRepo();
const ndHead = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: ND.dir, encoding: "utf8" }).trim();
let ndN = 0;
function ndCommit(names) {
  const from = ndHead();
  for (const n of names) {
    const abs = path.join(ND.dir, n);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `v${++ndN}`);          // 每次内容不同，保证每个文件都真的出现在 diff 里
  }
  ND.run("add", "-A"); ND.run("commit", "-qm", "c" + ndN);
  return [from, ndHead()];
}
const ndArg = (raw) => "--not-docs=" + raw;

const [mFrom, mTo] = ndCommit(["src/modules/x/矩阵.md"]);
check("真 git：只改模块矩阵，不带参数按老规则是纯文档（正对照）", cli(ND.dir, [mFrom, mTo]).value, "true");
check("真 git：只改模块矩阵，带 --not-docs 不是纯文档", cli(ND.dir, [mFrom, mTo, ndArg(MATRIX)]).value, "false");
check("真 git：--merge-base 与 --not-docs 一起用",
  cli(ND.dir, [mFrom, mTo, "--merge-base", ndArg(MATRIX)]).value, "false");
check("真 git：flag 放在 SHA 前面也认", cli(ND.dir, [ndArg(MATRIX), mFrom, mTo]).value, "false");
const ndOut = cli(ND.dir, [mFrom, mTo, ndArg(MATRIX)]).stdout;
check("真 git：非纯文档时没有 notice", /::notice::/.test(ndOut), false);
check("真 git：非纯文档的说明里点得出是哪个文件", ndOut.includes("src/modules/x/矩阵.md"), true);

const [dFrom, dTo] = ndCommit(["docs/方案/矩阵.md"]);
check("真 git：只改 docs/ 下的矩阵，不带参数是纯文档（正对照）", cli(ND.dir, [dFrom, dTo]).value, "true");
check("真 git：只改 docs/ 下的矩阵，带 --not-docs 不是纯文档（优先级）", cli(ND.dir, [dFrom, dTo, ndArg(MATRIX)]).value, "false");

const [rFrom, rTo] = ndCommit(["矩阵.md"]);
check("真 git：只改根目录的矩阵，不带参数是纯文档（正对照）", cli(ND.dir, [rFrom, rTo]).value, "true");
check("真 git：只改根目录的矩阵，带 --not-docs 不是纯文档", cli(ND.dir, [rFrom, rTo, ndArg(MATRIX)]).value, "false");

const [pFrom, pTo] = ndCommit(["src/a.md", "docs/a.md"]);
check("真 git：普通 md 带 --not-docs 仍是纯文档", cli(ND.dir, [pFrom, pTo, ndArg(MATRIX)]).value, "true");
const pd = cli(ND.dir, [pFrom, pTo, ndArg(MATRIX)]);
check("真 git：普通 md 仍是纯文档时 notice 照旧", /::notice::[^\n]*已跳过 npm test。/.test(pd.stdout), true);

/* 多个提交跨过去：只要区间里有一个矩阵就整体不是纯文档 */
check("真 git：区间里混着矩阵与普通文档 → 不是纯文档", cli(ND.dir, [pFrom, rTo, ndArg(MATRIX)]).value, "false");

/* NFD 路径：磁盘上真写一个 NFD 名字的文件。macOS 的 git 默认会把它转成 NFC（core.precomposeunicode），
   Linux 原样保留——两种平台上模式都是 NFC 写的，都必须命中。 */
const [nFrom, nTo] = ndCommit([`src/${E_NFD}/矩阵.md`]);
check("真 git：NFD 路径，不带参数是纯文档（正对照）", cli(ND.dir, [nFrom, nTo]).value, "true");
check("真 git：NFD 路径 + NFC 模式命中", cli(ND.dir, [nFrom, nTo, ndArg(`**/${E_NFC}/矩阵.md`)]).value, "false");

/* 多行参数：换行、空行、首尾空白、中文经过 argv 原样到达。第二行才是真正命中的那条 */
const [sFrom, sTo] = ndCommit(["a/规格.md"]);
const multi = "**/矩阵.md" + NL + NL + "  **/规格.md  " + NL;
check("真 git：多行参数的第二行命中", cli(ND.dir, [sFrom, sTo, ndArg(multi)]).value, "false");
check("真 git：多行参数没有一行命中就仍是纯文档", cli(ND.dir, [sFrom, sTo, ndArg("**/矩阵.md" + NL + "**/SPEC.md")]).value, "true");

/* 失败方向：参数解析出错 → 跑测试 + 出声。区间本身是纯文档（正对照见上），
   所以「true」只可能来自「把坏参数当成没传」——那正是这里要拦的。 */
for (const [name, raw] of [
  ["结尾的 **", "docs/**"],
  ["** 不成 **/", "a**b/矩阵.md"],
  ["以 / 开头", "/矩阵.md"],
  ["好的一行 + 坏的一行", "**/矩阵.md" + NL + "docs/**"],
]) {
  const r = cli(ND.dir, [pFrom, pTo, ndArg(raw)]);
  check(`失败方向：${name} → 按跑测试处理`, r.value, "false");
  check(`失败方向：${name} → 出声`, /::warning::[^\n]*not-docs/.test(r.stdout), true);
  check(`失败方向：${name} → 没有 notice`, /::notice::/.test(r.stdout), false);
}
const bare = cli(ND.dir, [pFrom, pTo, "--not-docs"]);
check("失败方向：光秃秃的 --not-docs（漏了 =）→ 按跑测试处理", bare.value, "false");
check("失败方向：光秃秃的 --not-docs → 出声", /::warning::/.test(bare.stdout), true);
/* 坏参数不许盖过 base/head 那一路的失败方向，反过来也一样 */
check("失败方向：坏参数 + 坏 SHA 仍是 false", cli(ND.dir, ["deadbeef", pTo, ndArg("docs/**")]).value, "false");
/* 空值 = 没传：这是 action.yml 里 `-n` 判断之外的第二道，不许把空值当成解析失败去吓人 */
const empty = cli(ND.dir, [pFrom, pTo, ndArg("")]);
check("空的 --not-docs= 等于没传", empty.value, "true");
check("空的 --not-docs= 不打 warning", /::warning::/.test(empty.stdout), false);
/* 不给参数：stdout 与旧行为一致（没有多出任何一行） */
check("不给 --not-docs：stdout 只有判定与 notice 两行", cli(ND.dir, [pFrom, pTo]).stdout.trim().split("\n").length, 2);

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

/* action.yml 的 env 那几行**跑不到**：下面那几条是自己塞 DOCS_ONLY_* 环境变量的
   （runner 上那一步才是 `${{ inputs.x }}` 展开出来的）。所以引用了一个没声明的
   input 这件事，执行验不到——GitHub 那边它会安静地展开成空串，
   表现是「--skipped 或 --merge-base 悄悄失效」，判定照常绿。这里单独对一遍。 */
function actionYaml() {
  return fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");
}
const DECLARED = (() => {
  const text = actionYaml();
  const i = text.indexOf("\ninputs:\n");
  const rest = text.slice(i + 1).split("\n").slice(1);
  const names = [];
  for (const l of rest) {
    if (/^\S/.test(l)) break;                       // 到下一个顶层键就停
    const m = /^  ([A-Za-z][\w-]*):\s*$/.exec(l);
    if (m) names.push(m[1]);
  }
  return names;
})();
const REFERENCED = [...actionYaml().matchAll(/\$\{\{\s*inputs\.([\w-]+)\s*\}\}/g)].map((m) => m[1]);
/* 两条正对照：解析器抽空了的话下面那条「都声明过」会因为无一可查而空绿。 */
check("action.yml 里抽得到 inputs 声明", DECLARED.length, 5);
check("action.yml 里抽得到 inputs 引用", REFERENCED.length, 5);
check("env 里引用的 input 都声明过",
  REFERENCED.filter((n) => !DECLARED.includes(n)).join("、"), "");
check("not-docs 声明了也引用了", DECLARED.includes("not-docs") && REFERENCED.includes("not-docs"), true);

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
  function act({ base: b, head: h, mergeBase = "", skipped = "", notDocs = "", cwd = dir }) {
    const outFile = path.join(OUT_DIR, "gh_output");
    fs.writeFileSync(outFile, "");
    let stdout = "", code = 0;
    try {
      stdout = execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", RUN_FILE], {
        cwd, encoding: "utf8",
        env: { ...process.env, GITHUB_ACTION_PATH: __dirname, GITHUB_OUTPUT: outFile,
               DOCS_ONLY_BASE: b, DOCS_ONLY_HEAD: h,
               DOCS_ONLY_MERGE_BASE: mergeBase, DOCS_ONLY_SKIPPED: skipped,
               DOCS_ONLY_NOT_DOCS: notDocs },
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

  /* not-docs 走环境变量、用数组追加：值里有换行、中文、空格和 `*`。
     每一种写坏的方式都对应一条会红的断言（做过变异验证，见下面每条的说明）：
     - 掉了 `if [ -n ... ]` 那一段 → 「动作层：not-docs 传得到」红
     - `"--not-docs=$X"` 掉了引号 → 值被词分割，第二行起的模式丢了，「第二行命中」红；
       `*` 还会被当路径展开
     - 环境变量名对不上 → 同样「传得到」红 */
  const ndAct = (over) => act({ cwd: ND.dir, ...over });
  check("动作层：not-docs 不传时矩阵按老规则是纯文档（正对照）", ndAct({ base: mFrom, head: mTo }).value, "true");
  const withNd = ndAct({ base: mFrom, head: mTo, notDocs: MATRIX });
  check("动作层：not-docs 传得到", withNd.value, "false");
  check("动作层：退出码是 0", withNd.code, 0);
  check("动作层：docs/ 下的矩阵也被拦（优先级）", ndAct({ base: dFrom, head: dTo, notDocs: MATRIX }).value, "false");
  /* 多行 + 中文 + 空格 + 通配符，一次全带上；命中的是最后一条，前面几条全没命中——
     任何一处被词分割 / 路径展开 / 吞掉换行，这条就变成 true */
  const multiNd = "**/矩阵.md" + NL + NL + "  src/*/nothing.md  " + NL + "**/my matrix.md" + NL + "**/规格.md" + NL;
  check("动作层：多行 not-docs 的最后一行命中", ndAct({ base: sFrom, head: sTo, notDocs: multiNd }).value, "false");
  const [spFrom, spTo] = ndCommit(["a/my matrix.md"]);
  check("动作层：模式里带空格的那一行命中", ndAct({ base: spFrom, head: spTo, notDocs: multiNd }).value, "false");
  check("动作层：多行没有一行命中就仍是纯文档",
    ndAct({ base: pFrom, head: pTo, notDocs: multiNd }).value, "true");
  /* 坏参数经过动作层同样落在「跑测试」并出声，而且这一步不红 */
  const badNd = ndAct({ base: pFrom, head: pTo, notDocs: "docs/**" });
  check("动作层：not-docs 写法不认识按跑测试处理", badNd.value, "false");
  check("动作层：not-docs 写法不认识要出声", /::warning::/.test(badNd.stdout), true);
  check("动作层：not-docs 写法不认识也不让这一步红", badNd.code, 0);
  /* 空串不该拼出 `--not-docs=`（虽然那样 node 也当没传）：走 `-n` 的那一支 */
  check("动作层：not-docs 为空等于没传", ndAct({ base: pFrom, head: pTo, notDocs: "" }).value, "true");
}

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(ND.dir, { recursive: true, force: true });
fs.rmSync(OUT_DIR, { recursive: true, force: true });

console.log(`纯文档判定：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
