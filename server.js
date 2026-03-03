// server.js (CommonJS) — Coaching Intelligence + Scoring Calibration v3.2

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const OpenAI = require("openai");

// ✅ Coaching Intelligence utils
const { analyzeTranscript, aggregateCoaching } = require("./utils/coaching");

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

// --- OpenAI client ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Upload storage ---
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || ".webm") || ".webm";
    const safe = `video_${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`;
    cb(null, safe);
  },
});
const upload = multer({ storage });

// --- Helpers ---
function safeJsonParse(maybeJson, fallback = null) {
  try {
    if (!maybeJson) return fallback;
    if (typeof maybeJson === "object") return maybeJson;
    return JSON.parse(maybeJson);
  } catch {
    return fallback;
  }
}

function normalize(text = "") {
  return String(text).replace(/\s+/g, " ").trim();
}

function countWords(text = "") {
  const t = normalize(text);
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

function computeConfidence(wordCount) {
  // v3.2 rule
  if (wordCount >= 80) return { confidence_level: "high", confidence_score: 85 };
  if (wordCount >= 40) return { confidence_level: "medium", confidence_score: 65 };
  return { confidence_level: "low", confidence_score: 40 };
}

function clamp100(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function rubricConsistency(rubric) {
  // v3.2 rule:
  // Start at 100. Subtract 10 for each rubric category that differs by >=4 from the mean.
  // Clamp 0-100.
  if (!rubric || typeof rubric !== "object") return 50;

  const vals = Object.values(rubric)
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));

  if (!vals.length) return 50;

  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  let score = 100;

  for (const v of vals) {
    if (Math.abs(v - mean) >= 4) score -= 10;
  }
  return clamp100(score);
}

function specificityHeuristics(transcript = "") {
  const t = normalize(transcript);

  // measurable outcomes: numbers, %, $, decimals
  const measurableMatches = t.match(/(\$?\d+(\.\d+)?%?)/g);
  const measurable_outcome_count = measurableMatches ? measurableMatches.length : 0;

  const example_presence = /\b(for example|for instance)\b/i.test(t);

  // named entities: very simple heuristic: "Capitalized Capitalized"
  const namedMatches = t.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g);
  const named_entity_count = namedMatches ? namedMatches.length : 0;

  const specificity_score = Math.min(
    100,
    measurable_outcome_count * 15 + named_entity_count * 8 + (example_presence ? 10 : 0)
  );

  const evidence_score = Math.min(
    100,
    measurable_outcome_count * 20 + (example_presence ? 15 : 0)
  );

  return {
    specificity_score: clamp100(specificity_score),
    evidence_score: clamp100(evidence_score),
    named_entity_count,
    measurable_outcome_count,
    example_presence,
  };
}

function interviewerSystemPrompt(style, difficulty) {
  const stylePrompt =
    style === "Friendly Alumni"
      ? "You are a warm, encouraging college alumni conducting a mock interview."
      : style === "Formal Admissions Officer"
      ? "You are a formal, professional admissions officer conducting a mock interview."
      : style === "High-Pressure Interviewer"
      ? "You are a challenging, high-pressure interviewer. Push for specifics and follow-ups."
      : "You are a college interviewer conducting a mock interview.";

  const diffPrompt =
    difficulty === "Easy"
      ? "Ask accessible questions suitable for a beginner."
      : difficulty === "Hard"
      ? "Ask advanced questions and follow-ups that demand specificity and reflection."
      : "Ask medium-difficulty questions with reasonable depth.";

  return `${stylePrompt}\n${diffPrompt}\nKeep questions concise and realistic. Ask ONE question at a time.`;
}

async function askNextQuestion({ turns, interviewer_style, difficulty }) {
  const system = interviewerSystemPrompt(interviewer_style, difficulty);

  const messages = [
    { role: "system", content: system },
    {
      role: "user",
      content:
        "You are conducting a multi-turn college interview. Ask the next best question based on the conversation so far.",
    },
  ];

  for (const t of turns || []) {
    if (t?.question) messages.push({ role: "assistant", content: `Question: ${t.question}` });
    if (t?.transcript) messages.push({ role: "user", content: `Answer: ${t.transcript}` });
  }

  const resp = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.7,
    messages,
  });

  return resp.choices?.[0]?.message?.content?.trim() || "Tell me about yourself.";
}

async function scoreWithAI({ transcript, question }) {
  // Returns structured scoring JSON
  const system = "You are an admissions interview coach. Score answers fairly. Return ONLY valid JSON.";

  const user = `
Question:
${question || ""}

Answer transcript:
${transcript || ""}

Return JSON with keys:
overall_score (0-10 number),
strengths (array of strings),
improvements (array of strings),
suggested_better_answer (string, concise),
rubric (object with: clarity, specificity, reflection, structure each 0-10).
`;

  const resp = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const text = resp.choices?.[0]?.message?.content || "";
  const parsed = safeJsonParse(text, null);

  if (!parsed) {
    return {
      overall_score: 6,
      strengths: ["Clear attempt to answer the question."],
      improvements: ["Add more concrete details and outcomes."],
      suggested_better_answer: "Try adding specific examples and measurable impact.",
      rubric: { clarity: 6, specificity: 5, reflection: 6, structure: 6 },
      _raw: text,
    };
  }

  return parsed;
}

async function buildFinalReportWithAI({ turns, interviewer_style, difficulty }) {
  const system = "You are an admissions interview coach. Produce a final report. Return ONLY valid JSON.";

  const compactTurns = (turns || []).map((t, i) => ({
    index: i + 1,
    question: t.question,
    transcript: t.transcript,
    overall_score: t?.score?.overall_score ?? t?.overall_score ?? null,
    coaching: t?.coaching ?? null,
  }));

  const user = `
Interviewer style: ${interviewer_style || ""}
Difficulty: ${difficulty || ""}

Turns:
${JSON.stringify(compactTurns, null, 2)}

Return JSON with keys:
summary (string),
overall_strengths (array of strings),
overall_improvements (array of strings),
avg_overall_score (number),
notable_moments (array of strings),
action_plan (array of strings).
`;

  const resp = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const text = resp.choices?.[0]?.message?.content || "";
  const parsed = safeJsonParse(text, null);

  if (!parsed) {
    return {
      summary: "Interview completed. Review feedback per question and focus on specifics and outcomes.",
      overall_strengths: ["You stayed engaged and answered each prompt."],
      overall_improvements: ["Add more concrete examples and measurable impact."],
      avg_overall_score: null,
      notable_moments: [],
      action_plan: ["Practice STAR structure for behavioral questions."],
      _raw: text,
    };
  }

  return parsed;
}

// --- Routes ---

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/ask", async (req, res) => {
  try {
    const { interviewer_style, difficulty } = req.body;
    const firstQuestion = await askNextQuestion({
      turns: [],
      interviewer_style,
      difficulty,
    });

    res.json({ question: firstQuestion });
  } catch (err) {
    console.error("/ask error:", err);
    res.status(500).json({ error: "Failed to generate question" });
  }
});

app.post("/next-question", async (req, res) => {
  try {
    const { turns, interviewer_style, difficulty } = req.body;
    const next = await askNextQuestion({ turns, interviewer_style, difficulty });
    res.json({ question: next });
  } catch (err) {
    console.error("/next-question error:", err);
    res.status(500).json({ error: "Failed to generate next question" });
  }
});

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.filename) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    res.json({ filename: req.file.filename });
  } catch (err) {
    console.error("/upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

app.post("/transcribe", async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: "filename required" });

    const filePath = path.join(UPLOAD_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }

    const transcriptResp = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: process.env.WHISPER_MODEL || "whisper-1",
    });

    const transcript = transcriptResp.text || "";
    res.json({ transcript });
  } catch (err) {
    console.error("/transcribe error:", err);
    res.status(500).json({ error: "Transcription failed" });
  }
});

// ✅ /score — AI score + Coaching + Scoring Calibration v3.2 enrichment
app.post("/score", async (req, res) => {
  try {
    const { transcript, question, durationSeconds } = req.body;
    if (!transcript) return res.status(400).json({ error: "transcript required" });

    const modelUsed = process.env.OPENAI_MODEL || "gpt-4o-mini";

    // 1) AI scoring
    const aiScore = await scoreWithAI({ transcript, question });

    // 2) Coaching Intelligence
    const coaching = analyzeTranscript({
      transcript,
      question,
      durationSeconds: Number(durationSeconds || 0),
    });

    // 3) Scoring Calibration v3.2 (deterministic enrichment)
    const word_count = countWords(transcript);
    const { confidence_level, confidence_score } = computeConfidence(word_count);

    const rubric = aiScore?.rubric || null;
    const rubric_consistency = rubricConsistency(rubric);
    const specificity = specificityHeuristics(transcript);

    const why_this_score =
      aiScore?.overall_score >= 8
        ? "Strong answer with clear structure and relevant specifics."
        : aiScore?.overall_score >= 6
        ? "Solid answer; adding more concrete examples and measurable outcomes would improve it."
        : "Answer needs clearer structure and more specific evidence to support the claims.";

    res.json({
      // keep original keys first
      ...aiScore,
      coaching,

      // v3.2 fields
      scoring_version: "v3.2",
      model_used: modelUsed,
      word_count,
      confidence_level,
      confidence_score,
      why_this_score,
      rubric_consistency,
      specificity,
    });
  } catch (err) {
    console.error("/score error:", err);
    res.status(500).json({ error: "Scoring failed" });
  }
});

app.post("/final-report", async (req, res) => {
  try {
    const { turns, interviewer_style, difficulty } = req.body;
    if (!Array.isArray(turns)) return res.status(400).json({ error: "turns array required" });

    const finalReport = await buildFinalReportWithAI({
      turns,
      interviewer_style,
      difficulty,
    });

    const coaching_summary = aggregateCoaching(turns);

    res.json({
      ...finalReport,
      coaching_summary,
    });
  } catch (err) {
    console.error("/final-report error:", err);
    res.status(500).json({ error: "Final report failed" });
  }
});

// --- Start server ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});