/* 小团体花名册 —— 前端逻辑（无任何外部依赖） */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const DAY = 86400;

  const state = {
    session: null,
    groups: [],
    syncJob: null,
    syncTimer: null,
    qrTimer: null,
    qrId: null,
    overlapSelected: new Set(),
    overlapQuery: "",
    groupFilter: "",
    groupSort: "members",
    groupMemberFilter: "",
    groupMemberSort: "active",
    memberQuery: "",
    memberMin: 1,
    activity: { mode: "active", days: 30, gc: "" },
    network: null,
    networkMin: 1,
    networkNodes: 40,
  };

  /* --------------------------------------------------------------- utils */
  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function num(value) {
    const n = Number(value || 0);
    return n.toLocaleString("zh-CN");
  }

  function pct(part, total) {
    if (!total) return "0%";
    return Math.round((part / total) * 100) + "%";
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function fmtDate(ts) {
    const n = Number(ts || 0);
    if (!n) return "—";
    const d = new Date(n * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function fmtTime(ts) {
    const n = Number(ts || 0);
    if (!n) return "—";
    const d = new Date(n * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function ago(ts) {
    const n = Number(ts || 0);
    if (!n) return "从未发言";
    const diff = Date.now() / 1000 - n;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < DAY) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;
    if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))} 个月前`;
    return `${Math.floor(diff / (365 * DAY))} 年前`;
  }

  function fmtSync(iso) {
    if (!iso) return "尚未同步";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function firstChar(text) {
    const chars = Array.from(String(text || "?"));
    return chars[0] || "?";
  }

  function gname(g) {
    return (g && (g.name || g.group_name || g.gc)) || "未知群";
  }

  function roleBadge(m) {
    if (m.is_owner) return '<span class="badge badge-amber">群主</span>';
    if (m.is_admin) return '<span class="badge badge-purple">管理员</span>';
    return '<span class="badge badge-muted">成员</span>';
  }

  function friendBadge(isFriend) {
    return isFriend
      ? '<span class="badge badge-green">好友</span>'
      : '<span class="badge badge-muted">非好友</span>';
  }

  function groupBadges(groups, max = 3) {
    const list = Array.isArray(groups) ? groups : [];
    const shown = list.slice(0, max).map((g) =>
      `<span class="badge badge-muted" title="${esc(gname(g))}">${esc(gname(g))}</span>`
    ).join("");
    const more = list.length > max ? `<span class="badge">+${list.length - max}</span>` : "";
    return `<div class="chips">${shown}${more}</div>`;
  }

  function userCell(uin, nick, card) {
    const display = nick || card || uin || "未知";
    const sub = card && card !== nick ? `${uin} · ${card}` : String(uin || "");
    return `<div class="user-cell">
      <span class="avatar">${esc(firstChar(display))}</span>
      <div class="meta">
        <div class="cell-main ellipsis" title="${esc(display)}">${esc(display)}</div>
        <div class="cell-sub mono">${esc(sub)}</div>
      </div>
    </div>`;
  }

  function statCard(label, value, sub, tone = "") {
    return `<div class="stat-card ${tone}">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${esc(value)}</div>
      <div class="stat-sub">${sub || ""}</div>
    </div>`;
  }

  function emptyState(icon, title, text, action = "") {
    return `<div class="empty">
      <div class="empty-icon">${icon}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
      ${action}
    </div>`;
  }

  function loadingBlock(text = "加载中…") {
    return `<div class="card"><div class="card-body">
      <div class="skeleton" style="height:16px;width:180px;margin-bottom:14px"></div>
      <div class="skeleton" style="height:44px;margin-bottom:10px"></div>
      <div class="skeleton" style="height:44px;margin-bottom:10px"></div>
      <div class="skeleton" style="height:44px"></div>
      <p class="muted small" style="margin-top:14px">${esc(text)}</p>
    </div></div>`;
  }

  async function api(path, options = {}) {
    const init = { ...options, headers: { ...(options.headers || {}) } };
    if (init.body && typeof init.body !== "string") {
      init.body = JSON.stringify(init.body);
      init.headers["Content-Type"] = "application/json";
    }
    const res = await fetch(path, init);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      throw new Error((data && data.error) || `请求失败 (${res.status})`);
    }
    return data;
  }

  function toast(message, type = "") {
    const root = $("#toastRoot");
    if (!root) return;
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    root.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity .25s ease";
      setTimeout(() => el.remove(), 260);
    }, 3600);
  }

  function debounce(fn, delay = 250) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  /* ------------------------------------------------------------- session */
  async function refreshSession() {
    state.session = await api("/api/session");
    updateAccountChip();
    return state.session;
  }

  function updateAccountChip() {
    const chip = $("#accountChip");
    const text = $("#accountText");
    if (!chip || !text) return;
    const s = state.session || {};
    if (s.logged_in) {
      chip.classList.add("online");
      text.textContent = s.uin ? `QQ ${s.uin}` : "已登录";
    } else {
      chip.classList.remove("online");
      text.textContent = "未登录";
    }
  }

  async function loadGroups() {
    const data = await api("/api/groups");
    state.groups = data.groups || [];
    return state.groups;
  }

  /* ---------------------------------------------------------------- sync */
  async function startSync(mode = "full", groups = []) {
    if (!state.session || !state.session.logged_in) {
      toast("请先登录 QQ", "error");
      go("#/data");
      return;
    }
    try {
      const job = await api("/api/sync", { method: "POST", body: { mode, groups } });
      state.syncJob = job;
      updateGlobalProgress(job);
      updateDataProgress(job);
      toast("同步任务已开始", "success");
      pollSync();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function stopSync() {
    try {
      const job = await api("/api/sync/stop", { method: "POST", body: {} });
      state.syncJob = job;
      toast("正在停止同步…");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  function pollSync() {
    if (state.syncTimer) clearTimeout(state.syncTimer);
    const tick = async () => {
      try {
        const job = await api("/api/sync");
        state.syncJob = job;
        updateGlobalProgress(job);
        updateDataProgress(job);
        if (job.running) {
          state.syncTimer = setTimeout(tick, 900);
          return;
        }
        state.syncTimer = null;
        await refreshSession();
        await loadGroups();
        if (job.phase === "done") toast(job.message || "同步完成", "success");
        else if (job.phase === "error") toast(job.message || "同步失败", "error");
        else if (job.phase === "stopped") toast(job.message || "同步已停止");
        renderRoute(true);
      } catch (err) {
        state.syncTimer = setTimeout(tick, 2200);
      }
    };
    tick();
  }

  function updateGlobalProgress(job) {
    const wrap = $("#globalProgress");
    const fill = $("#globalProgressFill");
    const text = $("#globalProgressText");
    if (!wrap || !fill || !text) return;
    if (!job || !job.running) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    const total = Number(job.groups_total || 0);
    const done = Number(job.groups_done || 0);
    const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 8;
    fill.style.width = `${percent}%`;
    const current = job.current ? ` · ${job.current}` : "";
    text.textContent = `${job.message || "同步中"}${current}`;
  }

  function updateDataProgress(job) {
    const fill = $("#syncProgressFill");
    const text = $("#syncProgressText");
    const errors = $("#syncErrors");
    if (!fill || !text) return;
    if (!job) {
      fill.style.width = "0%";
      text.textContent = "尚未开始";
      if (errors) errors.innerHTML = "";
      return;
    }
    const total = Number(job.groups_total || 0);
    const done = Number(job.groups_done || 0);
    const percent = total ? Math.min(100, Math.round((done / total) * 100)) : (job.running ? 8 : 0);
    fill.style.width = `${percent}%`;
    const bits = [];
    if (job.phase) bits.push({ idle: "空闲", groups: "获取群列表", members: "同步成员", done: "已完成", error: "失败", stopped: "已停止" }[job.phase] || job.phase);
    if (total) bits.push(`${done}/${total} 个群`);
    if (job.members_done) bits.push(`${num(job.members_done)} 人次`);
    if (job.skipped) bits.push(`跳过 ${job.skipped}`);
    text.textContent = bits.join(" · ") || "尚未开始";
    if (errors) {
      const list = job.errors || [];
      errors.innerHTML = list.length
        ? `<div class="notice warn mt-10"><span class="ico">!</span><div><strong>部分群同步失败</strong><br>${list.slice(0, 6).map((e) => `${esc(e.name || e.gc)}：${esc(e.error)}`).join("<br>")}</div></div>`
        : "";
    }
  }

  /* --------------------------------------------------------------- router */
  const ROUTES = {
    dashboard: { title: "概览", subtitle: "你的 QQ 群友关系全景", render: renderDashboard },
    groups: { title: "群聊", subtitle: "查看每个群的成员与活跃情况", render: renderGroups },
    overlap: { title: "交叉分析", subtitle: "找出同时活跃在多个群里的群友", render: renderOverlap },
    members: { title: "群友", subtitle: "搜索群友，查看 TA 加入的所有群", render: renderMembers },
    activity: { title: "活跃度", subtitle: "最近活跃、潜水与新入群成员", render: renderActivity },
    network: { title: "群网络", subtitle: "群与群之间的成员重合关系", render: renderNetwork },
    data: { title: "登录与数据", subtitle: "扫码登录、同步、导入导出", render: renderData },
  };

  function parseHash() {
    const raw = (location.hash || "#/dashboard").replace(/^#\/?/, "");
    const [name, ...rest] = raw.split("/");
    return { name: ROUTES[name] ? name : "dashboard", param: rest.join("/") };
  }

  async function renderRoute(force = false) {
    const { name, param } = parseHash();
    if (name !== "data" && state.qrTimer) {
      clearInterval(state.qrTimer);
      state.qrTimer = null;
      state.qrId = null;
    }
    $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === name));
    const meta = ROUTES[name];
    $("#pageTitle").textContent = name === "groups" && param ? "群聊详情" : meta.title;
    $("#pageSubtitle").textContent = name === "groups" && param ? "成员名单与活跃情况" : meta.subtitle;
    const view = $("#view");
    view.innerHTML = loadingBlock();
    try {
      if (name === "groups" && param) {
        await renderGroupDetail(param);
      } else {
        await meta.render(param, force);
      }
    } catch (err) {
      view.innerHTML = `<div class="card"><div class="card-body">
        <div class="empty">
          <div class="empty-icon">⚠</div>
          <h3>加载失败</h3>
          <p>${esc(err.message || err)}</p>
          <button class="btn" data-action="reload">重试</button>
        </div>
      </div></div>`;
    }
  }

  function go(hash) { location.hash = hash; }

  /* ------------------------------------------------------------ dashboard */
  async function renderDashboard() {
    const [stats, groupsData] = await Promise.all([api("/api/stats"), api("/api/groups")]);
    state.groups = groupsData.groups || [];
    const view = $("#view");

    if (!stats.groups) {
      view.innerHTML = `<div class="card"><div class="card-body">
        ${emptyState("◈", "还没有群数据", "登录 QQ 后同步你加入的群，就能看到跨群重合、活跃度和群关系网络。", '<a class="btn btn-primary" href="#/data">去登录 / 同步</a>')}
      </div></div>`;
      return;
    }

    const active30Percent = pct(stats.active_30d, stats.unique_members);
    const multiPercent = pct(stats.multi_group_members, stats.unique_members);
    const maxPair = Math.max(...(stats.top_pairs || []).map((p) => p.shared), 1);
    const maxHist = Math.max(...(stats.activity_histogram || []).map((h) => h.count), 1);
    const maxTrend = Math.max(...(stats.join_trend || []).map((t) => t.count), 1);

    const topMembers = (stats.top_members || []).map((m, i) => `
      <div class="list-row">
        <span class="rank">${i + 1}</span>
        <span class="avatar">${esc(firstChar(m.nick || m.card || m.uin))}</span>
        <div class="main" data-action="open-member" data-uin="${esc(m.uin)}" style="cursor:pointer">
          <div class="name">${esc(m.nick || m.card || m.uin)}</div>
          <div class="sub">在 ${m.group_count} 个群 · ${esc(ago(m.last_speak_time))}</div>
        </div>
        ${m.is_friend ? '<span class="badge badge-green">好友</span>' : ""}
        <span class="val">${m.group_count}</span>
      </div>`).join("");

    const topPairs = (stats.top_pairs || []).map((p) => `
      <div class="list-row" data-action="select-pair" data-a="${esc(p.a_gc)}" data-b="${esc(p.b_gc)}" style="cursor:pointer">
        <div class="main">
          <div class="name">${esc(p.a_name)} <span class="muted">×</span> ${esc(p.b_name)}</div>
          <div class="bar-track" style="margin-top:6px"><div class="bar-fill" style="width:${Math.round((p.shared / maxPair) * 100)}%"></div></div>
        </div>
        <span class="val">${p.shared}</span>
      </div>`).join("");

    const histogram = (stats.activity_histogram || []).map((h, i) => `
      <div class="bar-row">
        <span class="bar-label">${esc(h.label)}</span>
        <div class="bar-track"><div class="bar-fill ${["green", "", "amber", "amber", "red"][i] || ""}" style="width:${Math.round((h.count / maxHist) * 100)}%"></div></div>
        <span class="bar-value">${num(h.count)}</span>
      </div>`).join("");

    const trend = (stats.join_trend || []).map((t) => `
      <div class="trend-col">
        <span class="trend-count">${t.count || ""}</span>
        <div class="trend-bar" style="height:${Math.max(3, Math.round((t.count / maxTrend) * 88))}px"></div>
        <span class="trend-label">${esc(t.label)}</span>
      </div>`).join("");

    view.innerHTML = `
      <div class="stat-grid">
        ${statCard("群聊数", num(stats.groups), `已同步 <strong>${num(stats.groups)}</strong> 个群`)}
        ${statCard("独立群友", num(stats.unique_members), `共 <strong>${num(stats.memberships)}</strong> 人次`, "purple")}
        ${statCard("跨群群友", num(stats.multi_group_members), `占全部群友 <strong>${multiPercent}</strong>`, "green")}
        ${statCard("7 日活跃", num(stats.active_7d), `30 日活跃 <strong>${num(stats.active_30d)}</strong>（${active30Percent}）`, "amber")}
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><div><h2>跨群最多的人</h2><p>同时出现在多个群里，点击查看 TA 的完整轨迹 · 其中 <strong>${num(stats.potential_friends)}</strong> 位还不是好友</p></div><a class="btn btn-sm btn-ghost" href="#/members">全部群友</a></div>
          <div class="card-body tight">${topMembers || emptyState("⌕", "还没有跨群群友", "同步更多群后，这里会自动找出重合的人。")}</div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>群重合排行</h2><p>两个群之间有多少共同成员</p></div><a class="btn btn-sm btn-ghost" href="#/overlap">交叉分析</a></div>
          <div class="card-body tight">${topPairs || emptyState("⨯", "还没有重合数据", "至少同步两个群才能计算重合。")}</div>
        </div>
      </div>

      <div class="grid-2 mt-16">
        <div class="card">
          <div class="card-head"><div><h2>活跃度分布</h2><p>按每位群友最近一次发言时间统计</p></div></div>
          <div class="card-body"><div class="bar-chart">${histogram}</div></div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>入群趋势</h2><p>最近 8 周新增的群成员关系</p></div></div>
          <div class="card-body"><div class="trend">${trend}</div></div>
        </div>
      </div>

      <div class="grid-3 mt-16">
        <a class="card" href="#/overlap" style="text-decoration:none;color:inherit"><div class="card-body">
          <h2 style="font-size:15px">⨯ 交叉分析</h2>
          <p class="muted small" style="margin-top:6px">选择多个群，找出共同成员，导出重合名单。</p>
        </div></a>
        <a class="card" href="#/activity" style="text-decoration:none;color:inherit"><div class="card-body">
          <h2 style="font-size:15px">⚡ 活跃度</h2>
          <p class="muted small" style="margin-top:6px">最近活跃、长期潜水、新入群成员一目了然。</p>
        </div></a>
        <a class="card" href="#/network" style="text-decoration:none;color:inherit"><div class="card-body">
          <h2 style="font-size:15px">◉ 群网络</h2>
          <p class="muted small" style="margin-top:6px">用关系图看哪些群之间人员流动最紧密。</p>
        </div></a>
      </div>
    `;
  }

  /* --------------------------------------------------------------- groups */
  async function renderGroups() {
    await loadGroups();
    const view = $("#view");
    view.innerHTML = `
      <div class="page-head">
        <div><h2>全部群聊</h2><p>共 ${state.groups.length} 个群，点击卡片查看成员</p></div>
        <div class="actions">
          <button class="btn" data-action="start-sync" data-mode="groups">刷新群列表</button>
          <button class="btn btn-primary" data-action="start-sync" data-mode="full">同步全部成员</button>
        </div>
      </div>
      <div class="toolbar">
        <input class="input" id="groupSearch" placeholder="搜索群名或群号…" value="${esc(state.groupFilter)}">
        <select class="select" id="groupSort">
          <option value="members">按成员数</option>
          <option value="active">按 7 日活跃</option>
          <option value="name">按群名</option>
        </select>
        <div class="spacer"></div>
        <span class="small muted" id="groupCount"></span>
      </div>
      <div class="group-grid" id="groupGrid"></div>
    `;
    $("#groupSort").value = state.groupSort;
    renderGroupGrid();
    $("#groupSearch").addEventListener("input", (e) => {
      state.groupFilter = e.target.value;
      renderGroupGrid();
    });
    $("#groupSort").addEventListener("change", (e) => {
      state.groupSort = e.target.value;
      renderGroupGrid();
    });
  }

  function renderGroupGrid() {
    const grid = $("#groupGrid");
    if (!grid) return;
    const q = state.groupFilter.trim().toLowerCase();
    let rows = state.groups.filter((g) =>
      !q || (g.name || "").toLowerCase().includes(q) || String(g.gc).includes(q)
    );
    if (state.groupSort === "active") rows = rows.slice().sort((a, b) => (b.active_7d || 0) - (a.active_7d || 0));
    else if (state.groupSort === "name") rows = rows.slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh-CN"));
    else rows = rows.slice().sort((a, b) => (b.member_count || 0) - (a.member_count || 0));

    const count = $("#groupCount");
    if (count) count.textContent = `显示 ${rows.length} / ${state.groups.length} 个群`;
    if (!rows.length) {
      grid.innerHTML = `<div class="card" style="grid-column:1/-1"><div class="card-body">${emptyState("▤", "没有匹配的群", q ? "换个关键词试试。" : "先登录并同步群列表。")}</div></div>`;
      return;
    }
    grid.innerHTML = rows.map((g) => {
      const role = g.role === "create" ? ["群主", "badge-amber"] : g.role === "manage" ? ["管理员", "badge-purple"] : ["成员", "badge-muted"];
      return `<div class="group-card" data-action="open-group" data-gc="${esc(g.gc)}">
        <div class="group-card-head">
          <div>
            <div class="group-name">${esc(g.name || `群 ${g.gc}`)}</div>
            <div class="group-gc">群号 ${esc(g.gc)}</div>
          </div>
          <span class="badge ${role[1]}">${role[0]}</span>
        </div>
        <div class="group-stats">
          <div class="group-stat"><strong>${num(g.member_count)}</strong><span>成员</span></div>
          <div class="group-stat"><strong>${num(g.active_7d)}</strong><span>7 日活跃</span></div>
          <div class="group-stat"><strong>${num(g.inactive_90d)}</strong><span>90 天潜水</span></div>
        </div>
        <div class="group-foot">
          <span class="small muted">${g.synced ? `同步于 ${esc(fmtSync(g.synced_at))}` : "尚未同步成员"}</span>
          <div class="group-actions">
            <button class="btn btn-sm" data-action="sync-group" data-gc="${esc(g.gc)}">同步</button>
          </div>
        </div>
      </div>`;
    }).join("");
  }

  async function renderGroupDetail(gc) {
    const detail = await api(`/api/groups/${encodeURIComponent(gc)}`);
    const g = detail.group;
    const s = detail.stats;
    const view = $("#view");
    $("#pageTitle").textContent = g.name || `群 ${g.gc}`;
    $("#pageSubtitle").textContent = `群号 ${g.gc} · ${detail.members.length} 位成员`;

    view.innerHTML = `
      <div class="page-head">
        <div>
          <a class="small muted" href="#/groups">← 返回群聊列表</a>
          <h2 style="margin-top:6px">${esc(g.name || `群 ${g.gc}`)}</h2>
          <p>群号 ${esc(g.gc)} · ${g.role === "create" ? "我创建的群" : g.role === "manage" ? "我管理的群" : "我加入的群"} · ${g.synced_at ? "同步于 " + esc(fmtSync(g.synced_at)) : "尚未同步成员"}</p>
        </div>
        <div class="actions">
          <button class="btn" data-action="sync-group" data-gc="${esc(g.gc)}">同步本群</button>
          <button class="btn" data-action="export" data-kind="members" data-gc="${esc(g.gc)}">导出 CSV</button>
          <button class="btn btn-danger" data-action="delete-group" data-gc="${esc(g.gc)}" data-name="${esc(g.name || g.gc)}">删除</button>
        </div>
      </div>

      <div class="stat-grid">
        ${statCard("群成员", num(s.total), `好友 <strong>${num(s.friends)}</strong> 人`)}
        ${statCard("7 日活跃", num(s.active_7d), `30 日活跃 <strong>${num(s.active_30d)}</strong>`, "green")}
        ${statCard("90 天潜水", num(s.inactive_90d), `占比 <strong>${pct(s.inactive_90d, s.total)}</strong>`, "amber")}
        ${statCard("30 天新成员", num(s.new_30d), `群主 ${s.owners} · 管理员 ${s.admins}`, "purple")}
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><div><h2>最近活跃</h2><p>按最后发言时间排序</p></div></div>
          <div class="card-body tight">
            ${(detail.top_active || []).map((m, i) => `<div class="list-row">
              <span class="rank">${i + 1}</span>
              <span class="avatar">${esc(firstChar(m.nick || m.card || m.uin))}</span>
              <div class="main" data-action="open-member" data-uin="${esc(m.uin)}" style="cursor:pointer">
                <div class="name">${esc(m.nick || m.card || m.uin)}</div>
                <div class="sub">${esc(m.card || m.uin)} · ${esc(ago(m.last_speak_time))}</div>
              </div>
              ${m.is_friend ? '<span class="badge badge-green">好友</span>' : ""}
            </div>`).join("") || emptyState("⚡", "暂无活跃数据", "同步成员后即可查看。")}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>最近入群</h2><p>按入群时间排序</p></div></div>
          <div class="card-body tight">
            ${(detail.recent_joiners || []).map((m, i) => `<div class="list-row">
              <span class="rank">${i + 1}</span>
              <span class="avatar">${esc(firstChar(m.nick || m.card || m.uin))}</span>
              <div class="main" data-action="open-member" data-uin="${esc(m.uin)}" style="cursor:pointer">
                <div class="name">${esc(m.nick || m.card || m.uin)}</div>
                <div class="sub">${esc(fmtDate(m.join_time))} 入群 · ${esc(m.card || m.uin)}</div>
              </div>
            </div>`).join("") || emptyState("＋", "暂无入群数据", "同步成员后即可查看。")}
          </div>
        </div>
      </div>

      <div class="card mt-16">
        <div class="card-head">
          <div><h2>成员名单</h2><p>点击任意成员查看 TA 加入的所有群</p></div>
          <div class="toolbar" style="margin:0">
            <input class="input" id="groupMemberSearch" placeholder="搜索昵称 / 群名片 / QQ…" value="${esc(state.groupMemberFilter)}" style="max-width:230px">
            <select class="select" id="groupMemberSort">
              <option value="active">按最后发言</option>
              <option value="join">按入群时间</option>
              <option value="uin">按 QQ 号</option>
            </select>
          </div>
        </div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>群友</th><th>身份</th><th>群等级</th><th>入群时间</th><th>最后发言</th><th>关系</th></tr></thead>
          <tbody id="groupMemberBody"></tbody>
        </table></div>
      </div>
    `;

    const body = $("#groupMemberBody");
    const draw = () => {
      const q = state.groupMemberFilter.trim().toLowerCase();
      let rows = detail.members.filter((m) =>
        !q || String(m.uin).includes(q) || (m.nick || "").toLowerCase().includes(q) || (m.card || "").toLowerCase().includes(q)
      );
      if (state.groupMemberSort === "join") rows = rows.slice().sort((a, b) => (b.join_time || 0) - (a.join_time || 0));
      else if (state.groupMemberSort === "uin") rows = rows.slice().sort((a, b) => String(a.uin).localeCompare(String(b.uin)));
      else rows = rows.slice().sort((a, b) => (b.last_speak_time || 0) - (a.last_speak_time || 0));
      body.innerHTML = rows.map((m) => `<tr class="clickable" data-action="open-member" data-uin="${esc(m.uin)}">
        <td>${userCell(m.uin, m.nick, m.card)}</td>
        <td>${roleBadge(m)}</td>
        <td class="num">${num(m.level)}</td>
        <td class="nowrap">${esc(fmtDate(m.join_time))}</td>
        <td class="nowrap">${esc(ago(m.last_speak_time))}<div class="cell-sub">${esc(fmtDate(m.last_speak_time))}</div></td>
        <td>${friendBadge(m.is_friend)}</td>
      </tr>`).join("") || `<tr><td colspan="6">${emptyState("⌕", "没有匹配的成员", "换个关键词试试。")}</td></tr>`;
    };
    $("#groupMemberSort").value = state.groupMemberSort;
    draw();
    $("#groupMemberSearch").addEventListener("input", (e) => {
      state.groupMemberFilter = e.target.value;
      draw();
    });
    $("#groupMemberSort").addEventListener("change", (e) => {
      state.groupMemberSort = e.target.value;
      draw();
    });
  }

  /* --------------------------------------------------------------- overlap */
  async function renderOverlap() {
    await loadGroups();
    if (!state.groups.length) {
      $("#view").innerHTML = `<div class="card"><div class="card-body">${emptyState("⨯", "还没有群数据", "先登录并同步群列表，再来做交叉分析。", '<a class="btn btn-primary" href="#/data">去登录 / 同步</a>')}</div></div>`;
      return;
    }
    state.overlapSelected = new Set(
      Array.from(state.overlapSelected).filter((gc) => state.groups.some((g) => g.gc === gc))
    );
    if (!state.overlapSelected.size) {
      state.groups.filter((g) => (g.member_count || 0) > 0).slice(0, 2).forEach((g) => state.overlapSelected.add(g.gc));
    }
    const view = $("#view");
    view.innerHTML = `
      <div class="page-head">
        <div><h2>交叉分析</h2><p>勾选两个或多个群，找出同时在这些群里的群友</p></div>
        <div class="actions">
          <button class="btn" data-action="overlap-all">全选</button>
          <button class="btn" data-action="overlap-clear">清空</button>
        </div>
      </div>
      <div class="picker">
        <div class="card picker-panel">
          <div class="card-head"><div><h2>选择群聊</h2><p id="pickerCount"></p></div></div>
          <div class="card-body">
            <input class="input picker-search" id="pickerSearch" placeholder="搜索群名或群号…" value="${esc(state.overlapQuery)}">
            <div class="picker-list" id="pickerList"></div>
            <div class="chips mt-10" id="selectedChips"></div>
          </div>
        </div>
        <div>
          <div class="card">
            <div class="card-head">
              <div><h2>重合结果</h2><p>共同成员及其所在的所有群</p></div>
              <div id="overlapActions"></div>
            </div>
            <div class="card-body" id="overlapResult"></div>
          </div>
          <div class="card mt-16">
            <div class="card-head"><div><h2>群重合矩阵</h2><p>点击单元格快速选中两个群；显示成员最多的 18 个群</p></div></div>
            <div class="card-body tight"><div class="matrix-wrap" id="matrixWrap"></div></div>
          </div>
        </div>
      </div>
    `;
    renderPicker();
    $("#pickerSearch").addEventListener("input", (e) => {
      state.overlapQuery = e.target.value;
      renderPicker();
    });
    computeOverlap();
    renderMatrix();
  }

  function renderPicker() {
    const list = $("#pickerList");
    if (!list) return;
    const q = state.overlapQuery.trim().toLowerCase();
    const groups = state.groups.filter((g) =>
      !q || (g.name || "").toLowerCase().includes(q) || String(g.gc).includes(q)
    );
    list.innerHTML = groups.map((g) => {
      const active = state.overlapSelected.has(g.gc);
      return `<label class="picker-item ${active ? "active" : ""}">
        <input type="checkbox" data-picker-group="${esc(g.gc)}" ${active ? "checked" : ""}>
        <span class="name" title="${esc(g.name || g.gc)}">${esc(g.name || g.gc)}</span>
        <span class="count">${num(g.member_count)} 人</span>
      </label>`;
    }).join("") || `<p class="muted small">没有匹配的群</p>`;
    const count = $("#pickerCount");
    if (count) count.textContent = `已选 ${state.overlapSelected.size} 个群`;
    const chips = $("#selectedChips");
    if (chips) {
      chips.innerHTML = Array.from(state.overlapSelected).map((gc) => {
        const g = state.groups.find((x) => x.gc === gc);
        return `<span class="chip">${esc(g ? (g.name || g.gc) : gc)}<button data-action="overlap-remove" data-gc="${esc(gc)}" title="移除">×</button></span>`;
      }).join("");
    }
    $$("[data-picker-group]", list).forEach((input) => {
      input.addEventListener("change", (e) => {
        const gc = e.target.dataset.pickerGroup;
        if (e.target.checked) state.overlapSelected.add(gc);
        else state.overlapSelected.delete(gc);
        e.target.closest(".picker-item").classList.toggle("active", e.target.checked);
        const countEl = $("#pickerCount");
        if (countEl) countEl.textContent = `已选 ${state.overlapSelected.size} 个群`;
        renderPickerChips();
        computeOverlap();
      });
    });
  }

  function renderPickerChips() {
    const chips = $("#selectedChips");
    if (!chips) return;
    chips.innerHTML = Array.from(state.overlapSelected).map((gc) => {
      const g = state.groups.find((x) => x.gc === gc);
      return `<span class="chip">${esc(g ? (g.name || g.gc) : gc)}<button data-action="overlap-remove" data-gc="${esc(gc)}" title="移除">×</button></span>`;
    }).join("");
  }

  let overlapToken = 0;
  async function computeOverlap() {
    const box = $("#overlapResult");
    const actions = $("#overlapActions");
    if (!box) return;
    const groups = Array.from(state.overlapSelected);
    if (groups.length < 2) {
      box.innerHTML = emptyState("⨯", "至少选择两个群", "在左侧勾选两个或更多群，就能计算共同成员。");
      if (actions) actions.innerHTML = "";
      return;
    }
    const token = ++overlapToken;
    box.innerHTML = `<div class="skeleton" style="height:80px;margin-bottom:12px"></div><div class="skeleton" style="height:120px"></div>`;
    try {
      const data = await api(`/api/overlap?groups=${encodeURIComponent(groups.join(","))}`);
      if (token !== overlapToken) return;
      const s = data.stats || {};
      const common = data.common || [];
      if (actions) {
        actions.innerHTML = `<button class="btn btn-sm" data-action="export" data-kind="overlap" data-groups="${esc(groups.join(","))}">导出重合名单</button>`;
      }

      let statsHtml = "";
      if (data.groups.length === 2) {
        const a = data.groups[0], b = data.groups[1];
        statsHtml = `<div class="venn-stats">
          <div class="venn-stat"><div class="n">${num(s.only_a)}</div><div class="l">只在「${esc(a.name || a.gc)}」</div></div>
          <div class="venn-stat both"><div class="n">${num(s.both)}</div><div class="l">两个群都在</div></div>
          <div class="venn-stat"><div class="n">${num(s.only_b)}</div><div class="l">只在「${esc(b.name || b.gc)}」</div></div>
        </div>`;
      } else {
        statsHtml = `<div class="venn-stats">
          <div class="venn-stat"><div class="n">${num(s.common)}</div><div class="l">${data.groups.length} 个群的共同成员</div></div>
          <div class="venn-stat"><div class="n">${num(s.union)}</div><div class="l">去重后的总人数</div></div>
          <div class="venn-stat both"><div class="n">${(Number(s.jaccard || 0) * 100).toFixed(1)}%</div><div class="l">Jaccard 重合度</div></div>
        </div>`;
      }

      const exclusive = (s.exclusive || []).map((x) => {
        const g = data.groups.find((y) => y.gc === x.gc);
        return `<span class="badge badge-muted">${esc(g ? (g.name || g.gc) : x.gc)}：独占 ${num(x.count)}</span>`;
      }).join(" ");

      const table = common.length ? `<div class="table-wrap" style="max-height:560px">
        <table class="data">
          <thead><tr><th>群友</th><th>所在群</th><th>所在群数</th><th>最后发言</th><th>关系</th></tr></thead>
          <tbody>${common.map((m) => `<tr class="clickable" data-action="open-member" data-uin="${esc(m.uin)}">
            <td>${userCell(m.uin, m.nick, m.card)}</td>
            <td>${groupBadges((m.groups || []).map((g) => ({ name: g.group_name, gc: g.gc })), 4)}</td>
            <td class="num">${m.group_count}</td>
            <td class="nowrap">${esc(ago(m.last_speak_time))}</td>
            <td>${friendBadge(m.is_friend)}</td>
          </tr>`).join("")}</tbody>
        </table>
      </div>` : emptyState("∅", "没有共同成员", "这几个群之间没有找到同时加入的群友。");

      box.innerHTML = `${statsHtml}
        <div class="chips" style="margin-bottom:12px">${exclusive}</div>
        <div class="small muted" style="margin-bottom:10px">共同成员 <strong style="color:var(--text)">${num(s.common)}</strong> 人 · 去重总人数 ${num(s.union)} · Jaccard ${(Number(s.jaccard || 0) * 100).toFixed(1)}%</div>
        ${table}`;
    } catch (err) {
      if (token !== overlapToken) return;
      box.innerHTML = `<div class="notice warn"><span class="ico">!</span><div>${esc(err.message)}</div></div>`;
    }
  }

  async function renderMatrix() {
    const wrap = $("#matrixWrap");
    if (!wrap) return;
    try {
      const data = await api("/api/matrix?limit=18");
      const nodes = data.nodes || [];
      const edges = data.edges || [];
      if (nodes.length < 2) {
        wrap.innerHTML = `<p class="muted small" style="padding:12px">至少需要两个群才能生成矩阵。</p>`;
        return;
      }
      const map = new Map(edges.map((e) => [`${e.a}|${e.b}`, e.shared]));
      const max = Math.max(...edges.map((e) => e.shared), 1);
      const header = nodes.map((g) => `<th title="${esc(g.name || g.gc)}">${esc((g.name || g.gc).slice(0, 8))}</th>`).join("");
      const rows = nodes.map((row) => {
        const cells = nodes.map((col) => {
          if (row.gc === col.gc) return `<td class="diag">·</td>`;
          const key = row.gc < col.gc ? `${row.gc}|${col.gc}` : `${col.gc}|${row.gc}`;
          const value = map.get(key) || 0;
          const alpha = value ? 0.12 + (value / max) * 0.55 : 0;
          return `<td class="${value ? "" : "zero"}" style="background:rgba(91,140,255,${alpha})" data-action="select-pair" data-a="${esc(row.gc)}" data-b="${esc(col.gc)}" title="${esc(row.name || row.gc)} × ${esc(col.name || col.gc)}：${value} 人">${value || ""}</td>`;
        }).join("");
        return `<tr><th class="row-head" title="${esc(row.name || row.gc)}">${esc((row.name || row.gc).slice(0, 12))}</th>${cells}</tr>`;
      }).join("");
      wrap.innerHTML = `<table class="matrix"><thead><tr><th class="row-head">群</th>${header}</tr></thead><tbody>${rows}</tbody></table>`;
    } catch (err) {
      wrap.innerHTML = `<p class="muted small" style="padding:12px">矩阵加载失败：${esc(err.message)}</p>`;
    }
  }

  /* --------------------------------------------------------------- members */
  async function renderMembers() {
    const view = $("#view");
    view.innerHTML = `
      <div class="page-head">
        <div><h2>群友检索</h2><p>搜索 QQ 号、昵称或群名片，点击查看 TA 加入的所有群</p></div>
        <div class="actions"><button class="btn" data-action="export" data-kind="members">导出全部成员</button></div>
      </div>
      <div class="toolbar">
        <input class="input" id="memberSearch" placeholder="搜索 QQ 号 / 昵称 / 群名片…" value="${esc(state.memberQuery)}">
        <div class="segmented" id="memberMinTabs">
          <button data-min="1" class="${state.memberMin === 1 ? "active" : ""}">全部群友</button>
          <button data-min="2" class="${state.memberMin === 2 ? "active" : ""}">跨群群友</button>
        </div>
        <div class="spacer"></div>
        <span class="small muted" id="memberCount"></span>
      </div>
      <div class="card"><div class="table-wrap" id="memberTableWrap"></div></div>
    `;
    const input = $("#memberSearch");
    const load = async () => {
      const wrap = $("#memberTableWrap");
      wrap.innerHTML = `<div class="card-body"><div class="skeleton" style="height:40px;margin-bottom:8px"></div><div class="skeleton" style="height:40px"></div></div>`;
      try {
        let rows;
        if (state.memberMin >= 2) {
          const data = await api(`/api/multi-group?min=${state.memberMin}&limit=800`);
          rows = data.members || [];
          const q = state.memberQuery.trim().toLowerCase();
          if (q) rows = rows.filter((m) => String(m.uin).includes(q) || (m.nick || "").toLowerCase().includes(q) || (m.card || "").toLowerCase().includes(q));
        } else {
          const data = await api(`/api/members?q=${encodeURIComponent(state.memberQuery)}&limit=800`);
          rows = data.members || [];
        }
        const count = $("#memberCount");
        if (count) count.textContent = `${num(rows.length)} 位群友`;
        if (!rows.length) {
          wrap.innerHTML = `<div class="card-body">${emptyState("⌕", "没有找到群友", "换个关键词，或先同步更多群。")}</div>`;
          return;
        }
        wrap.innerHTML = `<table class="data">
          <thead><tr><th>群友</th><th>所在群</th><th>群数</th><th>最后发言</th><th>关系</th></tr></thead>
          <tbody>${rows.map((m) => `<tr class="clickable" data-action="open-member" data-uin="${esc(m.uin)}">
            <td>${userCell(m.uin, m.nick, m.card)}</td>
            <td>${groupBadges(m.groups || [], 3)}</td>
            <td class="num">${m.group_count}</td>
            <td class="nowrap">${esc(ago(m.last_speak_time))}</td>
            <td>${friendBadge(m.is_friend)}</td>
          </tr>`).join("")}</tbody>
        </table>`;
      } catch (err) {
        wrap.innerHTML = `<div class="card-body"><div class="notice warn"><span class="ico">!</span><div>${esc(err.message)}</div></div></div>`;
      }
    };
    input.addEventListener("input", debounce((e) => {
      state.memberQuery = e.target.value;
      load();
    }, 260));
    $$("#memberMinTabs button").forEach((btn) => btn.addEventListener("click", () => {
      state.memberMin = Number(btn.dataset.min);
      $$("#memberMinTabs button").forEach((b) => b.classList.toggle("active", b === btn));
      load();
    }));
    load();
  }

  /* -------------------------------------------------------------- activity */
  async function renderActivity() {
    const view = $("#view");
    view.innerHTML = `
      <div class="page-head">
        <div><h2>活跃度分析</h2><p>按最后发言时间识别活跃、潜水与新入群成员</p></div>
        <div class="actions"><button class="btn" id="activityExport">导出当前结果</button></div>
      </div>
      <div class="toolbar">
        <div class="segmented" id="activityTabs">
          <button data-mode="active" class="${state.activity.mode === "active" ? "active" : ""}">最近活跃</button>
          <button data-mode="lurker" class="${state.activity.mode === "lurker" ? "active" : ""}">潜水成员</button>
          <button data-mode="new" class="${state.activity.mode === "new" ? "active" : ""}">新入群</button>
        </div>
        <select class="select" id="activityDays">
          <option value="7">7 天</option>
          <option value="30">30 天</option>
          <option value="90">90 天</option>
          <option value="180">180 天</option>
          <option value="365">365 天</option>
        </select>
        <select class="select" id="activityGroup"><option value="">全部群聊</option></select>
        <div class="spacer"></div>
        <span class="small muted" id="activityCount"></span>
      </div>
      <div class="card"><div class="table-wrap" id="activityTableWrap"></div></div>
    `;
    const days = $("#activityDays");
    days.value = String(state.activity.days);
    const groupSelect = $("#activityGroup");
    groupSelect.innerHTML = `<option value="">全部群聊</option>` + state.groups.map((g) => `<option value="${esc(g.gc)}">${esc(g.name || g.gc)}</option>`).join("");
    groupSelect.value = state.activity.gc || "";

    const load = async () => {
      const wrap = $("#activityTableWrap");
      wrap.innerHTML = `<div class="card-body"><div class="skeleton" style="height:40px;margin-bottom:8px"></div><div class="skeleton" style="height:40px"></div></div>`;
      try {
        const qs = new URLSearchParams({
          mode: state.activity.mode,
          days: String(state.activity.days),
          limit: "600",
        });
        if (state.activity.gc) qs.set("gc", state.activity.gc);
        const data = await api(`/api/activity?${qs.toString()}`);
        const rows = data.rows || [];
        const count = $("#activityCount");
        if (count) count.textContent = `${num(rows.length)} 位群友`;
        if (!rows.length) {
          wrap.innerHTML = `<div class="card-body">${emptyState("⚡", "没有符合条件的成员", "换个时间范围或群聊试试。")}</div>`;
          return;
        }
        wrap.innerHTML = `<table class="data">
          <thead><tr><th>群友</th><th>${state.activity.gc ? "群名片" : "所在群"}</th><th>最后发言</th><th>入群时间</th><th>关系</th></tr></thead>
          <tbody>${rows.map((m) => `<tr class="clickable" data-action="open-member" data-uin="${esc(m.uin)}">
            <td>${userCell(m.uin, m.nick, m.card)}</td>
            <td>${state.activity.gc ? esc(m.card || "—") : groupBadges(m.groups || [], 3)}</td>
            <td class="nowrap">${esc(ago(m.last_speak_time))}<div class="cell-sub">${esc(fmtDate(m.last_speak_time))}</div></td>
            <td class="nowrap">${esc(fmtDate(m.join_time))}</td>
            <td>${friendBadge(m.is_friend)}</td>
          </tr>`).join("")}</tbody>
        </table>`;
      } catch (err) {
        wrap.innerHTML = `<div class="card-body"><div class="notice warn"><span class="ico">!</span><div>${esc(err.message)}</div></div></div>`;
      }
    };

    $$("#activityTabs button").forEach((btn) => btn.addEventListener("click", () => {
      state.activity.mode = btn.dataset.mode;
      $$("#activityTabs button").forEach((b) => b.classList.toggle("active", b === btn));
      load();
    }));
    days.addEventListener("change", () => {
      state.activity.days = Number(days.value);
      load();
    });
    groupSelect.addEventListener("change", () => {
      state.activity.gc = groupSelect.value;
      load();
    });
    $("#activityExport").addEventListener("click", () => {
      const qs = new URLSearchParams({
        kind: "activity",
        mode: state.activity.mode,
        days: String(state.activity.days),
      });
      if (state.activity.gc) qs.set("gc", state.activity.gc);
      window.location.href = `/api/export?${qs.toString()}`;
    });
    load();
  }

  /* --------------------------------------------------------------- network */
  async function renderNetwork() {
    const view = $("#view");
    view.innerHTML = `
      <div class="page-head">
        <div><h2>群关系网络</h2><p>节点是群，连线表示两个群有共同成员；线越粗，重合越多</p></div>
        <div class="actions">
          <button class="btn" data-action="reload-network">重新布局</button>
        </div>
      </div>
      <div class="toolbar">
        <label class="small muted">最少共同成员</label>
        <input class="input" type="number" min="1" value="${state.networkMin}" id="networkMin" style="width:90px">
        <label class="small muted">显示群数</label>
        <select class="select" id="networkNodes">
          <option value="20">20 个</option>
          <option value="30">30 个</option>
          <option value="40">40 个</option>
          <option value="60">60 个</option>
        </select>
        <div class="spacer"></div>
        <span class="small muted" id="networkSummary"></span>
      </div>
      <div class="card">
        <div class="network-wrap" id="networkWrap"><div class="card-body">${loadingBlock("正在计算群关系…")}</div></div>
      </div>
      <div class="card mt-16">
        <div class="card-head"><div><h2>重合最强的群对</h2><p>共同成员数量最多的组合</p></div></div>
        <div class="card-body tight" id="networkPairs"></div>
      </div>
    `;
    $("#networkNodes").value = String(state.networkNodes);
    const load = async () => {
      const wrap = $("#networkWrap");
      wrap.innerHTML = `<div class="card-body">${loadingBlock("正在计算群关系…")}</div>`;
      try {
        const data = await api(`/api/network?min_shared=${state.networkMin}&max_nodes=${state.networkNodes}`);
        state.network = data;
        const summary = $("#networkSummary");
        if (summary) summary.textContent = `${data.nodes.length} 个群 · ${data.edges.length} 条关系`;
        renderNetworkSvg(data, wrap);
        renderNetworkPairs(data);
      } catch (err) {
        wrap.innerHTML = `<div class="card-body"><div class="notice warn"><span class="ico">!</span><div>${esc(err.message)}</div></div></div>`;
      }
    };
    $("#networkMin").addEventListener("change", (e) => {
      state.networkMin = Math.max(1, Number(e.target.value) || 1);
      load();
    });
    $("#networkNodes").addEventListener("change", (e) => {
      state.networkNodes = Number(e.target.value);
      load();
    });
    load();
  }

  function renderNetworkSvg(data, wrap) {
    const nodes = data.nodes || [];
    const edges = data.edges || [];
    if (nodes.length < 2) {
      wrap.innerHTML = `<div class="card-body">${emptyState("◉", "关系数据不足", "至少同步两个有共同成员的群，才能画出网络。")}</div>`;
      return;
    }
    const width = 920, height = 640, cx = width / 2, cy = height / 2;
    const radius = Math.min(width, height) * 0.34;
    const maxMembers = Math.max(...nodes.map((n) => n.member_count || 0), 1);
    const maxShared = Math.max(...edges.map((e) => e.shared || 0), 1);
    const pos = new Map();
    const nodeR = new Map();
    nodes.forEach((node, i) => {
      const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
      const r = 8 + Math.sqrt((node.member_count || 0) / maxMembers) * 18;
      nodeR.set(node.gc, r);
      pos.set(node.gc, {
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
        angle,
      });
    });

    const edgeSvg = edges.map((e) => {
      const a = pos.get(e.a), b = pos.get(e.b);
      if (!a || !b) return "";
      const weight = (e.shared || 0) / maxShared;
      return `<line class="edge" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"
        stroke-width="${(1 + weight * 5).toFixed(2)}" opacity="${(0.12 + weight * 0.5).toFixed(2)}">
        <title>${e.shared} 位共同成员</title></line>`;
    }).join("");

    const nodeSvg = nodes.map((node) => {
      const p = pos.get(node.gc);
      const r = nodeR.get(node.gc);
      const label = (node.name || node.gc).slice(0, 12);
      const anchor = Math.abs(Math.cos(p.angle)) < 0.18 ? "middle" : (Math.cos(p.angle) > 0 ? "start" : "end");
      const lx = cx + Math.cos(p.angle) * (radius + r + 9);
      const ly = cy + Math.sin(p.angle) * (radius + r + 9) + 4;
      return `<g class="node" data-action="open-group" data-gc="${esc(node.gc)}">
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}"
          fill="url(#nodeGrad)" opacity="0.92">
          <title>${esc(node.name || node.gc)} · ${num(node.member_count)} 人</title>
        </circle>
        <text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}">${esc(label)}</text>
      </g>`;
    }).join("");

    wrap.innerHTML = `<svg class="network-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="群关系网络图">
      <defs>
        <radialGradient id="nodeGrad" cx="35%" cy="30%" r="75%">
          <stop offset="0%" stop-color="#7ea6ff"></stop>
          <stop offset="100%" stop-color="#5b6cf0"></stop>
        </radialGradient>
      </defs>
      ${edgeSvg}
      ${nodeSvg}
    </svg>`;
  }

  function renderNetworkPairs(data) {
    const box = $("#networkPairs");
    if (!box) return;
    const names = new Map((data.nodes || []).map((n) => [n.gc, n.name || n.gc]));
    const edges = (data.edges || []).slice(0, 12);
    if (!edges.length) {
      box.innerHTML = `<p class="muted small" style="padding:12px">没有达到条件的群对。</p>`;
      return;
    }
    const max = Math.max(...edges.map((e) => e.shared), 1);
    box.innerHTML = edges.map((e, i) => `<div class="list-row">
      <span class="rank">${i + 1}</span>
      <div class="main">
        <div class="name">${esc(names.get(e.a) || e.a)} <span class="muted">×</span> ${esc(names.get(e.b) || e.b)}</div>
        <div class="bar-track" style="margin-top:6px"><div class="bar-fill" style="width:${Math.round((e.shared / max) * 100)}%"></div></div>
      </div>
      <span class="val">${num(e.shared)}</span>
    </div>`).join("");
  }

  /* ------------------------------------------------------------------ data */
  async function renderData() {
    await refreshSession();
    const s = state.session || {};
    const counts = s.counts || {};
    const view = $("#view");
    const job = state.syncJob || (await api("/api/sync"));

    view.innerHTML = `
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><div><h2>QQ 账号</h2><p>扫码登录 qun.qq.com，只读取你自己加入的群</p></div>
            <span class="badge ${s.logged_in ? "badge-green" : "badge-muted"}">${s.logged_in ? "已登录" : "未登录"}</span>
          </div>
          <div class="card-body">
            <dl class="kv">
              <dt>账号</dt><dd>${s.uin ? "QQ " + esc(s.uin) : "—"}</dd>
              <dt>群聊数</dt><dd>${num(counts.groups)}</dd>
              <dt>成员关系</dt><dd>${num(counts.memberships)} 人次 / ${num(counts.unique_members)} 位独立群友</dd>
              <dt>最后同步</dt><dd>${esc(fmtSync(s.last_sync))}</dd>
            </dl>
            ${s.logged_in ? '<button class="btn btn-danger mt-16" data-action="logout">退出登录</button>' : '<div class="notice mt-16"><span class="ico">i</span><div>登录后即可同步群列表。普通群成员身份就能拉取已加入群的成员名单。</div></div>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div><h2>扫码登录</h2><p>用手机 QQ 扫描二维码</p></div></div>
          <div class="card-body">
            <div class="qr-box">
              <div id="qrArea"><div class="qr-placeholder">点击下方按钮生成二维码<br>二维码 3 分钟内有效</div></div>
              <div class="login-status" id="qrStatus"></div>
              <button class="btn btn-primary" data-action="start-qr">生成二维码</button>
            </div>
            <div class="notice mt-16"><span class="ico">i</span><div>扫码只用于获取 qun.qq.com 的会话 Cookie，不会读取聊天记录，也不会上传到任何第三方。</div></div>
          </div>
        </div>
      </div>

      <div class="card mt-16">
        <div class="card-head"><div><h2>同步数据</h2><p>先从 qun.qq.com 拉群列表，再逐群拉成员；有频率限制，请耐心等待</p></div></div>
        <div class="card-body">
          <div class="toolbar">
            <button class="btn" data-action="start-sync" data-mode="groups">同步群列表</button>
            <button class="btn btn-primary" data-action="start-sync" data-mode="full">同步全部群成员</button>
            <button class="btn" data-action="start-sync" data-mode="pending">同步未完成的群</button>
            <button class="btn btn-danger" data-action="stop-sync">停止</button>
          </div>
          <div class="progress"><div class="progress-fill" id="syncProgressFill"></div></div>
          <div class="small muted mt-10" id="syncProgressText">尚未开始</div>
          <div id="syncErrors"></div>
        </div>
      </div>

      <div class="grid-2 mt-16">
        <div class="card">
          <div class="card-head"><div><h2>导出</h2><p>CSV 可直接用 Excel 打开；JSON 可用于备份/迁移</p></div></div>
          <div class="card-body">
            <div class="toolbar" style="margin:0">
              <button class="btn" data-action="export" data-kind="groups">群列表 CSV</button>
              <button class="btn" data-action="export" data-kind="members">全部成员 CSV</button>
              <button class="btn" data-action="export" data-kind="json">完整备份 JSON</button>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>导入 / 迁移</h2><p>导入本工具导出的 JSON 备份</p></div></div>
          <div class="card-body">
            <div class="dropzone" id="importDrop">点击选择 JSON 备份文件<input type="file" id="importFile" accept=".json,application/json" hidden></div>
            <div class="small muted mt-10" id="importStatus"></div>
          </div>
        </div>
      </div>

      <div class="card mt-16">
        <div class="card-head"><div><h2>Cookie 登录（备用）</h2><p>如果你已经在浏览器登录 qun.qq.com，可以粘贴 Cookie</p></div></div>
        <div class="card-body">
          <div class="field">
            <label>浏览器 Cookie（需包含 skey 或 p_skey）</label>
            <textarea class="textarea" id="cookieInput" placeholder="uin=o123456; skey=@abc123..."></textarea>
          </div>
          <div class="toolbar mt-10" style="margin-bottom:0">
            <button class="btn btn-primary" data-action="save-cookie">验证并保存</button>
            <span class="small muted" id="cookieStatus"></span>
          </div>
          <div class="notice mt-16"><span class="ico">i</span><div>获取方式：浏览器登录 <a href="https://qun.qq.com/member.html" target="_blank" rel="noreferrer">qun.qq.com</a>，按 F12 打开开发者工具，在 Console 输入 <code>document.cookie</code> 复制结果。</div></div>
        </div>
      </div>

      <div class="card mt-16">
        <div class="card-head"><div><h2>隐私与安全</h2><p>这个工具如何对待你的数据</p></div></div>
        <div class="card-body">
          <div class="notice green"><span class="ico">✓</span><div>
            <strong>全部本地处理。</strong>群成员、活跃时间等数据只写入本机的 <code>data/roster.db</code>，不会上传到任何服务器。<br>            <strong>只访问腾讯域名。</strong>登录与同步只请求 <code>ptlogin2.qq.com</code> 和 <code>qun.qq.com</code>。<br>
            <strong>不读聊天记录。</strong>只读取群成员列表中的公开字段：QQ 号、昵称、群名片、入群时间、最后发言时间。<br>
            <strong>请谨慎分享导出文件。</strong>CSV / JSON 包含群友 QQ 号，请勿发给不可信的人。
          </div></div>
        </div>
      </div>

      <div class="card mt-16">
        <div class="card-head"><div><h2>危险操作</h2><p>清空本机数据库中的群和成员数据（不会退出登录）</p></div></div>
        <div class="card-body">
          <div class="toolbar" style="margin:0">
            <input class="input" id="clearConfirm" placeholder="输入 DELETE 确认" style="max-width:220px">
            <button class="btn btn-danger" data-action="clear-data">清空全部数据</button>
          </div>
        </div>
      </div>
    `;

    updateDataProgress(job);
    const drop = $("#importDrop");
    const file = $("#importFile");
    if (drop && file) {
      drop.addEventListener("click", (e) => {
        if (e.target !== file) file.click();
      });
      file.addEventListener("change", async () => {
        const f = file.files && file.files[0];
        if (!f) return;
        const status = $("#importStatus");
        if (status) status.textContent = "正在导入…";
        try {
          const text = (await f.text()).replace(/^\uFEFF/, "");
          const payload = JSON.parse(text);
          const result = await api("/api/import", { method: "POST", body: payload });
          if (status) status.textContent = `导入完成：${result.groups} 个群，${result.members} 条成员关系`;
          toast("导入完成", "success");
          await refreshSession();
          await loadGroups();
        } catch (err) {
          if (status) status.textContent = `导入失败：${err.message}`;
          toast(err.message, "error");
        }
      });
    }
  }

  /* --------------------------------------------------------------- QR login */
  async function startQr() {
    const area = $("#qrArea");
    const status = $("#qrStatus");
    if (!area) return;
    if (state.qrTimer) {
      clearInterval(state.qrTimer);
      state.qrTimer = null;
    }
    area.innerHTML = `<div class="qr-placeholder">正在生成二维码…</div>`;
    if (status) { status.textContent = ""; status.className = "login-status"; }
    try {
      const data = await api("/api/auth/qr", { method: "POST", body: {} });
      state.qrId = data.id;
      area.innerHTML = `<img class="qr-image" alt="QQ 登录二维码" src="${data.image}">`;
      if (status) status.textContent = "请用手机 QQ 扫码";
      state.qrTimer = setInterval(async () => {
        try {
          const res = await api("/api/auth/qr/poll", { method: "POST", body: { id: data.id } });
          if (status) {
            status.textContent = res.hint || "";
            status.className = "login-status " + (res.status === "ok" ? "ok" : res.status === "error" ? "err" : "");
          }
          if (res.status === "ok") {
            clearInterval(state.qrTimer);
            state.qrTimer = null;
            state.qrId = null;
            await refreshSession();
            toast("登录成功", "success");
            renderRoute(true);
          } else if (res.status === "expired" || res.status === "error") {
            clearInterval(state.qrTimer);
            state.qrTimer = null;
            state.qrId = null;
          }
        } catch (err) {
          if (status) { status.textContent = err.message; status.className = "login-status err"; }
        }
      }, 1500);
    } catch (err) {
      area.innerHTML = `<div class="qr-placeholder">二维码生成失败<br>${esc(err.message)}</div>`;
      if (status) { status.textContent = err.message; status.className = "login-status err"; }
    }
  }

  /* ---------------------------------------------------------------- member */
  async function openMember(uin) {
    const root = $("#modalRoot");
    root.innerHTML = `<div class="modal-overlay" id="modalOverlay"><div class="modal"><div class="card-body">${loadingBlock("正在读取群友资料…")}</div></div></div>`;
    bindModalClose();
    try {
      const p = await api(`/api/members/${encodeURIComponent(uin)}`);
      const memberships = p.memberships || [];
      root.innerHTML = `<div class="modal-overlay" id="modalOverlay">
        <div class="modal">
          <div class="modal-head">
            <div class="profile-head">
              <span class="avatar">${esc(firstChar(p.nick || p.uin))}</span>
              <div>
                <h3>${esc(p.nick || p.aliases[0] || p.uin)}</h3>
                <div class="uin">QQ ${esc(p.uin)}</div>
                <div class="chips" style="margin-top:6px">
                  ${p.is_friend ? '<span class="badge badge-green">好友</span>' : '<span class="badge badge-muted">非好友</span>'}
                  ${p.is_owner ? '<span class="badge badge-amber">某群群主</span>' : ""}
                  ${p.is_admin ? '<span class="badge badge-purple">某群管理员</span>' : ""}
                </div>
              </div>
            </div>
            <button class="modal-close" data-action="close-modal" title="关闭">×</button>
          </div>
          <div class="modal-body">
            <div class="profile-stats">
              <div class="profile-stat"><strong>${p.group_count}</strong><span>加入的群</span></div>
              <div class="profile-stat"><strong>${esc(ago(p.last_speak_time))}</strong><span>最后发言</span></div>
              <div class="profile-stat"><strong>${esc(fmtDate(p.first_join_time))}</strong><span>最早入群</span></div>
              <div class="profile-stat"><strong>${p.is_friend ? "是" : "否"}</strong><span>是否好友</span></div>
            </div>

            ${p.aliases && p.aliases.length ? `<div class="field" style="margin-bottom:16px"><label>用过的昵称 / 群名片</label><div class="alias-list">${p.aliases.map((a) => `<span class="badge">${esc(a)}</span>`).join("")}</div></div>` : ""}

            <div class="card">
              <div class="card-head"><div><h2>加入的群</h2><p>共 ${memberships.length} 个</p></div></div>
              <div class="table-wrap" style="max-height:280px">
                <table class="data">
                  <thead><tr><th>群</th><th>群名片</th><th>身份</th><th>入群时间</th><th>最后发言</th></tr></thead>
                  <tbody>${memberships.map((m) => `<tr class="clickable" data-action="open-group" data-gc="${esc(m.gc)}">
                    <td><span class="cell-main">${esc(m.group_name || m.gc)}</span><div class="cell-sub mono">${esc(m.gc)}</div></td>
                    <td>${esc(m.card || "—")}</td>
                    <td>${roleBadge(m)}</td>
                    <td class="nowrap">${esc(fmtDate(m.join_time))}</td>
                    <td class="nowrap">${esc(ago(m.last_speak_time))}</td>
                  </tr>`).join("")}</tbody>
                </table>
              </div>
            </div>

            ${(p.co_members || []).length ? `<div class="card mt-16">
              <div class="card-head"><div><h2>同群最多的人</h2><p>和 TA 共同群聊最多的群友</p></div></div>
              <div class="card-body tight">${p.co_members.map((c, i) => `<div class="list-row">
                <span class="rank">${i + 1}</span>
                <span class="avatar">${esc(firstChar(c.nick || c.uin))}</span>
                <div class="main" data-action="open-member" data-uin="${esc(c.uin)}" style="cursor:pointer">
                  <div class="name">${esc(c.nick || c.uin)}</div>
                  <div class="sub mono">${esc(c.uin)}</div>
                </div>
                <span class="badge badge-blue">${c.shared} 个共同群</span>
              </div>`).join("")}</div>
            </div>` : ""}
          </div>
        </div>
      </div>`;
      bindModalClose();
    } catch (err) {
      root.innerHTML = `<div class="modal-overlay" id="modalOverlay"><div class="modal"><div class="modal-head"><h3>加载失败</h3><button class="modal-close" data-action="close-modal">×</button></div><div class="modal-body"><div class="notice warn"><span class="ico">!</span><div>${esc(err.message)}</div></div></div></div></div>`;
      bindModalClose();
    }
  }

  function bindModalClose() {
    const overlay = $("#modalOverlay");
    if (!overlay) return;
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });
  }

  function closeModal() {
    const root = $("#modalRoot");
    if (root) root.innerHTML = "";
  }

  /* ------------------------------------------------------------- global UI */
  function downloadExport(dataset) {
    const qs = new URLSearchParams();
    qs.set("kind", dataset.kind || "members");
    if (dataset.gc) qs.set("gc", dataset.gc);
    if (dataset.groups) qs.set("groups", dataset.groups);
    window.location.href = `/api/export?${qs.toString()}`;
  }

  async function deleteGroup(gc, name) {
    if (!window.confirm(`确定删除「${name || gc}」及其成员数据吗？这不会影响 QQ 群本身。`)) return;
    try {
      await api(`/api/groups/${encodeURIComponent(gc)}`, { method: "DELETE" });
      toast("已删除本地群数据", "success");
      await refreshSession();
      await loadGroups();
      go("#/groups");
      renderRoute(true);
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function clearData() {
    const input = $("#clearConfirm");
    const confirmText = input ? input.value.trim() : "";
    if (confirmText !== "DELETE") {
      toast("请输入 DELETE 确认", "error");
      return;
    }
    if (!window.confirm("确定清空全部群和成员数据吗？建议先导出 JSON 备份。")) return;
    try {
      await api("/api/data/clear", { method: "POST", body: { confirm: "DELETE" } });
      toast("数据已清空", "success");
      await refreshSession();
      await loadGroups();
      renderRoute(true);
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function saveCookie() {
    const input = $("#cookieInput");
    const status = $("#cookieStatus");
    if (!input) return;
    const cookie = input.value.trim();
    if (!cookie) {
      toast("请先粘贴 Cookie", "error");
      return;
    }
    if (status) status.textContent = "正在验证…";
    try {
      const res = await api("/api/auth/cookie", { method: "POST", body: { cookie } });
      if (status) status.textContent = `验证成功${res.uin ? "，QQ " + res.uin : ""}，可见 ${res.groups} 个群`;
      toast("Cookie 登录成功", "success");
      await refreshSession();
      renderRoute(true);
    } catch (err) {
      if (status) status.textContent = `验证失败：${err.message}`;
      toast(err.message, "error");
    }
  }

  function handleAction(el) {
    const action = el.dataset.action;
    switch (action) {
      case "open-member":
        if (el.dataset.uin) openMember(el.dataset.uin);
        break;
      case "open-group":
        if (el.dataset.gc) {
          closeModal();
          go(`#/groups/${el.dataset.gc}`);
        }
        break;
      case "sync-group":
        if (el.dataset.gc) startSync("members", [el.dataset.gc]);
        break;
      case "delete-group":
        deleteGroup(el.dataset.gc, el.dataset.name);
        break;
      case "start-sync":
        startSync(el.dataset.mode || "full", []);
        break;
      case "stop-sync":
        stopSync();
        break;
      case "export":
        downloadExport(el.dataset);
        break;
      case "select-pair":
        state.overlapSelected = new Set([el.dataset.a, el.dataset.b]);
        if (parseHash().name === "overlap") renderRoute(true);
        else go("#/overlap");
        break;
      case "overlap-remove":
        state.overlapSelected.delete(el.dataset.gc);
        renderPicker();
        computeOverlap();
        break;
      case "overlap-all":
        state.overlapSelected = new Set(state.groups.map((g) => g.gc));
        renderPicker();
        computeOverlap();
        break;
      case "overlap-clear":
        state.overlapSelected.clear();
        renderPicker();
        computeOverlap();
        break;
      case "start-qr":
        startQr();
        break;
      case "save-cookie":
        saveCookie();
        break;
      case "logout":
        logout();
        break;
      case "clear-data":
        clearData();
        break;
      case "close-modal":
        closeModal();
        break;
      case "reload":
        renderRoute(true);
        break;
      case "reload-network":
        renderRoute(true);
        break;
      default:
        break;
    }
  }

  async function logout() {
    if (!window.confirm("退出登录只会清除本机会话 Cookie，不会删除已同步的数据。继续吗？")) return;
    try {
      await api("/api/auth/logout", { method: "POST", body: {} });
      toast("已退出登录");
      await refreshSession();
      renderRoute(true);
    } catch (err) {
      toast(err.message, "error");
    }
  }

  /* ------------------------------------------------------------------ boot */
  function initTheme() {
    const saved = localStorage.getItem("qqroster-theme");
    if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
    const btn = $("#themeToggle");
    if (btn) {
      btn.addEventListener("click", () => {
        const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
        document.documentElement.dataset.theme = next;
        localStorage.setItem("qqroster-theme", next);
      });
    }
  }

  function bindGlobal() {
    document.addEventListener("click", (e) => {
      const el = e.target.closest("[data-action]");
      if (!el) return;
      if (el.closest(".modal-overlay") && el.dataset.action !== "close-modal" && el.dataset.action !== "open-member" && el.dataset.action !== "open-group") {
        return;
      }
      handleAction(el);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
    });

    window.addEventListener("hashchange", () => renderRoute());

    const chip = $("#accountChip");
    if (chip) chip.addEventListener("click", () => go("#/data"));

    const syncBtn = $("#syncButton");
    if (syncBtn) syncBtn.addEventListener("click", () => startSync("full", []));
  }

  async function boot() {
    initTheme();
    bindGlobal();
    try {
      await refreshSession();
      await loadGroups();
    } catch (err) {
      console.error(err);
    }
    if (!location.hash) location.hash = "#/dashboard";
    await renderRoute();
    if (state.session && state.session.syncing) pollSync();
  }

  boot();
})();
