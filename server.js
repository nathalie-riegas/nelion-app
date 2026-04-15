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

// Static files after auth
app.use(express.static(path.join(__dirname, "public")));

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
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "Keine Felder zum Update" });
  }
  const { data, error } = await supabase
    .from("consultations")
    .update(updates)
    .eq("id", req.params.id)
    .select()
    .single();
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

// ─── TASKS ────────────────────────────────────────────────────────────────
// NOTE: Requires sort_order column. Run this once in Supabase SQL editor:
//   ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sort_order INT;
// Without this column, reorder up/down will silently fail but delete/rename still work.
app.get("/api/tasks", async (req, res) => {
  if (!supabase) return res.json([]);
  // Try sort_order first; if column missing, fall back
  let query = supabase.from("tasks").select("*")
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("prioritaet", { ascending: true })
    .order("created_at", { ascending: false });
  if (req.query.status) query = query.eq("status", req.query.status);
  let { data, error } = await query;
  if (error) {
    // sort_order column may not exist — retry without it
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
  const { titel, prioritaet, deadline, gate_bezug, ada_vorschlag, nathalie_approved } = req.body || {};
  if (!titel) return res.status(400).json({ error: "titel erforderlich" });
  const { data, error } = await supabase.from("tasks").insert({
    titel,
    prioritaet: prioritaet || 2,
    deadline: deadline || null,
    gate_bezug: gate_bezug || null,
    ada_vorschlag: ada_vorschlag || false,
    nathalie_approved: nathalie_approved !== undefined ? nathalie_approved : true,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch("/api/tasks/:id", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Supabase not configured" });
  const allowed = ["titel", "prioritaet", "deadline", "gate_bezug", "status", "ada_vorschlag", "nathalie_approved", "sort_order"];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  let { data, error } = await supabase.from("tasks").update(updates).eq("id", req.params.id).select().single();
  if (error && updates.sort_order !== undefined && /sort_order/.test(error.message || "")) {
    // column missing — retry without sort_order so other fields still update
    delete updates.sort_order;
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

  // 3. Dynamic Scan Context
  if (scan_context) {
    systemPrompt += `\n\n─── SCAN-KONTEXT ───\nKunde: ${scan_context.kunde || "unbekannt"}\nPhase: ${scan_context.phase || "unbekannt"}\nStatus: ${scan_context.status || "unbekannt"}\n─── ENDE SCAN-KONTEXT ───`;
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

// ─── START ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NELION Cockpit running on port ${PORT}`);
  console.log(`Aktualisiert: ${APP_LAST_UPDATED}`);
});
