#!/usr/bin/env node
/* 共享基础设施文件的完整性校验与同步。

     node scripts/vendor-infra.js --check          # 纯本地 sha256 + 模式比对，零凭据
     node scripts/vendor-infra.js --sync <tag>     # 从 dev-infra 拉那个 tag 的 shared/

   **这份文件是从 GinkgoLeafLab/dev-infra 同步进来的，不要手改**——包括它自己：
   它在清单里有自己的一行，--check 拿 sha256 把自己也对一遍。
   改它去那边走 PR、打 tag，再回来 node scripts/vendor-infra.js --sync <tag>。
   第一次接进一个新仓时手里还没有这份文件，那一次要人工放进来（连同清单），
   之后它就自己管自己了。

   **「自己校验自己」的边界，说准了别把它当成比实际更强。** 这份文件是**唯一的检查者**，
   所以绕过它**只需动这一个文件、清单一个字节都不用碰**：把 checkFiles 掏空
   （开头写一句 return bad）就行，--check 照样打印「OK（N 份）」并且 exit=0——
   而这时失效的**不是它自己那一行，是全部 N 份一起**。实测过。

   这条防不住，也加不出防御来：同一份实现自己验自己，这是固有性质，不是缺陷。
   所以判据只有一条，而且它不依赖读者认出某种 diff 形状：
   **任何碰 scripts/vendor-infra.js 的 diff，都当成「在拆守卫」来审。**

   这一层真正挡得住的是**无意的漂移**——手改了一份副本、丢了可执行位、
   忘了某个仓还没跟上。那类才是它存在的理由。

   **这一层的文件不躺在 vendor/ 下，别照着「vendor 一个目录」那种形状去想它。**
   同步进来的东西**必须躺在它们各自该在的位置**才会被读到——
   scripts/guard-branch.js 由 .claude/settings.json 的 PreToolUse hook 调，
   .githooks/pre-commit 由 git 调，两者都不认 vendor/ 下的副本。
   所以清单记的是**落点路径**，vendor/infra/ 下只有清单本身，没有文件。

   ## 清单为什么记这四样

   - **落点**（files 的键）：逐份记，不是「统一放某个目录」的规则。
     pre-commit 落 .githooks/ 而别的落 scripts/，写成一条规则迟早写错，
     而写错的表现是 git 不执行那个钩子、**且不报错**
   - **来处**（from）：dev-infra 的 shared/ 下哪一份
   - **sha256**：内容有没有被手改
   - **模式**（mode）：**sha256 永远比不到可执行位**，而 .githooks/pre-commit
     少了那一位 git 直接跳过、不报任何错。上游那份源文件也载不动它
     （GitHub Contents API 一律写 100644，而 fs.writeFileSync 新建的文件本来就不带），
     所以那一位只能由清单载着、--sync 显式打上、--check 对着查

   ## source_files 是干什么的

   记着**同步那一刻上游有哪些文件**。--check 是离线的，拿不到 dev-infra 今天有什么，
   所以「上游多了一份而本仓既没拿也没有显式不拿」这件事，只能靠这份快照在本地判出来。
   判据：source_files 里每一条，必须**恰好**出现在 files[*].from 或 skipped 之一。

   **skipped 的理由是必填的。** 机制必须分得开「刻意不拿」和「漂了」——
   分不开的话，它会把两者混成一类，然后被人一起忽略。
   没有理由的 skipped 等于一个「让红变绿」的开关，所以判失败。

   ## 失败方向

   一律**拒绝**：--check 非零退出，--sync 抛。这一层护的是「几个仓跑的是同一份守卫」，
   判错的方向如果是放行，那就是「以为对齐了，其实没有」。 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = path.join(ROOT, "vendor", "infra", "VERSION");
const REPO_URL = "https://github.com/GinkgoLeafLab/dev-infra.git";
const SOURCE_DIR = "shared";

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function readManifest(file = MANIFEST) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) { throw new Error("读不到 " + file + "：" + e.message); }
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(file + " 不是合法 JSON：" + e.message); }
}

/* 清单本身的形状。和「文件对不对」分开，是因为清单坏掉时逐文件比对的结果没有意义。
   返回问题清单，空数组 = 通过。**不抛**，让调用方决定怎么报。 */
function checkShape(v) {
  const bad = [];
  if (!v.files || typeof v.files !== "object" || Array.isArray(v.files)) {
    return ["清单里没有 files 对象"];
  }
  if (!Array.isArray(v.source_files)) {
    return ["清单里没有 source_files 数组——少了它，「上游多了一份」在本地判不出来"];
  }
  const skipped = v.skipped && typeof v.skipped === "object" && !Array.isArray(v.skipped)
    ? v.skipped : null;
  if (!skipped) return ["清单里 skipped 不是对象（没有要跳过的就写成 {}）"];

  /* 每条 skipped 都要有理由。空理由 = 一个让红变绿的开关。 */
  for (const [src, why] of Object.entries(skipped)) {
    if (typeof why !== "string" || why.trim() === "") {
      bad.push(`skipped["${src}"] 没写理由——「刻意不拿」和「漂了」必须分得开`);
    }
  }

  /* source_files 的每一条，恰好落在「拿了」或「刻意不拿」之一。 */
  const taken = new Map();                       // from -> 落点
  for (const [dest, meta] of Object.entries(v.files)) {
    const from = meta && meta.from;
    if (typeof from !== "string" || from === "") {
      bad.push(`files["${dest}"] 没写 from（它来自 ${SOURCE_DIR}/ 下哪一份）`);
      continue;
    }
    if (taken.has(from)) {
      bad.push(`${from} 被映射到了两个落点：${taken.get(from)} 与 ${dest}`);
    }
    taken.set(from, dest);
  }
  for (const src of v.source_files) {
    const inTaken = taken.has(src);
    const inSkipped = Object.prototype.hasOwnProperty.call(skipped, src);
    if (inTaken && inSkipped) {
      bad.push(`${src} 既写了落点又写在 skipped 里——只能占一个`);
    } else if (!inTaken && !inSkipped) {
      bad.push(`${src} 在上游有，本仓既没拿也没写明不拿。` +
        `要么给它一个落点，要么写进 skipped 并说明理由`);
    }
  }
  for (const from of taken.keys()) {
    if (!v.source_files.includes(from)) {
      bad.push(`files 里映射了 ${from}，但 source_files 里没有它——` +
        `清单自己对不上，多半是手改过`);
    }
  }
  for (const src of Object.keys(skipped)) {
    if (!v.source_files.includes(src)) {
      bad.push(`skipped 里写着 ${src}，但 source_files 里没有它——上游已经没有这份了？`);
    }
  }
  return bad;
}

/* 落点上那些文件对不对。dir 可传，是为了让测试能对着临时目录做变异。 */
function checkFiles(v, dir = ROOT) {
  const bad = [];
  for (const [dest, meta] of Object.entries(v.files)) {
    const p = path.join(dir, dest);
    let buf;
    try { buf = fs.readFileSync(p); }
    catch (e) { bad.push(`${dest}：读不到（${e.message}）`); continue; }

    if (buf.length !== meta.bytes) {
      bad.push(`${dest}：字节数对不上（清单记 ${meta.bytes}，实际 ${buf.length}）`);
      continue;                                  // 内容都不一样了，再比 sha 是噪音
    }
    const got = sha256(buf);
    if (got !== meta.sha256) {
      bad.push(`${dest}：内容被改过（sha256 记 ${meta.sha256.slice(0, 12)}…，` +
        `实际 ${got.slice(0, 12)}…）`);
      continue;
    }
    /* 模式：只认「要不要可执行位」这一位。别去比完整的 0o644/0o755——
       umask 和文件系统会让它天差地别，而我们真正在乎的只有 x。
       Windows 上 git 不看 x 位，fs.statSync 给出来的也不可信，所以那里不判。 */
    if (meta.mode === "100755" && process.platform !== "win32") {
      let mode;
      try { mode = fs.statSync(p).mode; }
      catch (e) { bad.push(`${dest}：取不到文件模式（${e.message}）`); continue; }
      if (!(mode & 0o111)) {
        bad.push(`${dest}：清单要求可执行（100755），实际没有可执行位。` +
          `**git 会直接跳过这个钩子，而且不报任何错**——` +
          `跑一次 npm install（它会调 scripts/setup-hooks.js 补上），或者 chmod +x`);
      }
    }
  }
  return bad;
}

function check(dir = ROOT, file) {
  const v = readManifest(file || path.join(dir, "vendor", "infra", "VERSION"));
  const shape = checkShape(v);
  if (shape.length) return shape;                // 清单坏了，逐文件比对没意义
  return checkFiles(v, dir);
}

/* 直接读 blob，不过 checkout 的 smudge 过滤器：那样它就和本机的 core.autocrlf 之类无关，
   换台机器同步出来的字节完全一样。 */
function readBlob(repoDir, relPath, rev = "HEAD") {
  return execFileSync("git", ["-C", repoDir, "cat-file", "blob", rev + ":" + relPath],
    { maxBuffer: 64 * 1024 * 1024 });
}

/* **-z 不是可选的。** git 默认把非 ASCII 路径输出成 "shared/\346\226\260.js"
   这种带引号的八进制转义形式，于是同一个文件在清单里和在这儿长得不一样，
   「上游多了一份」会被误判成真的多了一份、而且报出来的名字人也认不出。
   这条和 .github/actions/docs-only/docs-only.js 里 changedFiles 用 -z 是同一个理由，
   那边的注释写着「路径里有一个中文字符就够了」。 */
function listSource(repoDir, rev = "HEAD") {
  const out = execFileSync("git",
    ["-C", repoDir, "ls-tree", "-r", "--name-only", "-z", rev, SOURCE_DIR + "/"],
    { encoding: "utf8" });
  return out.split("\0").filter(Boolean).sort();
}

/* 从 tag 同步。upstream 可传一个本地仓库路径，测试用——
   生产路径永远是 clone 那个公开仓。 */
function sync(tag, opts = {}) {
  if (!tag) throw new Error("--sync 要给一个 tag，例如：--sync v1.5.0");
  const dir = opts.dir || ROOT;
  const manifestFile = path.join(dir, "vendor", "infra", "VERSION");
  const v = readManifest(manifestFile);

  const tmp = opts.upstream
    ? null
    : fs.mkdtempSync(path.join(require("os").tmpdir(), "vendor-infra-"));
  const repoDir = opts.upstream || tmp;
  const rev = opts.upstream ? tag : "HEAD";
  try {
    if (tmp) {
      console.log("拉 " + tag + " …");
      /* 关掉 detached HEAD 那段建议：clone 一个 tag 必然是分离头指针，那几行是噪音，
         而噪音会盖住真正的错误（stderr 是留给它们的）。 */
      execFileSync("git", ["-c", "advice.detachedHead=false",
        "clone", "--depth", "1", "--branch", tag, REPO_URL, tmp],
        { stdio: ["ignore", "ignore", "inherit"] });
    }
    const commit = execFileSync("git", ["-C", repoDir, "rev-parse", rev + "^{commit}"],
      { encoding: "utf8" }).trim();

    const upstream = listSource(repoDir, rev);
    if (!upstream.length) {
      throw new Error(`${tag} 上没有 ${SOURCE_DIR}/ ——这个 tag 带不了要同步的东西。` +
        `别把它当成「没什么要更新」，那正是 dev-infra v1.1.0 栽过的形状`);
    }

    /* 上游多出来的、或者少掉的，都**停下来让人决定**，不静默处理。 */
    const known = new Set([
      ...Object.values(v.files).map((m) => m.from),
      ...Object.keys(v.skipped || {}),
    ]);
    const added = upstream.filter((f) => !known.has(f));
    if (added.length) {
      throw new Error(
        `上游多了这几份，本仓既没拿也没写明不拿：\n  ` + added.join("\n  ") +
        `\n\n给它一个落点（files）或者写进 skipped 并说明理由，再跑一次。` +
        `\n**不要默默跳过**——那样这个仓会悄悄落在别人后面。`);
    }
    const gone = [...known].filter((f) => !upstream.includes(f));
    if (gone.length) {
      throw new Error(
        `清单里提到的这几份，${tag} 上已经没有了：\n  ` + gone.join("\n  ") +
        `\n\n上游删了文件就要在这儿同步删掉对应的条目（和落点上的文件），这一步要人来判。`);
    }

    for (const [dest, meta] of Object.entries(v.files)) {
      const buf = readBlob(repoDir, meta.from, rev);
      const p = path.join(dir, dest);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buf);
      /* 模式是清单说了算，不是上游那份源文件说了算——它载不动这一位。 */
      if (meta.mode === "100755" && process.platform !== "win32") fs.chmodSync(p, 0o755);
      meta.bytes = buf.length;
      meta.sha256 = sha256(buf);
      console.log(`  ${dest} ← ${meta.from}：${buf.length} 字节` +
        (meta.mode === "100755" ? "（可执行）" : ""));
    }

    v.repo = "GinkgoLeafLab/dev-infra";
    v.tag = tag;
    v.commit = commit;
    v.source_files = upstream;
    fs.writeFileSync(manifestFile, JSON.stringify(v, null, 2) + "\n");
    console.log("清单已更新：" + tag + " / " + commit.slice(0, 7));
    console.log("\n**接下来跑 npm test**——同步进来的是几个仓共用的守卫，" +
      "它们自己的测试也跟着同步过来了。");
    return v;
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === "--sync") {
    sync(args[1]);
  } else if (args[0] === "--check" || args.length === 0) {
    let bad;
    try { bad = check(); }
    catch (e) { console.error("共享基础设施文件校验失败：\n  ✗ " + e.message); process.exit(1); }
    if (bad.length) {
      console.error("共享基础设施文件校验失败：");
      for (const b of bad) console.error("  ✗ " + b);
      console.error("\n**这几份文件不在这个仓库里改**——它们是 GinkgoLeafLab/dev-infra\n" +
        "的 " + SOURCE_DIR + "/ 同步过来的，几个仓共用同一份。\n" +
        "要改去那边开 PR、打 tag，再回来：node scripts/vendor-infra.js --sync <tag>");
      process.exit(1);
    }
    const v = readManifest();
    console.log(`共享基础设施文件 OK（${v.tag} / ${String(v.commit).slice(0, 7)}，` +
      `${Object.keys(v.files).length} 份）`);
  } else {
    console.error("用法：--check | --sync <tag>");
    process.exit(2);
  }
}

module.exports = { check, checkShape, checkFiles, sync, readManifest, readBlob, listSource, sha256, MANIFEST };
