// =====================================================================
// DAYWISE — Frontend Application Controller (`frontend/app.js`)
// Implements:
// 1. Framer StretchType Interactive Physics Hero for "DAYWISE"
// 2. Character-by-Character Text Scramble Reveal for Headings
// 3. Auto-hiding sticky navbar on scroll down / reveal on scroll up
// 4. Two Top Tabs (HOME | DASHBOARD) & Sticky Stacking Cards
// 5. Google Calendar upcoming tasks data integration & OAuth flow
// 6. Photon SMS Staged Changes Final Approval Screen (`/approve/:batchId`)
// =====================================================================

const state = {
  currentView: "home", // "home" | "dashboard" | "approve"
  activeBatchId: null,
  calendarData: null,
  gcalSample: null,
  pendingProposals: [],
  allProposals: [],
  activeProposal: null,
  authStatus: null,
};

// =====================================================================
// Formatting & Notification Helpers
// =====================================================================
function formatShortTimeRange(startIso, endIso) {
  if (!startIso) return "Time TBD";
  try {
    const s = new Date(startIso);
    const e = endIso ? new Date(endIso) : null;
    const dayStr = s.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const sTime = s.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    if (!e || isNaN(e.getTime())) return `${dayStr} · ${sTime}`;
    const eTime = e.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `${dayStr} · ${sTime} – ${eTime}`;
  } catch {
    return String(startIso);
  }
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById("appToast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add("hidden");
  }, 4200);
}

// =====================================================================
// Text Scramble / Cipher Reveal Effect (Framer parity)
// =====================================================================
const CIPHER_CHARS = "+/F25Y9CXJ%=@&5L?0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function runScramble(element) {
  if (!element || element._scrambleRunning) return;
  const original = element.getAttribute("data-scramble") || element.innerText.trim();
  element._scrambleRunning = true;
  let frame = 0;
  const totalFrames = 26;

  clearInterval(element._scrambleTimer);
  element._scrambleTimer = setInterval(() => {
    frame++;
    const progress = frame / totalFrames;
    const lockedChars = Math.floor(progress * original.length);

    let output = original.slice(0, lockedChars);
    for (let i = lockedChars; i < original.length; i++) {
      const ch = original[i];
      if (ch === " " || ch === "\n") {
        output += ch;
      } else {
        output += CIPHER_CHARS[Math.floor(Math.random() * CIPHER_CHARS.length)];
      }
    }

    element.innerText = output;

    if (frame >= totalFrames) {
      clearInterval(element._scrambleTimer);
      element.innerText = original;
      element._scrambleRunning = false;
    }
  }, 26);
}

function initScrambleObserver() {
  const targets = document.querySelectorAll("[data-scramble]");
  if (!targets.length) return;

  const observer = new IntersectionObserver(
    entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          runScramble(entry.target);
        }
      });
    },
    { threshold: 0.25 }
  );

  targets.forEach(el => observer.observe(el));
}

// =====================================================================
// StretchType Interactive Physics Hero ("DAYWISE")
// Direct port of the Framer component code
// =====================================================================
function initStretchType() {
  const root = document.getElementById("daywiseStretchRoot");
  const svg = document.getElementById("daywiseStretchSvg");
  const group = document.getElementById("daywiseLettersGroup");
  const measurer = document.getElementById("daywiseMeasurer");
  const coordLabel = document.getElementById("daywiseCoordBadge");
  const clipRect = document.getElementById("daywiseClipRect");

  if (!root || !svg || !group || !measurer) return;

  const text = "DAYWISE";
  const chars = Array.from(text);
  const stretch = 0.75;
  const squeeze = 0.0;
  const reach = 21; // percentage of width
  const bounce = 0.8;
  const idle = true;
  const idleAmount = 0.12;
  const press = true;
  const coords = true;
  const introDelay = 0.2;

  let width = root.offsetWidth || 1104;
  let height = root.offsetHeight || 400;

  function falloff(distance, radius) {
    if (radius <= 0) return 0;
    const d = Math.min(1, Math.max(0, distance / radius));
    const inv = 1 - d;
    return inv * inv * (3 - 2 * inv);
  }

  function measureLetters() {
    width = root.offsetWidth || 1104;
    height = root.offsetHeight || 400;

    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    if (clipRect) {
      clipRect.setAttribute("x", `${-width}`);
      clipRect.setAttribute("y", `${-height * 3}`);
      clipRect.setAttribute("width", `${width * 3}`);
      clipRect.setAttribute("height", `${height * 4}`);
    }

    let total = 0;
    const starts = [];
    const widths = [];

    measurer.style.fontSize = "100px";
    measurer.style.fontFamily = '"Anton", Impact, sans-serif';

    try {
      total = measurer.getComputedTextLength();
      for (let i = 0; i < chars.length; i++) {
        const box = measurer.getExtentOfChar(i);
        starts.push(box.x);
        widths.push(box.width);
      }
    } catch {
      total = 400;
      for (let i = 0; i < chars.length; i++) {
        starts.push(i * 57);
        widths.push(57);
      }
    }

    let cap = 74;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.font = '400 100px "Anton", sans-serif';
      const m = ctx.measureText(text);
      if (m.actualBoundingBoxAscent > 0) cap = m.actualBoundingBoxAscent;
    }

    const widthFit = (width / total) * 100;
    const heightFit = height / ((cap / 100) * (1 + stretch * 0.85));
    const fontSize = Math.max(16, Math.min(widthFit, heightFit));
    const k = fontSize / 100;
    const offset = (width - total * k) / 2;

    const positions = chars.map((_, i) => {
      const x = offset + starts[i] * k;
      return { x, cx: x + (widths[i] * k) / 2 };
    });

    group.style.fontSize = `${fontSize}px`;
    group.innerHTML = "";

    const letterNodes = chars.map((char, i) => {
      const node = document.createElementNS("http://www.w3.org/2000/svg", "text");
      node.textContent = char;
      node.setAttribute("x", positions[i].x);
      node.setAttribute("y", height);
      node.style.whiteSpace = "pre";
      group.appendChild(node);
      return node;
    });

    return {
      fontSize,
      positions,
      cap: cap * k,
      reachPx: (width * reach) / 100,
      letterNodes,
    };
  }

  let layout = measureLetters();

  // ResizeObserver for responsive stretching
  const ro = new ResizeObserver(() => {
    layout = measureLetters();
  });
  ro.observe(root);

  // Pointer tracking
  const pointer = { x: -1e6, y: -1e6, time: 0, pressed: 0 };
  function onPointerMove(e) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.time = performance.now();
  }
  function onPointerDown(e) {
    onPointerMove(e);
    pointer.pressed = performance.now();
  }
  function onPointerLeave() {
    pointer.time = 0;
  }

  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerdown", onPointerDown, { passive: true });
  document.documentElement.addEventListener("mouseleave", onPointerLeave);

  // Spring physics loop
  const springs = chars.map(() => ({ s: 0, v: 0 }));
  const startedAt = performance.now() + introDelay * 1000;
  const stiffness = 170;
  const damping = 30 * (1 - Math.min(1, Math.max(0, bounce)) * 0.65);
  let last = performance.now();
  let lastPress = 0;
  let squashUntil = 0;

  function pad(n) {
    return String(Math.round(n)).padStart(4, "0");
  }

  function frameLoop(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;

    if (!layout || !layout.letterNodes.length) {
      requestAnimationFrame(frameLoop);
      return;
    }

    const rect = root.getBoundingClientRect();
    const scale = root.offsetWidth ? rect.width / root.offsetWidth || 1 : 1;
    const localX = (pointer.x - rect.left) / scale;
    const localY = (pointer.y - rect.top) / scale;
    const recent = now - pointer.time < 2500;
    const outside = Math.max(0, -localY, localY - height, -localX, localX - width);
    const presence = recent ? falloff(outside, 140) : 0;
    const pressed = press && pointer.pressed !== lastPress && presence > 0;
    lastPress = pointer.pressed;

    if (pressed) squashUntil = now + 170;
    const squashing = now < squashUntil;

    for (let i = 0; i < chars.length; i++) {
      const spring = springs[i];
      const pos = layout.positions[i];
      if (!pos) continue;

      const pull = falloff(Math.abs(localX - pos.cx), layout.reachPx) * presence;
      const wave = idle ? idleAmount * (0.5 + 0.5 * Math.sin(now / 620 - i * 0.75)) * (1 - presence) : 0;
      const target = squashing ? -0.42 * (pull + 0.25) : Math.max(pull, wave);

      if (pressed) spring.v -= 9 * (pull + 0.2);
      spring.v += (stiffness * (target - spring.s) - damping * spring.v) * dt;
      spring.s = Math.max(-0.45, Math.min(1.6, spring.s + spring.v * dt));

      const tIntro = Math.min(1, Math.max(0, (now - startedAt - i * 75) / 750));
      const lift = (1 - (1 - Math.pow(1 - tIntro, 3))) * layout.cap * 1.2;

      const sy = 1 + stretch * spring.s;
      const sx = 1 - squeeze * spring.s;
      const matrix = `matrix(${sx} 0 0 ${sy} ${pos.cx - sx * pos.cx} ${height - sy * height + lift})`;
      layout.letterNodes[i]?.setAttribute("transform", matrix);
    }

    if (coordLabel) {
      if (coords && presence > 0.5 && outside === 0) {
        coordLabel.style.opacity = "1";
        coordLabel.style.transform = `translate(${localX + 16}px, ${localY + 14}px)`;
        coordLabel.textContent = `X ${pad(localX)} · Y ${pad(localY)}`;
      } else {
        coordLabel.style.opacity = "0";
      }
    }

    requestAnimationFrame(frameLoop);
  }

  requestAnimationFrame(frameLoop);
}

// =====================================================================
// View & Router Management
// =====================================================================
function setView(viewName, options = {}) {
  state.currentView = viewName;
  if (options.batchId !== undefined) {
    state.activeBatchId = options.batchId;
  }

  const views = {
    home: document.getElementById("viewHome"),
    dashboard: document.getElementById("viewDashboard"),
    approve: document.getElementById("viewApprove"),
  };

  Object.entries(views).forEach(([k, el]) => {
    if (!el) return;
    if (k === viewName) {
      el.classList.remove("hidden");
      el.classList.add("active");
    } else {
      el.classList.add("hidden");
      el.classList.remove("active");
    }
  });

  const tabHome = document.getElementById("tabHome");
  const tabDashboard = document.getElementById("tabDashboard");
  [tabHome, tabDashboard].forEach(btn => btn?.classList.remove("active-navy"));

  if (viewName === "home") {
    tabHome?.classList.add("active-navy");
  } else {
    tabDashboard?.classList.add("active-navy");
  }

  if (!options.skipHistory) {
    let targetUrl = "/";
    if (viewName === "dashboard") targetUrl = "/dashboard";
    else if (viewName === "approve") {
      targetUrl = state.activeBatchId ? `/approve/${encodeURIComponent(state.activeBatchId)}` : "/approve";
    }
    if (window.location.pathname !== targetUrl) {
      window.history.pushState({ viewName, batchId: state.activeBatchId }, "", targetUrl);
    }
  }

  window.scrollTo({ top: 0, behavior: "smooth" });

  if (viewName === "dashboard") {
    void refreshAllData();
  } else if (viewName === "approve") {
    void loadApprovalView(state.activeBatchId);
  }

  // Trigger scramble on visible headings in the newly active view
  setTimeout(() => {
    const activeView = views[viewName];
    if (activeView) {
      activeView.querySelectorAll("[data-scramble]").forEach(el => runScramble(el));
    }
  }, 100);
}

function handleInitialRoute() {
  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);

  if (params.get("oauth") === "connected") {
    showToast("Connected to Google Calendar via OAuth 2.0!");
  }

  if (path.startsWith("/approve/")) {
    const batchId = decodeURIComponent(path.replace("/approve/", "").replace(/\/+$/, ""));
    setView("approve", { batchId, skipHistory: true });
  } else if (path === "/approve") {
    setView("approve", { batchId: null, skipHistory: true });
  } else if (path === "/dashboard" || path === "/calendar") {
    setView("dashboard", { skipHistory: true });
  } else {
    setView("home", { skipHistory: true });
  }
}

// =====================================================================
// Data Fetching & Synchronization
// =====================================================================
async function refreshAllData() {
  try {
    const [calResp, gcalResp, propResp, authResp] = await Promise.all([
      fetch("/api/calendar").catch(() => null),
      fetch("/api/google-calendar/today").catch(() => null),
      fetch("/api/calendar/proposals/pending?include_all=true").catch(() => null),
      fetch("/api/auth/status").catch(() => null),
    ]);

    if (calResp && calResp.ok) {
      state.calendarData = await calResp.json();
    }
    if (gcalResp && gcalResp.ok) {
      state.gcalSample = await gcalResp.json();
    }
    if (propResp && propResp.ok) {
      const pJson = await propResp.json();
      state.allProposals = pJson.proposals || [];
      state.pendingProposals = state.allProposals.filter(
        p => p.status === "pending" || p.status === "modified"
      );
    }
    if (authResp && authResp.ok) {
      state.authStatus = await authResp.json();
    }

    renderNavBadges();
    renderDashboard();
  } catch (err) {
    console.warn("Refresh warning:", err);
  }
}

function renderNavBadges() {
  const pendingCount = state.pendingProposals.length;
  const pill = document.getElementById("navPendingPill");
  const countText = document.getElementById("navPendingCountText");
  if (pill && countText) {
    if (pendingCount > 0) {
      pill.classList.remove("hidden");
      countText.textContent = `${pendingCount} STAGED APPROVAL${pendingCount > 1 ? "S" : ""}`;
    } else {
      pill.classList.add("hidden");
    }
  }
}

// =====================================================================
// Dashboard Rendering (Decluttered: Upcoming Tasks from Google Calendar)
// =====================================================================
function renderDashboard() {
  const cal = state.calendarData || {};
  const gcal = state.gcalSample || {};

  // 1. Staged Proposal Banner (only visible if Photon SMS approval batch is pending)
  const banner = document.getElementById("dashStagedBanner");
  const bannerTitle = document.getElementById("dashStagedTitle");
  const bannerSub = document.getElementById("dashStagedSub");
  if (banner) {
    if (state.pendingProposals.length > 0) {
      const latest = state.pendingProposals[state.pendingProposals.length - 1];
      banner.classList.remove("hidden");
      if (bannerTitle) {
        bannerTitle.textContent = `${state.pendingProposals.length} Staged Proposal Batch (${latest.batch_id}) Awaiting Approval`;
      }
      if (bannerSub) {
        bannerSub.textContent = latest.summary_message || "Click to review and approve your proposed changes.";
      }
      banner.dataset.batchId = latest.batch_id;
    } else {
      banner.classList.add("hidden");
    }
  }

  // 2. Upcoming Tasks List pulled from Google Calendar Integration Data
  const eventsListEl = document.getElementById("todayGoogleEventsList");
  const eventsBadgeEl = document.getElementById("todayEventsCountBadge");
  const dateSubLabelEl = document.getElementById("dashDateSubLabel");
  const footerLabelEl = document.getElementById("dashCalendarFooterLabel");

  const gcalTasks =
    Array.isArray(gcal.upcoming_tasks) && gcal.upcoming_tasks.length > 0
      ? gcal.upcoming_tasks
      : Array.isArray(gcal.today_events_sample) && gcal.today_events_sample.length > 0
        ? gcal.today_events_sample
        : [...(cal.events || []), ...(cal.scheduled_blocks || cal.blocks || [])];

  const sampleTasks = gcalTasks.slice(0, 6);

  if (eventsBadgeEl) {
    eventsBadgeEl.textContent = `${sampleTasks.length} UPCOMING`;
  }
  if (dateSubLabelEl) {
    const calName = gcal.user?.calendar_name || "GOOGLE CALENDAR SAMPLE";
    dateSubLabelEl.textContent = calName.toUpperCase();
  }
  if (footerLabelEl) {
    const calIdShort = (gcal.calendar_id || state.authStatus?.calendar_id || "GOOGLE CALENDAR").slice(0, 36);
    footerLabelEl.textContent = `PULLED FROM GOOGLE CALENDAR INTEGRATION · ${calIdShort}`;
  }

  if (eventsListEl) {
    if (sampleTasks.length === 0) {
      eventsListEl.innerHTML = `
        <div class="upcoming-task-row">
          <div class="upcoming-task-left">
            <div class="upcoming-task-title">No upcoming tasks found for today</div>
            <div class="upcoming-task-time">Connected to Google Calendar integration</div>
          </div>
          <span class="upcoming-task-badge">ALL CLEAR</span>
        </div>
      `;
    } else {
      eventsListEl.innerHTML = sampleTasks
        .map(task => {
          const badgeText = task.recommended_location
            ? `STUDY · ${String(task.recommended_location).toUpperCase()}`
            : task.source === "google_calendar_live"
              ? "GOOGLE CALENDAR LIVE"
              : "GOOGLE CALENDAR";
          return `
            <div class="upcoming-task-row">
              <div class="upcoming-task-left">
                <div class="upcoming-task-title">${escapeHtml(task.title)}</div>
                <div class="upcoming-task-time">${escapeHtml(formatShortTimeRange(task.start_time, task.end_time))}</div>
              </div>
              <span class="upcoming-task-badge">${escapeHtml(badgeText)}</span>
            </div>
          `;
        })
        .join("");
    }
  }
}

// =====================================================================
// Final Approval Screen (`/approve/:batchId` and `/approve`)
// =====================================================================
async function loadApprovalView(batchId) {
  await refreshAllData();

  let targetProposal = null;
  if (batchId) {
    try {
      const resp = await fetch(`/api/calendar/proposals/${encodeURIComponent(batchId)}`);
      if (resp.ok) {
        const data = await resp.json();
        targetProposal = data.proposal;
      }
    } catch {}
  }

  if (!targetProposal) {
    targetProposal =
      state.pendingProposals[state.pendingProposals.length - 1] ||
      state.allProposals[state.allProposals.length - 1] ||
      null;
  }

  state.activeProposal = targetProposal;
  if (targetProposal) {
    state.activeBatchId = targetProposal.batch_id;
  }

  renderApprovalScreen();
}

function formatOperationDiffDetails(op) {
  const opType = op.op_type || op.operation_type || "CREATE_EVENT";
  const before = op.before_state;
  const after = op.after_state;

  let beforeHtml = `<span style="opacity:0.75;">None (New Calendar Addition)</span>`;
  if (before) {
    const bTitle = before.title || before.assignment_id_or_title || before.id || "Existing Item";
    const bTime = before.start_time
      ? formatShortTimeRange(before.start_time, before.end_time)
      : before.due_date
        ? `Due: ${formatShortTimeRange(before.due_date, null)}`
        : "Current Schedule State";
    beforeHtml = `<strong>${escapeHtml(bTitle)}</strong><br/><span>${escapeHtml(bTime)}</span>`;
  }

  let afterHtml = `<span style="opacity:0.75;">Removed from Calendar</span>`;
  if (opType === "SPLIT_OR_RESCHEDULE_BLOCK" && after) {
    const chunks = after.proposed_chunks || after.chunks || [];
    afterHtml = chunks
      .map(
        ch =>
          `<div style="margin-bottom:4px;"><strong>${escapeHtml(ch.title)}</strong>: ${escapeHtml(
            formatShortTimeRange(ch.start_time, ch.end_time)
          )} @ <em>${escapeHtml((ch.recommended_location || ch.location || "desk").toUpperCase())}</em></div>`
      )
      .join("");
  } else if (opType === "UPDATE_DEADLINE" && after) {
    afterHtml = `<strong>${escapeHtml(after.assignment_id_or_title || after.title || "Assignment")}</strong><br/>New Due Date: ${escapeHtml(
      formatShortTimeRange(after.new_due_date || after.due_date, null)
    )} (Auto-rebalance blocks: YES)`;
  } else if (after) {
    const aTitle = after.title || "Scheduled Event";
    const aTime = formatShortTimeRange(after.start_time, after.end_time);
    const aLoc = (after.recommended_location || after.location || "library").toUpperCase();
    const reward = after.predicted_reward ? ` · ${Number(after.predicted_reward).toFixed(1)}★` : "";
    afterHtml = `<strong>${escapeHtml(aTitle)}</strong><br/><span>${escapeHtml(aTime)}</span><br/><span>Location: <strong>${escapeHtml(aLoc)}${reward}</strong></span>`;
  }

  return { opType, beforeHtml, afterHtml };
}

function renderApprovalScreen() {
  const container = document.getElementById("approvalContentContainer");
  const selectorBar = document.getElementById("batchSelectorBar");
  const metaIdEl = document.getElementById("approveBatchMetaId");
  const conflictBadge = document.getElementById("auditConflictBadge");
  const burnoutBadge = document.getElementById("auditBurnoutBadge");

  if (!container) return;

  if (selectorBar) {
    if (state.allProposals.length > 1) {
      selectorBar.innerHTML = state.allProposals
        .slice(-5)
        .reverse()
        .map(p => {
          const isAct = p.batch_id === state.activeProposal?.batch_id;
          return `
            <button class="batch-tab-btn ${isAct ? "active" : ""}" data-select-batch="${escapeHtml(p.batch_id)}">
              ${escapeHtml(p.batch_id)} (${escapeHtml(p.status.toUpperCase())})
            </button>
          `;
        })
        .join("");

      selectorBar.querySelectorAll("[data-select-batch]").forEach(btn => {
        btn.addEventListener("click", () => {
          const bId = btn.getAttribute("data-select-batch");
          setView("approve", { batchId: bId });
        });
      });
    } else {
      selectorBar.innerHTML = "";
    }
  }

  const proposal = state.activeProposal;
  if (!proposal) {
    if (metaIdEl) metaIdEl.textContent = "NO PENDING BATCH";
    container.innerHTML = `
      <div class="panel-card panel-navy">
        <span class="panel-eyebrow">STAGED APPROVAL QUEUE</span>
        <h2 class="panel-title" style="margin-bottom:12px;">NO STAGED CHANGES WAITING RIGHT NOW</h2>
        <p class="panel-helper-text">
          Text an action to Photon (e.g., "Push my ML Project study block to tomorrow night") to generate a staged approval batch.
        </p>
        <button class="get-started-btn" id="btnEmptyGoDash">
          <span>GO TO DASHBOARD</span>
          <span>&rarr;</span>
        </button>
      </div>
    `;
    document.getElementById("btnEmptyGoDash")?.addEventListener("click", () => setView("dashboard"));
    return;
  }

  if (metaIdEl) {
    metaIdEl.textContent = `${proposal.batch_id} · ${proposal.status.toUpperCase()}`;
  }

  const audit = proposal.veyzl_audit || { conflict_free: true, burnout_safe: true };
  if (conflictBadge) {
    conflictBadge.className = `audit-pill ${audit.conflict_free ? "ok" : "warn"}`;
    conflictBadge.textContent = audit.conflict_free ? "✓ CONFLICT-FREE" : "⚠ OVERLAP DETECTED";
  }
  if (burnoutBadge) {
    burnoutBadge.className = `audit-pill ${audit.burnout_safe ? "ok" : "warn"}`;
    burnoutBadge.textContent = audit.burnout_safe ? "✓ BURNOUT-SAFE" : "⚠ DAILY CAP WARNING";
  }

  const approvalUrl = `${window.location.origin}/approve/${proposal.batch_id}`;
  const isAlreadyResolved = proposal.status === "approved" || proposal.status === "rejected";

  const operationsHtml = (proposal.operations || [])
    .map((op, index) => {
      const opId = op.proposal_id || op.operation_id || `op_${index}`;
      const { opType, beforeHtml, afterHtml } = formatOperationDiffDetails(op);
      const checkedAttr = op.status !== "rejected" ? "checked" : "";
      const disabledAttr = isAlreadyResolved ? "disabled" : "";
      const warnFlags = [];
      if (op.has_conflict) warnFlags.push(`⚠ Conflict with ${op.conflict_with || "existing event"}`);
      if (op.exceeds_daily_cap) warnFlags.push(`⚠ Exceeds 4h daily study cap`);

      return `
        <div class="op-diff-card">
          <div class="op-diff-top">
            <label class="op-check-label">
              <input type="checkbox" class="op-checkbox" data-op-id="${escapeHtml(opId)}" ${checkedAttr} ${disabledAttr} />
              <span>ACTION #${index + 1} &middot; ${escapeHtml(opId)}</span>
            </label>
            <div style="display:flex;gap:8px;align-items:center;">
              ${warnFlags.map(w => `<span class="audit-pill warn">${escapeHtml(w)}</span>`).join("")}
              <span class="op-type-badge ${escapeHtml(opType)}">${escapeHtml(opType)}</span>
            </div>
          </div>

          <div class="diff-comparison-grid">
            <div class="diff-box diff-box-before">
              <span class="diff-box-label">&minus; BEFORE STATE</span>
              <div>${beforeHtml}</div>
            </div>
            <div class="diff-box diff-box-after">
              <span class="diff-box-label">&plus; PROPOSED AFTER STATE</span>
              <div>${afterHtml}</div>
            </div>
          </div>

          <div class="op-reasoning-bar">
            <strong>LLM &amp; LinUCB Reasoning:</strong> ${escapeHtml(op.reasoning || "Optimized for your circadian rhythm and workspace preferences.")}
          </div>
        </div>
      `;
    })
    .join("");

  container.innerHTML = `
    <div class="approval-summary-card">
      <div class="approval-summary-meta">
        <span>PHOTON SMS LINK: <strong>${escapeHtml(approvalUrl)}</strong></span>
        <span>SOURCE: <strong>${escapeHtml((proposal.source || "user_chat").toUpperCase())}</strong> &middot; STATUS: <strong>${escapeHtml(proposal.status.toUpperCase())}</strong></span>
      </div>
      <div class="approval-summary-quote">
        "${escapeHtml(proposal.summary_message)}"
      </div>
    </div>

    <div class="operations-diff-list">
      ${operationsHtml}
    </div>

    <div class="approval-actions-footer">
      ${
        isAlreadyResolved
          ? `
            <div style="font-family:var(--font-mono);font-size:14px;color:#6ee7b7;">
              ✓ This proposal batch has already been <strong>${escapeHtml(proposal.status.toUpperCase())}</strong>.
            </div>
            <button class="approve-all-btn" id="btnReturnToDashAfterApprove">
              <span>VIEW UPDATED DASHBOARD</span>
              <span>&rarr;</span>
            </button>
          `
          : `
            <button class="reject-batch-btn" id="btnRejectBatch">
              &times; REJECT &amp; ADJUST RHYTHM
            </button>
            <button class="approve-all-btn" id="btnApproveBatch">
              <span>APPROVE SELECTED (${(proposal.operations || []).length}) &amp; SYNC TO GOOGLE CALENDAR</span>
              <span>&rarr;</span>
            </button>
          `
      }
    </div>
  `;

  document.getElementById("btnReturnToDashAfterApprove")?.addEventListener("click", () => {
    setView("dashboard");
  });

  document.getElementById("btnApproveBatch")?.addEventListener("click", async () => {
    const checkedBoxes = Array.from(container.querySelectorAll(".op-checkbox:checked"));
    const selectedIds = checkedBoxes.map(cb => cb.getAttribute("data-op-id")).filter(Boolean);
    if (selectedIds.length === 0) {
      showToast("Select at least one operation to approve, or click Reject.");
      return;
    }
    await handleApproveProposalBatch(proposal.batch_id, selectedIds);
  });

  document.getElementById("btnRejectBatch")?.addEventListener("click", async () => {
    await handleRejectProposalBatch(proposal.batch_id);
  });
}

async function handleApproveProposalBatch(batchId, proposalIds) {
  const btn = document.getElementById("btnApproveBatch");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span>COMMITTING &amp; SYNCING TO GOOGLE CALENDAR...</span>`;
  }
  try {
    const resp = await fetch(`/api/calendar/proposals/${encodeURIComponent(batchId)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposal_ids: proposalIds }),
    });
    if (resp.ok) {
      showToast(`Approved ${batchId}! Changes committed & synced with Google Calendar.`);
      await loadApprovalView(batchId);
    } else {
      showToast("Could not approve batch. Please try again.");
    }
  } catch {
    showToast("Network error while approving batch.");
  }
}

async function handleRejectProposalBatch(batchId) {
  try {
    const resp = await fetch(`/api/calendar/proposals/${encodeURIComponent(batchId)}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "User rejected staged changes on Final Approval Screen" }),
    });
    if (resp.ok) {
      showToast(`Rejected ${batchId}. Rhythm learner updated to avoid those slots.`);
      await loadApprovalView(batchId);
    } else {
      showToast("Error rejecting batch.");
    }
  } catch {
    showToast("Error rejecting batch.");
  }
}

// =====================================================================
// Event Listeners & Auto-Hiding Navbar
// =====================================================================
function setupEventListeners() {
  // Top Navigation Tabs (HOME | DASHBOARD)
  document.getElementById("tabHome")?.addEventListener("click", () => setView("home"));
  document.getElementById("tabDashboard")?.addEventListener("click", () => setView("dashboard"));

  document.getElementById("navPendingPill")?.addEventListener("click", () => {
    const latest = state.pendingProposals[state.pendingProposals.length - 1];
    setView("approve", { batchId: latest?.batch_id || null });
  });

  document.getElementById("btnOpenApprovalFromBanner")?.addEventListener("click", () => {
    const banner = document.getElementById("dashStagedBanner");
    const batchId = banner?.dataset.batchId || state.pendingProposals[state.pendingProposals.length - 1]?.batch_id;
    setView("approve", { batchId });
  });

  document.getElementById("btnBackToDashboard")?.addEventListener("click", () => setView("dashboard"));
  document.getElementById("btnRefreshDashboard")?.addEventListener("click", async () => {
    showToast("Syncing upcoming tasks from Google Calendar integration...");
    await refreshAllData();
  });

  // GET STARTED -> Open Google OAuth Modal
  const oauthModal = document.getElementById("oauthModalBackdrop");
  document.getElementById("btnGetStarted")?.addEventListener("click", () => {
    oauthModal?.classList.remove("hidden");
  });
  document.getElementById("btnCloseOauthModal")?.addEventListener("click", () => {
    oauthModal?.classList.add("hidden");
  });

  // Continue with Google OAuth button
  document.getElementById("btnGoogleSignIn")?.addEventListener("click", async () => {
    const btn = document.getElementById("btnGoogleSignIn");
    if (btn) btn.querySelector("span").textContent = "CONNECTING GOOGLE CALENDAR...";
    try {
      await fetch("/api/auth/google/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "UW Student (Daywise)", email: "student@uw.edu" }),
      });
    } catch {}
    oauthModal?.classList.add("hidden");
    if (btn) btn.querySelector("span").textContent = "CONTINUE WITH GOOGLE";
    showToast("Signed in with Google OAuth! Pulling upcoming tasks...");
    setView("dashboard");
  });

  document.getElementById("btnGoogleRedirectFlow")?.addEventListener("click", async () => {
    try {
      const resp = await fetch("/api/auth/google/url");
      if (resp.ok) {
        const data = await resp.json();
        if (data.auth_url) {
          window.location.href = data.auth_url;
          return;
        }
      }
    } catch {}
    oauthModal?.classList.add("hidden");
    setView("dashboard");
  });

  // Auto-hiding navbar on scroll down / reveal on scroll up
  let lastScrollY = window.scrollY;
  const navbar = document.getElementById("topNavBar");

  window.addEventListener(
    "scroll",
    () => {
      const currentY = window.scrollY;
      if (navbar) {
        if (currentY > 76 && currentY > lastScrollY) {
          navbar.classList.add("nav-hidden");
        } else {
          navbar.classList.remove("nav-hidden");
        }
      }
      lastScrollY = currentY;
    },
    { passive: true }
  );

  window.addEventListener("popstate", () => {
    handleInitialRoute();
  });
}

// =====================================================================
// App Initialization
// =====================================================================
document.addEventListener("DOMContentLoaded", () => {
  setupEventListeners();
  initStretchType();
  initScrambleObserver();
  handleInitialRoute();
  void refreshAllData();
});
