const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = 3001;
const OLLAMA_URL = "http://localhost:11434/api/generate";
const OLLAMA_MODEL = "qwen2.5-coder:3b-instruct";
const PROJECT_ROOT = path.resolve(__dirname, "..");

const IGNORED_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".vite",
]);

/* ============================================================
   PATH HELPERS
   ============================================================ */

function normalizePath(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

function getFullProjectPath(p) {
  const n = normalizePath(p);

  if (
    !n ||
    n === ".." ||
    n.startsWith("../") ||
    path.isAbsolute(n)
  ) {
    return null;
  }

  const full = path.resolve(PROJECT_ROOT, n);

  if (
    full !== PROJECT_ROOT &&
    !full.startsWith(PROJECT_ROOT + path.sep)
  ) {
    return null;
  }

  return full;
}

function isSafeProjectPath(p) {
  return Boolean(getFullProjectPath(p));
}

function getProjectRelativePath(p) {
  return normalizePath(path.relative(PROJECT_ROOT, p));
}

/* ============================================================
   PROJECT FILES
   ============================================================ */

function collectProjectFiles(dir = PROJECT_ROOT) {
  if (!fs.existsSync(dir)) return [];

  const out = [];

  for (const e of fs.readdirSync(dir, {
    withFileTypes: true,
  })) {
    if (IGNORED_NAMES.has(e.name)) continue;

    const full = path.join(dir, e.name);

    if (e.isDirectory()) {
      out.push(...collectProjectFiles(full));
    } else if (e.isFile()) {
      out.push(getProjectRelativePath(full));
    }
  }

  return out.sort();
}

function buildProjectTree(dir = PROJECT_ROOT) {
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir, {
      withFileTypes: true,
    })
    .filter((e) => !IGNORED_NAMES.has(e.name))
    .sort((a, b) =>
      a.isDirectory() === b.isDirectory()
        ? a.name.localeCompare(b.name)
        : a.isDirectory()
        ? -1
        : 1
    )
    .map((e) => {
      const full = path.join(dir, e.name);
      const rel = getProjectRelativePath(full);

      return e.isDirectory()
        ? {
            name: e.name,
            path: rel,
            type: "folder",
            children: buildProjectTree(full),
          }
        : {
            name: e.name,
            path: rel,
            type: "file",
          };
    });
}

function readProjectFile(p) {
  const full = getFullProjectPath(p);

  if (
    !full ||
    !fs.existsSync(full) ||
    !fs.statSync(full).isFile()
  ) {
    return null;
  }

  return fs.readFileSync(full, "utf8");
}

/* ============================================================
   OLLAMA
   ============================================================ */

async function callOllama(prompt, systemPrompt = "") {
  const r = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      system: systemPrompt,
      stream: false,
    }),
  });

  if (!r.ok) {
    throw new Error(`Ollama returned HTTP ${r.status}`);
  }

  const data = await r.json();

  return data.response || "";
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {}

  const m = String(text || "").match(/\{[\s\S]*\}/);

  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }

  return null;
}

/* ============================================================
   HEALTH
   ============================================================ */

app.get("/api/health", (req, res) =>
  res.json({
    status: "ok",
    message: "VibeCoder backend is running",
  })
);

/* ============================================================
   PROJECT
   ============================================================ */

app.get("/api/project", (req, res) => {
  try {
    res.json({
      success: true,
      files: buildProjectTree(),
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      success: false,
      error: "Could not read project structure.",
    });
  }
});

app.get("/api/project/file", (req, res) => {
  try {
    const p = req.query.path;

    if (!p) {
      return res.status(400).json({
        success: false,
        error: "File path is required.",
      });
    }

    if (!isSafeProjectPath(p)) {
      return res.status(400).json({
        success: false,
        error: "Unsafe file path.",
      });
    }

    const content = readProjectFile(p);

    if (content === null) {
      return res.status(404).json({
        success: false,
        error: "File not found.",
      });
    }

    res.json({
      success: true,
      path: normalizePath(p),
      content,
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      success: false,
      error: "Could not read file.",
    });
  }
});

/* ============================================================
   SMART CONTEXT
   ============================================================ */

function isRequestAboutStyling(t) {
  return /style|styling|css|layout|design|color|colour|background|font|text size|spacing|margin|padding|border|radius|responsive|appearance|theme|visual|look|ui|interface|section|button style|hover|shadow|alignment|sizing/i.test(
    t
  );
}

function isRequestAboutReact(t) {
  return /react|component|jsx|tsx|frontend|button|form|hook|state|props|interface|ui|user interface|section/i.test(
    t
  );
}

function isRequestAboutBackend(t) {
  return /backend|server|express|api|endpoint|ollama|database|middleware|api response|backend response/i.test(
    t
  );
}

function isRequestAboutLogic(t) {
  return /logic|function|variable|bug|error|debug|condition|loop|async|await|promise|event|handler/i.test(
    t
  );
}

function isRequestAboutConfig(t) {
  return /package|dependency|dependencies|npm|vite config|eslint|configuration|config|build config|typescript config/i.test(
    t
  );
}

function getSmartContextIntent(prompt) {
  const t = String(prompt || "");

  if (isRequestAboutStyling(t)) return "styling";
  if (isRequestAboutBackend(t)) return "backend";
  if (isRequestAboutConfig(t)) return "config";
  if (isRequestAboutReact(t)) return "react";
  if (isRequestAboutLogic(t)) return "logic";

  return "general";
}

function scoreFile(file, intent) {
  const n = normalizePath(file).toLowerCase();
  let s = 0;

  if (intent === "styling") {
    if (n.endsWith("app.css")) s += 100;
    if (n.endsWith(".css")) s += 70;
    if (n.endsWith("app.tsx")) s += 50;
    if (n.endsWith(".tsx")) s += 30;
    if (n.includes("server/")) s -= 50;
  }

  if (intent === "backend") {
    if (n === "server/index.js") s += 120;
    if (n.startsWith("server/")) s += 80;
    if (n.includes("api")) s += 40;
    if (n.endsWith(".js")) s += 20;
    if (n.endsWith(".css")) s -= 50;
  }

  if (intent === "config") {
    if (n.endsWith("package.json")) s += 120;
    if (n.includes("vite.config")) s += 100;
    if (n.includes("tsconfig")) s += 90;
    if (n.includes("eslint")) s += 80;
  }

  if (intent === "react") {
    if (n.endsWith("app.tsx")) s += 120;
    if (n.endsWith(".tsx")) s += 80;
    if (n.endsWith(".jsx")) s += 70;
    if (n.endsWith(".css")) s += 30;
    if (n.startsWith("server/")) s -= 60;
  }

  if (intent === "logic") {
    if (n.endsWith("app.tsx")) s += 100;
    if (n.endsWith(".tsx")) s += 70;
    if (n.endsWith(".ts")) s += 60;
    if (n.endsWith(".js")) s += 60;
    if (n.startsWith("server/")) s += 50;
  }

  if (intent === "general") {
    if (n.endsWith("app.tsx")) s += 100;
    if (n.endsWith(".tsx")) s += 60;
    if (n === "server/index.js") s += 50;
  }

  return s;
}

app.post("/api/project/suggest-context", (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "");
    const files = collectProjectFiles();
    const intent = getSmartContextIntent(prompt);

    const suggestions = files
      .map((file) => ({
        path: file,
        score: scoreFile(file, intent),
      }))
      .sort((a, b) => b.score - a.score)
      .filter((x) => x.score > 0)
      .slice(0, 5)
      .map((x) => ({
        path: x.path,
        reason: "Relevant to your request",
      }));

    res.json({
      success: true,
      intent,
      suggestions,
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      success: false,
      error: "Could not suggest context files.",
    });
  }
});

/* ============================================================
   EDUCATION MODE
   ============================================================ */

function educationFacts(source, filePath) {
  const code = String(source || "");
  const lines = code.split(/\r?\n/);
  const nonEmpty = lines.filter((x) => x.trim());

  const imports = [
    ...code.matchAll(
      /import\s+(.*?)\s+from\s+["'](.*?)["']/g
    ),
  ].map((m) => ({
    imported: m[1],
    from: m[2],
  }));

  const functions = [
    ...code.matchAll(
      /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g
    ),
  ].map((m) => m[1] || m[2]);

  const states = [
    ...code.matchAll(
      /const\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*useState\s*(?:<[^>]+>)?\s*\(/g
    ),
  ].map((m) => ({
    value: m[1],
    setter: m[2],
  }));

  const fetchCalls = [
    ...code.matchAll(/fetch\s*\(/g),
  ].length;

  const responseJsonCalls = [
    ...code.matchAll(/response\.json\s*\(/g),
  ].length;

  const asyncFunctions = [
    ...code.matchAll(
      /\basync\s+(?:function\s+)?([A-Za-z_$][\w$]*)/g
    ),
  ]
    .map((m) => m[1])
    .filter(Boolean);

  const eventHandlers = [
    ...code.matchAll(/\bon[A-Z][A-Za-z]+\s*=\s*/g),
  ].map((m) => m[0].replace(/\s*=\s*$/, "").trim());

  const endpoints = [
    ...code.matchAll(
      /https?:\/\/localhost:\d+\/api\/[A-Za-z0-9_?=&./-]+/g
    ),
  ].map((m) => m[0]);

  const hasPromise =
    /\bPromise\b|\bawait\b|\.then\s*\(/.test(code);

  return {
    filePath,
    lineCount: lines.length,
    nonEmptyLineCount: nonEmpty.length,
    imports,
    functions: [...new Set(functions)],
    states,
    fetchCalls,
    responseJsonCalls,
    asyncFunctions: [...new Set(asyncFunctions)],
    eventHandlers: [...new Set(eventHandlers)],
    endpoints: [...new Set(endpoints)],
    variableDeclarations: [
      ...code.matchAll(
        /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*/g
      ),
    ].length,
    returnStatements: [
      ...code.matchAll(/\breturn\b/g),
    ].length,
    conditionalCount: [
      ...code.matchAll(/\bif\s*\(|\?.*:/g),
    ].length,
    loopCount: [
      ...code.matchAll(
        /\b(?:for|while)\s*\(|\.map\s*\(/g
      ),
    ].length,
    hasTryCatch: /try\s*\{[\s\S]*?catch\s*\(/.test(code),
    hasJSX:
      /<[A-Za-z][^>]*>/.test(code) &&
      /<\/[A-Za-z][^>]*>/.test(code),
    hasUseState: /\buseState\s*\(/.test(code),
    hasPromise,
  };
}

function findState(facts, name) {
  return facts.states.find((s) => s.value === name);
}

function extractModeRelationships(source) {
  const code = String(source || "");
  const out = [];

  const stateMatch = code.match(
    /const\s*\[\s*mode\s*,\s*setMode\s*\]\s*=\s*useState\s*(?:<[^>]+>)?\s*\(([^)]*)\)/
  );

  if (stateMatch) {
    out.push({
      type: "state",
      text: `The mode state is initialized with ${
        stateMatch[1].trim() || "a default value"
      }, using setMode to update it.`,
    });
  }

  const calls = [
    ...code.matchAll(
      /setMode\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g
    ),
  ].map((m) => m[1]);

  if (calls.length) {
    out.push({
      type: "setters",
      values: [...new Set(calls)],
    });
  }

  const modeChecks = [
    ...code.matchAll(
      /mode\s*(?:===|==)\s*["'`]([^"'`]+)["'`]/g
    ),
  ].map((m) => m[1]);

  if (modeChecks.length) {
    out.push({
      type: "checks",
      values: [...new Set(modeChecks)],
    });
  }

  const buttonBlocks = [
    ...code.matchAll(
      /<button\b[^>]*>[\s\S]*?<\/button>/gi
    ),
  ].map((m) => m[0]);

  for (const b of buttonBlocks) {
    if (/setMode\s*\(/.test(b)) {
      const text = b
        .replace(/<[^>]+>/g, " ")
        .replace(/\{[\s\S]*?\}/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const sm = b.match(
        /setMode\s*\(\s*["'`]([^"'`]+)["'`]/
      );

      if (sm) {
        out.push({
          type: "button",
          label: text || "mode button",
          value: sm[1],
        });
      }
    }
  }

  return out;
}

function findRelevantCode(source, prompt) {
  const code = String(source || "");
  const t = String(prompt || "").toLowerCase();
  const chunks = [];

  if (
    /mode|setmode|vibe coding|education mode|safe mode|button/.test(
      t
    )
  ) {
    const rel = extractModeRelationships(code);

    if (rel.length) {
      chunks.push(...rel);
    }
  }

  if (/state|usestate/.test(t)) {
    for (const s of educationFacts(code, "").states.slice(0, 8)) {
      const re = new RegExp(
        `(?:const\\s*\\[\\s*${s.value}\\s*,[\\s\\S]{0,80}|${s.setter}\\s*\\()[^\\n]*`
      );

      const m = code.match(re);

      chunks.push({
        type: "stateDetail",
        value: s.value,
        setter: s.setter,
        code: m ? m[0].trim() : "",
      });
    }
  }

  return chunks.slice(0, 12);
}

function educationGoal(prompt) {
  const t = String(prompt || "").toLowerCase();

  if (/mode|setmode|vibe coding|education mode|safe mode/.test(t)) {
    return "Understand how the application's mode state controls what the interface does.";
  }

  if (/button|click|handler|event/.test(t)) {
    return "Understand how a user action travels through the React event system.";
  }

  if (/state|usestate/.test(t)) {
    return "Understand how React state is created, updated, and used by the interface.";
  }

  if (/api|fetch|backend|server/.test(t)) {
    return "Understand how the frontend communicates with the backend.";
  }

  return "Understand the selected code by connecting its parts to the application's behavior.";
}

function buildRelationshipLesson(source, filePath, prompt) {
  const rel = extractModeRelationships(source);

  if (!rel.length) return null;

  const state = rel.find((x) => x.type === "state");
  const setters = rel.find((x) => x.type === "setters");
  const checks = rel.find((x) => x.type === "checks");
  const buttons = rel.filter((x) => x.type === "button");

  const lines = [];

  lines.push("**EDUCATION MODE**");
  lines.push("");

  lines.push("## What you will learn");
  lines.push("");
  lines.push(educationGoal(prompt));
  lines.push("");

  lines.push("## The big picture");
  lines.push("");

  lines.push(
    "This part of the application is connected through a chain of events:"
  );
  lines.push("");

  lines.push(
    "**User clicks a button → the button handler runs → `setMode(...)` updates React state → `mode` receives the new value → React renders again using the new state → mode-dependent UI or behavior can change.**"
  );
  lines.push("");

  if (buttons.length) {
    lines.push("## 1. Start with the buttons");
    lines.push("");

    for (const b of buttons) {
      lines.push(
        `- **${b.label}** calls \`setMode("${b.value}")\`.`
      );
    }

    lines.push("");

    lines.push(
      "The important idea is that the button does not directly redraw the whole interface. It requests a state change."
    );
    lines.push("");
  }

  if (state) {
    lines.push("## 2. The `mode` state");
    lines.push("");

    lines.push(
      "`mode` stores which application mode is currently active."
    );
    lines.push("");

    lines.push(
      "`setMode` is the function React provides for changing that state."
    );
    lines.push("");

    lines.push(
      "When `setMode(...)` is called, React schedules a re-render so the interface can use the updated value."
    );
    lines.push("");
  }

  if (setters?.values?.length) {
    lines.push("## 3. Possible mode values");
    lines.push("");

    for (const value of setters.values) {
      lines.push(`- \`${value}\``);
    }

    lines.push("");

    lines.push(
      "These values act like labels that let the application know which behavior or interface state is active."
    );
    lines.push("");
  }

  if (checks?.values?.length) {
    lines.push("## 4. Where the state is used");
    lines.push("");

    for (const value of checks.values) {
      lines.push(
        `The code checks whether \`mode === "${value}"\`.`
      );
    }

    lines.push("");

    lines.push(
      "This is the second half of the relationship: changing state only becomes useful when the application reads that state and makes a decision from it."
    );
    lines.push("");
  }

  lines.push("## 5. Why this relationship matters");
  lines.push("");

  lines.push(
    "The important concept is **state-driven UI**. Instead of manually telling every part of the page what to do after a click, React lets the application store the current state and render from that state."
  );
  lines.push("");

  lines.push(
    "That makes the interface easier to reason about: the current `mode` describes the current application state."
  );
  lines.push("");

  lines.push("## Quick check");
  lines.push("");

  if (buttons.length && setters?.values?.length) {
    lines.push(
      `**Think about this:** if a user clicks a button that calls \`setMode("${setters.values[0]}")\`, what value should \`mode\` have after React updates the state?`
    );
  } else {
    lines.push(
      "**Think about this:** what changes in the application when the value stored in `mode` changes?"
    );
  }

  lines.push("");

  lines.push("## Source");
  lines.push("");

  lines.push(
    `Selected file: \`${normalizePath(filePath)}\``
  );

  return lines.join("\n");
}

/* ============================================================
   MAIN EDUCATION LESSON
   ============================================================ */

function buildEducationLesson(source, filePath, prompt) {
  const code = String(source || "");
  const t = String(prompt || "").toLowerCase();
  const facts = educationFacts(code, filePath);

  /*
   * EDUCATION MODE PRIORITY
   *
   * The student's actual question decides the lesson.
   */

  const asksAboutBackendFlow =
    /frontend.*backend|backend.*frontend|frontend.*server|server.*frontend|ai response|response.*screen|screen.*response|ollama|api.*response|response.*api|request.*response|prompt.*backend|backend.*prompt|how.*response.*(screen|frontend|display)|how.*(ai|response).*gets.*(screen|page)/i.test(
      prompt
    );

  const asksAboutMode =
    /mode|setmode|vibe coding|education mode|safe mode/.test(t) &&
    !asksAboutBackendFlow;

  const asksAboutState =
    /state|usestate|setstate|react state/.test(t) &&
    !asksAboutBackendFlow &&
    !asksAboutMode;

  /* ==========================================================
     FRONTEND → BACKEND → OLLAMA → FRONTEND
     ========================================================== */

  if (asksAboutBackendFlow) {
    const hasHandleBuild =
      /\bhandleBuild\b/.test(code);

    const hasFetch =
      /\bfetch\s*\(/.test(code);

    const hasChatEndpoint =
      /\/api\/chat/.test(code);

    const hasPost =
      /method\s*:\s*["']POST["']/.test(code);

    const hasJsonStringify =
      /JSON\.stringify\s*\(/.test(code);

    const hasResponseJson =
      /response\.json\s*\(/.test(code);

    const hasAiResponse =
      /\baiResponse\b/.test(code);

    const hasSetAiResponse =
      /\bsetAiResponse\s*\(/.test(code);

    const lines = [];

    lines.push("**EDUCATION MODE**");
    lines.push("");

    lines.push("## What you will learn");
    lines.push("");

    lines.push(
      "Understand how VibeCoder EDU sends a user's prompt from the React frontend to the backend and brings the AI response back onto the screen."
    );
    lines.push("");

    lines.push("## The big picture");
    lines.push("");

    lines.push(
      "**User enters a prompt → React handler runs → frontend sends a POST request → `/api/chat` receives it → backend sends the prompt to Ollama → Ollama generates the answer → backend returns the answer → frontend receives the response → React updates `aiResponse` → the UI displays it.**"
    );
    lines.push("");

    lines.push("## 1. The user starts the process");
    lines.push("");

    if (hasHandleBuild) {
      lines.push(
        "The process begins inside the frontend's `handleBuild` logic. This is the code responsible for taking the user's request and starting the AI interaction."
      );
    } else {
      lines.push(
        "The process begins in the frontend when the user submits their prompt."
      );
    }

    lines.push("");

    lines.push("## 2. The frontend sends the request");
    lines.push("");

    if (hasFetch && hasChatEndpoint && hasPost) {
      lines.push(
        "The frontend uses `fetch(...)` to make a **POST** request to `/api/chat`."
      );
    } else if (hasFetch) {
      lines.push(
        "The frontend uses `fetch(...)` to communicate with the backend."
      );
    } else {
      lines.push(
        "The frontend prepares a request that is sent to the backend."
      );
    }

    lines.push("");

    if (hasJsonStringify) {
      lines.push(
        "`JSON.stringify(...)` converts the request data into JSON so it can be sent in the HTTP request body."
      );
      lines.push("");
    }

    lines.push("## 3. The backend receives the request");
    lines.push("");

    lines.push(
      "The backend's `/api/chat` endpoint receives the frontend request."
    );
    lines.push("");

    lines.push(
      "The backend can then read the user's prompt and decide how it should be handled."
    );
    lines.push("");

    lines.push("## 4. The backend communicates with Ollama");
    lines.push("");

    lines.push(
      "VibeCoder EDU's backend sends the prompt to the local Ollama service, which runs the Qwen2.5-Coder model."
    );
    lines.push("");

    lines.push(
      "This keeps the AI processing connected to the local development environment."
    );
    lines.push("");

    lines.push("## 5. Ollama generates the response");
    lines.push("");

    lines.push(
      "Ollama processes the prompt and generates the AI response."
    );
    lines.push("");

    lines.push(
      "The backend receives that generated response and prepares it to send back to the browser."
    );
    lines.push("");

    lines.push("## 6. The response returns to React");
    lines.push("");

    if (hasResponseJson) {
      lines.push(
        "The frontend reads the server's JSON response using `response.json()`."
      );
    } else {
      lines.push(
        "The frontend receives the backend's response and processes the returned data."
      );
    }

    lines.push("");

    if (hasSetAiResponse) {
      lines.push(
        "The important React connection is `setAiResponse(...)`. This updates the state containing the AI response."
      );
    }

    lines.push("");

    lines.push("## 7. React displays the answer");
    lines.push("");

    if (hasAiResponse) {
      lines.push(
        "`aiResponse` stores the generated answer, and React uses that state when rendering the interface."
      );
    } else {
      lines.push(
        "The returned AI data is stored in frontend state and used by React to update the interface."
      );
    }

    lines.push("");

    lines.push("## The complete relationship");
    lines.push("");

    lines.push("```text");
    lines.push("User prompt");
    lines.push("    ↓");
    lines.push("Frontend handler");
    lines.push("    ↓");
    lines.push("fetch('/api/chat')");
    lines.push("    ↓");
    lines.push("Express backend");
    lines.push("    ↓");
    lines.push("Ollama + Qwen2.5-Coder");
    lines.push("    ↓");
    lines.push("AI response");
    lines.push("    ↓");
    lines.push("response.json()");
    lines.push("    ↓");
    lines.push("setAiResponse(...)");
    lines.push("    ↓");
    lines.push("React re-renders");
    lines.push("    ↓");
    lines.push("Response appears on screen");
    lines.push("```");
    lines.push("");

    lines.push("## Why this relationship matters");
    lines.push("");

    lines.push(
      "This shows an important full-stack concept: the browser does not directly ask Ollama for the answer. The React frontend communicates with the Express backend, and the backend communicates with the local AI service."
    );
    lines.push("");

    lines.push(
      "Each layer has a responsibility, which makes the application easier to organize and maintain."
    );
    lines.push("");

    lines.push("## Quick check");
    lines.push("");

    lines.push(
      "**Think about this:** why does the frontend need the backend between itself and Ollama instead of simply putting the Ollama request directly inside the browser code?"
    );
    lines.push("");

    lines.push("## Source");
    lines.push("");

    lines.push(
      `Selected file: \`${normalizePath(filePath)}\``
    );

    return lines.join("\n");
  }

  /* ==========================================================
     MODE LESSON
     ========================================================== */

  if (asksAboutMode) {
    const relationshipLesson = buildRelationshipLesson(
      source,
      filePath,
      prompt
    );

    if (relationshipLesson) {
      return relationshipLesson;
    }
  }

  /* ==========================================================
     STATE LESSON
     ========================================================== */

  if (asksAboutState) {
    const lines = [];

    lines.push("**EDUCATION MODE**");
    lines.push("");

    lines.push("## What you will learn");
    lines.push("");

    lines.push(
      "Understand how React state is created, updated, and used by the interface."
    );
    lines.push("");

    lines.push("## State detected in this file");
    lines.push("");

    if (facts.states.length) {
      for (const state of facts.states) {
        lines.push(
          `- \`${state.value}\` is the state value.`
        );

        lines.push(
          `- \`${state.setter}\` is the function used to update it.`
        );

        lines.push("");
      }
    } else {
      lines.push(
        "No `useState` relationship was detected in the selected source."
      );
      lines.push("");
    }

    lines.push("## The basic relationship");
    lines.push("");

    lines.push(
      "**State value → setter function → state changes → React re-renders → UI reflects the new state.**"
    );
    lines.push("");

    lines.push("## Why this matters");
    lines.push("");

    lines.push(
      "React state allows the interface to respond to user actions and changing application data without manually redrawing the page."
    );
    lines.push("");

    lines.push("## Quick check");
    lines.push("");

    lines.push(
      "**Think about this:** what would happen to the interface if the setter function changed a state value?"
    );
    lines.push("");

    lines.push("## Source");
    lines.push("");

    lines.push(
      `Selected file: \`${normalizePath(filePath)}\``
    );

    return lines.join("\n");
  }

  /* ==========================================================
     GENERAL SOURCE-GROUNDED LESSON
     ========================================================== */

  const relevant = findRelevantCode(
    source,
    prompt
  );

  const lines = [];

  lines.push("**EDUCATION MODE**");
  lines.push("");

  lines.push("## Learning goal");
  lines.push("");

  lines.push(educationGoal(prompt));
  lines.push("");

  lines.push("## Source snapshot");
  lines.push("");

  lines.push(
    `- **File:** \`${normalizePath(filePath)}\``
  );

  lines.push(
    `- **Lines:** ${facts.lineCount}`
  );

  lines.push(
    `- **Non-empty lines:** ${facts.nonEmptyLineCount}`
  );

  if (facts.functions.length) {
    lines.push(
      `- **Functions detected:** ${facts.functions.join(", ")}`
    );
  }

  if (facts.states.length) {
    lines.push(
      `- **React state:** ${facts.states
        .map(
          (s) =>
            `\`${s.value}\` / \`${s.setter}\``
        )
        .join(", ")}`
    );
  }

  if (facts.fetchCalls) {
    lines.push(
      `- **Fetch calls:** ${facts.fetchCalls}`
    );
  }

  if (facts.responseJsonCalls) {
    lines.push(
      `- **JSON response parsing:** ${facts.responseJsonCalls}`
    );
  }

  lines.push("");

  if (relevant.length) {
    lines.push("## Relevant relationships");
    lines.push("");

    for (const item of relevant) {
      if (item.type === "stateDetail") {
        lines.push(
          `- React state \`${item.value}\` is controlled by \`${item.setter}\`.`
        );

        if (item.code) {
          lines.push(
            `  - Source pattern: \`${item.code}\``
          );
        }
      }
    }

    lines.push("");
  }

  lines.push("## How to read this code");
  lines.push("");

  lines.push(
    "Start with the values and functions that directly affect the behavior you are studying. Then follow where those values are created, changed, and finally used."
  );
  lines.push("");

  lines.push("## Quick check");
  lines.push("");

  lines.push(
    "Choose one important variable or function in this file and trace three things: **where it is created, where it changes, and where its value is used.**"
  );
  lines.push("");

  lines.push("## Source");
  lines.push("");

  lines.push(
    `Selected file: \`${normalizePath(filePath)}\``
  );

  return lines.join("\n");
}

/* ============================================================
   UI ANALYSIS
   ============================================================ */

function isUiStylingRequest(prompt) {
  const t = String(prompt || "").toLowerCase();

  return (
    /make.*(look|design|ui|interface|beautiful|modern|clean|professional)/.test(
      t
    ) ||
    /improve.*(ui|design|styling|appearance)/.test(t) ||
    /change.*(color|colour|background|font|spacing|layout)/.test(t) ||
    /dark mode|dark theme|responsive design/.test(t)
  );
}

function buildUiStylingAnalysis(
  prompt,
  contextFiles,
  selectedFile,
  selectedFileContent
) {
  const lines = [];

  lines.push("**UI/STYLING ANALYSIS**");
  lines.push("");

  lines.push("## Request");
  lines.push("");
  lines.push(prompt);
  lines.push("");

  lines.push("## Recommended approach");
  lines.push("");

  lines.push(
    "First inspect the existing component structure and styles. Then make the smallest coordinated changes needed so the new visual design remains consistent with the current application."
  );
  lines.push("");

  if (selectedFile) {
    lines.push(
      `Selected file: \`${normalizePath(selectedFile)}\``
    );
    lines.push("");
  }

  if (contextFiles.length) {
    lines.push("Relevant context files:");
    lines.push("");

    for (const file of contextFiles) {
      lines.push(`- \`${normalizePath(file)}\``);
    }

    lines.push("");
  }

  lines.push("## Design priorities");
  lines.push("");

  lines.push("- Keep the interface readable.");
  lines.push("- Preserve existing functionality.");
  lines.push("- Use consistent spacing and typography.");
  lines.push("- Keep buttons and interactive states obvious.");
  lines.push("- Avoid unnecessary visual complexity.");
  lines.push("");

  lines.push(
    "No files have been changed by this analysis."
  );

  return lines.join("\n");
}

/* ============================================================
   FILE FUNCTION ANALYSIS
   ============================================================ */

function isFileFunctionRequest(prompt) {
  const t = String(prompt || "").toLowerCase();

  return (
    /what does.*(file|code|function)/.test(t) ||
    /explain.*(file|code|function)/.test(t) ||
    /how.*work.*(file|code|function)/.test(t) ||
    /what is this file/.test(t)
  );
}

function buildFileFunctionSummary(source, filePath) {
  const facts = educationFacts(source, filePath);

  const lines = [];

  lines.push("**FILE ANALYSIS**");
  lines.push("");

  lines.push(
    `## ${normalizePath(filePath)}`
  );
  lines.push("");

  lines.push(
    `This file contains **${facts.lineCount} lines** and **${facts.nonEmptyLineCount} non-empty lines**.`
  );
  lines.push("");

  if (facts.functions.length) {
    lines.push("### Functions");
    lines.push("");

    for (const fn of facts.functions) {
      lines.push(`- \`${fn}\``);
    }

    lines.push("");
  }

  if (facts.states.length) {
    lines.push("### React state");
    lines.push("");

    for (const state of facts.states) {
      lines.push(
        `- \`${state.value}\` is updated with \`${state.setter}\``
      );
    }

    lines.push("");
  }

  if (facts.fetchCalls) {
    lines.push(
      `### Network communication: ${facts.fetchCalls} fetch call(s)`
    );
    lines.push("");
  }

  if (facts.hasJSX) {
    lines.push(
      "### UI: JSX markup is present, so this file contributes to the React interface."
    );
    lines.push("");
  }

  lines.push("### Overall role");
  lines.push("");

  lines.push(
    "The file combines application logic with the structures detected above. Follow the functions and state values to understand how its behavior is connected."
  );

  return lines.join("\n");
}

/* ============================================================
   DARK MODE PLAN
   ============================================================ */

function isDarkModeRequest(prompt) {
  const t = String(prompt || "").toLowerCase();

  return (
    t.includes("dark mode") ||
    t.includes("dark theme") ||
    t.includes("dark-mode")
  );
}

function buildDeterministicAgentPlan(prompt) {
  if (!isDarkModeRequest(prompt)) return null;

  const files = collectProjectFiles();

  const appFile = files.find(
    (x) => x.toLowerCase() === "src/app.tsx"
  );

  const cssFile = files.find(
    (x) => x.toLowerCase() === "src/app.css"
  );

  const selected = [
    ...[appFile, cssFile].filter(Boolean),
  ];

  const steps = [];

  if (appFile) {
    steps.push(
      `Inspect \`${appFile}\` and add React state to track dark mode.`
    );

    steps.push(
      `Add a dark mode toggle in \`${appFile}\` using the existing event-handler pattern.`
    );
  }

  if (cssFile) {
    steps.push(
      `Update existing \`${cssFile}\` styles with state-based dark-mode styling.`
    );
  }

  steps.push(
    "Connect the toggle to the existing interface and verify current functionality remains intact."
  );

  return {
    summary: selected.length
      ? `Add dark mode using the existing ${selected.join(
          " and "
        )} structure.`
      : "Add dark mode using the existing project structure.",

    steps: steps.slice(0, 4),
  };
}

/* ============================================================
   AGENT PLAN
   ============================================================ */

app.post("/api/agent/plan", async (req, res) => {
  const prompt = String(req.body?.prompt || "");
  const mode = String(req.body?.mode || "vibe");

  const contextFiles = Array.isArray(
    req.body?.contextFiles
  )
    ? req.body.contextFiles
    : [];

  try {
    const d = buildDeterministicAgentPlan(prompt);

    if (d) {
      return res.json({
        success: true,
        plan: d,
      });
    }

    const files = collectProjectFiles();

    const context = contextFiles
      .filter(isSafeProjectPath)
      .map((f) => ({
        path: f,
        content:
          readProjectFile(f)?.slice(0, 12000) || "",
      }));

    const raw = await callOllama(
      `Create a safe project-aware implementation plan.

USER REQUEST:
${prompt}

MODE:
${mode}

PROJECT FILES:
${files.join("\n")}

CONTEXT:
${JSON.stringify(context, null, 2)}

Return ONLY JSON with summary and steps (max 4).`,
      "You are a careful software engineering planning assistant."
    );

    const p = extractJson(raw);

    res.json({
      success: true,

      plan:
        p &&
        typeof p.summary === "string" &&
        Array.isArray(p.steps)
          ? {
              summary: p.summary,
              steps: p.steps.slice(0, 4),
            }
          : {
              summary:
                "Inspect the existing project structure before making the requested change.",

              steps: [
                "Identify relevant existing files.",
                "Inspect the source before changing anything.",
                "Modify the smallest appropriate set of files.",
                "Test and verify existing functionality.",
              ],
            },
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

/* ============================================================
   DEBUGGING
   ============================================================ */

app.post("/api/agent/debug", async (req, res) => {
  try {
    const selectedFile = req.body?.selectedFile;

    if (!selectedFile) {
      return res.json({
        success: true,

        result: {
          title: "Diagnostics",

          content:
            "**DIAGNOSTICS**\n\n## Debugging Agent\n\n**READY**\n\n**PROBLEM**\nNo file is currently selected.\n\n**WHY**\nThe Debugging Agent needs a real project file to inspect.\n\n**SUGGESTED FIX**\nSelect the relevant file and run Debugging Agent again.\n\n**CONFIDENCE**\nhigh",
        },
      });
    }

    if (!isSafeProjectPath(selectedFile)) {
      return res.status(400).json({
        success: false,
        error: "Unsafe selected file path.",
      });
    }

    const code = readProjectFile(selectedFile);

    if (code === null) {
      return res.status(404).json({
        success: false,
        error: "Selected file could not be read.",
      });
    }

    const flags = {
      handleBuild:
        /\bfunction\s+handleBuild\s*\(|\bhandleBuild\s*=/.test(
          code
        ),

      fetch: [
        ...code.matchAll(/fetch\s*\(/g),
      ].length,

      json: [
        ...code.matchAll(/response\.json\s*\(/g),
      ].length,

      tryCatch:
        /try\s*\{[\s\S]*catch\s*\(/.test(code),

      ai:
        /\baiResponse\b/.test(code),

      setAi:
        /\bsetAiResponse\s*\(/.test(code),

      chat:
        /\/api\/chat/.test(code),

      post:
        /method\s*:\s*["']POST["']/.test(code),

      stringify:
        /JSON\.stringify\s*\(/.test(code),
    };

    const good =
      flags.handleBuild &&
      flags.fetch > 0 &&
      flags.json > 0 &&
      flags.tryCatch &&
      flags.ai &&
      flags.setAi &&
      flags.chat &&
      flags.post &&
      flags.stringify;

    const content = good
      ? [
          "**DIAGNOSTICS**",
          "",
          "## Debugging Agent",
          "",
          "**READY**",
          "",
          "**PROBLEM**",
          "No frontend AI-response bug is proven in the selected file.",
          "",
          "**WHY**",
          "The request → response → state update → UI flow is present in the selected source.",
          "",
          "**SUGGESTED FIX**",
          "Verify runtime browser behavior and the backend response before changing code.",
          "",
          "**CONFIDENCE**",
          "high",
        ].join("\n")
      : [
          "**DIAGNOSTICS**",
          "",
          "## Debugging Agent",
          "",
          "**READY**",
          "",
          "**PROBLEM**",
          "A complete frontend request-to-response flow could not be verified.",
          "",
          "**WHY**",
          `Source evidence: ${JSON.stringify(flags)}.`,
          "",
          "**SUGGESTED FIX**",
          "Inspect the missing part of the request → response → state update → UI flow.",
          "",
          "**CONFIDENCE**",
          "medium",
        ].join("\n");

    res.json({
      success: true,

      result: {
        title: "Diagnostics",
        content,
      },
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

/* ============================================================
   CONTROLLED CHANGES
   ============================================================ */

function extractRequestedButtonText(prompt) {
  for (const p of [
    /button\s+text\s+(?:say|to)\s+["'“”]?([^"'“”]+)["'“”]?/i,

    /change\s+(?:the\s+)?button\s+(?:text\s+)?to\s+["'“”]?([^"'“”]+)["'“”]?/i,

    /make\s+(?:the\s+)?button\s+(?:text\s+)?(?:say|read)\s+["'“”]?([^"'“”]+)["'“”]?/i,
  ]) {
    const m = String(prompt || "").match(p);

    if (m?.[1]) {
      return m[1].trim();
    }
  }

  return null;
}

function validateControlledChanges(parsed, allowed) {
  if (!parsed || !Array.isArray(parsed.changes)) {
    return [];
  }

  return parsed.changes
    .filter(
      (c) =>
        c &&
        typeof c.path === "string" &&
        typeof c.newContent === "string"
    )
    .map((c) => {
      const match = allowed.find(
        (a) =>
          normalizePath(a).toLowerCase() ===
          normalizePath(c.path).toLowerCase()
      );

      return match
        ? {
            path: match,

            description:
              typeof c.description === "string"
                ? c.description
                : "Controlled source change.",

            oldContent:
              typeof c.oldContent === "string"
                ? c.oldContent
                : "",

            newContent: c.newContent,
          }
        : null;
    })
    .filter(Boolean);
}

app.post("/api/agent/changes", async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "");
    const mode = String(req.body?.mode || "vibe");

    const allowed = (
      Array.isArray(req.body?.contextFiles)
        ? req.body.contextFiles
        : []
    ).filter(isSafeProjectPath);

    if (!allowed.length) {
      return res.json({
        success: false,
        error:
          "No safe context file was selected. Select a file before proposing changes.",
      });
    }

    const contents = Object.fromEntries(
      allowed.map((f) => [
        f,
        readProjectFile(f) || "",
      ])
    );

    const raw = await callOllama(
      `You are the Controlled Changes Agent inside VibeCoder EDU.

USER REQUEST:
${prompt}

MODE:
${mode}

ONLY THESE FILES MAY CHANGE:
${allowed.join("\n")}

SOURCE:
${JSON.stringify(contents, null, 2)}

Return ONLY JSON:
{"changes":[{"path":"exact existing path","description":"what changed","oldContent":"complete original file","newContent":"complete updated file"}]}

Preserve functionality.`,
      "You are a strict and safe code-change assistant."
    );

    const valid = validateControlledChanges(
      extractJson(raw),
      allowed
    );

    if (!valid.length) {
      return res.json({
        success: false,
        error:
          "The AI could not produce a safe, valid change. No files were changed.",
      });
    }

    res.json({
      success: true,
      changes: valid,
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

app.post("/api/agent/apply", (req, res) => {
  try {
    const changes = Array.isArray(req.body?.changes)
      ? req.body.changes
      : [];

    if (!changes.length) {
      return res.status(400).json({
        success: false,
        error: "No approved changes supplied.",
      });
    }

    const applied = [];

    for (const c of changes) {
      if (
        !c ||
        typeof c.path !== "string" ||
        typeof c.newContent !== "string" ||
        !isSafeProjectPath(c.path)
      ) {
        continue;
      }

      fs.writeFileSync(
        getFullProjectPath(c.path),
        c.newContent,
        "utf8"
      );

      applied.push(normalizePath(c.path));
    }

    if (!applied.length) {
      return res.status(400).json({
        success: false,
        error: "No safe changes were applied.",
      });
    }

    res.json({
      success: true,
      applied,
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

/* ============================================================
   MAIN CHAT
   ============================================================ */

app.post("/api/chat", async (req, res) => {
  const prompt = String(req.body?.prompt || "");
  const mode = String(req.body?.mode || "vibe");

  const selectedFile =
    req.body?.selectedFile || null;

  const selectedFileContent =
    req.body?.selectedFileContent || null;

  const contextFiles = Array.isArray(
    req.body?.contextFiles
  )
    ? req.body.contextFiles
    : [];

  try {
    /* --------------------------------------------------------
       VIBE MODE — UI ANALYSIS
       -------------------------------------------------------- */

    if (
      mode.toLowerCase() === "vibe" &&
      isUiStylingRequest(prompt)
    ) {
      return res.json({
        success: true,

        response: buildUiStylingAnalysis(
          prompt,
          contextFiles,
          selectedFile,
          selectedFileContent
        ),
      });
    }

    /* --------------------------------------------------------
       VIBE MODE — FILE ANALYSIS
       -------------------------------------------------------- */

    if (
      mode.toLowerCase() === "vibe" &&
      selectedFile &&
      isFileFunctionRequest(prompt)
    ) {
      const source =
        selectedFileContent ||
        (isSafeProjectPath(selectedFile)
          ? readProjectFile(selectedFile)
          : null);

      if (source) {
        return res.json({
          success: true,

          response: buildFileFunctionSummary(
            source,
            selectedFile
          ),
        });
      }
    }

    const lower = prompt.toLowerCase();

    /* --------------------------------------------------------
       SELECTED FILE
       -------------------------------------------------------- */

    if (
      selectedFile &&
      (lower.includes("selected file") ||
        lower.includes("selected file name") ||
        lower.includes("file selected"))
    ) {
      return res.json({
        success: true,

        response: `The selected file is \`${normalizePath(
          selectedFile
        )}\`.`,
      });
    }

    /* --------------------------------------------------------
       PROJECT CONTEXT
       -------------------------------------------------------- */

    if (
      lower.includes("project context") &&
      (lower.includes("file path") ||
        lower.includes("file paths") ||
        lower.includes("context files"))
    ) {
      const paths = contextFiles.length
        ? contextFiles
        : selectedFile
        ? [selectedFile]
        : [];

      return res.json({
        success: true,

        response: paths.length
          ? `Project context files:\n\n${paths
              .map(
                (f) =>
                  `- \`${normalizePath(f)}\``
              )
              .join("\n")}`
          : "No project context files are currently selected.",
      });
    }

    /* --------------------------------------------------------
       EDUCATION MODE
       -------------------------------------------------------- */

    if (mode.toLowerCase() === "education") {
      const source =
        selectedFileContent ||
        (selectedFile &&
        isSafeProjectPath(selectedFile)
          ? readProjectFile(selectedFile)
          : null);

      if (source) {
        return res.json({
          success: true,

          response: buildEducationLesson(
            source,
            selectedFile || "Selected file",
            prompt
          ),
        });
      }
    }

    /* --------------------------------------------------------
       NORMAL AI CHAT
       -------------------------------------------------------- */

    const safe = contextFiles
      .filter(isSafeProjectPath)
      .map((file) => ({
        path: file,
        content:
          readProjectFile(file)?.slice(0, 12000) ||
          "",
      }));

    const system = `You are VibeCoder EDU, a local AI coding assistant.

Always prioritize the user's exact request.

Use project files only as relevant supporting context.

Never invent files, functions, APIs, or behavior.

Never claim to have changed files unless the system actually changed them.

Keep answers beginner-friendly and practical.`;

    const user = `USER REQUEST:
${prompt}

SELECTED FILE:
${selectedFile || "None"}

SELECTED FILE CONTENT:
${selectedFileContent || "None"}

PROJECT CONTEXT:
${JSON.stringify(safe, null, 2)}

Answer the USER REQUEST directly.`;

    const response = await callOllama(
      user,
      system
    );

    res.json({
      success: true,
      response,
    });
  } catch (e) {
    console.error("CHAT ERROR:", e);

    res.status(500).json({
      success: false,
      error:
        "Could not connect to the local AI service.",
      details: e.message,
    });
  }
});

/* ============================================================
   START SERVER
   ============================================================ */

app.listen(PORT, () =>
  console.log(
    `VibeCoder backend running at http://localhost:${PORT}`
  )
);