/* 标签同步的回归：node .github/actions/labels-sync/labels.test.js
   （本仓 .github/workflows/test.yml 跑的就是它）

   起一个**真的 HTTP 服务**冒充 GitHub API，打真的请求。不 mock fetch——
   这个脚本的价值在「算对了要做什么、并且只做加和改」，mock 掉网络那一层
   就把要验的东西验没了。

   钉五类东西：

   1. **共享清单本身合法**，流程标签一个不缺，而且**基础清单里没有 qa-***
   2. **形状校验抓得到那几类错**：颜色带 #、描述超长、重名、首尾空格
   3. **永远不产删除**。这是整个脚本唯一严重的失效方式——删标签会把它从所有
      issue 上摘掉，不可逆（见 labels-sync.js 顶部那段官方原话）
   4. **写路径**：dy-run 一个写请求都不发；--apply 时 `sev/major` 的斜杠要 encode
   5. **接线形状**：清单和脚本都走 $GITHUB_ACTION_PATH，这条路上不许有 checkout */
const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  validateManifest, diffLabels, readManifest, readManifests, syncLabels,
  BASE_MANIFEST, DESC_MAX,
} = require("./labels-sync.js");

let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { pass++; } else { fail++; console.log("  ✗ " + msg); }
}

const REPO = "GinkgoLeafLab/does-not-matter";
const QA_MANIFEST = path.join(__dirname, "labels.qa.json");

/** 起一个假 API。handler 拿到 (req, body) 返回 [状态码, 响应体字符串]。 */
function fakeApi(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let buf = "";
    req.on("data", c => { buf += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body: buf, auth: req.headers.authorization });
      const [code, out] = handler(req, buf, seen);
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(out);
    });
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, seen, api: "http://127.0.0.1:" + server.address().port });
    });
  });
}

const L = (name, color, description) => ({ name, color, description });

async function main() {
  /* ---------- 1. 共享清单：形状合法，流程标签一个不缺 ---------- */
  {
    const base = readManifest(BASE_MANIFEST);
    check(validateManifest(base).length === 0, "基础清单本身必须合法");

    /* 流程标签**逐个字面量断言**。它们是跨系统契约：各仓 caller 的 `if` 里那个
       `review-passed`、issue 表单的 `labels:`、以及 CLAUDE.md 里写的那几个名字，
       都按名字引用它们。**套件里其余每条用的都是读进来的数据**，所以改了清单
       它们照样全绿——改这里不改那边的后果是：表单引用的标签不存在，
       GitHub 静默不打，issue 开出来一个标签都没有。 */
    const names = new Set(base.map(l => l.name));
    for (const n of ["bug", "enhancement", "chore",
                     "sev/blocker", "sev/major", "sev/minor", "sev/cosmetic",
                     "status/unclaimed", "status/in-progress", "status/not-a-bug",
                     "review-passed"]) {
      check(names.has(n), `基础清单里缺了流程标签 ${n}`);
    }

    const sev = base.filter(l => l.name.startsWith("sev/"));
    const status = base.filter(l => l.name.startsWith("status/"));
    check(sev.length === 4, `sev/ 恰好四档，实际 ${sev.length}`);
    check(status.length === 3, `status/ 恰好三个，实际 ${status.length}`);
    /* 没有 status/fixed 是刻意的：GitHub 的 completed 已经记了同一件事，
       再拿标签记一遍就是第二处真相。 */
    check(!names.has("status/fixed"), "不该有 status/fixed");

    /* **基础清单里不许有 qa-***。它们是能力差异不是措辞差异：
       建到一个没有 qa-gate 的仓里，等于给两个没有任何东西在读的标签一份正式定义。 */
    check(!names.has("qa-required") && !names.has("qa-passed"),
      "qa-* 不许进基础清单——它们只属于真的装了 qa-gate 的仓，见 labels.qa.json");
  }

  /* ---------- 1b. qa 清单和 qa-gate 的常量对得上 ---------- */
  /* 这一条以前**不可能写**：标签清单在各消费仓，判定脚本的常量在这儿，
     两边只能靠约定对齐。清单搬进来之后它们第一次住在同一个仓，于是
     「这两个名字」从两处真相变成一处——**这是这次共享清单顺带买到的东西**。
     改了 qa-gate.js 的常量而没改清单（或者反过来），这条当场红。 */
  {
    const qa = readManifest(QA_MANIFEST);
    const { REQUIRED_LABEL, PASSED_LABEL } = require("../qa-gate/qa-gate.js");
    const names = new Set(qa.map(l => l.name));
    check(qa.length === 2, `qa 清单恰好两条，实际 ${qa.length}`);
    check(names.has(REQUIRED_LABEL), `qa 清单里缺 ${REQUIRED_LABEL}（qa-gate.js 认的就是这个名字）`);
    check(names.has(PASSED_LABEL), `qa 清单里缺 ${PASSED_LABEL}（qa-gate.js 认的就是这个名字）`);
  }

  /* ---------- 2. 形状校验抓得到那几类错 ---------- */
  {
    const bad = [
      ["颜色带 #", [L("a", "#d73a4a", "")]],
      ["颜色 5 位", [L("a", "d73a4", "")]],
      ["颜色不是 hex", [L("a", "zzzzzz", "")]],
      ["name 是空串", [L("", "d73a4a", "")]],
      ["name 首尾有空格", [L(" a ", "d73a4a", "")]],
      ["重名", [L("a", "d73a4a", ""), L("a", "000000", "")]],
      ["只差大小写也算重名", [L("Bug", "d73a4a", ""), L("bug", "000000", "")]],
      ["description 不是字符串", [{ name: "a", color: "d73a4a" }]],
      ["不是数组", { name: "a" }],
      ["空数组", []],
    ];
    for (const [why, input] of bad) {
      check(validateManifest(input).length > 0, why + "：应该被校验拦下，实际放过了");
    }
    check(validateManifest([L("a", "D73A4A", "大写 hex 是合法的")]).length === 0,
      "大写 hex 应该合法");

    /* 描述长度按**码点**数。中文在 BMP 里 s.length 和码点数相等，所以中文测不出区别——
       要钉住 charLen 只能用 emoji（一个占 2 个 UTF-16 码元）。
       拿中文写这条断言的话，把 charLen 换成 s.length 它照样绿，等于没钉。 */
    const cn = "中".repeat(DESC_MAX);
    check(validateManifest([L("a", "d73a4a", cn)]).length === 0,
      DESC_MAX + " 个中文字应该刚好合法");
    check(validateManifest([L("a", "d73a4a", cn + "中")]).length === 1,
      "超一个字就该被拦下");
    check(validateManifest([L("a", "d73a4a", "🏷".repeat(DESC_MAX))]).length === 0,
      DESC_MAX + " 个 emoji 是 " + DESC_MAX + " 个码点、" + DESC_MAX * 2
      + " 个 UTF-16 码元——按码点数才合法。这条钉的就是 charLen 没被换成 s.length");
    check(validateManifest([L("a", "d73a4a", "🏷".repeat(DESC_MAX + 1))]).length === 1,
      "超一个 emoji 也该被拦下");
  }

  /* ---------- 3. diff：算得对，而且**永远不产删除** ---------- */
  {
    const live = [L("bug", "d73a4a", "旧描述"), L("多余的", "ffffff", "")];

    const same = diffLabels([L("bug", "d73a4a", "旧描述")], live);
    check(same.create.length === 0 && same.update.length === 0, "完全一致时不该有任何改动");
    check(same.extra.length === 1 && same.extra[0].name === "多余的",
      "GitHub 上多出来的应该进 extra");

    /* 这一条是整个套件的支点：**任何输入都不许产生删除**。
       变异验证：把 labels-sync.js 里 extra 那一段改成真的删，这条会红。 */
    for (const r of [same, diffLabels([], live), diffLabels([L("x", "000000", "")], live)]) {
      check(!("delete" in r) && !("prune" in r) && !("remove" in r),
        "diff 结果里绝不许出现删除——删标签会把它从所有 issue 上摘掉，不可逆");
    }

    const created = diffLabels([L("新的", "00ff00", "x")], live);
    check(created.create.length === 1 && created.create[0].name === "新的", "缺的应该进 create");

    check(diffLabels([L("bug", "d73a4a", "新描述")], live).update.length === 1, "描述变了要改");
    check(diffLabels([L("bug", "000000", "旧描述")], live).update.length === 1, "颜色变了要改");
    check(diffLabels([L("bug", "D73A4A", "旧描述")], live).update.length === 0,
      "颜色只是大小写不同不该算成一次改动——否则每跑一次都在「改」");

    const conf = diffLabels([L("Bug", "d73a4a", "旧描述")], live);
    check(conf.conflicts.length === 1, "只差大小写的应该进 conflicts");
    check(conf.create.length === 0 && conf.update.length === 0,
      "只差大小写时不许自作主张建或改");
  }

  /* ---------- 4. dry-run：一个写请求都不发 ---------- */
  {
    const { server, seen, api } = await fakeApi(() => [200, JSON.stringify([])]);
    const r = await syncLabels({
      api, repo: REPO, token: "t", apply: false,
      manifest: [L("新的", "00ff00", "x")],
    });
    server.close();
    check(r.plan.create.length === 1, "dry-run 也该算出要建什么");
    check(seen.every(s => s.method === "GET"),
      "dry-run 绝不许发写请求，实际发了：" + seen.map(s => s.method).join(","));
    check(r.applied.length === 0, "dry-run 不该做任何事");
  }

  /* ---------- 5. --apply：真的建、真的改，斜杠要 encode，**而且不删** ---------- */
  {
    /* live 里**必须**同时有「清单里没有的」和「只差大小写的」，否则 plan.extra 与
       plan.conflicts 都是空的，下面那条「不许发 DELETE」就跑在**没东西可删**的场景上，
       什么都证明不了。

       这个坑真的踩过：第一版这里只有 sev/major 一个（被 manifest 精确匹配 → extra 为空），
       于是把 syncLabels 改成「循环 plan.extra 发 DELETE」之后，整套断言**全绿**。
       第 3 节那三条 `!("delete" in r)` 也补不上——它们查的是 diffLabels 返回对象的键，
       而真正危险的改法加在发请求那一层，根本不经过那个返回值。 */
    const live = [
      L("sev/major", "000000", "旧"),          /* 精确匹配 → 要改 */
      L("清单里没有的", "ffffff", ""),          /* → extra，承诺是「只报告，不动」 */
      L("Review-Passed", "478e25", ""),        /* → conflicts（只差大小写），同样不动 */
    ];
    const { server, seen, api } = await fakeApi((req) => {
      if (req.method === "GET") return [200, JSON.stringify(live)];
      return [req.method === "POST" ? 201 : 200, "{}"];
    });
    const r = await syncLabels({
      api, repo: REPO, token: "t", apply: true,
      manifest: [
        L("sev/major", "d93f0b", "新"), L("新的", "00ff00", "x"),
        L("review-passed", "478e25", ""),
      ],
    });
    server.close();
    /* 这两条是上面那段话的守卫本身：extra / conflicts 一旦回到 0，
       「不许发 DELETE」就又变回一条空断言。 */
    check(r.plan.extra.length === 1,
      "这一节必须有 extra，否则「不许发 DELETE」跑在没东西可删的场景上，等于没断言");
    check(r.plan.conflicts.length === 1,
      "这一节必须有 conflicts，只差大小写的也在「不动它」的承诺里");
    check(r.errors.length === 0, "都成功时不该有错，实际：" + r.errors.join("；"));
    check(r.applied.length === 2,
      "只该建 1 个改 1 个——extra 和 conflicts 都不许动，实际做了 " + r.applied.length
      + " 件：" + r.applied.join("、"));
    check(r.applied.every(a => !a.startsWith("删")),
      "applied 里不许出现删除，实际：" + r.applied.join("、"));

    const post = seen.find(s => s.method === "POST");
    const patch = seen.find(s => s.method === "PATCH");
    check(post && JSON.parse(post.body).name === "新的", "建标签要 POST，body 里带 name");
    check(patch && patch.url.includes("sev%2Fmajor"),
      "改 sev/major 时斜杠必须 encode 成 %2F，否则打到的是另一个路径，实际：" + (patch && patch.url));
    check(patch && !("name" in JSON.parse(patch.body)),
      "PATCH 不许带 name/new_name——那是改名，改名会丢 issue 关联");
    check(seen.every(s => s.method !== "DELETE"), "任何时候都不许发 DELETE");
    check(seen.every(s => s.auth === "Bearer t"), "写请求要带 Authorization");
  }

  /* ---------- 6. 失败方向：显式失败，不静默 ---------- */
  {
    const { server, api } = await fakeApi(() => [500, "{}"]);
    let threw = false;
    try { await syncLabels({ api, repo: REPO, token: "t", apply: true, manifest: [L("a", "000000", "")] }); }
    catch (e) { threw = true; }
    server.close();
    check(threw, "列标签返回 500 时必须抛——拿不到现状就不知道该建什么，不许硬来");
  }
  {
    /* apply 但没 token：要抛，而且**在发出任何写请求之前**。
       悄悄退化成 dry-run 是最坯的一种失败：流水线全绿，标签一个没同步。 */
    const { server, seen, api } = await fakeApi(() => [200, JSON.stringify([])]);
    let threw = false;
    try { await syncLabels({ api, repo: REPO, token: "", apply: true, manifest: [L("a", "000000", "")] }); }
    catch (e) { threw = true; }
    server.close();
    check(threw, "要写却没 token 时必须抛，不许静默退化成 dry-run");
    check(seen.every(s => s.method === "GET"), "没 token 时不该发出写请求");
  }
  {
    const { server, api } = await fakeApi((req) =>
      req.method === "GET" ? [200, JSON.stringify([])] : [422, "{}"]);
    const r = await syncLabels({
      api, repo: REPO, token: "t", apply: true, manifest: [L("a", "000000", "")],
    });
    server.close();
    check(r.errors.length === 1, "写失败必须进 errors，不许吞掉");
    check(r.applied.length === 0, "失败的不该算进 applied");
  }

  /* ---------- 7. 翻页：超过 100 个也要拿全 ---------- */
  {
    const page1 = Array.from({ length: 100 }, (_, i) => L("l" + i, "000000", ""));
    const { server, api } = await fakeApi((req) =>
      [200, JSON.stringify(/page=1(&|$)/.test(req.url) ? page1 : [L("last", "000000", "")])]);
    const r = await syncLabels({ api, repo: REPO, apply: false, manifest: [L("last", "000000", "")] });
    server.close();
    check(r.plan.create.length === 0 && r.plan.extra.length === 100,
      "满一页时要接着翻——不翻的话第 101 个标签会被当成不存在、然后重复创建");
  }

  /* ---------- 8. 清单坏掉 → 抛，不是当成空清单 ---------- */
  {
    const tmp = path.join(__dirname, "labels.test-tmp.json");
    fs.writeFileSync(tmp, "{ 不是 JSON");
    let threw = false;
    try { readManifest(tmp); } catch (e) { threw = true; }
    fs.unlinkSync(tmp);
    check(threw, "清单不是合法 JSON 时必须抛——当成空清单会让「什么都不做」看起来像成功");
  }

  /* ---------- 9. readManifests：拼几份，而且拼完整体校验 ---------- */
  {
    const both = readManifests([BASE_MANIFEST, QA_MANIFEST]);
    const base = readManifest(BASE_MANIFEST);
    const qa = readManifest(QA_MANIFEST);
    check(both.length === base.length + qa.length,
      `拼起来应该是 ${base.length}+${qa.length}，实际 ${both.length}`);
    const names = new Set(both.map(l => l.name));
    check(names.has("bug") && names.has("qa-required"), "拼完两边的标签都要在");

    /* **跨文件重名要红。** 这是这个机制唯一会静默出错的地方：两份清单撞了同一个
       标签名，后来者悄悄覆盖前者、而两份都「各自合法」。靠的是「拼完再整体校验」，
       变异落点：把 readManifests 改成逐份 validateManifest，这条当场绿→红反过来。 */
    const tmp = path.join(__dirname, "labels.dup-tmp.json");
    fs.writeFileSync(tmp, JSON.stringify([L("bug", "000000", "撞名")]));
    let threw = false;
    try { readManifests([BASE_MANIFEST, tmp]); } catch (e) { threw = true; }
    fs.unlinkSync(tmp);
    check(threw, "两份清单撞了同一个标签名必须抛——否则后来者悄悄覆盖前者");

    for (const [why, arg] of [["一份都不给", []], ["给 undefined", undefined]]) {
      let t = false;
      try { readManifests(arg); } catch (e) { t = true; }
      check(t, `${why}时必须抛——调用方没点名要哪几份，不该替它猜一个默认`);
    }

    const notArr = path.join(__dirname, "labels.notarr-tmp.json");
    fs.writeFileSync(notArr, JSON.stringify({ name: "a" }));
    let t2 = false;
    try { readManifests([notArr]); } catch (e) { t2 = true; }
    fs.unlinkSync(notArr);
    check(t2, "清单不是数组时必须抛");
  }

  /* ---------- 10. 接线形状 ----------

     这一段守的不是同步逻辑，是**这套接线跑不跑得起来**。
     每条先摆一个正对照：一次「无命中」同时兼容「真的没问题」和「正则压根匹配不到
     任何东西」，没有正对照分不开这两种。

     **和 qa-gate.test.js 的 W3 / W8 是同一个形状**（内层 uses 必须钉不可变 tag、
     那个 tag 如果已经存在就必须真的含有这个动作）。**两处目前是各写各的**——
     再出现第三个的时候就该抽出去，两个还不到那个点。 */
  {
    const dir = path.join(__dirname, "..", "..");
    const wf = fs.readFileSync(path.join(dir, "workflows", "labels-sync.yml"), "utf8");
    const act = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");

    check(/^on:\n\s*workflow_call:/m.test(wf), "L1 读到的确实是那份可复用工作流（正对照）");
    check(/^\s*uses: /m.test(wf), "L2 正对照：这份工作流里确实有 `uses:` 这种写法");
    check(/uses: GinkgoLeafLab\/dev-infra\/\.github\/actions\/labels-sync@v\d+\.\d+\.\d+\s*$/m.test(wf),
      "L3 内层必须按**不可变 tag**引用同仓的组合动作——不能是 `./`、不能是 `@main`、" +
      "**也不能是 `@v1` 这种会动的名字**（v1.1.0 就是那么发坏的）");
    check(!/actions\/checkout@/.test(wf),
      "L4 这条路上不许有 checkout——清单和脚本都跟着动作下发，caller 没给 `contents`");

    check(/^\s*run: \|/m.test(act), "L5 正对照：组合动作里确实有 `run:`");
    check(/node "\$GITHUB_ACTION_PATH\/labels-sync\.js"/.test(act),
      "L6 组合动作跑的是跟着它一起下发的那份脚本（`$GITHUB_ACTION_PATH`）");
    check(/\$\{\{ github\.action_path \}\}\/labels\.json/.test(act),
      "L7 **清单也要走 action_path**——写成工作区相对路径会指到 caller 那个没 checkout 过的空目录");
    check(/^\s*using: composite\s*$/m.test(act), "L8 组合动作确实是 composite");

    /* L10：**`runs:` 之前不许出现 `${` + `{` 那种表达式**。

       这条不是洁癖，是 v1.3.0 真的这么坏过：`inputs.repository.description` 里写着
       「通常传 ${'{{'} github.repository }}」，**于是三个消费仓的 labels-sync 全红**，
       报的是 `Unrecognized named-value: 'github'` +「Failed to load … action.yml」。

       **坏点在于 runner 把清单里的 `description` 也当模板解析**，而那个位置
       **没有 `github` 上下文**——所以那不是「注释里的一句话」，是整份清单加载失败、
       一步都跑不到。合法的位置只有 `runs:`（以及 qa-gate 那份的 `outputs.*.value`）。

       **为什么之前没有任何东西看得见它**：L1~L8 全是形状断言、80 条断言里没有一条
       按 runner 的方式解析清单，而这条路在 tag 打上、真有仓调用之前跑不到。
       所以这条守卫补的是「清单自己合不合法」，不是「接线接没接对」。 */
    const head = act.slice(0, act.search(/^(outputs|runs):/m));
    const EXPR = "${" + "{";   /* 拆开写，免得这份文件自己被同一条规则扫出来 */
    check(head.length > 0 && /^inputs:/m.test(head),
      "L10 正对照：`runs:` 之前确实有内容（`inputs:` 那一段），这条不是扫了个空字符串");
    check(!head.includes(EXPR),
      "L10 `runs:` 之前出现了 " + EXPR + " ——清单里的 description 会被 runner 当模板解析，" +
      "那儿没有 github 上下文，整份清单会加载失败（v1.3.0 就是这么让三个仓一起红的）");

    /* L9：内层引用的那个 tag 如果**已经存在**，它必须真的含有这个动作。
       判据故意是「已经存在的」而不是「必须存在」：正常发布流程里这一行是前向引用。
       一个 tag 都没有时**红**，不是跳过——`actions/checkout` 默认
       `fetch-tags: false`，那样这条会把每一次都当成前向引用放过去（qa-gate 的 W8
       第一版就是这么瞎掉的，本仓 test.yml 因此钉着 `fetch-tags: true`）。 */
    const ref = (wf.match(/uses: GinkgoLeafLab\/dev-infra\/\.github\/actions\/labels-sync@(\S+)/) || [])[1];
    const git = (args) => require("child_process")
      .spawnSync("git", ["-C", path.join(dir, ".."), ...args], { encoding: "utf8" });
    const inRepo = git(["rev-parse", "--git-dir"]).status === 0;
    const anyTag = inRepo && (git(["tag", "-l"]).stdout || "").trim() !== "";
    const known = ref && inRepo && git(["rev-parse", "--verify", "--quiet", `refs/tags/${ref}`]).status === 0;
    if (!ref) {
      check(false, "L9 前提：读得出内层引用的那个 tag");
    } else if (!inRepo) {
      console.log(`  · L9 跳过：这儿不是 git 仓库（或没有 git），验不了 tag \`${ref}\` 的内容`);
    } else if (!anyTag) {
      check(false, "L9 前提：**本地取到了 tag**——一个都没有说明 checkout 没带 tag 下来" +
        "（`actions/checkout` 默认 `fetch-tags: false`）。修法是加 `fetch-tags: true`，不是把这条改绿");
    } else if (!known) {
      console.log(`  · L9 跳过：tag \`${ref}\` 还不存在（前向引用，发布时才打）`);
    } else {
      const tree = git(["ls-tree", "--name-only", ref, ".github/actions/labels-sync/"]).stdout || "";
      check(/action\.yml/.test(tree),
        `L9 内层引用的 tag \`${ref}\` 上真的有这个组合动作——形状合法不等于内容对得上`);
    }
  }

  console.log(`\n标签同步：${pass} 通过${fail ? `，${fail} 失败` : ""}`);
  process.exit(fail ? 1 : 0);
}

main();
