/* 合并时自动打 tag 的测试：node .github/actions/tag-on-merge/tag-on-merge.test.js

   这份脚本判错一次的后果是**一个收不回来的版本号**（tag 不移动），或者更糟——
   把一个已有的 tag 挪走，让所有钉着它的 caller 悄悄换了内容。所以这里钉得最重的是：

   - **只建不改**：源码里没有 PATCH / DELETE / force，碰上 422 就红，不重试、不覆盖
   - **打在此刻 main 的 tip 上**，并且 tip 在建的那一刻往前走了会按新 tip 重算——
     这一条拿真 git 仓库、在假 API 的 POST 里真的往 origin 推一个新 commit 来测
   - **版本号按数值比**（v1.10.0 > v1.9.0），`v1` 这种老 tag 不参与
   - **判不了就不打**：标签矛盾、找不到 PR、最新 tag 不在 main 上，都必须是 error
     而且一次 POST 都没发

   端到端那一半会在临时目录里 git init 一个 bare 的 origin，再 clone 两份：
   一份当「别人往 main 合 PR」的那一边，一份当 runner 上 checkout 出来的工作区。 */
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const T = require("./tag-on-merge.js");
const SCRIPT = path.join(__dirname, "tag-on-merge.js");
const ROOT = path.join(__dirname, "..", "..", "..");

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = typeof want === "function" ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else { fail++; console.error(`  ✗ ${name}：期望 ${typeof want === "function" ? "（满足条件）" : JSON.stringify(want)}，实际 ${JSON.stringify(got)}`); }
}

/* —— 1. 版本号 —— */
check("v1.2.3 认", T.parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3 });
for (const bad of ["v1", "1.2.3", "v1.2", "v01.2.3", "v1.02.3", "v1.2.3-rc.1", "v1.2.3 ", "V1.2.3", ""]) {
  check(`${JSON.stringify(bad)} 不认`, T.parseVersion(bad), null);
}
check("按数值比不按字典序：v1.10.0 比 v1.9.0 大",
  T.latestTag([{ name: "v1.9.0", sha: "a" }, { name: "v1.10.0", sha: "b" }, { name: "v1.2.0", sha: "c" }]).name, "v1.10.0");
check("`v1`（挪 tag 时代的那个）不参与", T.latestTag([{ name: "v1", sha: "a" }, { name: "v0.9.0", sha: "b" }]).name, "v0.9.0");
check("没有合法 tag 时是 null", T.latestTag([{ name: "v1", sha: "a" }, { name: "latest", sha: "b" }]), null);
check("minor 把 patch 清零", T.formatVersion(T.bumpVersion(T.parseVersion("v1.18.3"), "minor")), "v1.19.0");
check("patch", T.formatVersion(T.bumpVersion(T.parseVersion("v1.18.0"), "patch")), "v1.18.1");
check("major 把后两位清零", T.formatVersion(T.bumpVersion(T.parseVersion("v1.18.3"), "major")), "v2.0.0");

/* —— 2. 标签 → 级别 —— */
const pr = (number, labels, extra = {}) => ({ number, title: `PR ${number}`, labels: labels.map(name => ({ name })), merged_at: "2026-09-30T00:00:00Z", base: { ref: "main" }, ...extra });
check("默认就是 minor（这个仓库十八个手打的 tag 全是 minor）", T.DEFAULT_LEVEL, "minor");
check("没挂 release/* → 默认", T.classifyPr(pr(1, ["bug", "enhancement"])).level, "minor");
check("release/major", T.classifyPr(pr(1, ["release/major"])).level, "major");
check("release/patch", T.classifyPr(pr(1, ["release/patch", "bug"])).level, "patch");
check("release/skip", T.classifyPr(pr(1, ["release/skip"])).level, "skip");
check("大小写不同也认（GitHub 的标签名本来就不区分大小写）", T.classifyPr(pr(1, ["Release/Major"])).level, "major");
check("标签是字符串也认", T.classifyPr({ number: 1, labels: ["release/patch"] }).level, "patch");
check("两个 release/* → 矛盾，报错", !!T.classifyPr(pr(7, ["release/major", "release/patch"])).error, true);
check("skip + major 也是矛盾", !!T.classifyPr(pr(7, ["release/skip", "release/major"])).error, true);
check("前缀相似的不算（release/majorish）", T.classifyPr(pr(1, ["release/majorish"])).level, "minor");

check("取最高：patch + minor → minor", T.aggregate([pr(1, ["release/patch"]), pr(2, [])]).level, "minor");
check("取最高：major 压过一切", T.aggregate([pr(1, ["release/patch"]), pr(2, ["release/major"]), pr(3, [])]).level, "major");
check("skip 不算级别：skip + patch → patch", T.aggregate([pr(1, ["release/skip"]), pr(2, ["release/patch"])]).level, "patch");
check("全是 skip → null（不打）", T.aggregate([pr(1, ["release/skip"]), pr(2, ["release/skip"])]).level, null);
check("有一个矛盾就带着 error", T.aggregate([pr(1, []), pr(2, ["release/major", "release/skip"])]).errors.length, 1);

/* —— 3. 端到端：真 git + 假 API —— */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tag-on-merge-"));
/* 不让本机的全局钩子（比如这个仓库自己的分支守卫）插手临时仓库里的提交。 */
const gitIn = (cwd, ...a) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...a],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let caseNo = 0;
function makeRepo() {
  const dir = path.join(TMP, "case" + (++caseNo));
  fs.mkdirSync(dir);
  const origin = path.join(dir, "origin.git");
  gitIn(dir, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  const dev = path.join(dir, "dev");
  gitIn(dir, "clone", "--quiet", origin, dev);
  gitIn(dev, "checkout", "--quiet", "-B", "main");
  let n = 0;
  const repo = {
    dir, origin, dev,
    /* 在「别人」那一边合一个 commit 进 main 并推上去；prs 是 API 对这个 commit 的回答 */
    merge(prs, file = "f.txt") {
      fs.mkdirSync(path.dirname(path.join(dev, file)), { recursive: true });
      fs.writeFileSync(path.join(dev, file), String(++n));
      gitIn(dev, "add", "-A");
      gitIn(dev, "commit", "--quiet", "-m", "c" + n);
      gitIn(dev, "push", "--quiet", "origin", "HEAD:refs/heads/main");
      const sha = gitIn(dev, "rev-parse", "HEAD");
      repo.pulls[sha] = prs;
      return sha;
    },
    tag(name, sha, annotated = false) {
      if (annotated) gitIn(dev, "tag", "-a", "-m", name, name, sha);
      else gitIn(dev, "tag", name, sha);
      gitIn(dev, "push", "--quiet", "origin", "refs/tags/" + name);
    },
    /* runner 上 checkout 出来的那一份：在建 origin 之后、在后续 merge 之前 clone，
       所以它的本地历史是旧的——脚本必须自己 fetch 才看得到新 tip */
    checkout() {
      const w = path.join(dir, "runner");
      gitIn(dir, "clone", "--quiet", origin, w);
      return w;
    },
    pulls: {},
    calls: [],
    /* POST /git/refs 的回答；默认成功，并像 GitHub 一样真的在 origin 上建出那个 tag */
    onCreate: null,
  };
  repo.fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    repo.calls.push({ method, url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers || {} });
    const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    let m;
    if (method === "GET" && (m = /\/repos\/o\/r\/commits\/([0-9a-f]{40})\/pulls/.exec(url))) {
      return json(200, repo.pulls[m[1]] || []);
    }
    if (method === "POST" && /\/repos\/o\/r\/git\/refs$/.test(url)) {
      const body = JSON.parse(init.body);
      const r = repo.onCreate ? await repo.onCreate(body, repo) : null;
      if (r) return json(r.status, { message: r.message || "nope" });
      gitIn(dev, "push", "--quiet", "origin", `${body.sha}:${body.ref}`);
      return json(201, { ref: body.ref, object: { sha: body.sha } });
    }
    return json(404, { message: "fake API 不认识 " + method + " " + url });
  };
  return repo;
}

const opts = (repo, cwd, extra = {}) => ({ cwd, api: "https://api.example", repo: "o/r", token: "tkn", fetchImpl: repo.fetchImpl, sleep: async () => { repo.slept = (repo.slept || 0) + 1; }, ...extra });
const posts = repo => repo.calls.filter(c => c.method === "POST");
const writes = repo => repo.calls.filter(c => c.method !== "GET");

async function e2e() {
  /* E1：最普通的一次——一个没挂标签的 PR 合进来，打下一个 minor，打在 tip 上 */
  {
    const r = makeRepo();
    const c0 = r.merge([pr(1, [])]);
    r.tag("v1.0.0", c0);
    const w = r.checkout();
    const c1 = r.merge([pr(2, [])]);
    const res = await T.run(opts(r, w));
    check("E1 结论是打", res.kind, "tag");
    check("E1 打的是下一个 minor", res.next, "v1.1.0");
    check("E1 真的建了", res.created, true);
    check("E1 恰好一次 POST，建的是 refs/tags/v1.1.0 → 此刻的 tip（runner 的工作区还停在旧 commit，脚本自己 fetch 了）",
      posts(r).map(c => c.body), [{ ref: "refs/tags/v1.1.0", sha: c1 }]);
    check("E1 带着 token", posts(r)[0].headers.Authorization, "Bearer tkn");
    check("E1 origin 上真的有了", gitIn(r.dev, "ls-remote", "--tags", "origin", "v1.1.0").split("\t")[0], c1);

    /* E1b：紧接着再跑一次（排在后面的那次运行）——tip 已经有 tag，什么都不做 */
    r.calls.length = 0;
    const again = await T.run(opts(r, w));
    check("E1b tip 已有 tag → nothing", again.kind, "nothing");
    check("E1b 一个 API 调用都没有", r.calls.length, 0);
  }

  /* E2：一段区间里好几个 PR，取最高；skip 不算级别；rebase 进来的同一个 PR 只算一次 */
  {
    const r = makeRepo();
    const c0 = r.merge([pr(1, [])]);
    r.tag("v1.9.0", c0);
    r.tag("v1.10.0", c0);   // 同一个 commit 上两个 tag：按数值取 v1.10.0
    r.tag("v1", c0);
    const w = r.checkout();
    r.merge([pr(2, ["release/patch"])]);
    r.merge([pr(3, ["release/skip"])]);
    r.merge([pr(4, ["release/patch"])]);
    const tip = r.merge([pr(4, ["release/patch"])]);   // PR 4 rebase 进来两个 commit
    const res = await T.run(opts(r, w));
    check("E2 patch + skip + patch → patch，从 v1.10.0 往上加", res.next, "v1.10.1");
    check("E2 打在 tip 上", posts(r).map(c => c.body.sha), [tip]);
    check("E2 同一个 PR 只列一次", res.rows.map(x => x.number), [2, 3, 4]);
    check("E2 查了 4 个 commit（--first-parent 那一串）", r.calls.filter(c => c.method === "GET").length, 4);
  }

  /* E3：major 压过一切；annotated tag 也剥得到它指的 commit */
  {
    const r = makeRepo();
    const c0 = r.merge([pr(1, [])]);
    r.tag("v1.18.0", c0, true);
    const w = r.checkout();
    r.merge([pr(2, ["release/patch"])]);
    r.merge([pr(3, ["Release/Major"])]);
    const res = await T.run(opts(r, w));
    check("E3 major → v2.0.0", res.next, "v2.0.0");
    check("E3 annotated 的上一个 tag 也认得出它在 main 上", res.kind, "tag");
  }

  /* E4：全是 skip → 不打，也不红 */
  {
    const r = makeRepo();
    r.tag("v1.0.0", r.merge([pr(1, [])]));
    const w = r.checkout();
    r.merge([pr(2, ["release/skip"])]);
    const res = await T.run(opts(r, w));
    check("E4 全是 skip → skip", res.kind, "skip");
    check("E4 一次写都没有", writes(r).length, 0);
  }

  /* E5：标签矛盾 → error，一次 POST 都不发 */
  {
    const r = makeRepo();
    r.tag("v1.0.0", r.merge([pr(1, [])]));
    const w = r.checkout();
    r.merge([pr(2, ["release/major", "release/patch"])]);
    r.merge([pr(3, [])]);
    const res = await T.run(opts(r, w));
    check("E5 矛盾 → error", res.kind, "error");
    check("E5 错误里点名了那个 PR", res.errors.join(" "), s => /#2/.test(s));
    check("E5 一次写都没有", writes(r).length, 0);
  }

  /* E6：main 上有个 commit 找不到合进来的 PR（直推；或者只有一个还开着的 PR、
     或者 PR 合进的是别的分支）→ 等过几次仍然没有，error，不打 */
  {
    const r = makeRepo();
    r.tag("v1.0.0", r.merge([pr(1, [])]));
    const w = r.checkout();
    r.merge([pr(2, [])]);
    r.merge([pr(3, [], { merged_at: null }), pr(4, [], { base: { ref: "other" } })]);
    const res = await T.run(opts(r, w));
    check("E6 找不到 PR → error", res.kind, "error");
    check("E6 错误里说了是哪个 commit", res.errors.join(" "), s => /找不到/.test(s));
    check("E6 等了几次再放弃（刚合进来那几秒可能还查不到）", r.slept, 2);
    check("E6 一次写都没有", writes(r).length, 0);
  }

  /* E7：最新的 tag 不在 main 的历史上（在一个分叉出去的分支上）→ error */
  {
    const r = makeRepo();
    const c0 = r.merge([pr(1, [])]);
    r.tag("v1.0.0", c0);
    gitIn(r.dev, "checkout", "--quiet", "-b", "side");
    fs.writeFileSync(path.join(r.dev, "side.txt"), "x");
    gitIn(r.dev, "add", "-A"); gitIn(r.dev, "commit", "--quiet", "-m", "side");
    r.tag("v1.1.0", gitIn(r.dev, "rev-parse", "HEAD"));
    gitIn(r.dev, "checkout", "--quiet", "main");
    const w = r.checkout();
    r.merge([pr(2, [])]);
    const res = await T.run(opts(r, w));
    check("E7 最新 tag 不在 main 上 → error", res.kind, "error");
    check("E7 一次写都没有", writes(r).length, 0);
  }

  /* E8：tip 被一个版本号更高的 tag 包含（tag 打在 main 前面的某个 commit 上）→ 没什么可打 */
  {
    const r = makeRepo();
    const c0 = r.merge([pr(1, [])]);
    r.tag("v1.0.0", c0);
    const w = r.checkout();
    const c1 = r.merge([pr(2, [])]);
    gitIn(r.dev, "checkout", "--quiet", "-b", "ahead");
    fs.writeFileSync(path.join(r.dev, "ahead.txt"), "x");
    gitIn(r.dev, "add", "-A"); gitIn(r.dev, "commit", "--quiet", "-m", "ahead");
    r.tag("v1.1.0", gitIn(r.dev, "rev-parse", "HEAD"));
    gitIn(r.dev, "checkout", "--quiet", "main");
    const res = await T.run(opts(r, w));
    check("E8 tip 已包含在更高的 tag 里 → nothing", res.kind, "nothing");
    check("E8 说的是 main 的 tip", res.tip, c1);
  }

  /* E9：一个 vX.Y.Z 都没有 → error（第一版请人手打） */
  {
    const r = makeRepo();
    r.tag("v1", r.merge([pr(1, [])]));
    const w = r.checkout();
    r.merge([pr(2, [])]);
    const res = await T.run(opts(r, w));
    check("E9 没有合法 tag → error", res.kind, "error");
    check("E9 一次写都没有", writes(r).length, 0);
  }

  /* E10：POST 回 422（这一刻别人刚建了同名 tag），tip 没动 → error，**只 POST 一次**，
     不重试、不覆盖、不移动 */
  {
    const r = makeRepo();
    r.tag("v1.0.0", r.merge([pr(1, [])]));
    const w = r.checkout();
    r.merge([pr(2, [])]);
    r.onCreate = async () => ({ status: 422, message: "Reference already exists" });
    const res = await T.run(opts(r, w));
    check("E10 422 → error", res.kind, "error");
    check("E10 错误里带着服务端的原话", res.errors.join(" "), s => /Reference already exists/.test(s));
    check("E10 只 POST 了一次", posts(r).length, 1);
    check("E10 除了 POST 没有任何写（没有 PATCH / DELETE）", writes(r).map(c => c.method), ["POST"]);
  }

  /* E11：建的那一刻 tip 往前走了（又有人合了一个 PR，而且它改了 workflow，
     于是 GITHUB_TOKEN 给旧 tip 建 tag 被 403 拒掉）→ 按新 tip 重算：
     新 PR 的级别也要算进来，tag 打在新 tip 上 */
  {
    const r = makeRepo();
    r.tag("v1.0.0", r.merge([pr(1, [])]));
    const w = r.checkout();
    const c1 = r.merge([pr(2, [])]);
    let c2 = null;
    r.onCreate = async (body, repo) => {
      if (c2) return null;
      c2 = repo.merge([pr(3, ["release/major"])], ".github/workflows/x.yml");
      return { status: 403, message: "refusing to allow a GitHub App to create or update workflow" };
    };
    const res = await T.run(opts(r, w, { log: () => {} }));
    check("E11 第二轮成功", res.kind === "tag" && res.created, true);
    check("E11 两次 POST：先旧 tip、再新 tip，第二次把新 PR 的 major 算进来了",
      posts(r).map(c => c.body), [{ ref: "refs/tags/v1.1.0", sha: c1 }, { ref: "refs/tags/v2.0.0", sha: c2 }]);
    check("E11 旧的那个 v1.1.0 没有被建出来", gitIn(r.dev, "ls-remote", "--tags", "origin", "v1.1.0"), "");
  }

  /* E12：tip 每一轮都在动 → 最多 MAX_ROUNDS 轮，然后出声地失败 */
  {
    const r = makeRepo();
    r.tag("v1.0.0", r.merge([pr(1, [])]));
    const w = r.checkout();
    r.merge([pr(2, [])]);
    let k = 10;
    r.onCreate = async (body, repo) => { repo.merge([pr(++k, [])]); return { status: 403, message: "refusing to allow a GitHub App to create or update workflow" }; };
    const res = await T.run(opts(r, w, { log: () => {} }));
    check("E12 最后是 error", res.kind, "error");
    check("E12 恰好 MAX_ROUNDS 次 POST", posts(r).length, T.MAX_ROUNDS);
    check("E12 原话带 workflow 的 403 → 提示说的是 tip 一直在动，不是权限", res.errors.join(" "), s => /都在往前走/.test(s) && !/ruleset/.test(s));
  }

  /* E14：PR 是按 merge commit 合进来的——主干上那一串只有 merge commit 本身，
     PR 分支里原来那几个 commit 不该各自去查一遍（--first-parent） */
  {
    const r = makeRepo();
    r.tag("v1.0.0", r.merge([pr(1, [])]));
    const w = r.checkout();
    gitIn(r.dev, "checkout", "--quiet", "-b", "feature");
    for (const f of ["a.txt", "b.txt"]) {
      fs.writeFileSync(path.join(r.dev, f), f);
      gitIn(r.dev, "add", "-A"); gitIn(r.dev, "commit", "--quiet", "-m", f);
    }
    gitIn(r.dev, "checkout", "--quiet", "main");
    gitIn(r.dev, "-c", "user.name=t", "merge", "--quiet", "--no-ff", "-m", "Merge PR 2", "feature");
    gitIn(r.dev, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    const m = gitIn(r.dev, "rev-parse", "HEAD");
    r.pulls[m] = [pr(2, ["release/patch"])];
    const res = await T.run(opts(r, w));
    check("E14 merge commit 合进来的 PR 照样打", res.next, "v1.0.1");
    check("E14 只查了主干上那一个 commit", r.calls.filter(c => c.method === "GET").map(c => /\/commits\/([0-9a-f]{40})\//.exec(c.url)[1]), [m]);
  }

  /* E15：tip 没动、403 也不带 workflow 字样 → 那是权限或 ruleset，提示要指到人去点的那一层 */
  {
    const r = makeRepo();
    r.tag("v1.0.0", r.merge([pr(1, [])]));
    const w = r.checkout();
    r.merge([pr(2, [])]);
    r.onCreate = async () => ({ status: 403, message: "Resource not accessible by integration" });
    const res = await T.run(opts(r, w, { log: () => {} }));
    check("E15 403 → error", res.kind, "error");
    check("E15 只 POST 一次（tip 没动就不重算）", posts(r).length, 1);
    check("E15 提示指向权限 / ruleset（那一层是人点的）", res.errors.join(" "), s => /ruleset/.test(s));
  }

  /* E13：dry-run 只算不建；没有 token 也能跑，而且不带 Authorization */
  {
    const r = makeRepo();
    r.tag("v1.0.0", r.merge([pr(1, [])]));
    const w = r.checkout();
    r.merge([pr(2, ["release/patch"])]);
    const res = await T.run(opts(r, w, { dryRun: true, token: undefined }));
    check("E13 dry-run 结论照算", res.next, "v1.0.1");
    check("E13 dry-run 没建", res.created, false);
    check("E13 dry-run 一次写都没有", writes(r).length, 0);
    check("E13 没 token 就不带 Authorization（带 \"Bearer undefined\" 只会 401）",
      r.calls.every(c => !("Authorization" in c.headers)), true);
    let threw = false;
    try { await T.run(opts(r, w, { token: undefined })); } catch { threw = true; }
    check("E13 要真的建却没 token → 当场抛", threw, true);
  }
}

/* —— 4. 命令行：认不出的参数直接失败 —— */
{
  /* `--dry_run` 被静默忽略的话，它会真的去建一个收不回来的 tag */
  const r = spawnSync(process.execPath, [SCRIPT, "--dry_run"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  check("C1 认不出的参数 → 非零退出", r.status !== 0, true);
  check("C1 并且说出来了", r.stdout + r.stderr, s => /认不出的参数/.test(s));
}

/* —— 5. 源码：只建不改 ——
   tag 不移动是「各仓钉 tag」成立的前提。POST /git/refs 碰上已存在的 ref 返回 422、
   不会覆盖；能挪 tag 的只有 PATCH /git/refs/tags/… 和 git push --force。
   这两样在这份脚本里一个字都不许出现。 */
{
  const src = fs.readFileSync(SCRIPT, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("S1 正对照：确实是 POST /git/refs", /method: "POST"/.test(src) && /\/git\/refs/.test(src), true);
  check("S2 没有 PATCH / DELETE", /["'](PATCH|DELETE)["']/.test(src), false);
  check("S3 没有 force（git push -f / --force / force: true）", /--force|\bforce\s*:|["']-f["']/.test(src), false);
  check("S4 正对照：下面那条的判据认得出这份脚本调 git 的写法", /\bgit\(\s*"fetch"/.test(src), true);
  check("S4 不 git push、不 git tag（建 tag 只走 API 那一条路）", /\bgit\(\s*["'](push|tag)["']/.test(src), false);
}

/* —— 6. 接线 ——
   三份文件三个角色：可复用工作流（checkout 调用方、调组合动作）、组合动作（跑这份脚本）、
   caller 模板（各仓那一份，形状由 adopt.js 的 lintCaller('tag-on-merge') 体检，那边的
   变异在 adopt.test.js）。这里只钉**这三份之间对不对得上**——每一处对不上都不报错，
   只是那条路安静地不跑，或者跑了建不出来。 */
{
  const strip = (t) => t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const wfRaw = fs.readFileSync(path.join(ROOT, ".github/workflows/tag-on-merge.yml"), "utf8");
  const wf = strip(wfRaw);
  const actRaw = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");
  const act = strip(actRaw);
  const tpl = strip(fs.readFileSync(path.join(ROOT, "adopt/templates/tag-on-merge.yml"), "utf8"));

  /* 可复用工作流 */
  check("W1 可复用工作流是 workflow_call，没有自己的触发器", /^on:\n  workflow_call:/m.test(wf) && !/^\s*(push|pull_request\w*|workflow_dispatch):/m.test(wf), true);
  check("W2 它自己不要权限、不设并发组（权限取自 calling job；同名并发组会和 caller 死锁）",
    /^\s*(permissions|concurrency):/m.test(wf), false);
  check("W3 checkout 的是调用方仓库，而且 fetch-depth: 0（要从上一个 tag 数到 tip）",
    /uses: actions\/checkout@v\d+\n\s+with:\n\s+fetch-depth: 0\n/.test(wf) && !/repository:/.test(wf), true);
  const refs = [...wf.matchAll(/uses:\s*(\S*tag-on-merge\S*)/g)].map((m) => m[1]);
  check("W4 正对照：工作流里引用了组合动作 tag-on-merge", refs.length, 1);
  /* 和 qa-gate.test.js 的 W3 同一个理由：`$/` 解析到这份文件自己所在的仓库、同一个 commit。
     写成 `./` 会对着工作区解析——而工作区里此刻是**调用方仓库**，那里没有这个动作。 */
  check("W5 引用必须精确是 `$/.github/actions/tag-on-merge`（不许带 @ref、不许写成 ./）", refs[0], "$/.github/actions/tag-on-merge");
  check("W6 `$/` 指的那个路径在这个仓库里真的有 action.yml",
    fs.existsSync(path.join(ROOT, ".github/actions/tag-on-merge/action.yml")), true);
  check("W7 token 与 dry-run 都往下传了", /token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/.test(wf) && /dry-run: \$\{\{ inputs\.dry-run \}\}/.test(wf), true);
  check("W8 工作流声明了 dry-run 这个 input（布尔、默认 false）",
    /^      dry-run:\n(        .*\n)*?        type: boolean\n        default: false/m.test(wf), true);

  /* 组合动作 */
  check("W9 组合动作确实是 composite", /^\s*using: composite\s*$/m.test(act), true);
  check("W10 跑的是跟着动作一起下发的这份脚本（$GITHUB_ACTION_PATH），不是调用方工作区里的",
    /node "\$GITHUB_ACTION_PATH\/tag-on-merge\.js" "\$\{args\[@\]\}"/.test(act), true);
  check("W11 token 走 input 进 env（组合动作读不到 secrets 上下文）",
    /GITHUB_TOKEN: \$\{\{ inputs\.token \}\}/.test(act) && !/secrets\./.test(act), true);
  const runBlock = (/^      run: \|\n((?:        .*\n?)+)/m.exec(act) || [])[1] || "";
  check("W12 正对照：切得出 run 那一段", /tag-on-merge\.js/.test(runBlock), true);
  check("W13 dry-run 走 env 拼参数，run 的文本里不许插表达式",
    /DRY_RUN: \$\{\{ inputs\.dry-run \}\}/.test(act) && !/\$\{\{/.test(runBlock), true);
  /* labels.test.js 的 L10 讲的是同一件事：这几个字段里 runner 没有 github 上下文，
     写了表达式会让**所有调用方**一起红。这里 runs: 之前一个表达式都不需要，所以整段禁。 */
  check("W14 runs: 之前（name / description / inputs）不许有 ${{ }} 表达式",
    /\$\{\{/.test(actRaw.slice(0, actRaw.indexOf("\nruns:"))), false);

  /* caller 模板：和脚本对得上的那两半 */
  check("W15 caller 模板只在脚本认的那个分支上触发（同一处真相的两半）",
    (/^  push:\n    branches: \[([^\]]*)\]/m.exec(tpl) || [])[1], T.BRANCH);
  check("W16 caller 模板调的是这份可复用工作流", /uses: GinkgoLeafLab\/dev-infra\/\.github\/workflows\/tag-on-merge\.yml@__INFRA_TAG__/.test(tpl), true);

  /* 这份测试自己要在 test.yml 里有一步，否则上面这些一条都没人跑 */
  const testYml = fs.readFileSync(path.join(ROOT, ".github/workflows/test.yml"), "utf8");
  check("W17 test.yml 跑这份测试", /run: node \.github\/actions\/tag-on-merge\/tag-on-merge\.test\.js/.test(testYml), true);
}

e2e().then(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n合并时自动打 tag：${pass} 通过${fail ? `，${fail} 失败` : ""}`);
  process.exit(fail ? 1 : 0);
}, e => {
  console.error(e);
  process.exit(1);
});
