
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
      version: 1,
      modifiedAt: nowISO(),
      projects: [],
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
  let currentView = "dashboard";
  let currentProjectId = null;
  let msalApp = null;
  let autoSyncTimer = null;

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

  function refreshNavigation() {
    $("#inboxBadge").textContent = state.inbox.length;
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

  function render() {
    refreshNavigation();
    setActiveNav();
    const content = $("#content");
    if (currentView === "dashboard") renderDashboard(content);
    else if (currentView === "inbox") renderInbox(content);
    else if (currentView === "search") renderSearch(content);
    else if (currentView === "settings") renderSettings(content);
    else if (currentView === "project") renderProject(content, currentProjectId);
    window.scrollTo({top:0,behavior:"instant"});
  }

  // ---------- Dashboard ----------
  function renderDashboard(root) {
    const active = state.projects.filter(p=>p.status!=="Complete");
    const openTasks = state.projects.flatMap(p => (p.tasks||[]).filter(t=>!t.done).map(t=>({p,t})));
    const due14 = openTasks.filter(x=>{ const d=daysFromNow(x.t.dueDate); return d>=0 && d<=14; });
    const overdue = openTasks.filter(x=>isOverdue(x.t.dueDate));

    const nextActions = active.filter(p=>String(p.nextAction||"").trim())
      .sort((a,b)=>priorityRank(a.priority)-priorityRank(b.priority));

    const upcoming = openTasks.filter(x=>x.t.dueDate && daysFromNow(x.t.dueDate)>=0 && daysFromNow(x.t.dueDate)<=14)
      .sort((a,b)=>String(a.t.dueDate).localeCompare(String(b.t.dueDate)));

    root.innerHTML = `
      <div class="page-header">
        <div><h1 class="page-title">Dashboard</h1><p class="page-subtitle">Your research at a glance</p></div>
      </div>

      <div class="metrics">
        ${metric("▱",active.length,"Active projects")}
        ${metric("☷",openTasks.length,"Open tasks")}
        ${metric("▣",due14.length,"Due in 14 days")}
        ${metric("△",overdue.length,"Overdue")}
        ${metric("⌄",state.inbox.length,"Inbox")}
      </div>

      <div class="panel">
        <div class="panel-title-row"><h2 class="panel-title">⚡ Quick capture</h2></div>
        <div class="quick-capture">
          <textarea id="dashQuick" class="field" placeholder="Idea, task, paper to check…"></textarea>
          <button class="button secondary" id="dashDictate">🎙 Dictate</button>
          <button class="button primary" id="dashSaveQuick">Send to Inbox</button>
        </div>
        <div class="dictation-hint">On iPhone or Mac, you can also use the microphone on the system keyboard.</div>
      </div>

      <div class="panel">
        <div class="panel-title-row"><h2 class="panel-title">→ Next actions</h2><span class="spacer"></span></div>
        ${nextActions.length ? nextActions.slice(0,8).map(p=>`
          <div class="project-card" data-open-project="${esc(p.id)}">
            <div class="row-title">${esc(p.nextAction)}</div>
            <div class="row-meta"><span>${esc(p.name)}</span><span class="priority-${p.priority.toLowerCase()}">${esc(p.priority)} priority</span></div>
          </div>`).join("") : `<div class="empty">No next actions set.</div>`}
      </div>

      <div class="panel">
        <div class="panel-title-row"><h2 class="panel-title">◷ Upcoming</h2></div>
        ${upcoming.length ? upcoming.slice(0,10).map(x=>taskSummaryRow(x.p,x.t)).join("") : `<div class="empty">No tasks due in the next 14 days.</div>`}
      </div>

      ${overdue.length ? `<div class="panel">
        <div class="panel-title-row"><h2 class="panel-title">△ Overdue</h2></div>
        ${overdue.slice(0,10).map(x=>taskSummaryRow(x.p,x.t,true)).join("")}
      </div>` : ""}

      <div class="panel">
        <div class="panel-title-row"><h2 class="panel-title">▱ Projects</h2></div>
        ${active.length ? active.slice(0,12).map(p=>`
          <div class="project-card" data-open-project="${esc(p.id)}">
            <div class="row-title">${esc(p.name)}</div>
            <div class="row-meta">
              <span class="status-pill">${esc(p.status)}</span>
              <span>${(p.tasks||[]).filter(t=>!t.done).length} open tasks</span>
              ${p.deadline?`<span>${dateOnly(p.deadline)}</span>`:""}
            </div>
          </div>`).join("") : `<div class="empty">Create your first research project.</div>`}
      </div>
    `;

    $("#dashSaveQuick").addEventListener("click", ()=>{
      const text = $("#dashQuick").value.trim();
      if (!text) return;
      state.inbox.unshift({id:uid(),text,tags:[],createdAt:nowISO(),updatedAt:nowISO()});
      persist(); renderDashboard(root); toast("Saved to Inbox");
    });
    $("#dashDictate").addEventListener("click", ()=>startDictation($("#dashQuick")));
    $$("[data-open-project]",root).forEach(el=>el.addEventListener("click",()=>{
      currentProjectId=el.dataset.openProject;currentView="project";render();
    }));
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
  function renderProject(root,id) {
    const p = projectById(id);
    if (!p) { currentView="dashboard";render();return; }
    p.sections = Array.isArray(p.sections) && p.sections.length ? p.sections : [...DEFAULT_SECTIONS];
    p.tasks = Array.isArray(p.tasks) ? p.tasks : [];

    const open = p.tasks.filter(t=>!t.done);
    const complete = p.tasks.filter(t=>t.done);
    const grouped = p.sections.map(section=>({section,tasks:open.filter(t=>t.section===section)})).filter(g=>g.tasks.length);
    const extraSections = [...new Set(open.map(t=>t.section).filter(s=>!p.sections.includes(s)))];
    extraSections.forEach(s=>grouped.push({section:s,tasks:open.filter(t=>t.section===s)}));

    root.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">${esc(p.name)}</h1>
          <p class="page-subtitle">${esc(p.summary||"No summary yet")}</p>
        </div>
        <div class="project-header-tools">
          <button class="button secondary" id="editProjectBtn">Edit project</button>
          <button class="button primary" id="addTaskBtn">＋ Add task</button>
        </div>
      </div>

      <div class="panel">
        <div class="form-grid">
          <div>
            <label class="field-label">Status</label>
            <div><span class="status-pill">${esc(p.status||"Idea")}</span></div>
          </div>
          <div>
            <label class="field-label">Priority</label>
            <div class="priority-${String(p.priority||"Normal").toLowerCase()}">${esc(p.priority||"Normal")}</div>
          </div>
          <div>
            <label class="field-label">Next action</label>
            <div>${esc(p.nextAction||"Not set")}</div>
          </div>
          <div>
            <label class="field-label">Deadline</label>
            <div>${p.deadline?dateOnly(p.deadline):"Not set"}</div>
          </div>
        </div>
        ${normalizeTags((p.tags||[]).join ? p.tags.join(",") : p.tags).length?`<hr class="sep"><div class="chips">${normalizeTags((p.tags||[]).join ? p.tags.join(",") : p.tags).map(t=>`<span class="chip">${esc(t)}</span>`).join("")}</div>`:""}
      </div>

      <div class="panel">
        <div class="panel-title-row">
          <h2 class="panel-title">☷ Tasks</h2><span class="spacer"></span>
          <button class="button ghost small" id="manageSectionsBtn">Manage sections</button>
        </div>
        ${open.length===0?`<div class="empty">No open tasks.</div>`:""}
        ${grouped.map(g=>`
          <div class="task-group">
            <div class="task-group-title">${esc(g.section)}</div>
            ${g.tasks.slice().sort(taskSort).map(t=>taskRowHTML(p,t)).join("")}
          </div>`).join("")}
        ${complete.length?`
          <details class="task-group">
            <summary class="task-group-title">Completed (${complete.length})</summary>
            ${complete.slice().sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt)).map(t=>taskRowHTML(p,t)).join("")}
          </details>`:""}
      </div>

      <div class="panel">
        <div class="panel-title-row">
          <h2 class="panel-title">▤ Project notes</h2><span class="spacer"></span>
          <button class="button secondary small" id="dictateNotesBtn">🎙 Dictate</button>
          <button class="button primary small" id="saveNotesBtn">Save notes</button>
        </div>
        <textarea id="projectNotes" class="field project-notes" placeholder="Meeting notes, observations, methods, ideas…">${esc(p.notes||"")}</textarea>
        <div class="dictation-hint">Dictation uses browser speech recognition when available; otherwise use the iPhone/Mac keyboard microphone.</div>
      </div>
    `;

    $("#addTaskBtn").addEventListener("click",()=>openTaskModal(p));
    $("#editProjectBtn").addEventListener("click",()=>openProjectModal(p));
    $("#manageSectionsBtn").addEventListener("click",()=>openSectionsModal(p));
    $("#saveNotesBtn").addEventListener("click",()=>{
      p.notes=$("#projectNotes").value;p.updatedAt=nowISO();persist();toast("Notes saved");
    });
    $("#dictateNotesBtn").addEventListener("click",()=>startDictation($("#projectNotes"), {append:true}));
    $$(".task-check",root).forEach(ch=>ch.addEventListener("change",()=>{
      const t=p.tasks.find(x=>x.id===ch.dataset.taskId); if(!t)return;
      t.done=ch.checked;t.updatedAt=nowISO();p.updatedAt=nowISO();persist();renderProject(root,p.id);
    }));
    $$("[data-edit-task]",root).forEach(btn=>btn.addEventListener("click",()=>{
      const t=p.tasks.find(x=>x.id===btn.dataset.editTask); if(t)openTaskModal(p,t);
    }));
    $$("[data-delete-task]",root).forEach(btn=>btn.addEventListener("click",()=>{
      const t=p.tasks.find(x=>x.id===btn.dataset.deleteTask); if(!t)return;
      if(confirm(`Delete "${t.title}"?`)){p.tasks=p.tasks.filter(x=>x.id!==t.id);p.updatedAt=nowISO();persist();renderProject(root,p.id);}
    }));
  }

  function taskSort(a,b) {
    const pr=priorityRank(a.priority)-priorityRank(b.priority);
    if(pr!==0)return pr;
    if(a.dueDate&&b.dueDate)return a.dueDate.localeCompare(b.dueDate);
    if(a.dueDate)return -1;if(b.dueDate)return 1;
    return new Date(a.createdAt)-new Date(b.createdAt);
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
    root.innerHTML=`
      ${searchSection("Projects",ps.map(p=>`<div class="project-card" data-open-project="${esc(p.id)}"><div class="row-title">${esc(p.name)}</div><div class="row-meta">${esc(p.summary||p.nextAction||"")}</div></div>`))}
      ${searchSection("Tasks",ts.map(x=>`<div class="project-card" data-open-project="${esc(x.p.id)}"><div class="row-title">${esc(x.t.title)}</div><div class="row-meta">${esc(x.p.name)} · ${esc(x.t.section)}</div></div>`))}
      ${searchSection("Inbox",ins.map(n=>`<div class="list-row"><div class="row-main"><div class="row-title">${esc(n.text)}</div></div></div>`))}
      ${ps.length+ts.length+ins.length===0?`<div class="panel"><div class="empty">No matches.</div></div>`:""}
    `;
    $$("[data-open-project]",root).forEach(el=>el.addEventListener("click",()=>{currentProjectId=el.dataset.openProject;currentView="project";render();}));
  }
  function searchSection(title,rows){return rows.length?`<div class="panel search-section"><div class="panel-title-row"><h2 class="panel-title">${esc(title)}</h2></div>${rows.join("")}</div>`:"";}

  // ---------- Settings / OneDrive ----------
  function renderSettings(root) {
    root.innerHTML=`
      <div class="page-header"><div><h1 class="page-title">Settings & Sync</h1><p class="page-subtitle">Local-first storage with optional OneDrive synchronization</p></div></div>
      <div class="settings-grid">
        <div>
          <div class="panel">
            <div class="panel-title-row"><h2 class="panel-title">OneDrive</h2></div>
            ${state.settings.syncEnabled?`
              <div class="success-box">Connected${state.settings.oneDriveAccount?` as <strong>${esc(state.settings.oneDriveAccount)}</strong>`:""}. ResearchFlow is configured to use the personal Microsoft account that owns your OneDrive.</div>
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

  const graphScopes=["Files.ReadWrite.AppFolder","User.Read"];

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
      inbox:state.inbox
    };
  }

  async function getRemotePayload() {
    await graph("/me/drive/special/approot");
    try{
      const contentRes=await graph(`/me/drive/special/approot:/${encodeURIComponent(CLOUD_FILE)}:/content`);
      return await contentRes.json();
    }catch(e){
      if(e.status===404)return null;
      throw e;
    }
  }

  async function pushToOneDrive({quiet=false}={}) {
    if(!state.settings.syncEnabled) throw new Error("OneDrive is not connected.");

    await graph("/me/drive/special/approot");

    const body=JSON.stringify(cloudPayload(),null,2);
    await graph(`/me/drive/special/approot:/${encodeURIComponent(CLOUD_FILE)}:/content`,{
      method:"PUT",
      headers:{"Content-Type":"application/json"},
      body
    });

    state.settings.lastSyncedAt=nowISO();
    state.settings.lastSyncError="";
    persist({touch:false,autosync:false});
    if(!quiet){render();toast("Synced to OneDrive");}
  }

  async function pullFromOneDrive({quiet=false}={}) {
    if(!state.settings.syncEnabled) throw new Error("OneDrive is not connected.");
    const remote=await getRemotePayload();
    if(!remote){ if(!quiet)toast("No OneDrive backup exists yet"); return false; }
    const merged=mergeCloudData(state,remote);
    state.projects=merged.projects;
    state.inbox=merged.inbox;
    state.modifiedAt=merged.modifiedAt;
    state.settings.lastSyncedAt=nowISO();
    state.settings.lastSyncError="";
    persist({touch:false,autosync:false});
    if(!quiet){render();toast("Pulled from OneDrive");}
    return true;
  }

  async function syncNow({quiet=false}={}) {
    if(!state.settings.syncEnabled) return;
    try{
      const remote=await getRemotePayload();
      if(remote){
        const merged=mergeCloudData(state,remote);
        state.projects=merged.projects;
        state.inbox=merged.inbox;
        state.modifiedAt=merged.modifiedAt;
        persist({touch:false,autosync:false});
      }
      await pushToOneDrive({quiet:true});
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

  function readableSyncError(e){
    const raw=String(e?.message||e||"Unknown sync error");

    let guidance="";
    if(e?.status===403 || /accessDenied|Authorization_RequestDenied|insufficient privileges/i.test(raw)){
      guidance=" Microsoft authenticated you, but Graph refused this operation. The exact Microsoft code/message above is needed to distinguish consent, account type, and App Folder service issues.";
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
    // Project-level last-write-wins. Task edits always touch their parent project's updatedAt.
    const pMap=new Map();
    for(const p of [...(remote.projects||[]),...(local.projects||[])]) {
      const old=pMap.get(p.id);
      if(!old || new Date(p.updatedAt||0) >= new Date(old.updatedAt||0)) pMap.set(p.id,p);
    }
    const iMap=new Map();
    for(const n of [...(remote.inbox||[]),...(local.inbox||[])]) {
      const old=iMap.get(n.id);
      if(!old || new Date(n.updatedAt||n.createdAt||0) >= new Date(old.updatedAt||old.createdAt||0)) iMap.set(n.id,n);
    }
    return {
      projects:[...pMap.values()],
      inbox:[...iMap.values()].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)),
      modifiedAt:new Date(Math.max(new Date(local.modifiedAt||0),new Date(remote.modifiedAt||0))).toISOString()
    };
  }

  // ---------- Modals ----------
  function openModal(title,bodyHTML,actionsHTML,onReady) {
    $("#modalTitle").textContent=title;
    $("#modalBody").innerHTML=bodyHTML;
    $("#modalActions").innerHTML=actionsHTML;
    const dlg=$("#modal");
    dlg.showModal();
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
      <div class="form-row"><label class="field-label">Next action</label><input class="field" id="mpNext" value="${esc(p.nextAction||"")}"></div>
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
          Object.assign(existing,{name,summary:$("#mpSummary").value.trim(),status:$("#mpStatus").value,priority:$("#mpPriority").value,nextAction:$("#mpNext").value.trim(),deadline:$("#mpDeadline").value,tags:normalizeTags($("#mpTags").value),updatedAt:nowISO()});
        }else{
          const np={id:uid(),name,summary:$("#mpSummary").value.trim(),status:$("#mpStatus").value,priority:$("#mpPriority").value,nextAction:$("#mpNext").value.trim(),deadline:$("#mpDeadline").value,tags:normalizeTags($("#mpTags").value),notes:"",sections:[...DEFAULT_SECTIONS],tasks:[],createdAt:nowISO(),updatedAt:nowISO()};
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

  function openTaskModal(p,existing=null) {
    const t=existing||{title:"",section:p.sections?.[0]||"General",priority:"Normal",dueDate:"",tags:[],notes:""};
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
      <div class="form-row"><label class="field-label">Task notes</label><textarea class="field" id="mtNotes">${esc(t.notes||"")}</textarea></div>
    `,`<button class="button secondary" type="button" id="cancelModalBtn">Cancel</button><button class="button primary" type="button" id="saveTaskBtn">${existing?"Save":"Add task"}</button>`,()=>{
      $("#cancelModalBtn").onclick=closeModal;
      $("#saveTaskBtn").onclick=()=>{
        const title=$("#mtTitle").value.trim();if(!title){toast("Task title is required");return;}
        if(existing){
          Object.assign(existing,{title,section:$("#mtSection").value,priority:$("#mtPriority").value,dueDate:$("#mtDue").value,tags:normalizeTags($("#mtTags").value),notes:$("#mtNotes").value.trim(),updatedAt:nowISO()});
        }else{
          p.tasks.push({id:uid(),title,section:$("#mtSection").value,priority:$("#mtPriority").value,dueDate:$("#mtDue").value,tags:normalizeTags($("#mtTags").value),notes:$("#mtNotes").value.trim(),done:false,createdAt:nowISO(),updatedAt:nowISO()});
        }
        p.updatedAt=nowISO();persist();closeModal();renderProject($("#content"),p.id);
      };
    });
  }

  function openSectionsModal(p) {
    const sections=p.sections||[...DEFAULT_SECTIONS];
    openModal("Manage task sections",`
      <div id="sectionList">${sections.map((s,i)=>`<div class="list-row"><div class="row-main"><input class="field section-input" data-index="${i}" value="${esc(s)}"></div><button type="button" class="row-button section-delete" data-index="${i}">Delete</button></div>`).join("")}</div>
      <div class="form-row" style="margin-top:14px"><input class="field" id="newSectionName" placeholder="New section name"></div>
      <button type="button" class="button secondary" id="addSectionBtn">＋ Add section</button>
    `,`<button class="button secondary" type="button" id="cancelModalBtn">Cancel</button><button class="button primary" type="button" id="saveSectionsBtn">Save</button>`,()=>{
      let work=[...sections];
      const redraw=()=>{closeModal();p.sections=work;openSectionsModal(p);};
      $("#cancelModalBtn").onclick=closeModal;
      $("#addSectionBtn").onclick=()=>{
        const s=$("#newSectionName").value.trim();if(!s)return;
        if(!work.includes(s))work.push(s);p.sections=work;redraw();
      };
      $$(".section-delete").forEach(b=>b.onclick=()=>{
        const idx=+b.dataset.index;
        const s=work[idx];
        if((p.tasks||[]).some(t=>t.section===s)){toast("Move or delete tasks in this section first");return;}
        work.splice(idx,1);p.sections=work;redraw();
      });
      $("#saveSectionsBtn").onclick=()=>{
        const names=$$(".section-input").map(x=>x.value.trim()).filter(Boolean);
        if(!names.length){toast("Keep at least one section");return;}
        p.sections=[...new Set(names)];p.updatedAt=nowISO();persist();closeModal();renderProject($("#content"),p.id);
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

  refreshNavigation();
  render();
  resumeMicrosoftRedirect().then(()=>{refreshNavigation();});
})();
