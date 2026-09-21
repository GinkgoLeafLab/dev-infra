#!/usr/bin/env node
/* PR 写锁判定的回归测试：node .github/actions/review-gate-lock/lock.test.js
   （本仓 .github/workflows/test.yml 跑的就是它）

   它判错一次的后果不是「测试红了」，而是**静默**：

   - 判成「没作废」→ 该报的作废没报，PR 上的 `review` 照常绿着，作者以为结论还算数。
     **这正是 GTO-Trainer#182 走了 9 轮的那个事故原样复发**，而且没有任何症状。
   - 判成「作废」判多了 → 每次推送都变红，很快就没人看了。

   所以这里钉的最重要的一条是**比对的方向**：判「作废」要拿锁的 base 去比
   **被推掉的那一版（before）**，不是比推送之后的 head。写成后者的话，
   推送之后 head 已经变了、锁的 base 是旧的，**两者永远不等**，
   于是每一次推送都判「没作废」——这把锁会安静地什么都不做。 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CLI = path.join(__dirname, "lock.js");
const {
  decide, findLock, parseFields, statusBody, checkDesc,
  LOCK_LABEL, OK, VOIDED, STALE, DESC_MAX,
} = require("./lock.js");

const A = "1111111111111111111111111111111111111111"; // 评审开始时的 head
const B = "2222222222222222222222222222222222222222"; // 作者推上来的新 commit
const C = "3333333333333333333333333333333333333333"; // 另一个无关的 SHA
const NOW = 1800000000;
const FUTURE = NOW + 600;   // 还没到期
const PAST = NOW - 600;     // 已到期

/* 打锁方写的那条评论。格式是**跨系统的契约**（人/agent 在 GitHub 上按它写），
   所以下面逐字面量钉着，不靠导出常量拼——拼出来的话改了格式测试照样绿。 */
const comment = (base, holder = "alice", exp = FUTURE) => ({
  body: `开始评审。\n\n<!-- review-lock base=${base} holder=${holder} exp=${exp} -->\n`,
});
const comments = (base, holder = "alice", exp = FUTURE) => [comment(base, holder, exp)];

/* 判定的默认入参：一次 synchronize 推送，A → B，而锁的 base 就是 A。
   这就是事故现场的形状。 */
const D = (o = {}) => decide({
  hasLock: true,
  lock: findLock(comments(A)),
  pushedHead: B,
  previousHead: A,
  now: NOW,
  ...o,
});

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`  ✗ ${name}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`); }
}
function ok(name, cond) { check(name, !!cond, true); }

/* —— 标签名是跨系统的契约，必须钉字面量 ——
   这个名字同时活在：清单 labels.json 里那条、人在 GitHub 上打的那一下、
   动作 inputs 那行 `contains(...)`、以及各仓评审角色的说明里。
   **套件里其余每条用的都是导入进来的常量**，所以改了常量它们照样全绿——
   改这里不改那边的后果是：GitHub 上打的还是 `review/in-flight`，
   脚本认的已经是别的字符串，于是永远判「没有锁」，整把锁形同虚设而且没有症状。 */
check("锁标签名（人在 GitHub 上打的那个）", LOCK_LABEL, "review/in-flight");
ok("锁标签名带 `review/` 前缀（和 status/ 一族一样看得出是状态不是分类）",
  LOCK_LABEL.startsWith("review/"));

/* —— 这一条是这个套件存在的理由：比对的方向 ——
   锁的 base = A（评审在审的那一版），作者推了 B。

   正对照先摆上：**锁的 base 确实不是推送后的 head**。没有这一条的话，
   下面那两条断言在「A 和 B 恰好相等」的夹具里也会绿，测不出方向。 */
ok("正对照：夹具里锁的 base 与推送后的 head 确实不同（不然测不出方向）", A !== B);

const voided = D();
check("推送让在飞的评审过期 → 判作废", voided.conclusion, VOIDED);
/* **这一条钉的就是那个最容易写反的地方。** 如果实现写成
   `lock.base === pushedHead`（拿锁比推送后的 head），这里会是 OK——*/
check("作废这一格必须是 failure 那一侧的结论，不是 ok", voided.conclusion === OK, false);

/* 反向对照：锁的 base 就是推送后的 head（评审正在审这一版，这次推送没让 head 前进
   ——例如打标签、reopened）→ **不许**判作废。少了这条，一个「永远判作废」的实现
   也能通过上面那一格。 */
const inFlight = D({ lock: findLock(comments(B)) });
check("锁的就是当前版本、这次推送没推进 head → 不判作废", inFlight.conclusion, OK);

/* 反向对照之二：锁在飞，但它锁的是**另一个** SHA（既不是被推掉的、也不是现在的）
   ——那是另一轮评审留下的锁 → 不是这次推送造成的，不判作废。 */
const stale = D({ lock: findLock(comments(C)) });
check("锁的是无关的第三个 SHA → 不判作废", stale.conclusion === VOIDED, false);
check("但它也不是完全正常，要单独成一档", stale.conclusion, STALE);

/* —— TTL：评审崩了会永久持锁 ——
   这次事故现场反复发生（评审 subagent 被 interrupt、failed before it finished）。
   不回放锁动作的话锁就永远挂着。 */
const expired = D({ lock: findLock(comments(A, "alice", PAST)) });
check("锁已超时 → 不判作废（放行）", expired.conclusion, OK);
check("超时要让 workflow 知道该自动释放", expired.releaseExpired, true);
check("没过期的锁不该被标成自动释放", D().releaseExpired, false);
/* 边界：恰好到期的瞬间就算过期（>= 而不是 >）。差一秒的语义写反了，
   会让锁多挂一会儿——那一会儿正好够作者推一个 commit。 */
const exactly = D({ lock: findLock(comments(A, "alice", NOW)) });
check("恰好到期就算过期（边界取 >=）", exactly.releaseExpired, true);
const oneSecondLeft = D({ lock: findLock(comments(A, "alice", NOW + 1)) });
check("还剩一秒就还不算过期（边界另一侧）", oneSecondLeft.releaseExpired, false);
check("只剩一秒时仍然是在飞的锁", oneSecondLeft.conclusion, VOIDED);

/* —— 没有锁 / 锁读不出来：一律照常 ——
   失败方向是**少一层保护，不是误拦 PR**。锁挂了不能让所有 PR 合不了。 */
const noLock = D({ hasLock: false });
check("没有锁 → 照常", noLock.conclusion, OK);
check("没有锁时不谈自动释放", noLock.releaseExpired, false);
check("挂着标签但读不到元数据 → 当作没有锁", D({ lock: null }).conclusion, OK);
ok("那一条的描述要说出来，别让它看不出来",
  /读不到锁元数据/.test(D({ lock: null }).desc));

/* —— findLock 的解析 —— */
check("解析出 base", findLock(comments(A)).base, A);
check("解析出 holder", findLock(comments(A, "bob")).holder, "bob");
check("解析出到期时间", findLock(comments(A, "bob", FUTURE)).exp, FUTURE);
/* **取最后一条**：同一个 PR 上锁可以取了放、放了又取，旧评论一直留着。 */
check("有多条锁评论时取最后一条（放锁又重新取锁）",
  findLock([comment(A), comment(B)]).base, B);
/* 没有锁评论时是 null，不是抛——调用方靠它落到「没有锁」那一支。 */
check("没有锁评论 → null", findLock([{ body: "随便一句" }]), null);
check("评论列表为空 → null", findLock([]), null);
check("不是数组 → null（不抛，别让一条坏数据把 job 弄红）", findLock("nope"), null);
/* base 不像 SHA 时整条作废。不校验的话，打锁方手滑写错一个字符，
   拿它比 head 就永远不等，锁永远判「过期」——静默失效的一种。 */
check("base 不像 SHA → 当作没有锁", findLock([{ body: "<!-- review-lock base=abc -->" }]), null);
check("base 被截短 → 当作没有锁",
  findLock([{ body: `<!-- review-lock base=${A.slice(0, 7)} -->` }]), null);
/* 缺 exp：不判过期（exp 为 null），而不是当成「已过期」放行。
   放行一个有 TTL 漏洞的锁比多报一次作废危险。 */
const noExp = findLock([{ body: `<!-- review-lock base=${A} holder=x -->` }]);
check("缺 exp 时 exp 是 null（而不是 0=立刻过期）", noExp.exp, null);
check("缺 exp 的锁仍然算在飞", D({ lock: noExp }).conclusion, VOIDED);
/* 缺 holder 时给个占位，别让描述里出现 "undefined"。 */
check("缺 holder 时给占位", findLock([{ body: `<!-- review-lock base=${A} -->` }]).holder, "(未署名)");
/* 带引号的值要去掉引号（holder 可能有空格）。 */
check("带引号的 holder 去掉引号",
  parseFields('base=x holder="Alice Smith" exp=1').holder, "Alice Smith");

/* —— 夹具的边界 —— */
/* 新分支第一次推送时 before 是全 0（或者缺失），那种情况下不该判作废。 */
check("before 是空串时不判作废", D({ previousHead: "" }).conclusion, OK);
check("before 是全 0 时也不判作废", D({ previousHead: "0".repeat(40) }).conclusion, OK);

/* —— commit status 那一半 —— */
const body = statusBody(
  { hasLock: true, lock: findLock(comments(A)), pushedHead: B, previousHead: A, now: NOW }, "");
/* **context 必须仍然是 `review`**：`review` 是主干的必需检查，而「结论作废」
   就是 `review` 这个检查自己的结论。写成别的名字会凭空多出一条不必需的检查，
   没人看，也就白做了。 */
check("context 是 review（和 review-gate 通过时写的是同一个）", body.status.context, "review");
check("作废时写的是 failure", body.status.state, "failure");
check("作废时如实报告 conclusion", body.conclusion, VOIDED);
/* —— 这一条是这个套件存在的**第二个**理由（第一个是上面比对的方向）——
   OK 时必须**什么都不写**，不是写一条 success。

   这条钉的就是 GTO-Trainer#186 / #189 / #191 那个洞：以前这里写的是
   `okBody.status.state === "success"`——**这条断言本身就是那个 bug 的编码**，
   它「验证」的正是「没有评审在飞时也写一条绿的检查」这件事，而 `review`
   唯一的保证是「缺席即拦」。一个从没派过评审的 PR，只要推过一次 commit，
   `review` 就是绿的，而且没有任何症状。 */
const okBody = statusBody(
  { hasLock: false, lock: null, pushedHead: B, previousHead: A, now: NOW }, "");
check("没有锁（OK）时 status 必须是 null——新 SHA 上什么都不写，让 `review` 保持缺席",
  okBody.status, null);
check("没有锁时如实报告 conclusion 为 ok", okBody.conclusion, OK);
check("没有锁时也不摘锁标签", okBody.releaseExpired, false);
/* 同一条钉法在「锁超时释放」这个 OK 分支上再验一遍——它也不该写任何东西，
   只是要报 releaseExpired=true 让调用方留痕（见 lock.js 里 TTL 那段）。 */
const expiredBody = statusBody(
  { hasLock: true, lock: findLock(comments(A, "alice", PAST)), pushedHead: B, previousHead: A, now: NOW }, "");
check("锁超时释放也是 OK，status 必须是 null", expiredBody.status, null);
check("锁超时释放要报告 releaseExpired=true", expiredBody.releaseExpired, true);
/* stale 也落 failure：那是刻意的保守方向（见 lock.js 里 STATE 的注释）。 */
check("stale 落 failure（保守方向）", statusBody(
  { hasLock: true, lock: findLock(comments(C)), pushedHead: B, previousHead: A, now: NOW }, ""
).status.state, "failure");

/* 描述字段 GitHub 限 140 字符，超了整个请求会被拒——那会让一条本该写上的
   作废警报根本没写上去。守卫自己也要被验。 */
check("描述为空要抛", (() => { try { checkDesc(""); return "no"; } catch { return "threw"; } })(), "threw");
check("描述超长要抛", (() => {
  try { checkDesc("中".repeat(DESC_MAX + 1)); return "no"; } catch { return "threw"; }
})(), "threw");
check("恰好 140 字符不抛", checkDesc("中".repeat(DESC_MAX)).length, DESC_MAX);
/* 上面两条只验得动 checkDesc **自己**。**产出请求体的那条路走不走它，是另一件事**——
   这里验的是 statusBody 真的接了线。 */
ok("statusBody 真的接了长度守卫", (() => {
  try {
    statusBody({ hasLock: true, lock: { base: A, holder: "名".repeat(140), exp: FUTURE },
                 pushedHead: B, previousHead: A, now: NOW }, "");
    return false;
  } catch { return true; }
})());

/* target_url 传了才带，没传就不带——空字符串会被 GitHub 拒。
   **必须用 VOIDED/STALE 夹具**：OK 现在 status 是 null，没有字段可看——
   用 OK 夹具测这条会拿 `null.target_url` 直接抛，测不出这条规则本身。 */
ok("没传 target_url 时不带这个字段", !("target_url" in body.status));
ok("传了 target_url 就带上",
  statusBody({ hasLock: true, lock: findLock(comments(A)), pushedHead: B, previousHead: A, now: NOW },
    "https://example.invalid/x").status.target_url === "https://example.invalid/x");

/* —— CLI：真的起一个进程跑 —— */
function runCLI(env) {
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "review-lock-")), "out");
  fs.writeFileSync(outFile, "");
  /* 环境变量要真的删掉，不能靠不传——父进程里可能有同名的。 */
  const e = { LOCK_HEAD: undefined, LOCK_BEFORE: undefined, LOCK_PRESENT: undefined,
              LOCK_COMMENTS: undefined, LOCK_NOW: undefined, ...env };
  const clean = { ...process.env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete clean[k]; else clean[k] = e[k];
  try {
    const stdout = execFileSync(process.execPath, [CLI], {
      env: { ...clean, GITHUB_OUTPUT: outFile },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, output: fs.readFileSync(outFile, "utf8") };
  } catch (err) {
    return { code: err.status === undefined ? -1 : err.status, stdout: err.stdout || "",
             output: fs.readFileSync(outFile, "utf8") };
  }
}

/* 事故现场那一次推送，端到端跑一遍。 */
const cli = runCLI({
  LOCK_HEAD: B, LOCK_BEFORE: A, LOCK_PRESENT: "true",
  LOCK_COMMENTS: JSON.stringify(comments(A)), LOCK_NOW: String(NOW),
});
check("CLI 正常退出", cli.code, 0);
check("CLI 吐出的是 failure 的 review 检查", JSON.parse(cli.stdout).state, "failure");
check("CLI 用的 context 是 review", JSON.parse(cli.stdout).context, "review");
check("CLI 把 conclusion 写进 GITHUB_OUTPUT", /conclusion=voided/.test(cli.output), true);
check("CLI 把 release_expired 写进 GITHUB_OUTPUT", /release_expired=false/.test(cli.output), true);

/* 没有锁的那一次推送。**这就是 GTO-Trainer#186/#189/#191 那次事故的真实输入**
   （`LOCK_PRESENT: "false"`）——曾经这里 CLI 吐出的是 `{"state":"success",...}`，
   一个从没派过评审的 PR 因此拿到一条绿的 `review`。现在必须是空 stdout：
   `body_path` 指向的文件没有内容可写，action.yml 据此把 has_body 判成 false，
   工作流那一步就不会再去调 `gh api`。 */
const cliNoLock = runCLI({
  LOCK_HEAD: B, LOCK_BEFORE: A, LOCK_PRESENT: "false",
  LOCK_COMMENTS: "[]", LOCK_NOW: String(NOW),
});
check("没有锁时 CLI 正常退出（0，不是失败——这不是错误，是『没有评审在飞』）", cliNoLock.code, 0);
check("没有锁（事故现场的真实输入）时 CLI 不吐任何检查体：stdout 必须是空串",
  cliNoLock.stdout, "");
check("没有锁时仍如实把 conclusion=ok 写进 GITHUB_OUTPUT（给 action.yml 之外的消费方用）",
  /conclusion=ok/.test(cliNoLock.output), true);

/* **`hasLock=false` 时即使评论里躺着一条锁评论也不认。**
   判定信的是事件快照里的标签（`LOCK_PRESENT`），不是评论——
   标签被摘掉之后旧评论还在，认它就会在一个已经放锁的 PR 上永远报作废。 */
const cliLabelGone = runCLI({
  LOCK_HEAD: B, LOCK_BEFORE: A, LOCK_PRESENT: "false",
  LOCK_COMMENTS: JSON.stringify(comments(A)), LOCK_NOW: String(NOW),
});
check("标签摘了之后旧评论不算数，CLI 不吐检查体", cliLabelGone.stdout, "");

/* 超时释放那一次：也是 OK，也不该吐检查体，但仍要报 release_expired=true
   让工作流那边留痕（那一步不依赖 has_body，摘标签+留评论走的是另一条件）。 */
const cliExpired = runCLI({
  LOCK_HEAD: B, LOCK_BEFORE: A, LOCK_PRESENT: "true",
  LOCK_COMMENTS: JSON.stringify(comments(A, "alice", PAST)), LOCK_NOW: String(NOW),
});
check("超时那一次 CLI 也不吐检查体（它是 OK，不是 VOIDED/STALE）", cliExpired.stdout, "");
check("超时那一次要报告 release_expired", /release_expired=true/.test(cliExpired.output), true);

/* 失败方向：全都要非零退出，而且**不许吐出检查体**——
   吐了的话 `gh api --input` 会拿着半截 JSON 去创建检查，那才是最糟的一种。 */
const BAD = [
  ["缺 head",              { LOCK_HEAD: undefined, LOCK_BEFORE: A, LOCK_PRESENT: "true" }],
  ["head 不像 SHA",        { LOCK_HEAD: "main", LOCK_BEFORE: A, LOCK_PRESENT: "true" }],
  ["head 被截短",          { LOCK_HEAD: B.slice(0, 7), LOCK_BEFORE: A, LOCK_PRESENT: "true" }],
  ["缺 LOCK_PRESENT",      { LOCK_HEAD: B, LOCK_BEFORE: A, LOCK_PRESENT: undefined }],
  ["LOCK_PRESENT 不是布尔", { LOCK_HEAD: B, LOCK_BEFORE: A, LOCK_PRESENT: "yes" }],
  ["评论不是 JSON",        { LOCK_HEAD: B, LOCK_BEFORE: A, LOCK_PRESENT: "true", LOCK_COMMENTS: "{" }],
  ["评论不是数组",         { LOCK_HEAD: B, LOCK_BEFORE: A, LOCK_PRESENT: "true", LOCK_COMMENTS: '{"a":1}' }],
  ["now 不是数字",         { LOCK_HEAD: B, LOCK_BEFORE: A, LOCK_PRESENT: "true", LOCK_NOW: "later" }],
];
for (const [name, env] of BAD) {
  const r = runCLI(env);
  ok(`${name} → 非零退出（失败方向是拦住）`, r.code !== 0);
  check(`${name} → 不吐检查体`, r.stdout.trim(), "");
}
/* before 缺失**不是**错误：新分支的第一次推送就是这样，判定当「不判作废」处理。
   这一条是反向对照——上面那张表里全是「必须抛」，这里钉住一个「必须不抛」。 */
const noBefore = runCLI({ LOCK_HEAD: B, LOCK_BEFORE: undefined, LOCK_PRESENT: "true",
                          LOCK_COMMENTS: JSON.stringify(comments(A)), LOCK_NOW: String(NOW) });
check("before 缺失时不抛，正常判（新分支第一次推送）", noBefore.code, 0);
check("before 缺失时读成空串、不判作废，也不吐检查体（OK）", noBefore.stdout, "");

/* ---- 接线本身要钉住 ----
   这一段守的不是判定逻辑，是**这套接线到底跑不跑得起来**。
   源码断言读的是文本，认得的只有下面这几个模式：有人换一种写法这几条就看不见了，
   那时该问的是「这条还成不成立」，不是把断言改绿。 */
{
  const dir = path.join(__dirname, "..", "..");
  const wf = fs.readFileSync(path.join(dir, "workflows", "review-gate.yml"), "utf8");
  const act = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, "actions", "labels-sync", "labels.json"), "utf8"));

  /* 每条都先摆一个正对照：一次「无命中」同时兼容「真的没问题」和「正则压根匹配不到
     任何东西」，没有正对照分不开这两种。 */
  ok("W1 正对照：读到的确实是那份可复用工作流（`on: workflow_call`）",
    /^on:\n\s*workflow_call:/m.test(wf));
  ok("W2 正对照：这份工作流里确实有 `uses:` 这种写法（下面 W3 不是凭空的）",
    /^\s*uses: /m.test(wf));

  /* W3：内层必须是同仓自引用 `$/`，不许带 @{ref}、不许是 ./ ——理由同 qa-gate.test.js。 */
  const refs = (wf.match(/^\s*uses:.*$/gm) || []).filter((l) => l.includes("actions/review-gate-lock"));
  ok("W3 正对照：工作流里至少引用了一次这个组合动作（下面判据不是凭空的）", refs.length > 0);
  ok("W3 每一处引用都必须精确是 `$/.github/actions/review-gate-lock`",
    refs.length > 0 && refs.every((l) => /uses:\s*\$\/\.github\/actions\/review-gate-lock\s*$/.test(l)));
  ok("W4 **这条路上不许有 checkout**——权限取自 caller 且只能降不能升", !/actions\/checkout@/.test(wf));

  ok("W5 正对照：组合动作里有 `run:`（下面 W6 不是凭空的）", /^\s*run: /m.test(act));
  ok("W6 **组合动作跑的是跟着它一起下发的那份脚本**（`$GITHUB_ACTION_PATH`）",
    /node "\$GITHUB_ACTION_PATH\/lock\.js"/.test(act));
  ok("W7 组合动作确实是 composite", /using:\s*composite/.test(act));

  /* W8：**锁标签必须在共享清单里**。
     GitHub 对打一个不存在的标签是**静默不打**（官方原文见 labels-sync.js 顶部），
     所以「清单里漏了它」的表现是：评审者打标签那一步没报错、标签根本没上去、
     于是永远判「没有锁」——整把锁形同虚设，而且没有任何症状。 */
  const names = new Set(manifest.map((l) => l.name));
  ok(`W8 \`${LOCK_LABEL}\` 在共享清单里（不在的话打标签是静默失败的）`,
    names.has(LOCK_LABEL));

  /* W9：**动作里那行 `contains(...)` 必须精确用这个字面量**。
     它在 action.yml 里是硬编码字符串，改了常量不会跟着改——
     而它判的就是「事件快照里有没有这把锁」，判错了整把锁不工作。 */
  ok("W9 正对照：action.yml 里确实有 contains(...) 那行",
    /contains\(fromJSON\(/.test(act));
  ok(`W9 那行用的必须是 \`${LOCK_LABEL}\` 字面量`,
    act.includes(`'${LOCK_LABEL}'`));

  /* W10：**`: ` 后面接中文的 YAML 值必须加引号**。
     这是这个仓库真的踩过的形状：`description: 锁：评审正在…` 里的 `: ` 会让 YAML
     把它解析成嵌套映射，而不是一个字符串——`action.yml` 直接读不起来。
     判据只认「值里出现 `: ` 却没被引号包住」这一种，别扩大。 */
  const badYaml = act.split("\n").filter((l) => {
    const m = /^\s*(description|name):\s+(.*)$/.exec(l);
    return m && !/^["'>|]/.test(m[2].trim()) && /: /.test(m[2]);
  });
  ok("W10 action.yml 里没有「值含 `: ` 却没加引号」的行（YAML 会解析成映射）"
    + (badYaml.length ? "：" + badYaml.join(" | ") : ""), badYaml.length === 0);

  /* W11 / W12：读评论那一步有两个**只在真跑起来才暴露、而且都是静默**的坑。
     两条都是这次实现时自己写错过的，所以钉在这儿。 */

  /* W11：`--paginate` 配 `--jq` 吐出来的**不是一段合法 JSON**——
     gh 把每一页的 jq 结果各自序列化后首尾相接。页数 > 1 时 `JSON.parse` 直接抛，
     判定步骤红 → 那个 SHA 上没有 `review` → PR 停在 Expected。 */
  ok("W11 正对照：读评论那一步确实用了 --paginate（下面判据不是凭空的）",
    /--paginate/.test(wf));
  /* **只看真正的命令行，不看注释**：注释里正是在讲这个坑，会写到 `--jq` 这个词。
     去掉以 `#` 开头的行之后再判，否则这条断言被自己的说明文字触发。 */
  const wfCode = wf.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  ok("W11 **`--paginate` 不许配 `--jq`**（分页时每页各吐一段 JSON，拼起来不是合法 JSON）"
    + "——要配 `-q` 再用 `jq -s 'add // []'` 收成一段",
    !/--paginate[\s\S]{0,300}?--jq/.test(wfCode));
  ok("W11 分页结果必须被收成一段 JSON（`jq -s`）", /jq -s 'add \/\/ \[\]'/.test(wf));

  /* W12：`$GITHUB_OUTPUT` 是**一行一条**的格式，值里带换行会被 GitHub 拒掉这一步
     （"Invalid format"）。而评论体里一定有换行——那正是它的用处（锁元数据那条注释）。
     所以必须用 heredoc 定界符写，不能写 `comments=$BODY`。 */
  ok("W12 正对照：确实往 GITHUB_OUTPUT 里写 comments（下面判据不是凭空的）",
    /comments/.test(wf) && /GITHUB_OUTPUT/.test(wf));
  ok("W12 **多行的 comments 必须用 heredoc 定界符写进 $GITHUB_OUTPUT**"
    + "（写 `comments=$BODY` 会因为值里有换行被 GitHub 拒掉）",
    /comments<<__LOCK_EOF__/.test(wf));

  /* W13 / W14：这次要修的洞——OK 时无条件写一条 success 的 review，
     把「缺席即拦」废掉了（GTO-Trainer#186/#189/#191）。
     判定不许只活在 YAML 的 `if` 里，落点是「有没有 body」，见 action.yml / lock.js
     的注释。这里钉住接线还在，不是重新验一遍那条 gh api 会不会因空 body 而失败——
     那条要真的打一次网络请求才验得动，这个套件验不了，只能靠这两处（`.claude/rules/
     ci-dev.md` 允许的退路是「说清楚它靠什么兜底」，见 PR 里的报告）。 */
  ok("W13 正对照：组合动作里确实有 has_body 这个输出（下面判据不是凭空的）",
    /has_body/.test(act));
  ok("W13 has_body 必须照 body 文件是不是非空算（`[ -s ... ]`），"
    + "不是重新问一遍 conclusion——判据落在产出的文件上，即使调用方少判它也有兜底",
    /\[ -s "\$RUNNER_TEMP\/review-lock\.json" \]/.test(act));
  ok("W13 outputs 块里也声明了 has_body（不只是 step 里写，还要透传给调用方）",
    /has_body:/.test(act) && /steps\.decide\.outputs\.has_body/.test(act));

  ok("W14 正对照：workflow 里确实有『在新 head 上写 review commit status』这一步"
    + "（下面判据不是凭空的）",
    /在新 head 上写 review commit status/.test(wf));
  /* **只看这一步自己的 `if:` 那一行代码，不看整份文件、也不看注释**：
     上面那段说明性注释里为了讲清楚这条规矩，字面上就含 `has_body == 'true'`——
     如果只 `wf.includes(...)` 全文匹配，把这一步真正的 `if:` 删掉、只留注释，
     断言照样绿。**这正是本仓 code-reviewer 记录过的坑（W11 那条注释同一形状）**：
     一次无命中/命中同时兼容两种解释，这里补的是「命中」也可能命中错地方。
     所以先剥注释（`wfCode`，W11 已经算过），再定位这一步之后紧跟着的
     `if:` 那一行本身。 */
  const writeStatusIf = (() => {
    const idx = wfCode.indexOf("在新 head 上写 review commit status");
    if (idx === -1) return "";
    const after = wfCode.slice(idx, idx + 300);
    const m = /if:\s*(.*)/.exec(after);
    return m ? m[1] : "";
  })();
  ok("W14 正对照：定位到了这一步自己的 if 行（下面判据不是凭空的）",
    writeStatusIf.length > 0);
  ok("W14 那一行 `if:` 本身（不是附近的注释）必须带 `has_body == 'true'`——"
    + "OK 时不许尝试写检查（这条是效率与噪音的问题，不是安全边界；"
    + "安全边界是空 body 让 gh api 自己失败，见 W13 与 lock.js 里 statusBody 的注释）",
    /has_body == 'true'/.test(writeStatusIf));

  /* W15：lock.js 里 `statusBody` 对 OK 结论必须提前返回 `status: null`，
     不能落进给 STATE 表查值那条路——STATE 表里已经没有 OK 这个键了，
     如果早退分支被删掉，`STATE[OK]` 会是 `undefined`，函数会抛，
     而不是「安静地」写回 success。这条断言钉的是源码形状，行为已经被
     上面那些 statusBody() 的单测钉过了，这里只是防止两处各自漂移。 */
  const lockSrc = fs.readFileSync(path.join(__dirname, "lock.js"), "utf8");
  /* **只看真正的 STATE 定义那一行，不看它上面一整段解释这次事故的注释**——
     那段注释里为了说清楚「以前这里写的是什么」，字面上就含
     `[OK]: "success"`，拿它去扫整个文件会被自己的说明文字触发（同 W11 的坑）。 */
  const stateLine = (lockSrc.match(/^const STATE = \{.*\}\s*;/m) || [""])[0];
  ok("W15 正对照：确实取到了 STATE 定义那一行（下面判据不是凭空的）",
    stateLine.length > 0);
  ok("W15 STATE 表里不许再出现 `[OK]:`（OK 早就该在更前面被拦下，不该有对应的 state 值）",
    stateLine.length > 0 && !/\[OK\]/.test(stateLine));
}

console.log(`\nPR 写锁判定：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
