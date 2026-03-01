import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import cors from "cors";

dotenv.config();

const app = express();

/**
 * ✅ Bulletproof CORS + Preflight (OPTIONS) handling
 * Must be BEFORE routes.
 */
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Optional: cors package (fine to keep)
app.use(cors());

app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (req, res) => {
  res.json({ ok: true });
});

/**
 * ✅ Use this to confirm Render is running the updated code
 */
app.get("/version", (req, res) => {
  res.json({ version: "cors-fix-1" });
});

app.post("/ask", async (req, res) => {
  try {
    const userMessage = req.body?.message || "";

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: userMessage,
    });

    res.json({ reply: response.output_text });
  } catch (error) {
    console.error("ASK ERROR:", error);
    res.status(500).json({ error: "Something went wrong" });
  }
});

/**
 * ✅ Render requires using process.env.PORT
 */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});