// PAI Self-Assessment — deaktiviert
// Reaktivierung: Script einbinden +
// Nav-Button in index.html
// einkommentieren.
// Stand: 17. April 2026

// ══════════════════════════════════════════════════════════════════════════
// PAI SELF-ASSESSMENT  ·  DEAKTIVIERT (2026-04-17)
// ══════════════════════════════════════════════════════════════════════════
// Survey-Logik in den zusammengeführten PAI-Tab migriert (Phase 0–4).
// Code + Backend-Routen bleiben intakt für späteren Survey-Modus.
// Kein Nav-Entry, kein Landing-Entry → initPAIAuditTab() wird nicht mehr aufgerufen.
// Bei Reaktivierung: Nav-Button in appTabNav wieder einkommentieren.
// ——————————————————————————————————————————————————————————————————————————
// Parallel zum PAI Interview. Eigener Tab (modul4), eigene Sessions (tool_type='audit').
// Nutzt dieselben Backend-Routen für Sessions und Erhebung (pai_sessions, pai_erhebung)
// via flexibles Key-Value. Eigene data-Attribute (data-pai-audit-feld / data-pai-audit-phase)
// verhindern Kollision mit dem bestehenden Interview-Auto-Save.
let currentPaiAuditSession = null;
let paiAuditPhase = 0;
let paiAuditAnswers = {};   // key: "phase_feld" → wert
let paiAuditAnalysis = null; // ADA-Ergebnis: { l2_signal, hypothesen[], interview_empfehlungen[] }
let _paiAuditAutoSaveTimer = null;

const PAI_AUDIT_PHASES = [
  { num: 0, title: "Kontext", short: "Kontext" },
  { num: 1, title: "Energiebild", short: "Energie" },
  { num: 2, title: "Systembild", short: "System" },
  { num: 3, title: "Friction-Bild", short: "Friction" },
  { num: 4, title: "Selbstbild", short: "Selbst" },
  { num: 5, title: "Abschluss & Analyse", short: "Abschluss" },
];

const PAI_AUDIT_REAKTION_OPTIONS = [
  { value: "drive",       label: "Ich packe es aktiv an — ich handle, statt zu warten" },
  { value: "wait",        label: "Ich warte ab — ich beobachte erst" },
  { value: "frustration", label: "Ich werde frustriert — es macht mich wütend" },
  { value: "resignation", label: "Ich resigniere — es bringt eh nichts" },
];

const PAI_AUDIT_UGROSSE_OPTIONS = [
  { value: "<10",    label: "Unter 10 Personen" },
  { value: "10-50",  label: "10–50 Personen" },
  { value: "50-250", label: "50–250 Personen" },
  { value: "250+",   label: "Über 250 Personen" },
];

function initPAIAuditTab() {
  if (!currentPaiAuditSession) renderPaiAuditList();
}

function renderPaiAuditList() {
  currentPaiAuditSession = null;
  paiAuditAnalysis = null;
  const $el = document.getElementById("paiAuditContent");
  $el.innerHTML = `
    <div class="start-title">PAI Self-Assessment</div>
    <div class="start-desc">Pre-Scan Tool für den Entscheider. Strukturiertes Selbst-Assessment in 6 Phasen.</div>
    <div class="form-group">
      <label class="form-label pflicht" for="paiAuditName">Name</label>
      <input class="form-input" type="text" id="paiAuditName" placeholder="Vorname Nachname" autocomplete="off">
    </div>
    <div class="form-group">
      <label class="form-label" for="paiAuditRolle">Rolle</label>
      <input class="form-input" type="text" id="paiAuditRolle" placeholder="z.B. CEO, Geschäftsleitung, Bereichsleiter…" autocomplete="off">
    </div>
    <div class="btn-row">
      <button class="btn btn-primary" id="btnStartPaiAudit">Self-Assessment starten</button>
    </div>
    <div class="divider">Bestehende Self-Assessments</div>
    <div class="contact-list" id="paiAuditListEl"><div style="font-size:12px;color:var(--ink-mute);text-align:center;padding:12px;">Lade…</div></div>
  `;
  document.getElementById("btnStartPaiAudit").addEventListener("click", startNewPaiAuditSession);
  loadPaiAuditSessions();
}

async function loadPaiAuditSessions() {
  try {
    const r = await fetch("/api/pai/sessions?tool=audit");
    const sessions = await r.json();
    const $list = document.getElementById("paiAuditListEl");
    if (!Array.isArray(sessions) || sessions.length === 0) {
      $list.innerHTML = '<div style="font-size:12px;color:var(--ink-mute);text-align:center;padding:12px;">Noch keine Self-Assessments.</div>';
      return;
    }
    $list.innerHTML = "";
    for (const s of sessions) {
      const date = new Date(s.created_at).toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit", year: "2-digit" });
      const item = document.createElement("div");
      item.className = "contact-item";
      const nameEl = document.createElement("span");
      nameEl.className = "contact-name";
      nameEl.textContent = s.person_name + (s.person_rolle ? ` (${s.person_rolle})` : "");
      const hasAnalysis = s.ada_analysis && !s.ada_analysis.parse_error;
      const phaseLabel = s.status === "abgeschlossen"
        ? (hasAnalysis ? "Analysiert" : "Abgeschlossen")
        : `Phase ${s.current_phase || 0}`;
      const badgeColor = hasAnalysis ? "var(--ada-accent)"
        : s.status === "abgeschlossen" ? "var(--green)"
        : s.current_phase > 0 ? "#3498db"
        : "var(--ink-mute)";
      const dateEl = document.createElement("span");
      dateEl.className = "contact-date";
      dateEl.innerHTML = `<span style="display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-family:var(--mono);background:${badgeColor};color:#fff;margin-right:6px">${phaseLabel}</span>${date}`;
      const delBtn = document.createElement("button");
      delBtn.className = "btn-del-contact";
      delBtn.title = "Self-Assessment löschen";
      delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M1 3h10M4 3V1.5h4V3M2.5 3l.7 6.5a.8.8 0 00.8.7h4a.8.8 0 00.8-.7L9.5 3"/></svg>';
      delBtn.addEventListener("click", (e) => { e.stopPropagation(); deletePaiAuditSession(s, item); });
      item.addEventListener("click", () => openPaiAuditSession(s));
      item.appendChild(nameEl);
      item.appendChild(dateEl);
      item.appendChild(delBtn);
      $list.appendChild(item);
    }
  } catch {
    document.getElementById("paiAuditListEl").innerHTML = '<div style="font-size:12px;color:var(--ink-mute);text-align:center;padding:12px;">Self-Assessments konnten nicht geladen werden.</div>';
  }
}

async function startNewPaiAuditSession() {
  const name = document.getElementById("paiAuditName").value.trim();
  if (!name) { document.getElementById("paiAuditName").focus(); return; }
  const rolle = document.getElementById("paiAuditRolle")?.value?.trim() || undefined;
  try {
    const r = await fetch("/api/pai/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ person_name: name, person_rolle: rolle, tool_type: "audit" }),
    });
    const session = await r.json();
    if (session.error) throw new Error(session.error);
    openPaiAuditSession(session);
  } catch (e) { alert("Fehler: " + e.message); }
}

async function deletePaiAuditSession(session, itemEl) {
  if (!confirm(`Self-Assessment "${session.person_name}" und alle Daten löschen?`)) return;
  try {
    const r = await fetch(`/api/pai/sessions/${session.id}`, { method: "DELETE" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    itemEl.remove();
    const $list = document.getElementById("paiAuditListEl");
    if ($list && $list.children.length === 0) $list.innerHTML = '<div style="font-size:12px;color:var(--ink-mute);text-align:center;padding:12px;">Noch keine Self-Assessments.</div>';
  } catch (e) { alert("Löschen fehlgeschlagen: " + e.message); }
}

async function openPaiAuditSession(session) {
  currentPaiAuditSession = session;
  paiAuditPhase = session.current_phase || 0;
  paiAuditAnswers = {};
  paiAuditAnalysis = session.ada_analysis || null;
  try {
    const r = await fetch(`/api/pai/erhebung/${session.id}`);
    const data = await r.json();
    if (Array.isArray(data)) data.forEach(e => { paiAuditAnswers[`${e.phase}_${e.feld}`] = e.wert; });
  } catch (e) { console.warn("PAI Audit load:", e.message); }
  // Anker-Button sichtbar machen (wenn gerade modul4 aktiv ist)
  if (activeTab === "modul4") document.getElementById("btnAnker").style.display = "flex";
  renderPaiAuditPhase(paiAuditPhase);
}

function getPaiAuditVal(phase, feld) {
  return paiAuditAnswers[`${phase}_${feld}`] || "";
}

function renderPaiAuditPhaseSidebar(activeNum) {
  let html = '<div class="phase-sidebar-label">Phasen</div>';
  for (const p of PAI_AUDIT_PHASES) {
    const isDone = isPaiAuditPhaseDone(p.num);
    const isActive = p.num === activeNum;
    html += `<button class="phase-nav-item${isActive ? " active" : ""}${isDone ? " done" : ""}" onclick="goToPaiAuditPhase(${p.num})">`;
    html += `<span class="phase-nav-dot">${isDone ? "✓" : p.num}</span>`;
    html += `<span class="phase-nav-title">${escHtml(p.short)}</span></button>`;
  }
  return html;
}

function isPaiAuditPhaseDone(num) {
  if (!currentPaiAuditSession) return false;
  switch (num) {
    case 0: return !!(getPaiAuditVal(0, "unternehmensgroesse") && getPaiAuditVal(0, "motivation"));
    case 1: return !!(getPaiAuditVal(1, "energie_skala") && getPaiAuditVal(1, "energie_freitext"));
    case 2: return !!(getPaiAuditVal(2, "was_laeuft_gut") || getPaiAuditVal(2, "was_versucht_zu_veraendern"));
    case 3: return !!(getPaiAuditVal(3, "wo_energieverlust") || getPaiAuditVal(3, "was_aendert_sich"));
    case 4: return !!(getPaiAuditVal(4, "reaktion_option") && getPaiAuditVal(4, "was_schuetzen_sie"));
    case 5: return !!paiAuditAnalysis;
    default: return false;
  }
}

function renderPaiAuditPhase(num) {
  paiAuditPhase = num;
  const $el = document.getElementById("paiAuditContent");
  let content = "";
  switch (num) {
    case 0: content = renderPaiAuditPhase0(); break;
    case 1: content = renderPaiAuditPhase1(); break;
    case 2: content = renderPaiAuditPhase2(); break;
    case 3: content = renderPaiAuditPhase3(); break;
    case 4: content = renderPaiAuditPhase4(); break;
    case 5: content = renderPaiAuditPhase5(); break;
  }
  $el.innerHTML = `
    <div class="cockpit-contact">
      <button class="cockpit-back-btn" onclick="renderPaiAuditList()" title="Zurück zur Self-Assessment-Liste" aria-label="Zurück zur Self-Assessment-Liste">&larr;</button>
      <span class="cockpit-contact-name">${escHtml(currentPaiAuditSession.person_name)}</span>
      <span class="cockpit-contact-date">— PAI Self-Assessment${currentPaiAuditSession.person_rolle ? " · " + escHtml(currentPaiAuditSession.person_rolle) : ""}</span>
    </div>
    <div class="cockpit-layout">
      <nav class="phase-sidebar">${renderPaiAuditPhaseSidebar(num)}</nav>
      <div class="cockpit-content">${content}</div>
    </div>
  `;
  wirePaiAuditAutoSave();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function goToPaiAuditPhase(num) {
  await savePaiAuditState();
  paiAuditPhase = num;
  renderPaiAuditPhase(num);
}

async function savePaiAuditState() {
  if (!currentPaiAuditSession) return;
  try {
    await fetch(`/api/pai/sessions/${currentPaiAuditSession.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_phase: paiAuditPhase }),
    });
  } catch (e) { console.warn("PAI Audit state save:", e.message); }
}

// ── PHASE 0: KONTEXT ──
function renderPaiAuditPhase0() {
  const ug = getPaiAuditVal(0, "unternehmensgroesse");
  const ugOpts = PAI_AUDIT_UGROSSE_OPTIONS
    .map(o => `<option value="${o.value}" ${ug === o.value ? "selected" : ""}>${escHtml(o.label)}</option>`)
    .join("");
  return `
    <div class="phase-header"><span class="phase-number">Phase 0</span><span class="phase-title">Kontext</span></div>
    <div class="phase-instruction">Grunddaten zur Person und zum Unternehmen.</div>
    <div class="scan-card">
      <div class="scan-card-title">Unternehmen</div>
      <div class="form-group">
        <label class="form-label pflicht">Unternehmensgrösse</label>
        <select class="form-input" data-pai-audit-feld="unternehmensgroesse" data-pai-audit-phase="0">
          <option value="">— wählen —</option>
          ${ugOpts}
        </select>
      </div>
      <div class="form-group" style="margin-top:10px">
        <label class="form-label">Branche</label>
        <input class="form-input" type="text" placeholder="z.B. Maschinenbau, Software, Gesundheitswesen…" value="${escHtml(getPaiAuditVal(0, 'branche'))}" data-pai-audit-feld="branche" data-pai-audit-phase="0">
      </div>
    </div>
    <div class="scan-card" style="margin-top:12px">
      <div class="scan-card-title">Motivation</div>
      <div class="form-group">
        <label class="form-label pflicht">Was hat Sie zu diesem Scan geführt?</label>
        <textarea class="form-input" rows="3" placeholder="Anlass, Auslöser, Hoffnung…" data-pai-audit-feld="motivation" data-pai-audit-phase="0">${escHtml(getPaiAuditVal(0, 'motivation'))}</textarea>
      </div>
    </div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn btn-primary" onclick="goToPaiAuditPhase(1)">Weiter zu Phase 1</button>
    </div>
  `;
}

// ── PHASE 1: ENERGIEBILD ──
function renderPaiAuditPhase1() {
  const skala = getPaiAuditVal(1, "energie_skala") || "5";
  return `
    <div class="phase-header"><span class="phase-number">Phase 1</span><span class="phase-title">Energiebild</span></div>
    <div class="phase-instruction">Wie steht es um Ihre eigene Energie im Moment?</div>
    <div class="scan-card">
      <div class="scan-card-title">Aktueller Energiezustand</div>
      <div class="form-group">
        <label class="form-label pflicht">Skala 1–10</label>
        <div class="pai-audit-scale-row">
          <span style="font-size:11px;color:var(--ink-mute)">leer</span>
          <input type="range" min="1" max="10" value="${escHtml(skala)}" data-pai-audit-feld="energie_skala" data-pai-audit-phase="1" oninput="document.getElementById('paiAuditEnergieSkalaVal').textContent = this.value">
          <span style="font-size:11px;color:var(--ink-mute)">voll</span>
          <span class="pai-audit-scale-val" id="paiAuditEnergieSkalaVal">${escHtml(skala)}</span>
        </div>
      </div>
      <div class="form-group" style="margin-top:10px">
        <label class="form-label pflicht">Wie würden Sie Ihren aktuellen Energiezustand beschreiben?</label>
        <textarea class="form-input" rows="3" placeholder="Erschöpft / getrieben / ruhig / unruhig / …" data-pai-audit-feld="energie_freitext" data-pai-audit-phase="1">${escHtml(getPaiAuditVal(1, 'energie_freitext'))}</textarea>
      </div>
    </div>
    <div class="scan-card" style="margin-top:12px">
      <div class="scan-card-title">Gute Tage</div>
      <div class="form-group">
        <label class="form-label">Wann hatten Sie zuletzt das Gefühl: heute war ein guter Tag?</label>
        <textarea class="form-input" rows="3" placeholder="Datum, Umstände, was war anders…" data-pai-audit-feld="letzter_guter_tag" data-pai-audit-phase="1">${escHtml(getPaiAuditVal(1, 'letzter_guter_tag'))}</textarea>
      </div>
    </div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn btn-ghost" onclick="goToPaiAuditPhase(0)">Zurück</button>
      <button class="btn btn-primary" onclick="goToPaiAuditPhase(2)">Weiter</button>
    </div>
  `;
}

// ── PHASE 2: SYSTEMBILD ──
function renderPaiAuditPhase2() {
  return `
    <div class="phase-header"><span class="phase-number">Phase 2</span><span class="phase-title">Systembild</span></div>
    <div class="phase-instruction">Ein Blick auf das Unternehmen — was funktioniert, was haben Sie zu verändern versucht?</div>
    <div class="scan-card">
      <div class="scan-card-title">Was funktioniert</div>
      <div class="form-group">
        <label class="form-label">Was läuft in Ihrem Unternehmen gerade gut — trotz allem?</label>
        <textarea class="form-input" rows="4" placeholder="Bereiche, Teams, Prozesse die trotz Druck liefern…" data-pai-audit-feld="was_laeuft_gut" data-pai-audit-phase="2">${escHtml(getPaiAuditVal(2, 'was_laeuft_gut'))}</textarea>
      </div>
    </div>
    <div class="scan-card" style="margin-top:12px">
      <div class="scan-card-title">Veränderungs-Versuche</div>
      <div class="form-group">
        <label class="form-label">Was haben Sie in den letzten 12 Monaten versucht zu verändern?</label>
        <textarea class="form-input" rows="4" placeholder="Initiativen, Projekte, Massnahmen — was davon hat gehalten, was nicht?" data-pai-audit-feld="was_versucht_zu_veraendern" data-pai-audit-phase="2">${escHtml(getPaiAuditVal(2, 'was_versucht_zu_veraendern'))}</textarea>
      </div>
    </div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn btn-ghost" onclick="goToPaiAuditPhase(1)">Zurück</button>
      <button class="btn btn-primary" onclick="goToPaiAuditPhase(3)">Weiter</button>
    </div>
  `;
}

// ── PHASE 3: FRICTION-BILD ──
function renderPaiAuditPhase3() {
  return `
    <div class="phase-header"><span class="phase-number">Phase 3</span><span class="phase-title">Friction-Bild</span></div>
    <div class="phase-instruction">Wo sitzt die Reibung? Was wäre anders, wenn das Problem weg wäre?</div>
    <div class="scan-card">
      <div class="scan-card-title">Energieverlust</div>
      <div class="form-group">
        <label class="form-label">Wo verlieren Sie am meisten Energie?</label>
        <textarea class="form-input" rows="4" placeholder="Themen, Personen, Prozesse, Entscheidungen…" data-pai-audit-feld="wo_energieverlust" data-pai-audit-phase="3">${escHtml(getPaiAuditVal(3, 'wo_energieverlust'))}</textarea>
      </div>
    </div>
    <div class="scan-card" style="margin-top:12px">
      <div class="scan-card-title">Imaginierte Lösung</div>
      <div class="form-group">
        <label class="form-label">Was würde sich ändern, wenn das Problem morgen weg wäre?</label>
        <textarea class="form-input" rows="4" placeholder="Konkret — für Sie persönlich, für das Team, für die Organisation…" data-pai-audit-feld="was_aendert_sich" data-pai-audit-phase="3">${escHtml(getPaiAuditVal(3, 'was_aendert_sich'))}</textarea>
      </div>
    </div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn btn-ghost" onclick="goToPaiAuditPhase(2)">Zurück</button>
      <button class="btn btn-primary" onclick="goToPaiAuditPhase(4)">Weiter</button>
    </div>
  `;
}

// ── PHASE 4: SELBSTBILD ──
function renderPaiAuditPhase4() {
  const selected = getPaiAuditVal(4, "reaktion_option");
  const radioHtml = PAI_AUDIT_REAKTION_OPTIONS.map(o => `
    <label class="pai-audit-radio-row${selected === o.value ? " selected" : ""}">
      <input type="radio" name="paiAuditReaktion" value="${o.value}" ${selected === o.value ? "checked" : ""} data-pai-audit-feld="reaktion_option" data-pai-audit-phase="4" onchange="savePaiAuditRadio(this)">
      <span class="pai-audit-radio-label">${escHtml(o.label)}</span>
    </label>
  `).join("");
  return `
    <div class="phase-header"><span class="phase-number">Phase 4</span><span class="phase-title">Selbstbild</span></div>
    <div class="phase-instruction">Wie reagieren Sie persönlich wenn es nicht vorankommt — und was schützen Sie?</div>
    <div class="scan-card">
      <div class="scan-card-title">Reaktion auf Stillstand</div>
      <div class="form-group">
        <label class="form-label pflicht">Wie reagieren Sie persönlich wenn Dinge nicht vorankommen?</label>
        ${radioHtml}
      </div>
      <div class="form-group" style="margin-top:10px">
        <label class="form-label">Optional: Erklären Sie die Wahl</label>
        <textarea class="form-input" rows="3" placeholder="Kontext, Beispiel, Muster über Zeit…" data-pai-audit-feld="reaktion_freitext" data-pai-audit-phase="4">${escHtml(getPaiAuditVal(4, 'reaktion_freitext'))}</textarea>
      </div>
    </div>
    <div class="scan-card" style="margin-top:12px">
      <div class="scan-card-title">Schutz</div>
      <div class="form-group">
        <label class="form-label pflicht">Was schützen Sie in Ihrem Unternehmen — auch wenn es vielleicht nicht mehr passt?</label>
        <textarea class="form-input" rows="4" placeholder="Prozesse, Personen, Strukturen, eigene Rolle, Geschichten…" data-pai-audit-feld="was_schuetzen_sie" data-pai-audit-phase="4">${escHtml(getPaiAuditVal(4, 'was_schuetzen_sie'))}</textarea>
      </div>
    </div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn btn-ghost" onclick="goToPaiAuditPhase(3)">Zurück</button>
      <button class="btn btn-primary" onclick="goToPaiAuditPhase(5)">Weiter</button>
    </div>
  `;
}

// ── PHASE 5: ABSCHLUSS & ADA-ANALYSE ──
function renderPaiAuditPhase5() {
  return `
    <div class="phase-header"><span class="phase-number">Phase 5</span><span class="phase-title">Abschluss & Analyse</span></div>
    <div class="phase-instruction">Alle Antworten im Überblick. ADA erstellt auf Wunsch eine vorläufige L2-Analyse.</div>
    <div class="scan-card">
      <div class="scan-card-title">Zusammenfassung</div>
      ${renderPaiAuditSummary()}
    </div>
    <div class="scan-card" style="margin-top:12px">
      <div class="scan-card-title">ADA Vor-Analyse</div>
      <div id="paiAuditAnalysisSlot">${renderPaiAuditAdaResult()}</div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn btn-primary" id="btnPaiAuditAnalyze" onclick="runPaiAuditAdaAnalysis()">${paiAuditAnalysis ? "Neu analysieren" : "Mit ADA analysieren"}</button>
      </div>
    </div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn btn-ghost" onclick="goToPaiAuditPhase(4)">Zurück</button>
      <button class="btn btn-ghost" onclick="printPaiAuditReport()">Als PDF speichern (drucken)</button>
      <button class="btn btn-primary" onclick="finishPaiAuditSession()">Self-Assessment abschliessen</button>
    </div>
  `;
}

function renderPaiAuditSummary() {
  const phaseFields = {
    0: [
      ["unternehmensgroesse", "Unternehmensgrösse", (v) => {
        const o = PAI_AUDIT_UGROSSE_OPTIONS.find(x => x.value === v);
        return o ? o.label : v;
      }],
      ["branche", "Branche"],
      ["motivation", "Motivation"],
    ],
    1: [
      ["energie_skala", "Energie-Skala", (v) => v ? `${v}/10` : ""],
      ["energie_freitext", "Energie-Beschreibung"],
      ["letzter_guter_tag", "Letzter guter Tag"],
    ],
    2: [
      ["was_laeuft_gut", "Was läuft gut"],
      ["was_versucht_zu_veraendern", "Veränderungsversuche"],
    ],
    3: [
      ["wo_energieverlust", "Energieverlust"],
      ["was_aendert_sich", "Imaginierte Lösung"],
    ],
    4: [
      ["reaktion_option", "Reaktion auf Stillstand", (v) => {
        const o = PAI_AUDIT_REAKTION_OPTIONS.find(x => x.value === v);
        return o ? o.label : v;
      }],
      ["reaktion_freitext", "Reaktion — Erklärung"],
      ["was_schuetzen_sie", "Was Sie schützen"],
    ],
  };
  let html = "";
  for (const [phase, fields] of Object.entries(phaseFields)) {
    const p = PAI_AUDIT_PHASES.find(x => x.num === parseInt(phase));
    html += `<div style="margin-top:${phase === "0" ? "0" : "14px"}"><div style="font-size:11px;font-weight:600;color:var(--ink-mid);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">Phase ${phase} — ${escHtml(p.title)}</div>`;
    for (const [key, label, formatter] of fields) {
      const raw = getPaiAuditVal(parseInt(phase), key);
      const display = formatter ? formatter(raw) : raw;
      if (display) {
        html += `<div class="pai-audit-summary-block"><div class="pai-audit-summary-label">${escHtml(label)}</div><div class="pai-audit-summary-val">${escHtml(display)}</div></div>`;
      }
    }
    html += "</div>";
  }
  if (!html) html = '<div style="font-size:13px;color:var(--ink-mute);padding:8px">Noch keine Antworten erfasst.</div>';
  return html;
}

function renderPaiAuditAdaResult() {
  if (!paiAuditAnalysis) {
    return '<div style="font-size:13px;color:var(--ink-mute);padding:8px">Noch keine Analyse. Klick auf "Mit ADA analysieren" unten.</div>';
  }
  if (paiAuditAnalysis.parse_error) {
    return `
      <div class="pai-audit-analysis-card">
        <div class="pai-audit-analysis-title">ADA-Antwort (Rohtext)</div>
        <div class="pai-audit-analysis-body">Das Modell hat kein valides JSON zurückgegeben. Raw-Output:</div>
        <div class="pai-audit-analysis-raw">${escHtml(paiAuditAnalysis.raw_text || "")}</div>
      </div>
    `;
  }
  const l2 = paiAuditAnalysis.l2_signal || "";
  const hyp = Array.isArray(paiAuditAnalysis.hypothesen) ? paiAuditAnalysis.hypothesen : [];
  const emp = Array.isArray(paiAuditAnalysis.interview_empfehlungen) ? paiAuditAnalysis.interview_empfehlungen : [];
  return `
    <div class="pai-audit-analysis-card">
      <div class="pai-audit-analysis-title">ADA Vor-Analyse</div>
      <div class="pai-audit-analysis-section">
        <div class="pai-audit-analysis-h">L2-Signal</div>
        <div class="pai-audit-analysis-body">${l2 ? escHtml(l2) : '<em style="color:var(--ink-mute)">— keine Daten —</em>'}</div>
      </div>
      <div class="pai-audit-analysis-section">
        <div class="pai-audit-analysis-h">Hypothesen für den Scan</div>
        <div class="pai-audit-analysis-body">${hyp.length ? `<ul>${hyp.map(h => `<li>${escHtml(h)}</li>`).join("")}</ul>` : '<em style="color:var(--ink-mute)">— keine Hypothesen —</em>'}</div>
      </div>
      <div class="pai-audit-analysis-section">
        <div class="pai-audit-analysis-h">Interview-Empfehlungen</div>
        <div class="pai-audit-analysis-body">${emp.length ? `<ul>${emp.map(e => `<li>${escHtml(e)}</li>`).join("")}</ul>` : '<em style="color:var(--ink-mute)">— keine Empfehlungen —</em>'}</div>
      </div>
    </div>
  `;
}

async function runPaiAuditAdaAnalysis() {
  if (!currentPaiAuditSession) return;
  const $slot = document.getElementById("paiAuditAnalysisSlot");
  const $btn = document.getElementById("btnPaiAuditAnalyze");
  if ($btn) { $btn.disabled = true; $btn.innerHTML = '<span class="pai-audit-spinner"></span>Analysiere…'; }
  if ($slot) $slot.innerHTML = '<div style="font-size:13px;color:var(--ada-accent);padding:12px"><span class="pai-audit-spinner"></span>ADA analysiert das Audit… (3–8 Sekunden)</div>';
  try {
    // Vor der Analyse: stelle sicher dass alle Felder gespeichert sind
    await savePaiAuditAllVisibleFields();

    const r = await fetch("/api/pai/audit/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: currentPaiAuditSession.id }),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    paiAuditAnalysis = data;
    if ($slot) $slot.innerHTML = renderPaiAuditAdaResult();
    if ($btn) { $btn.disabled = false; $btn.textContent = "Neu analysieren"; }
  } catch (e) {
    if ($slot) $slot.innerHTML = `<div style="font-size:13px;color:var(--red);padding:8px">Fehler: ${escHtml(e.message)}</div>`;
    if ($btn) { $btn.disabled = false; $btn.textContent = "Mit ADA analysieren"; }
  }
}

async function savePaiAuditAllVisibleFields() {
  const fields = document.querySelectorAll("#paiAuditContent [data-pai-audit-feld][data-pai-audit-phase]");
  for (const el of fields) {
    const feld = el.dataset.paiAuditFeld;
    const phase = parseInt(el.dataset.paiAuditPhase);
    let wert;
    if (el.type === "radio") {
      if (!el.checked) continue;
      wert = el.value;
    } else if (el.tagName === "SELECT") {
      wert = el.value || "";
    } else {
      wert = el.value || "";
    }
    await savePaiAuditField(phase, feld, wert);
  }
}

async function finishPaiAuditSession() {
  await savePaiAuditAllVisibleFields();
  try {
    await fetch(`/api/pai/sessions/${currentPaiAuditSession.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "abgeschlossen", current_phase: 5 }),
    });
  } catch (e) { console.warn("PAI Audit finish:", e.message); }
  alert("PAI Self-Assessment abgeschlossen und gespeichert.");
  renderPaiAuditList();
}

function printPaiAuditReport() {
  window.print();
}

// ── PAI AUDIT AUTO-SAVE ──
function wirePaiAuditAutoSave() {
  const $scope = document.getElementById("paiAuditContent");
  if (!$scope) return;
  $scope.querySelectorAll("textarea, input[type=text], input[type=range]").forEach(el => {
    el.addEventListener("input", schedulePaiAuditAutoSave);
  });
  $scope.querySelectorAll("select").forEach(el => {
    el.addEventListener("change", schedulePaiAuditAutoSave);
  });
  // Radios werden einzeln via onchange→savePaiAuditRadio gehandhabt
}

function schedulePaiAuditAutoSave() {
  if (_paiAuditAutoSaveTimer) clearTimeout(_paiAuditAutoSaveTimer);
  _paiAuditAutoSaveTimer = setTimeout(async () => {
    if (!currentPaiAuditSession) return;
    try {
      await savePaiAuditAllVisibleFields();
      showSaveIndicator();
    } catch (e) { console.warn("PAI Audit auto-save:", e.message); }
  }, 1200);
}

async function savePaiAuditField(phase, feld, wert) {
  paiAuditAnswers[`${phase}_${feld}`] = wert;
  try {
    await fetch("/api/pai/erhebung", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: currentPaiAuditSession.id, phase, feld, wert }),
    });
  } catch (e) { console.warn("PAI Audit field save:", e.message); }
}

function savePaiAuditRadio(el) {
  // Highlight gewählte Radio-Row
  const $rows = document.querySelectorAll("#paiAuditContent .pai-audit-radio-row");
  $rows.forEach(r => {
    const input = r.querySelector("input[type=radio]");
    if (input) r.classList.toggle("selected", input.checked);
  });
  const feld = el.dataset.paiAuditFeld;
  const phase = parseInt(el.dataset.paiAuditPhase);
  savePaiAuditField(phase, feld, el.value);
}
