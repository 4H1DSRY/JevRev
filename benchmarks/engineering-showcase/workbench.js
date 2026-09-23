const state = { selected: "tenant", data: null };
const byId = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const shortHash = (value) => `${value.slice(0, 12)}…${value.slice(-8)}`;

function summary(data) {
  const baselineFailures = Object.values(data.scenarios.baseline).filter((result) => !result.passed).length;
  const repairedPasses = Object.values(data.scenarios.repaired).filter((result) => result.passed).length;
  byId("summary").innerHTML = `
    <div class="summary-item fail"><span class="metric-label">BASELINE · LIVE REPLAY</span><strong>${baselineFailures} / 3 failed</strong><small>Tenant isolation + concurrent delivery</small></div>
    <div class="summary-item pass"><span class="metric-label">REPAIR · LIVE REPLAY</span><strong>${repairedPasses} / 3 passed</strong><small>Same executable contract</small></div>
    <div class="summary-item neutral"><span class="metric-label">JEVLOOP · CAPTURED AUDIT</span><strong>Completed</strong><small>${data.audit.outcomes.length} rounds, final round fresh</small></div>
    <div class="summary-item neutral"><span class="metric-label">JEVLONG · OBSERVER</span><strong>${data.audit.long_events} events</strong><small>Verified Loop audits, read only</small></div>`;
}

function scenarioBody(result, id) {
  if (id === "tenant") {
    const rows = result.deliveries.map((item) => `<tr><td>${escapeHtml(item.tenant)}</td><td><code>${escapeHtml(item.eventId)}</code></td><td><code>${escapeHtml(item.expected)}</code></td><td class="${item.passed ? "good" : "error"}"><code>${escapeHtml(item.observed)}</code></td></tr>`).join("");
    const bad = result.deliveries.find((item) => !item.passed);
    return `<table class="delivery-table"><thead><tr><th>TENANT</th><th>EVENT ID</th><th>EXPECTED</th><th>RETURNED</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="detail-box ${bad ? "error" : "success"}">${bad
        ? `South receives North's result for the same event ID. The cache key omitted tenant identity.`
        : `North and South receive independent results. The cache key includes tenant identity.`}</div>`;
  }
  if (id === "race") {
    return `<div class="mini-grid"><div><span>CONCURRENT DELIVERIES</span><strong>2</strong></div><div><span>HANDLER EXECUTIONS</span><strong class="${result.passed ? "good" : "bad"}">${result.calls}</strong></div></div>
      <div class="detail-box ${result.passed ? "success" : "error"}">${result.passed
        ? `Both deliveries shared one in-flight promise. Both returned <code>accepted</code>.`
        : `Both deliveries entered the handler before completion was cached. The side effect ran twice.`}</div>`;
  }
  return `<div class="retry-flow"><span>attempt 1 · rejected</span><span class="arrow">→</span><span>attempt 2 · ${escapeHtml(result.second)}</span></div>
    <div class="detail-box success">A failure does not get stored as a completed event. Handler executions: ${result.calls}.</div>`;
}

function panel(data, revision, id) {
  const result = data.scenarios[revision][id];
  const isBaseline = revision === "baseline";
  const title = isBaseline ? "Before · baseline" : "After · repaired";
  return `<article class="revision-panel ${result.passed ? "passed" : "failed"}"><div class="panel-head"><div><div class="panel-kicker">${isBaseline ? "CANDIDATE 00" : "CANDIDATE 01"}</div><div class="panel-title">${title}</div></div><span class="outcome ${result.passed ? "pass" : "fail"}">${result.passed ? "PASS" : "FAIL"}</span></div>
    <div class="revision">SOURCE SHA-256 &nbsp; ${escapeHtml(shortHash(data.source_sha256[revision]))}</div><div class="panel-body">${scenarioBody(result, id)}</div></article>`;
}

function comparison(data) {
  byId("comparison").innerHTML = panel(data, "baseline", state.selected) + panel(data, "repaired", state.selected);
  for (const tab of document.querySelectorAll(".tab")) {
    const selected = tab.dataset.case === state.selected;
    tab.classList.toggle("selected", selected);
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected) byId("comparison").setAttribute("aria-labelledby", tab.id);
  }
}

function audit(data) {
  const labels = ["Fix regression", "Request verification", "Completed"];
  byId("audit-route").innerHTML = data.audit.outcomes.map((outcome, index) => `<div class="audit-step"><div class="topline"><span>ROUND ${String(index + 1).padStart(2, "0")}</span><span>${index === 2 ? "FULL CHECK" : "PROGRESS"}</span></div><strong>${labels[index] ?? escapeHtml(outcome)}</strong></div>`).join("");
}

async function replay() {
  const button = byId("replay");
  button.disabled = true;
  byId("live-state").textContent = "Executing fixture…";
  try {
    const response = await fetch("/api/replay", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.data = data;
    summary(data);
    comparison(data);
    audit(data);
    byId("live-state").textContent = "LIVE REPLAY · COMPLETE";
  } catch (error) {
    byId("live-state").textContent = `Replay failed: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

const tabs = [...document.querySelectorAll(".tab")];
for (const [index, tab] of tabs.entries()) {
  tab.id = `scenario-tab-${tab.dataset.case}`;
  tab.setAttribute("aria-controls", "comparison");
  tab.addEventListener("click", () => {
    state.selected = tab.dataset.case;
    if (state.data) comparison(state.data);
  });
  tab.addEventListener("keydown", (event) => {
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
      : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length
        : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    tabs[next].click();
    tabs[next].focus();
  });
}
byId("replay").addEventListener("click", replay);
replay();
