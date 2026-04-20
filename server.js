const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execSync } = require("child_process");
const { createClient } = require("@supabase/supabase-js");
const Anthropic = require("@anthropic-ai/sdk");
const multer = require("multer");
const PDFParse = require("pdf-parse");
const mammoth = require("mammoth");
const AdmZip = require("adm-zip");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ─── VERSION ───────────────────────────────────────────────────────────────
let APP_LAST_UPDATED = "unbekannt";
try {
  const raw = execSync('git log -1 --format="%cd" "--date=format:%d.%m.%Y %H:%M"', {
    cwd: __dirname,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  APP_LAST_UPDATED = raw || "unbekannt";
} catch (e) {
  console.warn("Could not read git commit date:", e.message);
}

// ─── CONTENT FILE ─────────────────────────────────────────────────────────
// Parsed once at startup from content/cockpit.md. To update content:
// edit the file → git push → Render redeploys → new content is live.
function parseCockpitContent(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");

  // Split on --- separators
  const blocks = raw.split(/^---$/m).map(b => b.trim()).filter(Boolean);

  const phases = [];
  const anker = [];

  for (const block of blocks) {
    // Anker block
    if (/^## ANKER/m.test(block)) {
      const lines = block.split("\n");
      for (const line of lines) {
        const m = line.match(/^- (.+)$/);
        if (m) anker.push(m[1].trim());
      }
      continue;
    }

    // Phase block
    if (/^## PHASE/m.test(block)) {
      const get = (key) => {
        const m = block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
        return m ? m[1].trim() : "";
      };

      // instruction may be multiline — capture everything between instruction: and guide:
      let instruction = "";
      const instrMatch = block.match(/^instruction:\s*([\s\S]*?)(?=^guide:|$)/m);
      if (instrMatch) instruction = instrMatch[1].trim();

      // guide items: lines starting with -
      const guideItems = [];
      const guideSection = block.match(/^guide:\s*\n([\s\S]*)$/m);
      if (guideSection) {
        for (const line of guideSection[1].split("\n")) {
          const gm = line.match(/^- (.+)$/);
          if (gm) guideItems.push(gm[1].trim());
        }
      }

      if (get("title")) {
        phases.push({
          num: get("num"),
          title: get("title"),
          time: get("time"),
          instruction,
          guide: guideItems,
        });
      }
    }
  }

  return { phases, anker };
}

const CONTENT_PATH = path.join(__dirname, "content", "cockpit.md");
let COCKPIT_CONTENT = { phases: [], anker: [] };
try {
  COCKPIT_CONTENT = parseCockpitContent(CONTENT_PATH);
  console.log(`Content loaded: ${COCKPIT_CONTENT.phases.length} phases, ${COCKPIT_CONTENT.anker.length} anker lines`);
} catch (e) {
  console.error("Failed to load cockpit content:", e.message);
}

// ─── ADA SYSTEM PROMPT ────────────────────────────────────────────────────
const ADA_PROMPT_PATH = path.join(__dirname, "content", "ada-prompt.md");
let ADA_SYSTEM_PROMPT = "";
try {
  ADA_SYSTEM_PROMPT = fs.readFileSync(ADA_PROMPT_PATH, "utf-8");
  console.log(`ADA prompt loaded (${ADA_SYSTEM_PROMPT.length} chars)`);
} catch (e) {
  console.warn("ADA prompt not found:", e.message);
}

// ─── PAI AUDIT ANALYZER PROMPT ────────────────────────────────────────────
// Spezieller System-Prompt für die Pre-Scan-Analyse eines PAI Audit
// (Client Self-Assessment). Erzeugt strukturiertes JSON für den Consultant.
const PAI_AUDIT_ANALYZER_PROMPT = `Du bist ADA, der diagnostische Analyse-Assistent für NELION.
Du bekommst ein PAI Audit (Client Self-Assessment, 6 Phasen: Kontext, Energiebild,
Systembild, Friction-Bild, Selbstbild, Abschluss) und produzierst eine strukturierte
Vor-Analyse für den Consultant vor dem eigentlichen Friction Scan.

Analysiere die Antworten und gib EIN JSON-Objekt zurück (keinen Zusatztext, kein Markdown)
mit genau diesen Feldern:

{
  "l2_signal": "1-2 Sätze: welche psychologischen Muster sind in den Antworten sichtbar? Fokus: Helfersyndrom, Vermeidung, Resignation, Angst, Immunity-Muster, Attribution Style, Psychological Safety, Selbstwirksamkeit.",
  "hypothesen": [
    "Hypothese 1 — konkret und testbar im Scan",
    "Hypothese 2 — konkret und testbar im Scan",
    "Hypothese 3 — konkret und testbar im Scan"
  ],
  "interview_empfehlungen": [
    "Empfehlung 1 — welche Interview-Frage oder welches Thema besonders vertiefen",
    "Empfehlung 2 — …",
    "Empfehlung 3 — …"
  ]
}

Regeln:
- Nur JSON zurückgeben, kein Markdown, keine Präambel, kein Nachwort
- Wenn Daten zu dünn für eine Kategorie sind: leerer String bzw. leeres Array
- Fokus auf L2-Ebene (psychologische Dynamik), nicht L1 oder L3
- Deutsch, präzise, nicht blumig
- Keine Diagnose — nur Hypothesen die im Scan geprüft werden können`;

// ─── ENV ───────────────────────────────────────────────────────────────────
const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY  = process.env.SUPABASE_ANON_KEY;
const NELION_PASSWORD    = process.env.NELION_PASSWORD;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN        = process.env.GITHUB_TOKEN;
const GITHUB_REPO         = process.env.GITHUB_REPO;
const GITHUB_CONTEXT_PATH = process.env.GITHUB_CONTEXT_PATH;
const GITHUB_FILE_PATH    = process.env.GITHUB_FILE_PATH;

// ─── SUPABASE ───────────────────────────────────────────────────────────────
const supabase = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

const anthropic = ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  : null;

if (!supabase) console.warn("Supabase not configured — storage disabled");
if (!NELION_PASSWORD) console.warn("NELION_PASSWORD not set — app is publicly accessible");
if (!anthropic) console.warn("ANTHROPIC_API_KEY not set — ADA disabled");
if (!GITHUB_TOKEN || !GITHUB_REPO || !GITHUB_CONTEXT_PATH) console.warn("GitHub context not configured — Master Context disabled");
if (!GITHUB_FILE_PATH) console.warn("GITHUB_FILE_PATH not set — shared memory disabled");

// ─── GITHUB CONTEXT ───────────────────────────────────────────────────────
async function githubGetContextFile() {
  if (!GITHUB_CONTEXT_PATH || !GITHUB_TOKEN || !GITHUB_REPO) return { content: null };
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_CONTEXT_PATH}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    if (res.status === 404) return { content: null };
    throw new Error(`GitHub GET context failed: ${res.status}`);
  }
  const data = await res.json();
  const content = Buffer.from(data.content, "base64").toString("utf-8");
  return { content };
}

// ─── NELION MASTER CONTEXT LOADER (dynamisch, Multi-Source) ───────────────
// Reihenfolge: Supabase → GitHub → lokales File. Bei Fehler: leerer Content,
// der ADA-System-Prompt bleibt funktionsfähig (hardcodierter Fallback).
// 5-Minuten-Cache um API-Limits zu schonen.
let _nelionContextCache = { text: null, ts: 0 };
const NELION_CONTEXT_CACHE_MS = 5 * 60 * 1000;
const NELION_CONTEXT_LOCAL_PATH = path.join(__dirname, "content", "nelion-master-context.md");

async function loadNelionContext() {
  // Cache-Hit
  if (_nelionContextCache.text && (Date.now() - _nelionContextCache.ts) < NELION_CONTEXT_CACHE_MS) {
    return _nelionContextCache.text;
  }
  let text = null;
  // 1. Supabase — Tabelle nelion_context(name, content)
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("nelion_context")
        .select("content")
        .eq("name", "master")
        .maybeSingle();
      if (!error && data && data.content) text = data.content;
    } catch (e) {
      console.warn("loadNelionContext: Supabase skipped:", e.message);
    }
  }
  // 2. GitHub raw (bestehender Pfad)
  if (!text) {
    try {
      const { content } = await githubGetContextFile();
      if (content) text = content;
    } catch (e) {
      console.warn("loadNelionContext: GitHub skipped:", e.message);
    }
  }
  // 3. Lokales File als Fallback
  if (!text) {
    try {
      if (fs.existsSync(NELION_CONTEXT_LOCAL_PATH)) {
        text = fs.readFileSync(NELION_CONTEXT_LOCAL_PATH, "utf-8");
      }
    } catch (e) {
      console.warn("loadNelionContext: local file skipped:", e.message);
    }
  }
  if (text) {
    _nelionContextCache = { text, ts: Date.now() };
  }
  return text || "";
}

// ─── GITHUB MEMORY (shared with NOS) ─────────────────────────────────────
async function githubGetMemoryFile() {
  if (!GITHUB_FILE_PATH || !GITHUB_TOKEN || !GITHUB_REPO) return { content: null, sha: null };
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    if (res.status === 404) return { content: null, sha: null };
    throw new Error(`GitHub GET memory failed: ${res.status}`);
  }
  const data = await res.json();
  const content = Buffer.from(data.content, "base64").toString("utf-8");
  return { content, sha: data.sha };
}

async function githubPutMemoryFile(content, sha, message = "ADA memory update") {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
  const body = {
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
  };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub PUT memory failed: ${res.status} — ${err}`);
  }
  return res.json();
}

// ─── AUTH ──────────────────────────────────────────────────────────────────
function authToken() {
  return crypto
    .createHash("sha256")
    .update("nelion-auth:v1:" + (NELION_PASSWORD || ""))
    .digest("hex");
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    out[k] = v;
  }
  return out;
}

function isAuthenticated(req) {
  if (!NELION_PASSWORD) return true;
  const cookies = parseCookies(req);
  return cookies.nelion_auth === authToken();
}

const PUBLIC_AUTH_PATHS = new Set([
  "/login.html",
  "/api/auth/login",
  "/api/auth/status",
  "/webhook/tally",
]);

app.use((req, res, next) => {
  if (PUBLIC_AUTH_PATHS.has(req.path)) return next();
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return res.redirect("/login.html");
});

app.post("/api/auth/login", (req, res) => {
  if (!NELION_PASSWORD) {
    return res.status(503).json({ error: "NELION_PASSWORD nicht gesetzt" });
  }
  const { password } = req.body || {};
  if (!password || password !== NELION_PASSWORD) {
    return res.status(401).json({ error: "Falsches Passwort" });
  }
  const token = authToken();
  const maxAge = 7 * 24 * 60 * 60;
  const cookieParts = [
    `nelion_auth=${token}`,
    `Max-Age=${maxAge}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=None`,
    `Secure`,
  ];
  res.setHeader("Set-Cookie", cookieParts.join("; "));
  res.json({ success: true });
});

app.get("/api/auth/status", (req, res) => {
  res.json({
    authenticated: isAuthenticated(req),
    passwordSet: !!NELION_PASSWORD,
  });
});

// Static files after auth.
// HTML explizit ohne Cache ausliefern — damit Deploy-Updates sofort
// beim User ankommen ohne Hard-Refresh. Andere Assets (JS/CSS/Bilder
// werden aktuell nicht separat referenziert — alles inline in index.html).
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  },
}));

// ─── FILE UPLOAD ──────────────────────────────────────────────────────────
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTS = new Set([".pdf", ".docx", ".pptx"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      return cb(new Error("Format nicht unterstuetzt. Erlaubt: PDF, DOCX, PPTX"));
    }
    cb(null, true);
  },
});

async function extractPdfText(buffer) {
  const result = await PDFParse(buffer);
  return (result && result.text) || "";
}

async function extractDocxText(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return (result && result.value) || "";
}

function extractPptxText(buffer) {
  const zip = new AdmZip(buffer);
  const slides = [];
  for (const entry of zip.getEntries()) {
    const m = entry.entryName.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (!m) continue;
    const xml = entry.getData().toString("utf-8");
    const runs = [];
    for (const t of xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)) {
      runs.push(t[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"'));
    }
    slides.push({ index: parseInt(m[1], 10), text: runs.join(" ").trim() });
  }
  slides.sort((a, b) => a.index - b.index);
  return slides.map(s => `[Slide ${s.index}]\n${s.text}`).join("\n\n");
}

app.post("/api/upload", (req, res) => {
  upload.single("file")(req, res, async (uploadErr) => {
    if (uploadErr) {
      const msg = uploadErr.code === "LIMIT_FILE_SIZE"
        ? "Datei zu gross (max. 10 MB)"
        : uploadErr.message || "Upload fehlgeschlagen";
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: "Keine Datei empfangen" });

    const { buffer, originalname, size } = req.file;
    const ext = path.extname(originalname || "").toLowerCase();

    try {
      let text = "";
      if (ext === ".pdf") text = await extractPdfText(buffer);
      else if (ext === ".docx") text = await extractDocxText(buffer);
      else if (ext === ".pptx") text = extractPptxText(buffer);
      else if (ext === ".txt") text = buffer.toString("utf-8");
      else return res.status(400).json({ error: "Format nicht unterstuetzt" });

      text = (text || "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
      if (!text) return res.status(422).json({ error: "Kein Text extrahierbar" });

      res.json({ filename: originalname, size, text });
    } catch (err) {
      console.error("Upload parse error:", err.message);
      res.status(500).json({ error: "Parse-Fehler: " + err.message });
    }
  });
});

// ─── VERSION ENDPOINT ──────────────────────────────────────────────────────
app.get("/api/version", (req, res) => {
  res.json({ lastUpdated: APP_LAST_UPDATED });
});

// Content (loaded from content/cockpit.md at startup)
app.get("/api/content", (req, res) => {
  res.json(COCKPIT_CONTENT);
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    supabase: !!supabase,
    passwordSet: !!NELION_PASSWORD,
  });
});

// ─── CONTACTS ──────────────────────────────────────────────────────────────
app.post("/api/contacts", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { name, initial_note } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Name erforderlich" });
  }
  const { data, error } = await supabase
    .from("contacts")
    .insert({ name: name.trim(), initial_note: (initial_note || "").trim() || null })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/contacts", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { data, error } = await supabase
    .from("contacts")
    .select("id, name, initial_note, created_at")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Rename contact
app.patch("/api/contacts/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Name erforderlich" });
  const { data, error } = await supabase
    .from("contacts")
    .update({ name: name.trim() })
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Delete contact (cascades to consultations)
app.delete("/api/contacts/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { error } = await supabase.from("contacts").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── CONSULTATIONS ─────────────────────────────────────────────────────────
app.post("/api/consultations", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { contact_id, consultation_date } = req.body || {};
  if (!contact_id) return res.status(400).json({ error: "contact_id erforderlich" });

  const insert = { contact_id };
  if (consultation_date) insert.consultation_date = consultation_date;

  const { data, error } = await supabase
    .from("consultations")
    .insert(insert)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/consultations/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { data, error } = await supabase
    .from("consultations")
    .select("*, contacts(name, initial_note)")
    .eq("id", req.params.id)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Regime einer Consultation (Quick-Access für Friction-Scan-Banner).
// Gibt { regime: "1"|"2"|"2b"|"3"|null } zurück. Graceful fallback falls
// hyp_regime-Spalte nicht migriert ist (Migration 013_consultations_hyp.sql).
app.get("/api/consultations/:id/regime", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { data, error } = await supabase
    .from("consultations")
    .select("hyp_regime")
    .eq("id", req.params.id)
    .maybeSingle();
  if (error) {
    if (/hyp_regime/.test(error.message || "")) {
      return res.json({ regime: null });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json({ regime: (data && data.hyp_regime) || null });
});

// Liste aller Consultations für den Klient eines Scans (Phase 0 Dropdown).
// Matching: scans.kunde_name → contacts.name → consultations
// Rückgabe: [{ id, consultation_date, hyp_regime }, …] (absteigend nach Datum).
app.get("/api/scans/:id/consultations", async (req, res) => {
  if (!supabase) return res.json([]);
  try {
    const scanRes = await supabase
      .from("scans").select("kunde_name").eq("id", req.params.id).maybeSingle();
    if (scanRes.error || !scanRes.data) return res.json([]);
    const kundeName = (scanRes.data.kunde_name || "").trim();
    if (!kundeName) return res.json([]);
    const contactRes = await supabase
      .from("contacts").select("id").ilike("name", kundeName).limit(1);
    if (contactRes.error || !contactRes.data || contactRes.data.length === 0) return res.json([]);
    const contactId = contactRes.data[0].id;
    const consRes = await supabase
      .from("consultations")
      .select("id, consultation_date, hyp_regime")
      .eq("contact_id", contactId)
      .order("consultation_date", { ascending: false })
      .order("created_at", { ascending: false });
    if (consRes.error) {
      // hyp_regime Spalte evtl. nicht migriert — retry ohne
      if (/hyp_regime/.test(consRes.error.message || "")) {
        const r2 = await supabase
          .from("consultations")
          .select("id, consultation_date")
          .eq("contact_id", contactId)
          .order("consultation_date", { ascending: false })
          .order("created_at", { ascending: false });
        return res.json(r2.data || []);
      }
      return res.json([]);
    }
    res.json(consRes.data || []);
  } catch (e) {
    res.json([]);
  }
});

// Convenience: findet die neueste Consultation für den Klient eines Scans
// via Name-Matching (scans.kunde_name → contacts.name → consultations).
// Rückgabe: { consultation_id, regime, consultation_date } oder { regime: null }.
// Keine FK-Spalte auf scans nötig — Name-Match genügt für den Banner-Use-Case.
app.get("/api/scans/:id/linked-regime", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  try {
    // 1. Scan laden → kunde_name holen
    const scanRes = await supabase
      .from("scans")
      .select("kunde_name")
      .eq("id", req.params.id)
      .maybeSingle();
    if (scanRes.error || !scanRes.data) return res.json({ regime: null });
    const kundeName = (scanRes.data.kunde_name || "").trim();
    if (!kundeName) return res.json({ regime: null });

    // 2. Contact mit diesem Namen finden (case-insensitive, exact match)
    const contactRes = await supabase
      .from("contacts")
      .select("id")
      .ilike("name", kundeName)
      .limit(1);
    if (contactRes.error || !contactRes.data || contactRes.data.length === 0) {
      return res.json({ regime: null });
    }
    const contactId = contactRes.data[0].id;

    // 3. Neueste Consultation für diesen Contact → hyp_regime
    const consRes = await supabase
      .from("consultations")
      .select("id, consultation_date, hyp_regime")
      .eq("contact_id", contactId)
      .order("consultation_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1);
    if (consRes.error) {
      // hyp_regime Spalte fehlt evtl. — retry ohne
      if (/hyp_regime/.test(consRes.error.message || "")) return res.json({ regime: null });
      return res.json({ regime: null });
    }
    if (!consRes.data || consRes.data.length === 0) return res.json({ regime: null });
    const c = consRes.data[0];
    res.json({
      regime: c.hyp_regime || null,
      consultation_id: c.id,
      consultation_date: c.consultation_date,
    });
  } catch (e) {
    res.json({ regime: null, error: e.message });
  }
});

app.patch("/api/consultations/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const allowed = [
    "current_phase",
    "consultation_date",
    "unternehmen",
    "abteilung",
    "phase0_notiz",
    "phase1_notes",
    "phase2_notes",
    "phase3_notes",
    "phase4_notes",
    "phase4_schritt",
    "phase4_idealzustand",
    "phase4_schritt_notizen",
    "phase5_notes",
    "phase5_mitnehmen_notizen",
    "phase5_naechster_schritt_notizen",
    "phase5_multiplikator",
    "phase5_ungesagtes",
    "transkript_analyse",
    "transkript_text",
    "completed",
    "hyp_generated",
    "hyp_regime",
    // Migration 022 — automatische Pfad-Empfehlung
    "pfad_empfehlung",
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "Keine Felder zum Update" });
  }
  // Graceful fallback falls optional-Spalten noch nicht migriert sind.
  const OPTIONAL_COLS = [
    "hyp_generated", "hyp_regime",
    "phase4_schritt", "phase4_idealzustand", "phase4_schritt_notizen",
    "phase5_mitnehmen_notizen", "phase5_naechster_schritt_notizen", "phase5_multiplikator",
    "phase5_ungesagtes",
    "unternehmen", "abteilung", "phase0_notiz",
    "transkript_analyse", "transkript_text",
    "pfad_empfehlung",
  ];
  let { data, error } = await supabase
    .from("consultations").update(updates).eq("id", req.params.id).select().single();
  if (error) {
    const msg = error.message || "";
    const missing = OPTIONAL_COLS.filter(c => msg.includes(c));
    if (missing.length > 0) {
      for (const c of missing) delete updates[c];
      if (Object.keys(updates).length === 0) {
        return res.status(500).json({ error: "Migrationen nötig: 013/014/015/018 (consultations-Spalten fehlen: " + missing.join(", ") + ")" });
      }
      const r2 = await supabase.from("consultations").update(updates).eq("id", req.params.id).select().single();
      if (r2.error) return res.status(500).json({ error: r2.error.message });
      return res.json(r2.data);
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

// ─── SCANS (Modul 2) ──────────────────────────────────────────────────────
app.post("/api/scans", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { kunde_name, datum_start, anzahl_personen, organisation, notizen } = req.body || {};
  if (!kunde_name || !kunde_name.trim()) {
    return res.status(400).json({ error: "kunde_name erforderlich" });
  }
  const insert = { kunde_name: kunde_name.trim() };
  if (datum_start) insert.datum_start = datum_start;
  if (anzahl_personen) insert.anzahl_personen = anzahl_personen;
  if (organisation) insert.organisation = organisation;
  if (notizen) insert.notizen = notizen;
  const { data, error } = await supabase.from("scans").insert(insert).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/scans", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { data, error } = await supabase
    .from("scans")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/scans/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { data, error } = await supabase
    .from("scans").select("*").eq("id", req.params.id).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch("/api/scans/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const allowed = [
    "kunde_name", "datum_start", "anzahl_personen", "status", "regime", "organisation",
    "friction_vektor", "notizen", "survey_verschickt", "survey_notizen",
    "hypothesen_spiegel_done", "hypothesen_spiegel_notizen",
    "mandatscheck_budget", "mandatscheck_personen", "mandatscheck_kein_krise",
    "current_phase", "completed",
    // Interview Kernfragen-Notizen (Migration 015)
    "interview_f1_notiz", "interview_f2_notiz",
    "interview_f3_notiz", "interview_abschluss_notiz",
    // Scan-Umbau 2026-04-17 (Migration 017)
    "linked_consultation_id", "arbeitshypothese", "friction_profil_manual_override",
    "respondent_ceo_status", "respondent_fk_status", "respondent_op_status",
    "respondent_ceo_kuerzel", "respondent_fk_kuerzel", "respondent_op_kuerzel",
    "respondent_ceo_deadline", "respondent_fk_deadline", "respondent_op_deadline",
    "respondent_ceo_verschickt", "respondent_fk_verschickt", "respondent_op_verschickt",
    // Migration 020
    "regime_begruendung",
    // Migration 022 — automatische Pfad-Empfehlung
    "pfad_empfehlung",
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "Keine Felder zum Update" });
  }
  // Graceful Update: wenn eine Spalte fehlt, strippen wir nicht-existente
  // Felder und versuchen erneut. So bricht die App nicht, wenn Migration 015
  // oder 017 noch nicht ausgeführt wurde.
  const MIGRATION_017_COLS = [
    "linked_consultation_id", "arbeitshypothese", "friction_profil_manual_override",
    "respondent_ceo_status", "respondent_fk_status", "respondent_op_status",
    "respondent_ceo_kuerzel", "respondent_fk_kuerzel", "respondent_op_kuerzel",
    "respondent_ceo_deadline", "respondent_fk_deadline", "respondent_op_deadline",
    "respondent_ceo_verschickt", "respondent_fk_verschickt", "respondent_op_verschickt",
  ];
  const MIGRATION_015_COLS = [
    "interview_f1_notiz", "interview_f2_notiz",
    "interview_f3_notiz", "interview_abschluss_notiz",
  ];
  const MIGRATION_020_COLS = [
    "regime_begruendung",
  ];
  const MIGRATION_022_COLS = [
    "pfad_empfehlung",
  ];
  async function tryUpdate(u) {
    return supabase.from("scans").update(u).eq("id", req.params.id).select().single();
  }
  let { data, error } = await tryUpdate(updates);
  if (error) {
    const msg = error.message || "";
    const m017 = MIGRATION_017_COLS.some(c => msg.includes(c));
    const m015 = MIGRATION_015_COLS.some(c => msg.includes(c));
    const m020 = MIGRATION_020_COLS.some(c => msg.includes(c));
    const m022 = MIGRATION_022_COLS.some(c => msg.includes(c));
    if (m017 || m015 || m020 || m022) {
      const stripped = { ...updates };
      if (m017) for (const c of MIGRATION_017_COLS) delete stripped[c];
      if (m015) for (const c of MIGRATION_015_COLS) delete stripped[c];
      if (m020) for (const c of MIGRATION_020_COLS) delete stripped[c];
      if (m022) for (const c of MIGRATION_022_COLS) delete stripped[c];
      if (Object.keys(stripped).length === 0) {
        return res.status(500).json({ error: "Migration 015, 017, 020 oder 022 nötig (scans neue Spalten)" });
      }
      const r2 = await tryUpdate(stripped);
      if (r2.error) return res.status(500).json({ error: r2.error.message });
      return res.json(r2.data);
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

app.delete("/api/scans/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { error } = await supabase.from("scans").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── SCAN AMPELN ──────────────────────────────────────────────────────────
app.get("/api/scans/:id/ampeln", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { data, error } = await supabase
    .from("scan_ampeln").select("*").eq("scan_id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put("/api/scans/:id/ampeln", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { ampeln } = req.body || {};
  if (!Array.isArray(ampeln)) return res.status(400).json({ error: "ampeln array erforderlich" });

  const rows = ampeln.map(a => ({
    scan_id: req.params.id,
    layer: a.layer,
    achse: a.achse,
    wert: a.wert,
    phase: a.phase || "survey",
  }));

  const { data, error } = await supabase
    .from("scan_ampeln")
    .upsert(rows, { onConflict: "scan_id,layer,achse,phase" })
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── INTERVIEWS ───────────────────────────────────────────────────────────
app.get("/api/scans/:id/interviews", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { data, error } = await supabase
    .from("interviews").select("*, omission_bias_checks(*)")
    .eq("scan_id", req.params.id).order("slot_nr");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/scans/:id/interviews", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { slot_nr, rolle } = req.body || {};
  const insert = { scan_id: req.params.id, slot_nr: slot_nr || 1 };
  if (rolle) insert.rolle = rolle;
  const { data, error } = await supabase.from("interviews").insert(insert).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch("/api/scans/:sid/interviews/:iid", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const allowed = [
    "rolle", "datum", "audio_typ",
    "primaer_aufnahme", "backup_aufnahme", "einwilligung",
    "audio_gesichert", "whisper_laeuft", "transkript_vault",
    "notizen", "plan_b_aktiv",
    "plan_b_wichtigste_aussage", "plan_b_ton_wechsel",
    "plan_b_nicht_gesagt", "plan_b_layer",
    // Migration 022 — eigene Spalte fuer Interview-Abschlussfrage "Ungesagtes".
    "ungesagtes",
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "Keine Felder zum Update" });
  }
  // Graceful-Fallback: wenn Migration 022 noch nicht ausgefuehrt wurde,
  // strippe "ungesagtes" und versuche erneut. Datensatz bleibt speicherbar.
  const MIGRATION_022_COLS = ["ungesagtes"];
  let { data, error } = await supabase
    .from("interviews").update(updates).eq("id", req.params.iid).select().single();
  if (error) {
    const msg = error.message || "";
    if (MIGRATION_022_COLS.some(c => msg.includes(c))) {
      const stripped = { ...updates };
      for (const c of MIGRATION_022_COLS) delete stripped[c];
      if (Object.keys(stripped).length === 0) {
        return res.status(500).json({ error: "Migration 022 nötig (interviews.ungesagtes fehlt)" });
      }
      const r2 = await supabase
        .from("interviews").update(stripped).eq("id", req.params.iid).select().single();
      if (r2.error) return res.status(500).json({ error: r2.error.message });
      return res.json(r2.data);
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

// ─── OMISSION BIAS CHECKS ────────────────────────────────────────────────
app.put("/api/scans/:sid/interviews/:iid/bias", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const allowed = [
    "biologische_last", "systemsprache", "geschuetzte_kollegen",
    "antrieb_gefragt", "ton_wechsel", "ton_wechsel_timestamp",
  ];
  const row = { interview_id: req.params.iid };
  for (const key of allowed) {
    if (req.body[key] !== undefined) row[key] = req.body[key];
  }
  const { data, error } = await supabase
    .from("omission_bias_checks")
    .upsert(row, { onConflict: "interview_id" })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── HYPOTHESEN ──────────────────────────────────────────────────────────
app.get("/api/scans/:id/hypothesen", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { data, error } = await supabase
    .from("hypothesen").select("*").eq("scan_id", req.params.id).order("slot_nr");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/scans/:id/hypothesen", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { slot_nr, layer, mechanismus, evidenz_zitat, testfrage } = req.body || {};
  const insert = {
    scan_id: req.params.id,
    slot_nr: slot_nr || 1,
    layer: layer || "",
    mechanismus: mechanismus || "",
    evidenz_zitat: evidenz_zitat || "",
    testfrage: testfrage || "",
  };
  const { data, error } = await supabase.from("hypothesen").insert(insert).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch("/api/scans/:sid/hypothesen/:hid", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const allowed = ["layer", "mechanismus", "evidenz_zitat", "testfrage", "bestaetigt"];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  const { data, error } = await supabase
    .from("hypothesen").update(updates).eq("id", req.params.hid).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── BEFUND MASSNAHMEN ───────────────────────────────────────────────────
app.get("/api/scans/:id/massnahmen", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { data, error } = await supabase
    .from("befund_massnahmen").select("*").eq("scan_id", req.params.id).order("slot_nr");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/scans/:id/massnahmen", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { slot_nr, layer, massnahme, zeitrahmen } = req.body || {};
  const insert = {
    scan_id: req.params.id,
    slot_nr: slot_nr || 1,
    layer: layer || "",
    massnahme: massnahme || "",
    zeitrahmen: zeitrahmen || "",
  };
  const { data, error } = await supabase.from("befund_massnahmen").insert(insert).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch("/api/scans/:sid/massnahmen/:mid", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const allowed = ["layer", "massnahme", "zeitrahmen"];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  const { data, error } = await supabase
    .from("befund_massnahmen").update(updates).eq("id", req.params.mid).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── PAI ──────────────────────────────────────────────────────────────────
// PAI Sessions
// ?tool=interview|audit filters by tool_type. Default = 'interview' for
// backward compat with existing PAI Interview tab.
app.get("/api/pai/sessions", async (req, res) => {
  if (!supabase) return res.json([]);
  const tool = (req.query.tool || "interview").toLowerCase();
  const { data, error } = await supabase
    .from("pai_sessions")
    .select("*")
    .eq("tool_type", tool)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/pai/sessions", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { person_name, person_rolle, tool_type } = req.body;
  if (!person_name) return res.status(400).json({ error: "person_name erforderlich" });
  const { data, error } = await supabase
    .from("pai_sessions")
    .insert([{
      person_name,
      person_rolle: person_rolle || null,
      tool_type: tool_type === "audit" ? "audit" : "interview",
    }])
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch("/api/pai/sessions/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const allowed = [
    "person_name", "person_rolle", "status", "current_phase",
    // PAI Umbau 2026-04-17 — Phase 2/4 Felder auf pai_sessions
    "pai_transkript_analyse", "pai_abschluss_ampeln", "pai_next_session",
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase
    .from("pai_sessions").update(updates).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/api/pai/sessions/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { error } = await supabase.from("pai_sessions").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// PAI Erhebungsdaten (Auto-Save)
app.post("/api/pai/erhebung", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { session_id, phase, feld, wert } = req.body;
  if (!session_id || phase === undefined || !feld) return res.status(400).json({ error: "session_id, phase, feld erforderlich" });
  const { data, error } = await supabase
    .from("pai_erhebung")
    .upsert(
      { session_id, phase, feld, wert: wert || "", updated_at: new Date().toISOString() },
      { onConflict: "session_id,phase,feld" }
    )
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/pai/erhebung/:session_id", async (req, res) => {
  if (!supabase) return res.json([]);
  const { data, error } = await supabase
    .from("pai_erhebung")
    .select("*")
    .eq("session_id", req.params.session_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PAI Ampeln
app.put("/api/pai/ampeln/:session_id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { ampeln } = req.body;
  if (!Array.isArray(ampeln)) return res.status(400).json({ error: "ampeln array erforderlich" });
  const rows = ampeln.map(a => ({
    session_id: req.params.session_id,
    layer: a.layer,
    achse: a.achse,
    status: a.status || "gruen",
    notiz: a.notiz || null,
  }));
  const { error } = await supabase
    .from("pai_ampeln")
    .upsert(rows, { onConflict: "session_id,layer,achse" });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.get("/api/pai/ampeln/:session_id", async (req, res) => {
  if (!supabase) return res.json([]);
  const { data, error } = await supabase
    .from("pai_ampeln")
    .select("*")
    .eq("session_id", req.params.session_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PAI KPIs
app.put("/api/pai/kpis/:session_id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { kpis } = req.body;
  if (!Array.isArray(kpis)) return res.status(400).json({ error: "kpis array erforderlich" });
  const rows = kpis.map(k => ({
    session_id: req.params.session_id,
    kpi_key: k.kpi_key,
    wert: k.wert || 0,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase
    .from("pai_kpis")
    .upsert(rows, { onConflict: "session_id,kpi_key" });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.get("/api/pai/kpis/:session_id", async (req, res) => {
  if (!supabase) return res.json([]);
  const { data, error } = await supabase
    .from("pai_kpis")
    .select("*")
    .eq("session_id", req.params.session_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PAI Audit — ADA Vor-Analyse
// Lädt alle pai_erhebung-Felder der Session, baut Prompt, ruft Claude auf,
// parst JSON, persistiert in pai_sessions.ada_analysis.
app.post("/api/pai/audit/analyze", async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: "ANTHROPIC_API_KEY nicht konfiguriert" });
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { session_id } = req.body || {};
  if (!session_id) return res.status(400).json({ error: "session_id erforderlich" });

  // 1. Session laden
  const { data: session, error: sessErr } = await supabase
    .from("pai_sessions").select("*").eq("id", session_id).single();
  if (sessErr || !session) return res.status(404).json({ error: "Session nicht gefunden" });

  // 2. Alle Audit-Felder laden
  const { data: fields, error: fldErr } = await supabase
    .from("pai_erhebung").select("*").eq("session_id", session_id).order("phase");
  if (fldErr) return res.status(500).json({ error: fldErr.message });

  if (!fields || fields.length === 0) {
    return res.status(400).json({ error: "Keine Antworten zum Analysieren vorhanden" });
  }

  // 3. Input-Text bauen
  const answerBlob = fields
    .map(f => `[Phase ${f.phase} · ${f.feld}]\n${f.wert || "(leer)"}`)
    .join("\n\n");

  const userMsg = `Person: ${session.person_name}${session.person_rolle ? ", " + session.person_rolle : ""}

PAI Audit Antworten:

${answerBlob}

Analysiere das Audit und gib JSON im spezifizierten Format zurück.`;

  // 4. Anthropic call mit Retry (gleiches Pattern wie /api/ada/chat)
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        system: PAI_AUDIT_ANALYZER_PROMPT,
        messages: [{ role: "user", content: userMsg }],
      });

      const text = response.content
        .filter(c => c.type === "text")
        .map(c => c.text)
        .join("");

      // 5. JSON-Parse mit Fallback
      let parsed = null;
      try {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
      } catch (e) {
        parsed = null;
      }

      const analysis = parsed && typeof parsed === "object"
        ? parsed
        : { raw_text: text, parse_error: true };

      // 6. Persistieren
      await supabase
        .from("pai_sessions")
        .update({ ada_analysis: analysis, updated_at: new Date().toISOString() })
        .eq("id", session_id);

      return res.json(analysis);
    } catch (e) {
      const isOverloaded = e.status === 529 || (e.message && e.message.includes("529"));
      const isRateLimit = e.status === 429;
      if ((isOverloaded || isRateLimit) && attempt < maxRetries) {
        const wait = attempt * 2000;
        console.warn(`PAI Audit analyze attempt ${attempt}/${maxRetries} failed (${e.status || "?"}), retrying in ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      console.error("PAI Audit analyze error:", e.message);
      const userMsgErr = isOverloaded
        ? "Claude ist gerade überlastet. Bitte in 30 Sekunden nochmal versuchen."
        : isRateLimit
        ? "Zu viele Anfragen. Bitte kurz warten."
        : "Analyse-Fehler: " + e.message;
      return res.status(500).json({ error: userMsgErr });
    }
  }
});

// ─── AUSWERTUNGEN ─────────────────────────────────────────────────────────
// Interne Arbeitsansicht pro Scan. Tabelle "auswertungen" mit JSONB-Feldern
// (friction_points, befund_entwurf) + routing_empfehlung TEXT.
// Schema siehe supabase/migrations/008_auswertungen.sql.

// GET /api/auswertungen/:scan_id → lädt die Auswertung für einen Scan
// (oder null/404 wenn noch keine existiert)
app.get("/api/auswertungen/:scan_id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { data, error } = await supabase
    .from("auswertungen")
    .select("*")
    .eq("scan_id", req.params.scan_id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || null);
});

// POST /api/auswertungen → legt eine neue Auswertung an
app.post("/api/auswertungen", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { scan_id, friction_points, befund_entwurf, routing_empfehlung } = req.body || {};
  if (!scan_id) return res.status(400).json({ error: "scan_id erforderlich" });
  const insert = {
    scan_id,
    friction_points: friction_points || {},
    befund_entwurf: befund_entwurf || {},
    routing_empfehlung: routing_empfehlung || "",
  };
  const { data, error } = await supabase
    .from("auswertungen")
    .insert(insert)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /api/auswertungen/:id → updated bestehende Auswertung
app.patch("/api/auswertungen/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const allowed = ["friction_points", "befund_entwurf", "routing_empfehlung", "interventions_notizen"];
  const updates = {};
  for (const k of allowed) {
    if (k in (req.body || {})) updates[k] = req.body[k];
  }
  updates.updated_at = new Date().toISOString();
  let { data, error } = await supabase
    .from("auswertungen")
    .update(updates)
    .eq("id", req.params.id)
    .select()
    .single();
  if (error && updates.interventions_notizen !== undefined
      && /interventions_notizen/.test(error.message || "")) {
    // Column missing — retry without it so other fields still update.
    // Migration 011_interventions_notizen.sql adds the column.
    delete updates.interventions_notizen;
    const r2 = await supabase
      .from("auswertungen")
      .update(updates)
      .eq("id", req.params.id)
      .select()
      .single();
    if (r2.error) return res.status(500).json({ error: r2.error.message });
    return res.json(r2.data);
  }
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── TALLY WEBHOOK ────────────────────────────────────────────────────────
// Empfaengt Tally Form Submissions, normalisiert sie auf F1-F12 → NELION-Achsen,
// berechnet Score (1-10) und Ampel pro Achse, schreibt in tally_submissions.
// Webhook-URL fuer Tally: https://nelion-app.onrender.com/webhook/tally
// Schema siehe supabase/migrations/012_tally_submissions.sql.

// F-Nummer → { layer, achse } (interne Achsen-Keys aus AMPEL_AXES im Frontend)
const TALLY_F_TO_AXIS = {
  F1:  { layer: "L1",  achse: "Allostatic Load" },          // Neurobiologische Last
  F2:  { layer: "L1",  achse: "Energie-Status" },           // Energiereserven
  F3:  { layer: "L1b", achse: "Anforderungs-Ressourcen-Ungleichgewicht" }, // Strukturelle Ueberlastung
  F4:  { layer: "L1b", achse: "Erholungsstruktur" },        // Regenerationsdefizit (Erholung)
  F4b: { layer: "L1b", achse: "Schlafqualität" },           // Regenerationsdefizit (Schlaf) — A/B/C/D Letter-Scoring
  F5:  { layer: "L2",  achse: "Psychological Safety" },     // Selbstzensur
  F6:  { layer: "L2",  achse: "Immunity-Muster" },          // Veraenderungsresistenz
  F7:  { layer: "L2",  achse: "Attribution Style" },        // Verantwortungsvermeidung
  F8:  { layer: "L2",  achse: "Threat-State" },             // Irritabilitaet
  F9:  { layer: "L3",  achse: "Entscheidungsarchitektur" }, // Fehlentscheidungskosten
  F10: { layer: "L3",  achse: "Incentive-Struktur" },       // Dysfunktionale Anreize
  F11: { layer: "L3",  achse: "Strukturelle Ambiguität" },  // Verantwortungsvakuum
  F12: { layer: "L3",  achse: "Informationsfluss" },        // Informationsblockaden
  F13: { layer: "L1b", achse: "Schlafqualität" },           // Regenerationsdefizit (Schlaf)
};

function tallyScoreToAmpel(score) {
  if (score == null || isNaN(score)) return "grau";
  if (score >= 7) return "gruen";
  if (score >= 4) return "gelb";
  return "rot";
}

// Extrahiert numerischen Wert aus diversen Tally-Feld-Typen.
function extractTallyNumber(field) {
  const v = field?.value;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (!isNaN(n)) return n;
  }
  if (Array.isArray(v) && v.length > 0) {
    const first = v[0];
    if (typeof first === "number") return first;
    if (typeof first === "string") {
      const n = Number(first);
      if (!isNaN(n)) return n;
    }
    if (field.options && Array.isArray(field.options)) {
      const opt = field.options.find(o => o.id === first || o.value === first);
      if (opt && typeof opt.value === "number") return opt.value;
      // Manche Tally-Optionen kodieren den Score im Text (z.B. "7 — eher hoch")
      if (opt && typeof opt.text === "string") {
        const m = opt.text.match(/^(\d{1,2})/);
        if (m) return Number(m[1]);
      }
    }
  }
  return null;
}

// F4b (Schlafqualität) nutzt A/B/C/D-Multiple-Choice statt Linear Scale.
// A=Gut→9 (gruen), B=Gemischt→6 (gelb), C=Schlecht→3 (rot), D=Sehr schlecht→1 (rot).
const F4B_LETTER_TO_SCORE = { A: 9, B: 6, C: 3, D: 1 };

function extractLetterScore(field) {
  let v = field?.value;
  if (Array.isArray(v) && v.length > 0) v = v[0];
  if (field?.options && Array.isArray(field.options)) {
    const opt = field.options.find(o => o.id === v || o.value === v);
    if (opt) {
      const txt = String(opt.text ?? opt.value ?? "").trim();
      const letter = txt.charAt(0).toUpperCase();
      if (F4B_LETTER_TO_SCORE[letter] != null) return F4B_LETTER_TO_SCORE[letter];
    }
  }
  if (typeof v === "string") {
    const letter = v.trim().charAt(0).toUpperCase();
    if (F4B_LETTER_TO_SCORE[letter] != null) return F4B_LETTER_TO_SCORE[letter];
  }
  return null;
}

// Mappt Rohwert auf 1-10 (Tally LINEAR_SCALE liefert ueblicherweise schon 1-10).
function normalizeTallyScore(raw) {
  if (raw == null || isNaN(raw)) return null;
  const n = Number(raw);
  if (n < 1) return 1;
  if (n > 10) return 10;
  return Math.round(n);
}

function parseRespondentRolle(fields) {
  for (const f of fields) {
    const label = (f.label || f.title || f.key || "").toLowerCase();
    if (!(label.includes("rolle") || /\bf0\b/i.test(label) || label.includes("position"))) continue;
    let v = f.value;
    if (Array.isArray(v) && v.length > 0) v = v[0];
    // Wenn Multiple-Choice mit Options-IDs: in Text aufloesen
    if (f.options && Array.isArray(f.options)) {
      const opt = f.options.find(o => o.id === v || o.value === v);
      if (opt && opt.text) v = opt.text;
    }
    const s = String(v || "").toLowerCase();
    if (s.includes("ceo") || s.includes("geschäft") || s.includes("geschaeft") || s.includes("inhaber")) return "CEO";
    if (s.includes("führung") || s.includes("fuehrung") || s === "fk" || s.includes("leitung")) return "FK";
    if (s.includes("operativ") || s.includes("mitarbeit") || s.includes("team")) return "Operativ";
  }
  return "unbekannt";
}

function parseAuswertungIdHidden(fields) {
  for (const f of fields) {
    const key = (f.key || f.label || "").toLowerCase();
    if (!(key.includes("auswertung_id") || key === "auswertung")) continue;
    const v = Array.isArray(f.value) ? f.value[0] : f.value;
    if (v && typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v.trim())) {
      return v.trim();
    }
  }
  return null;
}

function processTallyPayload(payload) {
  const data = payload?.data || payload || {};
  const fields = Array.isArray(data.fields) ? data.fields : [];
  const submission_id = data.submissionId || data.responseId || payload?.eventId || null;

  const scores = {};
  const ampeln = {};

  for (const f of fields) {
    const label = (f.label || f.title || f.key || "");
    // F-Nummer mit optionalem "b"-Suffix (F4b); Fallback: Label "Schlafqualität" → F4b
    const m = label.match(/F(\d{1,2})(b?)\b/i);
    let fKey;
    if (m) {
      fKey = `F${parseInt(m[1], 10)}${(m[2] || "").toLowerCase()}`;
    } else if (/schlafqualit[äa]t/i.test(label)) {
      fKey = "F4b";
    } else {
      continue;
    }
    if (!TALLY_F_TO_AXIS[fKey]) continue;
    // F4b: Letter-Scoring (A/B/C/D). Alle anderen: Linear Scale 1-10.
    const score = fKey === "F4b"
      ? extractLetterScore(f)
      : normalizeTallyScore(extractTallyNumber(f));
    if (score == null) continue;
    scores[fKey] = score;
    ampeln[fKey] = tallyScoreToAmpel(score);
  }

  return {
    submission_id,
    scores,
    ampeln,
    respondent_rolle: parseRespondentRolle(fields),
    auswertung_id: parseAuswertungIdHidden(fields),
  };
}

app.post("/webhook/tally", async (req, res) => {
  try {
    const payload = req.body || {};
    const processed = processTallyPayload(payload);

    if (!processed.submission_id || Object.keys(processed.scores).length === 0) {
      console.warn("Tally webhook: ungueltige oder leere Payload (submission_id/scores fehlen)");
      return res.status(400).json({ error: "ungueltige Payload" });
    }

    if (!supabase) {
      console.warn("Tally webhook: Supabase nicht konfiguriert");
      return res.status(503).json({ error: "Supabase nicht konfiguriert" });
    }

    const insert = {
      auswertung_id: processed.auswertung_id,
      submission_id: processed.submission_id,
      respondent_rolle: processed.respondent_rolle,
      rohdaten: payload,
      scores: processed.scores,
      ampeln: processed.ampeln,
    };

    const { data, error } = await supabase
      .from("tally_submissions").insert(insert).select().single();
    if (error) {
      console.error("Tally webhook: Supabase-Fehler:", error.message);
      return res.status(500).json({ error: error.message });
    }
    console.log(`Tally webhook: Submission ${processed.submission_id} gespeichert (id=${data.id}, rolle=${processed.respondent_rolle})`);
    res.status(200).json({ ok: true, id: data.id });
  } catch (e) {
    console.error("Tally webhook: Crash:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// "unassigned" muss VOR /:auswertung_id deklariert werden, sonst matcht der UUID-Param.
app.get("/api/tally/submissions/unassigned", async (req, res) => {
  if (!supabase) return res.json([]);
  const { data, error } = await supabase
    .from("tally_submissions").select("*")
    .is("auswertung_id", null)
    .order("eingegangen_am", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get("/api/tally/submissions/:auswertung_id", async (req, res) => {
  if (!supabase) return res.json([]);
  const { data, error } = await supabase
    .from("tally_submissions").select("*")
    .eq("auswertung_id", req.params.auswertung_id)
    .order("eingegangen_am", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.patch("/api/tally/submissions/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const allowed = ["respondent_rolle", "auswertung_id"];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "Keine Felder zum Update" });
  }
  const { data, error } = await supabase
    .from("tally_submissions").update(updates).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── TASKS ────────────────────────────────────────────────────────────────
// NOTE: Requires `position` column for drag-and-drop ordering.
// See supabase/migrations/009_tasks_position.sql. One-time migration:
//   ALTER TABLE tasks ADD COLUMN IF NOT EXISTS position INTEGER;
// Without the column the server falls back to prioritaet + created_at order,
// and reorder silently no-ops while delete/rename/add still work.
app.get("/api/tasks", async (req, res) => {
  if (!supabase) return res.json([]);
  // Primary order: position (drag-and-drop). Fallback: prioritaet, created_at.
  let query = supabase.from("tasks").select("*")
    .order("position", { ascending: true, nullsFirst: false })
    .order("prioritaet", { ascending: true })
    .order("created_at", { ascending: false });
  if (req.query.status) query = query.eq("status", req.query.status);
  let { data, error } = await query;
  if (error) {
    // position column may not exist yet — retry without it
    let q2 = supabase.from("tasks").select("*")
      .order("prioritaet", { ascending: true })
      .order("created_at", { ascending: false });
    if (req.query.status) q2 = q2.eq("status", req.query.status);
    const r2 = await q2;
    if (r2.error) return res.json([]);
    data = r2.data;
  }
  res.json(data);
});

app.post("/api/tasks", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { titel, prioritaet, deadline, gate_bezug, ada_vorschlag, nathalie_approved, position } = req.body || {};
  if (!titel) return res.status(400).json({ error: "titel erforderlich" });

  // Auto-assign position = MAX(position) + 10 so new tasks land at the end.
  // If the position column doesn't exist yet, the insert still succeeds
  // because we only include it in the insert payload when we have a number.
  let nextPosition = typeof position === "number" ? position : null;
  if (nextPosition == null) {
    try {
      const r = await supabase
        .from("tasks")
        .select("position")
        .order("position", { ascending: false, nullsFirst: false })
        .limit(1);
      if (!r.error && r.data && r.data.length > 0 && r.data[0].position != null) {
        nextPosition = r.data[0].position + 10;
      }
    } catch {}
  }

  const payload = {
    titel,
    prioritaet: prioritaet || 2,
    deadline: deadline || null,
    gate_bezug: gate_bezug || null,
    ada_vorschlag: ada_vorschlag || false,
    nathalie_approved: nathalie_approved !== undefined ? nathalie_approved : true,
  };
  if (nextPosition != null) payload.position = nextPosition;

  let { data, error } = await supabase.from("tasks").insert(payload).select().single();
  if (error && payload.position !== undefined && /position/.test(error.message || "")) {
    // column missing — retry without position
    delete payload.position;
    const r2 = await supabase.from("tasks").insert(payload).select().single();
    if (r2.error) return res.status(500).json({ error: r2.error.message });
    return res.json(r2.data);
  }
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch("/api/tasks/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const allowed = ["titel", "prioritaet", "deadline", "gate_bezug", "status", "ada_vorschlag", "nathalie_approved", "position", "notiz"];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  let { data, error } = await supabase.from("tasks").update(updates).eq("id", req.params.id).select().single();
  if (error && updates.position !== undefined && /position/.test(error.message || "")) {
    // column missing — retry without position so other fields still update
    delete updates.position;
    const r2 = await supabase.from("tasks").update(updates).eq("id", req.params.id).select().single();
    if (r2.error) return res.status(500).json({ error: r2.error.message });
    return res.json(r2.data);
  }
  if (error && updates.notiz !== undefined && /notiz/.test(error.message || "")) {
    // Migration 021 noch nicht ausgeführt — ohne notiz retry
    delete updates.notiz;
    if (Object.keys(updates).length === 0) {
      return res.status(500).json({ error: "Migration 021 nötig: tasks.notiz Spalte fehlt" });
    }
    const r3 = await supabase.from("tasks").update(updates).eq("id", req.params.id).select().single();
    if (r3.error) return res.status(500).json({ error: r3.error.message });
    return res.json(r3.data);
  }
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/api/tasks/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { error } = await supabase.from("tasks").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── ADA SESSIONS ─────────────────────────────────────────────────────────
app.get("/api/ada/sessions", async (req, res) => {
  if (!supabase) return res.json([]);
  // Try with title column first, fall back without it
  let { data, error } = await supabase.from("ada_sessions").select("id, scan_id, created_at, updated_at, title").order("updated_at", { ascending: false });
  if (error) {
    // title column may not exist yet — retry without it
    const r2 = await supabase.from("ada_sessions").select("id, scan_id, created_at, updated_at").order("updated_at", { ascending: false });
    if (r2.error) return res.json([]);
    data = (r2.data || []).map(s => ({ ...s, title: "Session" }));
  }
  res.json(data);
});

app.post("/api/ada/sessions", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { scan_id, title } = req.body || {};
  // Try with title, fall back without
  let ins = { scan_id: scan_id || null, messages: [] };
  let { data, error } = await supabase.from("ada_sessions").insert({ ...ins, title: title || "Neue Session" }).select().single();
  if (error && error.message.includes("title")) {
    const r2 = await supabase.from("ada_sessions").insert(ins).select().single();
    if (r2.error) return res.status(500).json({ error: r2.error.message });
    data = { ...r2.data, title: title || "Neue Session" };
  } else if (error) {
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

app.get("/api/ada/sessions/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { data, error } = await supabase.from("ada_sessions").select("*").eq("id", req.params.id).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put("/api/ada/sessions/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const allowed = ["messages", "title", "scan_id"];
  const updates = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  let { data, error } = await supabase.from("ada_sessions").update(updates).eq("id", req.params.id).select().single();
  if (error && updates.title && error.message.includes("title")) {
    delete updates.title;
    const r2 = await supabase.from("ada_sessions").update(updates).eq("id", req.params.id).select().single();
    if (r2.error) return res.status(500).json({ error: r2.error.message });
    data = r2.data;
  } else if (error) {
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

app.delete("/api/ada/sessions/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { error } = await supabase.from("ada_sessions").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── ADA MEMORY ENDPOINTS ─────────────────────────────────────────────────

// Load shared memory (NATHALIE_MEMORY.md)
app.get("/api/ada/memory", async (req, res) => {
  try {
    const { content, sha } = await githubGetMemoryFile();
    res.json({
      memory: content || "# NATHALIE MEMORY\nErste Session noch nicht gestartet.",
      sha,
      loaded: !!content,
    });
  } catch (err) {
    console.error("ADA memory load error:", err.message);
    res.json({ memory: null, sha: null, loaded: false, error: err.message });
  }
});

// Write memory update (append, not overwrite)
app.post("/api/ada/memory/save", async (req, res) => {
  const { updateBlock } = req.body;
  if (!updateBlock) return res.status(400).json({ error: "updateBlock erforderlich" });

  try {
    const { content: existing, sha } = await githubGetMemoryFile();
    const newContent = `${updateBlock}\n\n---\n\n${existing || ""}`;
    await githubPutMemoryFile(
      newContent,
      sha,
      `ADA memory update ${new Date().toISOString().slice(0, 10)}`
    );
    res.json({ success: true });
  } catch (err) {
    console.error("ADA memory save error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── ADA CHAT ─────────────────────────────────────────────────────────────
app.post("/api/ada/chat", async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: "ANTHROPIC_API_KEY nicht konfiguriert" });
  const { messages, scan_context, memory } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array erforderlich" });
  }

  // Build system prompt: Master Context (dynamisch) + ADA-spezifisch + Memory + Scan-Kontext
  // Reihenfolge: NELION_MASTER_CONTEXT (Supabase/GitHub/lokal) zuerst, dann ADA-Prompt.
  // Falls dynamisches Laden fehlschlägt: hardcodierter ADA-Prompt reicht aus.
  let systemPrompt = "";
  try {
    const masterContext = await loadNelionContext();
    if (masterContext) {
      systemPrompt += `─── NELION MASTER CONTEXT (read-only) ───\n${masterContext}\n─── ENDE CONTEXT ───\n\n`;
    }
  } catch (e) {
    console.warn("Master Context fetch failed:", e.message);
  }
  systemPrompt += ADA_SYSTEM_PROMPT;

  // 2. Shared Memory (NATHALIE_MEMORY.md)
  if (memory) {
    systemPrompt += `\n\n─── NATHALIE MEMORY (geteilt mit NOS) ───\n${memory}\n─── ENDE MEMORY ───`;
  }

  // 3. Dynamic Scan Context — erweitert um Tab, letzte Aktion, Scan-ID für
  // kontextgebundene Calls aus dem Floating-Overlay und vom ❓-Icon.
  if (scan_context) {
    const lines = [];
    if (scan_context.kunde)       lines.push(`Kunde: ${scan_context.kunde}`);
    if (scan_context.phase)       lines.push(`Phase: ${scan_context.phase}`);
    if (scan_context.status)      lines.push(`Status: ${scan_context.status}`);
    if (scan_context.scan_id)     lines.push(`Scan-ID: ${scan_context.scan_id}`);
    if (scan_context.tab)         lines.push(`Aktiver Tab: ${scan_context.tab}`);
    if (scan_context.last_action) lines.push(`Letzte Aktion: ${scan_context.last_action}`);
    if (scan_context.field_label) lines.push(`Nachgefragtes Feld: ${scan_context.field_label}`);
    if (lines.length > 0) {
      systemPrompt += `\n\n─── SCAN-KONTEXT ───\n${lines.join("\n")}\n─── ENDE SCAN-KONTEXT ───`;
    }
  }

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        system: systemPrompt,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      });

      const text = response.content
        .filter(c => c.type === "text")
        .map(c => c.text)
        .join("");

      return res.json({ role: "assistant", content: text });
    } catch (e) {
      const isOverloaded = e.status === 529 || (e.message && e.message.includes("529"));
      const isRateLimit = e.status === 429;
      if ((isOverloaded || isRateLimit) && attempt < maxRetries) {
        const wait = attempt * 2000;
        console.warn(`ADA attempt ${attempt}/${maxRetries} failed (${e.status || "?"}), retrying in ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      console.error("ADA error:", e.message);
      const userMsg = isOverloaded
        ? "Claude ist gerade überlastet. Bitte in 30 Sekunden nochmal versuchen."
        : isRateLimit
        ? "Zu viele Anfragen. Bitte kurz warten."
        : "ADA-Fehler: " + e.message;
      return res.status(500).json({ error: userMsg });
    }
  }
});

// ─── ADA INTERVENTIONS ────────────────────────────────────────────────────
// Generiert strukturierte Interventions-Empfehlungen fuer den Interventionen-Tab.
// Input: 3 Haupt-Friction-Points + Regime + Klienten-Name.
// Output: JSON-Array mit Empfehlungen (typ, was, warum, wann, wann_nicht,
// spezialist_profil, spezialist_begruendung, regime_check).
// Empfehlungen werden NICHT persistiert — session-temporaer im Frontend.
app.post("/api/ada/interventions", async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: "ANTHROPIC_API_KEY nicht konfiguriert" });
  const { friction_points, regime, kunde_name } = req.body || {};
  if (!Array.isArray(friction_points) || friction_points.length === 0) {
    return res.status(400).json({ error: "friction_points array erforderlich" });
  }

  const fpBlock = friction_points.map((fp, i) =>
    `${i + 1}. Layer ${fp.layer} — ${fp.achse} — Ampel: ${fp.wert}`
  ).join("\n");

  // NELION Master Context (read-only) as additional context
  let masterCtx = "";
  try {
    const { content } = await githubGetContextFile();
    if (content) masterCtx = `\n\n─── NELION MASTER CONTEXT (read-only) ───\n${content}\n─── ENDE CONTEXT ───`;
  } catch {}

  const systemPrompt = `Du bist ADA und generierst strukturierte Interventions-Empfehlungen für den Organizational Friction Scan bei ${kunde_name || "Klient"}.

Input: 3 Haupt-Friction-Points (Layer, Achse, Ampel) + aktuelles Pfad-Routing.

Für JEDEN Friction-Point gib zurück:
  - layer: "L1" | "L1b" | "L2" | "L3" (wie im Input)
  - achse: Achsen-Name (wie im Input)
  - wert: "rot" | "gelb" (wie im Input)
  - typ: Interventions-Name. Nutze primär diese Vault-Bibliothek:
    L1 → Workload-Reduktion / Regenerationsstruktur / Kapazitätsplanung / neurologische Entlastung
    L2 → Psychological Safety Aufbau / Immunity-to-Change Arbeit / Attribution Training / Threat-State Deeskalation
    L3 → Entscheidungsarchitektur-Redesign / Incentive-Struktur-Audit / Rollenklärung + Verantwortungsmatrix / Informationsfluss-Mapping
  - was: 2–3 Sätze (konkrete Beschreibung der Intervention)
  - warum: Theorie/Methode mit Autor + Validitäts-Status (★★★ validiert / ★★☆ emerging / ★☆☆ proprietär)
  - wann: Bedingungen, unter denen die Intervention wirkt
  - wann_nicht: Kontraindikationen
  - spezialist_profil: genau einer von ["OE-Berater", "Coach", "Therapeut", "HR", "Strukturberater", "Kombiniert"]
  - spezialist_begruendung: 1 Satz, warum dieses Profil
  - regime_check: Objekt { "passt": "ok" | "warn" | "no", "begruendung": 1 Satz }
    - "ok" = Intervention passt zum aktuellen Regime
    - "warn" = hinterfragen, Sequenzierung prüfen
    - "no" = widerspricht dem Regime (z.B. L3-Intervention bei L1 rot)

Klienten-Name first. Wissenschaftliche Namen/Autoren in Klammern (z.B. "Psychological Safety (Edmondson, 1999)").

Antwort AUSSCHLIESSLICH als JSON-Objekt mit genau diesem Format, kein Text davor oder danach:
{
  "recommendations": [
    { "layer": "...", "achse": "...", "wert": "...", "typ": "...", "was": "...", "warum": "...", "wann": "...", "wann_nicht": "...", "spezialist_profil": "...", "spezialist_begruendung": "...", "regime_check": { "passt": "ok", "begruendung": "..." } },
    ...
  ]
}

Sprache: Deutsch, normale Umlaute ä/ö/ü.${masterCtx}`;

  const userMsg = `Klient: ${kunde_name || "Unbekannt"}
Aktuelles Regime: ${regime || "—"}

3 Haupt-Friction-Points:
${fpBlock}

Bitte generiere die strukturierten Empfehlungen im geforderten JSON-Format.`;

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userMsg }],
      });

      const text = response.content
        .filter(c => c.type === "text")
        .map(c => c.text)
        .join("");

      // Strip code fences if present, then parse JSON
      let json = text.trim();
      const fenceMatch = json.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
      if (fenceMatch) json = fenceMatch[1].trim();
      // Find first { and last } to be robust
      const firstBrace = json.indexOf("{");
      const lastBrace = json.lastIndexOf("}");
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        json = json.slice(firstBrace, lastBrace + 1);
      }

      try {
        const parsed = JSON.parse(json);
        return res.json({
          recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
        });
      } catch (parseErr) {
        // Return raw text so frontend can display a fallback
        return res.json({
          recommendations: [],
          _raw: text,
          _parse_error: parseErr.message,
        });
      }
    } catch (e) {
      const isOverloaded = e.status === 529 || (e.message && e.message.includes("529"));
      const isRateLimit = e.status === 429;
      if ((isOverloaded || isRateLimit) && attempt < maxRetries) {
        const wait = attempt * 2000;
        console.warn(`ADA interventions attempt ${attempt}/${maxRetries} failed (${e.status || "?"}), retrying in ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      console.error("ADA interventions error:", e.message);
      const userErr = isOverloaded
        ? "Claude ist gerade überlastet. Bitte in 30 Sekunden nochmal versuchen."
        : isRateLimit
        ? "Zu viele Anfragen. Bitte kurz warten."
        : "ADA-Fehler: " + e.message;
      return res.status(500).json({ error: userErr });
    }
  }
});

// ─── ADA ERSTGESPRÄCH HYPOTHESEN ──────────────────────────────────────────
// Generiert strukturierte Hypothesen aus einem Erstgespräch-Transkript.
// Input: Phase-Notizen (sync/scan/spiegeln/slice/abschluss) + Signal-Counts.
// Output: { text } — Markdown-formatierte Antwort von Claude auf Deutsch.
app.post("/api/ada/erstgespraech-hypothesen", async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: "ANTHROPIC_API_KEY nicht konfiguriert" });
  const { person_name, phase_notes, signals } = req.body || {};
  const notes = phase_notes || {};

  const notesBlock =
`Phase 1 (Sync):
${(notes.sync || "— keine Notizen —").trim()}

Phase 2 (Scan):
${(notes.scan || "— keine Notizen —").trim()}

Phase 3 (Spiegeln):
${(notes.spiegeln || "— keine Notizen —").trim()}

Phase 4 (Slice + Idealzustand):
${(notes.slice || "— keine Notizen —").trim()}

Phase 5 (Abschluss):
${(notes.abschluss || "— keine Notizen —").trim()}`;

  // Signal-Counts pro Phase aggregiert
  let signalBlock = "";
  if (signals && typeof signals === "object") {
    const totals = { L1: 0, L2: 0, L3: 0 };
    for (const p of Object.keys(signals)) {
      const pc = signals[p] || {};
      totals.L1 += pc.L1 || 0;
      totals.L2 += pc.L2 || 0;
      totals.L3 += pc.L3 || 0;
    }
    signalBlock = `\n\nSignal-Zählungen (gesamt über alle Phasen):\nL1: ${totals.L1} · L2: ${totals.L2} · L3: ${totals.L3}`;
  }

  const systemPrompt = `Du bist NELION Friction Diagnostics.
Analysiere dieses Erstgespräch und generiere:
1. Eine Haupthypothese (1 Satz, Layer benennen: L1/L2/L3)
2. Zwei alternative Hypothesen
3. Stärkste Evidenz aus dem Gespräch (direktes Zitat oder Paraphrase)
4. Empfohlene erste Friction Scan-Frage — mit Begründung (siehe Format-Regel unten)

Antworte auf Deutsch, maximal 250 Wörter, strukturiert.

Verwende Markdown-Formatierung:
- **Fett** für Überschriften und Layer-Labels
- Nummerierte Listen (1. 2. 3.) für die Alternativen
- Kurze, klare Sätze

Die drei Layer der NELION-Friction-Taxonomie:
- L1 = Neurobiologische Kapazität (Energie, Schlaf, Overload)
- L2 = Wissensblockaden (Muster, Safety, Immunity)
- L3 = Strukturelle Reibung (Prozesse, Entscheidung, Verantwortung)

Format-Regel für die Friction-Frage (obligatorisch):

**Empfohlene erste Friction Scan-Frage**
"[Frage]"

**Warum diese Frage:**
[2–3 Sätze: welches psychologische oder strukturelle Muster sie testet, wissenschaftliche Basis, was die Antwort über den Layer verrät]`;

  const userMsg = `Klient${person_name ? ": " + person_name : ""}.

${notesBlock}${signalBlock}

Bitte generiere die Hypothesen-Zusammenfassung. Nach der empfohlenen Friction-Frage immer eine Begründung ausgeben (siehe Format-Regel im System-Prompt).`;

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userMsg }],
      });
      const text = response.content.filter(c => c.type === "text").map(c => c.text).join("");
      return res.json({ text });
    } catch (e) {
      const isOverloaded = e.status === 529 || (e.message && e.message.includes("529"));
      const isRateLimit = e.status === 429;
      if ((isOverloaded || isRateLimit) && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, attempt * 2000));
        continue;
      }
      console.error("Erstgespraech-Hypothesen error:", e.message);
      const userErr = isOverloaded
        ? "Claude ist gerade überlastet. Bitte in 30 Sekunden nochmal versuchen."
        : isRateLimit
        ? "Zu viele Anfragen. Bitte kurz warten."
        : "ADA-Fehler: " + e.message;
      return res.status(500).json({ error: userErr });
    }
  }
});

// ─── ADA TRANSKRIPT-ANALYSE (Erstgespräch Phase 5) ────────────────────────
// Analysiert ein Gesprächs-Transkript einer Führungsperson und extrahiert
// Layer-Hypothesen (L1/L2/L3) mit Zitaten, Omission Bias Check, stärkste
// Friction-Hypothese und eine empfohlene Vertiefungsfrage für den
// Hypothesen-Spiegel. Antwort = strukturierter deutscher Markdown-Text.
app.post("/api/ada/transkript-analyse", async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: "ANTHROPIC_API_KEY nicht konfiguriert" });
  const { transkript, phase_notes, person_name } = req.body || {};
  if (!transkript || !transkript.trim()) {
    return res.status(400).json({ error: "Transkript erforderlich" });
  }
  const notes = phase_notes || {};

  const kontextBlock =
`Phase 1 (Sync): ${(notes.phase1 || "— keine Notizen —").trim()}
Phase 2 (Scan): ${(notes.phase2 || "— keine Notizen —").trim()}
Phase 3 (Spiegeln): ${(notes.phase3 || "— keine Notizen —").trim()}
Phase 4 (Slice): ${(notes.phase4 || "— keine Notizen —").trim()}`;

  const systemPrompt = `Du bist NELION Friction Diagnostics.
Analysiere dieses Erstgespräch-Transkript einer Führungsperson.

Kontext aus dem Gespräch:
${kontextBlock}

Extrahiere:
1. Layer-Hypothesen (L1/L2/L3) — je mit direktem Zitat als Evidenz
2. Omission Bias Check:
   - Biologische Last über Systemsprache kommuniziert?
   - Geschützte Personen nie als Reibungsquelle genannt?
   - Wo hat der Ton gewechselt?
3. Stärkste Friction-Hypothese (1 Satz)
4. Empfohlene erste Friction Scan-Frage — mit Begründung (Format unten, obligatorisch)

Antworte strukturiert, deutsch, maximal 450 Wörter.
Verwende Markdown: ## / ### für Überschriften, **Fett** für Layer-Labels, nummerierte Listen, kurze Sätze.

Die drei Layer:
- L1 = Neurobiologische Kapazität (Energie, Schlaf, Overload)
- L2 = Wissensblockaden (Muster, Safety, Immunity)
- L3 = Strukturelle Reibung (Prozesse, Entscheidung, Verantwortung)

Format-Regel für die Friction-Frage (obligatorisch):

**Empfohlene erste Friction Scan-Frage**
"[Frage]"

**Warum diese Frage:**
[2–3 Sätze: welches psychologische oder strukturelle Muster sie testet, wissenschaftliche Basis, was die Antwort über den Layer verrät]`;

  const userMsg = `Klient${person_name ? ": " + person_name : ""}.

Transkript:
${transkript.trim()}

Bitte liefere die strukturierte Analyse.`;

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: "user", content: userMsg }],
      });
      const text = response.content.filter(c => c.type === "text").map(c => c.text).join("");
      return res.json({ text, generated_at: new Date().toISOString() });
    } catch (e) {
      const isOverloaded = e.status === 529 || (e.message && e.message.includes("529"));
      const isRateLimit = e.status === 429;
      if ((isOverloaded || isRateLimit) && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, attempt * 2000));
        continue;
      }
      console.error("Transkript-Analyse error:", e.message);
      const userErr = isOverloaded
        ? "Claude ist gerade überlastet. Bitte in 30 Sekunden nochmal versuchen."
        : isRateLimit
        ? "Zu viele Anfragen. Bitte kurz warten."
        : "ADA-Fehler: " + e.message;
      return res.status(500).json({ error: userErr });
    }
  }
});

// ─── ADA PFAD-EMPFEHLUNG (Erstgespräch Phase 5) ───────────────────────────
// Schätzt den wahrscheinlichsten Pfad aus den Erstgespräch-Notizen ab.
// Konfidenz: ★☆☆ (Einzelquelle, schwache Hypothese).
// Endergebnis wird in consultations.pfad_empfehlung persistiert (Frontend).
app.post("/api/ada/pfad-empfehlung-erstgespraech", async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: "ANTHROPIC_API_KEY nicht konfiguriert" });
  const { person_name, phase_notes } = req.body || {};
  const notes = phase_notes || {};

  const notesBlock =
`Phase 1 (Sync):
${(notes.sync || "— keine Notizen —").trim()}

Phase 2 (Scan):
${(notes.scan || "— keine Notizen —").trim()}

Phase 3 (Spiegeln):
${(notes.spiegeln || "— keine Notizen —").trim()}

Phase 4 (Slice + Idealzustand):
${(notes.slice || "— keine Notizen —").trim()}

Phase 5 (Abschluss):
${(notes.abschluss || "— keine Notizen —").trim()}`;

  const systemPrompt = `Du bist NELION Friction Diagnostics.
Analysiere diese Erstgespräch-Notizen und schätze den wahrscheinlichsten Pfad ein.

Verfügbare Pfade:
- Alarmstufe Rot: Scan nicht möglich, System im Überlebensmodus
- Stabilisierungspfad: L1 dominant, biologische Erschöpfung
- Kulturpfad: L2 dominant, psychologische Blockaden
- Klärungspfad: L3 hat L2-Blockaden erzeugt, Sequenz entscheidend
- Gestaltungspfad: L3 direkt, System stabil
- Neuausrichtungspfad: alle Layer kritisch, fundamentaler Reset

Ausgabe (Markdown, deutsch, max. 150 Wörter):
1. **Empfohlener Pfad** — Name + 1 Satz Begründung
2. **Konfidenz** — ★☆☆ (Einzelquelle)
3. **Stärkste Evidenz** — direktes Zitat oder Paraphrase aus den Notizen
4. **Im Scan zu prüfen** — 2–3 konkrete Punkte`;

  const userMsg = `Klient${person_name ? ": " + person_name : ""}.

${notesBlock}

Bitte liefere die strukturierte Pfad-Empfehlung.`;

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userMsg }],
      });
      const text = response.content.filter(c => c.type === "text").map(c => c.text).join("");
      return res.json({ text });
    } catch (e) {
      const isOverloaded = e.status === 529 || (e.message && e.message.includes("529"));
      const isRateLimit = e.status === 429;
      if ((isOverloaded || isRateLimit) && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, attempt * 2000));
        continue;
      }
      console.error("Pfad-Empfehlung Erstgespraech error:", e.message);
      const userErr = isOverloaded
        ? "Claude ist gerade überlastet. Bitte in 30 Sekunden nochmal versuchen."
        : isRateLimit
        ? "Zu viele Anfragen. Bitte kurz warten."
        : "ADA-Fehler: " + e.message;
      return res.status(500).json({ error: userErr });
    }
  }
});

// ─── ADA PFAD-EMPFEHLUNG (Friction Scan Phase 3) ──────────────────────────
// Berechnet den Pfad aus Survey-Ampeln + Interview-Notizen + Omission Bias.
// Konfidenz: ★★☆ bis ★★★, steigt mit Anzahl Datenquellen.
// Endergebnis wird in scans.pfad_empfehlung persistiert (Frontend).
app.post("/api/ada/pfad-empfehlung-scan", async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: "ANTHROPIC_API_KEY nicht konfiguriert" });
  const { ampeln, interview_notizen, omission_flags, arbeitshypothese, kunde_name } = req.body || {};

  const ampelnBlock = Array.isArray(ampeln) && ampeln.length > 0
    ? ampeln.map(a => `- ${a.layer} ${a.achse}: ${a.wert}`).join("\n")
    : "— keine Ampeln verfügbar —";

  const interviewBlock = Array.isArray(interview_notizen) && interview_notizen.length > 0
    ? interview_notizen.map((iv, i) =>
        `Interview ${i + 1}${iv.rolle ? " (" + iv.rolle + ")" : ""}:\n${(iv.notizen || "— keine Notizen —").trim()}`
      ).join("\n\n")
    : "— keine Interviews verfügbar —";

  const omissionBlock = Array.isArray(omission_flags) && omission_flags.length > 0
    ? omission_flags.map((f, i) => `Interview ${i + 1}: ${Object.entries(f).filter(([, v]) => v === true).map(([k]) => k).join(", ") || "— keine Flags —"}`).join("\n")
    : "— keine Omission-Bias-Flags —";

  const systemPrompt = `Du bist NELION Friction Diagnostics.
Berechne den Pfad basierend auf den gelieferten Scan-Daten.

Gate-Logik (zwingend einhalten):
- L1 rot → Stabilisierungspfad (keine Ausnahme)
- L1 gelb + L2 hoch → Kulturpfad
- L1 gelb + L2 ok + L3 erzeugt L2-Blockaden → Klärungspfad
- L1 grün + L3 dominant → Gestaltungspfad
- Alle Layer kritisch → Neuausrichtungspfad
- Mandat fehlt → Alarmstufe Rot

Ausgabe (Markdown, deutsch, max. 200 Wörter):
1. **Empfohlener Pfad** — Name
2. **Konfidenz** — ★★☆ (Survey + 1–2 Interviews) oder ★★★ (Survey + alle 3 Interviews + Omission-Bias-Check)
3. **Primärer Friction-Vektor** — Layer + Achse + Zitat (falls Interview-Beleg)
4. **Top 3 zu adressierende Punkte** — priorisiert nach Gate-Logik
5. **Nächster konkreter Schritt** — operativ, umsetzbar`;

  const userMsg = `Klient${kunde_name ? ": " + kunde_name : ""}.

Survey-Ampeln (alle 12 Achsen):
${ampelnBlock}

Interview-Notizen:
${interviewBlock}

Omission-Bias-Flags:
${omissionBlock}

Arbeitshypothese:
${(arbeitshypothese || "— keine Arbeitshypothese gesetzt —").trim()}

Bitte berechne die Pfad-Empfehlung gemäss Gate-Logik.`;

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: "user", content: userMsg }],
      });
      const text = response.content.filter(c => c.type === "text").map(c => c.text).join("");
      return res.json({ text });
    } catch (e) {
      const isOverloaded = e.status === 529 || (e.message && e.message.includes("529"));
      const isRateLimit = e.status === 429;
      if ((isOverloaded || isRateLimit) && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, attempt * 2000));
        continue;
      }
      console.error("Pfad-Empfehlung Scan error:", e.message);
      const userErr = isOverloaded
        ? "Claude ist gerade überlastet. Bitte in 30 Sekunden nochmal versuchen."
        : isRateLimit
        ? "Zu viele Anfragen. Bitte kurz warten."
        : "ADA-Fehler: " + e.message;
      return res.status(500).json({ error: userErr });
    }
  }
});

// ─── NOTES ────────────────────────────────────────────────────────────────
// Freie Notizen (Rich-Text HTML). Migration: 012_notes.sql.
// Ohne Migration: GET gibt [] zurück, POST/PATCH/DELETE geben 503 zurück.
app.get("/api/notes", async (req, res) => {
  if (!supabase) return res.json([]);
  const { data, error } = await supabase
    .from("notes")
    .select("*")
    .order("position", { ascending: true, nullsFirst: false })
    .order("updated_at", { ascending: false });
  if (error) return res.json([]); // Tabelle evtl. nicht migriert
  res.json(data || []);
});

app.post("/api/notes", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { title, content, position } = req.body || {};
  // Auto-assign position = MAX+10
  let nextPos = typeof position === "number" ? position : null;
  if (nextPos == null) {
    try {
      const r = await supabase.from("notes").select("position")
        .order("position", { ascending: false, nullsFirst: false }).limit(1);
      if (!r.error && r.data && r.data.length > 0 && r.data[0].position != null) {
        nextPos = r.data[0].position + 10;
      } else {
        nextPos = 10;
      }
    } catch {}
  }
  const payload = {
    title: typeof title === "string" ? title : "",
    content: typeof content === "string" ? content : "",
  };
  if (nextPos != null) payload.position = nextPos;
  const { data, error } = await supabase.from("notes").insert(payload).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch("/api/notes/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const allowed = ["title", "content", "position"];
  const updates = {};
  for (const k of allowed) {
    if (k in (req.body || {})) updates[k] = req.body[k];
  }
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase
    .from("notes").update(updates).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/api/notes/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const { error } = await supabase.from("notes").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── START ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NELION Cockpit running on port ${PORT}`);
  console.log(`Aktualisiert: ${APP_LAST_UPDATED}`);
});
