require("dotenv").config({ path: __dirname + "/.env" });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

console.log(
  "Gemini API key loaded:",
  Boolean(GEMINI_API_KEY)
);

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3001;
const OLLAMA_URL =
  "http://localhost:11434/api/generate";

const OLLAMA_MODEL =
  "qwen2.5-coder:3b-instruct";

const GEMINI_MODEL =
  "gemini-3.7-flash";

const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const PROJECT_ROOT =
  path.resolve(__dirname, "..");

const IGNORED_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".vite",
  "VibeCoder-EDU_BACKUPS",
  "backups",
  "backup",
]);

app.use(cors());

app.use(
  express.json({
    limit: "2mb",
  })
);

/* =========================================================
   PATH HELPERS
========================================================= */

function normalizePath(value = "") {
  return String(value)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .trim();
}

function canonicalPath(value = "") {
  return normalizePath(value).toLowerCase();
}

function getFullProjectPath(relativePath = "") {
  return path.resolve(
    PROJECT_ROOT,
    normalizePath(relativePath)
  );
}

function isSafeProjectPath(relativePath = "") {
  const normalized =
    normalizePath(relativePath);

  if (!normalized) {
    return false;
  }

  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return false;
  }

  const fullPath =
    getFullProjectPath(normalized);

  return (
    fullPath === PROJECT_ROOT ||
    fullPath.startsWith(
      PROJECT_ROOT + path.sep
    )
  );
}

function getProjectRelativePath(fullPath) {
  return normalizePath(
    path.relative(
      PROJECT_ROOT,
      fullPath
    )
  );
}

/* =========================================================
   PROJECT TREE
========================================================= */

function buildProjectTree(
  currentPath,
  relativeBase = ""
) {
  let entries = [];

  try {
    entries = fs.readdirSync(
      currentPath,
      {
        withFileTypes: true,
      }
    );
  } catch {
    return [];
  }

  return entries
    .filter(
      (entry) =>
        !IGNORED_NAMES.has(
          entry.name
        )
    )
    .sort((a, b) => {
      if (
        a.isDirectory() !==
        b.isDirectory()
      ) {
        return a.isDirectory()
          ? -1
          : 1;
      }

      return a.name.localeCompare(
        b.name
      );
    })
    .map((entry) => {
      const absolutePath =
        path.join(
          currentPath,
          entry.name
        );

      const relativePath =
        normalizePath(
          path.join(
            relativeBase,
            entry.name
          )
        );

      if (entry.isDirectory()) {
        return {
          name: entry.name,
          path: relativePath,
          type: "folder",
          children:
            buildProjectTree(
              absolutePath,
              relativePath
            ),
        };
      }

      return {
        name: entry.name,
        path: relativePath,
        type: "file",
      };
    });
}

/* =========================================================
   PROJECT FILE READING
========================================================= */

function readProjectFile(relativePath) {
  if (
    !isSafeProjectPath(
      relativePath
    )
  ) {
    throw new Error(
      "Unsafe project path."
    );
  }

  const fullPath =
    getFullProjectPath(
      relativePath
    );

  if (!fs.existsSync(fullPath)) {
    throw new Error(
      "File does not exist."
    );
  }

  const stat =
    fs.statSync(fullPath);

  if (!stat.isFile()) {
    throw new Error(
      "Requested path is not a file."
    );
  }

  if (stat.size > 100 * 1024) {
    throw new Error(
      "File is too large to load."
    );
  }

  return fs.readFileSync(
    fullPath,
    "utf8"
  );
}

/* =========================================================
   SMALL ASYNC HELPER
========================================================= */

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
}

/* =========================================================
   GEMINI
========================================================= */

/*
  Gemini is our primary AI provider.

  Important improvements:
  - Retries temporary provider errors.
  - JSON response mode is optional.
  - Normal chat/debug requests are NOT forced into JSON.
  - If Gemini remains unavailable, Ollama can be used as
    a local fallback.
*/

async function callGemini(
  prompt,
  systemPrompt = "",
  options = {}
) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      "Gemini API key is not configured."
    );
  }

  const wantsJson =
    Boolean(options.json);

  const maxAttempts = 3;

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    try {
      const generationConfig = {
        temperature:
          options.temperature ?? 0.2,
      };

      if (wantsJson) {
        generationConfig.responseMimeType =
          "application/json";
      }

      const body = {
        systemInstruction: {
          parts: [
            {
              text:
                systemPrompt ||
                "You are VibeCoder EDU, a helpful coding assistant.",
            },
          ],
        },

        contents: [
          {
            role: "user",
            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],

        generationConfig,
      };

      const response =
        await fetch(
          GEMINI_URL,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",

              "x-goog-api-key":
                GEMINI_API_KEY,
            },

            body: JSON.stringify(body),
          }
        );

      if (response.ok) {
        const data =
          await response.json();

        const text =
          data.candidates?.[0]
            ?.content?.parts?.[0]
            ?.text;

        if (text) {
          return text;
        }

        throw new Error(
          "Gemini returned no response."
        );
      }

      const errorText =
        await response.text();

      console.error(
        `Gemini API error ${response.status}:`,
        errorText
      );

      const retryableStatuses =
        new Set([
          429,
          502,
          503,
          504,
        ]);

      if (
        retryableStatuses.has(
          response.status
        )
      ) {
        lastError =
          new Error(
            `Gemini temporary error ${response.status}: ${errorText}`
          );

        if (
          attempt < maxAttempts
        ) {
          const delay =
            1000 *
            Math.pow(
              2,
              attempt - 1
            );

          console.log(
            `Gemini temporary error (${response.status}). Retrying in ${delay}ms...`
          );

          await sleep(delay);

          continue;
        }

        break;
      }

      throw new Error(
        `Gemini API error: ${response.status} ${errorText}`
      );
    } catch (error) {
      lastError = error;

      if (
        attempt < maxAttempts
      ) {
        const delay =
          1000 *
          Math.pow(
            2,
            attempt - 1
          );

        console.log(
          `Gemini request failed. Retrying in ${delay}ms...`
        );

        await sleep(delay);

        continue;
      }
    }
  }

  throw (
    lastError ||
    new Error(
      "Gemini request failed."
    )
  );
}
/* =========================================================
   OLLAMA
========================================================= */

async function callOllama(
  prompt,
  systemPrompt = "",
  options = {}
) {
  const response =
    await fetch(
      OLLAMA_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          model:
            OLLAMA_MODEL,

          prompt,

          system:
            systemPrompt,

          stream: false,

          format:
            options.json
              ? "json"
              : undefined,

          options: {
            temperature:
              options.temperature ??
              0.2,

            num_predict:
              options.numPredict ??
              600,
          },

          keep_alive: "10m",
        }),
      }
    );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `Ollama request failed: ${errorText}`
    );
  }

  const data =
    await response.json();

  return data.response || "";
}
/* =========================================================
   AI WITH LOCAL FALLBACK
========================================================= */
async function callAI(
  prompt,
  systemPrompt = "",
  options = {}
) {
  try {
    return await callGemini(
      prompt,
      systemPrompt,
      options
    );
  } catch (geminiError) {
    console.error(
      "Gemini unavailable:",
      geminiError.message
    );

    /*
      Only use Ollama after Gemini has exhausted
      its retry attempts.

      This keeps the application usable even when
      Gemini temporarily returns 503/429/etc.
    */
    try {
      console.log(
        "Falling back to local Ollama..."
      );

      return await callOllama(
        prompt,
        systemPrompt,
        {
          temperature:
            options.temperature ??
            0.2,

          numPredict:
  options.json
    ? 1200
    : 600,

json:
  options.json ?? false,
        }
      );
    } catch (ollamaError) {
      console.error(
        "Ollama fallback failed:",
        ollamaError.message
      );

      throw new Error(
        `AI service unavailable. Gemini: ${geminiError.message} Ollama: ${ollamaError.message}`
      );
    }
  }
}

/* =========================================================
   JSON EXTRACTION
========================================================= */

function extractJson(text = "") {
  const cleaned =
    String(text)
      .replace(
        /```json/gi,
        ""
      )
      .replace(
        /```/g,
        ""
      )
      .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const objectStart =
    cleaned.indexOf("{");

  const objectEnd =
    cleaned.lastIndexOf("}");

  if (
    objectStart !== -1 &&
    objectEnd > objectStart
  ) {
    try {
      return JSON.parse(
        cleaned.slice(
          objectStart,
          objectEnd + 1
        )
      );
    } catch {}
  }

  const arrayStart =
    cleaned.indexOf("[");

  const arrayEnd =
    cleaned.lastIndexOf("]");

  if (
    arrayStart !== -1 &&
    arrayEnd > arrayStart
  ) {
    try {
      return JSON.parse(
        cleaned.slice(
          arrayStart,
          arrayEnd + 1
        )
      );
    } catch {}
  }

  return null;
}

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      status: "ok",
      message:
        "VibeCoder backend is running",
    });
  }
);

/* =========================================================
   PROJECT API
========================================================= */

app.get(
  "/api/project",
  async (req, res) => {
    try {
      const response =
        await fetch(
          "https://api.github.com/repos/areejsaqib/VibeCoder-EDU/git/trees/master?recursive=1"
        );

      if (!response.ok) {
        throw new Error(
          "Unable to load project from GitHub."
        );
      }

      const data =
        await response.json();

      const files =
        data.tree
          .filter(
            (item) =>
              item.type === "blob"
          )
          .map((item) => ({
            name:
  item.path
    .split("/")
    .pop(),

            path: item.path,

            type: "file",
          }));

      res.json({
        files,

        structure:
          files,
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        message:
          error.message ||
          "Unable to load project.",
      });
    }
  }
);

app.get(
  "/api/project/file",
  (req, res) => {
    try {
      const filePath =
        String(
          req.query.path || ""
        );

      const content =
        readProjectFile(
          filePath
        );

      res.json({
        path:
          normalizePath(
            filePath
          ),

        content,
      });
    } catch (error) {
      console.error(error);

      res.status(400).json({
        message:
          error.message ||
          "Unable to read project file.",
      });
    }
  }
);

/* =========================================================
   SMART CONTEXT
========================================================= */

function isRequestAboutStyling(
  prompt = ""
) {
  return /\b(css|style|styling|design|background|color|colour|font|layout|spacing|padding|margin|button|ui|interface|dark mode|theme|responsive)\b/i.test(
    prompt
  );
}

function isRequestAboutReact(
  prompt = ""
) {
  return /\breact|component|jsx|tsx|useState|useEffect|props|hook\b/i.test(
    prompt
  );
}

function isRequestAboutBackend(
  prompt = ""
) {
  return /\bbackend|server|express|api|endpoint|route|ollama|fetch|cors|node\b/i.test(
    prompt
  );
}

function isRequestAboutLogic(
  prompt = ""
) {
  return /\bfunction|logic|state|variable|array|object|condition|loop|event|handler|calculation\b/i.test(
    prompt
  );
}

function isRequestAboutConfig(
  prompt = ""
) {
  return /\bpackage\.json|vite|typescript|tsconfig|config|dependency|npm|build\b/i.test(
    prompt
  );
}

function getSmartContextIntent(
  prompt = ""
) {
  return {
    styling:
      isRequestAboutStyling(
        prompt
      ),

    react:
      isRequestAboutReact(
        prompt
      ),

    backend:
      isRequestAboutBackend(
        prompt
      ),

    logic:
      isRequestAboutLogic(
        prompt
      ),

    config:
      isRequestAboutConfig(
        prompt
      ),
  };
}

function scoreFile(
  filePath,
  prompt
) {
  const lowerPath =
    filePath.toLowerCase();

  const intent =
    getSmartContextIntent(
      prompt
    );

  let score = 0;

  const reasons = [];

  if (
    intent.styling &&
    /\.(css|scss|sass|less)$/i.test(
      lowerPath
    )
  ) {
    score += 10;

    reasons.push(
      "Styling-related file"
    );
  }

  if (
    intent.react &&
    /\.(tsx|jsx)$/i.test(
      lowerPath
    )
  ) {
    score += 9;

    reasons.push(
      "React component file"
    );
  }

  if (
    intent.backend &&
    /server|api|backend|index\.js|\.server\./i.test(
      lowerPath
    )
  ) {
    score += 9;

    reasons.push(
      "Backend-related file"
    );
  }

  if (
    intent.logic &&
    /\.(ts|tsx|js|jsx)$/i.test(
      lowerPath
    )
  ) {
    score += 5;

    reasons.push(
      "Logic/code file"
    );
  }

  if (
    intent.config &&
    /(package\.json|vite\.config|tsconfig)/i.test(
      lowerPath
    )
  ) {
    score += 8;

    reasons.push(
      "Configuration file"
    );
  }

  if (
    /src[\\/]/i.test(
      filePath
    )
  ) {
    score += 2;
  }

  if (
    /README|\.md$/i.test(
      lowerPath
    )
  ) {
    score -= 2;
  }

  return {
    score,

    reason:
      reasons.join(", ") ||
      "Relevant project source file",
  };
}

/*
  Guarantees every project file appears
  only once.
*/

function collectProjectFiles(
  currentPath,
  relativeBase = "",
  result = [],
  seen = new Set()
) {
  let entries = [];

  try {
    entries =
      fs.readdirSync(
        currentPath,
        {
          withFileTypes:
            true,
        }
      );
  } catch {
    return result;
  }

  for (
    const entry of entries
  ) {
    if (
      IGNORED_NAMES.has(
        entry.name
      )
    ) {
      continue;
    }

    const absolutePath =
      path.join(
        currentPath,
        entry.name
      );

    const relativePath =
      normalizePath(
        path.join(
          relativeBase,
          entry.name
        )
      );

    if (
      entry.isDirectory()
    ) {
      collectProjectFiles(
        absolutePath,
        relativePath,
        result,
        seen
      );

      continue;
    }

    const key =
      canonicalPath(
        relativePath
      );

    if (
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);

    result.push(
      relativePath
    );
  }

  return result;
}

/* =========================================================
   SMART CONTEXT ENDPOINT
========================================================= */

app.post(
  "/api/project/suggest-context",
  async (req, res) => {
    try {
      const prompt =
        String(
          req.body?.prompt ||
            ""
        ).trim();

      if (!prompt) {
        return res.json({
          suggestions: [],
        });
      }

      const response =
        await fetch(
          "https://api.github.com/repos/areejsaqib/VibeCoder-EDU/git/trees/master?recursive=1"
        );

      if (!response.ok) {
        throw new Error(
          "Unable to load project files from GitHub."
        );
      }

      const data =
        await response.json();

      const files =
        data.tree
          .filter(
            (item) =>
              item.type ===
              "blob"
          )
          .map(
            (item) =>
              item.path
          )
          .filter(
            (filePath) =>
              !filePath
                .split("/")
                .some((part) =>
                  IGNORED_NAMES.has(
                    part
                  )
                )
          );

      const scoredFiles =
        files
          .map((filePath) => {
            const normalizedPath =
              normalizePath(
                filePath
              );

            const result =
              scoreFile(
                normalizedPath,
                prompt
              );

            return {
              path:
                normalizedPath,

              name:
                path.basename(
                  normalizedPath
                ),

              score:
                result.score,

              reason:
                result.reason,
            };
          })
          .filter(
            (file) =>
              file.score > 0
          )
          .sort(
            (a, b) =>
              b.score -
              a.score
          );

      const uniqueSuggestions =
        new Map();

      for (
        const file of scoredFiles
      ) {
        const key =
          canonicalPath(
            file.path
          );

        if (
          !uniqueSuggestions.has(
            key
          )
        ) {
          uniqueSuggestions.set(
            key,
            file
          );
        }
      }

      const suggestions =
        Array.from(
          uniqueSuggestions.values()
        ).slice(0, 3);

      console.log(
        "SMART CONTEXT REQUEST:",
        prompt
      );

      console.log(
        "SMART CONTEXT RESULTS:",
        suggestions.map(
          (file) =>
            file.path
        )
      );

      res.json({
        suggestions,
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        message:
          "Smart Context failed.",
      });
    }
  }
);

/* =========================================================
   EDUCATION MODE
========================================================= */

function educationFacts(
  prompt = ""
) {
  const facts = [];

  if (
    /\bfunction\b/i.test(
      prompt
    )
  ) {
    facts.push(
      "A function is a reusable block of code designed to perform a specific task."
    );
  }

  if (
    /\bvariable\b/i.test(
      prompt
    )
  ) {
    facts.push(
      "A variable gives a value a name so the program can use that value later."
    );
  }

  if (
    /\barray\b/i.test(
      prompt
    )
  ) {
    facts.push(
      "An array stores multiple values in an ordered collection."
    );
  }

  if (
    /\bobject\b/i.test(
      prompt
    )
  ) {
    facts.push(
      "An object groups related data using properties and values."
    );
  }

  if (
    /\bif\b|\bcondition\b/i.test(
      prompt
    )
  ) {
    facts.push(
      "A conditional lets a program choose what to do based on whether a condition is true or false."
    );
  }

  return facts;
}

function findState(
  content = ""
) {
  const matches =
    content.match(
      /(?:const|let)\s+\w+\s*=\s*(?:useState\([^)]*\)|[^;]+)/g
    ) || [];

  return matches.slice(
    0,
    5
  );
}

function extractModeRelationships(
  content = ""
) {
  const relationships = [];

  if (
    /\bmode\b/i.test(
      content
    ) &&
    /\bsetMode\b/i.test(
      content
    )
  ) {
    relationships.push(
      "The `mode` state stores the current working mode, while `setMode` changes it."
    );
  }

  if (
    /\bprompt\b/i.test(
      content
    ) &&
    /\bsetPrompt\b/i.test(
      content
    )
  ) {
    relationships.push(
      "The `prompt` state stores the user's request and `setPrompt` updates it."
    );
  }

  if (
    /\bselectedFile\b/i.test(
      content
    )
  ) {
    relationships.push(
      "The selected file state connects the Project Explorer to the file-reading and AI-context features."
    );
  }

  return relationships;
}

function findRelevantCode(
  content = "",
  prompt = ""
) {
  const lines =
    content.split("\n");

  const keywords =
    prompt
      .toLowerCase()
      .split(/\s+/)
      .filter(
        (word) =>
          word.length > 3
      );

  const relevant = [];

  lines.forEach(
    (line, index) => {
      const lower =
        line.toLowerCase();

      if (
        keywords.some(
          (keyword) =>
            lower.includes(
              keyword
            )
        )
      ) {
        relevant.push(
          `Line ${
            index + 1
          }: ${line.trim()}`
        );
      }
    }
  );

  return relevant.slice(
    0,
    8
  );
}

function educationGoal(
  prompt = ""
) {
  if (
    /\bfunction\b/i.test(
      prompt
    )
  ) {
    return "Understand how functions are defined, what inputs they receive, and what they return.";
  }

  if (
    /\bstate\b|\buseState\b/i.test(
      prompt
    )
  ) {
    return "Understand how state stores information and how state updates change a React interface.";
  }

  if (
    /\breact\b|\bcomponent\b/i.test(
      prompt
    )
  ) {
    return "Understand how React components combine data, logic, and UI.";
  }

  return "Understand the requested concept by connecting it to the source code and a simple example.";
}

function buildRelationshipLesson(
  prompt,
  content
) {
  const relationships =
    extractModeRelationships(
      content
    );

  const state =
    findState(content);

  const relevant =
    findRelevantCode(
      content,
      prompt
    );

  return [
    "### Teacher Explanation",
    "",

    `**Learning goal:** ${educationGoal(
      prompt
    )}`,

    "",

    relationships.length
      ? `**How the pieces connect:**\n${relationships
          .map(
            (item) =>
              `- ${item}`
          )
          .join("\n")}`
      : "**How the pieces connect:**\n- The selected source does not expose an obvious state relationship for this request yet.",

    "",

    state.length
      ? `**Relevant state in this file:**\n${state
          .map(
            (item) =>
              `- \`${item}\``
          )
          .join("\n")}`
      : "**Relevant state:**\n- No obvious React state declaration was found.",

    "",

    relevant.length
      ? `**Relevant source lines:**\n${relevant
          .map(
            (item) =>
              `- \`${item}\``
          )
          .join("\n")}`
      : "**Relevant source lines:**\n- No exact matching source lines were found.",

    "",

    "**Think like a developer:**",

    "1. Identify the data being stored.",
    "2. Find the function that changes that data.",
    "3. Find where the data is used to influence the interface.",
  ].join("\n");
}

function buildEducationLesson(
  prompt,
  content = ""
) {
  const facts =
    educationFacts(prompt);

  if (
    content &&
    (/\bmode\b|\bstate\b|\buseState\b/i.test(
      prompt
    ))
  ) {
    return buildRelationshipLesson(
      prompt,
      content
    );
  }

  const relevant =
    content
      ? findRelevantCode(
          content,
          prompt
        )
      : [];

  return [
    "### Teacher Explanation",
    "",

    `**Learning goal:** ${educationGoal(
      prompt
    )}`,

    "",

    facts.length
      ? `**Key idea:**\n${facts
          .map(
            (fact) =>
              `- ${fact}`
          )
          .join("\n")}`
      : "**Key idea:**\n- Start by identifying the main concept in the question, then connect it to a small example.",

    "",

    relevant.length
      ? `**From your code:**\n${relevant
          .map(
            (line) =>
              `- ${line}`
          )
          .join("\n")}`
      : "**From your code:**\n- No source code was provided for a source-specific explanation.",

    "",

    "**Simple example:**",

    "```js",

    "function addNumbers(a, b) {",
    "  return a + b;",
    "}",

    "",

    "const result = addNumbers(2, 3);",

    "```",

    "",

    "Here the function receives two inputs, performs the calculation, and returns the result.",

    "",

    "**Remember:**",

    "Understanding the purpose of each piece is more important than memorizing the syntax.",
  ].join("\n");
}

/* =========================================================
   UI ANALYSIS
========================================================= */

function isUiStylingRequest(
  prompt = ""
) {
  return /\b(background|background color|dark mode|light mode|theme|button|font|color|colour|spacing|padding|margin|layout|border|shadow|style|styling|appearance|ui|interface)\b/i.test(
    prompt
  );
}

function buildUiStylingAnalysis(
  prompt
) {
  return [
    "### UI Analysis",
    "",

    `**Request:** ${prompt}`,

    "",

    "**Recommended approach:**",

    "- Identify the component that renders the affected UI.",
    "- Identify the stylesheet controlling its appearance.",
    "- Make the smallest targeted styling change.",
    "- Test the interface after the change.",

    "",

    "**Safety:**",

    "No files were changed by this analysis.",
  ].join("\n");
}

/* =========================================================
   FILE FUNCTION ANALYSIS
========================================================= */

function isFileFunctionRequest(
  prompt = ""
) {
  return /\b(functions?|methods?|handlers?|what does this file do|explain this file|analyze this file)\b/i.test(
    prompt
  );
}

function buildFileFunctionSummary(
  filePath,
  content
) {
  const functions = [];

  const patterns = [
    /function\s+([A-Za-z_$][\w$]*)\s*\(/g,

    /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,

    /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\w+\s*=>/g,
  ];

  for (
    const pattern of patterns
  ) {
    let match;

    while (
      (match =
        pattern.exec(content)) !==
      null
    ) {
      if (
        !functions.includes(
          match[1]
        )
      ) {
        functions.push(
          match[1]
        );
      }
    }
  }

  return [
    "### File Analysis",
    "",

    `**File:** \`${filePath}\``,

    "",

    functions.length
      ? `**Functions detected:**\n${functions
          .map(
            (name) =>
              `- \`${name}()\``
          )
          .join("\n")}`
      : "**Functions detected:**\n- No standard function declarations were detected.",

    "",

    "**Purpose:**",

    "This file contains application logic used by the VibeCoder EDU interface.",

    "",

    "**Safety:**",

    "No files were changed.",
  ].join("\n");
}

/* =========================================================
   DARK / BACKGROUND REQUEST DETECTION
========================================================= */

function isDarkModeRequest(
  prompt = ""
) {
  return /\bdark mode\b|\bdark theme\b|\bdark background\b|\bdark blue\b/i.test(
    prompt
  );
}

function isDarkBlueRequest(
  prompt = ""
) {
  return /\bdark blue\b/i.test(
    prompt
  );
}

function isBackgroundColorRequest(
  prompt = ""
) {
  return /\b(change|make|set|update)\b.*\bbackground\b/i.test(
    prompt
  );
}

/* =========================================================
   DETERMINISTIC AGENT PLAN
========================================================= */

function buildDeterministicAgentPlan(
  prompt
) {
  const files =
    collectProjectFiles(
      PROJECT_ROOT
    );

  const appFile =
    files.find(
      (file) =>
        canonicalPath(file) ===
        "src/app.tsx"
    ) ||
    "src/App.tsx";

  const cssFile =
    files.find(
      (file) =>
        canonicalPath(file) ===
        "src/app.css"
    ) ||
    "src/App.css";

  return {
    summary:
      `Create a controlled dark-mode implementation for the request: "${prompt}"`,

    steps: [
      {
        step: 1,

        title:
          "Inspect the application UI",

        description:
          `Review ${appFile} to identify where a theme or dark-mode control should live.`,
      },

      {
        step: 2,

        title:
          "Add theme state or control",

        description:
          `Update ${appFile} with the smallest appropriate state/control needed for dark mode.`,
      },

      {
        step: 3,

        title:
          "Update visual styles",

        description:
          `Update ${cssFile} with dark-mode styling while preserving the existing design.`,
      },

      {
        step: 4,

        title:
          "Connect and verify",

        description:
          "Connect the control to the stylesheet and verify that the interface switches correctly.",
      },
    ],
  };
}

/* =========================================================
   AGENT PLAN
========================================================= */

app.post(
  "/api/agent/plan",
  async (req, res) => {
    try {
      const prompt =
        String(
          req.body?.prompt ||
            ""
        ).trim();

      const mode =
        String(
          req.body?.mode ||
            "vibe"
        );

      const contextFiles =
        Array.isArray(
          req.body?.contextFiles
        )
          ? req.body
              .contextFiles
          : [];

      if (!prompt) {
        return res.status(400).json({
          message:
            "Prompt is required.",
        });
      }

      /*
        Dark-mode planning is deterministic so that
        a temporary AI outage cannot prevent this
        predictable planning feature from working.
      */

      if (
        isDarkModeRequest(
          prompt
        )
      ) {
        return res.json({
          plan:
            buildDeterministicAgentPlan(
              prompt
            ),
        });
      }

      const safeFiles =
        contextFiles
          .filter(
            (file) =>
              typeof file ===
                "string" &&
              isSafeProjectPath(
                file
              )
          )
          .map(normalizePath)
          .filter(
            (file, index, array) =>
              array.findIndex(
                (item) =>
                  canonicalPath(
                    item
                  ) ===
                  canonicalPath(
                    file
                  )
              ) === index
          )
          .slice(0, 3);

      const context =
        safeFiles
          .map((file) => {
            try {
              return [
                `FILE: ${file}`,
                readProjectFile(
                  file
                ),
              ].join("\n");
            } catch {
              return "";
            }
          })
          .filter(Boolean)
          .join("\n\n");

      const systemPrompt = [
        "You are the VibeCoder EDU planning agent.",
        "Create a short, practical coding plan.",
        "Do not claim that files have already been changed.",
        "Use only files present in the supplied context.",
        "Return valid JSON only.",
        'Format: {"summary":"...","steps":[{"step":1,"title":"...","description":"..."}]}',
      ].join("\n");

      const aiResult =
        await callAI(
          [
            `USER REQUEST:\n${prompt}`,

            `MODE:\n${mode}`,

            `PROJECT CONTEXT:\n${
              context ||
              "No selected context."
            }`,
          ].join("\n\n"),

          systemPrompt,

          {
            json: true,
          }
        );

      const parsed =
        extractJson(
          aiResult
        );

      res.json({
        plan:
          parsed || {
            summary:
              "AI-generated plan",

            steps: [
              {
                step: 1,

                title:
                  "Analyze request",

                description:
                  aiResult ||
                  "Analyze the requested change.",
              },
            ],
          },
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        message:
          error.message ||
          "Agent planning failed.",
      });
    }
  }
);

/* =========================================================
   DEBUGGING AGENT
========================================================= */

app.post(
  "/api/agent/debug",
  async (req, res) => {
    try {
      const prompt =
        String(
          req.body?.prompt ||
            ""
        ).trim();

      const selectedFile =
        String(
          req.body
            ?.selectedFile || ""
        );

      const selectedFileContent =
        String(
          req.body
            ?.selectedFileContent ||
            ""
        );

      if (!selectedFile) {
        return res.status(400).json({
          message:
            "Select a file to debug.",
        });
      }

      let content =
        selectedFileContent;

      if (!content) {
        content =
          readProjectFile(
            selectedFile
          );
      }

      content =
        content.slice(
          0,
          30000
        );

      const debugPrompt = `
You are the Debugging Agent inside VibeCoder EDU.

Analyze the selected project file and the user's debugging request.

USER REQUEST:
${prompt || "Find potential bugs or problems in this file."}

FILE:
${selectedFile}

SOURCE CODE:
${content}

Your job is to identify REAL, specific problems in the code.

Do NOT simply describe what the file contains.

Only report a problem if it is relevant to the user's debugging request.

If the requested area has no clear problem, say:
"No clear bug found."

Look for:
- incorrect logic
- broken conditions
- incorrect API usage
- missing error handling
- state-management problems
- UI behavior problems
- possible runtime errors
- incorrect file paths or endpoints
- problems caused by the current request

Return exactly this structure:

PROBLEM:
Describe the most important actual problem you found. If there is no clear bug, say "No clear bug found."

WHY:
Explain specifically why it is a problem and refer to the relevant code.

SUGGESTED FIX:
Give a concrete fix. Do not actually modify the file.

CONFIDENCE:
high, medium, or low

Keep the response concise and based only on the provided source code.
`;

      const aiResult =
        await callAI(
          debugPrompt,

          "",

          {
            json: false,
          }
        );

      const resultText =
        String(
          aiResult || ""
        ).trim();

      const cleanedResultText =
        resultText
          .replace(
            /```json/gi,
            ""
          )
          .replace(
            /```/g,
            ""
          )
          .trim();

      const problemMatch =
        cleanedResultText.match(
          /PROBLEM:\s*([\s\S]*?)(?=\nWHY:|$)/i
        );

      const whyMatch =
        cleanedResultText.match(
          /WHY:\s*([\s\S]*?)(?=\nSUGGESTED FIX:|$)/i
        );

      const fixMatch =
        cleanedResultText.match(
          /SUGGESTED FIX:\s*([\s\S]*?)(?=\nCONFIDENCE:|$)/i
        );

      const confidenceMatch =
        cleanedResultText.match(
          /CONFIDENCE:\s*(high|medium|low)/i
        );

      const result = {
        problem:
          problemMatch?.[1]?.trim() ||
          resultText ||
          "No clear bug found.",

        why:
          whyMatch?.[1]?.trim() ||
          "The AI could not provide a specific explanation.",

        fix:
          fixMatch?.[1]?.trim() ||
          "Review the identified code and test the affected workflow.",

        confidence:
          confidenceMatch?.[1]?.toLowerCase() ||
          "medium",
      };

      res.json({
        result,
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        message:
          error.message ||
          "Debugging failed.",
      });
    }
  }
);

/* =========================================================
   CONTROLLED CHANGE HELPERS
========================================================= */

function extractRequestedButtonText(
  prompt = ""
) {
  const match =
    prompt.match(
      /button(?:\s+text)?\s+(?:called|named|with text)\s+["']([^"']+)["']/i
    );

  return match
    ? match[1]
    : "";
}

function validateControlledChanges(
  parsed,
  allowedFiles
) {
  if (
    !parsed ||
    !Array.isArray(
      parsed.changes
    )
  ) {
    throw new Error(
      "AI did not return a valid changes array."
    );
  }

  const allowed =
    new Set(
      allowedFiles.map(
        canonicalPath
      )
    );

  const changes =
    parsed.changes.map(
      (change) => {
        const filePath =
          normalizePath(
            change?.path || ""
          );

        if (!filePath) {
          throw new Error(
            "A proposed change is missing its file path."
          );
        }

        if (
          !allowed.has(
            canonicalPath(
              filePath
            )
          )
        ) {
          throw new Error(
            `AI proposed a file outside the approved context: ${filePath}`
          );
        }

        if (
          typeof change?.description !==
          "string"
        ) {
          throw new Error(
            `Change description missing for ${filePath}.`
          );
        }

        if (
          typeof change?.oldContent !==
          "string"
        ) {
          throw new Error(
            `Original content missing for ${filePath}.`
          );
        }

        if (
          typeof change?.newContent !==
          "string"
        ) {
          throw new Error(
            `New content missing for ${filePath}.`
          );
        }

        return {
          path:
            filePath,

          description:
            change.description,

          oldContent:
            change.oldContent,

          newContent:
            change.newContent,
        };
      }
    );

  return changes;
}

/* =========================================================
   DETERMINISTIC DARK MODE CHANGE
========================================================= */

function buildDeterministicDarkModeChanges(
  allowedFiles,
  prompt = ""
) {
  const appPath =
    allowedFiles.find(
      (file) =>
        canonicalPath(file) ===
        "src/app.tsx"
    );

  const cssPath =
    allowedFiles.find(
      (file) =>
        canonicalPath(file) ===
        "src/app.css"
    );

  const changes = [];

  /*
    Preserve the existing Safe Mode implementation
    for explicit dark-blue requests.
  */

  if (
    cssPath &&
    isDarkBlueRequest(
      prompt
    )
  ) {
    const oldContent =
      readProjectFile(
        cssPath
      );

    let newContent =
      oldContent;

    const marker =
      "vibecoder-safe-dark-blue";

    if (
      !newContent.includes(
        marker
      )
    ) {
      newContent += `

/* VibeCoder EDU — Safe Mode dark blue */
.${marker} {
  background: #0f172a;
  color: #f8fafc;
}

.${marker} .panel,
.${marker} .builder-card {
  background: #1e293b;
  color: #f8fafc;
}
`;
    }

    changes.push({
      path:
        cssPath,

      description:
        "Add a scoped dark-blue background style without replacing the existing application styles.",

      oldContent,

      newContent,
    });

    if (appPath) {
      const appOldContent =
        readProjectFile(
          appPath
        );

      let appNewContent =
        appOldContent;

      appNewContent =
        appNewContent.replace(
          /mode === "safe"\s*\?\s*"vibecoder-safe-dark-mode"\s*:\s*""/,
          'mode === "safe"\n          ? "vibecoder-safe-dark-blue"\n          : ""'
        );

      if (
        appNewContent ===
          appOldContent &&
        !appNewContent.includes(
          marker
        )
      ) {
        appNewContent =
          appNewContent.replace(
            /className=\{`app\s*\$\{\s*([\s\S]*?)\s*\}\}/,
            (match, expression) => {
              return `className={\`app \${${expression}}\`}`;
            }
          );
      }

      changes.push({
        path:
          appPath,

        description:
          "Apply the dark-blue class only while Safe Mode is active.",

        oldContent:
          appOldContent,

        newContent:
          appNewContent,
      });
    }

    return changes;
  }

  return undefined;
}

/* =========================================================
   PROPOSE CONTROLLED CHANGES
========================================================= */

app.post(
  "/api/agent/changes",
  async (req, res) => {
    try {
      const prompt =
        String(
          req.body?.prompt ||
            ""
        ).trim();

      const contextFiles =
        Array.isArray(
          req.body?.contextFiles
        )
          ? req.body
              .contextFiles
          : [];

      if (!prompt) {
        return res.status(400).json({
          message:
            "Prompt is required.",
        });
      }

      const safeFiles =
        contextFiles
          .filter(
            (file) =>
              typeof file ===
                "string" &&
              isSafeProjectPath(
                file
              )
          )
          .map(normalizePath)
          .filter(
            (file, index, array) =>
              array.findIndex(
                (item) =>
                  canonicalPath(
                    item
                  ) ===
                  canonicalPath(
                    file
                  )
              ) === index
          )
          .slice(0, 3);

      if (
        safeFiles.length === 0
      ) {
        return res.status(400).json({
          message:
            "Select a file or add AI context before proposing changes.",
        });
      }

      /*
        Capture the trusted source BEFORE asking AI.

        This snapshot is what Apply Changes will later
        compare against.
      */

      const sourceSnapshots =
        new Map();

      for (
        const file of safeFiles
      ) {
        sourceSnapshots.set(
          canonicalPath(
            file
          ),
          readProjectFile(
            file
          )
        );
      }

      /*
        Known styling requests can still use the
        deterministic Safe Mode implementation.
      */

      if (
        isDarkModeRequest(
          prompt
        ) ||
        isBackgroundColorRequest(
          prompt
        )
      ) {
        const stylingFiles =
          safeFiles.filter(
            (file) =>
              /^(src\/app\.tsx|src\/app\.css)$/i.test(
                file
              )
          );

        if (
          stylingFiles.length >
          0
        ) {
          const deterministic =
            buildDeterministicDarkModeChanges(
              stylingFiles,
              prompt
            );

          if (
            Array.isArray(
              deterministic
            ) &&
            deterministic.length
          ) {
            return res.json({
              changes:
                deterministic,
            });
          }
        }
      }

      /*
        Build AI source from the exact same snapshots
        that Apply will later trust.
      */

      const fileContents =
        safeFiles
          .map((file) => {
            const content =
              sourceSnapshots.get(
                canonicalPath(
                  file
                )
              );

            if (
              typeof content !==
              "string"
            ) {
              return "";
            }

            if (
              content.length >
              50 * 1024
            ) {
              return [
                `FILE: ${file}`,
                "CONTENT OMITTED: file is too large for controlled editing.",
              ].join("\n");
            }

            return [
              `FILE: ${file}`,
              content,
            ].join("\n");
          })
          .filter(Boolean)
          .join("\n\n");

      const requestedButtonText =
        extractRequestedButtonText(
          prompt
        );

      const systemPrompt = [
        "You are the VibeCoder EDU Safe Mode controlled editing agent.",
        "",
        "Your job is to propose changes, NOT apply them.",
        "",
        "Safety rules:",
        "1. Only modify files included in the supplied context.",
        "2. Never invent a file path.",
        "3. Return the complete original file in oldContent.",
        "4. Return the complete proposed file in newContent.",
        "5. Do not omit unchanged code.",
        "6. Make the smallest practical change.",
        "7. Preserve existing functionality.",
        "8. Never claim that the files have already been changed.",
        "9. Return JSON only.",
        "",
        'Required format: {"changes":[{"path":"exact existing path","description":"what changed","oldContent":"complete original file","newContent":"complete updated file"}]}',

        requestedButtonText
          ? `If the request concerns a button, the requested button text is "${requestedButtonText}".`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      const aiResult =
        await callAI(
          [
            `USER REQUEST:\n${prompt}`,

            `APPROVED CONTEXT FILES:\n${safeFiles.join(
              "\n"
            )}`,

            `PROJECT SOURCE:\n${fileContents}`,
          ].join("\n\n"),

          systemPrompt,

          {
            json: true,
          }
        );

      const parsed =
        extractJson(
          aiResult
        );

      console.log(
        "AI CHANGES RESPONSE:",
        aiResult
      );
if (
  !parsed ||
  !Array.isArray(parsed.changes)
) {
  console.warn(
    "AI did not return a valid controlled-change proposal. No files were changed."
  );

  return res.json({
    changes: [],
    message:
      "No controlled changes were proposed. No files were changed.",
  });
}
      const changes =
        validateControlledChanges(
          parsed,
          safeFiles
        ).map(
          (change) => {
            const trustedOriginal =
              sourceSnapshots.get(
                canonicalPath(
                  change.path
                )
              );

            if (
              typeof trustedOriginal !==
              "string"
            ) {
              throw new Error(
                `Unable to verify original content for ${change.path}.`
              );
            }

            return {
              ...change,

              /*
                Never trust AI's oldContent.

                Replace it with the exact source
                snapshot captured by our server.
              */

              oldContent:
                trustedOriginal,
            };
          }
        );

      res.json({
        changes,
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        message:
          error.message ||
          "Controlled changes failed.",
      });
    }
  }
);

/* =========================================================
   APPLY APPROVED CHANGES
========================================================= */

app.post(
  "/api/agent/apply",
  (req, res) => {
    try {
      const changes =
        Array.isArray(
          req.body?.changes
        )
          ? req.body.changes
          : [];

      if (
        changes.length === 0
      ) {
        return res.status(400).json({
          message:
            "No changes were supplied.",
        });
      }

      const applied = [];

      for (
        const change of changes
      ) {
        const filePath =
          normalizePath(
            change?.path || ""
          );

        const newContent =
          change?.newContent;

        if (
          !isSafeProjectPath(
            filePath
          )
        ) {
          throw new Error(
            `Unsafe file path: ${filePath}`
          );
        }

        if (
          typeof newContent !==
          "string"
        ) {
          throw new Error(
            `Invalid new content for ${filePath}`
          );
        }

        const fullPath =
          getFullProjectPath(
            filePath
          );

        if (
          !fs.existsSync(
            fullPath
          )
        ) {
          throw new Error(
            `File does not exist: ${filePath}`
          );
        }

        const currentContent =
          fs.readFileSync(
            fullPath,
            "utf8"
          );

        /*
          If the file changed after the proposal,
          refuse to overwrite it.

          Normalize Windows line endings so CRLF/LF
          differences do not create false mismatches.
        */

        if (
          typeof change.oldContent ===
            "string" &&
          currentContent.replace(
            /\r\n/g,
            "\n"
          ) !==
            change.oldContent.replace(
              /\r\n/g,
              "\n"
            )
        ) {
          throw new Error(
            `File changed after proposal was created: ${filePath}. Generate a new proposal first.`
          );
        }

        fs.writeFileSync(
          fullPath,
          newContent,
          "utf8"
        );

        applied.push(
          filePath
        );
      }

      res.json({
        success: true,

        applied,
      });
    } catch (error) {
      console.error(error);

      res.status(400).json({
        message:
          error.message ||
          "Unable to apply changes.",
      });
    }
  }
);

/* =========================================================
   NORMAL CHAT
========================================================= */

app.post(
  "/api/chat",
  async (req, res) => {
    try {
      const prompt =
        String(
          req.body?.prompt ||
            ""
        ).trim();

      const mode =
        String(
          req.body?.mode ||
            "vibe"
        );

      const selectedFile =
        String(
          req.body
            ?.selectedFile || ""
        );

      const selectedFileContent =
        String(
          req.body
            ?.selectedFileContent ||
            ""
        );

      const contextFiles =
        Array.isArray(
          req.body?.contextFiles
        )
          ? req.body
              .contextFiles
          : [];

      if (!prompt) {
        return res.status(400).json({
          message:
            "Prompt is required.",
        });
      }

      /*
        Safe Mode intentionally does not use normal chat.
      */

      if (
        mode === "safe"
      ) {
        return res.json({
          response:
            "Safe Mode uses the controlled review workflow. Use Review with AI to generate proposed changes before anything is applied.",
        });
      }

      /*
        Keep the deterministic UI analysis behavior.
      */

      
      /*
        Keep deterministic file-function analysis.
      */

      if (
        mode === "vibe" &&
        selectedFile &&
        selectedFileContent &&
        isFileFunctionRequest(
          prompt
        )
      ) {
        return res.json({
          response:
            buildFileFunctionSummary(
              selectedFile,
              selectedFileContent
            ),
        });
      }

      let sourceContent =
        selectedFileContent;

      if (
        !sourceContent &&
        selectedFile
      ) {
        try {
          sourceContent =
            readProjectFile(
              selectedFile
            );
        } catch {}
      }

      const safeContextFiles =
        contextFiles
          .filter(
            (file) =>
              typeof file ===
                "string" &&
              isSafeProjectPath(
                file
              )
          )
          .map(normalizePath)
          .filter(
            (file, index, array) =>
              array.findIndex(
                (item) =>
                  canonicalPath(
                    item
                  ) ===
                  canonicalPath(
                    file
                  )
              ) === index
          )
          .slice(0, 3);

      const context =
        safeContextFiles
          .map((file) => {
            try {
              return [
                `FILE: ${file}`,
                readProjectFile(
                  file
                ),
              ].join("\n");
            } catch {
              return "";
            }
          })
          .filter(Boolean)
          .join("\n\n");

      /*
        Education Mode remains teacher-style and
        source-grounded.
      */

      if (
        mode ===
        "education"
      ) {
        return res.json({
          response:
            buildEducationLesson(
              prompt,
              sourceContent ||
                context
            ),
        });
      }

      const systemPrompt = [
        "You are VibeCoder EDU, a local AI coding assistant.",
        "Always prioritize the user's exact request.",
        "Never invent files, functions, APIs, or project details.",
        "Use only file paths that actually appear in the provided project context.",
        "Never claim to have changed files.",
        "Keep answers beginner-friendly and practical.",
        "When the user asks to build, add, create, modify, or implement something, respond directly to that request.",
        "Treat the USER REQUEST as the primary task.",
"When the user asks for a UI change, identify the existing React file that should be changed and provide the exact code needed for that change.",
"For small UI changes, provide only the minimal code snippet or exact insertion point needed. Do not rewrite the entire file.",
"Never change .tsx to .js or invent a different extension.",
"Do not summarize the project or explain what the files do unless the user explicitly asks for a summary or explanation.",
"Do not merely summarize or explain the provided project files unless the user explicitly asks for an explanation.",
        "When source code is provided, ground your explanation in that source.",
      ].join("\n");

      const aiPrompt = [
  selectedFile
    ? `SELECTED FILE:\n${selectedFile}`
    : "",

  sourceContent
    ? `SELECTED FILE CONTENT:\n${sourceContent}`
    : "",

  context
    ? `PROJECT CONTEXT:\n${context}`
    : "",

  `USER REQUEST:\n${prompt}`,

  "IMPORTANT: Answer the USER REQUEST directly.",
  "Do not summarize the project unless the user asks for a summary.",
  "If the request asks for a change, explain the exact existing file and code change needed.",
]
  .filter(Boolean)
  .join("\n\n");

      const responseText =
        await callAI(
          aiPrompt,

          systemPrompt,

          {
            json: false,
          }
        );

      res.json({
        response:
          responseText ||
          "AI returned an empty response.",
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        message:
          error.message ||
          "AI request failed.",
      });
    }
  }
);

/* =========================================================
   START SERVER
========================================================= */


 app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `VibeCoder backend running at http://localhost:${PORT}`
    );

    console.log(
      `Project root: ${PROJECT_ROOT}`
    );

    console.log(
      `Ollama model: ${OLLAMA_MODEL}`
    );

    console.log(
      `Gemini model: ${GEMINI_MODEL}`
    );
  }
);