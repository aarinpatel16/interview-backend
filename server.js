// server.js
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

require("dotenv").config();

const OpenAI = require("openai");

// ---------- App Setup ----------
const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Preflight (Express 5-safe)
app.options(/.*/, cors());

// JSON body parsing for non-multipart routes
app.use(express.json({ limit: "2mb" }));

// ---------- OpenAI ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Uploads (Multer) ----------
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safeName = Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
});

// ---------- Helpers ----------
function safeUploadPath(filename) {
  if (!filename || typeof filename !== "string") return null;
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) return null;
  return path.join(uploadDir, filename);
}

function normalizeText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function countWords(text) {
  const t = normalizeText(text);
  if (!t) return 0;
  return t.split(" ").filter(Boolean).length;
}

function countFillerWords(text) {
  const t = (text || "").toLowerCase();

  const fillers = [
    "um",
    "uh",
    "like",
    "you know",
    "kind of",
    "sort of",
    "actually",
    "basically",
    "literally",
    "i mean",
    "right",
  ];

  const counts = {};
  let total = 0;

  for (const f of fillers) {
    const re = new RegExp(`\\b${f.replace(/\s+/g, "\\s+")}\\b`, "g");
    const m = t.match(re);
    const c = m ? m.length : 0;
    counts[f] = c;
    total += c;
  }

  return { total, counts };
}

function sentenceStats(text) {
  const t = normalizeText(text);
  if (!t) return { sentences: 0, avgWordsPerSentence: 0 };

  const sentences = t
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length === 0) return { sentences: 0, avgWordsPerSentence: 0 };

  const wordsPerSentence = sentences.map((s) => countWords(s));
  const avgWordsPerSentence =
    wordsPerSentence.reduce((a, b) => a + b, 0) / sentences.length;

  return {
    sentences: sentences.length,
    avgWordsPerSentence: Math.round(avgWordsPerSentence * 10) / 10,
  };
}

function computeMetrics(transcript) {
  const words = countWords(transcript);
  const filler = countFillerWords(transcript);
  const s = sentenceStats(transcript);

  const hasStructureSignals = /first|second|third|overall|in conclusion|to summarize|because|for example/i.test(
    transcript || ""
  );

  const questionHandlingSignals = /that's a great question|i would say|in my experience|one example/i.test(
    transcript || ""
  );

  return {
    words,
    sentences: s.sentences,
    avgWordsPerSentence: s.avgWordsPerSentence,
    fillerTotal: filler.total,
    fillerBreakdown: filler.counts,
    structureSignals: hasStructureSignals,
    responseSignals: questionHandlingSignals,
  };
}

// ---------- Routes ----------
app.get("/version", (req, res) => {
  res.json({ ok: true, version: "phase4-live-interview-v1" });
});

app.post("/ask", async (req, res) => {
  try {
    const userMessage = req.body?.message || req.body?.input || req.body?.userMessage;
    if (!userMessage) return res.status(400).json({ error: "Missing message in request body" });

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: userMessage,
    });

    const reply =
      response.output_text ||
      response.output?.[0]?.content?.[0]?.text ||
      "No response text returned.";

    res.json({ reply });
  } catch (err) {
    console.error("Error in /ask:", err);
    res.status(500).json({ error: "Server error in /ask" });
  }
});

// Upload endpoint: multipart/form-data with field name "video"
app.post("/upload", upload.single("video"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });

    res.json({
      ok: true,
      filename: req.file.filename,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
    });
  } catch (err) {
    console.error("Error in /upload:", err);
    res.status(500).json({ ok: false, error: "Server error in /upload" });
  }
});

// Transcribe endpoint: { filename }
app.post("/transcribe", async (req, res) => {
  try {
    const filename = req.body?.filename;
    const filePath = safeUploadPath(filename);

    if (!filePath) return res.status(400).json({ ok: false, error: "Invalid filename" });
    if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: "File not found" });

    const transcript = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(filePath),
    });

    res.json({ ok: true, text: transcript.text, filename });
  } catch (err) {
    console.error("Error in /transcribe:", err);
    const message = err?.message || "Unknown error";
    const status = err?.status || err?.response?.status;
    const details = err?.response?.data || err?.error || null;

    res.status(500).json({
      ok: false,
      error: "Server error in /transcribe",
      message,
      status,
      details,
    });
  }
});

// Score endpoint: { transcript, role?, level? }
app.post("/score", async (req, res) => {
  try {
    const transcriptRaw = req.body?.transcript;
    const role = req.body?.role || "college admissions interview";
    const level = req.body?.level || "high school applicant";

    const transcript = normalizeText(transcriptRaw);
    if (!transcript) return res.status(400).json({ ok: false, error: "Missing transcript" });

    const metrics = computeMetrics(transcript);

    const prompt = `
You are an interview coach scoring a response for: ${role}.
Candidate level: ${level}.

Score this transcript using a rubric with clear, actionable feedback.
Return ONLY valid JSON matching the schema.

Transcript:
"""${transcript}"""
`.trim();

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "InterviewScore",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              overallScore: { type: "integer", minimum: 1, maximum: 10 },
              categoryScores: {
                type: "object",
                additionalProperties: false,
                properties: {
                  content: { type: "integer", minimum: 1, maximum: 10 },
                  structure: { type: "integer", minimum: 1, maximum: 10 },
                  clarity: { type: "integer", minimum: 1, maximum: 10 },
                  confidence: { type: "integer", minimum: 1, maximum: 10 },
                },
                required: ["content", "structure", "clarity", "confidence"],
              },
              strengths: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 },
              improvements: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 8 },
              rewriteSuggestion: { type: "string" },
              followUpQuestions: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 },
            },
            required: ["overallScore", "categoryScores", "strengths", "improvements", "rewriteSuggestion", "followUpQuestions"],
          },
        },
      },
    });

    let ai;
    try {
      ai = JSON.parse(response.output_text || "{}");
    } catch {
      ai = null;
    }

    if (!ai) {
      return res.status(500).json({ ok: false, error: "AI returned invalid JSON" });
    }

    res.json({ ok: true, metrics, ai });
  } catch (err) {
    console.error("Error in /score:", err);
    res.status(500).json({ ok: false, error: "Server error in /score" });
  }
});

// Next question endpoint: { turns, style, difficulty }
app.post("/next-question", async (req, res) => {
  try {
    const turns = Array.isArray(req.body?.turns) ? req.body.turns : [];
    const difficulty = req.body?.difficulty || "medium"; // easy | medium | hard
    const style = req.body?.style || "mixed"; // friendly | serious | mixed

    const styleGuidance =
      style === "friendly"
        ? "Tone: warm, encouraging, conversational. Ask supportive follow-ups."
        : style === "serious"
        ? "Tone: professional, selective, concise. Ask probing follow-ups and push for specifics."
        : "Tone: start warm, then gradually become more challenging and selective as the interview progresses.";

    const history = turns
      .slice(-6)
      .map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answerTranscript}`)
      .join("\n\n");

    const prompt = `
You are a realistic college admissions interviewer.

${styleGuidance}
Difficulty: ${difficulty}

Rules:
- Ask ONE question only.
- If no history, start with a warm opener.
- If there is history, ask a follow-up based on the MOST RECENT answer.
- Avoid robotic phrasing; make it feel like a real interview.

Conversation so far:
${history || "(none)"}

Return ONLY valid JSON:
{ "question": "..." }
`.trim();

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "NextQuestion",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { question: { type: "string" } },
            required: ["question"],
          },
        },
      },
    });

    const data = JSON.parse(response.output_text || "{}");
    res.json({ ok: true, question: data.question });
  } catch (err) {
    console.error("Error in /next-question:", err);
    res.status(500).json({ ok: false, error: "Server error in /next-question" });
  }
});

// ---------- Start Server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));