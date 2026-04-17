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
    `SameSite=Lax`,
  ];
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    cookieParts.push("Secure");
  }
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

app.patch("/api/consultations/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const allowed = [
    "current_phase",
    "phase1_notes",
    "phase2_notes",
    "phase3_notes",
    "phase4_notes",
    "phase5_notes",
    "completed",
    "hyp_generated",
    "hyp_regime",
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "Keine Felder zum Update" });
  }
  // Graceful fallback falls hyp_generated/hyp_regime Spalten fehlen.
  let { data, error } = await supabase
    .from("consultations").update(updates).eq("id", req.params.id).select().single();
  if (error && /hyp_generated|hyp_regime/.test(error.message || "")) {
    // Spalten fehlen — retry ohne diese Felder
    delete updates.hyp_generated; delete updates.hyp_regime;
    if (Object.keys(updates).length === 0) {
      return res.status(500).json({ error: "Migration 013_consultations_hyp.sql nötig: ADD COLUMN hyp_generated TEXT, hyp_regime TEXT" });
    }
    const r2 = await supabase.from("consultations").update(updates).eq("id", req.params.id).select().single();
    if (r2.error) return res.status(500).json({ error: r2.error.message });
    return res.json(r2.data);
  }
  if (error) return res.status(500).json({ error: error.message });
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
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "Keine Felder zum Update" });
  }
  const { data, error } = await supabase
    .from("scans").update(updates).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
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
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "Keine Felder zum Update" });
  }
  const { data, error } = await supabase
    .from("interviews").update(updates).eq("id", req.params.iid).select().single();
  if (error) return res.status(500).json({ error: error.message });
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
  const allowed = ["person_name", "person_rolle", "status", "current_phase"];
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
  F4:  { layer: "L1b", achse: "Erholungsstruktur" },        // Regenerationsdefizit
  F5:  { layer: "L2",  achse: "Psychological Safety" },     // Selbstzensur
  F6:  { layer: "L2",  achse: "Immunity-Muster" },          // Veraenderungsresistenz
  F7:  { layer: "L2",  achse: "Attribution Style" },        // Verantwortungsvermeidung
  F8:  { layer: "L2",  achse: "Threat-State" },             // Irritabilitaet
  F9:  { layer: "L3",  achse: "Entscheidungsarchitektur" }, // Fehlentscheidungskosten
  F10: { layer: "L3",  achse: "Incentive-Struktur" },       // Dysfunktionale Anreize
  F11: { layer: "L3",  achse: "Strukturelle Ambiguität" },  // Verantwortungsvakuum
  F12: { layer: "L3",  achse: "Informationsfluss" },        // Informationsblockaden
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
    const m = label.match(/F(\d{1,2})\b/i);
    if (!m) continue;
    const fNum = parseInt(m[1], 10);
    const fKey = `F${fNum}`;
    if (!TALLY_F_TO_AXIS[fKey]) continue;
    const raw = extractTallyNumber(f);
    const score = normalizeTallyScore(raw);
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
  const allowed = ["titel", "prioritaet", "deadline", "gate_bezug", "status", "ada_vorschlag", "nathalie_approved", "position"];
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

  // Build system prompt: ADA prompt + Master Context + Memory + Scan Context
  let systemPrompt = ADA_SYSTEM_PROMPT;

  // 1. NELION Master Context (read-only)
  try {
    const { content: masterContext } = await githubGetContextFile();
    if (masterContext) {
      systemPrompt += `\n\n─── NELION MASTER CONTEXT (read-only) ───\n${masterContext}\n─── ENDE CONTEXT ───`;
    }
  } catch (e) {
    console.warn("Master Context fetch failed:", e.message);
  }

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

Input: 3 Haupt-Friction-Points (Layer, Achse, Ampel) + aktuelles Regime-Routing.

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
4. Empfohlene erste Frage für den Friction Scan
Antworte auf Deutsch, maximal 200 Wörter, strukturiert.

Verwende Markdown-Formatierung:
- **Fett** für Überschriften und Layer-Labels
- Nummerierte Listen (1. 2. 3.) für die Alternativen
- Kurze, klare Sätze

Die drei Layer der NELION-Friction-Taxonomie:
- L1 = Biologische Kapazität (Energie, Schlaf, Overload)
- L2 = Psychologische Dynamik (Muster, Safety, Immunity)
- L3 = Organisationale Struktur (Prozesse, Entscheidung, Verantwortung)`;

  const userMsg = `Klient${person_name ? ": " + person_name : ""}.

${notesBlock}${signalBlock}

Bitte generiere die Hypothesen-Zusammenfassung.`;

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
