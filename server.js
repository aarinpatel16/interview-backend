// server.js (CommonJS) — Full working example with Coaching Intelligence

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const OpenAI = require("openai");

// ✅ Step 2 import (make sure you created utils/coaching.js)
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

  // Feed prior Q/A to the model
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
  const system =
    "You are an admissions interview coach. Score answers fairly. Return ONLY valid JSON.";

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

  // Fallback if model returns non-JSON
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
  const system =
    "You are an admissions interview coach. Produce a final report. Return ONLY valid JSON.";

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

// Start interview: first question
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

// Next question after a turn
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

// Upload video blob -> filename
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

// Transcribe a previously uploaded file
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

// ✅ Score transcript with AI + Coaching Intelligence
app.post("/score", async (req, res) => {
  try {
    const { transcript, question, durationSeconds } = req.body;

    if (!transcript) return res.status(400).json({ error: "transcript required" });

    // Existing AI scoring
    const aiScore = await scoreWithAI({ transcript, question });

    // ✅ Coaching Intelligence (Step 2)
    const coaching = analyzeTranscript({
      transcript,
      question,
      durationSeconds: Number(durationSeconds || 0),
    });

    res.json({
      ...aiScore,
      coaching,
    });
  } catch (err) {
    console.error("/score error:", err);
    res.status(500).json({ error: "Scoring failed" });
  }
});

// ✅ Final report + Coaching Summary
app.post("/final-report", async (req, res) => {
  try {
    const { turns, interviewer_style, difficulty } = req.body;
    if (!Array.isArray(turns)) return res.status(400).json({ error: "turns array required" });

    // Existing final report (AI)
    const finalReport = await buildFinalReportWithAI({
      turns,
      interviewer_style,
      difficulty,
    });

    // ✅ Coaching summary (Step 2)
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