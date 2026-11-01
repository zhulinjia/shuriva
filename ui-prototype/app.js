(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const dialog = $('#detailDialog');
  const toast = $('#toast');
  const userMessage = $('#userMessage');
  const intro = $('#assistantIntro');
  const resultCard = $('#resultCard');
  const insight = $('#insight');
  const resultBody = $('#resultBody');
  const originalBody = resultBody.innerHTML;
  const originalResultHead = $('.result-head').innerHTML;
  const originalIntro = intro.innerHTML;
  const originalInsight = insight.innerHTML;
  let toastTimer;
  let runTimer;
  let activePrompt = '分析近六个月的订单趋势，看看每月订单金额和订单数量。';

  function notify(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function openDialog(title, body, actions = '<button class="outline-button dialog-close">关闭</button>') {
    $('#dialogTitle').textContent = title;
    $('#dialogContent').innerHTML = `<div class="dialog-body">${body}</div>`;
    $('#dialogActions').innerHTML = actions;
    if (!dialog.open) dialog.showModal();
  }

  function switchTab(tab) {
    $$('.result-tabs [role="tab"]').forEach((button) => {
      const active = button.dataset.tab === tab;
      button.setAttribute('aria-selected', String(active));
    });
    ['table', 'chart', 'sql'].forEach((name) => {
      const panel = $(`#${name}Panel`);
      if (panel) panel.hidden = name !== tab;
    });
  }

  function renderExample(prompt) {
    clearTimeout(runTimer);
    activePrompt = prompt;
    userMessage.textContent = prompt;
    $('.assistant-name small').textContent = '正在生成示例';
    intro.innerHTML = '<p>正在整理演示数据，请稍候…</p>';
    resultCard.hidden = true;
    insight.hidden = true;
    $('.chat-thread').scrollTop = 0;
    runTimer = setTimeout(() => {
      $('.assistant-name small').textContent = '已完成分析';
      resultCard.hidden = false;
      insight.hidden = false;
      resultBody.innerHTML = originalBody;
      $('.result-head').innerHTML = originalResultHead;
      $$('.result-tabs button').forEach((button) => button.hidden = false);
      const normalized = prompt.toLowerCase();
      if (normalized.includes('状态')) {
        intro.innerHTML = '<p>我整理了演示订单的状态分布，<strong>已完成订单占比较高</strong>。以下结果均为虚构示例。</p>';
        $('.result-title strong').textContent = '订单状态分布';
        $('.result-subtitle').textContent = '数据来源 business_db · 演示数据';
        $('#tablePanel').innerHTML = '<table><thead><tr><th>订单状态</th><th class="number">订单数量</th><th class="number">占比</th></tr></thead><tbody><tr><td>已完成</td><td class="number">5,621</td><td class="number">61.1%</td></tr><tr><td>待发货</td><td class="number">1,532</td><td class="number">16.6%</td></tr><tr><td>配送中</td><td class="number">1,314</td><td class="number">14.3%</td></tr><tr><td>已取消</td><td class="number">722</td><td class="number">8.0%</td></tr></tbody></table>';
        $('#sqlText').textContent = 'SELECT status, COUNT(*) AS order_count\nFROM orders\nGROUP BY status\nORDER BY order_count DESC;';
        insight.innerHTML = '<span class="insight-icon">✦</span><div><strong>发现一点趋势</strong><p>已完成订单占比约为 <b>61.1%</b>，你可以继续了解待发货订单。</p></div>';
        $('.result-tabs [data-tab="chart"]').hidden = true;
        $('.result-footer>span:first-child').innerHTML = '<span class="green-dot"></span>查询成功 <i>·</i> 4 行结果 <i>·</i> 0.18 秒';
      } else if (normalized.includes('商品') || normalized.includes('客户')) {
        intro.innerHTML = '<p>这是为你准备的界面示例。<strong>当前原型未连接数据库</strong>，暂不生成此问题的真实查询结果。</p><p>你可以查看默认的订单趋势示例，感受查询和结果展示方式。</p>';
        resultCard.hidden = true;
        insight.hidden = true;
      } else if (normalized.includes('近六个月') || normalized === '订单趋势') {
        intro.innerHTML = originalIntro;
        insight.innerHTML = originalInsight;
        $('.result-footer>span:first-child').innerHTML = '<span class="green-dot"></span>查询成功 <i>·</i> 6 行结果 <i>·</i> 0.24 秒';
      } else {
        intro.innerHTML = '<p>这是用于设计评审的交互原型，目前只能展示预设示例，<strong>不会连接数据库或生成真实答案</strong>。</p><p>可以点击下方“订单状态分布”，或新建对话查看空状态。</p>';
        resultCard.hidden = true;
        insight.hidden = true;
      }
      switchTab('table');
    }, 450);
  }

  function newConversation() {
    clearTimeout(runTimer);
    activePrompt = '';
    userMessage.textContent = '开始一个新的数据对话';
    $('.assistant-name small').textContent = '准备就绪';
    intro.innerHTML = '<p>你好！选择下方示例问题，看看数据助手如何帮助你探索数据。</p><p>当前为界面演示，不会连接或操作真实数据库。</p>';
    resultCard.hidden = true;
    insight.hidden = true;
    $$('.history-item').forEach((item) => item.classList.remove('selected'));
    $('#question').value = '';
    $('#question').focus();
  }

  function showSource() {
    openDialog('数据源详情', '<p>查看当前工作区中的示例数据源及访问范围。</p><div class="dialog-row"><span>数据源</span><strong>business_db</strong></div><div class="dialog-row"><span>数据库类型</span><strong>MySQL 8.0 · 演示</strong></div><div class="dialog-row"><span>连接器</span><strong>本地连接器 · 演示在线</strong></div><div class="dialog-row"><span>访问模式</span><strong>只读</strong></div><div class="dialog-row"><span>结构同步</span><strong>演示快照</strong></div><div class="dialog-note">这是设计原型，以上状态和配置均为演示，不会连接数据库或保存凭证。</div>');
  }

  function showWritePreview() {
    openDialog('预览数据修改', '<p>数据变更需要独立授权与明确确认。以下仅展示未来的交互方式。</p><div class="dialog-row"><span>目标数据源</span><strong>business_db</strong></div><div class="dialog-row"><span>目标数据表</span><strong>orders</strong></div><div class="dialog-row"><span>拟执行操作</span><strong>更新订单状态</strong></div><div class="dialog-row"><span>预计影响</span><strong>3 条演示记录</strong></div><div class="dialog-row"><span>预览有效期</span><strong>5 分钟（示例）</strong></div><div class="dialog-note warning">写入能力在通过安全验证前保持关闭。此处仅为演示，不会修改任何数据。</div>', '<button class="outline-button dialog-close">取消</button><button class="dialog-primary" id="confirmWriteDemo">体验确认状态</button>');
  }

  $('#composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const prompt = $('#question').value.trim();
    if (!prompt) { notify('请输入问题，或选择一个示例'); return; }
    if (/删除|修改|更新|写入|变更/.test(prompt)) { showWritePreview(); return; }
    renderExample(prompt);
    $('#question').value = '';
  });
  $('#question').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('#composer').requestSubmit();
    }
  });
  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    const question = event.target.closest('[data-prompt]');
    const table = event.target.closest('[data-table]');
    const nav = event.target.closest('[data-view]');
    if (tab) switchTab(tab.dataset.tab);
    if (question) { renderExample(question.dataset.prompt); $$('.history-item').forEach((item) => item.classList.toggle('selected', item === question)); }
    if (table) {
      const labels = { orders: '订单信息 · 12 个字段', order_items: '订单明细 · 8 个字段', customers: '客户信息 · 10 个字段', products: '商品信息 · 9 个字段' };
      openDialog('数据表详情', `<div class="dialog-row"><span>表名</span><strong>${table.dataset.table}</strong></div><div class="dialog-row"><span>说明</span><strong>${labels[table.dataset.table] || '示例数据表'}</strong></div><div class="dialog-row"><span>数据源</span><strong>business_db</strong></div><div class="dialog-note">仅展示演示结构；实际字段和授权范围以数据库连接及安全策略为准。</div>`);
    }
    if (nav) {
      if (nav.dataset.view === 'sources') showSource();
      else if (nav.dataset.view === 'history') openDialog('查询历史', '<p>这里将展示当前工作区有权查看的查询和执行记录。</p><div class="dialog-row"><span>今天</span><strong>近六个月订单趋势 · 已完成</strong></div><div class="dialog-note">历史记录为演示内容；真实产品中会根据当前授权控制可见范围。</div>');
      else if (nav.dataset.view === 'settings') openDialog('设置', '<p>模型、安全策略和工作区配置将在这里集中管理。</p><div class="dialog-note">此页面为设计占位，不会保存任何设置。</div>');
      else { $('#sidebar').classList.remove('open'); $('#mobileMenu').setAttribute('aria-expanded', 'false'); }
    }
    if (event.target.closest('.dialog-close')) dialog.close();
    if (event.target.closest('#confirmWriteDemo')) openDialog('确认状态演示', '<div class="dialog-note warning">演示已结束。当前原型不会确认、提交或执行数据库变更。</div><p>正式产品会重新验证权限、预览内容和数据状态。</p>');
    if (event.target.closest('#copySql')) { const sql = $('#sqlText').textContent; if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(sql).then(() => notify('示例 SQL 已复制')).catch(() => notify('无法复制，请手动选择文本')); else notify('请手动选择并复制示例 SQL'); }
    if (event.target.closest('#resultMore')) notify('这是本地演示结果，并非真实数据库查询');
  });
  $('#sourceButton').addEventListener('click', showSource);
  $('#configureSource').addEventListener('click', showSource);
  $('#workspaceButton').addEventListener('click', () => openDialog('我的工作区', '<p>工作区用于组织数据源、对话和保存的分析。</p><div class="dialog-row"><span>当前工作区</span><strong>我的工作区</strong></div><div class="dialog-row"><span>访问权限</span><strong>工作区管理员 · 演示</strong></div><div class="dialog-note">当前仅显示单个示例工作区。</div>'));
  $('#newButton').addEventListener('click', newConversation);
  $('#newConversation').addEventListener('click', newConversation);
  $('#writeDemo').addEventListener('click', showWritePreview);
  $('#runAgain').addEventListener('click', () => activePrompt ? renderExample(activePrompt) : notify('请先选择一个示例问题'));
  $('#explainButton').addEventListener('click', () => openDialog('查询说明', '<p>示例按月份汇总订单数量和订单金额，并按时间排序。</p><div class="dialog-note">演示 SQL 和数据仅用于展示界面，并非实际执行结果。</div>'));
  $('#contextInfo').addEventListener('click', () => openDialog('当前上下文', '<p>这里展示当前数据源、可访问的相关表，以及本次查询的处理状态。</p><div class="dialog-note">真实权限始终由服务端与 Connector 验证。</div>'));
  $('#demoInfo').addEventListener('click', () => openDialog('关于这个原型', '<p>这是用于评审视觉和交互的本地静态原型，所有数据、状态和结果均为演示。</p><div class="dialog-note">它不会连接 MySQL、调用模型、保存配置或执行任何操作。</div>'));
  $('#closeDialog').addEventListener('click', () => dialog.close());
  $('#schemaToggle').addEventListener('click', (event) => { const button = event.currentTarget; const hidden = !$('#schemaTree').hidden; $('#schemaTree').hidden = hidden; button.setAttribute('aria-expanded', String(!hidden)); });
  $('#mobileMenu').addEventListener('click', (event) => { const open = $('#sidebar').classList.toggle('open'); event.currentTarget.setAttribute('aria-expanded', String(open)); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !dialog.open) { $('#sidebar').classList.remove('open'); $('#mobileMenu').setAttribute('aria-expanded', 'false'); } });
})();
