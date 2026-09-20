#!/usr/bin/env node
/* PR 写锁的判定：一个 PR 上的评审「在飞」时，推新 commit 会让这一轮结论作废。

   **这份文件是组合动作 `.github/actions/review-gate-lock` 的一部分，各仓库共用这一份**，
   通过 `.github/workflows/review-gate.yml` 那个可复用工作流被调到各仓库的 job 里。
   为什么这么拆见本仓 README；锁本身的调研与取舍见本仓
   docs/方案/2026-09-PR-写锁.md。

   ## 它回答的问题

   现有两条机制都只回答「这个 SHA **通过**了吗」，而且都在评审**结束之后**才写
   （`review` / `qa` 这两个 commit status）。**没有人回答「有人正在审吗」**——
   于是评审在跑的那十几分钟里，作者看到已发出的必修就改、就推，
   评审的目标 SHA 当场过期，这一轮结论作废，只能再派一轮。
   GTO-Trainer#182（一份纯文档）因此走了 9 轮，**其中两轮已判「通过」后作废**。

   ## 它不做什么（这一条比它做什么更重要）

   **它不阻止 push，也阻止不了。** 实调过 `GET /repos/GinkgoLeafLab/GTO-Trainer/rulesets`
   （2026-09-20）：ruleset 只覆盖 `~DEFAULT_BRANCH`，而 PR 的提交推在特性分支上；
   而且必需检查的语义是「不能**合并**」不是「不能 push」——官方文档
   *Available rules for rulesets* 原话是 "all required status checks must pass before
   collaborators can **merge** changes into the branch or tag"。

   所以这把锁的作用是**让「你的结论已经作废了」当场上报**：
   把这个事实从「作者事后自己算」变成「系统当场说，而且是一条变红的必需检查」。

   ## 为什么判定在这儿而不在 workflow 的 YAML 里

   和 `qa-gate.js` 同一个理由：它判错的后果不是「CI 红了」，而是**静默**——
   该报的作废没报，表面上一切正常，PR 照常合得掉，事故原样复发。
   这种东西必须待在有测试钉着的地方，钉着它的是同目录的 `lock.test.js`。

   ## 失败方向

   读不到环境变量、JSON 坏了、SHA 不像 SHA，一律**抛**。
   抛出去 job 就是红的，这个 job 不写 `review` 检查——而 `review` 是必需检查，
   新 SHA 上没有它，PR 停在 "Expected — waiting for status" 上，**拦住，不是放行**。
   方向与 `qa-gate.js` 一致：宁可拦住，不放行。 */

/* 锁标签。**这个名字是跨系统的契约**：人/agent 在 GitHub 上打的是它，
   判定认的也是它，清单（同目录 ../../actions/labels-sync/labels.json）里定义的是它。
   改名要三处一起改，lock.test.js 用字面量钉着。 */
const LOCK_LABEL = "review/in-flight";

/* 结论。**三态而不是两态**，因为「没有锁」和「锁是别人的/过期的」对作者意味着不同的事，
   而下面 STATE 才把它压成 commit status 的两态。 */
const OK = "ok";                 // 没有锁，或锁不属于这次推送 → 照常
const VOIDED = "voided";         // 锁在飞，而推送让它的 base 过期了 → 结论作废
const STALE = "stale";           // 锁还在，但它声明的 base 早就不是 head 了 → 只警告

/* 锁元数据的**唯一载体**是打锁时留下的那条评论，标题是这个前缀。

   为什么用评论而不是把 SHA 塞进标签名：标签名是 GitHub 上的一个共享命名空间，
   名字里带 SHA 意味着每个 SHA 一个新标签、清单没法预定义、也永远删不干净。
   固定标题的评论还能让人一眼看到「谁在审、审的是哪一版、什么时候到期」。

   格式（打锁方按这个写，解析失败一律当**没有锁**——失败方向见文件顶部）：
     <!-- review-lock base=<40位sha> holder=<登录名> exp=<epoch 秒> --> */
const META_RE = /<!--\s*review-lock\s+([^>]*?)-->/;
const FIELD_RE = /(\w+)=("[^"]*"|\S+)/g;

/* 把 `k=v k=v` 那一段解析成对象。认不出的键忽略，缺键由调用方判。 */
function parseFields(blob) {
  const out = {};
  let m;
  FIELD_RE.lastIndex = 0;
  while ((m = FIELD_RE.exec(blob)) !== null) {
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/* 从一批评论里找那条锁评论，返回 { base, holder, exp } 或 null。

   **取「最后一条」而不是「第一条」**：同一个 PR 上锁可以取了放、放了又取，
   旧的那条评论会一直留在那儿。按时间序取最后一条才代表**当前**这把锁。
   传入的 comments 按 GitHub 返回的顺序（时间正序），这里不重排——
   调用方负责给出正确顺序，重排要一个时间戳解析，而 API 已经保证了顺序。 */
function findLock(comments) {
  if (!Array.isArray(comments)) return null;
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i] && comments[i].body;
    if (typeof body !== "string") continue;
    const meta = META_RE.exec(body);
    if (!meta) continue;
    const f = parseFields(meta[1]);
    /* base 必须像 SHA。不校验的话，打锁方手滑写错一个字符，
       下面拿它和 head 比就永远不等，锁永远判「过期」——那是静默失效的一种。 */
    if (!/^[0-9a-f]{40}$/.test(f.base || "")) return null;
    const exp = Number(f.exp);
    return {
      base: f.base,
      holder: f.holder || "(未署名)",
      exp: Number.isFinite(exp) ? exp : null,
    };
  }
  return null;
}

/* 主判定。

   hasLock        : 事件快照里有没有 review/in-flight
   lock           : findLock(comments) 的结果（没有就 null）
   pushedHead     : 这次推送之后的 head（synchronize 事件里的 head.sha）
   previousHead   : 这次推送**之前**的 head（synchronize 事件里的 before）
   now            : 当前 epoch 秒，用来判 TTL

   返回 { conclusion, desc, releaseExpired }

   ## 为什么比对的是 previousHead 而不是「锁的 base == pushedHead」

   要判的是「**这次推送**有没有让在飞的评审过期」，也就是
   「锁声明的 base（评审开始时那一版）是不是就是被推掉的那一版」。

   写成 `lock.base === pushedHead` 是错的：推送之后 head 已经变成新的了，
   而锁的 base 是旧的，**两者永远不等**，于是每一次推送都判「没作废」——
   这把锁会安静地什么都不做。这是一路上最容易写反的一处，lock.test.js 钉着它。 */
function decide({ hasLock, lock, pushedHead, previousHead, now }) {
  if (!hasLock) {
    return { conclusion: OK, desc: "没有评审在飞", releaseExpired: false };
  }

  /* 挂着标签但读不到元数据：**当没有锁**。
     理由与「读锁失败」一致——不能因为一条评论写坏了就让所有 PR 合不了。
     但描述里要写明，否则这个状态在检查结果上看不出来。 */
  if (!lock) {
    return {
      conclusion: OK,
      desc: `挂着 \`${LOCK_LABEL}\` 但读不到锁元数据，当作没有评审在飞`,
      releaseExpired: false,
    };
  }

  const who = `holder=${lock.holder} base=${lock.base.slice(0, 7)}`;

  /* TTL：评审崩了、被掐了、忘了放锁，锁会永久挂着。
     这次事故的现场就反复发生（评审 subagent 会被 interrupt）。
     过期就**自动释放**，并且 releaseExpired 让 workflow 留一条痕——
     「锁自己消失了」不能变成新的静默失败。 */
  if (lock.exp !== null && now >= lock.exp) {
    return {
      conclusion: OK,
      desc: `锁已超时（${who}），自动释放`,
      releaseExpired: true,
    };
  }

  /* 被推掉的那一版正是评审在审的那一版 → **这一轮结论作废**。
     这是整把锁存在的理由，也是这次事故里最缺的那句话。 */
  if (previousHead && lock.base === previousHead) {
    return {
      conclusion: VOIDED,
      desc: `评审结论已作废：推送让在飞的评审（${who}）过期了`,
      releaseExpired: false,
    };
  }

  /* 这次事件**确实把 head 推进了一步**（有 before、且和 after 不同），
     而锁的 base 既不是被推掉的那一版、也不是现在的 head ——
     说明这把锁是另一轮评审留下的，或者这中间已经推过好几次。
     不判作废（那不是**这次**推送造成的），但**要说出来**，别假装没看见。

     **`pushed` 这两个前提都不能省**：
       - 新分支第一次推送时 before 是**全 0**（GitHub 的约定），那时
         `lock.base !== pushedHead` 也成立，却并没有任何东西被这次推送顶掉；
       - before 缺失（空串）同理。
     少了它们，一个「打标签/开分支就该判 stale」的 bug 会混在正确行为里过去
     （lock.test.js 里那三条边界钉着）。 */
  const pushed = Boolean(previousHead) && !/^0{40}$/.test(previousHead)
    && previousHead !== pushedHead;
  if (pushed && lock.base !== pushedHead) {
    return {
      conclusion: STALE,
      desc: `有评审在飞但锁的是旧版本（${who}），不是这一次推送`,
      releaseExpired: false,
    };
  }

  /* 锁的 base 就是当前 head：评审正在审这一版，而这次事件没有让 head 前进一步
     （例如打标签本身、或者 reopened）。照常。 */
  return { conclusion: OK, desc: `评审在飞（${who}），审的就是当前版本`, releaseExpired: false };
}

/* commit status 只有这几个 state，**没有 neutral**（同 qa-gate.js 的注释）。
   VOIDED 与 STALE 都落到 `failure`：
     - VOIDED 必须红——那正是要让人当场看见的东西；
     - STALE 也红是**刻意的保守**：那意味着有一个在飞的评审和一个对不上的 head，
       让人看一眼比让它绿着过去安全。**它是可以合成绿的方向，但我们没合。** */
const STATE = { [OK]: "success", [VOIDED]: "failure", [STALE]: "failure" };

/* 描述字段 GitHub 限 140 字符，超了**整个请求会被拒**——那意味着一条本该写上的
   作废警报根本没写上去。抽成函数是为了让它自己也能被断言（同 qa-gate.js）。 */
const DESC_MAX = 140;
function checkDesc(desc) {
  if (typeof desc !== "string" || !desc) throw new Error("描述不能为空");
  if (desc.length > DESC_MAX) throw new Error(`描述超过 ${DESC_MAX} 字符：${desc.length}`);
  return desc;
}

/* 拼出 POST /repos/{o}/{r}/statuses/{sha} 的请求体。

   **是 commit status 不是 check run**，理由与 qa-gate.js 完全相同（那边有实测记录），
   别改回去。

   注意 `context` 仍然是 `"review"`——**和 review-gate 通过时写的那个同名**。
   这是刻意的：`review` 是主干的必需检查，而「结论作废」就是 `review` 这个检查
   自己的结论。写成另一个名字（例如 `review-lock`）会凭空多出一条不必需的检查，
   没人看，也就白做了。 */
function statusBody(input, targetUrl) {
  const d = decide(input);
  const state = STATE[d.conclusion];
  if (!state) throw new Error(`没有对应 commit status state 的结论：${d.conclusion}`);
  const status = { state, context: "review", description: checkDesc(d.desc) };
  if (targetUrl) status.target_url = targetUrl;
  return { status, releaseExpired: d.releaseExpired, conclusion: d.conclusion };
}

/* —— CLI —— 从环境变量读，不从 argv 读（同 qa-gate.js：进 argv 要过 shell）。 */
function main() {
  const pushedHead = process.env.LOCK_HEAD;
  const previousHead = process.env.LOCK_BEFORE;
  const hasLockRaw = process.env.LOCK_PRESENT;
  if (!pushedHead || !/^[0-9a-f]{40}$/.test(pushedHead)) {
    throw new Error(`LOCK_HEAD 不是一个 40 位 SHA：${JSON.stringify(pushedHead)}`);
  }
  if (hasLockRaw === undefined) throw new Error("缺 LOCK_PRESENT");
  if (hasLockRaw !== "true" && hasLockRaw !== "false") {
    throw new Error(`LOCK_PRESENT 必须是 "true" / "false"：${JSON.stringify(hasLockRaw)}`);
  }

  /* 评论体：workflow 用 `gh api` 取回来之后原样喂进来。
     取不到（API 失败）时 workflow 传 `[]`——**当没有锁**，见文件顶部失败方向。 */
  let comments;
  try {
    comments = JSON.parse(process.env.LOCK_COMMENTS || "[]");
  } catch (e) {
    throw new Error(`LOCK_COMMENTS 不是合法 JSON：${e.message}`);
  }
  if (!Array.isArray(comments)) throw new Error("LOCK_COMMENTS 必须是数组");

  /* now 可注入，测试才判得动 TTL。缺省取本机时间。 */
  const now = process.env.LOCK_NOW ? Number(process.env.LOCK_NOW) : Math.floor(Date.now() / 1000);
  if (!Number.isFinite(now)) throw new Error(`LOCK_NOW 不是数字：${JSON.stringify(process.env.LOCK_NOW)}`);

  const { status, releaseExpired, conclusion } = statusBody(
    {
      hasLock: hasLockRaw === "true",
      lock: findLock(comments),
      pushedHead,
      /* before 可能是全 0（新分支的第一次推送）或缺失；两者都表示
         「没有一版被这次推送顶掉」，所以都传空串，判定那边一律不判作废。 */
      previousHead: /^[0-9a-f]{40}$/.test(previousHead || "") && !/^0{40}$/.test(previousHead)
        ? previousHead : "",
      now,
    },
    process.env.LOCK_TARGET_URL || ""
  );
  /* 请求体走 stdout，调用方重定向进文件再交给 `gh api --input`。 */
  process.stdout.write(JSON.stringify(status));
  /* 其余几个输出走 GITHUB_OUTPUT，别和上面那份 JSON 混在一条流里
     （同 qa-gate.js 的分工）。**body_path 由 action.yml 那一步自己写**——
     它才知道 $RUNNER_TEMP 在哪，脚本不该猜。 */
  if (process.env.GITHUB_OUTPUT) {
    require("fs").appendFileSync(
      process.env.GITHUB_OUTPUT,
      `release_expired=${releaseExpired ? "true" : "false"}\nconclusion=${conclusion}\n`
    );
  }
}

module.exports = {
  decide, findLock, parseFields, statusBody, checkDesc,
  LOCK_LABEL, OK, VOIDED, STALE, DESC_MAX, META_RE,
};

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`review-gate-lock: ${e.message}`);
    process.exit(1);
  }
}
