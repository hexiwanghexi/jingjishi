'use strict';

/* ============ 常量与工具 ============ */
const STORE_KEY = 'jjxs_hr_progress_v1';
const INTV = [1, 2, 4, 7, 15]; // 艾宾浩斯间隔(天)
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
const dstr = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const today = () => dstr(new Date());
const addDays = (base, n) => { const d = new Date(base + 'T00:00:00'); d.setDate(d.getDate()+n); return dstr(d); };
const LETTERS = ['A','B','C','D','E'];
const ringSvg = pct => { const r = 30, c = 2 * Math.PI * r;
  return `<div class="ring"><svg viewBox="0 0 74 74">
    <circle cx="37" cy="37" r="${r}" fill="none" stroke="var(--line)" stroke-width="7"/>
    <circle cx="37" cy="37" r="${r}" fill="none" stroke="var(--accent)" stroke-width="7"
      stroke-linecap="round" stroke-dasharray="${(c*pct/100).toFixed(1)} ${c.toFixed(1)}"/>
  </svg><div class="num">${pct}%</div></div>`;
};

function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2000);
}

function modal({title, body, buttons}) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><p>${body}</p>${buttons.map((b,i)=>`<button class="btn ${b.cls||''}" data-i="${i}">${esc(b.text)}</button>`).join('')}</div>`;
  mask.addEventListener('click', e => {
    if (e.target === mask) { mask.remove(); }
    const btn = e.target.closest('[data-i]');
    if (btn) { mask.remove(); buttons[+btn.dataset.i].onClick?.(); }
  });
  document.body.appendChild(mask);
}

/* ============ 题库加载 ============ */
let BANK = null;
let UNITS = {};          // id -> unit（两科合并，复习/错题本共用）
let CHAPTER_UNITS = [];  // 人力 [{chapter, ids:[]}]
let ECON_UNITS = [];     // 经济 [{chapter, ids:[]}]
let TOTAL = 0, HR_TOTAL = 0, ECON_TOTAL = 0;

async function loadBank() {
  BANK = window.BANK_DATA;
  const build = (subject, store) => {
    let total = 0;
    for (const chap of subject.chapters) {
      const ids = [];
      for (const q of chap.questions) {
        if (q.type === 'case') {
          for (const sub of q.subQuestions) {
            if (UNITS[sub.id]) console.warn('重复题号:', sub.id);
            UNITS[sub.id] = { ...sub, badgeType: 'case', material: q.material, chapterId: chap.id, subject: subject.id };
            ids.push(sub.id);
          }
        } else {
          if (UNITS[q.id]) console.warn('重复题号:', q.id);
          UNITS[q.id] = { ...q, badgeType: q.type, chapterId: chap.id, subject: subject.id };
          ids.push(q.id);
        }
      }
      store.push({ chapter: chap, ids });
      total += ids.length;
    }
    return total;
  };
  HR_TOTAL = build(BANK.subjects.find(s => s.id === 'hr'), CHAPTER_UNITS);
  ECON_TOTAL = build(BANK.subjects.find(s => s.id === 'econ'), ECON_UNITS);
  TOTAL = HR_TOTAL + ECON_TOTAL;
}

/* ============ 进度存取 ============ */
let P = null;

function defaultProgress() { return { version: 1, updatedAt: Date.now(), q: {}, daily: {} }; }

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && obj.q && obj.daily) { P = obj; return; }
    }
  } catch (e) { /* 损坏则重建 */ }
  P = defaultProgress();
}

function save() { P.updatedAt = Date.now(); localStorage.setItem(STORE_KEY, JSON.stringify(P)); }

function rec(id) { return P.q[id] || (P.q[id] = { done: false, wrong: 0, attempts: 0, correct: 0, box: 0, due: null }); }

function dailyRec(date) { return P.daily[date] || (P.daily[date] = { n: 0, c: 0 }); }

/* 记录一次作答 */
function recordAnswer(id, ok) {
  const r = rec(id);
  r.attempts++;
  const d = dailyRec(today());
  d.n++; if (ok) d.c++;
  if (ok) {
    r.correct++;
    if (!r.done) r.done = true;
    if (r.box >= INTV.length - 1) { r.box = INTV.length; r.due = null; }   // 毕业
    else { r.due = addDays(today(), INTV[r.box]); r.box++; }
  } else {
    r.wrong++;
    r.box = 0;
    r.due = addDays(today(), 1);
  }
  save();
}

const isMastered = id => (P.q[id]?.box ?? 0) >= INTV.length;
const dueIds = () => Object.keys(P.q).filter(id => UNITS[id] && P.q[id].due && P.q[id].due <= today());
const wrongIds = () => Object.keys(P.q).filter(id => UNITS[id] && (P.q[id]?.wrong > 0) && !isMastered(id));

function chapterDone(ch) {
  const ids = CHAPTER_UNITS[ch].ids;
  const done = ids.filter(id => P.q[id]?.done).length;
  return { done, total: ids.length, pct: Math.round(done / ids.length * 100) };
}

/* ============ 路由 ============ */
const ROUTES = {};
let CUR_TAB = 'chapters';
let SESSION = null; // 进行中的答题会话

function nav(hash) { if (location.hash === hash) render(); else location.hash = hash; }

window.addEventListener('hashchange', render);

function parseHash() {
  const h = (location.hash || '#/chapters').slice(2);
  const [name, ...rest] = h.split('/');
  return { name: name || 'chapters', args: rest };
}

function render() {
  const { name, args } = parseHash();
  const view = $('#view');
  window.scrollTo(0, 0);
  const inSession = name === 'session';
  $('#tabbar').style.display = inSession ? 'none' : 'flex';
  $('#btn-back').hidden = !(inSession || name === 'picker' || name === 'settings');
  $('#topbar-right').innerHTML = '';
  if (ROUTES[name]) {
    $('#topbar-title').textContent = ROUTES[name].title(args);
    CUR_TAB = ['chapters','econ','review','wrong','stats'].includes(name) ? name : CUR_TAB;
    view.innerHTML = ROUTES[name].render(args);
    ROUTES[name].after?.(args);
  } else {
    nav('#/chapters');
  }
  document.querySelectorAll('.tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === CUR_TAB);
    const hasDot = el.dataset.tab === 'review' && dueIds().length > 0;
    el.querySelector('span').classList.toggle('dot', hasDot);
  });
}

document.querySelectorAll('.tab').forEach(el =>
  el.addEventListener('click', () => nav('#/' + el.dataset.tab)));
$('#btn-back').addEventListener('click', () => {
  if (location.hash.startsWith('#/picker/econ')) { nav('#/econ'); return; }
  if (location.hash.startsWith('#/picker/')) { nav('#/chapters'); return; }
  if (location.hash.startsWith('#/settings')) { nav('#/stats'); return; }
  history.back();
});

/* ============ 视图：章节 ============ */
ROUTES.chapters = {
  title: () => '章节 · 人力资源管理',
  render() {
    const overall = (() => {
      let done = 0;
      CHAPTER_UNITS.forEach((c, i) => done += chapterDone(i).done);
      return Math.round(done / HR_TOTAL * 100);
    })();
    const due = dueIds().length;
    const hero = `<div class="card hero">${ringSvg(overall)}
      <div class="hero-info">
        <h2>人力资源管理专业知识和实务</h2>
        <p>中级经济师 · ${CHAPTER_UNITS.length} 章 · 共 ${HR_TOTAL} 题</p>
        <div class="hero-tags">
          <span class="tag">今日待复习 ${due}</span>
          <span class="tag ${overall >= 100 ? 'ok' : 'warn'}">总进度 ${overall}%</span>
        </div>
      </div>
    </div>`;
    const list = CHAPTER_UNITS.map((c, i) => {
      const { done, total, pct } = chapterDone(i);
      return `<button class="card chapter" data-ch="${i}">
        <div class="row1">
          <span class="no">${pad(i+1).replace(/^0/,'')}</span>
          <span class="name">${esc(c.chapter.title)}</span>
          <span class="pct ${pct >= 100 ? 'done' : ''}">${pct >= 100 ? '✓ 已完成' : pct + '%'}</span>
        </div>
        <div class="bar"><i class="${pct >= 100 ? 'full' : ''}" style="width:${pct}%"></i></div>
        <div class="meta"><span>共 ${total} 题</span><span>已掌握 ${done}</span></div>
      </button>`;
    }).join('');
    return hero + list;
  },
  after() {
    document.querySelectorAll('[data-ch]').forEach(el =>
      el.addEventListener('click', () => nav('#/picker/' + el.dataset.ch)));
  }
};

/* ============ 视图：章节选题 ============ */
// args: [章索引] → 人力；['econ', 章索引] → 经济基础
function pickerCtx(args) {
  if (args[0] === 'econ') return { subject: 'econ', units: ECON_UNITS, i: +args[1] };
  return { subject: 'hr', units: CHAPTER_UNITS, i: +args[0] };
}

ROUTES.picker = {
  title: (args) => { const { units, i } = pickerCtx(args); return `第${i+1}章 ${units[i].chapter.title}`; },
  render(args) {
    const { subject, units, i } = pickerCtx(args);
    const c = units[i];
    const doneN = c.ids.filter(id => P.q[id]?.done).length;
    const groups = [
      { label: subject === 'econ' ? '历年真题' : '核心母题', g: 'master', list: [] },
      { label: '章节练习', g: 'extra', list: [] }
    ];
    c.ids.forEach((id, k) => groups[id.includes('-p') ? 1 : 0].list.push({ id, k }));
    const cellCls = id => {
      const r = P.q[id];
      if (!r || !r.attempts) return 'todo';
      if (isMastered(id)) return 'master';
      return r.done ? 'ok' : 'bad';
    };
    const grid = g => `<div class="sec-title">${g.label}</div><div class="q-grid" data-g="${g.g}">${
      g.list.map((it, n) => `<button class="q-cell ${cellCls(it.id)}" data-k="${it.k}">${n+1}</button>`).join('')}</div>`;
    const undoN = c.ids.length - doneN;
    return `
    <div class="card picker-head">
      <div class="bar"><i style="width:${Math.round(doneN/c.ids.length*100)}%"></i></div>
      <div class="meta"><span>共 ${c.ids.length} 题</span><span>已答对 ${doneN}</span></div>
    </div>
    ${groups[0].list.length ? grid(groups[0]) : ''}
    ${groups[1].list.length ? grid(groups[1]) : ''}
    <div class="legend">
      <span><i class="sw todo"></i>未做</span><span><i class="sw bad"></i>错过</span>
      <span><i class="sw ok"></i>答对过</span><span><i class="sw master">★</i>彻底掌握</span>
    </div>
    <div class="picker-actions">
      <button class="btn" id="btn-all">顺序刷全章</button>
      ${undoN ? `<button class="btn subtle" id="btn-undo">只刷未掌握（${undoN}）</button>` : ''}
    </div>`;
  },
  after(args) {
    const { subject, i } = pickerCtx(args);
    const kindAll = subject === 'econ' ? 'econ' : 'chapter';
    const kindUndo = subject === 'econ' ? 'econ_undo' : 'chapter_undo';
    document.querySelectorAll('.q-cell').forEach(el =>
      el.addEventListener('click', () => startSession(kindAll, i, +el.dataset.k)));
    $('#btn-all')?.addEventListener('click', () => startSession(kindAll, i));
    $('#btn-undo')?.addEventListener('click', () => startSession(kindUndo, i));
  }
};

/* ============ 答题会话 ============ */
function startSession(kind, chapterIdx, fromIdx = 0) {
  let ids = [], title = '';
  if (kind === 'chapter') {
    ids = CHAPTER_UNITS[chapterIdx].ids.slice(fromIdx);
    title = `第${chapterIdx+1}章 ${CHAPTER_UNITS[chapterIdx].chapter.title}`;
  } else if (kind === 'chapter_undo') {
    ids = CHAPTER_UNITS[chapterIdx].ids.filter(id => !P.q[id]?.done);
    title = `第${chapterIdx+1}章 ${CHAPTER_UNITS[chapterIdx].chapter.title} · 未掌握`;
  } else if (kind === 'review') {
    ids = dueIds().sort();
    title = '今日复习';
  } else if (kind === 'econ') {
    ids = ECON_UNITS[chapterIdx].ids.slice(fromIdx);
    title = `第${chapterIdx+1}章 ${ECON_UNITS[chapterIdx].chapter.title}`;
  } else if (kind === 'econ_undo') {
    ids = ECON_UNITS[chapterIdx].ids.filter(id => !P.q[id]?.done);
    title = `第${chapterIdx+1}章 ${ECON_UNITS[chapterIdx].chapter.title} · 未掌握`;
  } else if (kind === 'wrong') {
    ids = wrongIds().sort();
    title = '错题重刷';
  }
  if (!ids.length) { toast(kind === 'review' ? '今天没有到期的复习题' : '没有可刷的题'); return; }
  SESSION = { kind, chapterIdx, title, queue: ids, idx: 0, answered: 0, correct: 0 };
  nav('#/session');
}

ROUTES.session = {
  title: (args) => SESSION ? SESSION.title : '答题',
  render() {
    if (!SESSION) { setTimeout(() => nav('#/chapters')); return '<div class="empty"></div>'; }
    if (SESSION.idx >= SESSION.queue.length) return renderSummary();
    return renderQuestion();
  },
  after() {
    if (SESSION && SESSION.idx < SESSION.queue.length) bindQuestion();
    else bindSummary();
  }
};

function renderQuestion() {
  const id = SESSION.queue[SESSION.idx];
  const u = UNITS[id];
  const opts = LETTERS.filter(l => u.options[l]).map(l =>
    `<button class="opt" data-l="${l}"><span class="letter">${l}</span><span>${esc(u.options[l])}</span></button>`).join('');
  const badge = u.badgeType === 'case' ? '<span class="badge case">不定项</span>'
    : u.type === 'multi' ? '<span class="badge multi">多选题</span>' : '<span class="badge single">单选题</span>';
  const material = u.material ? `<div class="material">${esc(u.material)}</div>` : '';
  const stem = esc(u.stem).replace(/（\s*）/, '<span class="blank">（&nbsp;&nbsp;&nbsp;&nbsp;）</span>');
  return `
  <div class="q-head">
    ${badge}
    <div class="q-bar"><i style="width:${(SESSION.idx)/SESSION.queue.length*100}%"></i></div>
    <span class="q-progress">${SESSION.idx+1}/${SESSION.queue.length}</span>
  </div>
  ${material}
  <div class="stem">${stem}</div>
  <div class="opts">${opts}</div>
  <div class="actions" id="q-actions"></div>`;
}

let QSTATE = null; // {selected:Set, submitted:bool, id}

function bindQuestion() {
  const id = SESSION.queue[SESSION.idx];
  const u = UNITS[id];
  QSTATE = { id, selected: new Set(), submitted: false };
  const isMulti = u.type === 'multi';

  document.querySelectorAll('.opt').forEach(el => {
    el.addEventListener('click', () => {
      if (QSTATE.submitted) return;
      const l = el.dataset.l;
      if (isMulti) {
        el.classList.toggle('selected');
        QSTATE.selected.has(l) ? QSTATE.selected.delete(l) : QSTATE.selected.add(l);
        renderSubmitBar();
      } else {
        QSTATE.selected = new Set([l]);
        submit();
      }
    });
  });
  if (isMulti) renderSubmitBar();
}

function renderSubmitBar() {
  const bar = $('#q-actions');
  const n = QSTATE.selected.size;
  bar.innerHTML = `<button class="btn" id="btn-submit" ${n ? '' : 'disabled'}>提交（已选 ${n} 项）</button>`;
  $('#btn-submit')?.addEventListener('click', submit);
}

function submit() {
  if (QSTATE.submitted || QSTATE.selected.size === 0) return;
  QSTATE.submitted = true;
  const u = UNITS[QSTATE.id];
  const correct = [...u.answer].sort().join('');
  const mine = [...QSTATE.selected].sort().join('');
  const ok = mine === correct;
  recordAnswer(QSTATE.id, ok);
  SESSION.answered++;
  if (ok) SESSION.correct++;

  document.querySelectorAll('.opt').forEach(el => {
    const l = el.dataset.l;
    el.classList.remove('selected');
    if (correct.includes(l)) el.classList.add('correct');
    else if (mine.includes(l)) el.classList.add('wrong');
    else el.classList.add('dim');
  });

  const oa = u.optionAnalysis && Object.keys(u.optionAnalysis).length
    ? `<div class="opt-analysis">${LETTERS.filter(l=>u.optionAnalysis[l]).map(l =>
        `<p><b>${l}项</b>：${esc(u.optionAnalysis[l])}</p>`).join('')}</div>` : '';
  const fb = document.createElement('div');
  fb.className = `feedback ${ok ? 'ok' : 'bad'}`;
  fb.innerHTML = `
    <div class="verdict">${ok ? '✓ 回答正确' : '✗ 回答错误'}</div>
    <div class="ans-line">正确答案：<b>${correct}</b>${ok ? '' : `　你的答案：<b style="color:var(--bad)">${mine}</b>`}</div>
    <div class="analysis">${esc(u.analysis || '（本题无解析）')}${oa}</div>`;
  $('#q-actions').innerHTML = '';
  $('#q-actions').appendChild(fb);
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.style.marginTop = '12px';
  btn.textContent = SESSION.idx + 1 >= SESSION.queue.length ? '查看总结' : '下一题';
  btn.addEventListener('click', () => { SESSION.idx++; render(); });
  $('#q-actions').appendChild(btn);
  fb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ============ 会话总结 ============ */
function renderSummary() {
  const acc = SESSION.answered ? Math.round(SESSION.correct / SESSION.answered * 100) : 0;
  const emo = acc === 100 ? '🎉' : acc >= 80 ? '👍' : '💪';
  return `<div class="card summary">
    <div class="confetti">${emo}</div>
    <div class="big">${acc}<small>%</small></div>
    <div class="lbl">本次正确率</div>
    <div class="grid">
      <div class="cell"><b>${SESSION.answered}</b><span>答题数</span></div>
      <div class="cell"><b>${SESSION.correct}</b><span>答对数</span></div>
    </div>
    <div id="sum-btns"></div>
  </div>`;
}

function bindSummary() {
  const box = $('#sum-btns');
  if (!box) return;
  const mk = (text, cls, fn) => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = text; b.style.marginTop = '10px'; b.addEventListener('click', fn); return b; };
  if (SESSION.kind === 'chapter' || SESSION.kind === 'chapter_undo') {
    const undone = CHAPTER_UNITS[SESSION.chapterIdx].ids.filter(id => !P.q[id]?.done).length;
    if (undone) box.appendChild(mk(`只刷未掌握的题（${undone}）`, 'subtle', () => startSession('chapter_undo', SESSION.chapterIdx)));
    box.appendChild(mk('再刷一遍全章', 'subtle', () => startSession('chapter', SESSION.chapterIdx)));
    box.appendChild(mk('返回选题', 'ghost', () => nav('#/picker/' + SESSION.chapterIdx)));
    box.appendChild(mk('返回章节列表', 'ghost', () => nav('#/chapters')));
  } else if (SESSION.kind === 'econ' || SESSION.kind === 'econ_undo') {
    const undone = ECON_UNITS[SESSION.chapterIdx].ids.filter(id => !P.q[id]?.done).length;
    if (undone) box.appendChild(mk(`只刷未掌握的题（${undone}）`, 'subtle', () => startSession('econ_undo', SESSION.chapterIdx)));
    box.appendChild(mk('再刷一遍本章', 'subtle', () => startSession('econ', SESSION.chapterIdx)));
    box.appendChild(mk('返回选题', 'ghost', () => nav('#/picker/econ/' + SESSION.chapterIdx)));
    box.appendChild(mk('返回经济基础', 'ghost', () => nav('#/econ')));
  } else {
    box.appendChild(mk(SESSION.kind === 'review' ? '返回复习页' : '返回错题本', 'ghost', () =>
      nav(SESSION.kind === 'review' ? '#/review' : '#/wrong')));
  }
}

/* ============ 视图：复习 ============ */
ROUTES.review = {
  title: () => '复习计划',
  render() {
    const due = dueIds();
    const masteredN = Object.keys(P.q).filter(isMastered).length;
    const inQueue = Object.values(P.q).filter(r => r.due).length;
    const upcoming = (() => {
      const cnt = {};
      for (const r of Object.values(P.q)) if (r.due && r.due > today()) cnt[r.due] = (cnt[r.due]||0)+1;
      return Object.entries(cnt).sort().slice(0, 7);
    })();
    return `
    <div class="card today-card">
      <div class="n ${due.length ? '' : 'zero'}">${due.length}</div>
      <p>${due.length ? '题今天到期，趁记忆还在快来巩固' : '今天没有到期的复习题，太棒了！'}</p>
      ${due.length ? `<button class="btn" id="btn-review">开始复习</button>` : `<button class="btn subtle" id="btn-review-any">去刷新题</button>`}
    </div>
    <div class="mini-stats">
      <div class="cell"><b>${masteredN}</b><span>已彻底掌握</span></div>
      <div class="cell"><b>${inQueue}</b><span>复习队列中</span></div>
      <div class="cell"><b>${TOTAL - masteredN}</b><span>尚未掌握</span></div>
    </div>
    ${upcoming.length ? `<div class="sec-title">接下来几天</div>
    <div class="card">${upcoming.map(([d, n]) => `
      <div class="set-row" style="padding:11px 4px">
        <div class="ic">📅</div>
        <div class="tx"><b>${d.slice(5).replace('-','月')}日</b></div>
        <div class="arrow">${n} 题</div>
      </div>`).join('')}</div>` : ''}
    <div class="card" style="font-size:.78rem;color:var(--sub)">
      复习规则（艾宾浩斯遗忘曲线）：答错的题第 2 天重现；答对后按 1、2、4、7、15 天间隔安排下次复习，连续通过全部间隔即彻底掌握。
    </div>`;
  },
  after() {
    $('#btn-review')?.addEventListener('click', () => startSession('review'));
    $('#btn-review-any')?.addEventListener('click', () => nav('#/chapters'));
  }
};

/* ============ 视图：经济基础 ============ */
ROUTES.econ = {
  title: () => '经济基础知识',
  render() {
    const overall = (() => {
      let done = 0;
      ECON_UNITS.forEach(c => done += c.ids.filter(id => P.q[id]?.done).length);
      return Math.round(done / ECON_TOTAL * 100);
    })();
    const due = dueIds().length;
    const hero = `<div class="card hero">${ringSvg(overall)}
      <div class="hero-info">
        <h2>经济基础知识</h2>
        <p>中级经济师 · ${ECON_UNITS.length} 章 · 共 ${ECON_TOTAL} 题</p>
        <div class="hero-tags">
          <span class="tag">今日待复习 ${due}</span>
          <span class="tag ${overall >= 100 ? 'ok' : 'warn'}">总进度 ${overall}%</span>
        </div>
      </div>
    </div>`;
    const list = ECON_UNITS.map((c, i) => {
      const done = c.ids.filter(id => P.q[id]?.done).length;
      const pct = Math.round(done / c.ids.length * 100);
      return `<button class="card chapter" data-ech="${i}">
        <div class="row1">
          <span class="no">${i+1}</span>
          <span class="name">${esc(c.chapter.title)}</span>
          <span class="pct ${pct >= 100 ? 'done' : ''}">${pct >= 100 ? '✓ 已完成' : pct + '%'}</span>
        </div>
        <div class="bar"><i class="${pct >= 100 ? 'full' : ''}" style="width:${pct}%"></i></div>
        <div class="meta"><span>共 ${c.ids.length} 题</span><span>已掌握 ${done}</span></div>
      </button>`;
    }).join('');
    return hero + list;
  },
  after() {
    document.querySelectorAll('[data-ech]').forEach(el =>
      el.addEventListener('click', () => nav('#/picker/econ/' + el.dataset.ech)));
  }
};

/* ============ 视图：错题本 ============ */
ROUTES.wrong = {
  title: () => '错题本',
  render() {
    const ids = wrongIds();
    const histN = Object.entries(P.q).filter(([id, r]) => UNITS[id] && r.wrong > 0).length;
    if (!ids.length) {
      return `<div class="card empty"><div class="big">✨</div>错题本是空的<br><span style="font-size:.78rem">答错的题会自动收进来，直到你彻底掌握它</span></div>
      ${histN ? `<div class="card" style="text-align:center;font-size:.8rem;color:var(--sub)">历史错题 ${histN} 道，均已彻底掌握 🎉</div>` : ''}`;
    }
    const list = ids.sort().map(id => {
      const u = UNITS[id];
      const r = P.q[id];
      return `<button class="card wrong-item" data-id="${id}">
        <div class="info">
          <div class="stem-line">${esc(u.stem)}</div>
          <div class="sub-line">${u.subject === 'econ' ? '经济' : '人力'} · 第${u.chapterId}章 · 错过 ${r.wrong} 次 · ${r.due ? '下次复习 ' + r.due.slice(5) : ''}</div>
        </div><span class="go">重刷</span>
      </button>`;
    }).join('');
    return `
    <div class="card today-card" style="padding:20px 16px">
      <div style="font-size:.85rem;color:var(--sub)">当前待消灭错题</div>
      <div class="n" style="font-size:2.2rem">${ids.length}</div>
      <button class="btn" id="btn-wrong-all">开始刷错题</button>
    </div>
    <div class="sec-title">错题列表（按章节排序）</div>${list}`;
  },
  after() {
    $('#btn-wrong-all')?.addEventListener('click', () => startSession('wrong'));
    document.querySelectorAll('[data-id]').forEach(el =>
      el.addEventListener('click', () => startSession('wrong')));
  }
};

/* ============ 视图：统计 ============ */
let CAL_MONTH = null;
ROUTES.stats = {
  title: () => '学习记录',
  render() {
    if (!CAL_MONTH) { const n = new Date(); CAL_MONTH = [n.getFullYear(), n.getMonth()]; }
    const days = Object.entries(P.daily).filter(([,v]) => v.n > 0);
    const totN = days.reduce((s,[,v]) => s+v.n, 0), totC = days.reduce((s,[,v]) => s+v.c, 0);
    const streak = calcStreak();
    const doneN = Object.keys(P.q).filter(id => UNITS[id] && P.q[id].done).length;
    const masteredN = Object.keys(P.q).filter(isMastered).length;
    const t = today();
    const todayRec = P.daily[t];

    const [y, m] = CAL_MONTH;
    const first = new Date(y, m, 1), last = new Date(y, m+1, 0);
    const lead = first.getDay();
    let cells = ['日','一','二','三','四','五','六'].map(w => `<div class="wd">${w}</div>`).join('');
    for (let i = 0; i < lead; i++) cells += '<div class="d future"></div>';
    for (let d = 1; d <= last.getDate(); d++) {
      const ds = `${y}-${pad(m+1)}-${pad(d)}`;
      const rec = P.daily[ds];
      const lvl = !rec || !rec.n ? '' : rec.n < 10 ? 'l1' : rec.n < 30 ? 'l2' : rec.n < 60 ? 'l3' : 'l4';
      cells += `<div class="d ${lvl} ${ds===t?'today':''} ${ds>t?'future':''}" ${rec?`title="${ds}：${rec.n} 题，正确 ${Math.round(rec.c/rec.n*100)}%"`:''}>${d}</div>`;
    }
    return `
    <div class="card stat-hero">
      <div class="fire"><b>${streak}</b><span>连续打卡(天)</span></div>
      <div><b>${totN}</b><span>累计刷题</span></div>
      <div><b>${totN ? Math.round(totC/totN*100)+'%' : '—'}</b><span>总正确率</span></div>
    </div>
    ${todayRec?.n ? `<div class="card" style="text-align:center;font-size:.82rem">今天已刷 <b>${todayRec.n}</b> 题，正确率 <b>${Math.round(todayRec.c/todayRec.n*100)}%</b></div>`
      : `<div class="card" style="text-align:center;font-size:.82rem;color:var(--sub)">今天还没刷题，开一局？</div>`}
    <div class="card">
      <div class="cal-head">
        <button id="cal-prev">‹ 上月</button>
        <b>${y} 年 ${m+1} 月</b>
        <button id="cal-next">下月 ›</button>
      </div>
      <div class="cal">${cells}</div>
      <div class="cal-legend">少 <i style="background:var(--line)"></i><i style="background:#dce4fd"></i><i style="background:#a8bcfa"></i><i style="background:#6c8bff"></i><i style="background:var(--accent)"></i> 多</div>
    </div>
    <div class="mini-stats" style="grid-template-columns:1fr 1fr">
      <div class="cell"><b>${doneN}/${TOTAL}</b><span>题目完成度</span></div>
      <div class="cell"><b>${masteredN}</b><span>彻底掌握</span></div>
    </div>`;
  },
  after() {
    // render() 会清空 #topbar-right，但 stats._rerender() 直调 after() 不清空，需幂等守卫
    if (!$('#btn-settings-top')) {
      const gear = document.createElement('button');
      gear.id = 'btn-settings-top';
      gear.className = 'icon-btn';
      gear.setAttribute('aria-label', '设置');
      gear.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.4 4a8.4 8.4 0 0 0-.12-1.4l2.02-1.56-2-3.46-2.4.96a8.5 8.5 0 0 0-2.42-1.4L15.1 2.6h-4l-.38 2.54a8.5 8.5 0 0 0-2.42 1.4l-2.4-.96-2 3.46 2.02 1.56a8.4 8.4 0 0 0 0 2.8L3.9 15.08l2 3.46 2.4-.96a8.5 8.5 0 0 0 2.42 1.4l.38 2.54h4l.38-2.54a8.5 8.5 0 0 0 2.42-1.4l2.4.96 2-3.46-2.02-1.56c.08-.46.12-.93.12-1.4z"/></svg>';
      gear.addEventListener('click', () => nav('#/settings'));
      $('#topbar-right').appendChild(gear);
    }
    $('#cal-prev')?.addEventListener('click', () => {
      CAL_MONTH[1]--; if (CAL_MONTH[1] < 0) { CAL_MONTH[1] = 11; CAL_MONTH[0]--; }
      ROUTES.stats._rerender();
    });
    $('#cal-next')?.addEventListener('click', () => {
      CAL_MONTH[1]++; if (CAL_MONTH[1] > 11) { CAL_MONTH[1] = 0; CAL_MONTH[0]++; }
      ROUTES.stats._rerender();
    });
  },
  _rerender() {
    const view = $('#view');
    view.innerHTML = ROUTES.stats.render();
    ROUTES.stats.after();
  }
};

function calcStreak() {
  let n = 0;
  let d = today();
  if (!P.daily[d]?.n) d = addDays(d, -1);           // 今天还没刷，从昨天算
  while (P.daily[d]?.n > 0) { n++; d = addDays(d, -1); }
  return n;
}

/* ============ 视图：设置 ============ */
ROUTES.settings = {
  title: () => '设置',
  render() {
    return `
    <div class="card">
      <button class="set-row" id="set-export">
        <div class="ic">📤</div>
        <div class="tx"><b>导出学习进度</b><span>下载进度文件，可存到微信收藏/网盘备份</span></div><span class="arrow">›</span>
      </button>
      <button class="set-row" id="set-import">
        <div class="ic">📥</div>
        <div class="tx"><b>导入学习进度</b><span>从进度文件恢复（会覆盖当前进度）</span></div><span class="arrow">›</span>
      </button>
      <button class="set-row danger" id="set-reset">
        <div class="ic">🗑️</div>
        <div class="tx"><b>清空所有进度</b><span>慎用！建议先导出备份</span></div><span class="arrow">›</span>
      </button>
    </div>
    <div class="card" style="font-size:.8rem;color:var(--sub);line-height:1.8">
      <b style="color:var(--text)">关于</b><br>
      题库：中级经济师双科目——人力资源管理（核心母题 505 + 章节练习 454）、经济基础（历年真题 809），共 1768 题<br>
      数据：所有进度仅保存在本机浏览器中，不上传任何服务器<br>
      小技巧：用手机浏览器的"添加到主屏幕"，即可像 App 一样全屏刷题
    </div>
    <input type="file" id="file-import" accept="application/json" hidden>`;
  },
  after() {
    $('#set-export').addEventListener('click', exportProgress);
    $('#set-import').addEventListener('click', () => $('#file-import').click());
    $('#file-import').addEventListener('change', importProgress);
    $('#set-reset').addEventListener('click', () => {
      modal({
        title: '清空所有进度？',
        body: '所有做题记录、复习队列、错题本都会被删除，且无法恢复。确定要继续吗？',
        buttons: [
          { text: '取消', cls: 'subtle' },
          { text: '确认清空', cls: 'red', onClick: () => {
              P = defaultProgress(); save(); toast('已清空'); render();
            } }
        ]
      });
    });
  }
};

function exportProgress() {
  const blob = new Blob([JSON.stringify(P, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `经济师刷题进度-${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('进度文件已下载');
}

function importProgress(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const obj = JSON.parse(reader.result);
      if (!obj || typeof obj !== 'object' || !obj.q || !obj.daily) throw new Error('bad');
      modal({
        title: '导入进度',
        body: `文件时间：${new Date(obj.updatedAt || Date.now()).toLocaleString()}\n累计刷题 ${Object.values(obj.daily).reduce((s,v)=>s+v.n,0)} 次\n将覆盖当前进度，确定导入吗？`,
        buttons: [
          { text: '取消', cls: 'subtle' },
          { text: '导入', onClick: () => {
              P = obj; save(); toast('导入成功'); CAL_MONTH = null; render();
            } }
        ]
      });
    } catch { toast('文件格式不对，导入失败'); }
  };
  reader.readAsText(file);
  e.target.value = '';
}

/* ============ 启动 ============ */
(async function boot() {
  loadProgress();
  await loadBank();
  if (!location.hash) location.hash = '#/chapters';
  render();
})();
