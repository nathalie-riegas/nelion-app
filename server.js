const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execSync } = require("child_process");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ─── VERSION ───────────────────────────────────────────────────────────────
let APP_LAST_UPDATED = "unbekannt";
try {
  const raw = execSync("git log -1 --format=%cd --date=format:%d.%m.%Y %H:%M", {
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

// ─── ENV ───────────────────────────────────────────────────────────────────
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const NELION_PASSWORD   = process.env.NELION_PASSWORD;

// ─── SUPABASE ───────────────────────────────────────────────────────────────
const supabase = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

if (!supabase) console.warn("Supabase not configured — storage disabled");
if (!NELION_PASSWORD) console.warn("NELION_PASSWORD not set — app is publicly accessible");

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

// ─── START ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NELION Cockpit running on port ${PORT}`);
  console.log(`Aktualisiert: ${APP_LAST_UPDATED}`);
});
