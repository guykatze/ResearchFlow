
(() => {
  "use strict";

  const STORAGE_KEY = "researchflow.pwa.data.v1";
  const CLOUD_FILE = "researchflow-data.json";
  const CONSUMER_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";
  const DEFAULT_SECTIONS = ["Data", "Laboratory", "Statistics", "Writing", "Administration", "General"];
  const STATUSES = ["Idea", "Active", "Waiting", "Writing", "Complete"];
  const PRIORITIES = ["Low", "Normal", "High", "Urgent"];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const nowISO = () => new Date().toISOString();
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const esc = (v = "") => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
  const dateOnly = iso => iso ? new Date(iso + (iso.length === 10 ? "T12:00:00" : "")).toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"}) : "";
  const shortDateTime = iso => iso ? new Date(iso).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}) : "";
  const normalizeTags = s => String(s||"").split(",").map(x=>x.trim()).filter(Boolean);
  const priorityRank = p => ({Urgent:0,High:1,Normal:2,Low:3}[p] ?? 2);
  const isOverdue = iso => iso && new Date(iso+"T23:59:59") < new Date();
  const daysFromNow = iso => {
    if (!iso) return Infinity;
    const a = new Date(); a.setHours(0,0,0,0);
    const b = new Date(iso+"T00:00:00");
    return Math.ceil((b-a)/86400000);
  };

  function defaultState() {
    return {
      version: 2,
      modifiedAt: nowISO(),
      projects: [],
      meetings: [],
      generalTasks: [],
      inbox: [],
      settings: {
        clientId: "",
        syncEnabled: false,
        lastSyncedAt: "",
        oneDriveAccount: "",
        autoSync: true,
        lastSyncError: ""
      }
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      return {...defaultState(), ...parsed, settings:{...defaultState().settings,...(parsed.settings||{})}};
    } catch {
      return defaultState();
    }
  }

  let state = loadState();
  normalizeExtendedState();
  let currentView = "dashboard";
  let currentProjectId = null;
  let msalApp = null;
  let autoSyncTimer = null;
  let cloudOperationQueue = Promise.resolve();

  function queueCloudOperation(operation) {
    const job = cloudOperationQueue.then(operation, operation);
    cloudOperationQueue = job.catch(() => {});
    return job;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function isResourceModifiedError(e) {
    return e?.status === 409 && /resourceModified/i.test(String(e?.graphCode || e?.message || ""));
  }

  function persist({touch=true, autosync=true} = {}) {
    if (touch) state.modifiedAt = nowISO();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    refreshNavigation();
    if (autosync && state.settings.syncEnabled && state.settings.autoSync) scheduleAutoSync();
  }

  function scheduleAutoSync() {
    clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(() => syncNow({quiet:true}).catch(()=>{}), 2500);
  }

  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(()=>el.classList.remove("show"), 2200);
  }

  function projectById(id) { return state.projects.find(p => p.id === id); }
  function liveProject(projectOrId) {
    const id = typeof projectOrId === "string" ? projectOrId : projectOrId?.id;
    return id ? projectById(id) : null;
  }
  function meetingById(id) { return state.meetings.find(m => m.id === id); }
  function generalTaskById(id) { return state.generalTasks.find(t => t.id === id); }

  function normalizeExtendedState() {
    state.meetings = Array.isArray(state.meetings) ? state.meetings : [];
    for (const m of state.meetings) {
      // v0.4.2 migration: single projectId -> projectIds[], summary -> notes.
      if (!Array.isArray(m.projectIds)) m.projectIds = m.projectId ? [m.projectId] : [];
      m.projectIds = [...new Set(m.projectIds.filter(Boolean))];
      if (!("notes" in m)) m.notes = m.summary || "";
    }
    state.generalTasks = Array.isArray(state.generalTasks) ? state.generalTasks : [];
    state.projects = Array.isArray(state.projects) ? state.projects : [];
    for (const p of state.projects) {
      p.tasks = Array.isArray(p.tasks) ? p.tasks : [];
      p.sections = Array.isArray(p.sections) && p.sections.length ? p.sections : [...DEFAULT_SECTIONS];
      p.milestones = Array.isArray(p.milestones) ? p.milestones : [];
      p.notes = p.notes || "";
    }
  }

  function refreshNavigation() {
    $("#inboxBadge").textContent = state.inbox.length;
    const mb = $("#meetingBadge"); if (mb) mb.textContent = state.meetings.length;
    const gb = $("#generalBadge"); if (gb) gb.textContent = state.generalTasks.filter(t=>!t.done).length;
    const nav = $("#projectNav");
    nav.innerHTML = state.projects
      .slice()
      .sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt))
      .map(p => {
        const open = (p.tasks||[]).filter(t=>!t.done).length;
        return `<button class="project-link ${currentProjectId===p.id?'active':''}" data-project-id="${esc(p.id)}">
          <span>▱</span><span class="name">${esc(p.name)}</span>${open?`<span class="count">${open}</span>`:""}
        </button>`;
      }).join("");
    $$(".project-link").forEach(btn => btn.addEventListener("click", () => {
      currentProjectId = btn.dataset.projectId;
      currentView = "project";
      setActiveNav();
      render();
      closeSidebar();
    }));

    const sm = $("#syncMini");
    if (state.settings.syncEnabled) {
      sm.textContent = state.settings.lastSyncedAt ? `OneDrive · ${shortDateTime(state.settings.lastSyncedAt)}` : "OneDrive connected";
    } else {
      sm.textContent = "Local only";
    }
  }

  function setActiveNav() {
    $$(".nav-item").forEach(b => b.classList.toggle("active", currentView !== "project" && b.dataset.view === currentView));
    $$(".project-link").forEach(b => b.classList.toggle("active", currentView === "project" && b.dataset.projectId === currentProjectId));
  }

  // ---------- Automatic text direction ----------
  function detectedTextDirection(value) {
    const text = String(value ?? "");
    for (const ch of text) {
      // Hebrew, including presentation forms.
      if (/[\u0590-\u05FF\uFB1D-\uFB4F]/.test(ch)) return "rtl";
      // Common left-to-right alphabets. Numbers/punctuation are ignored until a strong letter appears.
      if (/[A-Za-z\u00C0-\u02AF\u0370-\u058F\u1E00-\u1EFF]/.test(ch)) return "ltr";
    }
    return "auto";
  }

  function applyDirectionToElement(el) {
    if (!el) return;
    const value = ("value" in el && /^(INPUT|TEXTAREA)$/.test(el.tagName)) ? el.value : el.textContent;
    const dir = detectedTextDirection(value);
    el.setAttribute("dir", dir);
    if (dir === "rtl") el.style.textAlign = "right";
    else if (dir === "ltr") el.style.textAlign = "left";
    else el.style.textAlign = "start";
  }

  function applyAutomaticTextDirection(root=document) {
    const fieldSelector = 'textarea, input[type="text"], input[type="search"], input:not([type])';
    const savedTextSelector = [
      '.row-title',
      '.meeting-summary',
      '.big-next',
      '.page-title',
      '.page-subtitle',
      '.project-link .name',
      '.gantt-label .row-button',
      '.meeting-card .meeting-mini',
      '.list-row .row-meta',
      '.project-card .row-meta'
    ].join(',');

    const nodes = [];
    if (root.matches?.(fieldSelector) || root.matches?.(savedTextSelector)) nodes.push(root);
    root.querySelectorAll?.(`${fieldSelector},${savedTextSelector}`).forEach(el => nodes.push(el));
    nodes.forEach(applyDirectionToElement);
  }

  function installAutomaticTextDirection() {
    document.addEventListener('input', e => {
      const el = e.target;
      if (el?.matches?.('textarea, input[type="text"], input[type="search"], input:not([type])')) {
        applyDirectionToElement(el);
      }
    });
    document.addEventListener('focusin', e => {
      const el = e.target;
      if (el?.matches?.('textarea, input[type="text"], input[type="search"], input:not([type])')) {
        applyDirectionToElement(el);
      }
    });
  }

  function render() {
    refreshNavigation();
    setActiveNav();
    const content = $("#content");
    if (currentView === "dashboard") renderDashboard(content);
    else if (currentView === "meetings") renderMeetings(content);
    else if (currentView === "general") renderGeneralTasks(content);
    else if (currentView === "inbox") renderInbox(content);
    else if (currentView === "search") renderSearch(content);
    else if (currentView === "settings") renderSettings(content);
    else if (currentView === "project") renderProject(content, currentProjectId);
    applyAutomaticTextDirection(content);
    applyAutomaticTextDirection($("#sidebar"));
    window.scrollTo({top:0,behavior:"instant"});
  }

  // ---------- Dashboard ----------
  function renderDashboard(root) {
    const active = state.projects.filter(p=>p.status!=="Complete");
    const projectOpenTasks = state.projects.flatMap(p => (p.tasks||[]).filter(t=>!t.done).map(t=>({p,t,kind:"project"})));
    const generalOpen = state.generalTasks.filter(t=>!t.done).map(t=>({p:null,t,kind:"general"}));
    const openTasks = [...projectOpenTasks, ...generalOpen];
    const due14 = openTasks.filter(x=>{ const d=daysFromNow(x.t.dueDate); return d>=0 && d<=14; });
    const overdue = openTasks.filter(x=>isOverdue(x.t.dueDate));
    const waiting = openTasks.filter(x=>String(x.t.waitingFor||"").trim());

    const nextActions = active.map(p=>({p,t:nextProjectTask(p)}))
      .filter(x=>x.t)
      .sort((a,b)=>{
        const taskOrder=taskSort(a.t,b.t);
        if(taskOrder!==0)return taskOrder;
        return priorityRank(a.p.priority)-priorityRank(b.p.priority);
      });

    const upcoming = openTasks.filter(x=>x.t.dueDate && daysFromNow(x.t.dueDate)>=0 && daysFromNow(x.t.dueDate)<=14)
      .sort((a,b)=>String(a.t.dueDate).localeCompare(String(b.t.dueDate)));

    const upcomingMeetings = state.meetings
      .filter(m=>m.date && new Date(m.date+"T23:59:59") >= new Date())
      .sort((a,b)=>a.date.localeCompare(b.date))
      .slice(0,5);

    const upcomingMilestones = state.projects.flatMap(p=>(p.milestones||[])
      .filter(m=>!m.done && m.endDate)
      .map(m=>({p,m})))
      .sort((a,b)=>a.m.endDate.localeCompare(b.m.endDate))
      .slice(0,7);

    root.innerHTML = `
      <div class="page-header">
        <div><h1 class="page-title">Dashboard</h1><p class="page-subtitle">What needs your attention</p></div>
      </div>

      <div class="metrics">
        ${metric("▱",active.length,"Active projects")}
        ${metric("☷",openTasks.length,"Open tasks")}
        ${metric("◫",upcomingMeetings.length,"Upcoming meetings")}
        ${metric("△",overdue.length,"Overdue")}
        ${metric("⌛",waiting.length,"Waiting for")}
      </div>

      <div class="panel">
        <div class="panel-title-row"><h2 class="panel-title">⚡ Quick capture</h2></div>
        <div class="quick-capture">
          <textarea id="dashQuick" class="field" placeholder="Idea, task, paper to check…"></textarea>
          <button class="button secondary" id="dashDictate">🎙 Dictate</button>
          <button class="button primary" id="dashSaveQuick">Send to Inbox</button>
        </div>
      </div>

      ${waiting.length ? `<div class="panel">
        <div class="panel-title-row"><h2 class="panel-title">⌛ Waiting for</h2></div>
        ${waiting.slice(0,8).map(x=>`
          <div class="list-row">
            <div class="row-main"><div class="row-title">${esc(x.t.title)}</div>
              <div class="row-meta"><span>${x.p?esc(x.p.name):"General"}</span><span>Waiting for: ${esc(x.t.waitingFor)}</span></div>
            </div>
          </div>`).join("")}
      </div>`:""}

      <div class="panel">
        <div class="panel-title-row"><h2 class="panel-title">→ Next tasks</h2></div>
        ${nextActions.length ? nextActions.slice(0,8).map(({p,t})=>`
          <div class="project-card" data-open-project="${esc(p.id)}">
            <div class="row-title">${esc(t.title)}</div>
            <div class="row-meta"><span>${esc(p.name)}</span><span>${esc(t.priority||"Normal")} priority</span>${t.dueDate?`<span>${dateOnly(t.dueDate)}</span>`:""}</div>
          </div>`).join("") : `<div class="empty">No open project tasks.</div>`}
      </div>

      <div class="dashboard-two">
        <div class="panel">
          <div class="panel-title-row"><h2 class="panel-title">◆ Upcoming milestones</h2></div>
          ${upcomingMilestones.length?upcomingMilestones.map(x=>`
            <div class="project-card" data-open-project="${esc(x.p.id)}">
              <div class="row-title">${esc(x.m.title)}</div>
              <div class="row-meta"><span>${esc(x.p.name)}</span><span>${dateOnly(x.m.endDate)}</span></div>
            </div>`).join(""):`<div class="empty">No upcoming milestones.</div>`}
        </div>
        <div class="panel">
          <div class="panel-title-row"><h2 class="panel-title">◫ Upcoming meetings</h2></div>
          ${upcomingMeetings.length?upcomingMeetings.map(m=>`
            <div class="project-card" data-open-meeting="${esc(m.id)}">
              <div class="row-title">${esc(m.title)}</div>
              <div class="row-meta"><span>${dateOnly(m.date)}</span><span>${esc((m.projectIds||[]).map(id=>projectById(id)?.name).filter(Boolean).join(", ")||"General")}</span></div>
            </div>`).join(""):`<div class="empty">No upcoming meetings.</div>`}
        </div>
      </div>

      <div class="panel">
        <div class="panel-title-row"><h2 class="panel-title">◷ Upcoming tasks</h2></div>
        ${upcoming.length ? upcoming.slice(0,10).map(x=>x.kind==="project"?taskSummaryRow(x.p,x.t):generalSummaryRow(x.t)).join("") : `<div class="empty">No tasks due in the next 14 days.</div>`}
      </div>

      ${overdue.length ? `<div class="panel">
        <div class="panel-title-row"><h2 class="panel-title">△ Overdue</h2></div>
        ${overdue.slice(0,10).map(x=>x.kind==="project"?taskSummaryRow(x.p,x.t,true):generalSummaryRow(x.t,true)).join("")}
      </div>` : ""}
    `;

    $("#dashSaveQuick").addEventListener("click", ()=>{
      const text = $("#dashQuick").value.trim();
      if (!text) return;
      state.inbox.unshift({id:uid(),text,tags:[],createdAt:nowISO(),updatedAt:nowISO()});
      persist(); renderDashboard(root); toast("Saved to Inbox");
    });
    $("#dashDictate").addEventListener("click", ()=>startDictation($("#dashQuick")));
    $$("[data-open-project]",root).forEach(el=>el.addEventListener("click",()=>{
      currentProjectId=el.dataset.openProject;currentView="project";currentProjectTab="overview";render();
    }));
    $$("[data-open-meeting]",root).forEach(el=>el.addEventListener("click",()=>{
      currentView="meetings";render();setTimeout(()=>openMeetingModal(meetingById(el.dataset.openMeeting)),0);
    }));
  }

  function generalSummaryRow(t,forceOverdue=false) {
    const dueClass = forceOverdue || isOverdue(t.dueDate) ? "overdue" : (daysFromNow(t.dueDate)<=3 ? "due-soon" : "");
    return `<div class="list-row"><div class="row-main"><div class="row-title">${esc(t.title)}</div>
      <div class="row-meta"><span>General</span>${t.dueDate?`<span class="${dueClass}">${dateOnly(t.dueDate)}</span>`:""}${t.waitingFor?`<span>Waiting for ${esc(t.waitingFor)}</span>`:""}</div>
    </div></div>`;
  }

  function metric(icon,value,label) {
    return `<div class="metric"><div class="metric-icon">${icon}</div><div><div class="metric-value">${value}</div><div class="metric-label">${esc(label)}</div></div></div>`;
  }
  function taskSummaryRow(p,t,forceOverdue=false) {
    const dueClass = forceOverdue || isOverdue(t.dueDate) ? "overdue" : (daysFromNow(t.dueDate)<=3 ? "due-soon" : "");
    return `<div class="list-row">
      <div class="row-main">
        <div class="row-title">${esc(t.title)}</div>
        <div class="row-meta"><span>${esc(p.name)}</span><span>${esc(t.section)}</span>${t.dueDate?`<span class="${dueClass}">${dateOnly(t.dueDate)}</span>`:""}</div>
      </div>
    </div>`;
  }

  // ---------- Project ----------
  let currentProjectTab = "overview";

  function renderProject(root,id) {
    const p = projectById(id);
    if (!p) { currentView="dashboard";render();return; }
    p.sections = Array.isArray(p.sections) && p.sections.length ? p.sections : [...DEFAULT_SECTIONS];
    p.tasks = Array.isArray(p.tasks) ? p.tasks : [];
    p.milestones = Array.isArray(p.milestones) ? p.milestones : [];

    const tabs = [
      ["overview","Overview"],["gantt","Gantt"],["tasks","To-do"],
      ["meetings","Meetings"],["notes","Notes"]
    ];

    root.innerHTML = `
      <div class="page-header">
        <div><h1 class="page-title">${esc(p.name)}</h1><p class="page-subtitle">${esc(p.summary||"No summary yet")}</p></div>
        <div class="project-header-tools">
          <button class="button secondary" id="editProjectBtn">Edit project</button>
          <button class="button primary" id="addTaskBtn">＋ Add task</button>
        </div>
      </div>
      <div class="project-tabs">${tabs.map(([k,label])=>`<button class="project-tab ${currentProjectTab===k?"active":""}" data-project-tab="${k}">${label}</button>`).join("")}</div>
      <div id="projectTabBody"></div>
    `;

    $("#editProjectBtn").addEventListener("click",()=>openProjectModal(projectById(p.id)));
    $("#addTaskBtn").addEventListener("click",()=>openTaskModal(p.id));
    $$("[data-project-tab]",root).forEach(btn=>btn.addEventListener("click",()=>{
      currentProjectTab=btn.dataset.projectTab;renderProject(root,p.id);
    }));

    const body=$("#projectTabBody");
    if(currentProjectTab==="overview") renderProjectOverview(body,p);
    if(currentProjectTab==="gantt") renderProjectGantt(body,p);
    if(currentProjectTab==="tasks") renderProjectTasks(body,p);
    if(currentProjectTab==="meetings") renderProjectMeetings(body,p);
    if(currentProjectTab==="notes") renderProjectNotes(body,p);
  }

  function renderProjectOverview(root,p){
    const open=(p.tasks||[]).filter(t=>!t.done);
    const completed=(p.tasks||[]).filter(t=>t.done).length;
    const progress=(open.length+completed)?Math.round(completed/(open.length+completed)*100):0;
    const nextTask=nextProjectTask(p);
    const nextMilestone=(p.milestones||[]).filter(m=>!m.done&&m.endDate).sort((a,b)=>a.endDate.localeCompare(b.endDate))[0];
    root.innerHTML=`
      <div class="panel">
        <div class="form-grid">
          <div><label class="field-label">Status</label><span class="status-pill">${esc(p.status||"Idea")}</span></div>
          <div><label class="field-label">Priority</label><div>${esc(p.priority||"Normal")}</div></div>
          <div><label class="field-label">Next task</label><div>${nextTask?esc(nextTask.title):"No open tasks"}</div></div>
          <div><label class="field-label">Deadline</label><div>${p.deadline?dateOnly(p.deadline):"Not set"}</div></div>
        </div>
        <hr class="sep">
        <label class="field-label">Task progress</label>
        <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
        <div class="row-meta"><span>${progress}% complete</span><span>${open.length} open tasks</span></div>
      </div>
      <div class="dashboard-two">
        <div class="panel">
          <div class="panel-title-row"><h2 class="panel-title">→ Next task</h2></div>
          ${nextTask?`<div class="big-next">${esc(nextTask.title)}</div><div class="row-meta"><span>${esc(nextTask.priority||"Normal")} priority</span>${nextTask.dueDate?`<span>${dateOnly(nextTask.dueDate)}</span>`:""}${nextTask.waitingFor?`<span>Waiting for ${esc(nextTask.waitingFor)}</span>`:""}</div>`:`<div class="empty">No open tasks.</div>`}
        </div>
        <div class="panel">
          <div class="panel-title-row"><h2 class="panel-title">◆ Next milestone</h2></div>
          ${nextMilestone?`<div class="big-next">${esc(nextMilestone.title)}</div><div class="row-meta">${dateOnly(nextMilestone.endDate)}</div>`:`<div class="empty">No upcoming milestone.</div>`}
        </div>
      </div>
      <div class="panel">
        <div class="panel-title-row"><h2 class="panel-title">⌛ Waiting for</h2></div>
        ${open.filter(t=>t.waitingFor).length?open.filter(t=>t.waitingFor).map(t=>`<div class="list-row"><div class="row-main"><div class="row-title">${esc(t.title)}</div><div class="row-meta">Waiting for ${esc(t.waitingFor)}</div></div></div>`).join(""):`<div class="empty">Nothing waiting.</div>`}
      </div>`;
  }

  function renderProjectGantt(root,p){
    const ms=(p.milestones||[]).slice().sort((a,b)=>String(a.startDate||a.endDate).localeCompare(String(b.startDate||b.endDate)));
    const dated=ms.filter(m=>m.startDate||m.endDate);
    let min=new Date(), max=new Date();
    if(dated.length){
      const dates=dated.flatMap(m=>[m.startDate,m.endDate].filter(Boolean).map(x=>new Date(x+"T12:00:00")));
      min=new Date(Math.min(...dates));max=new Date(Math.max(...dates));
    }
    if(max<=min)max=new Date(min.getTime()+30*86400000);
    const span=Math.max(1,(max-min)/86400000);

    root.innerHTML=`
      <div class="panel">
        <div class="panel-title-row"><h2 class="panel-title">Gantt / Milestones</h2><span class="spacer"></span><button class="button primary small" id="addMilestoneBtn">＋ Milestone</button></div>
        <div class="gantt-axis"><span>${dateOnly(min.toISOString().slice(0,10))}</span><span>${dateOnly(max.toISOString().slice(0,10))}</span></div>
        ${ms.length?`<div class="gantt-list">${ms.map(m=>{
          const st=new Date((m.startDate||m.endDate||min.toISOString().slice(0,10))+"T12:00:00");
          const en=new Date((m.endDate||m.startDate||max.toISOString().slice(0,10))+"T12:00:00");
          const left=Math.max(0,Math.min(96,((st-min)/86400000/span)*100));
          const width=Math.max(3,Math.min(100-left,(((en-st)/86400000+1)/span)*100));
          return `<div class="gantt-row">
            <div class="gantt-label"><button class="row-button" data-edit-milestone="${esc(m.id)}">${esc(m.title)}</button><div class="row-meta">${m.endDate?dateOnly(m.endDate):""}${m.waitingFor?` · Waiting for ${esc(m.waitingFor)}`:""}</div></div>
            <div class="gantt-track"><div class="gantt-bar ${m.done?"donebar":""}" style="left:${left}%;width:${width}%">${m.done?"✓":""}</div></div>
          </div>`}).join("")}</div>`:`<div class="empty">Add milestones to build the project timeline.</div>`}
      </div>`;
    $("#addMilestoneBtn").onclick=()=>openMilestoneModal(p.id);
    $$("[data-edit-milestone]",root).forEach(b=>b.onclick=()=>{
      const lp=projectById(p.id);
      openMilestoneModal(p.id,lp?.milestones?.find(m=>m.id===b.dataset.editMilestone)?.id);
    });
  }

  function renderProjectTasks(root,p){
    const open=p.tasks.filter(t=>!t.done), complete=p.tasks.filter(t=>t.done);
    const sections=[...new Set([...p.sections,...open.map(t=>t.section)])];
    root.innerHTML=`
      <div class="panel">
        <div class="panel-title-row"><h2 class="panel-title">To-do</h2><span class="spacer"></span>
          <button class="button ghost small" id="manageSectionsBtn">Manage sections</button>
          <button class="button primary small" id="tabAddTaskBtn">＋ Add task</button>
        </div>
        ${open.length?sections.map(sec=>{
          const tasks=open.filter(t=>t.section===sec).sort(taskSort); if(!tasks.length)return "";
          return `<div class="task-group"><div class="task-group-title">${esc(sec)}</div>${tasks.map(t=>taskRowHTML(p,t)).join("")}</div>`;
        }).join(""):`<div class="empty">No open tasks.</div>`}
        ${complete.length?`<details class="task-group"><summary class="task-group-title">Completed (${complete.length})</summary>${complete.map(t=>taskRowHTML(p,t)).join("")}</details>`:""}
      </div>`;
    $("#manageSectionsBtn").onclick=()=>openSectionsModal(p.id);
    $("#tabAddTaskBtn").onclick=()=>openTaskModal(p.id);
    bindProjectTaskRows(root,p.id);
  }

  function bindProjectTaskRows(root,projectId){
    $$(".task-check",root).forEach(ch=>ch.addEventListener("change",()=>{
      const p=projectById(projectId);if(!p)return;
      const t=p.tasks.find(x=>x.id===ch.dataset.taskId);if(!t)return;
      t.done=ch.checked;t.updatedAt=nowISO();p.updatedAt=nowISO();persist();renderProject(root.closest(".content")||$("#content"),projectId);
    }));
    $$('[data-edit-task]',root).forEach(b=>b.onclick=()=>openTaskModal(projectId,b.dataset.editTask));
    $$('[data-delete-task]',root).forEach(b=>b.onclick=()=>{
      const p=projectById(projectId);if(!p)return;
      const t=p.tasks.find(x=>x.id===b.dataset.deleteTask);
      if(t&&confirm(`Delete "${t.title}"?`)){p.tasks=p.tasks.filter(x=>x.id!==t.id);p.updatedAt=nowISO();persist();renderProject($("#content"),projectId);}
    });
  }

  function renderProjectMeetings(root,p){
    const meetings=state.meetings.filter(m=>(m.projectIds||[]).includes(p.id)).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
    root.innerHTML=`<div class="panel"><div class="panel-title-row"><h2 class="panel-title">Meetings</h2><span class="spacer"></span><button class="button primary small" id="newProjectMeetingBtn">＋ Meeting</button></div>
      ${meetings.length?meetings.map(meetingCardHTML).join(""):`<div class="empty">No meetings linked to this project.</div>`}</div>`;
    $("#newProjectMeetingBtn").onclick=()=>openMeetingModal(null,p.id);
    $$("[data-edit-meeting]",root).forEach(b=>b.onclick=()=>openMeetingModal(meetingById(b.dataset.editMeeting)));
  }

  function renderProjectNotes(root,p){
    root.innerHTML=`<div class="panel"><div class="panel-title-row"><h2 class="panel-title">Project notes</h2><span class="spacer"></span><button class="button secondary small" id="dictateNotesBtn">🎙 Dictate</button><button class="button primary small" id="saveNotesBtn">Save</button></div>
      <textarea id="projectNotes" class="field project-notes" placeholder="Methods, ideas, observations…">${esc(p.notes||"")}</textarea></div>`;
    $("#saveNotesBtn").onclick=()=>{const lp=projectById(p.id);if(!lp)return;lp.notes=$("#projectNotes").value;lp.updatedAt=nowISO();persist();toast("Notes saved");};
    $("#dictateNotesBtn").onclick=()=>startDictation($("#projectNotes"),{append:true});
  }

  function taskSort(a,b) {
    const pr=priorityRank(a.priority)-priorityRank(b.priority);
    if(pr!==0)return pr;
    if(a.dueDate&&b.dueDate)return a.dueDate.localeCompare(b.dueDate);
    if(a.dueDate)return -1;if(b.dueDate)return 1;
    return new Date(a.createdAt)-new Date(b.createdAt);
  }


  function nextProjectTask(p) {
    const open=(p.tasks||[]).filter(t=>!t.done);
    if(!open.length)return null;

    // A task that is waiting on someone/something is not actionable while
    // another open task can be worked on now.
    const actionable=open.filter(t=>!String(t.waitingFor||"").trim());
    const pool=actionable.length?actionable:open;
    return pool.slice().sort(taskSort)[0]||null;
  }

  function nextProjectTaskLabel(p) {
    const t=nextProjectTask(p);
    if(!t)return "No open tasks";
    return t.title;
  }

  function taskRowHTML(p,t) {
    const dc = isOverdue(t.dueDate)&&!t.done?"overdue":(daysFromNow(t.dueDate)<=3&&!t.done?"due-soon":"");
    return `<div class="list-row ${t.done?"done":""}">
      <input type="checkbox" class="task-check" data-task-id="${esc(t.id)}" ${t.done?"checked":""}>
      <div class="row-main">
        <div class="row-title">${esc(t.title)}</div>
        <div class="row-meta">
          <span class="priority-${String(t.priority||"Normal").toLowerCase()}">${esc(t.priority||"Normal")}</span>
          ${t.dueDate?`<span class="${dc}">${dateOnly(t.dueDate)}</span>`:""}
          ${(t.tags||[]).map(x=>`<span>#${esc(x)}</span>`).join("")}
        </div>
        ${t.notes?`<div class="row-meta">${esc(t.notes)}</div>`:""}
      </div>
      <div class="row-actions">
        <button class="row-button" data-edit-task="${esc(t.id)}">Edit</button>
        <button class="row-button" data-delete-task="${esc(t.id)}">Delete</button>
      </div>
    </div>`;
  }

  // ---------- Inbox ----------
  function renderInbox(root) {
    root.innerHTML = `
      <div class="page-header"><div><h1 class="page-title">Inbox</h1><p class="page-subtitle">Capture first. Organize later.</p></div></div>
      <div class="panel">
        <textarea id="inboxText" class="field inbox-compose" placeholder="Dictate or type an idea…"></textarea>
        <div class="form-row" style="margin-top:10px"><input id="inboxTags" class="field" placeholder="Tags, comma separated (optional)"></div>
        <div class="section-toolbar">
          <button class="button secondary" id="inboxDictateBtn">🎙 Dictate</button>
          <button class="button primary" id="inboxSaveBtn">Save to Inbox</button>
        </div>
        <div class="dictation-hint">If the browser microphone button is unavailable, tap the text box and use Apple's keyboard microphone.</div>
      </div>
      <div class="panel">
        <div class="panel-title-row"><h2 class="panel-title">Captured items</h2></div>
        ${state.inbox.length?state.inbox.map(n=>`
          <div class="list-row">
            <div class="row-main"><div class="row-title">${esc(n.text)}</div>
              <div class="row-meta"><span>${shortDateTime(n.createdAt)}</span>${(n.tags||[]).map(t=>`<span>#${esc(t)}</span>`).join("")}</div>
            </div>
            <div class="row-actions">
              <button class="row-button" data-inbox-to-project="${esc(n.id)}">To project</button>
              <button class="row-button" data-delete-inbox="${esc(n.id)}">Delete</button>
            </div>
          </div>`).join(""):`<div class="empty">Inbox is empty.</div>`}
      </div>
    `;
    $("#inboxSaveBtn").addEventListener("click",()=>{
      const text=$("#inboxText").value.trim();if(!text)return;
      state.inbox.unshift({id:uid(),text,tags:normalizeTags($("#inboxTags").value),createdAt:nowISO(),updatedAt:nowISO()});
      persist();renderInbox(root);toast("Saved");
    });
    $("#inboxDictateBtn").addEventListener("click",()=>startDictation($("#inboxText"),{append:true}));
    $$("[data-delete-inbox]",root).forEach(btn=>btn.addEventListener("click",()=>{
      state.inbox=state.inbox.filter(n=>n.id!==btn.dataset.deleteInbox);persist();renderInbox(root);
    }));
    $$("[data-inbox-to-project]",root).forEach(btn=>btn.addEventListener("click",()=>{
      const note=state.inbox.find(n=>n.id===btn.dataset.inboxToProject); if(note) openMoveInboxModal(note);
    }));
  }


  // ---------- Meetings ----------
  function meetingCardHTML(m){
    const projectNames=(m.projectIds||[]).map(id=>projectById(id)?.name).filter(Boolean);
    const notes=m.notes ?? m.summary ?? "";
    return `<div class="meeting-card">
      <div class="meeting-top"><div><div class="row-title">${esc(m.title)}</div><div class="row-meta"><span>${dateOnly(m.date)}</span><span>${esc(projectNames.join(", ")||"General")}</span>${m.participants?`<span>${esc(m.participants)}</span>`:""}</div></div>
      <button class="row-button" data-edit-meeting="${esc(m.id)}">Open</button></div>
      ${notes?`<div class="meeting-summary">${esc(notes)}</div>`:""}
      ${(m.decisions||[]).length?`<div class="meeting-mini"><strong>Decisions:</strong> ${(m.decisions||[]).map(esc).join(" · ")}</div>`:""}
    </div>`;
  }

  function renderMeetings(root){
    const meetings=state.meetings.slice().sort((a,b)=>String(b.date).localeCompare(String(a.date)));
    root.innerHTML=`
      <div class="page-header"><div><h1 class="page-title">Meetings</h1><p class="page-subtitle">Summaries, decisions and action items</p></div>
        <button class="button primary" id="newMeetingBtn">＋ New meeting</button></div>
      <div class="panel">
        ${meetings.length?meetings.map(meetingCardHTML).join(""):`<div class="empty">No meeting summaries yet.</div>`}
      </div>`;
    $("#newMeetingBtn").onclick=()=>openMeetingModal();
    $$("[data-edit-meeting]",root).forEach(b=>b.onclick=()=>openMeetingModal(meetingById(b.dataset.editMeeting)));
  }

  function openMeetingModal(existing=null,presetProjectId=""){
    const migratedProjectIds = existing
      ? (Array.isArray(existing.projectIds) ? existing.projectIds : (existing.projectId ? [existing.projectId] : []))
      : (presetProjectId ? [presetProjectId] : []);
    const m=existing||{title:"",date:new Date().toISOString().slice(0,10),projectIds:migratedProjectIds,participants:"",notes:"",decisions:[],questions:[],actions:[]};
    const selectedProjectIds = [...new Set((m.projectIds||migratedProjectIds||[]).filter(Boolean))];
    const meetingNotes = m.notes ?? m.summary ?? "";
    const decisions=(m.decisions||[]).join("\n");
    const questions=(m.questions||[]).join("\n");

    const projectsPicker = state.projects.length ? `
      <div class="multi-project-picker" id="mmProjects">
        ${state.projects.map(p=>`
          <label class="multi-project-option">
            <input type="checkbox" value="${esc(p.id)}" ${selectedProjectIds.includes(p.id)?"checked":""}>
            <span>${esc(p.name)}</span>
          </label>`).join("")}
      </div>` : `<div class="empty small-empty">No projects yet. This meeting will remain general.</div>`;

    openModal(existing?"Meeting notes":"New meeting",`
      <div class="form-grid">
        <div class="form-row"><label class="field-label">Title</label><input class="field" id="mmTitle" value="${esc(m.title)}"></div>
        <div class="form-row"><label class="field-label">Date</label><input type="date" class="field" id="mmDate" value="${esc(m.date)}"></div>
      </div>

      <div class="form-row">
        <label class="field-label">Projects</label>
        <div class="field-help">Select any projects discussed in this meeting. You can select more than one.</div>
        ${projectsPicker}
      </div>

      <div class="form-row"><label class="field-label">Participants</label><input class="field" id="mmParticipants" value="${esc(m.participants||"")}"></div>

      <div class="form-row">
        <div class="field-label-row"><label class="field-label">Meeting notes</label><button type="button" class="button secondary small" id="dictateMeetingBtn">🎙 Dictate</button></div>
        <textarea class="field meeting-notes" id="mmNotes" placeholder="Write or dictate notes during or after the meeting…">${esc(meetingNotes)}</textarea>
      </div>

      <div class="form-row"><label class="field-label">Decisions — one per line</label><textarea class="field" id="mmDecisions">${esc(decisions)}</textarea></div>
      <div class="form-row"><label class="field-label">Unresolved questions — one per line</label><textarea class="field" id="mmQuestions">${esc(questions)}</textarea></div>

      <div class="form-row">
        <label class="field-label">New action items — one per line</label>
        <div class="field-help">If one project is selected, action items become tasks in that project. If several or no projects are selected, they become General Tasks so the same action is not duplicated across projects.</div>
        <textarea class="field" id="mmActions" placeholder="Each line becomes a task"></textarea>
      </div>

      ${existing?`<div class="info-box">${(m.actions||[]).length} action item(s) already linked to tasks.</div><hr class="sep"><button type="button" class="button danger small" id="deleteMeetingBtn">Delete meeting</button>`:""}
    `,`<button type="button" class="button secondary" id="cancelModalBtn">Cancel</button><button type="button" class="button primary" id="saveMeetingBtn">Save meeting</button>`,()=>{
      $("#cancelModalBtn").onclick=closeModal;
      $("#dictateMeetingBtn").onclick=()=>startDictation($("#mmNotes"),{append:true});

      $("#saveMeetingBtn").onclick=()=>{
        const title=$("#mmTitle").value.trim();
        if(!title){toast("Meeting title is required");return;}
        const projectIds = $$("#mmProjects input[type='checkbox']:checked").map(x=>x.value);
        const actionLines=$("#mmActions").value.split("\n").map(x=>x.trim()).filter(Boolean);
        const linkedActions=existing?(m.actions||[]):[];

        for(const text of actionLines){
          if(projectIds.length===1){
            const projectId=projectIds[0];
            const p=projectById(projectId);
            if(p){
              const task={id:uid(),title:text,section:"General",priority:"Normal",dueDate:"",tags:[],notes:`From meeting: ${title}`,waitingFor:"",done:false,createdAt:nowISO(),updatedAt:nowISO()};
              p.tasks.push(task);p.updatedAt=nowISO();
              linkedActions.push({text,taskId:task.id,projectId});
            }
          }else{
            const linkedNames=projectIds.map(id=>projectById(id)?.name).filter(Boolean);
            const taskNotes = linkedNames.length ? `From meeting: ${title}\nProjects: ${linkedNames.join(", ")}` : `From meeting: ${title}`;
            const task={id:uid(),title:text,priority:"Normal",dueDate:"",tags:[],notes:taskNotes,waitingFor:"",done:false,createdAt:nowISO(),updatedAt:nowISO()};
            state.generalTasks.push(task);
            linkedActions.push({text,taskId:task.id,projectId:"",projectIds:[...projectIds]});
          }
        }

        const data={title,date:$("#mmDate").value,projectIds,participants:$("#mmParticipants").value.trim(),notes:$("#mmNotes").value.trim(),
          decisions:$("#mmDecisions").value.split("\n").map(x=>x.trim()).filter(Boolean),
          questions:$("#mmQuestions").value.split("\n").map(x=>x.trim()).filter(Boolean),actions:linkedActions,updatedAt:nowISO()};
        if(existing){Object.assign(existing,data);delete existing.projectId;delete existing.summary;}
        else state.meetings.unshift({id:uid(),createdAt:nowISO(),...data});
        persist();closeModal();render();toast("Meeting saved");
      };
      if(existing)$("#deleteMeetingBtn").onclick=()=>{if(confirm("Delete this meeting? Linked tasks will remain.")){state.meetings=state.meetings.filter(x=>x.id!==m.id);persist();closeModal();render();}};
    });
  }

  // ---------- General Tasks ----------
  function generalTaskRowHTML(t){
    const dc=isOverdue(t.dueDate)&&!t.done?"overdue":(daysFromNow(t.dueDate)<=3&&!t.done?"due-soon":"");
    return `<div class="list-row ${t.done?"done":""}">
      <input type="checkbox" class="task-check general-check" data-general-id="${esc(t.id)}" ${t.done?"checked":""}>
      <div class="row-main"><div class="row-title">${esc(t.title)}</div>
        <div class="row-meta"><span>${esc(t.priority||"Normal")}</span>${t.dueDate?`<span class="${dc}">${dateOnly(t.dueDate)}</span>`:""}${t.waitingFor?`<span>Waiting for ${esc(t.waitingFor)}</span>`:""}</div>
        ${t.notes?`<div class="row-meta">${esc(t.notes)}</div>`:""}
      </div><div class="row-actions"><button class="row-button" data-edit-general="${esc(t.id)}">Edit</button><button class="row-button" data-delete-general="${esc(t.id)}">Delete</button></div>
    </div>`;
  }

  function renderGeneralTasks(root){
    const open=state.generalTasks.filter(t=>!t.done);
    const today=open.filter(t=>daysFromNow(t.dueDate)===0);
    const week=open.filter(t=>{const d=daysFromNow(t.dueDate);return d>0&&d<=7;});
    const later=open.filter(t=>t.dueDate&&daysFromNow(t.dueDate)>7);
    const nodate=open.filter(t=>!t.dueDate);
    const done=state.generalTasks.filter(t=>t.done);
    const group=(title,arr)=>arr.length?`<div class="task-group"><div class="task-group-title">${title}</div>${arr.sort(taskSort).map(generalTaskRowHTML).join("")}</div>`:"";
    root.innerHTML=`<div class="page-header"><div><h1 class="page-title">General Tasks</h1><p class="page-subtitle">Work that does not belong to a project</p></div><button class="button primary" id="newGeneralBtn">＋ Add task</button></div>
      <div class="panel">${group("Today",today)}${group("This week",week)}${group("Later",later)}${group("No date",nodate)}${done.length?`<details><summary class="task-group-title">Completed (${done.length})</summary>${done.map(generalTaskRowHTML).join("")}</details>`:""}${state.generalTasks.length?"":`<div class="empty">No general tasks.</div>`}</div>`;
    $("#newGeneralBtn").onclick=()=>openGeneralTaskModal();
    $$(".general-check",root).forEach(ch=>ch.onchange=()=>{const t=generalTaskById(ch.dataset.generalId);t.done=ch.checked;t.updatedAt=nowISO();persist();renderGeneralTasks(root);});
    $$("[data-edit-general]",root).forEach(b=>b.onclick=()=>openGeneralTaskModal(generalTaskById(b.dataset.editGeneral)));
    $$("[data-delete-general]",root).forEach(b=>b.onclick=()=>{const t=generalTaskById(b.dataset.deleteGeneral);if(t&&confirm(`Delete "${t.title}"?`)){state.generalTasks=state.generalTasks.filter(x=>x.id!==t.id);persist();renderGeneralTasks(root);}});
  }

  function openGeneralTaskModal(existing=null){
    const t=existing||{title:"",priority:"Normal",dueDate:"",tags:[],notes:"",waitingFor:""};
    openModal(existing?"Edit general task":"New general task",`
      <div class="form-row"><label class="field-label">Task</label><input class="field" id="mgTitle" value="${esc(t.title)}"></div>
      <div class="form-grid"><div class="form-row"><label class="field-label">Priority</label><select class="field" id="mgPriority">${PRIORITIES.map(x=>`<option ${x===t.priority?"selected":""}>${x}</option>`).join("")}</select></div>
      <div class="form-row"><label class="field-label">Due date</label><input type="date" class="field" id="mgDue" value="${esc(t.dueDate||"")}"></div></div>
      <div class="form-row"><label class="field-label">Waiting for</label><input class="field" id="mgWaiting" value="${esc(t.waitingFor||"")}"></div>
      <div class="form-row"><label class="field-label">Notes</label><textarea class="field" id="mgNotes">${esc(t.notes||"")}</textarea></div>
    `,`<button type="button" class="button secondary" id="cancelModalBtn">Cancel</button><button type="button" class="button primary" id="saveGeneralBtn">Save</button>`,()=>{
      $("#cancelModalBtn").onclick=closeModal;
      $("#saveGeneralBtn").onclick=()=>{const title=$("#mgTitle").value.trim();if(!title){toast("Task title is required");return;}
        const data={title,priority:$("#mgPriority").value,dueDate:$("#mgDue").value,waitingFor:$("#mgWaiting").value.trim(),notes:$("#mgNotes").value.trim(),updatedAt:nowISO()};
        if(existing)Object.assign(existing,data);else state.generalTasks.unshift({id:uid(),done:false,tags:[],createdAt:nowISO(),...data});
        persist();closeModal();render();};
    });
  }

  // ---------- Milestones ----------
  function openMilestoneModal(projectOrId,existingOrId=null){
    const projectId=typeof projectOrId==="string"?projectOrId:projectOrId?.id;
    const p=projectById(projectId);if(!p)return;
    const existingId=typeof existingOrId==="string"?existingOrId:existingOrId?.id;
    const existing=existingId?p.milestones.find(x=>x.id===existingId):null;
    const m=existing||{title:"",startDate:"",endDate:"",status:"Planned",waitingFor:"",notes:"",done:false};
    openModal(existing?"Edit milestone":"New milestone",`
      <div class="form-row"><label class="field-label">Milestone</label><input class="field" id="milTitle" value="${esc(m.title)}"></div>
      <div class="form-grid"><div class="form-row"><label class="field-label">Start</label><input type="date" class="field" id="milStart" value="${esc(m.startDate||"")}"></div>
      <div class="form-row"><label class="field-label">End / deadline</label><input type="date" class="field" id="milEnd" value="${esc(m.endDate||"")}"></div></div>
      <div class="form-row"><label class="field-label">Waiting for</label><input class="field" id="milWaiting" value="${esc(m.waitingFor||"")}"></div>
      <label style="display:flex;gap:8px;align-items:center;margin:12px 0"><input type="checkbox" id="milDone" ${m.done?"checked":""}> Completed</label>
      <div class="form-row"><label class="field-label">Notes</label><textarea class="field" id="milNotes">${esc(m.notes||"")}</textarea></div>
      ${existing?`<button type="button" class="button danger small" id="deleteMilestoneBtn">Delete milestone</button>`:""}
    `,`<button type="button" class="button secondary" id="cancelModalBtn">Cancel</button><button type="button" class="button primary" id="saveMilestoneBtn">Save</button>`,()=>{
      $("#cancelModalBtn").onclick=closeModal;
      $("#saveMilestoneBtn").onclick=()=>{const title=$("#milTitle").value.trim();if(!title){toast("Milestone title is required");return;}
        const lp=projectById(projectId);if(!lp)return;
        const data={title,startDate:$("#milStart").value,endDate:$("#milEnd").value,waitingFor:$("#milWaiting").value.trim(),done:$("#milDone").checked,notes:$("#milNotes").value.trim(),updatedAt:nowISO()};
        if(existingId){const lm=lp.milestones.find(x=>x.id===existingId);if(lm)Object.assign(lm,data);}else lp.milestones.push({id:uid(),createdAt:nowISO(),...data});
        lp.updatedAt=nowISO();persist();closeModal();currentProjectTab="gantt";renderProject($("#content"),projectId);};
      if(existingId)$("#deleteMilestoneBtn").onclick=()=>{if(confirm("Delete this milestone?")){const lp=projectById(projectId);if(!lp)return;lp.milestones=lp.milestones.filter(x=>x.id!==existingId);lp.updatedAt=nowISO();persist();closeModal();renderProject($("#content"),projectId);}};
    });
  }


  // ---------- Search ----------
  function renderSearch(root) {
    root.innerHTML = `
      <div class="page-header"><div><h1 class="page-title">Search</h1><p class="page-subtitle">Projects, tasks, notes, tags and Inbox</p></div></div>
      <div class="search-box"><input class="field" id="searchInput" placeholder="Search ResearchFlow…" autofocus></div>
      <div id="searchResults"></div>
    `;
    $("#searchInput").addEventListener("input",e=>renderSearchResults($("#searchResults"),e.target.value));
  }
  function renderSearchResults(root,q) {
    q=q.trim().toLowerCase();
    if(!q){root.innerHTML=`<div class="panel"><div class="empty">Start typing to search.</div></div>`;return;}
    const ps=state.projects.filter(p=>[p.name,p.summary,p.nextAction,p.notes,(p.tags||[]).join(" ")].join(" ").toLowerCase().includes(q));
    const ts=state.projects.flatMap(p=>(p.tasks||[]).filter(t=>[t.title,t.section,t.notes,(t.tags||[]).join(" ")].join(" ").toLowerCase().includes(q)).map(t=>({p,t})));
    const ins=state.inbox.filter(n=>[n.text,(n.tags||[]).join(" ")].join(" ").toLowerCase().includes(q));
    const gs=state.generalTasks.filter(t=>[t.title,t.notes,t.waitingFor,(t.tags||[]).join(" ")].join(" ").toLowerCase().includes(q));
    const ms=state.meetings.filter(m=>[m.title,m.participants,m.notes||m.summary,(m.decisions||[]).join(" "),(m.questions||[]).join(" "),(m.projectIds||[]).map(id=>projectById(id)?.name||"").join(" ")].join(" ").toLowerCase().includes(q));
    root.innerHTML=`
      ${searchSection("Projects",ps.map(p=>`<div class="project-card" data-open-project="${esc(p.id)}"><div class="row-title">${esc(p.name)}</div><div class="row-meta">${esc(p.summary||p.nextAction||"")}</div></div>`))}
      ${searchSection("Tasks",ts.map(x=>`<div class="project-card" data-open-project="${esc(x.p.id)}"><div class="row-title">${esc(x.t.title)}</div><div class="row-meta">${esc(x.p.name)} · ${esc(x.t.section)}</div></div>`))}
      ${searchSection("General Tasks",gs.map(t=>`<div class="list-row"><div class="row-main"><div class="row-title">${esc(t.title)}</div><div class="row-meta">${esc(t.waitingFor||"")}</div></div></div>`))}
      ${searchSection("Meetings",ms.map(m=>`<div class="project-card" data-search-meeting="${esc(m.id)}"><div class="row-title">${esc(m.title)}</div><div class="row-meta">${dateOnly(m.date)}</div></div>`))}
      ${searchSection("Inbox",ins.map(n=>`<div class="list-row"><div class="row-main"><div class="row-title">${esc(n.text)}</div></div></div>`))}
      ${ps.length+ts.length+ins.length+gs.length+ms.length===0?`<div class="panel"><div class="empty">No matches.</div></div>`:""}
    `;
    $$("[data-open-project]",root).forEach(el=>el.addEventListener("click",()=>{currentProjectId=el.dataset.openProject;currentView="project";render();}));
  }
  function searchSection(title,rows){return rows.length?`<div class="panel search-section"><div class="panel-title-row"><h2 class="panel-title">${esc(title)}</h2></div>${rows.join("")}</div>`:"";}

  // ---------- Settings / OneDrive ----------
  function renderSettings(root) {
    root.innerHTML=`
      <div class="page-header"><div><h1 class="page-title">Settings & Sync</h1><div class="row-meta">ResearchFlow v0.4.5</div><p class="page-subtitle">Local-first storage with optional OneDrive synchronization</p></div></div>
      <div class="settings-grid">
        <div>
          <div class="panel">
            <div class="panel-title-row"><h2 class="panel-title">OneDrive</h2></div>
            ${state.settings.syncEnabled?`
              <div class="success-box">Connected${state.settings.oneDriveAccount?` as <strong>${esc(state.settings.oneDriveAccount)}</strong>`:""}. ResearchFlow is connected to your personal Microsoft account. Sync data is stored only in the OneDrive folder /ResearchFlow/.</div>
              <div class="form-row" style="margin-top:14px"><label class="field-label">Last sync</label><div>${state.settings.lastSyncedAt?shortDateTime(state.settings.lastSyncedAt):"Not yet synced"}</div></div>
              ${state.settings.lastSyncError?`<div class="warning-box" style="margin:12px 0"><strong>Last OneDrive error</strong><br>${esc(state.settings.lastSyncError)}</div>`:""}
              <label style="display:flex;gap:8px;align-items:center;margin:14px 0"><input type="checkbox" id="autoSyncCheck" ${state.settings.autoSync?"checked":""}> Automatically sync after changes</label>
              <div class="section-toolbar">
                <button class="button primary" id="syncNowBtn">↻ Sync now</button>
                <button class="button secondary" id="pullBtn">↓ Pull from OneDrive</button>
                <button class="button secondary" id="pushBtn">↑ Push to OneDrive</button>
                <button class="button secondary" id="reconnectBtn">Reconnect personal OneDrive</button>
                <button class="button danger" id="disconnectBtn">Disconnect</button>
              </div>
            `:`
              <div class="info-box">To connect OneDrive, ResearchFlow needs a free Microsoft Entra app registration. Enter its Application (client) ID below. No Microsoft 365 upgrade or Apple developer subscription is required.</div>
              <div class="form-row" style="margin-top:14px"><label class="field-label">Microsoft Application (client) ID</label><input id="clientIdInput" class="field" value="${esc(state.settings.clientId||"")}" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"></div>
              <button class="button primary" id="connectOneDriveBtn">Connect OneDrive</button>
            `}
          </div>

          <div class="panel">
            <div class="panel-title-row"><h2 class="panel-title">Data backup</h2></div>
            <div class="section-toolbar">
              <button class="button secondary" id="exportBtn">Export JSON backup</button>
              <button class="button secondary" id="importBtn">Import JSON backup</button>
              <input id="importFile" type="file" accept="application/json" class="hidden">
            </div>
          </div>
        </div>

        <div>
          <div class="panel">
            <div class="panel-title-row"><h2 class="panel-title">Install on iPhone</h2></div>
            <div class="info-box">After this app is hosted on an HTTPS address, open it in Safari → Share → <strong>Add to Home Screen</strong>. It then opens like a standalone app and does not expire after seven days.</div>
          </div>
          <div class="panel">
            <div class="panel-title-row"><h2 class="panel-title">Dictation</h2></div>
            <div class="info-box">ResearchFlow supports browser speech recognition where Safari exposes it. On every iPhone and Mac, you can also dictate into any text box using Apple's keyboard/system Dictation.</div>
          </div>
          <div class="panel">
            <div class="panel-title-row"><h2 class="panel-title">Privacy</h2></div>
            <div class="warning-box">Use this as a research organizer, not an approved clinical record. Do not store patient names, medical record numbers, dates of birth, or other identifiable clinical information unless your institution has approved this exact storage setup.</div>
          </div>
        </div>
      </div>
    `;

    if(state.settings.syncEnabled){
      $("#autoSyncCheck").addEventListener("change",e=>{state.settings.autoSync=e.target.checked;persist({touch:false,autosync:false});});
      $("#syncNowBtn").addEventListener("click",()=>syncNow());
      $("#pullBtn").addEventListener("click",()=>pullFromOneDrive().catch(handleVisibleSyncError));
      $("#pushBtn").addEventListener("click",()=>pushToOneDrive().catch(handleVisibleSyncError));
      $("#reconnectBtn").addEventListener("click",()=>reconnectPersonalOneDrive().catch(handleVisibleSyncError));
      $("#disconnectBtn").addEventListener("click",async()=>{
        if(confirm("Disconnect OneDrive? Your local data will stay on this device.")){
          try{ if(msalApp){const a=msalApp.getAllAccounts()[0];if(a)await msalApp.logoutPopup({account:a});} }catch{}
          state.settings.syncEnabled=false;state.settings.oneDriveAccount="";state.settings.lastSyncedAt="";state.settings.lastSyncError="";
          persist({touch:false,autosync:false}); msalApp=null; renderSettings(root); toast("Disconnected");
        }
      });
    } else {
      $("#connectOneDriveBtn").addEventListener("click",async()=>{
        const id=$("#clientIdInput").value.trim();
        if(!id){toast("Enter the Microsoft client ID first");return;}
        state.settings.clientId=id;persist({touch:false,autosync:false});
        try{await connectOneDrive();renderSettings(root);}catch(e){console.error(e);toast(e.message||"Could not connect");}
      });
    }

    $("#exportBtn").addEventListener("click",exportBackup);
    $("#importBtn").addEventListener("click",()=>$("#importFile").click());
    $("#importFile").addEventListener("change",importBackup);
  }

  async function initMsal() {
    if(!state.settings.clientId) throw new Error("Microsoft client ID is not configured.");
    if(typeof msal === "undefined") throw new Error("Microsoft sign-in library is unavailable. Check your internet connection.");
    if(msalApp) return msalApp;
    const config={
      auth:{
        clientId:state.settings.clientId,
        authority:"https://login.microsoftonline.com/consumers",
        redirectUri:window.location.origin + window.location.pathname
      },
      cache:{cacheLocation:"localStorage"}
    };
    msalApp=new msal.PublicClientApplication(config);
    if(msalApp.initialize) await msalApp.initialize();
    try{await msalApp.handleRedirectPromise();}catch{}
    return msalApp;
  }

  const graphScopes=["Files.ReadWrite","User.Read"];

  async function connectOneDrive() {
    const app=await initMsal();
    let result;
    try{
      result=await app.loginPopup({
        scopes:graphScopes,
        prompt:"consent",
        authority:"https://login.microsoftonline.com/consumers"
      });
    }catch(e){
      if(String(e?.errorCode||e).includes("popup")) {
        await app.loginRedirect({
          scopes:graphScopes,
          authority:"https://login.microsoftonline.com/consumers"
        });
        return;
      }
      throw e;
    }
    state.settings.syncEnabled=true;
    state.settings.oneDriveAccount=result.account?.username||result.account?.name||"";
    state.settings.lastSyncError="";
    persist({touch:false,autosync:false});
    await syncNow();
    toast("OneDrive connected");
  }

  async function getAccessToken() {
    const app=await initMsal();
    let account=app.getAllAccounts().find(a =>
      a.tenantId === CONSUMER_TENANT_ID ||
      a.idTokenClaims?.tid === CONSUMER_TENANT_ID
    );

    if(!account){
      const login=await app.loginPopup({
        scopes:graphScopes,
        prompt:"select_account",
        authority:"https://login.microsoftonline.com/consumers"
      });
      account=login.account;
    }

    try{
      const r=await app.acquireTokenSilent({
        scopes:graphScopes,
        account,
        authority:"https://login.microsoftonline.com/consumers"
      });
      return r.accessToken;
    }catch{
      const r=await app.acquireTokenPopup({
        scopes:graphScopes,
        account,
        authority:"https://login.microsoftonline.com/consumers"
      });
      return r.accessToken;
    }
  }

  async function graph(path,options={}) {
    const token=await getAccessToken();
    const headers={Authorization:`Bearer ${token}`,...(options.headers||{})};
    const endpoint=`https://graph.microsoft.com/v1.0${path}`;
    const res=await fetch(endpoint,{...options,headers});

    if(!res.ok){
      let graphCode="";
      let graphMessage="";
      let raw="";

      try{
        const data=await res.clone().json();
        graphCode=data?.error?.code||"";
        graphMessage=data?.error?.message||"";
        raw=JSON.stringify(data);
      }catch{
        raw=await res.text();
      }

      const detail = [
        `HTTP ${res.status}`,
        graphCode ? `Code: ${graphCode}` : "",
        graphMessage ? `Message: ${graphMessage}` : (raw ? `Response: ${raw.slice(0,500)}` : ""),
        `Endpoint: ${path}`
      ].filter(Boolean).join(" | ");

      const e=new Error(detail);
      e.status=res.status;
      e.graphCode=graphCode;
      e.graphMessage=graphMessage;
      e.endpoint=path;
      throw e;
    }
    return res;
  }

  function cloudPayload() {
    return {
      version:state.version,
      modifiedAt:state.modifiedAt,
      projects:state.projects,
      meetings:state.meetings,
      generalTasks:state.generalTasks,
      inbox:state.inbox
    };
  }

  async function ensureResearchFlowFolder() {
    try {
      const res = await graph("/me/drive/root:/ResearchFlow");
      return await res.json();
    } catch (e) {
      if (e.status !== 404) throw e;

      const createRes = await graph("/me/drive/root/children", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          name: "ResearchFlow",
          folder: {},
          "@microsoft.graph.conflictBehavior": "fail"
        })
      });
      return await createRes.json();
    }
  }

  async function getRemotePayload() {
    await ensureResearchFlowFolder();
    try{
      const contentRes=await graph(`/me/drive/root:/ResearchFlow/${encodeURIComponent(CLOUD_FILE)}:/content`);
      return await contentRes.json();
    }catch(e){
      if(e.status===404)return null;
      throw e;
    }
  }

  async function pushPayloadWithConflictRetry({maxAttempts=4}={}) {
    let lastError = null;

    for (let attempt=0; attempt<maxAttempts; attempt++) {
      try {
        await ensureResearchFlowFolder();
        const body=JSON.stringify(cloudPayload(),null,2);
        await graph(`/me/drive/root:/ResearchFlow/${encodeURIComponent(CLOUD_FILE)}:/content`,{
          method:"PUT",
          headers:{"Content-Type":"application/json"},
          body
        });
        return;
      } catch (e) {
        lastError = e;
        if (!isResourceModifiedError(e) || attempt === maxAttempts-1) throw e;

        // Another device/tab changed the file while this write was in progress.
        // Re-read, merge the newest data into local state, then retry with backoff.
        await sleep(350 * (attempt + 1) + Math.floor(Math.random()*180));
        const remote = await getRemotePayload();
        if (remote) {
          const merged = mergeCloudData(state, remote);
          state.projects = merged.projects;
          state.meetings = merged.meetings;
          state.generalTasks = merged.generalTasks;
          state.inbox = merged.inbox;
          state.modifiedAt = merged.modifiedAt;
          persist({touch:false,autosync:false});
        }
      }
    }
    if (lastError) throw lastError;
  }

  async function pushToOneDriveUnlocked({quiet=false}={}) {
    if(!state.settings.syncEnabled) throw new Error("OneDrive is not connected.");

    await pushPayloadWithConflictRetry();

    state.settings.lastSyncedAt=nowISO();
    state.settings.lastSyncError="";
    persist({touch:false,autosync:false});
    if(!quiet){render();toast("Synced to OneDrive");}
  }

  function pushToOneDrive(options={}) {
    return queueCloudOperation(()=>pushToOneDriveUnlocked(options));
  }

  async function pullFromOneDriveUnlocked({quiet=false}={}) {
    if(!state.settings.syncEnabled) throw new Error("OneDrive is not connected.");
    const remote=await getRemotePayload();
    if(!remote){ if(!quiet)toast("No OneDrive backup exists yet"); return false; }
    const merged=mergeCloudData(state,remote);
    state.projects=merged.projects;
    state.meetings=merged.meetings;
    state.generalTasks=merged.generalTasks;
    state.inbox=merged.inbox;
    state.modifiedAt=merged.modifiedAt;
    state.settings.lastSyncedAt=nowISO();
    state.settings.lastSyncError="";
    persist({touch:false,autosync:false});
    if(!quiet){render();toast("Pulled from OneDrive");}
    return true;
  }

  function pullFromOneDrive(options={}) {
    return queueCloudOperation(()=>pullFromOneDriveUnlocked(options));
  }

  async function syncNowUnlocked({quiet=false}={}) {
    if(!state.settings.syncEnabled) return;
    try{
      const remote=await getRemotePayload();
      if(remote){
        const merged=mergeCloudData(state,remote);
        state.projects=merged.projects;
        state.meetings=merged.meetings;
        state.generalTasks=merged.generalTasks;
        state.inbox=merged.inbox;
        state.modifiedAt=merged.modifiedAt;
        persist({touch:false,autosync:false});
      }

      await pushPayloadWithConflictRetry();

      state.settings.lastSyncedAt=nowISO();
      state.settings.lastSyncError="";
      persist({touch:false,autosync:false});
      if(!quiet){render();toast("OneDrive synchronized");}
    }catch(e){
      console.error(e);
      state.settings.lastSyncError=readableSyncError(e);
      persist({touch:false,autosync:false});
      if(!quiet){render();toast("Sync failed — error shown below");}
    }
  }

  function syncNow(options={}) {
    return queueCloudOperation(()=>syncNowUnlocked(options));
  }

  function readableSyncError(e){
    const raw=String(e?.message||e||"Unknown sync error");

    let guidance="";
    if(e?.status===403 || /accessDenied|Authorization_RequestDenied|insufficient privileges/i.test(raw)){
      guidance=" Microsoft authenticated you, but Graph refused this operation. The exact Microsoft code/message above is needed to distinguish consent, account type, and OneDrive access issues.";
    }else if(isResourceModifiedError(e)){
      guidance=" Another device or tab changed the OneDrive file at the same moment. ResearchFlow normally retries this automatically; if this message persists, wait a few seconds and tap Sync now once.";
    }else if(e?.status===401 || /invalid_grant|interaction_required/i.test(raw)){
      guidance=" The Microsoft session needs to be renewed. Use “Reconnect personal OneDrive”.";
    }else if(/mysite|not provisioned|drive.*not found|ResourceNotFound/i.test(raw)){
      guidance=" This Microsoft identity may not have an initialized OneDrive.";
    }

    const combined = raw + guidance;
    return combined.length>1000 ? combined.slice(0,1000)+"…" : combined;
  }

  function handleVisibleSyncError(e){
    console.error(e);
    state.settings.lastSyncError=readableSyncError(e);
    persist({touch:false,autosync:false});
    render();
    toast("OneDrive operation failed — error shown below");
  }

  async function reconnectPersonalOneDrive(){
    const app=await initMsal();
    try{
      if(app.clearCache) await app.clearCache();
    }catch{}

    msalApp=null;
    const fresh=await initMsal();
    const result=await fresh.loginPopup({
      scopes:graphScopes,
      prompt:"consent",
      authority:"https://login.microsoftonline.com/consumers"
    });

    state.settings.syncEnabled=true;
    state.settings.oneDriveAccount=result.account?.username||result.account?.name||"";
    state.settings.lastSyncError="";
    persist({touch:false,autosync:false});

    await pushToOneDrive();
    render();
  }

  function mergeCloudData(local,remote) {
    const itemTime = item => new Date(item?.updatedAt || item?.createdAt || 0).getTime();

    const mergeById=(remoteList=[],localList=[])=>{
      const map=new Map();
      for(const item of [...remoteList,...localList]){
        if(!item?.id) continue;
        const old=map.get(item.id);
        if(!old || itemTime(item) >= itemTime(old)) map.set(item.id,item);
      }
      return [...map.values()];
    };

    const mergeProjects=(remoteProjects=[],localProjects=[])=>{
      const rmap=new Map(remoteProjects.map(p=>[p.id,p]));
      const lmap=new Map(localProjects.map(p=>[p.id,p]));
      const ids=new Set([...rmap.keys(),...lmap.keys()]);
      const out=[];

      for(const id of ids){
        const r=rmap.get(id), l=lmap.get(id);
        if(!r){ out.push(l); continue; }
        if(!l){ out.push(r); continue; }

        const newer = itemTime(l) >= itemTime(r) ? l : r;
        const older = newer === l ? r : l;

        out.push({
          ...older,
          ...newer,
          id,
          sections:[...new Set([...(r.sections||[]),...(l.sections||[])])],
          tasks:mergeById(r.tasks||[],l.tasks||[]),
          milestones:mergeById(r.milestones||[],l.milestones||[])
        });
      }
      return out;
    };

    const latestModified = Math.max(
      new Date(local.modifiedAt||0).getTime() || 0,
      new Date(remote.modifiedAt||0).getTime() || 0
    );

    return {
      projects:mergeProjects(remote.projects||[],local.projects||[]),
      meetings:mergeById(remote.meetings||[],local.meetings||[]),
      generalTasks:mergeById(remote.generalTasks||[],local.generalTasks||[]),
      inbox:mergeById(remote.inbox||[],local.inbox||[]).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)),
      modifiedAt:new Date(latestModified || Date.now()).toISOString()
    };
  }

  // ---------- Modals ----------
  function openModal(title,bodyHTML,actionsHTML,onReady) {
    $("#modalTitle").textContent=title;
    $("#modalBody").innerHTML=bodyHTML;
    $("#modalActions").innerHTML=actionsHTML;
    const dlg=$("#modal");
    dlg.showModal();
    applyAutomaticTextDirection(dlg);
    if(onReady)onReady(dlg);
  }
  function closeModal(){ $("#modal").close(); }

  function openProjectModal(existing=null) {
    const p=existing||{name:"",summary:"",status:"Idea",priority:"Normal",nextAction:"",deadline:"",tags:[]};
    openModal(existing?"Edit project":"New project",`
      <div class="form-row"><label class="field-label">Project name</label><input class="field" id="mpName" value="${esc(p.name)}"></div>
      <div class="form-row"><label class="field-label">Summary</label><textarea class="field" id="mpSummary">${esc(p.summary||"")}</textarea></div>
      <div class="form-grid">
        <div class="form-row"><label class="field-label">Status</label><select class="field" id="mpStatus">${STATUSES.map(x=>`<option ${x===p.status?"selected":""}>${x}</option>`).join("")}</select></div>
        <div class="form-row"><label class="field-label">Priority</label><select class="field" id="mpPriority">${PRIORITIES.map(x=>`<option ${x===p.priority?"selected":""}>${x}</option>`).join("")}</select></div>
      </div>
      <div class="form-grid">
        <div class="form-row"><label class="field-label">Deadline</label><input type="date" class="field" id="mpDeadline" value="${esc(p.deadline||"")}"></div>
        <div class="form-row"><label class="field-label">Tags</label><input class="field" id="mpTags" value="${esc((p.tags||[]).join(", "))}" placeholder="AST, manuscript, retrospective"></div>
      </div>
      ${existing?`<hr class="sep"><button type="button" class="button danger small" id="deleteProjectBtn">Delete project</button>`:""}
    `,`<button class="button secondary" type="button" id="cancelModalBtn">Cancel</button><button class="button primary" type="button" id="saveProjectBtn">${existing?"Save":"Create"}</button>`,()=>{
      $("#cancelModalBtn").onclick=closeModal;
      $("#saveProjectBtn").onclick=()=>{
        const name=$("#mpName").value.trim(); if(!name){toast("Project name is required");return;}
        if(existing){
          const liveExisting=projectById(existing.id);if(!liveExisting){toast("Project could not be found");return;}
          Object.assign(liveExisting,{name,summary:$("#mpSummary").value.trim(),status:$("#mpStatus").value,priority:$("#mpPriority").value,deadline:$("#mpDeadline").value,tags:normalizeTags($("#mpTags").value),updatedAt:nowISO()});
        }else{
          const np={id:uid(),name,summary:$("#mpSummary").value.trim(),status:$("#mpStatus").value,priority:$("#mpPriority").value,nextAction:"",deadline:$("#mpDeadline").value,tags:normalizeTags($("#mpTags").value),notes:"",sections:[...DEFAULT_SECTIONS],tasks:[],milestones:[],createdAt:nowISO(),updatedAt:nowISO()};
          state.projects.unshift(np);currentProjectId=np.id;currentView="project";
        }
        persist();closeModal();render();
      };
      if(existing)$("#deleteProjectBtn").onclick=()=>{
        if(confirm(`Delete project "${existing.name}" and all of its tasks?`)){
          state.projects=state.projects.filter(x=>x.id!==existing.id);currentProjectId=null;currentView="dashboard";persist();closeModal();render();
        }
      };
    });
  }

  function openTaskModal(projectOrId,existingOrId=null) {
    const projectId = typeof projectOrId === "string" ? projectOrId : projectOrId?.id;
    const p = projectById(projectId);
    if(!p){toast("Project could not be found");return;}
    const existingId = typeof existingOrId === "string" ? existingOrId : existingOrId?.id;
    const existing = existingId ? p.tasks.find(t=>t.id===existingId) : null;
    const t=existing||{title:"",section:p.sections?.[0]||"General",priority:"Normal",dueDate:"",tags:[],notes:"",waitingFor:""};
    const sections=[...new Set([...(p.sections||DEFAULT_SECTIONS),t.section])];
    openModal(existing?"Edit task":"New task",`
      <div class="form-row"><label class="field-label">Task</label><input class="field" id="mtTitle" value="${esc(t.title)}"></div>
      <div class="form-grid">
        <div class="form-row"><label class="field-label">Section</label><select class="field" id="mtSection">${sections.map(x=>`<option ${x===t.section?"selected":""}>${esc(x)}</option>`).join("")}</select></div>
        <div class="form-row"><label class="field-label">Priority</label><select class="field" id="mtPriority">${PRIORITIES.map(x=>`<option ${x===t.priority?"selected":""}>${x}</option>`).join("")}</select></div>
      </div>
      <div class="form-grid">
        <div class="form-row"><label class="field-label">Due date</label><input type="date" class="field" id="mtDue" value="${esc(t.dueDate||"")}"></div>
        <div class="form-row"><label class="field-label">Tags</label><input class="field" id="mtTags" value="${esc((t.tags||[]).join(", "))}"></div>
      </div>
      <div class="form-row"><label class="field-label">Waiting for (optional)</label><input class="field" id="mtWaiting" value="${esc(t.waitingFor||"")}" placeholder="Statistician, collaborator, lab result…"></div>
      <div class="form-row"><label class="field-label">Task notes</label><textarea class="field" id="mtNotes">${esc(t.notes||"")}</textarea></div>
    `,existing
      ? `<button class="button secondary" type="button" id="cancelModalBtn">Cancel</button><button class="button primary" type="button" id="saveTaskBtn">Save</button>`
      : `<button class="button secondary" type="button" id="cancelModalBtn">Cancel</button><button class="button secondary" type="button" id="saveAnotherTaskBtn">Add & another</button><button class="button primary" type="button" id="saveTaskBtn">Add task</button>`,()=>{
      $("#cancelModalBtn").onclick=closeModal;

      const collect=()=>({
        title:$("#mtTitle").value.trim(),
        section:$("#mtSection").value,
        priority:$("#mtPriority").value,
        dueDate:$("#mtDue").value,
        tags:normalizeTags($("#mtTags").value),
        notes:$("#mtNotes").value.trim(),
        waitingFor:$("#mtWaiting").value.trim()
      });

      const saveTask=(addAnother=false)=>{
        const values=collect();if(!values.title){toast("Task title is required");return;}
        const lp=projectById(projectId);if(!lp){toast("Project could not be found");closeModal();return;}

        if(existingId){
          const liveTask=lp.tasks.find(x=>x.id===existingId);if(!liveTask){toast("Task could not be found");closeModal();return;}
          Object.assign(liveTask,{...values,updatedAt:nowISO()});
        }else{
          lp.tasks.push({id:uid(),...values,done:false,createdAt:nowISO(),updatedAt:nowISO()});
        }
        lp.updatedAt=nowISO();
        persist();

        if(addAnother){
          // Reopen against the current state object after persist/autosync scheduling.
          closeModal();
          renderProject($("#content"),projectId);
          openTaskModal(projectId);
          const freshTitle=$("#mtTitle");if(freshTitle)freshTitle.focus();
          toast("Task added");
        }else{
          closeModal();renderProject($("#content"),projectId);toast(existingId?"Task saved":"Task added");
        }
      };

      $("#saveTaskBtn").onclick=()=>saveTask(false);
      if(!existingId)$("#saveAnotherTaskBtn").onclick=()=>saveTask(true);
      setTimeout(()=>$("#mtTitle")?.focus(),0);
    });
  }

  function openSectionsModal(projectOrId) {
    const projectId=typeof projectOrId==="string"?projectOrId:projectOrId?.id;
    const p=projectById(projectId);if(!p)return;
    const sections=p.sections||[...DEFAULT_SECTIONS];
    openModal("Manage task sections",`
      <div id="sectionList">${sections.map((s,i)=>`<div class="list-row"><div class="row-main"><input class="field section-input" data-index="${i}" value="${esc(s)}"></div><button type="button" class="row-button section-delete" data-index="${i}">Delete</button></div>`).join("")}</div>
      <div class="form-row" style="margin-top:14px"><input class="field" id="newSectionName" placeholder="New section name"></div>
      <button type="button" class="button secondary" id="addSectionBtn">＋ Add section</button>
    `,`<button class="button secondary" type="button" id="cancelModalBtn">Cancel</button><button class="button primary" type="button" id="saveSectionsBtn">Save</button>`,()=>{
      let work=[...sections];
      const redraw=()=>{closeModal();const lp=projectById(projectId);if(lp)lp.sections=work;openSectionsModal(projectId);};
      $("#cancelModalBtn").onclick=closeModal;
      $("#addSectionBtn").onclick=()=>{
        const name=$("#newSectionName").value.trim();if(!name)return;
        if(!work.includes(name))work.push(name);redraw();
      };
      $$(".section-delete").forEach(b=>b.onclick=()=>{
        const lp=projectById(projectId);if(!lp)return;
        const idx=+b.dataset.index;const name=work[idx];
        if((lp.tasks||[]).some(t=>t.section===name)){toast("Move or delete tasks in this section first");return;}
        work.splice(idx,1);redraw();
      });
      $("#saveSectionsBtn").onclick=()=>{
        const names=$$(".section-input").map(x=>x.value.trim()).filter(Boolean);
        if(!names.length){toast("Keep at least one section");return;}
        const lp=projectById(projectId);if(!lp)return;
        lp.sections=[...new Set(names)];lp.updatedAt=nowISO();persist();closeModal();renderProject($("#content"),projectId);
      };
    });
  }

  function openMoveInboxModal(note) {
    if(!state.projects.length){toast("Create a project first");return;}
    openModal("Move Inbox item to project",`
      <div class="form-row"><label class="field-label">Project</label><select class="field" id="moveProject">${state.projects.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></div>
      <div class="form-row"><label class="field-label">Destination</label><select class="field" id="moveDestination"><option value="note">Append to project notes</option><option value="task">Create a task</option></select></div>
    `,`<button class="button secondary" type="button" id="cancelModalBtn">Cancel</button><button class="button primary" type="button" id="moveInboxBtn">Move</button>`,()=>{
      $("#cancelModalBtn").onclick=closeModal;
      $("#moveInboxBtn").onclick=()=>{
        const p=projectById($("#moveProject").value); if(!p)return;
        if($("#moveDestination").value==="task"){
          p.tasks=p.tasks||[];p.tasks.push({id:uid(),title:note.text,section:p.sections?.[0]||"General",priority:"Normal",dueDate:"",tags:note.tags||[],notes:"",done:false,createdAt:nowISO(),updatedAt:nowISO()});
        }else{
          p.notes=(p.notes?`${p.notes}\n\n`:"")+`${new Date().toLocaleDateString()}\n${note.text}`;
        }
        p.updatedAt=nowISO();state.inbox=state.inbox.filter(n=>n.id!==note.id);persist();closeModal();renderInbox($("#content"));toast("Moved to project");
      };
    });
  }

  // ---------- Dictation ----------
  function startDictation(target,{append=false}={}) {
    const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SpeechRecognition){
      target.focus();
      toast("Use the keyboard microphone for dictation");
      return;
    }
    try{
      const rec=new SpeechRecognition();
      rec.continuous=false;
      rec.interimResults=true;
      rec.lang=navigator.language||"en-US";
      const original=append&&target.value.trim()?target.value.trim()+"\n":"";
      rec.onstart=()=>toast("Listening…");
      rec.onresult=e=>{
        let text="";
        for(let i=e.resultIndex;i<e.results.length;i++)text+=e.results[i][0].transcript;
        target.value=original+text;
        target.dispatchEvent(new Event("input",{bubbles:true}));
      };
      rec.onerror=()=>{target.focus();toast("Speech button unavailable — use keyboard Dictation");};
      rec.onend=()=>target.focus();
      rec.start();
    }catch{
      target.focus();toast("Use the keyboard microphone for dictation");
    }
  }

  // ---------- Backup ----------
  function exportBackup() {
    const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json"});
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`ResearchFlow-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(a.href);
  }
  async function importBackup(e) {
    const f=e.target.files?.[0];if(!f)return;
    try{
      const parsed=JSON.parse(await f.text());
      if(!Array.isArray(parsed.projects)||!Array.isArray(parsed.inbox))throw new Error("Invalid backup");
      if(confirm("Replace local ResearchFlow data with this backup?")){
        const settings=state.settings;
        state={...defaultState(),...parsed,settings:{...settings,...(parsed.settings||{})}};
        persist({touch:true,autosync:false});render();toast("Backup imported");
      }
    }catch{toast("Could not import this backup");}
    e.target.value="";
  }

  // ---------- UI wiring ----------
  function openSidebar(){ $("#sidebar").classList.add("open"); }
  function closeSidebar(){ $("#sidebar").classList.remove("open"); }

  $$(".nav-item").forEach(btn=>btn.addEventListener("click",()=>{
    currentView=btn.dataset.view;currentProjectId=null;render();closeSidebar();
  }));
  $("#newProjectBtn").addEventListener("click",()=>openProjectModal());
  $("#newProjectSidebarBtn").addEventListener("click",()=>openProjectModal());
  $("#quickAddBtn").addEventListener("click",()=>{
    currentView="inbox";currentProjectId=null;render();setTimeout(()=>$("#inboxText")?.focus(),50);
  });
  $("#openSidebarBtn").addEventListener("click",openSidebar);
  $("#closeSidebarBtn").addEventListener("click",closeSidebar);

  // Initial redirect handling for MSAL when the app returns from Microsoft.
  async function resumeMicrosoftRedirect() {
    if(!state.settings.clientId || typeof msal==="undefined")return;
    try{
      await initMsal();
      const accounts=msalApp.getAllAccounts().filter(a =>
        a.tenantId === CONSUMER_TENANT_ID ||
        a.idTokenClaims?.tid === CONSUMER_TENANT_ID
      );
      if(accounts.length && !state.settings.syncEnabled){
        state.settings.syncEnabled=true;
        state.settings.oneDriveAccount=accounts[0].username||accounts[0].name||"";
        persist({touch:false,autosync:false});
        await syncNow({quiet:true});
      }
    }catch(e){console.warn("Microsoft redirect initialization:",e);}
  }

  if("serviceWorker" in navigator && (location.protocol==="https:" || location.hostname==="localhost" || location.hostname==="127.0.0.1")){
    navigator.serviceWorker.register("service-worker.js").catch(()=>{});
  }

  installAutomaticTextDirection();
  refreshNavigation();
  render();
  resumeMicrosoftRedirect().then(()=>{refreshNavigation();applyAutomaticTextDirection(document);});
})();
