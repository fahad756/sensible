import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { nanoid } from "nanoid";
import { Server } from "socket.io";
import { GoogleGenAI } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

const port = Number(process.env.PORT || 8787);
const corsOrigin = process.env.CORS_ORIGIN || "*";
const apiKey = process.env.GEMINI_API_KEY || "";
const primaryModel = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
const fallbackModel = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash";
const publicAppUrl = process.env.PUBLIC_APP_URL || "";

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: corsOrigin === "*" ? true : corsOrigin.split(",").map((origin) => origin.trim()),
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"]
});

const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;
const sessions = new Map();

app.use(
  cors({
    origin: corsOrigin === "*" ? true : corsOrigin.split(",").map((origin) => origin.trim())
  })
);
app.use(express.json({ limit: "12mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    geminiConfigured: Boolean(apiKey),
    primaryModel,
    fallbackModel,
    publicAppUrl
  });
});

app.post("/api/gemini/answer", async (req, res) => {
  try {
    const { question, context } = req.body || {};
    if (!question || typeof question !== "string") {
      res.status(400).json({ ok: false, error: "question is required" });
      return;
    }
    const result = await generateAnswer({ question, context: normalizeContext(context) });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: publicError(error) });
  }
});

app.post("/api/gemini/vision-question", async (req, res) => {
  try {
    const { imageDataUrl, context } = req.body || {};
    if (!imageDataUrl || typeof imageDataUrl !== "string") {
      res.status(400).json({ ok: false, error: "imageDataUrl is required" });
      return;
    }
    const result = await extractQuestionFromMedia({
      dataUrl: imageDataUrl,
      context: normalizeContext(context),
      mediaKind: "image"
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: publicError(error) });
  }
});

app.post("/api/gemini/audio-question", async (req, res) => {
  try {
    const { audioDataUrl, context } = req.body || {};
    if (!audioDataUrl || typeof audioDataUrl !== "string") {
      res.status(400).json({ ok: false, error: "audioDataUrl is required" });
      return;
    }
    const result = await extractQuestionFromMedia({
      dataUrl: audioDataUrl,
      context: normalizeContext(context),
      mediaKind: "audio"
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ ok: false, error: publicError(error) });
  }
});

const shouldServeStatic = process.env.NODE_ENV === "production" || fs.existsSync(path.join(distDir, "index.html"));

if (shouldServeStatic) {
  app.use(express.static(distDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

io.on("connection", (socket) => {
  socket.emit("server:ready", {
    socketId: socket.id,
    geminiConfigured: Boolean(apiKey),
    primaryModel,
    fallbackModel,
    publicAppUrl
  });

  socket.on("session:create", (payload, ack) => {
    const reply = toAck(ack);
    const context = normalizeContext(payload?.context);

    const roomId = createRoomId();
    const session = {
      roomId,
      context,
      createdAt: Date.now(),
      producerSocketId: socket.id,
      status: "ready",
      questions: [],
      answers: [],
      clients: new Set([socket.id]),
      lastQuestionKey: "",
      lastQuestionAt: 0
    };

    sessions.set(roomId, session);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.clientRole = "producer";

    reply({ ok: true, roomId, session: publicSession(session) });
    io.to(roomId).emit("session:state", publicSession(session));
  });

  socket.on("session:join", (payload, ack) => {
    const reply = toAck(ack);
    const roomId = String(payload?.roomId || "").trim().toUpperCase();
    const role = payload?.role === "producer" ? "producer" : "viewer";
    const session = sessions.get(roomId);

    if (!session) {
      reply({ ok: false, error: "Room not found. Check the ID or create a desktop session first." });
      return;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.clientRole = role;
    session.clients.add(socket.id);

    reply({ ok: true, session: publicSession(session) });
    io.to(roomId).emit("session:state", publicSession(session));
  });

  socket.on("capture:status", (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId || !sessions.has(roomId)) return;

    const statusPayload = {
      at: Date.now(),
      state: String(payload?.state || "unknown"),
      detail: String(payload?.detail || "")
    };

    io.to(roomId).emit("capture:status", statusPayload);
  });

  socket.on("transcript:partial", (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId || !sessions.has(roomId)) return;

    io.to(roomId).emit("transcript:partial", {
      at: Date.now(),
      text: String(payload?.text || "").slice(0, 2000),
      source: String(payload?.source || "screen-audio")
    });
  });

  socket.on("question:detected", async (payload, ack) => {
    const reply = toAck(ack);
    const roomId = socket.data.roomId || String(payload?.roomId || "").trim().toUpperCase();
    const session = sessions.get(roomId);

    if (!session) {
      reply({ ok: false, error: "No active session for this socket." });
      return;
    }

    const question = sanitizeText(payload?.question, 1800);
    const source = sanitizeText(payload?.source || "screen", 40);
    const key = normalizedKey(question);
    const now = Date.now();

    if (!question || question.length < 8) {
      reply({ ok: false, error: "Question is too short." });
      return;
    }

    if (key === session.lastQuestionKey && now - session.lastQuestionAt < 12000) {
      reply({ ok: true, skipped: true, reason: "duplicate" });
      return;
    }

    session.lastQuestionKey = key;
    session.lastQuestionAt = now;

    const questionEvent = {
      id: nanoid(12),
      at: now,
      source,
      question
    };

    session.questions.unshift(questionEvent);
    session.questions = session.questions.slice(0, 40);
    io.to(roomId).emit("question:new", questionEvent);
    io.to(roomId).emit("answer:pending", {
      questionId: questionEvent.id,
      at: Date.now()
    });
    reply({ ok: true, questionId: questionEvent.id });

    try {
      const answer = await generateAnswer({
        question,
        context: session.context
      });
      const answerEvent = {
        id: nanoid(12),
        questionId: questionEvent.id,
        question,
        answer: answer.text,
        model: answer.model,
        latencyMs: answer.latencyMs,
        at: Date.now()
      };
      session.answers.unshift(answerEvent);
      session.answers = session.answers.slice(0, 40);
      io.to(roomId).emit("answer:ready", answerEvent);
    } catch (error) {
      io.to(roomId).emit("answer:error", {
        questionId: questionEvent.id,
        at: Date.now(),
        error: publicError(error)
      });
    }
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const session = roomId ? sessions.get(roomId) : null;
    if (!session) return;

    session.clients.delete(socket.id);
    io.to(roomId).emit("session:state", publicSession(session));

    if (session.clients.size === 0) {
      setTimeout(() => {
        const stale = sessions.get(roomId);
        if (stale && stale.clients.size === 0) {
          sessions.delete(roomId);
        }
      }, 10 * 60 * 1000);
    }
  });
});

server.listen(port, () => {
  console.log(`Sensible server listening on http://localhost:${port}`);
});

function createRoomId() {
  return nanoid(8).replace(/[-_]/g, "").slice(0, 6).toUpperCase();
}

function toAck(ack) {
  return typeof ack === "function" ? ack : () => {};
}

function normalizeContext(context) {
  return {
    role: sanitizeText(context?.role, 180),
    projects: sanitizeText(context?.projects, 6000),
    company: sanitizeText(context?.company, 1200)
  };
}

function sanitizeText(value, maxLength) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
    .slice(0, maxLength);
}

function normalizedKey(value) {
  return sanitizeText(value, 1000)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function publicSession(session) {
  return {
    roomId: session.roomId,
    createdAt: session.createdAt,
    status: session.status,
    clientCount: session.clients.size,
    questionCount: session.questions.length,
    answerCount: session.answers.length,
    context: {
      role: session.context.role,
      company: session.context.company
    },
    recentQuestions: session.questions.slice(0, 10),
    recentAnswers: session.answers.slice(0, 10)
  };
}

async function generateAnswer({ question, context }) {
  if (!ai) {
    throw new Error("Sensible engine is not configured. Set the server API key.");
  }

  const startedAt = Date.now();
  const prompt = buildAnswerPrompt({ question, context });

  try {
    const text = await withTimeout(
      generateText({
        model: primaryModel,
        systemInstruction: answerSystemInstruction(),
        prompt,
        maxOutputTokens: 360
      }),
      15000
    );
    return { text, model: primaryModel, latencyMs: Date.now() - startedAt };
  } catch (primaryError) {
    await delay(200);
    const fallbackPrompt = buildFallbackPrompt({ question, context });
    const text = await withTimeout(
      generateText({
        model: fallbackModel || primaryModel,
        systemInstruction: fallbackSystemInstruction(),
        prompt: fallbackPrompt,
        maxOutputTokens: 300
      }),
      15000
    ).catch((fallbackError) => {
      throw new Error(`${publicError(primaryError)} Fallback failed: ${publicError(fallbackError)}`);
    });
    return { text, model: fallbackModel || primaryModel, latencyMs: Date.now() - startedAt };
  }
}

async function extractQuestionFromMedia({ dataUrl, context, mediaKind }) {
  if (!ai) {
    throw new Error("Sensible engine is not configured. Set the server API key.");
  }

  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    throw new Error("Invalid media data URL.");
  }

  const prompt =
    mediaKind === "audio"
      ? `Listen for the latest interview-practice question in this short audio segment. Return compact JSON only: {"question":"...","confidence":0.0}. If no clear question exists, use {"question":"","confidence":0}. Context role: ${context.role || "unspecified"}.`
      : `Read the screen image and extract the newest visible interview-practice question. Return compact JSON only: {"question":"...","confidence":0.0}. If no clear question exists, use {"question":"","confidence":0}. Context role: ${context.role || "unspecified"}.`;

  const startedAt = Date.now();
  let modelUsed = primaryModel;
  let responseText;

  try {
    responseText = await withTimeout(
      generateMediaText({
        model: primaryModel,
        prompt,
        mimeType: parsed.mimeType,
        data: parsed.data
      }),
      15000
    );
  } catch (primaryError) {
    if (!fallbackModel || fallbackModel === primaryModel) {
      throw primaryError;
    }

    modelUsed = fallbackModel;
    responseText = await withTimeout(
      generateMediaText({
        model: fallbackModel,
        prompt,
        mimeType: parsed.mimeType,
        data: parsed.data
      }),
      15000
    ).catch((fallbackError) => {
      throw new Error(`${publicError(primaryError)} Media fallback failed: ${publicError(fallbackError)}`);
    });
  }

  const json = parseJsonLoose(responseText);

  return {
    question: sanitizeText(json?.question, 1800),
    confidence: clamp(Number(json?.confidence || 0), 0, 1),
    model: modelUsed,
    latencyMs: Date.now() - startedAt
  };
}

async function generateText({ model, systemInstruction, prompt, maxOutputTokens }) {
  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      systemInstruction,
      temperature: 0.48,
      topP: 0.9,
      maxOutputTokens
    }
  });

  return normalizeModelText(response.text);
}

async function generateMediaText({ model, prompt, mimeType, data }) {
  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType,
              data
            }
          }
        ]
      }
    ],
    config: {
      temperature: 0.1,
      topP: 0.7,
      maxOutputTokens: 180
    }
  });

  return normalizeModelText(response.text);
}

function answerSystemInstruction() {
  return [
    "You are Sensible, an interview practice coach for mock or explicitly permitted sessions.",
    "Never help the user misrepresent experience. Only synthesize from the candidate-owned context provided.",
    "Start directly with the answer draft. No greetings, no filler, no 'based on the context'.",
    "Make it sound natural when spoken out loud in 30-45 seconds.",
    "Use first person only for details grounded in the provided project experience.",
    "Use bold markdown sparingly for key metrics, technologies, and decisions that are easy to glance at on mobile."
  ].join("\n");
}

function fallbackSystemInstruction() {
  return [
    "Create a concise, spoken interview-practice answer draft.",
    "No filler. No claims beyond the supplied context.",
    "Keep it under 130 words and emphasize practical technical choices."
  ].join("\n");
}

function buildAnswerPrompt({ question, context }) {
  return [
    `Question: ${question}`,
    "",
    "Candidate context:",
    `Role/subject: ${context.role || "Not provided"}`,
    `Target company/session: ${context.company || "Not provided"}`,
    `Projects and experience: ${context.projects || "Not provided"}`,
    "",
    "Draft a compact answer for practice. If the context lacks evidence, say how I would frame the answer honestly without inventing specifics."
  ].join("\n");
}

function buildFallbackPrompt({ question, context }) {
  return [
    `Question: ${question}`,
    `Role: ${context.role || "candidate"}`,
    `Relevant experience: ${context.projects || "not supplied"}`,
    "Return a concise answer draft for an authorized practice setting. Do not invent credentials."
  ].join("\n");
}

function normalizeModelText(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) {
    throw new Error("Sensible engine returned an empty response.");
  }
  return cleaned;
}

function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:([^;,]+)(?:;[^,]*)*;base64,(.+)$/s);
  if (!match) return null;
  return {
    mimeType: match[1],
    data: match[2]
  };
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function publicError(error) {
  const message = error instanceof Error ? error.message : String(error || "Unknown error");
  return (apiKey ? message.replace(apiKey, "[redacted]") : message)
    .replace(/Gemini/gi, "Sensible engine")
    .replace(/models\/gemini[-\w.]+/gi, "selected engine model")
    .replace(/gemini[-\w.]+/gi, "selected engine model")
    .slice(0, 500);
}
