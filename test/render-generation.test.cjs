// 渲染代际竞态安全网（P0-3a / N33）。
//
// 背景：updatePreview 是异步的，渲染期间会被多个 await 打断（generate_toc / 渲染 / 图片加载）。
// 每次触发都会 ++this._renderGeneration，且每个 await 之后都用 `if (gen !== this._renderGeneration) return;`
// 丢弃过期渲染。若守卫缺失，旧渲染（gen N）在 await 恢复后会用旧内容覆盖新渲染（gen N+1）的成果，
// 预览出现“回退到旧内容”的竞态 bug。本测试用可控的 generate_toc 制造竞态窗口，验证守卫有效。
//
// 用 buildEnv harness 加载真实 app.js，不依赖任何浏览器 / Tauri GUI。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildEnv, cleanup, waitForEditor } = require('./helpers/app-env.cjs');

// 浏览器里 unified-bundle.js 以 <script> 挂全局 UnifiedRenderer；jsdom 测试需手动 eval，
// 否则 updatePreview 内 UnifiedRenderer.renderMarkdown 抛错（渲染失败退化为“预览错误”）。
const _bundle = fs.readFileSync(path.resolve(__dirname, '..', 'src/lib/unified-bundle.js'), 'utf8');
function loadUnifiedRenderer(w) {
  w.eval(_bundle.replace('var UnifiedRenderer =', 'window.UnifiedRenderer ='));
}

test('渲染代际计数器随每次 updatePreview 自增', async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  const pm = w.editor;
  try {
    loadUnifiedRenderer(w);
    const g0 = pm._renderGeneration;
    ed.cm.setValue('# 第一次渲染');
    await pm.updatePreview();
    assert.equal(pm._renderGeneration, g0 + 1, '第一次应自增 1');
    ed.cm.setValue('# 第二次渲染');
    await pm.updatePreview();
    assert.equal(pm._renderGeneration, g0 + 2, '第二次应再自增 1');
  } finally {
    cleanup(w);
  }
});

test('渲染代际竞态：过期异步渲染被丢弃，预览只反映最新内容', async () => {
  // 可控的 generate_toc：让首个渲染卡在 await 点，制造竞态窗口
  let resolveToc = null;
  const tocPromise = new Promise((r) => { resolveToc = r; });
  const invokeImpl = (cmd) => {
    if (cmd === 'generate_toc') return tocPromise.then(() => '<div class="toc">TOC</div>');
    if (cmd === 'get_cli_args') return [];
    return undefined;
  };
  const { w } = await buildEnv({ invokeImpl });
  const ed = await waitForEditor(w);
  const pm = w.editor;
  try {
    loadUnifiedRenderer(w);
    const preview = w.document.getElementById('preview');

    // 基线：无 [TOC] 的文档正常渲染（gen = 1），不触碰可控 tocPromise
    ed.cm.setValue('# 标题\n\n正文内容');
    await pm.updatePreview();
    assert.ok(preview.innerHTML.includes('正文内容'), '基线渲染应落盘');

    // 第二轮：带 [TOC]，调用 generate_toc 后卡在 await（gen = 2，未落盘）
    ed.cm.setValue('# 旧内容\n[TOC]\n\n旧段落');
    const genAtP1 = pm._renderGeneration;
    const p1 = pm.updatePreview(); // gen = genAtP1+1，停在 generate_toc 的 await

    // 第三轮：不带 [TOC] 的新内容，应正常完成并落盘
    ed.cm.setValue('# 新内容\n\n新段落');
    const p2 = pm.updatePreview(); // gen 进一步自增
    await p2;

    // 此刻代际应已超过 p1 起始代际（编辑器 change 还可能触发 debounce 渲染，故只用 > 比较）
    assert.ok(pm._renderGeneration > genAtP1, '第三轮应把代际推到比 p1 更新');
    assert.ok(preview.innerHTML.includes('新段落'), '最新渲染应已落盘');

    // 释放 p1 的 generate_toc：恢复后守卫应拦截，不得用旧内容覆盖
    resolveToc();
    await p1;

    // 关键断言：预览必须反映最新（gen 3）内容，且未被过期的 gen 2 覆盖
    assert.ok(preview.innerHTML.includes('新段落'), '预览应反映最新内容（新段落）');
    assert.ok(!preview.innerHTML.includes('旧段落'), '预览不得被过期渲染（旧内容）覆盖');
  } finally {
    cleanup(w);
    if (resolveToc) { try { resolveToc(); } catch (_) {} } // 兜底释放，避免悬挂
  }
});

test('连续两次渲染：最终预览始终是最后触发的内容', async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  const pm = w.editor;
  try {
    loadUnifiedRenderer(w);
    const preview = w.document.getElementById('preview');
    // 两个无 [TOC] 的渲染并发触发，最后一个完成的内容应胜出（守卫保证不会互相覆盖成乱序）
    ed.cm.setValue('# 内容A\n\n段落A');
    const p1 = pm.updatePreview(); // gen N
    ed.cm.setValue('# 内容B\n\n段落B');
    const p2 = pm.updatePreview(); // gen N+1
    await Promise.all([p1, p2]);
    assert.equal(pm._renderGeneration >= 2, true, '至少自增两次');
    assert.ok(preview.innerHTML.includes('段落B'), '最终预览应为最后触发的内容B');
    assert.ok(!preview.innerHTML.includes('段落A'), '不应残留内容A');
  } finally {
    cleanup(w);
  }
});
