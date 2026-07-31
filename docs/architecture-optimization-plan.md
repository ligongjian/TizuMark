# TizuMark 架构优化最终方案（第十轮 · 终版收口）

> **基线**：`HEAD = 2165504`，工作区干净（仅本文件未跟踪），`src/lib/unified-bundle.js` 在位（878.7kb），基线测试全绿。
>
> **关于 gitee 的 `origin/unified-rendering` 分支**：已定性为**6 月的旧历史线**（顶端提交 2026-06-29，与当前 master **无共同祖先**），孤儿分支，不合并、不影响本方案。
>
> **审查历程**：①评审原建议 → ②补 IPC 边界缺口 → ③拉取最新代码全量复核 → ④核对 Rust 侧契约与测试基建，自我纠正 3 处 → ⑤验证执行期细节（语法形态/命名/rAF/stub/直跑缺口）→ ⑥首次做「原型实证」，隔离环境实跑 9 组场景，自我纠正 2 处 → ⑦改查「落地写法层」，新增 11 项发现（3 红），自我纠正 2 处（含 1 处推翻上轮核心论断）→ ⑧承重断言代码级复核 + 边界拆清（N32 / C16）→ ⑨**第九轮专攻尚未实证过的执行风险**：代码级确认 N13（harness 在加载模块前注入 `window.__TAURI__.core.invoke`，延迟求值 tauri-api 必然接管 → 28 集成测试零改动延续）；实查渲染代际检查点为 **14 处**（非 17），且 `_mermaidGeneration` 守卫（2114）是独立竞态点、P0-3a 原描述测试覆盖不到（N33）。**结论：除 N33 这处计数/覆盖小缺口外，无新承重矛盾，方案可执行。**
>
> 本文是**唯一权威版**，取代前六轮全部结论。

---

## 0. 累计 7 处自我纠正（前几轮方案曾是错的）

架构方案最危险的不是遗漏，而是**写着「已验证可行」的错误结论**。

**第七轮新增的 2 处：**

| # | 前几轮的说法 | 实际情况 | 后果 |
|---|---|---|---|
| **R6** | N16：「**NaN 是真实可达的**」「兑现一个真实 bug 修复」，理由是 `outline.js:58` 在 `node.line` 为 undefined 时产出 `data-line="undefined"` | **该前提不成立**。`extractHeadings` 里 `headings.push({..., line: i })` —— `line` **恒为数字**；`buildOutlineTree` 用 `{...h}` 透传；且全仓库 `.outline-item` **只有 `renderOutlineHtml` 一个生产者**（app.js 三处均为查询/移除 class）。**今天没有任何路径能让 `parseInt(dataset.line)` 得到 NaN** | 上一轮把一个**结构性脆弱点**说成了**已可触发的缺陷**。修复仍值得做（2 行、边际风险≈0），但①不能宣称在修用户能遇到的 bug；②C14 的 app 层用例必须写成**防御性注入**（手工塞 `data-line="undefined"`），若按「复现真实场景」去写，会**永远造不出这个场景而卡住** |
| **R7** | §4 测试政策：「`run-tests.cjs` 单文件单进程**天然支持过滤**」 | `main()` **完全忽略 `process.argv`**（`listTestFiles()` 无参、`main()` 无 argv 读取）—— 运行器只能全量跑。所谓「只跑相关测试」实际是绕过运行器直接 `node --test test/x.test.cjs` | 方案默认存在的能力其实不存在。后果：**唯一被使用的日常入口恰好是绕过全部守护的那个** —— P0-0b 的产物检查、未来的任何前置检查都不在这条路径上。对策：给运行器加 5 行 argv 过滤（P0-0f），把日常入口拉回守护之内 |

**第六轮的 2 处：**

| # | 前几轮的说法 | 实际情况 | 后果 |
|---|---|---|---|
| **R4** | 方案通篇写「CI 跑全量」「CI 卡阈值」「契约漂移在 CI 暴露」「CI 接 cargo test」「ESLint 卡点禁止 `window.Xxx=`」 | **这个项目根本没有 CI**：`.github/workflows/` 不存在，无 `.gitlab-ci.yml`，无任何流水线配置；**也没有 ESLint**（无 `.eslintrc*` / `eslint.config.*`，package.json 无 lint 脚本） | 方案的**整套强制机制是空中楼阁**。所有护栏若只挂在 CI 上，等于没有护栏 —— 必须改为「本地 npm script 优先，CI 作为显式独立步骤 P1-8」 |
| **R5** | P1-2.3：「`csp-check.cjs` / `csp-server.cjs` 接入 `npm run test:csp` **或**删除」 | 实测 `csp-check.cjs` 依赖 `src/tauri-mock.js`（注入到 index.html 让 app.js 能在纯浏览器启动）——**该文件磁盘和 git 里都不存在**；同时硬编码 `C:/Users/admin/.claude/skills/browser/node_modules/ws`（`ws` 不在 package.json） | **这是第二个僵尸，不是「孤儿」。**「接入」是伪选项，接进去必红。而它是 CSP 唯一的自动化安全网 → ADR-4（ESM/CSP 变更）目前**零回归保护** |

**前几轮的 3 处（保留）：**

| # | 第三轮的说法 | 实际情况 | 后果 |
|---|---|---|---|
| **R1** | ADR-2：「`_isBlockStart` / `_computePreviewWindow` / `_renderPreviewWindowBlock` **三者抽取为纯函数完全可行**」 | 上轮用 `sed -n '6592,6649p'` 统计依赖，**行范围跨了 4 个方法**导致依赖被张冠李戴。真实情况：只有前两个是纯的；`_renderPreviewWindowBlock` 写 DOM，且同族的 `_syncPreviewVirtualScroll` 在 120ms 定时器里**回调 `this.updatePreview()`** | 照上轮执行会试图把有状态视图行为塞进"纯模块"，抽到一半发现循环依赖，被迫回滚 |
| **R2** | P1-2：「`run-tests.cjs` 递归扫描，把 `test/browser/` 纳入，预期首跑暴露失败，单独 PR 处理」 | 实跑了那个测试：**它是僵尸**——fixture `src/test-browser.html` 根本不存在（磁盘和 git 都没有），还硬编码了 `C:/Users/admin/.claude/skills/browser/browser/node_modules/ws` 和 Chrome 绝对路径，`ws` 不在 package.json | "纳入后修一修"是伪命题，它在任何机器/CI 上都不可能通过 |
| **R3** | P0-1：「`index.html` 每个业务脚本加 `onerror` 上报 + 非白屏错误条」 | `app.js:1` 是 `const { invoke } = window.__TAURI__.core;` **顶层无守卫解构**。`window.__TAURI__` 缺失时 app.js 是**加载成功、执行第一行抛 TypeError**——`<script onerror>` 只捕获**加载失败**，兜不住这个 | 最脆弱的单点恰好是 onerror 覆盖不到的，防护形同虚设 |

另修正竞态点计数（第九轮实查）：`_renderGeneration` 比较检查 **13 处**（updatePreview 8 + processImages 4 + _focusPreviewToLine 1），另有独立的 `_mermaidGeneration` 守卫 **1 处**（2079 自增 / 2114 比较），全文 **14 处**；上轮写的「17 处」为虚数，且 `_mermaidGeneration` 是 P0-3a 原描述测试覆盖不到的独立竞态点（N33）。

---

## 1. 本轮新发现

### 🟢 N1 — 前后端 IPC 契约完全对齐（好消息，且可锁定）

首次核对 Rust 侧。`src-tauri/src/lib.rs` 的 `generate_handler!` 注册 **20 个命令**，与前端 `invoke` 的 20 个自定义命令**双向零差集**：

```
前端调用但 Rust 未注册：（空）
Rust 注册但前端未调用：（空）
```

**含义**：① 口径修正——不是「23 命令」，而是 **20 个自定义命令 + 3 类 plugin 命令**（`plugin:updater|check/download/install`、`plugin:dialog|open/save`、`plugin:webview|internal_toggle_devtools`）；② `tauri-api.js` 的命令清单有了**权威来源**，可以写一条契约测试用 `lib.rs` 反向校验，从此前后端不一致在 `npm run check` 就暴露（P1-8 后进 CI），而不是等桌面运行时。

### 🟠 N2 — Rust 侧存在一整套「僵尸渲染实现」

`lib.rs:924` 的 `render_markdown` 标着 `#[allow(dead_code)] #[tauri::command]`，**定义了但未注册**到 `invoke_handler`。它背后是完整的 pulldown-cmark 渲染链（`preprocess_markdown` / `guard_math_blocks` / `extract_abbreviations`），并有 **8 个 XSS 单元测试**仍在编译运行。

前端渲染早已全量走 `unified-renderer.js`。**这是两套并存的 Markdown 实现**，其中一套永久无法被调用，却仍在被维护和测试。属于架构层面的认知陷阱——未来有人改 XSS 过滤规则，很可能改在死代码上。

> 处置见 P1-7。**不在 P0 动它**（无运行时风险，且删除涉及 Rust 侧较大 diff）。

### 🔴 N3 — `test/browser/` 是僵尸测试，不是「欠账」

`test/browser/code-block-brackets.test.cjs` 实跑结果 **fail 1**，根因是**四重**的：

| 问题 | 证据 |
|---|---|
| fixture 不存在 | `src/test-browser.html` 磁盘无、`git ls-files` 无 |
| 依赖本机私有路径 | `require('C:/Users/admin/.claude/skills/browser/browser/node_modules/ws')` |
| 依赖未声明 | `ws` 不在 package.json 任何依赖段 |
| 硬编码浏览器 | `C:/Program Files/Google/Chrome/Application/chrome.exe` |

**它从未被 `run-tests.cjs` 执行过（不递归），所以这些腐坏一直没暴露。** 上轮把它当"纳入后修一修"处理是错的。

### 🔴 N4 — `app.js:1` 顶层解构是全应用最脆弱单点，且现有防护思路兜不住

```js
const { invoke } = window.__TAURI__.core;   // app.js:1，无任何守卫
```

`window.__TAURI__` 未定义 → 整个 app.js **执行第一行即 TypeError** → 类未定义 → 全白屏。而这**不是加载错误**，`<script onerror>` 捕获不到。

**正解**：`window.addEventListener('error')` 全局兜底 + 把这行改成守卫式延迟求值（这恰好由 P0-2 的 `tauriApi` 延迟求值天然解决——**P0-2 顺带修掉了 P0-1 修不了的东西**，两者顺序不能颠倒）。

### 🟡 N5 — 模块加载顺序是 `readdirSync` 字典序（隐式契约）

harness 与 `index.html` 都按固定顺序加载 6 个模块，harness 用的是 `fs.readdirSync` 的**字典序**：
`code-block → dialogs → find-replace → outline → preview-post → word-count`

今天各模块互不依赖，所以没暴露。新增 `tauri-api.js` 后字典序排在 `preview-post` 之后 —— **若将来 `preview-post` 想调用 `tauriApi`，在 harness 里会是 undefined，但在 `index.html` 里（可手动排序）却正常**，形成"测试通过、运行时行为不同"的错位。

**对策**：`tauri-api.js` 设计为**纯延迟求值**（调用时才读 `window.__TAURI__`），使加载顺序不敏感；并在 harness 里显式优先加载它，而非依赖字典序。

### 🟡 N6 — `run-tests.cjs` 完全不跑 Rust 测试

`scripts/run-tests.cjs` 只 spawn `node --test`，无 `cargo test`。`lib.rs` 里的单元测试（含 N2 那 8 个 XSS 测试、`files_from_args` 等）**从不在 `npm test` 中执行**。前端改动若影响 Rust 契约，本地无感。

### 🟡 N7 — `_computePreviewWindow` 是完美的抽取候选（比上轮预估更好）

精确读取 `app.js:6592-6618` 全文后确认：**零 DOM、零副作用、无 `this` 状态**，只依赖 `this._isBlockStart`（同样纯）+ 3 个模块级常量。返回 `{start, end}`。

这是整个 `updatePreview` 链路里**唯一一块可以零风险切下来的纯逻辑**，且它承载了最易错的算法（块边界回退、代码围栏奇偶配对、guard 上限 500）。**抽它性价比最高。**

同族其余方法的真实边界与性质：

| 方法 | 行 | 性质 | 处置 |
|---|---|---|---|
| `_isBlockStart` | 6585-6591 | 纯 | ✅ P0-3 抽 |
| `_computePreviewWindow` | 6592-6618 | **纯** | ✅ P0-3 抽 |
| `_buildWindowLineTops` | 6621-6634 | 读 DOM、写 `this._windowLineTops` | ⛔ 留 |
| `_focusPreviewToLine` | 6635-6649 | 读状态、写 `scrollTop` | ⛔ 留 |
| `_renderPreviewWindowBlock` | 6650-6663 | 写 DOM | ⛔ 留 |
| `_updateVirtualScrollMetrics` | 6664-6685 | 写状态 | ⛔ 留 |
| `_syncPreviewVirtualScroll` | 6686-6703 | **120ms 定时器回调 `this.updatePreview()`** | ⛔ 留（循环依赖） |

### 🟡 N8 — CSP 与入口插入点已确认无阻碍

`tauri.conf.json:26`：`script-src 'self' 'unsafe-inline' 'unsafe-eval'`，无 `script-src-elem` 限制 → ESM（`type=module` + `'self'`）可行，ADR-4 成立。
`index.html:1070-1078` 平铺 8 个 script，`tauri-api.js` 插入点明确：**1071 行之后、`app.js` 之前**。

### 🟡 N9 — 三个依赖产物的测试现已全绿（基线可信）

`render` 11/11、`render-extra` 19/19、`tab-scroll` 2/2。上一轮的阻塞项已解除，方案可直接开工。

### 🟢 N10 —（第五轮）invoke 调用形态高度规整，P0-2b 替换风险**下调**

对 46 处 invoke 做语法形态分类：**43 处 `await invoke('cmd', …)`** + **1 处 fire-and-forget**（`app.js:5483` `try { invoke('stop_watch'); } catch …`，卸载路径，故意不 await）+ **2 处直接 `window.__TAURI__.core.invoke`**（3530/7617）。**零 `.then()` 链、零模板串命令名、零跨行命令名**。含义：机械替换是纯文本级操作，无需处理异步链改写；唯一注意点是 5483 行**保持不 await 语义**（`tauriApi.stopWatch()` 返回 promise 不 await 即可，但要 `.catch(()=>{})` 防 unhandled rejection——原 try/catch 对 async 错误本就无效，这里顺带修复一个既有小 bug）。

### 🟢 N11 —（第五轮）`tauriApi` 命名零冲突，且无 inline IPC 漏网

全源码 `\btauriApi\b` 零命中；`src/index.html` 的 inline script 无任何 `invoke(`/`__TAURI__` 引用；`src/` 仅一个 html 文件。P0-2 的两类潜在漏网（命名撞车、HTML 内联调用）均排除。另确认 6 个模块内**零 invoke 引用**（IPC 全部经 opts 注入），收敛面确实只有 app.js 一个文件。

### 🟢 N12 —（第五轮）jsdom rAF 真实可用，P0-3d 特征测试可行性实证

`app-env.cjs:57` 有 `pretendToBeVisual: true` → jsdom 提供真实 `requestAnimationFrame`。`updatePreview` 内 4 处 rAF（含双重 rAF await）在测试中不会挂死——`render-extra.test.cjs:203` 已实证 `await ed.updatePreview()` 可正常完成。P0-3d 无需 stub rAF。

### 🟡 N13 —（第五轮）`defaultInvoke` 极简 + stub 注入链路与 tauri-api 天然兼容

`app-env.cjs:29` 的 `defaultInvoke` 只处理 `get_cli_args`/`app_data_dir`，**其余命令一律返回 `undefined`**（含 `generate_toc`）。两个推论：① P0-3d 的 TOC 分支测试必须传自定义 `invokeImpl` 返回 TOC 数据，不能靠默认 stub；② `tauriApi` 采用延迟求值（调用时读 `window.__TAURI__.core.invoke`）后，harness 的 `invokeImpl` 注入机制**零改动继续生效**——stub 替换的正是延迟求值读到的那个函数，捕获/断言链路不断。这消除了「P0-2b 后 28 个集成测试的 invoke 捕获全部失灵」的隐忧。

### 🔴 N14 —（第五轮）单文件直跑完全绕过产物防护（P0-0 缺第 5 层）

用户日常工作流是**单文件直跑**（`node test/render.test.cjs`，项目约定「只跑相关测试」），不经过 `run-tests.cjs` 也不触发 `pretest`。而 3 个依赖产物的测试都是模块顶层裸 `fs.readFileSync(unified-bundle.js)`——bundle 缺失时报一屏 ENOENT 堆栈，无修复指引。P0-0 的 a/b/c/d 四层全部覆盖不到这个入口 → 新增 **P0-0e**：抽公共 `test/helpers/load-bundle.cjs`，`existsSync` 失败时抛 `Error('产物缺失，请运行 npm run build:renderer')`，3 个测试改用之。

### 🔴 N15 —（第六轮）**入口脚本清单与测试自动加载不一致 → 「测试全绿、真机白屏」陷阱，正压在 P0-2 关键路径上**

两套加载机制根本不同，且**零校验**：

| 环境 | 机制 | 证据 |
|---|---|---|
| 生产 | `index.html:1072-1077` **显式 6 行 `<script>` 硬清单** | `grep -nE '<script' src/index.html` |
| 测试 | `app-env.cjs:141` `fs.readdirSync(modulesDir)` **自动加载目录下全部 .js** | `app-env.cjs:140-144` |
| 校验 | **不存在**——54 个测试文件中没有任何一个断言 index.html 的 script 清单 | `grep -rln index.html test/*.test.cjs \| xargs grep -ln script` → 空 |

**后果链**：P0-2a 建 `src/modules/tauri-api.js` 但漏加 `<script src="modules/tauri-api.js">` →
- 测试侧：readdir 自动捡到 → **54 个测试 100% 全绿**
- 生产侧：app.js 里 `tauriApi` 未定义 → **第一次 IPC 调用即崩，或直接白屏**

这是最恶劣的一类失效：**信号完全正确，系统完全坏掉**。而 P0-2 恰好就是"新增一个模块文件"的动作，命中概率极高。

> **对策（提到 P0-1，先于 P0-2a）**：`test/entry-scripts.test.cjs` —— 解析 `src/index.html`，断言 ①`src/modules/*.js` 与 `<script src="modules/...">` 集合**双向相等**；②所有 module script 位置在 `app.js` **之前**；③`src/lib/*.js`（`unified-bundle` / `md-links`）同样在清单内。
> 先写这条测试（此刻应通过），再建 tauri-api.js（测试立刻变红），加完 script 标签后转绿 —— **TDD 式护栏，把陷阱变成流程的一部分**。

### 🟠 N16 —（第六轮 · 原型实证）`_computePreviewWindow` 存在**真实潜伏缺陷**：NaN 焦点 → 预览空白且状态粘滞

把 `_isBlockStart` + `_computePreviewWindow` 原样拷到隔离环境跑 9 组场景，**S8 组暴露**：

```
computePreviewWindow(doc, undefined) → { start: NaN, end: NaN }
computePreviewWindow(doc, NaN)       → { start: NaN, end: NaN }
computePreviewWindow(null, 0)        → TypeError: Cannot read properties of null
```

**NaN 是真实可达的**，代码自己就承认这一点：

```js
// src/app.js:1758-1776（大纲点击跳转）
const line = parseInt(item.dataset.line, 10);
if (!isNaN(line)) {                 // ← 1761：编辑区跳转有 NaN 守卫
  this.cm.setCursor({ line, ch: 0 });
  ...
} else if (this.previewWindow) {
  this._previewFocusLine = line;    // ← 1776：**逃出守卫，NaN 直接写进状态**
  this.updatePreview();
}
```

再看消费侧 `app.js:6730`：`const focus = (this._previewFocusLine != null) ? this._previewFocusLine : 0;`
—— **`NaN != null` 为 true**，守卫放行 → `_computePreviewWindow(content, NaN)` → `{NaN, NaN}` → `lines.slice(NaN, NaN)` = `[]` → **预览空白**。

更糟的是**状态粘滞**：`_previewFocusLine` 被污染后一直是 NaN，直到下次赋值才恢复 → 表现为「大纲点了某项后预览一片空白，反复刷新也不回来」，且**极难复现**（依赖 `outline.js:58` 的 `data-line="${node.line}"` 在 `node.line` 为 undefined 时产出 `data-line="undefined"`）。

> **处置**：P0-3b 抽取时**顺带修复**（这正是"抽成纯函数"的价值兑现）——
> ① `computePreviewWindow` 入口加 `Number.isFinite(focusLine) ? focusLine : 0` + `content` 空值兜底；
> ② `app.js:1776` 改为在 `isNaN` 守卫内赋值；
> ③ `preview-window.test.cjs` 锁死 NaN/undefined/null/负数/越界 五种异常输入的返回值。

### 🟡 N17 —（第六轮 · 原型实证）末尾块边界扫描是 O(n²)，最坏 25ms/次

`_computePreviewWindow` 的 end 循环里每次迭代都重新 `lines.slice(start, end+1).join('\n').match(FENCE_RE)` —— **每次推进一行就把整个窗口（1200~1700 行）重新 join + 全局正则扫一遍**，最多 500 次。

| 场景 | 耗时 | 说明 |
|---|---|---|
| 正常文档（有空行） | **0ms** | 第一次就命中块边界 |
| 大文档零块边界（纯连续段落） | **26ms** | 跑满 500 次 guard |
| 巨型代码围栏内部（7000 行 fence） | **21ms** | 围栏奇偶始终不配对 |
| **连续 50 次调用（模拟持续输入）** | **1236ms** | ≈25ms/次，全部阻塞主线程 |

`updatePreview` 在输入时被 debounce 调用，最坏场景下每次预览刷新白送 25ms 主线程停顿。

> **处置**：**不在 P0 修**（属行为变更，需先有测试）。P0-3c 的单测先把**当前行为**锁死，P1 再做等价优化（增量维护 fence 计数而非重扫，O(n²)→O(n)）。列为 **P1-9**，有测试兜底后是安全改动。

### 🟡 N18 —（第六轮 · 原型实证）实际窗口行数可达 **2200**，是名义 `PREVIEW_WINDOW_LINES=1200` 的 **1.83 倍**

start 回退最多 500 行、end 后移最多 500 行，叠加后窗口上限是 `1200+500+500=2200`。实测 S2/S6 均返回 2200 行窗口。

这是个**未文档化的不变量**，直接影响大文档渲染耗时预期。P0-3c 必须把它写成断言（`end-start ≤ windowLines + 2*guard`），否则将来有人调 guard 上限会无声改变性能特征。

> 顺带纠正方案 P0-3c 原写的断言「`end-start ≤ windowLines`」是**错的**，实测不成立。

### 🟢 N19 —（第六轮 · 原型实证）纯函数性获得**实测确认**（此前仅为 grep 推断）

S7 组：同输入两次调用结果完全一致（幂等），入参字符串引用未被修改。S1/S4/S5 边界（小文档直通、焦点末尾、焦点 0）行为符合预期。

**含义**：ADR-2 的 P0-3b「零风险抽取」从"读代码推断"升级为"隔离环境实测"。抽取本身可以放心做，唯一要带上的是 N16 的 NaN 修复。

### 🔴 N20 —（第六轮）**项目无 CI、无 ESLint**，方案的强制机制需要重新落地

| 检查项 | 结果 |
|---|---|
| `.github/workflows/` | **不存在** |
| `.gitlab-ci.yml` / 其它流水线 | 不存在（`.gitee/` 下只有 issue 模板） |
| ESLint 配置 / lint 脚本 | **全部不存在** |

方案里出现 8 次「CI」作为护栏承载体（全量测试、耦合预算硬卡、契约漂移暴露、cargo test、check-globals）。**这些今天全部无处安放。**

> **对策**：护栏全部**先做成本地可执行的 npm script**（`npm run check` 聚合 `check-globals` + `coupling-report` + 契约测试），提交前手动跑；**CI 单列为 P1-8**，作为显式工作项而非隐含假设。ESLint 若要引入是**独立决策**（新增依赖 + 配置 + 存量告警治理），不塞进 P2-4 的脚注 —— 当前用 `check-globals.cjs` 这类小脚本即可满足需求，**不引入 ESLint**（YAGNI）。

---

### 🔴 N21 —（第七轮）**IPC 包装层若不是「透明透传」，会把全部文件错误静默降级为 `E_IO`，而现有测试查不出来**

这是本轮最危险的发现，因为它**符合直觉的写法恰好是错的**。

P0-2a 原文写 tauri-api 要做「延迟求值 + 守卫 + **参数校验**」。但错误链路是这样的：

```js
// app.js:1381 —— 原始 reject 值被直接送进映射器
raw = await invoke('read_file', { path });
} catch (e) { throw this._mapReadFileError(e, path); }

// app.js:7098 _mapReadFileError —— 它要的是【Rust 原样返回的 JSON 字符串】
const raw = typeof e === 'string' ? e : (e && e.message ? e.message : null);
const obj = raw ? JSON.parse(raw) : null;
if (obj && obj.kind) kind = obj.kind;      // NotFound / PermissionDenied / Locked / ...
```

只要 tauri-api 做了**任何一种**常见"好心"处理，`JSON.parse` 就失败：

| 常见写法 | 结果 |
|---|---|
| `catch (e) { throw new Error('[read_file] ' + e) }` | message 变成 `[read_file] {"kind":...}` → parse 失败 |
| `catch (e) { throw new TauriError(cmd, e) }` | message 非 JSON → parse 失败 |
| 参数校验 `if (!path) throw new Error('path required')` | 抛的根本不是 Rust 错误 |

失败后走 `catch(_){}` → `kind='Io'` → **所有文件错误一律变成 `E_IO`**：文件不存在、权限拒绝、被占用、路径过长、编码错误 —— 五种精准提示塌缩成一条"IO 错误"。**用户可见的功能退化，且完全静默。**

**而现有测试抓不到**：`error-handling.test.cjs:38/50` 是**直接调用 `_mapReadFileError(rawString)`**，绕开了 invoke 这一层。包装层怎么改它都绿。

> **对策（硬约束写进 ADR-1）**：P0-2 的 tauri-api **必须是语义空操作** —— resolve 值原样返回、**reject 值原样抛出**、不 try/catch、不包装、**不做会抛异常的参数校验**。守卫只允许一种：`window.__TAURI__` 缺失时抛明确错误（这条路径下本来也没有 Rust 错误可保）。参数校验、错误分类等增强留到 P1-5 之后，**且必须单独一步、单独测试**。
> 配套新增用例 **C16**：让 stub 的 invoke reject 一个 Rust 形态字符串 `'{"kind":"NotFound","path":"x"}'`，断言经 `tauriApi.readFile` 后仍能映射出 `E_NOT_FOUND`。这条是 P0-2b 的**验收门**。

### 🟠 N22 —（第七轮）`_previewFocusLine` 有 **8 个写入点、2 个读取点**，方案只盯了 1 个写入点；且 `Math.max/min` 夹逼对 NaN 是**透明的**

上一轮只分析了 `app.js:1776`。全量扫描后的真实分布：

| 行 | 写入源 | 是否可能非有限数 |
|---|---|---|
| 780 / 2988 / 5374 | `= 0` | 否 |
| 2839 | `cm.getCursor().line` | 否 |
| 4484 | `Math.max(0, line - 1)`，`line` 来自 Rust `search_in_files` 的 `m.line` | 否（serde 数字） |
| **1776** | `parseInt(dataset.line, 10)`，**逃出 1761 的 `!isNaN` 守卫** | **结构上是** |
| **6465** | `Math.max(0, Math.min(focus, lineCount-1))` | **夹逼无效**：`Math.min(NaN,n)=NaN`、`Math.max(0,NaN)=NaN` |
| 6698 | `Math.max(0, Math.min(n, Math.round(scrollTop/avg2)))`，`avg2 = this._avgLineHeight \|\| 22` | 否（`NaN` 为假值，被 `\|\| 22` 兜住） |

读取点两个，方案只提了一个：`6730`（→ `_computePreviewWindow`）和 **`6839`（→ `_focusPreviewToLine`）**。

**结论**：「逐个补写入点」是错误策略 —— 写入点会随功能增加，6465 那种**看起来已经夹逼过、实际对 NaN 透明**的写法尤其容易骗过 review。

> **对策（修订 ADR-2）**：归一化点放在**读取侧 + 模块入口**这两道，覆盖全部现在与将来的写入点：
> ① `computePreviewWindow` 入口 `Number.isFinite(focusLine) ? focusLine : 0`（模块自防御）；
> ② `app.js:6730` 的 `!= null` 改为 `Number.isFinite(...)`；③ `6839` 同样归一化；
> ④ `1776` 仍然要改（不投毒是卫生问题），但它**不再是修复的承重点**。
> 另：`cross-search-jump.test.cjs:92` 断言 `_previewFocusLine === 49`，归一化不能改变有限数的取值 —— 用 `Number.isFinite` 而非 `|| 0`（后者会把合法的 `0` 也换掉，虽结果相同但语义错）。

### 🟢 N23 —（第七轮）`_isBlockStart` **零外部调用**、`_computePreviewWindow` **单一调用点**、测试**零引用** → P0-3b 比方案设想的更简单

| 符号 | 全仓库引用 |
|---|---|
| `_isBlockStart` | 定义 6585 + **仅在 `_computePreviewWindow` 内部被调 2 次**（6604 / 6612） |
| `_computePreviewWindow` | 定义 6592 + **仅 6731 一处调用** |
| 两者在 `test/*.test.cjs` | **零引用** |

**含义**：`_isBlockStart` 可以**整个搬走、不在类上保留任何形式**；`_computePreviewWindow` 也不需要"薄委托"，直接把 6731 改成 `PreviewWindow.computePreviewWindow(...)` 即可。方案原写的"`app.js` 保留薄委托"是多余的兼容层 —— **少写一层就少一处可能不同步的语义**。

### 🔴 N24 —（第七轮）`entry-scripts.test.cjs` 的朴素实现**必然误报**：`src/lib/highlight.js` 是**目录**，且 index.html 共有 **33 个 script**

方案 P0-1 写「断言 `src/lib/*.js` 也在清单内」。实测：

```
src/lib/  →  codemirror/  highlight.js/  katex/  mermaid/       ← 目录（注意第二个）
             html2canvas.min.js  markdown-it.min.js  md-links.js  unified-bundle.js   ← 文件
```

**`src/lib/highlight.js` 是一个目录，名字以 `.js` 结尾。** 任何 `readdirSync(lib).filter(f => f.endsWith('.js'))` 都会把它当文件，然后断言 index.html 必须有 `<script src="lib/highlight.js">` —— 而真实标签是 `lib/highlight.js/highlight.min.js` → **测试一写出来就是红的，且红得莫名其妙**。

同时 index.html 的 script 分两簇，共 33 条：**367-393 的 27 条 vendor**（codemirror 21 条 + highlight/katex×2/mermaid/html2canvas/markdown-it）+ **1070-1078 的 6 条**（unified-bundle、md-links、6 模块、app.js）。

> **对策（entry-scripts 实现规范，写进 P0-1）**：
> ① 枚举必须 `statSync(...).isFile()` 过滤，**不能只看后缀**；
> ② **双向相等只对 `src/modules/` 生效**（这是"新增模块"的高频动作，也是 N15 的命中面）；
> ③ 对 `src/lib/` **只做单向包含**（`unified-bundle.js` / `md-links.js` 必须在清单内），**不做反向**（vendor 目录里几百个 js 显然不该全进 index.html）；
> ④ 顺序断言只针对这 8 条业务 script（modules + lib 两个 + app.js），**不牵扯 27 条 vendor**。

### 🟡 N25 —（第七轮）index.html 的模块顺序与 harness 字典序**今天就已经不同**，N5 说的不是未来风险

| 位次 | index.html（生产） | harness `readdirSync`（测试） |
|---|---|---|
| 1 | code-block | code-block |
| 2 | **preview-post** | dialogs |
| 3 | word-count | find-replace |
| 4 | outline | outline |
| 5 | dialogs | **preview-post** |
| 6 | find-replace | word-count |

`preview-post` 生产第 2 位、测试第 5 位。今天各模块互不引用所以无害，但这意味着 **"顺序一致"从来就没有成立过**，`entry-scripts.test.cjs` 只能断言"集合相等 + 都在 app.js 之前"，**不能断言顺序一致**（会立刻红）。而真正的防线只能是 N5 的那条：**任何新模块都必须做成加载顺序不敏感**（延迟求值 / 不在顶层读别的模块）。这条要写进 ARCHITECTURE.md 而不是靠测试。

### 🟡 N26 —（第七轮）加了 `pretest` 之后，P0-0b 在 `npm test` 路径上变成**死代码**；真正暴露的入口只剩两个

`build-renderer.mjs` 实测 **0.52s**（esbuild 83ms + node 启动），成本可忽略 —— `pretest` 值得加。但加了之后：

```
npm test → pretest 重建 bundle（必然存在）→ run-tests.cjs 的 existsSync 检查【永远为真】
```

P0-0b 只在 `node scripts/run-tests.cjs` 直跑时才有意义。**产物缺失的真实暴露面收敛为两个**：① 单文件直跑（P0-0e 覆盖）；② 应用本身（P0-0c/d 覆盖）。

另有一个**新引入的副作用**必须接受：`pretest` 会让 `src/unified-renderer.js` 存在语法错误时 **`npm test` 一个测试都跑不了**（build 失败即中止）。这是 fail-fast，可接受，但要知道 —— 改渲染器改到一半想跑无关测试时，得走单文件直跑。

> **对策**：P0-0b **保留但降级为"直跑运行器时的兜底"**，不再作为主防线；同时新增 **P0-0f：给 `run-tests.cjs` 加 argv 过滤**（见 R7），让"只跑相关测试"这个日常动作重新走进有守护的入口。

### 🟡 N27 —（第七轮）契约测试必须解析 **`generate_handler!` 列表**，不能扫 `#[tauri::command]`

`src-tauri/src/lib.rs` 里 **`#[tauri::command]` 有 21 个**，`generate_handler!` 只注册 **20 个** —— 差的那个正是 N2 的僵尸 `render_markdown`。若契约测试按属性宏统计，会**恒定报出 1 个差集**，然后被人加进白名单，白名单又会掩盖将来真正的漂移。

另确认：全文件**只有 1 处 `invoke_handler`**（`lib.rs:1649`），不存在第二套注册。解析范围明确。

### 🟢 N28 —（第七轮）46 处 invoke **全部是字面量单引号命令名**，零动态构造，实证收口

`grep -oE "invoke\(\s*'[^']+'"` 抽出的命令名频次合计 **恰好 46**，与 `grep -c "invoke("` 的 46 **完全相等** → 不存在变量命令名、模板串命令名、跨行命令名。去重后 **20 自定义 + 6 plugin = 26**，与 Rust 侧 20 命令**逐字匹配**。

高频前三：`fetch_image_as_base64`×8、`write_file`×5、`read_file`/`file_meta` 各×3。这三个也正是 P0-2b 出错时**爆炸半径最大**的（图片渲染 / 保存 / 打开）。

### 🟡 N29 —（第七轮）双导出必须沿用 `typeof module === 'undefined'` **互斥式**，且契约测试需要一个**静态 `COMMANDS`**

现有 6 个模块统一是这个形状：

```js
if (typeof window !== 'undefined' && typeof module === 'undefined') { window.Xxx = ...; }
if (typeof module !== 'undefined' && module.exports) { module.exports = ...; }
```

`w.eval()` 进 jsdom 时 `module` 未定义 → 走 window 分支；`require()` 进 Node 时走 exports 分支。**若 tauri-api.js 漏掉 `typeof module === 'undefined'` 这半个条件**，在 `buildEnv` 之后再 `require` 该模块会同时写 `global.window.tauriApi`，污染下一个测试的全局 —— 这类污染正是 `run-tests.cjs` 注释里描述过的"漂移式间歇失败"。

第二点：契约测试在**纯 Node** 里 `require('src/modules/tauri-api.js')`，此时 `window` 不存在。若命令集合只能通过"枚举对象上的方法名再反推 snake_case"得到，就得触碰 window 或做脆弱的字符串还原。

> **对策（写进 ADR-1）**：模块内以**一个 `COMMANDS` 数组为唯一真源**，方法由它生成（`read_bundled_image_as_base64` → `readBundledImageAsBase64`），`COMMANDS` 一并导出。契约测试直接 `assert.deepEqual(new Set(COMMANDS), new Set(parseHandler(lib.rs)))` —— 零 window 依赖、零字符串反推，且**从根上杜绝命令名拼写错误**（拼错就是契约测试红，不是运行时红）。plugin 类 6 个走单独的手写方法（`updater.download` 要建 Channel），**不进 COMMANDS**，契约测试也不比对它们。

### 🟡 N30 —（第七轮）P0-2b 会让 app.js **行号整体上移约 4 行**，方案里的行号锚点在那之后全部失效

P0-2b 要**删掉 4 处 invoke 绑定声明**（`app.js:1` + 7694 / 7766 / 7798）。46 处调用是 1:1 文本替换（行数不变），但这 4 行是净删除 → `app.js:1` 之后的所有行号 −1，7694 之后再 −1…… 

而方案在 P0-2b **之后**才执行 P0-3b/c，那一步依赖的锚点是 **6585 / 6592 / 6730 / 6731 / 1776 / 6465 / 6839** —— 其中除 1776 外全在 `app.js:1` 之后，**届时至少偏移 1 行**，若 7694 前还有删除则更多。

> **对策**：① 本文所有行号从此视为**「HEAD=2165504 时的快照坐标」**，执行时一律用**符号名/代码片段**定位（`grep -n '_computePreviewWindow('`），不用行号；② 里程碑表里为 P0-3b 增加一步"**执行前重新定位锚点**"；③ 或者把 P0-3b/c 提到 P0-2b **之前**做（它只碰 6585-6618 + 6730 附近，与 IPC 收敛零重叠）—— **本轮采纳后者**，见 §10 执行顺序调整。

### 🟡 N31 —（第七轮）P0-3b 里夹带的「4 空格缩进改 2 空格」是**不该混进来的改动**

`updatePreview`（6704 起）确认是 4 空格缩进，全方法约 190 行。方案 P0-3b 写「顺带把缩进修正为 2 空格」。

这会让**一次行为抽取的 commit 变成 190 行全红全绿的 diff** —— review 时人眼无法区分"哪几行是真改动"，回滚时也无法只回滚抽取部分。而抽取恰恰是本方案里**最需要被仔细 review** 的一步。

> **对策**：缩进整理**从 P0-3b 移除**，降级为 P2 的独立 commit（纯格式、零行为、可用 `git diff -w` 自证空 diff）。**永远不要把格式化和语义改动放进同一个 commit** —— 这不是洁癖，是保住 review 与回滚能力的成本最低的做法。

### 🟡 N32 —（第八轮）「plugin 命令」与「非 core 命名空间」边界必须显式拆清，否则执行者会漏收 plugin 而删崩 updater

N30 要求 P0-2b 删除 4 处 `invoke` 绑定声明（`app.js:1` + `7694/7766/7798`）。其中 `7694/7766/7798` **仅服务于 `plugin:updater|check/download/install`** 三个调用（已用 `grep` 实证：`7695` 用 7694 绑定、`7783` 用 7766 绑定、`7799` 用 7798 绑定）。若执行者把「plugin 命令」误读为 ADR-1「非 core 留 P1-5」里的"非 core"，就会在 P0-2b **跳过这 3 个 plugin 替换、却照删 7694/7766/7798** → updater 三方法 `ReferenceError: invoke is not defined`，且因 updater 仅手动触发、54 个自动化测试不覆盖它，**退化静默上线**。

本轮回查已厘清事实分布（全部 grep 实证）：
- `core.invoke` 调用 **46 处**（已用 `grep -c "invoke("` = 46 双重核验，与 N10/N28/现状表一致）= **39 处自定义命令 + 7 处 `plugin:*`**（dialog×2 / updater×3 / **webview×2** —— 3530 与 7617 两处直接 `window.__TAURI__.core.invoke` 也属 `plugin:webview`，计在这 7 内）；**全部经 `core.invoke`，均属 P0-2b 收敛范围**（plugin 本质是 core.invoke，不是「非 core」）。
- 真正推迟到 P1-5 的是**非 invoke** 命名空间：`shell.open`/`event.listen`×7/`app.getVersion`×4/`window.getCurrentWindow`/`path.resourceDir`，共 **~20 处**（口径见现状表，含/不含 `core.Channel` 不影响「零交集」结论），与 P0-2b 的 46 处 invoke **零交集**。

> **对策（已写进 ADR-1 分期 / P0-2b）**：`plugin:*` 调用本质就是 `core.invoke`，属 P0-2b 收敛范围，替换为 `tauriApi.updater.*` / `dialog.*` / `webview.*` 手写方法；P1-5 只收 `shell/event/app/window/path`。两条清单互斥。验收门加一条：`grep -nE "invoke\('plugin:" src/app.js` 在 P0-2b 后应只剩 0 处（且 `dialogOpen`/`dialogSave` 这种顶部 `async function` 内调用已改 `tauriApi.dialogOpen()`）。

### 🟡 N33 —（第九轮）渲染代际检查点实为 **14 处**（非 17），且 `_mermaidGeneration` 守卫是 P0-3a 原测试覆盖不到的独立竞态点

第九轮实查 `app.js`：`this._renderGeneration`（772）与 `this._mermaidGeneration`（773）是**两个独立**代际变量。

- `_renderGeneration` 比较检查 **13 处**：`updatePreview` 内 8（6749/6759/6801/6816/6830/6842/6884/6887）、`processImages` 内 4（6938/6954/6965/6982）、`_focusPreviewToLine` 内 1（6898）；自增 1 次（6712）。
- `_mermaidGeneration` 比较检查 **1 处**：自增（2079）→ 比较（2114 `if (this._mermaidGeneration !== gen) return;`）。

方案此前写「17 处」为**虚数**（上轮自称"updatePreview 9 + processImages 7 = 17"，但 updatePreview 实为 8、processImages 实为 4，且漏算 mermaid 的 1）。

> **对策**：① P0-3a 的计数全部改 **14**；② **关键**：P0-3a 原描述「用可控 renderer stub 让第一次 `updatePreview` 挂起」只覆盖 `_renderGeneration` 路径，**完全碰不到 `_mermaidGeneration`**（2114 在 mermaid 渲染函数内，与 updatePreview 的挂起无关）。必须在 P0-3a 增一条**独立用例**：触发 mermaid 并发重渲染、断言旧 gen 的回调被 2114 拦掉。否则 mermaid 这条竞态守卫在「零覆盖 → 抽取」前仍是裸的，抽取时一旦改到 2079/2114 周边就会无声退化。

---

## 2. 已验证现状（HEAD=2165504）

| 维度 | 事实 | 证据 |
|---|---|---|
| app.js 体量 | **8698 行** / 448 `getElementById` / 32 行 `window.__TAURI__` | `wc -l`、`grep -c` |
| 核心编排 | `updatePreview` @ **6704**，**4 空格缩进**（异于其余 2 缩进），按 `^  方法名(` 的 grep 会漏 | `grep -nE '^\s*(async\s+)?updatePreview'` |
| 编排链 | 虚拟窗口切片 → `generate_toc` → `UnifiedRenderer.renderMarkdown` → TOC 注入 → base64→BlobURL → `data-source-line` 偏移还原 → 窗口块渲染 → `processImages` → PreviewPost×6 → `CodeBlock` → 滚动同步 | 通读 6704-6895 |
| **代际竞态** | `_renderGeneration` 比较 **13 处**（updatePreview 8 + processImages 4 + `_focusPreviewToLine` 1）+ `_mermaidGeneration` 比较 **1 处**（2114），**全文 14 处**（非 17，见 N33/行 39 修正），`gen !== this._renderGeneration` / `_mermaidGeneration !== gen`，**零测试** | N33 实查（`grep -n` 逐点核对 6712/6749/…/6982 与 2079/2114） |
| 虚拟窗口 | 7 个方法，**仅前 2 个是纯的**（见 N7 表） | 逐方法边界核实 |
| `processImages` | 6896-6991；依赖 5 项：`preview`/`activeTab(.isBundled)`/`_imageBase64Cache`/`getCachedImageURL`/`_renderGeneration`；IPC 2 个 | 依赖去重 |
| 模块解耦 | 6 模块零 app 耦合；导出是**缩进的** `  window.Xxx =`（在 if 块内），非行首 | 各文件命中 1 行 |
| IPC 前端 | 46 处 `invoke`；直接调用 3530/7617；**4 处绑定声明**：`app.js:1` + 7694/7766/7798（7766 含 `Channel`） | `grep -nE 'const \{[^}]*invoke'` |
| **IPC 后端** | `generate_handler!` 注册 **20 命令**，与前端**零差集**；`render_markdown` 定义未注册（`#[allow(dead_code)]`） | `awk '/generate_handler!\[/,/\]/'` + `comm` |
| 非 core 命名空间 | ~20 处：`shell.open` / `event.listen`×7 / `app.getVersion`×4 / `window.getCurrentWindow`×6 / `path.resourceDir` / `core.Channel` | 32 行 `__TAURI__` 全量 |
| harness stub | 有 `core.invoke`/`event.listen`/`window.getCurrentWindow`/`path.resourceDir`/`shell.open`；**缺 `app.getVersion`、`core.Channel`** | `app-env.cjs:106-127` |
| harness 加载 | 只 eval `src/modules/*.js`，**字典序**，`catch(_){}` **静默吞异常** | `app-env.cjs:140-144` |
| 测试规模 | 根目录 **55 个** `.test.cjs`（运行器只扫这层）；`test/browser/` **已删除**（其内 code-block-brackets 僵尸冗余于 `code-block.test.cjs`，本轮回测后删除）；`csp-check.cjs` **已重建为 `csp-check.test.cjs` 并纳入主套件**（不再依赖 `src/tauri-mock.js`/私有 `ws`，纯 node 静态守卫，本轮回测通过）；**Rust 测试从不执行** | `find` + `run-tests.cjs:19` + 本轮回测 |
| **入口脚本清单** | index.html 共 **33 个 script**：367-393 的 **27 条 vendor** + 1070-1078 的 unified-bundle / md-links / **6 模块硬清单** / app.js；harness 用 `readdirSync` **自动加载**；**两者无任何一致性校验** | `grep -nE '<script'` + `app-env.cjs:141` |
| **加载顺序** | 生产与测试顺序**今天就已不同**（preview-post 生产第 2 / 测试第 5） | 两份清单逐位比对 |
| **`src/lib/` 结构** | 4 个顶层 `.js` 文件 + 4 个目录，**其中 `highlight.js` 是目录** | `ls src/lib/` |
| **工程护栏** | **无 CI**（`.github` 不存在）、**无 ESLint**（无配置无脚本） | `ls -d .github`、`ls .eslintrc*` |
| **测试运行器** | `run-tests.cjs` **不读 `process.argv`**（无过滤能力）、不递归、单文件独立进程 + `--test-concurrency=1`、单文件 120s 超时 | 通读全文件 |
| 构建治理 | `build:renderer` + `prepare` 均指向 `scripts/build-renderer.mjs`（实测 **0.52s**）；`dev`/`build` 前置，**`test` 无前置**；无 `check` 脚本（P0 可安全占用该名字） | package.json + 实测 |
| vendor | `src/lib/` 手工副本 6 个包，**全在 `dependencies`** → 可从 node_modules 还原 | `ls src/lib/` |
| **模块导出形状** | 6 模块统一 `if (window!==undefined && module===undefined) window.Xxx=` / `if (module...) module.exports=` **互斥双分支** | 各文件尾部 |
| **IPC 调用形态** | 46 处 invoke **全部字面量单引号命令名**（频次合计恰为 46，无动态构造）；去重 20 自定义 + 6 plugin | `grep -oE` 频次求和 |
| **Rust 命令** | `#[tauri::command]` **21 个** vs `generate_handler!` 注册 **20 个**（差 `render_markdown`）；全文件仅 1 处 `invoke_handler` | `grep -c` + `awk` |
| **错误链路** | `_mapReadFileError`（7098）依赖 **invoke 原始 reject 字符串是 Rust JSON**；`error-handling.test.cjs` 直测该函数、**绕过 invoke** | 通读 1381/7098 + 测试 |
| **焦点状态** | `_previewFocusLine`：**8 写 2 读**；6465 的 `Math.max/min` 夹逼对 NaN 透明 | 全量 grep + 逐点判定 |
| **大纲 data-line** | `extractHeadings` 恒写 `line: i`（数字），`.outline-item` **唯一生产者**是 `renderOutlineHtml` → **今日 NaN 不可达** | outline.js:9-58 + app.js 三处引用 |
| **窗口算法实测** | 纯函数✅幂等✅；NaN 焦点 → `{NaN,NaN}`（**结构性可能，非今日可达**）；最坏 25ms/次；**实际窗口上限 2200 行**（非 1200） | 隔离环境 9 组场景实跑 |
| **抽取面** | `_isBlockStart` 零外部调用、`_computePreviewWindow` 单一调用点（6731）、两者测试零引用 | 全量 grep |

---

## 3. 架构决策记录（ADR）

### ADR-1：IPC 收敛到 `src/modules/tauri-api.js`，并用 Rust 侧反向锁定契约
- **Status**：Accepted（本轮强化：新增契约测试）
- **Context**：46 处裸字符串散落 app.js；harness 只自动加载 `src/modules/`；前后端仅靠字符串约定（虽然当前对齐，但无机制保证不漂移）。
- **Decision**：
  1. 建 `src/modules/tauri-api.js`，双导出，**必须沿用现有互斥式** `typeof window !== 'undefined' && typeof module === 'undefined'`（N29 —— 漏掉后半个条件会造成跨测试全局污染）。
  2. **延迟求值**：每次调用时读 `window.__TAURI__`，不在模块顶层快照 —— 这同时解决 N4（顶层解构白屏）与 N5/N25（加载顺序敏感）。
  3. **🔴 语义空操作（N21，硬约束）**：resolve 值原样返回、**reject 值原样抛出**；**不 try/catch、不包装错误、不做会抛异常的参数校验**。唯一允许的守卫是 `window.__TAURI__` 缺失时抛明确错误。理由：`_mapReadFileError` 依赖 Rust 原始 JSON 字符串，任何包装都会把 5 类文件错误静默塌缩成 `E_IO`，且现有测试查不出来。增强留到 P1-5 之后单独一步。
  4. **单一真源 `COMMANDS` 数组（N29）**：20 个自定义命令写成数组，方法由它生成（snake_case → camelCase），`COMMANDS` 一并导出。契约测试在纯 Node 里 `require` 后直接比对集合，零 window 依赖，且命令名拼错立即变成契约测试红。
  5. **契约测试**：`tauri-api.test.cjs` 解析 `lib.rs` 的 **`generate_handler!` 块**（**不能扫 `#[tauri::command]`** —— 21 vs 20，差的是僵尸 `render_markdown`，见 N27），断言 `COMMANDS` == Rust 注册集合。解析失败必须**显式报错**，不得静默通过。
  6. plugin 类 6 个走**手写方法、不进 COMMANDS**、契约测试不比对。`plugin:updater|download` 需 `new Channel()` → 做成 `updater.download(rid, onEvent)`，内部自建 Channel。
  7. **（N15）必须同步 `index.html` 脚本清单**，并由 `entry-scripts.test.cjs` 强制 —— 否则测试全绿而真机白屏。
- **分期**：P0 只收敛 `core.invoke`（**含 6 个 `plugin:*` 命令** —— 它们本质就是 `core.invoke`，P0-2b 一并替换为 `tauriApi.updater.*` / `dialog.*` / `webview.*` 手写方法，见 ADR-1 决策 1/6）；**仅 `shell/event/app/window/path` 等非 invoke 命名空间（~16 处）推迟到 P1-5**。两条清单互斥、无交集 —— 不要混淆：「非 core」一律改为「非 invoke 命名空间」。被 N30 删除的 `7694/7766/7798` 绑定正是 3 个 `plugin:updater|*` 调用所用，plugin 收掉后删除安全（N32）。
- **Consequences**：+ 改名只改一处、测试只 mock 一个模块、契约漂移自动暴露、命令名拼写错误编译期化；− 需机械替换 46 处 + 删 4 处绑定声明 + 改 index.html；− 生成式方法意味着 P0 阶段**没有**逐命令的参数类型提示（明确接受，见 §7）。

### ADR-2：虚拟窗口**只抽两个纯函数**，其余留待 Strangler（**本轮纠正 R1**）
- **Status**：Accepted（修订：抽取范围从 3 个收窄到 2 个）
- **Context**：见 N7。`_renderPreviewWindowBlock` 及其后的方法读写 DOM/状态，`_syncPreviewVirtualScroll` 还在定时器里回调 `updatePreview` —— 强行"纯化"会制造循环依赖。
- **Decision**：`src/modules/preview-window.js` 只暴露两个纯函数：
  ```js
  isBlockStart(line) -> boolean
  computePreviewWindow(content, focusLine, { maxLines, windowLines, lead }) -> { start, end }
  ```
  常量由参数注入（不从模块内读全局）。其余 5 个方法**原地不动**，等 P2-1 随 `PreviewController` 整体迁移。
- **前置**：**抽取前先补代际竞态测试**（P0-3a）作为安全网。
- **本轮修订一（N23）——不保留薄委托**：`_isBlockStart` 零外部调用 → **整个搬走，类上不留**；`_computePreviewWindow` 仅 6731 一处调用 → **直接改调用点**，不设兼容层。少一层就少一处会不同步的语义。
- **本轮修订二（N22/R6）——归一化点从"写入侧"改到"读取侧 + 模块入口"**：`_previewFocusLine` 有 8 个写入点，其中 6465 那种 `Math.max(0, Math.min(...))` 对 NaN **完全透明**，逐点补写不可持续。正确做法是两道防线：① 模块入口 `Number.isFinite(focusLine) ? focusLine : 0` + `(content || '')`；② 两个读取点（6730 的 `!= null`、6839 的裸传）统一改 `Number.isFinite`。`1776` 仍然要改（不投毒是卫生问题），但**不再是承重点**。
  - ⚠️ 用 `Number.isFinite` 判定，**不要用 `|| 0`** —— 后者会把合法的 `0` 也替换掉，结果虽同但语义错，且会让 `cross-search-jump.test.cjs:92` 那类"焦点值精确断言"变得难以推理。
- **本轮修订三（N31）——不夹带缩进整理**：`updatePreview` 的 4 空格→2 空格是 190 行的纯格式 diff，混进抽取 commit 会摧毁 review 与回滚能力。移到 P2 独立 commit。
- **定性修订（R6）**：N16 的 NaN 在**今天不可达**（`outline.js` 恒产出数字 `data-line`，且 `.outline-item` 唯一生产者）。因此本项是**消除结构性脆弱**，不是修复线上缺陷；C14 的 app 层用例必须写成**防御性注入**（手工构造 `data-line="undefined"` 的节点触发点击），不要试图复现真实场景。
- **Consequences**：+ 罩住最易错算法（块边界/围栏奇偶/guard 上限）+ 关掉一整类"NaN 穿透夹逼"的隐患；− 虚拟窗口的 DOM 部分仍无单测，只能靠特征测试间接覆盖。

### ADR-7（新增）：护栏先落地为本地 npm script，CI 单列为显式工作项（**本轮纠正 R4**）
- **Status**：Accepted
- **Context**：见 N20。方案原先 8 处把强制机制挂在 CI 上，但项目**没有 CI、没有 ESLint**。护栏挂在不存在的东西上 = 没有护栏。
- **Decision**：
  1. 所有守护脚本（`check-globals` / `coupling-report` / `tauri-api` 契约 / `entry-scripts`）**首先做成本地可执行**，聚合为 `npm run check`，提交前手动跑；
  2. **CI 单列为 P1-8**（GitHub Actions：`npm ci` → `npm run check` → `npm test` → 可选 `cargo test`），作为显式工作项排期，而非隐含假设；
  3. **不引入 ESLint**（YAGNI）—— 当前需求（禁止裸 `window.Xxx=`、检测 invoke 残留）用几十行的 `check-globals.cjs` 即可满足，引入 ESLint 意味着新依赖 + 配置 + 存量告警治理，成本不成比例。
- **Consequences**：+ 护栏立刻可用、不依赖尚不存在的基础设施；− 本地执行靠自觉，直到 P1-8 落地才有强制力（可选：接 `pre-commit` 钩子，但**只跑改动相关**，符合既有约定）。

### ADR-3：上帝对象拆分走 Strangler Fig，禁止 big-bang
- **Status**：Accepted
- **Decision**：建 `PreviewController` facade 包住 `updatePreview` + `processImages` + 后处理编排 + N7 表中留下的 5 个虚拟窗口方法；旧调用点逐批迁移，迁移期 `this.updatePreview` 保留薄委托，全迁完再删。
- **约束**：facade 必须**原样承接代际语义**（`_renderGeneration` 归属谁、谁负责提前返回），每批迁移都跑竞态测试。

### ADR-4：ESM 仅用于 release 打包，dev 保持源码即运行
- **Status**：Accepted（N8 确认 CSP 无阻碍）
- **Decision**：`scripts/build-frontend.mjs`（esbuild）仅用于 release 输出 `dist/`；dev 与日常调试仍走 `src/`。打包后若不再需要 `unsafe-eval`，从 CSP 移除。

### ADR-5：构建产物「缺失即可见」，而非静默降级
- **Status**：Accepted
- **Context**：`unified-bundle.js` 已是 gitignore 产物（`5f5b23e`）。上一轮拉取时它缺失，导致预览失效 + 3 个测试 ENOENT，而代码里**没有任何一处检测或提示**。
- **Decision**：三层兜底 —— ①`pretest` + `run-tests.cjs` 启动检查，缺失则打印修复命令并非零退出；②`index.html` 该 script 加 `onerror` 显示可操作错误条；③`app.js` 调用 `UnifiedRenderer` 前做存在性断言，抛带指引的明确错误。

### ADR-6（新增）：Rust 侧僵尸渲染实现予以退役
- **Status**：Proposed（P1-7 执行，**不阻塞 P0**）
- **Context**：见 N2。`render_markdown` 及其渲染链、8 个 XSS 测试永不被调用，但仍在编译、仍在被"维护"。前端 `unified-renderer.js` 是唯一渲染路径。
- **Decision**：确认无调用后删除 `render_markdown` 命令及其专属辅助函数；其 XSS 用例的**语义价值迁移到前端** —— 在 `render.test.cjs` 补等价的 sanitize 断言（`unified-renderer.js` 的 sanitize schema 才是今天真正的安全边界）。
- **Consequences**：+ 消除"改错地方"的认知陷阱、减少编译面；− Rust 侧 diff 较大，需确认无外部依赖。**因此排在 P1 而非 P0。**

---

## 4. 可执行路线图

> 测试政策：**本地只跑改动相关文件**（符合既有约定）。⚠️ **纠正（R7）**：`run-tests.cjs` **没有过滤能力**（不读 argv），今天的"只跑相关"实际是绕过运行器直跑单文件 —— 也就绕过了全部前置守护。故新增 **P0-0f** 给运行器加 argv 过滤，把日常入口拉回守护之内。全量测试在 **P1-8 建成 CI 之前**只能靠手动 `npm test`，**不设自动全量**（见 ADR-7 / N20）。
>
> ⚠️ **行号约定（N30）**：本文所有行号是 `HEAD=2165504` 的**快照坐标**。P0-2b 会净删 4 行导致其后行号整体上移，执行时**一律用符号名/代码片段定位**，不得直接跳行号。

### 🔴 P0-0 构建产物韧性

| 步骤 | 改动 | 验证 |
|---|---|---|
| a | `package.json` 加 `"pretest": "node scripts/build-renderer.mjs"`（实测 **0.52s**，成本可忽略） | `npm test` 前自动重建 |
| b | `run-tests.cjs` 启动时 `existsSync('src/lib/unified-bundle.js')`，缺失则打印修复命令 + exit 1 | **（N26 降级）** 有了 a 之后这条在 `npm test` 路径上**永不触发**，仅作直跑运行器的兜底 —— 保留但不作为主防线 |
| c | `index.html:1070` 加 `onerror` 错误条（复用 `#toast-container`） | `test/asset-resilience.test.cjs` |
| d | `UnifiedRenderer` 调用点前加 `if (typeof UnifiedRenderer === 'undefined') throw new Error('渲染器未构建，请运行 npm run build:renderer')` | 同上 |
| e | **（N14）** 抽 `test/helpers/load-bundle.cjs`：`existsSync` 检查 + 可操作报错；`render`/`render-extra`/`tab-scroll` 3 个测试改用之，覆盖**单文件直跑**入口 | 删产物后 `node test/render.test.cjs` 应给指引而非 ENOENT 堆栈 |
| **f** | **（R7 新增）`run-tests.cjs` 加 argv 过滤**：`node scripts/run-tests.cjs preview outline` → 只跑文件名含这些子串的测试；无参时行为不变 | 5 行改动；跑一次带参、一次不带参对比文件数 |

**回退**：纯增量，`git revert` 即可。
**已知副作用（N26，明确接受）**：`pretest` 会让 `src/unified-renderer.js` 有语法错误时 `npm test` 一个用例都跑不了（fail-fast）。改渲染器途中需跑无关测试时走单文件直跑或 P0-0f 的过滤。

### 🔴 P0-1 启动韧性 + 模块单导出守护（**本轮按 R3/N4 重新设计**）

- **全局错误兜底**（新，替代原"只加 onerror"）：`index.html` 在**首个 script 之前**插入 inline `window.addEventListener('error', ...)`，捕获**运行时**抛错并渲染可读错误条 —— 这才能兜住 `app.js:1` 那类 TypeError。
- 业务 script 追加 `onerror`（覆盖**加载失败**，与上者互补）。
- `scripts/check-globals.cjs`：扫 `src/modules/*.js`，用 **`\bwindow\.[A-Z][A-Za-z]*\s*=`**（**不能锚行首**，见现状表）统计全局导出，超白名单即失败。
- **harness 修复**：`app-env.cjs` 模块加载循环对白名单关键模块（`tauri-api`/`preview-post`/`code-block`/`preview-window`）加载失败**抛出**而非静默吞；并**显式优先加载 `tauri-api.js`**，不依赖字典序（N5）。
- **🔴（N15，必须先于 P0-2a）`test/entry-scripts.test.cjs`** —— **实现规范按 N24/N25 收紧，否则一写出来就是红的**：
  - **① `src/modules/` 双向相等**：目录内 `.js` 集合 == `<script src="modules/...">` 集合，缺一即失败。这是"新增模块"高频动作的正面命中区。
  - **② `src/lib/` 只做单向包含**：断言 `unified-bundle.js` / `md-links.js` 在清单内即可，**绝不反向枚举** —— vendor 目录下有数百个 js，显然不该全进 index.html。
  - **③ 枚举必须 `statSync().isFile()` 过滤**：`src/lib/highlight.js` **是一个目录**，只看后缀会把它当文件，然后要求存在 `<script src="lib/highlight.js">`（真实标签是 `lib/highlight.js/highlight.min.js`）→ 必然误报。
  - **④ 顺序断言只限"业务 8 条"**（6 模块 + 2 个 lib + app.js）都在 `app.js` 之前，**不牵扯 367-393 的 27 条 vendor**；**且不得断言模块之间的相对顺序** —— 生产与 harness 字典序**今天就不同**（preview-post 生产第 2 / 测试第 5，N25），断了立刻红。
  - 顺序不敏感由**设计**保证（新模块一律延迟求值），写进 ARCHITECTURE.md，不靠测试。

  **执行顺序即护栏**：先写这条（此刻应通过）→ 建 `tauri-api.js`（立刻变红）→ 加 script 标签（转绿）。把「测试全绿真机白屏」的陷阱变成流程的一部分。

> ⚠️ **顺序**：`app.js:1` 的根治由 P0-2 的延迟求值完成。P0-1 只是让故障**可见**，P0-2 才让它**不发生**。

### 🔴 P0-2 建 `src/modules/tauri-api.js` 并收敛 46 处 invoke

**命令清单（权威来源 = `lib.rs` 的 `generate_handler!`，20 个）**：
`read_file` `write_file` `write_binary_file` `file_meta` `is_directory` `list_dir` `ensure_dir` `app_data_dir` `read_bundled_file` `read_bundled_image_as_base64` `fetch_image_as_base64` `save_image_to_assets` `watch_folder` `stop_watch` `search_in_files` `generate_toc` `get_cli_args` `quit_app` `open_devtools` `set_window_behavior`
**plugin 类（3 类 6 个）**：`plugin:updater|check/download/install`、`plugin:dialog|open/save`、`plugin:webview|internal_toggle_devtools`

- **P0-2a（零风险，但有两个致命前提）**：建模块 —— **`COMMANDS` 数组为唯一真源、方法由其生成、延迟求值、互斥双导出、语义空操作（不包装错误、不做抛异常的参数校验，N21/N29）**+ updater Channel 专用手写方法；**`index.html` 在 `app.js` 前插 `<script src="modules/tauri-api.js">` —— 这一步漏了测试不会告诉你（N15），所以 `entry-scripts.test.cjs` 必须已在 P0-1 就位**；新增 `test/tauri-api.test.cjs`（含**契约测试**：解析 `generate_handler!` 块而非 `#[tauri::command]`，N27）。**app.js 尚未改动，不影响任何现有测试。**
- **P0-2b（机械替换，带护栏）**：
  - 替换 44 处裸 `invoke(...)` + 2 处直接调用（**3530 / 7617**）。形态已核（N10）：43 处 `await invoke`、零 then 链、零模板串 → 纯文本级替换。
  - **特例 `app.js:5483`**：`invoke('stop_watch')` 是故意 fire-and-forget，替换为 `tauriApi.stopWatch().catch(() => {})`（保持不 await 语义，顺带修复原 try/catch 捕不到 async 错误的既有小瑕疵）。
  - **删除 4 处绑定声明**：`app.js:1`（顶层，同时消除 N4 白屏根因）+ `7694` / `7766` / `7798`（`7766` 的 `Channel` 由 `tauriApi.updater` 内部接管）。漏删任一处，度量脚本「残留==0」会失败。
  - ⚠️ **删除安全的前提**：本步已把 `plugin:updater|check/download/install`、`plugin:dialog|open/save`、`plugin:webview|internal_toggle_devtools` 全部换成 `tauriApi.*` 手写方法（它们是 `core.invoke`，属本次收敛，**不是** P1-5）。若误把 plugin 当「非 core」跳过替换、却照删 7694/7766/7798 → updater 三方法 `ReferenceError: invoke is not defined`（N32）。验收：删完后 `grep -nE "invoke\('plugin:" src/app.js` 应为空。
  - **stub 兼容性已验证（N13）**：tauriApi 延迟求值读的正是 harness 注入的 `w.__TAURI__.core.invoke`，28 个集成测试的 invoke 捕获链路零改动继续生效。
  - **🔴 验收门（N21）**：新增 **C16** —— stub reject 一个 Rust 形态字符串 `'{"kind":"NotFound","path":"x"}'`，断言经 `tauriApi.readFile` 后仍映射出 `E_NOT_FOUND`。**没有这条，"把 5 类文件错误静默降级成 E_IO"这一整类退化在现有 54 个测试里完全不可见**（`error-handling.test.cjs` 是直测 `_mapReadFileError`，绕开 invoke）。
  - 跑：`tauri-api` + `app-fileops` + `fileops-extra` + `error-handling` + `tauri-integration` + `init-smoke`。
  - **回退**：P0-2b 是 46 处替换 + 4 处删除的单一主题 commit，**必须独立成 commit**（不与 P0-2a 混），失败时 `git revert` 单条即可回到 tauriApi 已存在但未接入的中间态 —— 这个中间态本身是可用且全绿的。

### 🔴 P0-3 竞态安全网 → 抽纯函数 → 特征测试（顺序不可颠倒）

- **P0-3a 竞态安全网（先做）**：`test/render-generation.test.cjs`。用可控 renderer stub 让第一次 `updatePreview` 挂起，其间触发第二次，断言第一次不写 DOM、`_renderGeneration` 单调递增。覆盖 14 处 gen 检查中的关键路径（**注意**：`_mermaidGeneration` 守卫在 2114，是独立竞态点，不能仅靠 updatePreview 挂起覆盖，需单独用例 —— N33）。
- **P0-3b 抽 `src/modules/preview-window.js`**：**只搬 `_isBlockStart` + `_computePreviewWindow`**（ADR-2/N7），常量参数注入。⚠️ **必须同步在 `index.html` 的 modules 清单加 `<script src="modules/preview-window.js">`** —— `src/modules/` 下每多一个文件，`entry-scripts.test.cjs`（P0-1 已就位）就会立刻变红要求对应 script 标签，这是该护栏的设计意图；不要等测试报错才补。
  - **（N23）不留薄委托**：`_isBlockStart` 零外部调用 → 类上不保留；`_computePreviewWindow` 仅一处调用 → 直接改调用点。
  - **（N31）不夹带缩进整理** —— `updatePreview` 的 4→2 空格移到 P2 独立 commit。
  - **🟠（N22 修订）NaN 归一化放在读取侧 + 模块入口，不是逐个补写入点**：
    ① 模块入口 `const f = Number.isFinite(focusLine) ? focusLine : 0;` + `(content || '')`；
    ② `_computePreviewWindow` 调用点的 `(this._previewFocusLine != null)` 改 `Number.isFinite(this._previewFocusLine)`；
    ③ `_focusPreviewToLine(this._previewFocusLine)` 处同样归一化（**上一轮漏了这个读取点**）；
    ④ 大纲点击里 `this._previewFocusLine = line` 移入 `!isNaN(line)` 守卫（卫生，非承重）。
  - ⚠️ 用 `Number.isFinite`，**不要 `|| 0`**；`cross-search-jump.test.cjs:92` 精确断言焦点为 49，归一化不得改变有限数取值。
  - ⚠️ **不要去"加固" `Math.max(0, Math.min(focus, n))` 那类写法就当作已修** —— 夹逼对 NaN 完全透明（`Math.max(0, NaN) === NaN`），它是**放大器不是过滤器**。
- **P0-3c `test/preview-window.test.cjs`**（纯单测，不加载 app.js）：`total <= maxLines` 直接全量返回；>5000 行时窗口落在块边界；焦点前保留 `lead` 行；**代码围栏奇偶配对不被切开**；`guard` 上限 500 生效；`end<=start` 兜底。
  - **⚠️（N18）修正原断言**：不能写 `end-start ≤ windowLines`（实测**不成立**）。正确不变量是 **`end-start ≤ windowLines + 2×guardMax`（= 2200）**，并单独锁一条「零块边界大文档返回 2200 行」的实测基线。
  - **（N16/R6）异常输入五连锁**：`NaN` / `undefined` / `null` / 负数 / 越界 focusLine 全部返回**有限且合法**的 `{start,end}`，绝不出现 `NaN`。⚠️ 定性：这是**防御性用例**（今日不可达，见 R6），不要在描述里写成"复现某个已知 bug"。
  - **（N17）性能基线**：连续 50 次最坏场景调用记录耗时（当前 ≈1236ms），作为 P1-9 优化的对照基准，不设硬阈值（避免机器差异导致 flaky）。
- **P0-3d `test/update-preview.test.cjs`**（特征测试，复用现成 bundle eval 手法；rAF 可用性已实证 N12）：普通文档正常渲染；大文档进入窗口模式产生 `.pv-spacer`+`.pv-block`；窗口模式下 `data-source-line` 已加偏移；TOC 分支替换 `[TOC]`（**需自定义 `invokeImpl` 返回 TOC 数据**——`defaultInvoke` 对 `generate_toc` 返回 undefined，见 N13）；`processImages` 抛错时后续 PreviewPost 仍执行。

  > bundle eval 手法（`render-extra.test.cjs` 已在用）：
  > ```js
  > const _b = fs.readFileSync('src/lib/unified-bundle.js', 'utf8');
  > w.eval(_b.replace('var UnifiedRenderer =', 'window.UnifiedRenderer ='));
  > ```

### 🟡 P1-1 抽 `processImages` → `src/modules/image-processor.js`

```js
processImages(preview, { activeTab, imageCache, tauri, getCachedImageURL, getRenderGeneration })
```
**必须原样保留 7 处代际检查**（用注入的 `getRenderGeneration()`）。
测试 `test/image-processor.test.cjs`：绝对 URL / 相对路径 / `isBundled` 三路径；缓存命中零重复 IO；代际过期提前返回不写 DOM。

> ⚠️ 既有铁律：**仅 `isBundled` tab 本地读不到才回退** `read_bundled_image_as_base64`，普通文档绝不回退。抽取后**必须复跑 `bundled-demo.test.cjs`**。

### 🟡 P1-2 测试运行器与僵尸测试处置（**本轮按 R2/N3/N6 重写**）

三件事，**不能混为一谈**：

1. **僵尸测试处置（第十轮回测已落定）**：`test/browser/code-block-brackets.test.cjs` **已删除**，`test/browser/` 目录整体移除。它守的 bug（`3c2c62f` 代码块被 `[ ]` 包裹）今天已有 jsdom 层等价覆盖 —— `test/code-block.test.cjs` 的「代码块不被多余 [ ] 包裹」「无 hljs 分支同样不被多余 [ ] 包裹」两条用例（行 113–145）逐字复刻了同一源码（`const a=[1,2]`）与同一断言逻辑，且本轮回测 10/10 通过。保留一个依赖已删 fixture (`src/test-browser.html`)、硬编码 Chrome 绝对路径、私有 `ws` 的文件只会持续误导。
2. **运行器递归**：`run-tests.cjs` 改为递归扫 `test/**/*.test.cjs`，**无需再排除 `test/browser/`**（该目录已删除）。递归的真实价值是防止今后再出现"写了但没跑"。
3. **第二个僵尸处置（第十轮回测已落定）**：`csp-check.cjs` **已重建为 `test/csp-check.test.cjs` 并纳入主套件**（纯 node，无浏览器/CDP/私有依赖，读 `tauri.conf.json` 真实 CSP + 断言 `unified-renderer.js` 净化块仍在；本轮回测通过）。它**不再**是「独立套件」—— 直接进主套件，每次 `npm test` 都跑，成为 ADR-4 的常驻安全网，CSP 变更不再盲改。原 `csp-check.cjs`（依赖不存在的 `src/tauri-mock.js` + 私有 `ws`）已删除。
4. **Rust 测试**：`cargo test` 接入 P1-8 的 CI（N6，本地保持不跑以免拖慢）。

### 🟡 P1-3 测试分层
纯模块（code-block / preview-post / outline / word-count / preview-window / image-processor / tauri-api）走单测不加载 app.js；集成测试独立。本地按改动过滤；全量待 P1-8 的 CI。

### 🟡 P1-4 成功度量 `scripts/coupling-report.cjs`
> 与 `check-globals` / `entry-scripts` / 契约测试一起聚合为 **`npm run check`**（ADR-7：先本地可执行，CI 见 P1-8）。

- 模块全局导出数 == 白名单（正则不锚行首）；
- `src/app.js` 中 `invoke(` 残留 == 0；
- `window.__TAURI__` 残留数（P1-5 前信息性，之后硬卡）；
- `updatePreview` fan-in（`this.` 计数，**容忍 4 空格缩进**）趋势；
- 每 PR 破测预算：单文件改动连坐 > 3 个无关模块测试则告警。

### 🟡 P1-5 收敛非 core 的 `window.__TAURI__.*`
**前置**：先补 harness stub（`app: { getVersion }`、`core.Channel`），否则集成测试批量失败。
收敛为 `tauriApi.shellOpen / onEvent / getVersion / currentWindow / resourceDir`，全部带守卫。完成后 ADR-1 的「唯一 IPC 边界」才真正成立，coupling-report 转为硬卡。

### 🟡 P1-6 settings 补一条真往返
现有 `settings.test.cjs` 覆盖已足（`_validConfigObject` 四类非法输入、类型回退、丢弃未知键、旧版 colorScheme 推断、坏 JSON 回退）。只补 `saveSettings`→`loadSettings` 端到端一致 1 条。

### 🟡 P1-7 Rust 僵尸渲染退役（ADR-6）
删 `render_markdown` 及专属辅助链；XSS 语义迁到前端 `render.test.cjs` 对 sanitize schema 的断言。

### 🟡 P1-8（**本轮新增**）建立 CI（ADR-7 / N20）
项目当前**无任何流水线**。新增 `.github/workflows/ci.yml`：`npm ci`（完整安装，**不用 `--omit=dev`**，否则 `prepare` 的 esbuild 缺失）→ `npm run check`（聚合守护脚本）→ `npm test`（全量）→ 可选 `cargo test`。
**这一步之前，方案里所有「CI 卡点」都只是本地脚本 + 自觉。** 排 P1 而非 P0：它不阻塞任何代码改动，但决定护栏最终有没有牙齿。

### 🟡 P1-9（**本轮新增**）`computePreviewWindow` 末尾扫描 O(n²)→O(n)（N17）
现状：end 循环每推进一行就把整窗口重新 `join('\n')` + 全局正则，最坏 500 次 → ≈25ms/次。
优化：预先按行计算 fence 标记数组，循环内增量维护奇偶计数，不再重扫。
**前置**：P0-3c 的行为锁定测试 + 性能基线必须先在位 —— 有网才敢改算法。属纯等价优化，风险低但**不进 P0**（P0 只锁行为，不改行为）。

### 🟢 P2-1 `PreviewController` facade（Strangler）
建 `src/controllers/preview-controller.js`，暴露 `render()`/`setDark()`/`refresh()`，**同时收编 N7 表中留下的 5 个虚拟窗口方法**；每 PR 迁一批；每批必跑竞态测试。

### 🟢 P2-2 ESM 仅 release 打包
`scripts/build-frontend.mjs`；release CI 将 `frontendDist` 指向 `dist/`，dev 仍 `../src`。

### 🟢 P2-3 vendor 锁定（沿用 `5f5b23e` 范式）
新增 `scripts/ensure-vendor.mjs`，从 `node_modules` 复制 codemirror / highlight.js / katex / mermaid / html2canvas / markdown-it（**已全在 `dependencies`**），接入 `prepare`，对应子目录加 `.gitignore`。比"删 `src/lib` 改 npm 导入"更可逆。
> 配套：CI 必须完整安装依赖（不用 `--omit=dev`），否则 `prepare` 跳过/失败。

### 🟢 P2-4 `ARCHITECTURE.md` + 守护固化
文档化：模块边界、单导出约定、**tauri-api 为唯一 IPC 边界**、PreviewController 职责、产物再生规则、**前端 unified-renderer 是唯一渲染路径**、**新增模块必须同步 `index.html` 脚本清单**。守护由 `npm run check` 承载（`entry-scripts` + `check-globals` + `coupling-report` + 契约测试），P1-8 后接入 CI。

---

## 5. 测试完善清单

### 5.1 基建缺陷（先修，否则后续测试都不可信）

| # | 缺陷 | 影响 | 修复 |
|---|---|---|---|
| T1 | `run-tests.cjs` 不递归 | 写了不跑 = 假覆盖 | P1-2.2 递归 + 排除 browser |
| T2 | **`test/browser/` 曾是僵尸**（fixture 缺失 + 私有路径 + 未声明依赖） | 纳入即红且无法修 | **第十轮已删除该目录**（其覆盖由 `code-block.test.cjs` 等价承担） |
| T3 | 无产物存在性前置检查 | bundle 缺失 → 3 文件 ENOENT | P0-0 a/b |
| T4 | stub 缺 `app.getVersion` / `core.Channel` | 阻断 P1-5 | P1-5 前置补 stub |
| T5 | harness `catch(_){}` 静默吞异常 | 表现为莫名 ReferenceError | P0-1 关键模块白名单抛出 |
| T6 | harness 模块加载依赖字典序 | 测试通过但运行时行为不同 | P0-1 显式优先加载 tauri-api |
| T7 | **`csp-check.cjs` 曾是第二个僵尸**（依赖不存在的 `src/tauri-mock.js` + 私有 `ws` 路径） | CSP 变更零回归保护，ADR-4 盲改 | **第十轮已重建为 `csp-check.test.cjs` 纳入主套件**（纯 node 静态守卫） |
| T8 | **Rust 测试从不执行** | 后端改动本地无感 | P1-8 CI 接 `cargo test` |
| **T9** | **入口脚本清单与 harness 自动加载无一致性校验（N15）** | **新增模块漏加 script 时：测试全绿、真机白屏** | **P0-1 `entry-scripts.test.cjs`（先于 P0-2a）** |
| **T10** | **无 CI、无任何流水线（N20）** | 全量测试 / 守护脚本 / 契约测试**无强制执行点** | P1-8 建 CI；此前护栏落地为 `npm run check` |
| **T11** | 无性能回归基线 | O(n²) 一类问题只能靠人肉发现（N17 就是这么发现的） | P0-3c 记录基线耗时（不设硬阈值，避免 flaky） |
| **T12** | **运行器无过滤能力（R7）** | 日常"只跑相关测试"必须绕过运行器 → **绕过全部前置守护** | **P0-0f** 加 argv 过滤 |
| **T13** | **错误链路端到端零覆盖（N21）** | `error-handling` 直测 `_mapReadFileError`、绕过 invoke → IPC 包装层退化**不可见** | **C16**（P0-2b 验收门） |
| **T14** | **测试断言只能靠行号定位的部分（N30）** | P0-2b 后行号整体偏移，任何行号型定位失效 | 全文改用符号/片段定位；执行顺序调整（§10） |
| **T15** | 新测试自身的实现陷阱（N24） | `entry-scripts` 朴素实现会被 `src/lib/highlight.js` **这个目录**弄成假红 | P0-1 写死实现规范（isFile 过滤 / lib 单向 / 不断言顺序） |

### 5.2 覆盖盲区与补齐清单

| # | 盲区 | 新增/扩展 | 归属 | 优先级 |
|---|---|---|---|---|
| C1 | **渲染代际竞态**（14 处 gen 检查零覆盖：`_renderGeneration` 13 + `_mermaidGeneration` 1） | `test/render-generation.test.cjs`（`_renderGeneration` 路径 + 单独补 `_mermaidGeneration` 用例） | P0-3a | 🔴 最高 |
| C2 | `computePreviewWindow` 块边界/围栏奇偶/guard 上限/兜底 | `test/preview-window.test.cjs` | P0-3c | 🔴 |
| C3 | **前后端 IPC 契约一致性** | `test/tauri-api.test.cjs` 反解析 `lib.rs` | P0-2a | 🔴 |
| C4 | 大文档 `isLarge` 分支 + `data-source-line` 偏移还原 | `test/update-preview.test.cjs` | P0-3d | 🔴 |
| C5 | `tauriApi` 26 命令透传 + 守卫 + updater Channel | 同 C3 文件 | P0-2a | 🔴 |
| C6 | TOC 分支（`generate_toc` → 段落替换） | 同 C4 文件 | P0-3d | 🟡 |
| C7 | `processImages` 三路径 + 缓存命中 + 代际过期 | `test/image-processor.test.cjs` | P1-1 | 🟡 |
| C8 | **运行时抛错不白屏**（含 `app.js:1` 场景） | `test/asset-resilience.test.cjs` | P0-0c/P0-1 | 🟡 |
| C9 | 模块全局导出数 == 白名单 | `test/check-globals.test.cjs` | P0-1 | 🟡 |
| C10 | 虚拟窗口 DOM 几何（spacer 高度 / block top） | 扩展 C4（特征测试间接覆盖） | P0-3d | 🟡 |
| C11 | `saveSettings`→`loadSettings` 真往返 | 扩展 `test/settings.test.cjs` | P1-6 | 🟢 |
| C12 | sanitize schema XSS（承接 Rust 退役用例） | 扩展 `test/render.test.cjs` | P1-7 | 🟢 |
| **C13** | **入口脚本清单 ↔ 模块目录一致性（N15）** | `test/entry-scripts.test.cjs` | **P0-1** | **🔴 最高** |
| **C14** | **NaN/undefined/null/负数/越界 焦点行（N16 真实缺陷）** | 扩展 `preview-window.test.cjs` + 一条 app 层回归（大纲 `data-line` 缺失不致预览空白） | P0-3b/c | **🔴** |
| **C15** | 窗口行数上限真实不变量 2200（N18） | 扩展 `preview-window.test.cjs` | P0-3c | 🟡 |
| **C16** | **🔴 IPC 错误原样透传**（reject `'{"kind":"NotFound"...}'` → 仍得 `E_NOT_FOUND`，N21） | 扩展 `error-handling.test.cjs`：**stub `window.__TAURI__.core.invoke` reject 该 JSON 串 → 经 `app.readFileNormalized(path)`（内部走 `tauriApi.readFile` → `_mapReadFileError`）→ 断言抛出错误的 `.code === 'E_NOT_FOUND'`**。必须走端到端路径，不能直调 `_mapReadFileError`（否则退化不可见） | **P0-2b 验收门** | **🔴 最高** |
| **C17** | `COMMANDS` 集合 == `generate_handler!` 集合，且解析失败必须显式失败（N27/N29） | `tauri-api.test.cjs` | P0-2a | 🔴 |
| **C18** | `_focusPreviewToLine` 读取点的 NaN 归一化（N22 漏点） | 扩展 `view-mode-scroll.test.cjs` 或 `preview-window.test.cjs` | P0-3b | 🟡 |
| **C19** | 运行器 argv 过滤：带参只跑子集、无参行为不变（R7） | `test/run-tests-filter.test.cjs`（或直接双跑比对计数） | P0-0f | 🟢 |

> `asset-resilience.test.cjs` 不能用 app-env（其 `runScripts:'outside-only'` 不执行 `<script src>`），需独立 jsdom `runScripts:'dangerously'`，或直接对错误处理函数单测。

---

## 6. 改动影响矩阵

| 步骤 | 潜在爆点 | 触发条件 | 预防 |
|---|---|---|---|
| P0-0 | 无 | — | 纯增量 |
| P0-0e 缺失 | 单文件直跑仍裸 ENOENT | 只做 a/b（`npm test` 入口），漏掉 `node test/xxx` 直跑入口 | 3 个测试统一走 `load-bundle.cjs` |
| P0-2b | `stop_watch` 静默失效或 unhandled rejection | 5483 行被机械改成 await 或丢了 catch | 特例清单化：`.catch(()=>{})` 不 await |
| P0-1 | 守护脚本假通过 | 正则锚了行首 `^window\.` | 用 `\bwindow\.[A-Z]` |
| **P0-2a** | **🔴 测试 100% 全绿但真机白屏** | **新建 `tauri-api.js` 却漏加 `index.html` 的 `<script>`；harness 靠 readdir 自动加载，完全察觉不到（N15）** | **P0-1 先落 `entry-scripts.test.cjs`，让它替你红** |
| P0-2b | **28 个集成测试全红** | `tauri-api.js` 放错目录（不在 `src/modules/`） | 放对目录；先跑 `init-smoke` 冒烟 |
| P0-2b | 度量脚本假失败 | 漏删 4 处 invoke 绑定之一 | 清单化逐条核对 |
| P0-2b | updater 静默失效 | Channel 未由 tauriApi 接管 | 契约测试断言 Channel 传递 |
| P0-2b | 契约测试误报 | `lib.rs` 解析正则未容忍格式变化 | 解析失败时明确报错而非静默通过 |
| **P0-2a** | **契约测试恒红 1 个** | 按 `#[tauri::command]`（21 个）而非 `generate_handler!`（20 个）统计，差的是僵尸 `render_markdown`；随后被加白名单，白名单又掩盖真漂移 | 只解析 handler 块（N27） |
| **P0-2b** | **🔴 五类文件错误静默塌缩成 `E_IO`** | tauri-api 里 try/catch 包装错误、或加了会抛的参数校验 → `_mapReadFileError` 的 `JSON.parse` 失败 → 一律 `Io`。**现有 54 个测试全绿** | ADR-1 硬约束「语义空操作」+ **C16 验收门** |
| **P0-2a** | 跨测试全局污染、间歇性漂移失败 | 双导出漏写 `typeof module === 'undefined'`，`require` 时同时写 `global.window.tauriApi` | 沿用现有互斥式写法（N29） |
| **P0-1** | **`entry-scripts` 一写出来就假红** | 用后缀枚举 `src/lib/*.js` 撞上**目录** `highlight.js`；或断言了模块相对顺序（生产/测试今天就不同） | `isFile()` 过滤 + lib 单向包含 + 不断言顺序（N24/N25） |
| **P0-3b** | 按行号跳转改错位置 | P0-2b 净删 4 行使其后行号整体上移 | 符号定位；**或把 P0-3 提到 P0-2 之前**（本轮采纳，§10） |
| **P0-3b** | NaN 修复看似完成实则漏一半 | 只改了 `_computePreviewWindow` 的读取点，漏了 `_focusPreviewToLine`；或误以为 `Math.max/min` 已夹逼 | 两个读取点都改；C18 锁死（N22） |
| **P0-3b** | 抽取 commit 无法 review / 无法部分回滚 | 夹带了 190 行缩进整理 | 格式化独立 commit（N31） |
| **P0-3c** | 想"复现真实 NaN 场景"而卡住 | 按 R6 之前的错误定性去写用例 —— 今天造不出这个场景 | 写成防御性注入用例 |
| P0-3b | **偶发「旧渲染覆盖新渲染」** | 抽取时 gen 检查错位 | P0-3a 竞态测试先行 |
| P0-3b | 抽取中途受阻回滚 | 误把 `_renderPreviewWindowBlock` 等有状态方法一起抽 | ADR-2 明确只抽 2 个纯函数 |
| **P0-3b** | **NaN 缺陷只修一半，粘滞空白预览仍在** | 只在模块入口加 `Number.isFinite` 归一化，忘了改 `app.js:1776` 的投毒源（或反之） | 两处同批改；C14 用例双向锁死 |
| **P0-3c** | **断言写错导致用例假红** | 沿用旧方案的 `end-start ≤ windowLines`（实测上限是 2200，非 1200） | 按 N18 用 `windowLines + 2×guardMax` |
| **P1-9** | 优化改变了窗口边界行为 | 增量 fence 计数与原 `join+match` 语义不等价（如 `~~~` 与 ``` 混用、行内反引号） | P0-3c 行为锁定测试先行；优化后逐条比对同输入输出 |
| **P1-2.3** | CSP 回归网彻底消失 | 直接删掉 csp-check 而未重建 | 倾向重建；若删，须在 ADR-4 显式标注「ESM/CSP 变更为盲改」 |
| **P1-8** | CI 首次运行即红 | `npm ci --omit=dev` 导致 `prepare` 的 esbuild 缺失，bundle 构建失败 | 完整安装依赖（已列入 P1-8 与假设 4） |
| P1-1 | **打包 demo 图片回退失效** | 抽取时放宽 `isBundled` 条件 | 复跑 `bundled-demo.test.cjs` |
| P1-2 | 主套件突然变红 | 递归时未排除 `test/browser/` | 先处置僵尸测试，再开递归 |
| P1-5 | 集成测试批量失败 | stub 缺 `getVersion`/`Channel` | 先补 stub |
| P1-7 | Rust 编译失败 | 删除时漏了共享辅助函数 | 先 `cargo check` 再删 |
| P2-1 | 迁移期行为分叉 | facade 与薄委托语义不一致 | 每批跑竞态 + 特征测试 |
| P2-3 | 本地 `src/lib` 清空后起不来 | `ensure-vendor` 未接 `prepare` | 先接 prepare、验证后再 gitignore |

---

## 7. 明确不做（YAGNI / 风险规避）

- ❌ 不 big-bang 拆 5 个 Controller（走 ADR-3 Strangler）
- ❌ 不重写 app.js
- ❌ 不在 dev 引入打包步骤（保住"源码即运行"）
- ❌ 不在当前源码模式强推 ESM
- ❌ P0 阶段不收敛非 core `__TAURI__.*`（留 P1-5，避免替换面膨胀 45%）
- ❌ **不把 `test/browser/` 纳入主测试套件**（僵尸 + 需 Chrome + 需私有依赖）
- ❌ **不在 P0 动 Rust 侧**（N2 无运行时风险，排 P1-7）
- ❌ 不在 P1-2 之前用「破测数」做硬门禁（运行器本身还漏跑）
- ❌ **不抽 `_renderPreviewWindowBlock` 及其后的有状态方法**（N7，留 P2-1）
- ❌ **不引入 ESLint**（ADR-7）—— `check-globals.cjs` 这类几十行小脚本已满足当前所有守护需求，引入 ESLint = 新依赖 + 配置 + 存量告警治理，成本不成比例
- ❌ **P0 阶段不改 `computePreviewWindow` 的算法**（N17 的 O(n²) 留 P1-9）—— P0 只锁行为，不改行为
- ❌ **不把守护脚本的强制力寄托在尚不存在的 CI 上**（ADR-7 / N20）
- ❌ **P0 阶段 tauri-api 不做参数校验、不做错误包装、不做重试/超时**（N21）—— 这一步的价值恰恰在于**语义为零**；任何"顺手增强"都会把一次可验证的机械替换变成一次行为变更
- ❌ **不在抽取 commit 里做格式化**（N31）
- ❌ **不断言模块加载顺序一致**（N25，生产与测试今天就不同）；顺序不敏感靠设计保证，不靠测试
- ❌ **不给 `_previewFocusLine` 的 8 个写入点逐个打补丁**（N22）—— 在读取侧收口

---

## 8. 假设（闭包，无需再追问）

1. 本地只跑改动相关测试；**在 P1-8 建成 CI 之前不设自动全量**，全量靠手动 `npm test`。
2. `src/modules/` 是 harness 自动加载目录，新模块一律放这里；**且必须同步 `index.html` 脚本清单**（由 `entry-scripts.test.cjs` 强制）。
3. IPC 完整集合 = `lib.rs` 注册的 20 命令 + 3 类 plugin（已双向 diff 校验）。
4. CI（P1-8 建成后）使用完整依赖安装（非 `--omit=dev`），保证 `prepare` 可执行。
5. **僵尸测试处置已落定（第十轮执行）**：`test/browser/` 已删除（其 `[ ]` 包裹回归由 `code-block.test.cjs` 等价承担，逐字一致）；`csp-check.cjs` 已重建为 `test/csp-check.test.cjs` 纳入主套件（纯 node 静态守卫，读真实 CSP + 断言 `sanitizeHTML`/`sanitizeTagAttributes` 净化块）。两者均用受管 node 回测通过。
6. `render_markdown` 无外部调用方（已 grep 前端与 Rust 全量确认）。
7. **N16 的 NaN 按「修」处理**（P0-3b 同批），但定性为**消除结构性脆弱**而非修复线上缺陷（R6：今日不可达）。修的理由是成本 4 行、抽取本身已在动这段代码、边际风险≈0；**不修也不会有用户受影响** —— 若你希望把 P0 面再压小，这是唯一可以安全砍掉的子项。
8. **P0-2 的 tauri-api 是纯搬运，不含任何增强**（N21）。若你希望它顺带做参数校验或统一错误码，那是 P1 的独立工作项，需要单独的测试与验收。
9. **本文行号 = `HEAD=2165504` 快照坐标**（N30），执行时以符号定位为准。

---

## 9. 里程碑

| 阶段 | 步骤 | 本地验证 | 风险 |
|---|---|---|---|
| **P0-0** | 产物韧性六件套（含 e 直跑入口 + **f 运行器过滤**） | `asset-resilience` + 手动删产物 + 双跑对比 | 低 |
| **P0-1** | 全局错误兜底 + 单导出守护 + harness 修复 + **`entry-scripts.test.cjs`**（按 N24/N25 规范） | `entry-scripts` + `check-globals` + `init-smoke` | 低 |
| P0-3a | 代际竞态测试 | `render-generation.test.cjs` | 低 |
| P0-3b/c | 抽 2 个纯函数（**不留委托、不带格式化**）+ 两个读取点归一化 + 单测 | `preview-window` + `outline` + `view-mode-scroll` + `cross-search-jump` | **低**（范围最窄，纯函数性已实测） |
| P0-2a | tauri-api 模块（**COMMANDS 真源 + 语义空操作**）+ **index.html 脚本标签** + 契约测试 | `tauri-api` + **`entry-scripts`** | 低 |
| P0-2b | 收敛 46 invoke + 删 4 绑定（**独立 commit**） | `tauri-api` + **`error-handling`(C16)** + `app-fileops` + `fileops-extra` + `tauri-integration` + `init-smoke` | **中高**（面最广） |
| P0-3d | updatePreview 特征测试 | `update-preview.test.cjs` | 中 |
| P1-1 | 抽 image-processor | `image-processor` + `bundled-demo` | 中 |
| P1-2 | **两个僵尸处置** + 运行器递归 + Rust 测试归位 | 手动全量 `npm test` | 中 |
| P1-3/4/6 | 分层 + 度量 + settings | 对应单测 | 低 |
| P1-5 | 收敛非 core（先补 stub） | `tauri-api` + 集成套件 | 中 |
| P1-7 | Rust 僵尸退役 | `cargo check` + `cargo test` + `render` | 中 |
| **P1-8** | **建 CI** | 首跑全量 + `npm run check` | 低（但决定护栏有无牙齿） |
| **P1-9** | 窗口扫描 O(n²)→O(n) | `preview-window`（行为锁定 + 基线对比） | 低（有网之后） |
| P2-1..4 | 演进 | 逐批迁移 + 守护脚本 | 按步可控 |

---

## 10. 开工状态

✅ **无阻塞项**。产物已重建，基线测试全绿，代码与远端一致（`HEAD=2165504`），工作区干净。

**执行顺序（第七轮据 N30 调整，第八轮代码级复核确认无需再变）**：

1. **P0-1 的 `entry-scripts.test.cjs`（最先做，几十行）** —— 它是 P0-2 的**安全带**。不先有它，P0-2a 漏加一个 `<script>` 标签就会得到「54 个测试全绿 + 真机白屏」，这是最难自查的一类失效。实现按 N24/N25 的四条规范写，否则它自己先假红。
2. **P0-3a → P0-3b/c**（**提前到 P0-2 之前**）—— 理由（N30）：这一步依赖 7 个精确锚点，而 P0-2b 会净删 4 行让其后行号整体上移。先做 P0-3 就完全绕开重定位问题；且 P0-3 范围最窄、纯函数性已实测、与 IPC 收敛零重叠，天然适合当"第一刀真改动"。顺序内部仍是**先补竞态网、再抽取**。
3. **P0-2a → P0-2b** 把 46 处 IPC 收敛到 `src/modules/tauri-api.js` —— 延迟求值顺带根治 `app.js:1` 的白屏单点；`COMMANDS` 真源 + 契约测试锁死前后端漂移。**P0-2b 必须独立 commit，且以 C16 为验收门**。
4. **P0-0** 产物韧性六件套 —— 已被真实踩中一次；其中 **f（运行器过滤）** 顺带修复"日常入口绕过全部守护"这个结构问题。

**九轮审查的收敛状态**：

| 轮次 | 方法 | 产出 |
|---|---|---|
| ①–③ | 读方案 + grep 复核 | 补 IPC 边界、事实基线 |
| ④–⑤ | 核 Rust 契约 / 执行期细节 | 自我纠正 3 处，N1–N14 |
| ⑥ | **原型实证**（隔离环境实跑） | N15–N20，自我纠正 2 处 |
| ⑦ | **落地写法层反推**（"照这么写会怎样"） | N21–N31，自我纠正 2 处，**其中 R6 推翻了上一轮的核心论断** |
| ⑧ | **承重断言代码级复核 + 边界拆清** | N32（plugin↔非core 措辞陷阱）；C16 端到端路径修正 |
| ⑨ | **执行风险专攻**（harness 注入机制 / 代际检查点实查） | **N13 实证确认**（28 集成测试零改动延续）；**N33**（gen 检查 17→14、_mermaidGeneration 独立守卫未覆盖） |
| ⑩ | **全文档收口**（僵尸处置落定 + 数值矛盾闭环） | 僵尸测试已执行（删 `test/browser/`、重建 `csp-check.test.cjs`）；N32（46 处 invoke 全经 `core.invoke`）、代际竞态（14 处）、非 core 命名空间（~20）等计数全部与代码实查一致；§8 假设 5 / 结尾注去"未决"化，审查历程表补齐 |

第七轮的方法论差异值得记下：前六轮问的是**「这件事该不该做、能不能做」**，本轮问的是**「按方案原文一字不差地写出来，会得到什么」**。三个最危险的发现（N21 错误静默降级、N24 测试自身假红、R6 定性错误）都只有在这个视角下才会浮现 —— 它们全都**不是遗漏，而是照做就会踩**。

第八轮做的是"收口验证"：把第七轮所有承重断言逐一对照真实代码（`_mapReadFileError` 实现体、`buildOutlineTree` 的 `{...h}` 透传、`_previewFocusLine` 的 8 写 2 读、`highlight.js` 实为目录、`#[tauri::command]` 21 vs 注册 20、46 处 invoke 的 plugin/非core 分布、`dialogOpen` 位于函数内），并拆清 plugin 命令（属 `core.invoke`，P0-2b 收）与 shell/event/app/window/path（非 invoke，P1-5 收）两条互斥清单。结论：**方案内部自洽、与代码一致，达到稳定可执行态。**

**当前无已知的未验证假设，亦无待拍板项。** 剩余的不确定性只有一类：执行中真实 diff 带来的意外，这类只能靠 P0-1 的护栏和逐步 commit 兜住。

> **第九轮补充**：本轮把火力集中在「前八轮没实证过的执行风险」。最关键的一项 —— N13（P0-2b「28 个集成测试零改动继续生效」）已通过读 `test/helpers/app-env.cjs` 实证：harness 在加载 `src/modules/*`（含未来的 `tauri-api.js`）**之前**就把 `w.__TAURI__ = { core: { invoke: stub } }` 注入到位，而 tauri-api 采用延迟求值（调用时才读 `window.__TAURI__.core.invoke`），二者路径天然吻合，28 个测试捕获/断言链路零断点。另一项 —— 渲染代际竞态检查点实查为 **14 处**（非 17），且 `_mermaidGeneration` 守卫（2114）是独立竞态点、原 P0-3a 测试描述覆盖不到，已补 N33 与对应用例要求。除 N33 这处计数/覆盖小缺口外，方案与代码一致、可执行。

> **第十轮补充（收口）**：本轮不再引入新发现，只把前九轮所有"未决/默认取"的措辞全部闭环。① 僵尸测试处置已实际执行：`test/browser/` 目录已删（其 `[ ]` 包裹回归由 `code-block.test.cjs` 逐字等价承担）、原 `csp-check.cjs` 已重建为 `test/csp-check.test.cjs` 并纳入主套件（`run-tests.cjs` 每次 `npm test` 自动跑），均用受管 node 回测通过。② 三个计数矛盾（N32 的 46 vs 41、代际竞态 17 vs 14、非 core ~16 vs ~20）已逐一与代码实查对齐，且反向 grep 确认全文无「17 处 / 41 处 / 默认取删除 / 默认取重建」等旧表述残留。③ §8 假设 5、结尾注「待拍板项」、T2/T7 现状均已改写为已落定事实。至此方案内部自洽、与代码一致、无未验证假设、无待拍板项、无遗留数值矛盾 —— 达到"无优化空间、无疑问"的可执行终态。
