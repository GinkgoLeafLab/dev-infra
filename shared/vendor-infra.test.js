/* 共享基础设施文件校验的回归测试：node scripts/vendor-infra.test.js

   **这份文件是从 GinkgoLeafLab/dev-infra 同步进来的，不要手改。**
   改它去那边走 PR、打 tag，再回来 node scripts/vendor-infra.js --sync <tag>。

   **它在 dev-infra 自己那边跑不了，这是刻意的**：里面有一条断言要对**真的这个仓库**
   跑一次 check()（见下面那句注释），而 dev-infra 是这些文件的来处、不是消费者，
   它没有 vendor/infra/VERSION，那一条会当场抛。dev-infra 的 test.yml 因此只对这两份
   做 node --check 的语法检查，真套件在各消费仓里跑。
   **别为了让它在 dev-infra 也能跑而把那条断言改成「有清单才验」**——
   那样一个消费仓弄丢清单之后它会静默跳过，正是这整套东西要挡住的失效方式。

   这条守卫判错的后果是**几个仓跑着不同版本的分支守卫 / 纯文档判定，而没有任何东西会说**。
   所以下面每一条都是一次变异：把一样东西弄坏，断言它**真的红**。
   只测「不坏的时候是绿的」等于没测——那条任何写法都能通过。

   同步那一半对着**临时目录里的假上游仓**跑，不碰网络也不依赖 dev-infra 今天有哪些 tag：
   端到端只验「拉一个 tag 的 shared/ 会发生什么」，而那件事在假上游上一模一样。 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const M = require("./vendor-infra.js");

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) pass++;
  else { fail++; console.error(`  ✗ ${name}`); }
}
/* 断言「这一坨问题里有一条提到了 X」——比数条数稳，加一条无关的问题不会让它红 */
function has(bad, needle, name) {
  check(bad.some((b) => b.includes(needle)), `${name}（实际报了：${bad.join(" / ") || "什么都没报"}）`);
}

/* —— 造一个完整的落点目录 + 清单 —— */
const SRC = {
  "shared/a.js": "// 甲\n",
  "shared/b.js": "// 乙\n",
  "shared/hook": "#!/bin/sh\necho hi\n",
};
const DEST = {
  "shared/a.js": "scripts/a.js",
  "shared/b.js": "scripts/b.js",
  "shared/hook": ".githooks/hook",
};
const MODE = { "shared/hook": "100755" };

function makeConsumer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinfra-"));
  const files = {};
  for (const [from, dest] of Object.entries(DEST)) {
    const p = path.join(dir, dest);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, SRC[from]);
    const mode = MODE[from] || "100644";
    if (mode === "100755" && process.platform !== "win32") fs.chmodSync(p, 0o755);
    files[dest] = {
      from, bytes: Buffer.byteLength(SRC[from]), sha256: M.sha256(Buffer.from(SRC[from])), mode,
    };
  }
  const v = {
    repo: "GinkgoLeafLab/dev-infra", tag: "v9.9.9", commit: "deadbeef",
    source_files: Object.keys(SRC).sort(), files, skipped: {},
  };
  fs.mkdirSync(path.join(dir, "vendor", "infra"), { recursive: true });
  fs.writeFileSync(path.join(dir, "vendor", "infra", "VERSION"), JSON.stringify(v, null, 2) + "\n");
  return { dir, v };
}
const readV = (dir) => M.readManifest(path.join(dir, "vendor", "infra", "VERSION"));
const writeV = (dir, v) =>
  fs.writeFileSync(path.join(dir, "vendor", "infra", "VERSION"), JSON.stringify(v, null, 2) + "\n");

/* —— 先对**真的这个仓库**跑一次 ——
   下面所有变异都在临时目录的假落点上做，那是对的（不能去改真文件）。
   但**只有假目录的话，这个套件对本仓这六份一句话都没说**：
   真的手改一份、真的把钩子的 x 位去掉，`npm test` 会一声不吭地绿着。
   这一条就是把尺子架到真东西上的那一句，隔壁 scripts/vendor.test.js 里是同一条。 */
check(M.check().length === 0, "真的落点文件通过完整性校验");

/* —— 基线：不动任何东西就该是绿的 —— */
{
  const { dir } = makeConsumer();
  check(M.check(dir).length === 0, "基线：没动过的落点目录校验通过");
  fs.rmSync(dir, { recursive: true, force: true });
}

/* —— 变异 1：改一个字节 —— */
{
  const { dir } = makeConsumer();
  fs.writeFileSync(path.join(dir, "scripts/a.js"), "// 丙\n");   // 长度相同，只有内容变
  has(M.check(dir), "内容被改过", "变异：手改了一份副本的内容（字节数不变）");
  fs.rmSync(dir, { recursive: true, force: true });
}

/* —— 变异 2：删掉一份 —— */
{
  const { dir } = makeConsumer();
  fs.rmSync(path.join(dir, "scripts/b.js"));
  has(M.check(dir), "读不到", "变异：删掉一份副本");
  fs.rmSync(dir, { recursive: true, force: true });
}

/* —— 变异 3：**去掉 .githooks 那份的可执行位** ——
   这一条是整套里唯一 sha256 抓不到的：内容一字没改，但 git 会直接跳过这个钩子、
   而且**不报任何错**。没有这条断言，那一位丢了就是静默的。 */
if (process.platform !== "win32") {
  const { dir } = makeConsumer();
  fs.chmodSync(path.join(dir, ".githooks/hook"), 0o644);
  const bad = M.check(dir);
  has(bad, "可执行位", "变异：钩子的 x 位没了（sha256 抓不到这一条）");
  check(bad.length === 1, "去掉 x 位只该报这一条，不该连带报内容对不上");
  fs.rmSync(dir, { recursive: true, force: true });
}

/* —— 变异 4：上游有、本仓既没拿也没写明不拿 —— */
{
  const { dir } = makeConsumer();
  const v = readV(dir); v.source_files.push("shared/新来的.js"); writeV(dir, v);
  has(M.check(dir), "既没拿也没写明不拿", "变异：source_files 多一条，两边都没提");
  fs.rmSync(dir, { recursive: true, force: true });
}

/* —— 变异 5：skipped 没写理由 ——
   「刻意不拿」和「漂了」必须分得开。没理由的 skipped 等于一个让红变绿的开关。 */
{
  const { dir } = makeConsumer();
  const v = readV(dir);
  v.source_files.push("shared/c.js"); v.skipped["shared/c.js"] = "";
  writeV(dir, v);
  has(M.check(dir), "没写理由", "变异：skipped 里有一条空理由");

  v.skipped["shared/c.js"] = "这个仓没有 QA 门禁，不要这份";
  writeV(dir, v);
  check(M.check(dir).length === 0, "写了理由的 skipped 通过");
  fs.rmSync(dir, { recursive: true, force: true });
}

/* —— 变异 6：清单自己坏掉 —— */
{
  const { dir } = makeConsumer();
  fs.writeFileSync(path.join(dir, "vendor", "infra", "VERSION"), "{ 不是 JSON");
  let threw = false;
  try { M.check(dir); } catch (e) { threw = /不是合法 JSON/.test(e.message); }
  check(threw, "变异：清单不是合法 JSON 时抛，而不是当成「没什么要查」");

  writeV(dir, { files: {}, skipped: {} });                      // 少了 source_files
  has(M.check(dir), "source_files", "变异：清单少了 source_files");

  writeV(dir, { files: {}, source_files: [] });                 // 少了 skipped
  has(M.check(dir), "skipped 不是对象", "变异：清单少了 skipped");
  fs.rmSync(dir, { recursive: true, force: true });
}

/* —— 变异 7：同一份源文件被映射到两个落点 —— */
{
  const { dir } = makeConsumer();
  const v = readV(dir);
  v.files["scripts/a2.js"] = { ...v.files["scripts/a.js"] };
  writeV(dir, v);
  has(M.check(dir), "被映射到了两个落点", "变异：一份源文件映射到两个落点");
  fs.rmSync(dir, { recursive: true, force: true });
}

/* —— 变异 8：清单里映射了一份 source_files 里没有的 —— */
{
  const { dir } = makeConsumer();
  const v = readV(dir);
  v.source_files = v.source_files.filter((f) => f !== "shared/b.js");
  writeV(dir, v);
  has(M.check(dir), "source_files 里没有它", "变异：files 映射的来处不在 source_files 里");
  fs.rmSync(dir, { recursive: true, force: true });
}

/* —— 同步：对着临时目录里的假上游仓跑，不碰网络 —— */
function makeUpstream(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinfra-up-"));
  const run = (...a) => execFileSync("git", ["-c", "core.hooksPath=" +
    (process.platform === "win32" ? "NUL" : "/dev/null"), "-C", dir, ...a], { encoding: "utf8" });
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  run("config", "user.email", "t@t");
  run("config", "user.name", "t");
  fs.mkdirSync(path.join(dir, "shared"));
  for (const [p, body] of Object.entries({ ...SRC, ...(extra || {}) })) {
    fs.writeFileSync(path.join(dir, p), body);
  }
  run("add", "-A");
  run("commit", "-qm", "up");
  return dir;
}

/* 同步真的把内容搬过来了，而且把 x 位打上了 */
{
  const { dir } = makeConsumer();
  const up = makeUpstream();
  /* 先把落点弄坏，确认是同步把它修回来的，不是它本来就对 */
  fs.writeFileSync(path.join(dir, "scripts/a.js"), "坏了");
  if (process.platform !== "win32") fs.chmodSync(path.join(dir, ".githooks/hook"), 0o644);

  M.sync("HEAD", { dir, upstream: up });
  check(M.check(dir).length === 0, "同步之后校验通过");
  check(fs.readFileSync(path.join(dir, "scripts/a.js"), "utf8") === SRC["shared/a.js"],
    "同步把被改坏的那份还原了");
  if (process.platform !== "win32") {
    check(!!(fs.statSync(path.join(dir, ".githooks/hook")).mode & 0o111),
      "同步按清单把可执行位打上了（上游那份源文件是 100644，载不动这一位）");
  }
  const v = readV(dir);
  check(v.tag === "HEAD" && /^[0-9a-f]{40}$/.test(v.commit), "同步写下了 tag 与 commit");
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(up, { recursive: true, force: true });
}

/* 上游多一份 → 停下来让人决定，不静默拿也不静默漏 */
{
  const { dir } = makeConsumer();
  const up = makeUpstream({ "shared/新的.js": "// 新\n" });
  let msg = "";
  try { M.sync("HEAD", { dir, upstream: up }); } catch (e) { msg = e.message; }
  check(/既没拿也没写明不拿/.test(msg) && /shared\/新的\.js/.test(msg),
    "变异：上游多一份时同步报错停下，并点名是哪一份");
  check(readV(dir).tag === "v9.9.9", "报错时不该已经把清单写掉一半");
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(up, { recursive: true, force: true });
}

/* 上游少一份 → 同样停下来 */
{
  const { dir } = makeConsumer();
  const up = makeUpstream();
  fs.rmSync(path.join(up, "shared/b.js"));
  execFileSync("git", ["-C", up, "add", "-A"]);
  execFileSync("git", ["-C", up, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "rm"]);
  let msg = "";
  try { M.sync("HEAD", { dir, upstream: up }); } catch (e) { msg = e.message; }
  check(/已经没有了/.test(msg) && /shared\/b\.js/.test(msg),
    "变异：上游删了一份时同步报错停下");
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(up, { recursive: true, force: true });
}

/* 上游整个没有 shared/ → 不许当成「没什么要更新」 */
{
  const { dir } = makeConsumer();
  const up = fs.mkdtempSync(path.join(os.tmpdir(), "vinfra-empty-"));
  execFileSync("git", ["init", "-q", "-b", "main", up]);
  execFileSync("git", ["-C", up, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", up, "config", "user.name", "t"]);
  fs.writeFileSync(path.join(up, "README.md"), "x");
  execFileSync("git", ["-C", up, "add", "-A"]);
  execFileSync("git", ["-C", up, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "init"]);
  let msg = "";
  try { M.sync("HEAD", { dir, upstream: up }); } catch (e) { msg = e.message; }
  check(/没有 shared\//.test(msg), "变异：那个 tag 上根本没有 shared/ 时报错，不当成「没什么要更新」");
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(up, { recursive: true, force: true });
}

console.log(`共享基础设施文件：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
