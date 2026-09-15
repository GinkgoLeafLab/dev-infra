#!/usr/bin/env node
/* QA 门禁：把 PR 上的标签翻译成一个挂在 head SHA 上的必需检查 `qa` 的结论。

   **这份文件是组合动作 `.github/actions/qa-gate` 的一部分，各仓库共用这一份**，
   通过 `.github/workflows/qa-gate.yml` 那个可复用工作流被调到各仓库的 job 里。
   为什么这么拆见本仓 README 与 GinkgoLeafLab/GTO-Trainer 仓的
   docs/方案/2026-09-跨仓库基础设施复用.md；
   门禁本身的调研与取舍见那个仓的 docs/方案/2026-09-评论线自处理与-QA-门禁.md。

   **为什么判定在这儿而不在 workflow 的 YAML 里**：它判错一次的后果不是「CI 红了」，
   而是**一个标了「必须测」的 PR 拿到绿的必需检查**——表面上一切正常，检查绿着、合得掉。
   这种东西必须待在有测试钉着的地方（各仓的 `scripts/docs-only.js` 是同一个理由），
   而钉着它的是同目录下的 `qa-gate.test.js`，由本仓的 `.github/workflows/test.yml` 跑。

   **`decide()` 判三态，`STATE` 才压成 commit status 的两态**：免测与通过都落到
   `success`（描述不同、要不要摘标签也不同），等待落到 `failure`。
   所以「不需要 QA 也能放行」的原因是那层映射，**不是** GitHub 接受某种「中立」结论——
   commit status 根本没有那一档。**「需要但还没测」必须是 `failure`**，
   写成 `success` 是直接放行、写成 `pending` 是「看起来还在跑」，两个都等于这道门不存在。
   （我们不再写 check run，所以官方那句关于 check run conclusion 的原文
   在这里不再适用，见下面 STATE 那一段。）

   失败方向：读不到环境变量、JSON 坏了、SHA 不像 SHA，一律**抛**。
   抛出去 job 就是红的，那个 SHA 上不会有 `qa` 检查，PR 停在
   "Expected — waiting for status" 上——**拦住，不是放行**。 */

const REQUIRED_LABEL = "qa-required";
const PASSED_LABEL = "qa-passed";

/* 认得的 pull_request_target 事件。**不在这张表里就抛**——多一个触发类型时 job 会当场红，
   而不是悄悄按「不是 synchronize」处理，那正好是下面那个竞态要防的方向。 */
const ACTIONS = ["opened", "reopened", "synchronize", "labeled", "unlabeled"];

/* labels: 标签名数组。返回 { conclusion, desc, removeLabel }。
   `conclusion` 是三态判断（免测 / 等待 / 通过），下面的 STATE 把它压成 commit status
   的两态——**判断留三态是刻意的**，「免测」和「通过」都绿，但它们不是一回事。
   removeLabel 非空时，workflow 写完检查要把它摘掉——标签是一次性信号不是状态，
   留着它会在下一版代码上假装「已经测过了」。 */
function decide(labels, action, label) {
  const has = (name) => labels.includes(name);

  /* **只有「这个事件本身就是在打 `qa-passed`」时才认那个标签。** 其余一律当过期。

     要判的是「**这一版**有没有被人打过 `qa-passed`」，而 `github.event.pull_request.labels`
     是 webhook **事件创建那一刻**的快照——快照过没过期和事件类型无关，所以不能拿事件类型当键：

     1. head = SHA1，`qa-tester` 打上 `qa-passed` → 事件 A（labeled），run A 排队
     2. 作者推了 SHA2 → 事件 B（synchronize），快照里仍带着 `qa-passed`
     3. run A 那句 DELETE 还没落地的这段时间里，**任何一个 `qa-` 标签动作**
        （有人补打 `qa-required`、或者摘掉它）→ 事件 C 的快照里照样带着 `qa-passed`，
        而 head 已经是 SHA2 → 于是**在没人测过的 SHA2 上写 success**

     只挡 `synchronize` 会漏掉第 3 步，而它和第 2 步是同一个失效、只是换了个入口。
     `labeled` + `label === qa-passed` 这个条件把 `unlabeled` / `reopened` / `opened`
     和「打的是别的 `qa-` 标签」一起全收进来了。

     窗口也不止「一个 run 的时长」：摘标签那步靠 gate 步骤的输出，gate 一抛
     （以后往 `types` 里加了事件类型而 `ACTIONS` 没跟上就会）输出就是空的，
     标签会一直留在 PR 上。

     正常流程不受影响：`qa-tester` 打标签那一下就是 labeled + `qa-passed`，写完随即摘掉；
     摘掉之后的事件，快照里本来就没有它了。

     现读标签不算修掉——事件已经发出来了，读到的还是「摘之前」那一份。 */
  const fresh = has(PASSED_LABEL) && action === "labeled" && label === PASSED_LABEL;
  if (has(PASSED_LABEL) && !fresh) {
    return {
      conclusion: has(REQUIRED_LABEL) ? "failure" : "neutral",
      desc: has(REQUIRED_LABEL)
        ? `\`${PASSED_LABEL}\` 不是这个事件打上的，这一版没人测过`
        : `没有 \`${REQUIRED_LABEL}\`，跳过 QA`,
      removeLabel: null,
    };
  }

  /* 有人主动测了却没标 qa-required 也算数（多测不是错） */
  if (fresh) {
    return {
      conclusion: "success",
      desc: "qa-tester 判这一版通过",
      removeLabel: PASSED_LABEL,
    };
  }
  if (has(REQUIRED_LABEL)) {
    return {
      conclusion: "failure",
      desc: `标了 \`${REQUIRED_LABEL}\`，但这一版还没通过 QA`,
      removeLabel: null,
    };
  }
  return {
    conclusion: "neutral",
    desc: `没有 \`${REQUIRED_LABEL}\`，跳过 QA`,
    removeLabel: null,
  };
}

/* commit status 只有这四个 state，**没有 neutral**——所以「不需要 QA」那一格写 success。
   这一步顺带把「ruleset 到底认不认 neutral」那个一直找不到出处的问题消掉了。 */
const STATE = { success: "success", neutral: "success", failure: "failure" };

/* 描述字段 GitHub 限 140 字符，超了**整个请求会被拒**——那意味着一条本该拦住的检查
   根本没写上去。抽成一个函数是为了让它自己也能被断言（不然这道守卫删掉之后，
   现有描述都很短、测试照样全绿，就成了一句「声称有用」的注释）。 */
const DESC_MAX = 140;
function checkDesc(desc) {
  if (typeof desc !== "string" || !desc) throw new Error("描述不能为空");
  if (desc.length > DESC_MAX) throw new Error(`描述超过 ${DESC_MAX} 字符：${desc.length}`);
  return desc;
}

/* `POST /repos/{o}/{r}/statuses/{sha}` 的请求体。

   **必需检查认的是 commit status，不是 check run。** 这条是**在同组织的产品仓
   （GTO-Trainer）上实测出来的**：那边用 Checks API 现写的 check run 不被匹配——
   #67 / #68 上 `review` 与 `qa` 都存在于 head SHA、结论正常，merge box 照样说
   「Expected — Waiting for status to be reported」，而同一个 PR 上 job 产出的 `test`
   匹配得上；换成 commit status 之后 #69 当场变 `clean`。**原因没查到出处**，
   别在这上面编一个机制。**这条是那一个仓库的实测，别的仓库没有各自复现过**——
   而这份文件现在是所有仓库共用的，所以照抄它的是「结论」不是「本仓现象」。
   调研见 GinkgoLeafLab/GTO-Trainer 仓的
   docs/方案/2026-09-放行检查改用-commit-status.md。**别改回 check run。** */
function statusBody(labels, action, label, targetUrl) {
  const d = decide(labels, action, label);
  const state = STATE[d.conclusion];
  if (!state) throw new Error(`没有对应 commit status state 的结论：${d.conclusion}`);
  const status = { state, context: "qa", description: checkDesc(d.desc) };
  if (targetUrl) status.target_url = targetUrl;
  return { status, removeLabel: d.removeLabel };
}

/* —— CLI —— 从环境变量读，不从 argv 读：标签名是用户随手填的文本，
   进 argv 就要经过 shell，那是注入口子。JSON.stringify 顺带把引号转义接过去。 */
function main() {
  const raw = process.env.QA_GATE_LABELS;
  const sha = process.env.QA_GATE_SHA;
  const action = process.env.QA_GATE_EVENT;
  if (!ACTIONS.includes(action)) {
    throw new Error(`QA_GATE_EVENT 不认得：${JSON.stringify(action)}（认得的：${ACTIONS.join(" / ")}）`);
  }
  /* 标签事件必须带上是哪个标签——没有它就判不出「这个事件是不是在打 qa-passed」。
     缺了直接抛：那是 workflow 接线错了，job 红 → 检查缺席 → 拦住，看得见。 */
  const label = process.env.QA_GATE_LABEL || "";
  if ((action === "labeled" || action === "unlabeled") && !label) {
    throw new Error(`${action} 事件缺 QA_GATE_LABEL`);
  }
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`QA_GATE_SHA 不是一个 40 位 SHA：${JSON.stringify(sha)}`);
  }
  if (raw === undefined) throw new Error("缺 QA_GATE_LABELS");
  let labels;
  try {
    labels = JSON.parse(raw);
  } catch (e) {
    throw new Error(`QA_GATE_LABELS 不是合法 JSON：${e.message}`);
  }
  if (!Array.isArray(labels) || labels.some((l) => typeof l !== "string")) {
    throw new Error("QA_GATE_LABELS 必须是字符串数组");
  }

  /* sha 不进请求体——commit status 是 POST 到 /statuses/{sha} 的，SHA 在 URL 里。
     上面那道 40 位校验仍然必须留着：它挡住的是 workflow 接线错误。 */
  const { status, removeLabel } = statusBody(
    labels, action, label, process.env.QA_GATE_TARGET_URL || ""
  );
  /* 请求体走 stdout，调用方把它重定向进一个文件再交给 `gh api --input`。 */
  process.stdout.write(JSON.stringify(status));
  /* 要摘的标签走 GITHUB_OUTPUT，别和上面那份 JSON 混在一条流里。 */
  if (process.env.GITHUB_OUTPUT) {
    require("fs").appendFileSync(
      process.env.GITHUB_OUTPUT,
      `remove_label=${removeLabel || ""}\n`
    );
  }
}

module.exports = { decide, statusBody, checkDesc, REQUIRED_LABEL, PASSED_LABEL, ACTIONS, DESC_MAX };

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`qa-gate: ${e.message}`);
    process.exit(1);
  }
}
