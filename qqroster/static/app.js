/* 小团体花名册 —— 前端逻辑（无任何外部依赖） */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const DAY = 86400;

  const MEMES = {
    logo: "/static/memes/01-logo.png",
    fanGroup: "/static/memes/02-fan-group.png",
    goodGroupmates: "/static/memes/03-good-groupmates.png",
    nobodyPlays: "/static/memes/04-nobody-plays.png",
    linuxPanic: "/static/memes/05-linux-panic.png",
    ignoreYou: "/static/memes/06-ignore-you.png",
    soStrong: "/static/memes/07-so-strong.png",
    callEveryone: "/static/memes/08-call-everyone.png",
    takeNotes: "/static/memes/09-take-notes.png",
    rule: "/static/memes/10-rule.png",
    mysteryA: "/static/memes/11-mystery-a.png",
    mysteryB: "/static/memes/12-mystery-b.png",
    mysteryC: "/static/memes/13-mystery-c.png",
  };

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
    focusGc: "",
    focusQuery: "",
    focusOnlyMulti: true,
    focusData: null,
    network: {
      data: null,
      mode: "force",
      minShared: 1,
      maxNodes: 40,
      chordTop: 12,
      focusGc: null,
      seed: 7,
      zoom: 1,
      panX: 0,
      panY: 0,
    },
  };

  function meme(key, cls = "meme-sm", style = "") {
    const src = MEMES[key] || MEMES.mysteryA;
    return `<img class="meme ${cls}" data-meme="${esc(key)}" src="${src}" alt="抽象表情" loading="lazy"${style ? ` style="${style}"` : ""}>`;
  }

  function groupAvatar(gc, name, cls = "group-avatar") {
    return `<img class="${cls}" src="/api/avatar/group/${encodeURIComponent(gc)}" alt="${esc(name || gc)}" loading="lazy" decoding="async">`;
  }

  function memberAvatar(uin, nick, cls = "member-avatar") {
    return `<img class="${cls}" src="/api/avatar/user/${encodeURIComponent(uin)}" alt="${esc(nick || uin)}" loading="lazy" decoding="async">`;
  }

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

  function groupPills(groups, max = 3) {
    const list = Array.isArray(groups) ? groups : [];
    const shown = list.slice(0, max).map((g) => {
      const card = g.card || "";
      return `<span class="group-pill" title="${esc(gname(g))}${card ? " · " + esc(card) : ""}">
        ${groupAvatar(g.gc, gname(g), "group-avatar xs")}
        <b>${esc(gname(g))}</b>${card ? ` · ${esc(card)}` : ""}
      </span>`;
    }).join("");
    const more = list.length > max ? `<span class="badge">+${list.length - max}</span>` : "";
    return `<div class="chips">${shown}${more}</div>`;
  }

  function userCell(uin, nick, card, opts = {}) {
    const display = nick || card || uin || "未知";
    const sub = card && card !== nick ? `${uin} · ${card}` : String(uin || "");
    const avatar = opts.avatar
      ? memberAvatar(uin, display, opts.avatarClass || "member-avatar sm")
      : `<span class="avatar">${esc(firstChar(display))}</span>`;
    return `<div class="user-cell">
      ${avatar}
      <div class="meta">
        <div class="cell-main ellipsis" title="${esc(display)}">${esc(display)}</div>
        <div class="cell-sub mono">${esc(sub)}</div>
      </div>
    </div>`;
  }

  function statCard(label, value, sub, tone = "", icon = "") {
    return `<div class="stat-card ${tone}">
      ${icon ? `<div class="stat-icon">${icon}</div>` : ""}
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${esc(value)}</div>
      <div class="stat-sub">${sub || ""}</div>
    </div>`;
  }

  function emptyState(icon, title, text, action = "", memeKey = "") {
    return `<div class="empty">
      ${memeKey ? meme(memeKey, "meme-md") : `<div class="empty-icon">${icon}</div>`}
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

  function progressSnapshot() {
    const s = state.session || {};
    const c = s.counts || {};
    const logged = !!s.logged_in;
    const hasGroups = (c.groups || 0) > 0;
    const hasMembers = (c.memberships || 0) > 0;
    let current = 0;
    if (!logged) current = 0;
    else if (!hasGroups) current = 1;
    else if (!hasMembers) current = 2;
    else current = 3;
    return { logged, hasGroups, hasMembers, counts: c, current };
  }

  function stepperHtml() {
    const p = progressSnapshot();
    const steps = [
      { title: "登录 QQ", sub: p.logged ? "已登录" : "扫码或粘贴 Cookie", done: p.logged, href: "#/data", action: p.logged ? "" : "去登录" },
      { title: "同步群列表", sub: p.hasGroups ? `${num(p.counts.groups)} 个群` : "还没同步", done: p.hasGroups, href: "#/groups", action: p.hasGroups ? "" : "去同步" },
      { title: "同步成员", sub: p.hasMembers ? `${num(p.counts.memberships)} 人次` : "还没同步", done: p.hasMembers, href: "#/data", action: p.hasMembers ? "" : "去同步" },
      { title: "开始分析", sub: p.hasMembers ? "数据已就绪" : "同步后解锁", done: false, href: "#/focus", action: p.hasMembers ? "单群透视" : "" },
    ];
    return `<ol class="stepper">${steps.map((st, i) => {
      const current = i === p.current;
      return `<li class="step ${st.done ? "done" : ""} ${current ? "current" : ""}">
        <span class="step-num">${st.done ? "✓" : i + 1}</span>
        <div class="step-copy"><div class="step-title">${esc(st.title)}</div><div class="step-sub">${esc(st.sub)}</div></div>
        ${st.action ? `<a class="btn btn-sm" href="${st.href}">${esc(st.action)}</a>` : ""}
      </li>`;
    }).join("")}</ol>`;
  }

  function updateNextStep() {
    const el = $("#nextStep");
    if (!el) return;
    const p = progressSnapshot();
    if (p.hasMembers) {
      el.hidden = true;
      return;
    }
    let icon = "✦";
    let title = "";
    let text = "";
    let actions = "";
    if (!p.logged) {
      title = "先扫码登录 QQ";
      text = "登录后才能同步你已加入的群。普通成员身份就够，不需要管理员。";
      actions = `<a class="btn btn-primary btn-sm" href="#/data">去登录</a>`;
    } else if (!p.hasGroups) {
      title = "群列表还没同步";
      text = "下一步：从 qun.qq.com 拉取你已加入的群。";
      actions = `<button class="btn btn-primary btn-sm" data-action="start-sync" data-mode="groups">同步群列表</button>`;
    } else if (!p.hasMembers) {
      title = "成员名单还没同步";
      text = `已经拿到 ${num(p.counts.groups)} 个群，下一步逐群拉取成员，之后就能做重合分析。`;
      actions = `<button class="btn btn-primary btn-sm" data-action="start-sync" data-mode="full">同步全部成员</button>`;
    } else {
      el.hidden = true;
      return;
    }
    el.innerHTML = `<span class="next-icon">${icon}</span>
      <div class="next-copy"><strong>${esc(title)}</strong><p>${esc(text)}</p></div>
      <div class="next-actions">${actions}<a class="btn btn-sm" href="#/data">打开同步页</a></div>`;
    el.hidden = false;
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
    focus: { title: "单群透视", subtitle: "选一个群，看看群友还在哪些群", render: renderFocus },
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
    try {
      await refreshSession();
    } catch (err) {
      console.warn("session refresh failed", err);
    }
    updateNextStep();
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
  function buildHero(stats) {
    const p = progressSnapshot();
    let cta = `<a class="btn btn-primary" href="#/data">扫码登录</a>`;
    if (p.logged && !p.hasGroups) cta = `<button class="btn btn-primary" data-action="start-sync" data-mode="groups">同步群列表</button>`;
    else if (p.logged && !p.hasMembers) cta = `<button class="btn btn-primary" data-action="start-sync" data-mode="full">同步全部成员</button>`;
    else if (p.hasMembers) cta = `<a class="btn btn-primary" href="#/focus">开始单群透视</a>`;
    return `<section class="hero">
      <div class="hero-copy">
        <span class="hero-eyebrow">✦ QQ 群友关系分析</span>
        <h2 class="hero-title">谁和你混在同一个<br><em>小团体</em>里？</h2>
        <p class="hero-desc">同步你已加入的群，看看谁同时在 A 群和 B 群、谁最近最活跃、每个群友在别的群叫什么，以及哪些群之间人员流动最紧密。</p>
        <div class="hero-actions">
          ${cta}
          <a class="btn" href="#/overlap">做交叉分析</a>
          <a class="btn btn-ghost" href="#/network">看群网络</a>
        </div>
        <div class="hero-stat-row">
          <div class="hero-stat"><strong>${num(stats.groups)}</strong><span>群聊</span></div>
          <div class="hero-stat"><strong>${num(stats.unique_members)}</strong><span>独立群友</span></div>
          <div class="hero-stat"><strong>${num(stats.multi_group_members)}</strong><span>跨群群友</span></div>
          <div class="hero-stat"><strong>${num(stats.active_7d)}</strong><span>7 日活跃</span></div>
        </div>
      </div>
      <div class="hero-art">
        ${meme("goodGroupmates", "meme-hero m1 meme-float", "--rot:-6deg")}
        ${meme("callEveryone", "meme-md m2", "--rot:7deg")}
        ${meme("soStrong", "meme-sm m3", "--rot:-10deg")}
      </div>
    </section>`;
  }

  async function renderDashboard() {
    const [stats, groupsData] = await Promise.all([api("/api/stats"), api("/api/groups")]);
    state.groups = groupsData.groups || [];
    const view = $("#view");

    if (!stats.groups) {
      view.innerHTML = `${buildHero(stats)}${stepperHtml()}
        <div class="card"><div class="card-body">
          ${emptyState("◈", "还没有群数据", "登录 QQ 后同步你加入的群，就能看到跨群重合、活跃度和群关系网络。", '<a class="btn btn-primary" href="#/data">去登录 / 同步</a>', "fanGroup")}
        </div></div>`;
      return;
    }

    const active30Percent = pct(stats.active_30d, stats.unique_members);
    const multiPercent = pct(stats.multi_group_members, stats.unique_members);
    const maxPair = Math.max(...(stats.top_pairs || []).map((p) => p.shared), 1);
    const maxHist = Math.max(...(stats.activity_histogram || []).map((h) => h.count), 1);
    const maxTrend = Math.max(...(stats.join_trend || []).map((t) => t.count), 1);

    const topMembers = (stats.top_members || []).map((m, i) => {
      const display = m.nick || m.card || m.uin;
      return `
      <div class="list-row">
        <span class="rank">${i + 1}</span>
        ${memberAvatar(m.uin, display, "member-avatar sm")}
        <div class="main" data-action="open-member" data-uin="${esc(m.uin)}" style="cursor:pointer">
          <div class="name">${esc(display)}</div>
          <div class="sub">在 ${m.group_count} 个群 · ${esc(ago(m.last_speak_time))}</div>
        </div>
        ${m.is_friend ? '<span class="badge badge-green">好友</span>' : ""}
        <span class="val">${m.group_count}</span>
      </div>`;
    }).join("");

    const topPairs = (stats.top_pairs || []).map((p) => `
      <div class="list-row" data-action="select-pair" data-a="${esc(p.a_gc)}" data-b="${esc(p.b_gc)}" style="cursor:pointer">
        <div class="main">
          <div class="name" style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
            ${groupAvatar(p.a_gc, p.a_name, "group-avatar xs")} ${esc(p.a_name)}
            <span class="muted">×</span>
            ${groupAvatar(p.b_gc, p.b_name, "group-avatar xs")} ${esc(p.b_name)}
          </div>
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
      ${buildHero(stats)}
      ${stepperHtml()}
      <div class="stat-grid">
        ${statCard("群聊数", num(stats.groups), `已同步 <strong>${num(stats.groups)}</strong> 个群`, "coral", "▤")}
        ${statCard("独立群友", num(stats.unique_members), `共 <strong>${num(stats.memberships)}</strong> 人次`, "teal", "◎")}
        ${statCard("跨群群友", num(stats.multi_group_members), `占全部群友 <strong>${multiPercent}</strong>`, "pink", "⨯")}
        ${statCard("7 日活跃", num(stats.active_7d), `30 日活跃 <strong>${num(stats.active_30d)}</strong>（${active30Percent}）`, "sun", "⚡")}
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><div><h2>跨群最多的人</h2><p>同时出现在多个群里，点击查看 TA 的完整轨迹 · 其中 <strong>${num(stats.potential_friends)}</strong> 位还不是好友</p></div><a class="btn btn-sm btn-ghost" href="#/members">全部群友</a></div>
          <div class="card-body tight">
            ${topMembers || emptyState("⌕", "还没有跨群群友", "同步更多群后，这里会自动找出重合的人。", "", "nobodyPlays")}
            ${topMembers ? `<div class="guide-note" style="margin:10px 8px 2px">${meme("nobodyPlays", "meme-sm")}<div><strong>点击任意群友</strong>，可以看 TA 在哪些群、每个群用什么群名片。</div></div>` : ""}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>群重合排行</h2><p>两个群之间有多少共同成员</p></div><a class="btn btn-sm btn-ghost" href="#/overlap">交叉分析</a></div>
          <div class="card-body tight">
            ${topPairs || emptyState("⨯", "还没有重合数据", "至少同步两个群才能计算重合。", "", "mysteryA")}
            ${topPairs ? `<div class="guide-note" style="margin:10px 8px 2px">${meme("mysteryA", "meme-sm")}<div>点一条重合排行，会直接跳到这两个群的共同成员名单。</div></div>` : ""}
          </div>
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

      <div class="guide-note mt-16">
        ${meme("takeNotes", "meme-sm")}
        <div><strong>怎么用：</strong>先看「单群透视」找到某个群的跨群成员，再用「交叉分析」精确对比两三个群；「群网络」适合看整体格局，群多时可以切到和弦图或热力图。</div>
      </div>

      <div class="grid-3 mt-16">
        <a class="card" href="#/focus" style="text-decoration:none;color:inherit"><div class="card-body">
          <h2 style="font-size:15px">◎ 单群透视</h2>
          <p class="muted small" style="margin-top:6px">选一个群，看看哪些群友还在其他群、他们在别的群叫什么。</p>
        </div></a>
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
          <p class="muted small" style="margin-top:6px">力导向图、和弦图、热力图，三种视角看群关系。</p>
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
      <div class="guide-note" style="margin-bottom:14px">
        ${meme("fanGroup", "meme-sm")}
        <div><strong>点开任意群</strong>可以看成员名单；想从「一个人」出发看跨群轨迹，去「单群透视」更快。</div>
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
          <div style="display:flex;align-items:center;gap:11px;min-width:0">
            ${groupAvatar(g.gc, g.name || g.gc, "group-avatar")}
            <div style="min-width:0">
              <div class="group-name">${esc(g.name || `群 ${g.gc}`)}</div>
              <div class="group-gc">群号 ${esc(g.gc)}</div>
            </div>
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
        <div style="display:flex;align-items:center;gap:14px;min-width:0">
          ${groupAvatar(g.gc, g.name || g.gc, "group-avatar lg")}
          <div style="min-width:0">
            <a class="small muted" href="#/groups">← 返回群聊列表</a>
            <h2 style="margin-top:6px">${esc(g.name || `群 ${g.gc}`)}</h2>
            <p>群号 ${esc(g.gc)} · ${g.role === "create" ? "我创建的群" : g.role === "manage" ? "我管理的群" : "我加入的群"} · ${g.synced_at ? "同步于 " + esc(fmtSync(g.synced_at)) : "尚未同步成员"}</p>
          </div>
        </div>
        <div class="actions">
          <a class="btn btn-primary" href="#/focus/${esc(g.gc)}">单群透视</a>
          <button class="btn" data-action="sync-group" data-gc="${esc(g.gc)}">同步本群</button>
          <button class="btn" data-action="export" data-kind="members" data-gc="${esc(g.gc)}">导出 CSV</button>
          <button class="btn btn-danger" data-action="delete-group" data-gc="${esc(g.gc)}" data-name="${esc(g.name || g.gc)}">删除</button>
        </div>
      </div>

      <div class="guide-note" style="margin-bottom:14px">
        ${meme("rule", "meme-sm")}
        <div><strong>想知道这群人还在哪些群？</strong>点「单群透视」可以看每位群友的其他群、其他群名片，还能按跨群数排序。</div>
      </div>

      <div class="stat-grid">
        ${statCard("群成员", num(s.total), `好友 <strong>${num(s.friends)}</strong> 人`, "coral", "▤")}
        ${statCard("7 日活跃", num(s.active_7d), `30 日活跃 <strong>${num(s.active_30d)}</strong>`, "teal", "⚡")}
        ${statCard("90 天潜水", num(s.inactive_90d), `占比 <strong>${pct(s.inactive_90d, s.total)}</strong>`, "sun", "◌")}
        ${statCard("30 天新成员", num(s.new_30d), `群主 ${s.owners} · 管理员 ${s.admins}`, "pink", "＋")}
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><div><h2>最近活跃</h2><p>按最后发言时间排序</p></div></div>
          <div class="card-body tight">
            ${(detail.top_active || []).map((m, i) => `<div class="list-row">
              <span class="rank">${i + 1}</span>
              ${memberAvatar(m.uin, m.nick || m.card || m.uin, "member-avatar sm")}
              <div class="main" data-action="open-member" data-uin="${esc(m.uin)}" style="cursor:pointer">
                <div class="name">${esc(m.nick || m.card || m.uin)}</div>
                <div class="sub">${esc(m.card || m.uin)} · ${esc(ago(m.last_speak_time))}</div>
              </div>
              ${m.is_friend ? '<span class="badge badge-green">好友</span>' : ""}
            </div>`).join("") || emptyState("⚡", "暂无活跃数据", "同步成员后即可查看。", "", "ignoreYou")}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>最近入群</h2><p>按入群时间排序</p></div></div>
          <div class="card-body tight">
            ${(detail.recent_joiners || []).map((m, i) => `<div class="list-row">
              <span class="rank">${i + 1}</span>
              ${memberAvatar(m.uin, m.nick || m.card || m.uin, "member-avatar sm")}
              <div class="main" data-action="open-member" data-uin="${esc(m.uin)}" style="cursor:pointer">
                <div class="name">${esc(m.nick || m.card || m.uin)}</div>
                <div class="sub">${esc(fmtDate(m.join_time))} 入群 · ${esc(m.card || m.uin)}</div>
              </div>
            </div>`).join("") || emptyState("＋", "暂无入群数据", "同步成员后即可查看。", "", "takeNotes")}
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

  /* --------------------------------------------------------------- focus */
  async function renderFocus(param) {
    await loadGroups();
    const view = $("#view");
    if (!state.groups.length) {
      view.innerHTML = `<div class="card"><div class="card-body">${emptyState("◎", "还没有群数据", "先登录并同步群列表，再来做单群透视。", '<a class="btn btn-primary" href="#/data">去登录 / 同步</a>', "ignoreYou")}</div></div>`;
      return;
    }
    const withMembers = state.groups.filter((g) => (g.member_count || 0) > 0);
    let gc = param || state.focusGc;
    if (!gc || !state.groups.some((g) => g.gc === gc)) {
      gc = (withMembers[0] || state.groups[0]).gc;
    }
    state.focusGc = gc;
    const data = await api(`/api/focus?gc=${encodeURIComponent(gc)}&limit=2000`);
    state.focusData = data;
    const g = data.group;
    const s = data.stats;
    const maxRelated = Math.max(...(data.related || []).map((r) => r.shared), 1);
    const maxDist = Math.max(...(data.distribution || []).map((d) => d.count), 1);
    const distRows = (data.distribution || []).map((d, i) => `
      <div class="bar-row">
        <span class="bar-label">${esc(d.label)}</span>
        <div class="bar-track"><div class="bar-fill ${["green", "", "amber", "red"][i] || ""}" style="width:${Math.round((d.count / maxDist) * 100)}%"></div></div>
        <span class="bar-value">${num(d.count)}</span>
      </div>`).join("");
    const relatedRows = (data.related || []).map((r) => `
      <div class="related-row">
        ${groupAvatar(r.gc, r.name, "group-avatar sm")}
        <div class="main">
          <div class="name">${esc(r.name)}</div>
          <div class="bar-track" style="margin-top:5px"><div class="bar-fill" style="width:${Math.round((r.shared / maxRelated) * 100)}%"></div></div>
        </div>
        <span class="val">${num(r.shared)}</span>
      </div>`).join("") || emptyState("◌", "没有关联群", "这个群的成员暂时没有加入其他已同步的群。", "", "mysteryA");

    view.innerHTML = `
      <div class="page-head">
        <div><h2>单群透视</h2><p>选一个群，看看哪些群友还在其他群、他们在别的群叫什么</p></div>
        <div class="actions">${meme("ignoreYou", "meme-sm", "--rot:6deg")}</div>
      </div>
      <div class="focus-toolbar">
        <label class="small muted">选择群聊</label>
        <select class="select" id="focusSelect" style="min-width:240px">
          ${state.groups.map((x) => `<option value="${esc(x.gc)}" ${x.gc === gc ? "selected" : ""}>${esc(x.name || x.gc)}（${num(x.member_count)} 人）</option>`).join("")}
        </select>
        <a class="btn btn-sm" href="#/groups/${esc(gc)}">群详情</a>
        <button class="btn btn-sm" data-action="sync-group" data-gc="${esc(gc)}">同步本群</button>
        <div class="spacer"></div>
        <span class="small muted">数据来自最近一次同步</span>
      </div>

      <div class="focus-header">
        ${groupAvatar(g.gc, g.name || g.gc, "group-avatar")}
        <div class="focus-title">
          <h2>${esc(g.name || g.gc)}</h2>
          <p>群号 ${esc(g.gc)} · ${num(s.total)} 位成员 · ${num(s.related_groups)} 个关联群</p>
          <div class="chips">
            <span class="badge badge-blue">${num(s.multi_group)} 位跨群</span>
            <span class="badge badge-amber">${num(s.bridge)} 位桥梁成员</span>
            <span class="badge badge-muted">平均 ${s.avg_other_groups} 个其他群</span>
          </div>
        </div>
        <div style="margin-left:auto">${meme("mysteryA", "meme-md", "--rot:-5deg")}</div>
      </div>

      <div class="stat-grid">
        ${statCard("本群成员", num(s.total), "同步后的当前快照", "coral", "▤")}
        ${statCard("跨群成员", num(s.multi_group), `占 ${pct(s.multi_group, s.total)}`, "teal", "⨯")}
        ${statCard("桥梁成员", num(s.bridge), "还在 3+ 个其他群", "sun", "◎")}
        ${statCard("关联群", num(s.related_groups), `平均 ${s.avg_other_groups} 个其他群`, "pink", "◉")}
      </div>

      <div class="focus-grid">
        <div class="card">
          <div class="card-head">
            <div><h2>成员跨群名单</h2><p>点任意成员看 TA 在每个群的昵称和群名片</p></div>
            <span class="badge badge-blue" id="focusCount"></span>
          </div>
          <div class="card-body">
            <div class="focus-toolbar">
              <input class="input" id="focusSearch" placeholder="搜索昵称 / 群名片 / QQ…" value="${esc(state.focusQuery)}" style="max-width:260px">
              <label class="small muted" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="focusOnlyMulti" ${state.focusOnlyMulti ? "checked" : ""}> 只看跨群成员</label>
              <div class="spacer"></div>
              <span class="small muted">按跨群数排序</span>
            </div>
            <div class="table-wrap" style="max-height:660px">
              <table class="data focus-member-table">
                <thead><tr><th>群友</th><th>本群昵称 / 名片</th><th>其他群昵称 / 名片</th><th>跨群数</th><th>最后发言</th></tr></thead>
                <tbody id="focusBody"></tbody>
              </table>
            </div>
          </div>
        </div>
        <div>
          <div class="card">
            <div class="card-head"><div><h2>跨群分布</h2><p>本群成员还在几个其他群</p></div></div>
            <div class="card-body"><div class="bar-chart">${distRows}</div></div>
          </div>
          <div class="card mt-16">
            <div class="card-head"><div><h2>与本群重合最多的群</h2><p>按共同成员数排序</p></div></div>
            <div class="card-body tight" id="focusRelated">${relatedRows}</div>
          </div>
          <div class="card mt-16">
            <div class="card-head"><div><h2>本群关系辐射</h2><p>中心是本群，周围是关联群</p></div></div>
            <div class="card-body"><div class="ego-wrap" id="focusEgo"></div></div>
          </div>
          <div class="guide-note mt-16">
            ${meme("mysteryB", "meme-sm")}
            <div>「桥梁成员」= 除了本群，还在 3 个以上其他群的人。他们通常是把不同小团体连起来的关键节点。</div>
          </div>
        </div>
      </div>
    `;

    $("#focusSelect").addEventListener("change", (e) => {
      state.focusGc = e.target.value;
      state.focusQuery = "";
      go(`#/focus/${e.target.value}`);
    });

    const draw = () => {
      const q = state.focusQuery.trim().toLowerCase();
      let rows = data.members || [];
      if (state.focusOnlyMulti) rows = rows.filter((m) => (m.other_count || 0) > 0);
      if (q) {
        rows = rows.filter((m) =>
          String(m.uin).includes(q) ||
          (m.nick || "").toLowerCase().includes(q) ||
          (m.card || "").toLowerCase().includes(q) ||
          (m.other_groups || []).some((x) =>
            (x.card || "").toLowerCase().includes(q) ||
            (x.nick || "").toLowerCase().includes(q) ||
            (x.group_name || "").toLowerCase().includes(q)
          )
        );
      }
      const count = $("#focusCount");
      if (count) count.textContent = `${num(rows.length)} / ${num((data.members || []).length)} 人`;
      const body = $("#focusBody");
      body.innerHTML = rows.map((m) => {
        const others = m.other_groups || [];
        const nickChips = others.slice(0, 3).map((x) =>
          `<span class="nick-chip" title="${esc(x.group_name)} · 昵称 ${esc(x.nick || "—")} · 名片 ${esc(x.card || "—")}"><b>${esc(x.group_name)}</b> · ${esc(x.card || x.nick || "—")}</span>`
        ).join("");
        const more = others.length > 3 ? `<span class="nick-chip">+${others.length - 3} 个群</span>` : "";
        return `<tr class="clickable" data-action="open-member" data-uin="${esc(m.uin)}">
          <td>${userCell(m.uin, m.nick, m.card, { avatar: true, avatarClass: "member-avatar sm" })}</td>
          <td><span class="nick-chip current"><b>${esc(m.nick || m.card || "—")}</b>${m.card && m.card !== m.nick ? ` · ${esc(m.card)}` : ""}</span></td>
          <td><div class="nick-compare">${nickChips || '<span class="muted small">只在本群</span>'}${more}</div></td>
          <td class="num"><span class="badge ${m.other_count >= 3 ? "badge-amber" : m.other_count > 0 ? "badge-blue" : "badge-muted"}">${m.other_count}</span></td>
          <td class="nowrap">${esc(ago(m.last_speak_time))}</td>
        </tr>`;
      }).join("") || `<tr><td colspan="5">${emptyState("⌕", "没有匹配的成员", "试试关掉「只看跨群成员」或换个关键词。", "", "ignoreYou")}</td></tr>`;
    };
    $("#focusSearch").addEventListener("input", debounce((e) => {
      state.focusQuery = e.target.value;
      draw();
    }, 220));
    $("#focusOnlyMulti").addEventListener("change", (e) => {
      state.focusOnlyMulti = e.target.checked;
      draw();
    });
    draw();
    drawEgo(data.ego, $("#focusEgo"));
  }

  function drawEgo(ego, container) {
    if (!container) return;
    const nodes = (ego && ego.nodes) || [];
    if (nodes.length < 2) {
      container.innerHTML = emptyState("◌", "没有可画的关联群", "同步更多群后，这里会出现以本群为中心的辐射图。", "", "mysteryA");
      return;
    }
    const width = 420, height = 340, cx = width / 2, cy = height / 2;
    const related = nodes.slice(1);
    const radius = 120;
    const maxShared = Math.max(...(ego.edges || []).map((e) => e.shared), 1);
    const center = nodes[0];
    const centerR = 40;
    const nodeR = 24;
    const pos = related.map((n, i) => {
      const angle = (i / related.length) * Math.PI * 2 - Math.PI / 2;
      return { ...n, x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
    });
    const edges = (ego.edges || []).map((e) => {
      const target = pos.find((p) => p.gc === e.b);
      if (!target) return "";
      const w = 1 + (e.shared / maxShared) * 5;
      return `<line x1="${cx}" y1="${cy}" x2="${target.x}" y2="${target.y}" stroke="var(--accent)" stroke-width="${w}" opacity="0.25"><title>${e.shared} 位共同成员</title></line>`;
    }).join("");
    const centerSvg = `<clipPath id="ego-center-clip"><circle cx="${cx}" cy="${cy}" r="${centerR}"/></clipPath>
      <circle cx="${cx}" cy="${cy}" r="${centerR}" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="2"/>
      <image href="/api/avatar/group/${encodeURIComponent(center.gc)}" x="${cx - centerR}" y="${cy - centerR}" width="${centerR * 2}" height="${centerR * 2}" clip-path="url(#ego-center-clip)" preserveAspectRatio="xMidYMid slice"/>`;
    const relatedSvg = pos.map((n, i) => {
      const clip = `ego-clip-${i}`;
      const label = (n.name || n.gc).slice(0, 8);
      return `<g>
        <clipPath id="${clip}"><circle cx="${n.x}" cy="${n.y}" r="${nodeR}"/></clipPath>
        <circle cx="${n.x}" cy="${n.y}" r="${nodeR}" fill="var(--panel-3)" stroke="var(--panel)" stroke-width="2"/>
        <image href="/api/avatar/group/${encodeURIComponent(n.gc)}" x="${n.x - nodeR}" y="${n.y - nodeR}" width="${nodeR * 2}" height="${nodeR * 2}" clip-path="url(#${clip})" preserveAspectRatio="xMidYMid slice"/>
        <text x="${n.x}" y="${n.y + nodeR + 13}" text-anchor="middle" class="ego-label">${esc(label)}</text>
      </g>`;
    }).join("");
    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="本群关系辐射图">
      ${edges}${centerSvg}${relatedSvg}
      <text x="${cx}" y="${cy + centerR + 16}" text-anchor="middle" class="ego-center-label">${esc((center.name || center.gc).slice(0, 10))}</text>
    </svg>`;
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
        ${groupAvatar(g.gc, g.name || g.gc, "group-avatar sm")}
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
          <div class="venn-stat"><div class="n">${num(s.only_a)}</div><div class="l" style="display:flex;align-items:center;justify-content:center;gap:5px">${groupAvatar(a.gc, a.name, "group-avatar xs")} 只在「${esc(a.name || a.gc)}」</div></div>
          <div class="venn-stat both"><div class="n">${num(s.both)}</div><div class="l">两个群都在</div></div>
          <div class="venn-stat"><div class="n">${num(s.only_b)}</div><div class="l" style="display:flex;align-items:center;justify-content:center;gap:5px">${groupAvatar(b.gc, b.name, "group-avatar xs")} 只在「${esc(b.name || b.gc)}」</div></div>
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
            <td>${userCell(m.uin, m.nick, m.card, { avatar: true, avatarClass: "member-avatar sm" })}</td>
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
        ${table}
        <div class="guide-note mt-16">
          ${meme("mysteryB", "meme-sm")}
          <div>共同成员列表里点任意一个人，可以看到 TA 在所有群的群名片；导出按钮会把这份名单保存为 CSV。</div>
        </div>`;
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
      const header = nodes.map((g) => `<th title="${esc(g.name || g.gc)}">${groupAvatar(g.gc, g.name || g.gc, "group-avatar xs")}<div>${esc((g.name || g.gc).slice(0, 8))}</div></th>`).join("");
      const rows = nodes.map((row) => {
        const cells = nodes.map((col) => {
          if (row.gc === col.gc) return `<td class="diag">·</td>`;
          const key = row.gc < col.gc ? `${row.gc}|${col.gc}` : `${col.gc}|${row.gc}`;
          const value = map.get(key) || 0;
          const alpha = value ? 0.12 + (value / max) * 0.55 : 0;
          return `<td class="${value ? "" : "zero"}" style="background:rgba(255,107,94,${alpha})" data-action="select-pair" data-a="${esc(row.gc)}" data-b="${esc(col.gc)}" title="${esc(row.name || row.gc)} × ${esc(col.name || col.gc)}：${value} 人">${value || ""}</td>`;
        }).join("");
        return `<tr><th class="row-head" title="${esc(row.name || row.gc)}">${groupAvatar(row.gc, row.name || row.gc, "group-avatar xs")} ${esc((row.name || row.gc).slice(0, 12))}</th>${cells}</tr>`;
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
      <div class="guide-note" style="margin-bottom:14px">
        ${meme("soStrong", "meme-sm")}
        <div><strong>想按群看人？</strong>去「单群透视」选一个群，就能看到这群人还在哪些群、在别的群用什么群名片。</div>
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
          wrap.innerHTML = `<div class="card-body">${emptyState("⌕", "没有找到群友", "换个关键词，或先同步更多群。", "", "ignoreYou")}</div>`;
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
      <div class="guide-note" style="margin-bottom:14px">
        ${meme("rule", "meme-sm")}
        <div><strong>活跃度是「最后发言时间」快照</strong>，不是完整聊天统计。想找小团体核心，可以结合「单群透视」里的桥梁成员一起看。</div>
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
          wrap.innerHTML = `<div class="card-body">${emptyState("⚡", "没有符合条件的成员", "换个时间范围或群聊试试。", "", "nobodyPlays")}</div>`;
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
  const NET_COLORS = ["#ff6b5e", "#1f9d8b", "#ffb703", "#e05a9e", "#4d7cff", "#8a6a4f", "#9bc53d", "#f28482"];

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function detectCommunities(nodes, edges) {
    const index = new Map(nodes.map((n, i) => [n.gc, i]));
    const adj = nodes.map(() => []);
    for (const e of edges) {
      const a = index.get(e.a), b = index.get(e.b);
      if (a === undefined || b === undefined) continue;
      adj[a].push([b, e.shared]);
      adj[b].push([a, e.shared]);
    }
    const labels = nodes.map((_, i) => i);
    for (let iter = 0; iter < 14; iter++) {
      let changed = false;
      for (let i = 0; i < nodes.length; i++) {
        const counts = new Map();
        for (const [j, w] of adj[i]) counts.set(labels[j], (counts.get(labels[j]) || 0) + w);
        let best = labels[i], bestW = -1;
        for (const [label, w] of counts) {
          if (w > bestW || (w === bestW && label === labels[i])) {
            best = label;
            bestW = w;
          }
        }
        if (best !== labels[i]) {
          labels[i] = best;
          changed = true;
        }
      }
      if (!changed) break;
    }
    const unique = [...new Set(labels)];
    const map = new Map(unique.map((label, i) => [label, i]));
    return labels.map((label) => map.get(label));
  }

  function forceLayout(nodes, edges, width, height, seed) {
    const rand = mulberry32(seed);
    const index = new Map(nodes.map((n, i) => [n.gc, i]));
    const pos = nodes.map((_, i) => {
      const angle = (i / nodes.length) * Math.PI * 2;
      return {
        x: width / 2 + Math.cos(angle) * 170 + (rand() - 0.5) * 30,
        y: height / 2 + Math.sin(angle) * 170 + (rand() - 0.5) * 30,
        vx: 0,
        vy: 0,
      };
    });
    const links = edges
      .map((e) => ({ s: index.get(e.a), t: index.get(e.b), w: e.shared }))
      .filter((l) => l.s !== undefined && l.t !== undefined);
    const maxW = Math.max(...links.map((l) => l.w), 1);
    for (let iter = 0; iter < 340; iter++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          let dx = pos[j].x - pos[i].x;
          let dy = pos[j].y - pos[i].y;
          let d2 = dx * dx + dy * dy || 0.01;
          let d = Math.sqrt(d2) || 1;
          let force = 5600 / d2;
          let fx = (dx / d) * force;
          let fy = (dy / d) * force;
          pos[i].vx -= fx;
          pos[i].vy -= fy;
          pos[j].vx += fx;
          pos[j].vy += fy;
        }
      }
      for (const l of links) {
        const a = pos[l.s], b = pos[l.t];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.sqrt(dx * dx + dy * dy) || 1;
        const weight = 0.45 + (l.w / maxW) * 0.9;
        const rest = 150 - (l.w / maxW) * 55;
        const force = (d - rest) * 0.012 * weight;
        let fx = (dx / d) * force;
        let fy = (dy / d) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
      for (const p of pos) {
        p.vx += (width / 2 - p.x) * 0.0022;
        p.vy += (height / 2 - p.y) * 0.0022;
        p.vx *= 0.86;
        p.vy *= 0.86;
        p.x += p.vx;
        p.y += p.vy;
        p.x = Math.max(55, Math.min(width - 55, p.x));
        p.y = Math.max(55, Math.min(height - 55, p.y));
      }
    }
    return pos;
  }

  function polar(cx, cy, r, angle) {
    return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
  }

  function bindNetworkZoom(svg, viewport) {
    let scale = 1, tx = 0, ty = 0;
    let dragging = false, startX = 0, startY = 0;
    const apply = () => viewport.setAttribute("transform", `translate(${tx},${ty}) scale(${scale})`);
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const mx = ((e.clientX - rect.left) / rect.width) * 920;
      const my = ((e.clientY - rect.top) / rect.height) * 620;
      const next = Math.max(0.55, Math.min(2.6, scale * (e.deltaY < 0 ? 1.12 : 0.89)));
      tx = mx - (mx - tx) * (next / scale);
      ty = my - (my - ty) * (next / scale);
      scale = next;
      apply();
    }, { passive: false });
    svg.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".net-node")) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      try { svg.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    svg.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const rect = svg.getBoundingClientRect();
      tx += ((e.clientX - startX) / rect.width) * 920;
      ty += ((e.clientY - startY) / rect.height) * 620;
      startX = e.clientX;
      startY = e.clientY;
      apply();
    });
    svg.addEventListener("pointerup", (e) => {
      dragging = false;
      try { svg.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    });
  }

  async function renderNetwork() {
    const view = $("#view");
    const n = state.network;
    view.innerHTML = `
      <div class="page-head">
        <div><h2>群关系网络</h2><p>力导向图看结构，和弦图看流量，热力图看两两重合</p></div>
        <div class="actions">
          <button class="btn" data-action="network-relayout">重新布局</button>
          ${meme("linuxPanic", "meme-sm", "--rot:-6deg")}
        </div>
      </div>
      <div class="toolbar">
        <div class="segmented" id="networkTabs">
          <button data-mode="force" class="${n.mode === "force" ? "active" : ""}">力导向图</button>
          <button data-mode="chord" class="${n.mode === "chord" ? "active" : ""}">和弦图</button>
          <button data-mode="heatmap" class="${n.mode === "heatmap" ? "active" : ""}">热力图</button>
        </div>
        <label class="small muted">最少共同成员</label>
        <input class="input" type="number" min="1" value="${n.minShared}" id="networkMin" style="width:90px">
        <label class="small muted">显示群数</label>
        <select class="select" id="networkNodes">
          <option value="20">20 个</option>
          <option value="30">30 个</option>
          <option value="40">40 个</option>
          <option value="60">60 个</option>
        </select>
        <label class="small muted" id="chordTopLabel" ${n.mode !== "chord" ? "hidden" : ""}>和弦群数</label>
        <select class="select" id="networkChordTop" ${n.mode !== "chord" ? "hidden" : ""}>
          <option value="8">8 个</option>
          <option value="12">12 个</option>
          <option value="16">16 个</option>
          <option value="20">20 个</option>
        </select>
        <div class="spacer"></div>
        <span class="small muted" id="networkSummary"></span>
      </div>
      <div class="card">
        <div class="network-canvas" id="networkWrap">
          <div class="card-body">${loadingBlock("正在计算群关系…")}</div>
        </div>
      </div>
      <div class="guide-note mt-16">
        ${meme("mysteryC", "meme-sm")}
        <div><strong>群多了怎么办？</strong>力导向图适合看整体结构；和弦图只显示共同成员最多的群，丝带越粗代表重合越多；热力图适合精确比较两两群。</div>
      </div>
      <div class="card mt-16">
        <div class="card-head"><div><h2>重合最强的群对</h2><p>共同成员数量最多的组合</p></div></div>
        <div class="card-body tight" id="networkPairs"></div>
      </div>
    `;
    $("#networkNodes").value = String(n.maxNodes);
    $("#networkChordTop").value = String(n.chordTop);

    const load = async () => {
      const wrap = $("#networkWrap");
      wrap.innerHTML = `<div class="card-body">${loadingBlock("正在计算群关系…")}</div>`;
      try {
        const data = await api(`/api/network?min_shared=${n.minShared}&max_nodes=${n.maxNodes}`);
        n.data = data;
        const summary = $("#networkSummary");
        if (summary) summary.textContent = `${data.nodes.length} 个群 · ${data.edges.length} 条关系`;
        drawNetwork();
      } catch (err) {
        wrap.innerHTML = `<div class="card-body"><div class="notice warn"><span class="ico">!</span><div>${esc(err.message)}</div></div></div>`;
      }
    };

    $$("#networkTabs button").forEach((btn) => btn.addEventListener("click", () => {
      n.mode = btn.dataset.mode;
      n.focusGc = null;
      $$("#networkTabs button").forEach((b) => b.classList.toggle("active", b === btn));
      const chordLabel = $("#chordTopLabel");
      const chordSelect = $("#networkChordTop");
      if (chordLabel) chordLabel.hidden = n.mode !== "chord";
      if (chordSelect) chordSelect.hidden = n.mode !== "chord";
      drawNetwork();
    }));
    $("#networkMin").addEventListener("change", (e) => {
      n.minShared = Math.max(1, Number(e.target.value) || 1);
      load();
    });
    $("#networkNodes").addEventListener("change", (e) => {
      n.maxNodes = Number(e.target.value);
      load();
    });
    $("#networkChordTop").addEventListener("change", (e) => {
      n.chordTop = Number(e.target.value);
      drawNetwork();
    });
    load();
  }

  function drawNetwork() {
    const wrap = $("#networkWrap");
    const data = state.network.data;
    if (!wrap || !data) return;
    if (state.network.mode === "chord") drawChordDiagram(data, wrap);
    else if (state.network.mode === "heatmap") drawHeatmap(data, wrap);
    else drawForceGraph(data, wrap);
    renderNetworkPairs(data);
  }

  function drawForceGraph(data, wrap) {
    const nodes = data.nodes || [];
    const edges = data.edges || [];
    if (nodes.length < 2) {
      wrap.innerHTML = `<div class="card-body">${emptyState("◉", "关系数据不足", "至少同步两个有共同成员的群，才能画出网络。", "", "linuxPanic")}</div>`;
      return;
    }
    const width = 920, height = 620;
    const pos = forceLayout(nodes, edges, width, height, state.network.seed * 1000 + nodes.length);
    const communities = detectCommunities(nodes, edges);
    const communityCount = Math.max(...communities) + 1;
    const maxMembers = Math.max(...nodes.map((n) => n.member_count || 0), 1);
    const maxShared = Math.max(...edges.map((e) => e.shared || 0), 1);
    const index = new Map(nodes.map((n, i) => [n.gc, i]));
    const degree = new Map();
    for (const e of edges) {
      degree.set(e.a, (degree.get(e.a) || 0) + 1);
      degree.set(e.b, (degree.get(e.b) || 0) + 1);
    }
    const labelSet = new Set(
      nodes.length <= 22
        ? nodes.map((n) => n.gc)
        : nodes.slice().sort((a, b) => (b.member_count || 0) - (a.member_count || 0)).slice(0, 12).map((n) => n.gc)
    );
    const colorOf = (gc) => NET_COLORS[communities[index.get(gc)] % NET_COLORS.length];

    const edgeSvg = edges.map((e) => {
      const a = pos[index.get(e.a)], b = pos[index.get(e.b)];
      if (!a || !b) return "";
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const off = Math.min(38, len * 0.12);
      const cx = mx - (dy / len) * off;
      const cy = my + (dx / len) * off;
      const weight = (e.shared || 0) / maxShared;
      return `<path class="net-edge" data-a="${esc(e.a)}" data-b="${esc(e.b)}" d="M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}" fill="none" stroke-width="${(1 + Math.pow(weight, 0.7) * 6).toFixed(2)}" opacity="${(0.1 + weight * 0.5).toFixed(2)}"><title>${esc(e.a)} × ${esc(e.b)}：${num(e.shared)} 位共同成员</title></path>`;
    }).join("");

    const nodeSvg = nodes.map((node, i) => {
      const p = pos[i];
      const r = 11 + Math.sqrt((node.member_count || 0) / maxMembers) * 17;
      const color = colorOf(node.gc);
      const clip = `net-clip-${i}`;
      const showLabel = labelSet.has(node.gc);
      return `<g class="net-node" data-gc="${esc(node.gc)}" data-name="${esc(node.name || node.gc)}" data-members="${num(node.member_count)}" data-degree="${degree.get(node.gc) || 0}">
        <clipPath id="${clip}"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}"/></clipPath>
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" opacity="0.94"/>
        <image href="/api/avatar/group/${encodeURIComponent(node.gc)}" x="${(p.x - r).toFixed(1)}" y="${(p.y - r).toFixed(1)}" width="${(r * 2).toFixed(1)}" height="${(r * 2).toFixed(1)}" clip-path="url(#${clip})" preserveAspectRatio="xMidYMid slice"/>
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="${color}" stroke-width="2" opacity="0.85"/>
        ${showLabel ? `<text x="${p.x.toFixed(1)}" y="${(p.y + r + 14).toFixed(1)}" text-anchor="middle">${esc((node.name || node.gc).slice(0, 10))}</text>` : ""}
      </g>`;
    }).join("");

    const legend = Array.from({ length: Math.min(communityCount, NET_COLORS.length) }, (_, i) =>
      `<span class="net-legend-item"><span class="net-legend-dot" style="background:${NET_COLORS[i]}"></span>社区 ${i + 1}</span>`
    ).join("");

    let focusCard = "";
    if (state.network.focusGc) {
      const node = nodes.find((x) => x.gc === state.network.focusGc);
      if (node) {
        const neighbors = edges
          .filter((e) => e.a === node.gc || e.b === node.gc)
          .map((e) => ({ gc: e.a === node.gc ? e.b : e.a, shared: e.shared }))
          .sort((a, b) => b.shared - a.shared)
          .slice(0, 4);
        const names = new Map(nodes.map((x) => [x.gc, x.name || x.gc]));
        focusCard = `<div class="net-focus-card">
          <div style="display:flex;align-items:center;gap:9px">
            ${groupAvatar(node.gc, node.name || node.gc, "group-avatar sm")}
            <div style="min-width:0"><h4>${esc(node.name || node.gc)}</h4><p>${num(node.member_count)} 人 · ${degree.get(node.gc) || 0} 条关系</p></div>
          </div>
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:4px">
            ${neighbors.map((x) => `<div class="small muted" style="display:flex;justify-content:space-between;gap:8px"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(names.get(x.gc) || x.gc)}</span><b style="color:var(--text)">${num(x.shared)}</b></div>`).join("")}
          </div>
          <div class="actions">
            <a class="btn btn-sm btn-primary" href="#/groups/${esc(node.gc)}">群详情</a>
            <a class="btn btn-sm" href="#/focus/${esc(node.gc)}">单群透视</a>
            <button class="btn btn-sm" data-action="network-unfocus">取消聚焦</button>
          </div>
        </div>`;
      }
    }

    wrap.innerHTML = `<div class="net-tooltip" id="netTooltip"></div>${focusCard}
      <svg class="network-svg" id="netSvg" viewBox="0 0 ${width} ${height}" role="img" aria-label="群关系网络图">
        <rect class="net-bg" x="0" y="0" width="${width}" height="${height}" fill="rgba(0,0,0,0)"></rect>
        <g id="netViewport">${edgeSvg}${nodeSvg}</g>
      </svg>
      <div class="net-legend" style="padding:10px 14px 4px">${legend}<span class="net-legend-item"><span class="net-legend-dot" style="background:var(--accent)"></span>线越粗 = 共同成员越多</span></div>
      <div class="net-hint">滚轮缩放 · 拖拽平移 · 点击节点聚焦</div>`;

    const svg = $("#netSvg");
    const viewport = $("#netViewport");
    const tooltip = $("#netTooltip");
    if (svg && viewport) bindNetworkZoom(svg, viewport);

    const applyFocus = () => {
      const focus = state.network.focusGc;
      if (!focus) {
        $$(".net-node", wrap).forEach((el) => el.classList.remove("dim", "highlight"));
        $$(".net-edge", wrap).forEach((el) => el.classList.remove("dim"));
        return;
      }
      const connected = new Set([focus]);
      edges.forEach((e) => {
        if (e.a === focus) connected.add(e.b);
        if (e.b === focus) connected.add(e.a);
      });
      $$(".net-node", wrap).forEach((el) => {
        const gc = el.dataset.gc;
        el.classList.toggle("dim", !connected.has(gc));
        el.classList.toggle("highlight", gc === focus);
      });
      $$(".net-edge", wrap).forEach((el) => {
        const on = el.dataset.a === focus || el.dataset.b === focus;
        el.classList.toggle("dim", !on);
      });
    };
    applyFocus();

    $$(".net-node", wrap).forEach((el) => {
      const gc = el.dataset.gc;
      el.addEventListener("mouseenter", (e) => {
        if (state.network.focusGc) return;
        const connected = new Set([gc]);
        edges.forEach((edge) => {
          if (edge.a === gc) connected.add(edge.b);
          if (edge.b === gc) connected.add(edge.a);
        });
        $$(".net-node", wrap).forEach((x) => x.classList.toggle("dim", !connected.has(x.dataset.gc)));
        $$(".net-edge", wrap).forEach((x) => x.classList.toggle("dim", x.dataset.a !== gc && x.dataset.b !== gc));
        el.classList.add("highlight");
        if (tooltip) {
          tooltip.textContent = `${el.dataset.name} · ${el.dataset.members} 人 · ${el.dataset.degree} 条关系`;
          tooltip.style.opacity = "1";
          tooltip.style.left = `${e.clientX - wrap.getBoundingClientRect().left}px`;
          tooltip.style.top = `${e.clientY - wrap.getBoundingClientRect().top}px`;
        }
      });
      el.addEventListener("mousemove", (e) => {
        if (!tooltip) return;
        tooltip.style.left = `${e.clientX - wrap.getBoundingClientRect().left}px`;
        tooltip.style.top = `${e.clientY - wrap.getBoundingClientRect().top}px`;
      });
      el.addEventListener("mouseleave", () => {
        if (tooltip) tooltip.style.opacity = "0";
        if (!state.network.focusGc) {
          $$(".net-node", wrap).forEach((x) => x.classList.remove("dim", "highlight"));
          $$(".net-edge", wrap).forEach((x) => x.classList.remove("dim"));
        } else {
          applyFocus();
        }
      });
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        state.network.focusGc = state.network.focusGc === gc ? null : gc;
        drawNetwork();
      });
    });

    const bg = $(".net-bg", wrap);
    if (bg) bg.addEventListener("click", () => {
      if (state.network.focusGc) {
        state.network.focusGc = null;
        drawNetwork();
      }
    });
  }

  function drawChordDiagram(data, wrap) {
    const nodes = data.nodes || [];
    const edges = data.edges || [];
    if (nodes.length < 3 || edges.length === 0) {
      wrap.innerHTML = `<div class="card-body">${emptyState("◉", "和弦图需要更多群", "至少需要 3 个有共同成员的群；先同步更多群，或降低「最少共同成员」。", "", "mysteryC")}</div>`;
      return;
    }
    const flow = new Map(nodes.map((n) => [n.gc, 0]));
    for (const e of edges) {
      flow.set(e.a, (flow.get(e.a) || 0) + e.shared);
      flow.set(e.b, (flow.get(e.b) || 0) + e.shared);
    }
    const selected = nodes.slice().sort((a, b) => (flow.get(b.gc) || 0) - (flow.get(a.gc) || 0)).slice(0, state.network.chordTop);
    const ids = new Set(selected.map((n) => n.gc));
    const selEdges = edges.filter((e) => ids.has(e.a) && ids.has(e.b) && e.a !== e.b);
    const totalFlow = selected.reduce((sum, n) => sum + (flow.get(n.gc) || 0), 0);
    if (!totalFlow) {
      wrap.innerHTML = `<div class="card-body">${emptyState("◉", "没有可用的重合关系", "降低「最少共同成员」再试试。", "", "mysteryC")}</div>`;
      return;
    }
    const width = 800, height = 800, cx = width / 2, cy = height / 2, r = 250;
    const arcs = new Map();
    let angle = -Math.PI / 2;
    selected.forEach((n, i) => {
      const span = ((flow.get(n.gc) || 0) / totalFlow) * Math.PI * 2;
      arcs.set(n.gc, { start: angle, end: angle + span, span, cursor: angle, node: n, color: NET_COLORS[i % NET_COLORS.length], index: i });
      angle += span;
    });
    selEdges.sort((e1, e2) => {
      const a1 = arcs.get(e1.a).start, a2 = arcs.get(e2.a).start;
      if (a1 !== a2) return a1 - a2;
      return arcs.get(e1.b).start - arcs.get(e2.b).start;
    });
    const ribbons = [];
    for (const e of selEdges) {
      const A = arcs.get(e.a), B = arcs.get(e.b);
      if (!A || !B) continue;
      const aw = (e.shared / (flow.get(e.a) || 1)) * A.span;
      const bw = (e.shared / (flow.get(e.b) || 1)) * B.span;
      const a0 = A.cursor, a1 = a0 + aw;
      A.cursor = a1;
      const b0 = B.cursor, b1 = b0 + bw;
      B.cursor = b1;
      if (a1 <= a0 || b1 <= b0) continue;
      const pA0 = polar(cx, cy, r, a0), pA1 = polar(cx, cy, r, a1);
      const pB0 = polar(cx, cy, r, b0), pB1 = polar(cx, cy, r, b1);
      const largeA = a1 - a0 > Math.PI ? 1 : 0;
      const largeB = b1 - b0 > Math.PI ? 1 : 0;
      const path = `M ${pA0.x.toFixed(2)} ${pA0.y.toFixed(2)}
        Q ${cx} ${cy} ${pB0.x.toFixed(2)} ${pB0.y.toFixed(2)}
        A ${r} ${r} 0 ${largeB} 1 ${pB1.x.toFixed(2)} ${pB1.y.toFixed(2)}
        Q ${cx} ${cy} ${pA1.x.toFixed(2)} ${pA1.y.toFixed(2)}
        A ${r} ${r} 0 ${largeA} 0 ${pA0.x.toFixed(2)} ${pA0.y.toFixed(2)} Z`;
      ribbons.push({ a: e.a, b: e.b, shared: e.shared, color: A.color, path });
    }
    const ribbonSvg = ribbons.map((rb, i) =>
      `<path class="chord-ribbon" data-a="${esc(rb.a)}" data-b="${esc(rb.b)}" data-i="${i}" d="${rb.path}" fill="${rb.color}" fill-opacity="0.3" stroke="${rb.color}" stroke-opacity="0.16" stroke-width="0.6"><title>${esc(rb.a)} × ${esc(rb.b)}：${num(rb.shared)} 人</title></path>`
    ).join("");
    const arcSvg = selected.map((n, i) => {
      const arc = arcs.get(n.gc);
      const p0 = polar(cx, cy, r, arc.start);
      const p1 = polar(cx, cy, r, arc.end);
      const large = arc.end - arc.start > Math.PI ? 1 : 0;
      const mid = (arc.start + arc.end) / 2;
      const ap = polar(cx, cy, r, mid);
      const lp = polar(cx, cy, r + 36, mid);
      const anchor = Math.cos(mid) > 0.1 ? "start" : Math.cos(mid) < -0.1 ? "end" : "middle";
      const clip = `chord-clip-${i}`;
      return `<g class="chord-group" data-gc="${esc(n.gc)}">
        <path d="M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}" fill="none" stroke="${arc.color}" stroke-width="17" stroke-linecap="butt"/>
        <clipPath id="${clip}"><circle cx="${ap.x.toFixed(2)}" cy="${ap.y.toFixed(2)}" r="18"/></clipPath>
        <circle cx="${ap.x.toFixed(2)}" cy="${ap.y.toFixed(2)}" r="18" fill="${arc.color}"/>
        <image href="/api/avatar/group/${encodeURIComponent(n.gc)}" x="${(ap.x - 18).toFixed(2)}" y="${(ap.y - 18).toFixed(2)}" width="36" height="36" clip-path="url(#${clip})" preserveAspectRatio="xMidYMid slice"/>
        <text x="${lp.x.toFixed(2)}" y="${lp.y.toFixed(2)}" text-anchor="${anchor}" class="chord-label">${esc((n.name || n.gc).slice(0, 9))}</text>
      </g>`;
    }).join("");
    const legend = selected.map((n, i) =>
      `<span class="net-legend-item"><span class="net-legend-dot" style="background:${NET_COLORS[i % NET_COLORS.length]}"></span>${esc(n.name || n.gc)} <b style="color:var(--text)">${num(flow.get(n.gc) || 0)}</b></span>`
    ).join("");
    wrap.innerHTML = `<div class="net-tooltip" id="netTooltip"></div>
      <svg class="chord-svg" id="chordSvg" viewBox="0 0 ${width} ${height}" role="img" aria-label="群重合和弦图">
        ${ribbonSvg}${arcSvg}
      </svg>
      <div class="net-legend" style="padding:8px 16px 14px">${legend}</div>
      <div class="net-hint">丝带越粗 = 共同成员越多 · 悬停群弧可高亮相关丝带</div>`;

    const tooltip = $("#netTooltip");
    const canvas = wrap;
    $$(".chord-group", wrap).forEach((g) => {
      const gc = g.dataset.gc;
      g.addEventListener("mouseenter", () => {
        $$(".chord-ribbon", wrap).forEach((rb) => {
          rb.classList.toggle("dim", rb.dataset.a !== gc && rb.dataset.b !== gc);
        });
      });
      g.addEventListener("mouseleave", () => {
        $$(".chord-ribbon", wrap).forEach((rb) => rb.classList.remove("dim"));
      });
    });
    $$(".chord-ribbon", wrap).forEach((rb) => {
      rb.addEventListener("mousemove", (e) => {
        if (!tooltip) return;
        const names = new Map(selected.map((n) => [n.gc, n.name || n.gc]));
        tooltip.textContent = `${names.get(rb.dataset.a) || rb.dataset.a} × ${names.get(rb.dataset.b) || rb.dataset.b} · 共同成员 ${rb.querySelector("title")?.textContent?.split("：").pop() || ""}`;
        tooltip.style.opacity = "1";
        const rect = canvas.getBoundingClientRect();
        tooltip.style.left = `${e.clientX - rect.left}px`;
        tooltip.style.top = `${e.clientY - rect.top}px`;
      });
      rb.addEventListener("mouseleave", () => {
        if (tooltip) tooltip.style.opacity = "0";
      });
    });
  }

  function drawHeatmap(data, wrap) {
    const allNodes = data.nodes || [];
    const edges = data.edges || [];
    if (allNodes.length < 2) {
      wrap.innerHTML = `<div class="card-body">${emptyState("◉", "关系数据不足", "至少同步两个群才能生成热力图。", "", "mysteryC")}</div>`;
      return;
    }
    const nodes = allNodes.slice().sort((a, b) => (b.member_count || 0) - (a.member_count || 0)).slice(0, 20);
    const ids = new Set(nodes.map((n) => n.gc));
    const map = new Map();
    let max = 1;
    for (const e of edges) {
      if (!ids.has(e.a) || !ids.has(e.b)) continue;
      const key = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`;
      map.set(key, e.shared);
      max = Math.max(max, e.shared);
    }
    const header = nodes.map((g) =>
      `<th title="${esc(g.name || g.gc)}">${groupAvatar(g.gc, g.name || g.gc, "group-avatar xs")}<div>${esc((g.name || g.gc).slice(0, 6))}</div></th>`
    ).join("");
    const rows = nodes.map((row) => {
      const cells = nodes.map((col) => {
        if (row.gc === col.gc) return `<td class="diag">·</td>`;
        const key = row.gc < col.gc ? `${row.gc}|${col.gc}` : `${col.gc}|${row.gc}`;
        const value = map.get(key) || 0;
        const alpha = value ? 0.1 + (value / max) * 0.78 : 0;
        const color = value ? `rgba(255,107,94,${alpha.toFixed(2)})` : "var(--panel-2)";
        const textColor = alpha > 0.55 ? "#fff" : "var(--text)";
        return `<td style="background:${color};color:${textColor}" data-action="select-pair" data-a="${esc(row.gc)}" data-b="${esc(col.gc)}" title="${esc(row.name || row.gc)} × ${esc(col.name || col.gc)}：${value} 人">${value || ""}</td>`;
      }).join("");
      return `<tr><th class="row-head" title="${esc(row.name || row.gc)}">${groupAvatar(row.gc, row.name || row.gc, "group-avatar xs")} ${esc((row.name || row.gc).slice(0, 12))}</th>${cells}</tr>`;
    }).join("");
    wrap.innerHTML = `<div class="card-body">
      <div class="heatmap-scroll"><table class="heatmap-table"><thead><tr><th class="row-head">群</th>${header}</tr></thead><tbody>${rows}</tbody></table></div>
      <div class="heatmap-legend" style="margin-top:12px">
        少 <span class="swatch" style="background:rgba(255,107,94,0.1)"></span>
        <span class="swatch" style="background:rgba(255,107,94,0.45)"></span>
        <span class="swatch" style="background:rgba(255,107,94,0.85)"></span> 多
        <span class="muted" style="margin-left:8px">显示成员最多的 ${nodes.length} 个群 · 点击单元格可直接跳转交叉分析</span>
      </div>
    </div>`;
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
        <div class="name" style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
          ${groupAvatar(e.a, names.get(e.a) || e.a, "group-avatar xs")} ${esc(names.get(e.a) || e.a)}
          <span class="muted">×</span>
          ${groupAvatar(e.b, names.get(e.b) || e.b, "group-avatar xs")} ${esc(names.get(e.b) || e.b)}
        </div>
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
      <div class="guide-note" style="margin-bottom:16px">
        ${meme("mysteryC", "meme-sm")}
        <div><strong>第一次用？</strong>按顺序来：① 扫码登录 → ② 同步群列表 → ③ 同步全部成员。之后去「单群透视」或「交叉分析」就能看到结果。</div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><div><h2>QQ 账号</h2><p>扫码登录 qun.qq.com，只读取你自己加入的群</p></div>
            <span class="badge ${s.logged_in ? "badge-green" : "badge-muted"}">${s.logged_in ? "已登录" : "未登录"}</span>
          </div>
          <div class="card-body">
            <dl class="kv">
              <dt>账号</dt><dd style="display:flex;align-items:center;gap:8px">${s.uin ? memberAvatar(s.uin, "我", "member-avatar sm") : ""}${s.uin ? "QQ " + esc(s.uin) : "—"}</dd>
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
            <div style="display:flex;justify-content:flex-end;margin-top:10px">${meme("fanGroup", "meme-sm", "--rot:6deg")}</div>
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
            <div class="guide-note mt-10">${meme("takeNotes", "meme-sm")}<div>导入只会合并群和成员数据，不会覆盖登录状态。</div></div>
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
        <div class="card-head"><div><h2>表情包墙</h2><p>来自你的 images 文件夹，13 张已经全部穿插到各个页面</p></div><span class="badge badge-purple">13 张</span></div>
        <div class="card-body">
          <div class="meme-wall">${Object.keys(MEMES).map((k) => meme(k, "")).join("")}</div>
        </div>
      </div>

      <div class="card mt-16">
        <div class="card-head"><div><h2>隐私与安全</h2><p>这个工具如何对待你的数据</p></div></div>
        <div class="card-body">
          <div class="notice green"><span class="ico">✓</span><div>
            <strong>全部本地处理。</strong>群成员、活跃时间等数据只写入本机的 <code>data/roster.db</code>，不会上传到任何服务器。<br>
            <strong>只访问腾讯域名。</strong>登录与同步只请求 <code>ptlogin2.qq.com</code> 和 <code>qun.qq.com</code>；头像来自腾讯 qlogo CDN 并缓存到本机。<br>
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
              ${memberAvatar(p.uin, p.nick || p.aliases[0] || p.uin, "member-avatar lg")}
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
                  <thead><tr><th>群</th><th>群昵称</th><th>群名片</th><th>身份</th><th>入群时间</th><th>最后发言</th></tr></thead>
                  <tbody>${memberships.map((m) => `<tr class="clickable" data-action="open-group" data-gc="${esc(m.gc)}">
                    <td><div style="display:flex;align-items:center;gap:8px">${groupAvatar(m.gc, m.group_name || m.gc, "group-avatar sm")}<div><span class="cell-main">${esc(m.group_name || m.gc)}</span><div class="cell-sub mono">${esc(m.gc)}</div></div></div></td>
                    <td>${esc(m.nick || "—")}</td>
                    <td><span class="nick-chip"><b>${esc(m.card || "—")}</b></span></td>
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
                ${memberAvatar(c.uin, c.nick || c.uin, "member-avatar sm")}
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
      case "network-relayout":
        state.network.seed += 1;
        if (state.network.mode !== "force") {
          state.network.mode = "force";
          $$("#networkTabs button").forEach((b) => b.classList.toggle("active", b.dataset.mode === "force"));
          const chordLabel = $("#chordTopLabel");
          const chordSelect = $("#networkChordTop");
          if (chordLabel) chordLabel.hidden = true;
          if (chordSelect) chordSelect.hidden = true;
        }
        drawNetwork();
        break;
      case "network-unfocus":
        state.network.focusGc = null;
        drawNetwork();
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
