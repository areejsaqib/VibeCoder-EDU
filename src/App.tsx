import { useState } from "react";
import type { ReactElement } from "react";
import "./App.css";

type Mode = "vibe" | "education" | "safe";

type ProjectItem =
  | string
  | {
      name?: string;
      path?: string;
      relativePath?: string;
      filePath?: string;
      type?: string;
      children?: ProjectItem[];
    };

type ContextFile = {
  path: string;
  name?: string;
  score?: number;
  reason?: string;
  content?: string;
};

type PlanStep = {
  step?: number;
  title?: string;
  description?: string;
};

type ProposedChange = {
  path: string;
  description: string;
  oldContent: string;
  newContent: string;
};

type DebugResult = {
  problem: string;
  why: string;
  fix: string;
  confidence: string;
};

function App() {
  const [mode, setMode] = useState<Mode>("vibe");
  const [prompt, setPrompt] = useState("");

  const [projectFiles, setProjectFiles] = useState<ProjectItem[]>([]);
  const [projectOpened, setProjectOpened] = useState(false);

  const [selectedFile, setSelectedFile] = useState("");
  const [selectedFileContent, setSelectedFileContent] = useState("");

  const [contextFiles, setContextFiles] = useState<ContextFile[]>([]);
  const [smartContextFiles, setSmartContextFiles] = useState<ContextFile[]>(
    []
  );

  const [agentPlan, setAgentPlan] = useState<PlanStep[]>([]);
  const [debugResult, setDebugResult] = useState<DebugResult | null>(null);

  const [proposedChanges, setProposedChanges] = useState<ProposedChange[]>(
    []
  );

  const [aiResponse, setAiResponse] = useState("");

  const [loading, setLoading] = useState(false);
  const [loadingAction, setLoadingAction] = useState("");

  const [statusMessage, setStatusMessage] = useState(
    "Ready for your next build."
  );

  const [applyingChanges, setApplyingChanges] = useState(false);

  const getItemPath = (item: ProjectItem): string => {
    if (typeof item === "string") {
      return item;
    }

    return (
      item.path ||
      item.relativePath ||
      item.filePath ||
      item.name ||
      ""
    );
  };

  const getItemName = (item: ProjectItem): string => {
    const rawPath = getItemPath(item);
    const parts = rawPath.split(/[\\/]+/).filter(Boolean);

    return parts[parts.length - 1] || rawPath || "Unnamed";
  };

  const isFileItem = (item: ProjectItem): boolean => {
    if (typeof item === "string") {
      return true;
    }

    if (item.type) {
      return item.type.toLowerCase() === "file";
    }

    return Boolean(
      item.path ||
        item.relativePath ||
        item.filePath ||
        item.name
    );
  };

  const normalizeContextPath = (filePath: string): string => {
    return filePath
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .replace(/^\/+/, "")
      .replace(/\/+/g, "/")
      .toLowerCase();
  };

  const handleSelectFile = async (filePath: string) => {
    if (!filePath) return;

    setSelectedFile(filePath);
    setLoading(true);
    setLoadingAction("Reading file...");
    setStatusMessage(`Loading ${filePath}`);

    try {
      const response = await fetch(
        `http://localhost:3001/api/project/file?path=${encodeURIComponent(
          filePath
        )}`
      );

      if (!response.ok) {
        throw new Error("Unable to read file.");
      }

      const data = await response.json();

      const content =
        typeof data.content === "string"
          ? data.content
          : "";

      setSelectedFileContent(content);
      setStatusMessage(`Selected ${filePath}`);
    } catch (error) {
      console.error(error);
      setSelectedFileContent("");
      setStatusMessage("Unable to read selected file.");
    } finally {
      setLoading(false);
      setLoadingAction("");
    }
  };

  const renderProjectItems = (
    items: ProjectItem[],
    level = 0
  ): ReactElement[] => {
    const rendered: ReactElement[] = [];

    items.forEach((item, index) => {
      const itemPath = getItemPath(item);
      const itemName = getItemName(item);

      if (!itemPath) {
        return;
      }

      const children =
        typeof item === "object" && Array.isArray(item.children)
          ? item.children
          : [];

      const hasChildren = children.length > 0;

      if (hasChildren) {
        rendered.push(
          <div
            key={`${itemPath}-${index}`}
            className="tree-folder"
            style={{ paddingLeft: `${12 + level * 14}px` }}
          >
            <span className="tree-icon">⌄</span>
            <span className="tree-folder-name">{itemName}</span>
          </div>
        );

        rendered.push(
          ...renderProjectItems(children, level + 1)
        );
      } else if (isFileItem(item)) {
        const active = selectedFile === itemPath;

        rendered.push(
          <button
            key={`${itemPath}-${index}`}
            className={`tree-file ${active ? "selected" : ""}`}
            style={{ paddingLeft: `${12 + level * 14}px` }}
            onClick={() => handleSelectFile(itemPath)}
          >
            <span className="tree-icon">▱</span>
            <span>{itemName}</span>
          </button>
        );
      }
    });

    return rendered;
  };

  const parseJsonResponse = (text: string) => {
    try {
      return JSON.parse(text);
    } catch {
      const cleaned = text
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

      try {
        return JSON.parse(cleaned);
      } catch {
        return null;
      }
    }
  };

  const parseDebugContent = (content: string): DebugResult => {
    const getSection = (
      sectionName: string,
      nextSections: string[]
    ): string => {
      const escapedName = sectionName.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

      const nextPattern =
        nextSections.length > 0
          ? `(?=\\n\\s*\\*\\*(${nextSections.join("|")})\\*\\*)`
          : "$";

      const pattern = new RegExp(
        `\\*\\*${escapedName}\\*\\*\\s*\\n?([\\s\\S]*?)${nextPattern}`,
        "i"
      );

      const match = content.match(pattern);

      return match ? match[1].trim() : "";
    };

    return {
      problem:
        getSection("PROBLEM", [
          "WHY",
          "SUGGESTED FIX",
          "CONFIDENCE",
        ]) || "No definite problem identified.",
      why:
        getSection("WHY", [
          "SUGGESTED FIX",
          "CONFIDENCE",
        ]) || "No explanation available.",
      fix:
        getSection("SUGGESTED FIX", [
          "CONFIDENCE",
        ]) || "No fix suggested.",
      confidence:
        getSection("CONFIDENCE", []) || "unknown",
    };
  };

  const handleOpenProject = async () => {
    setLoading(true);
    setLoadingAction("Opening project...");
    setStatusMessage("Scanning your project structure...");

    try {
      const response = await fetch(
        "http://localhost:3001/api/project"
      );

      if (!response.ok) {
        throw new Error("Unable to open project.");
      }

      const data = await response.json();

      const files = Array.isArray(data.files)
        ? data.files
        : Array.isArray(data.structure)
        ? data.structure
        : [];

      setProjectFiles(files);
      setProjectOpened(true);

      setStatusMessage(
        `${files.length} project items loaded into context.`
      );
    } catch (error) {
      console.error(error);

      setStatusMessage(
        "Could not connect to the VibeCoder backend."
      );
    } finally {
      setLoading(false);
      setLoadingAction("");
    }
  };

  const handleAddContext = async () => {
    if (!selectedFile) {
      setStatusMessage(
        "Select a file before adding AI context."
      );
      return;
    }

    setLoading(true);
    setLoadingAction("Adding context...");
    setStatusMessage(
      "Preparing selected file for the AI..."
    );

    try {
      const response = await fetch(
        "http://localhost:3001/api/project/file?path=" +
          encodeURIComponent(selectedFile)
      );

      if (!response.ok) {
        throw new Error("Could not load context.");
      }

      const data = await response.json();

      const content =
        typeof data.content === "string"
          ? data.content
          : "";

      setSelectedFileContent(content);

      setContextFiles((previous) => {
        const alreadyExists = previous.some(
          (file) =>
            normalizeContextPath(file.path) ===
            normalizeContextPath(selectedFile)
        );

        if (alreadyExists) {
          return previous;
        }

        return [
          ...previous,
          {
            path: selectedFile,
            name: getItemName(selectedFile),
            content,
          },
        ];
      });

      setStatusMessage(
        `AI context added: ${selectedFile}`
      );
    } catch (error) {
      console.error(error);

      setStatusMessage(
        "Unable to add AI context."
      );
    } finally {
      setLoading(false);
      setLoadingAction("");
    }
  };

  const handleSmartContext = async () => {
    if (!prompt.trim()) {
      setStatusMessage(
        "Write a request first so Smart Context can find relevant files."
      );
      return;
    }

    setLoading(true);
    setLoadingAction("Finding context...");
    setStatusMessage(
      "AI is selecting the most relevant files..."
    );

    try {
      const response = await fetch(
        "http://localhost:3001/api/project/suggest-context",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prompt: prompt.trim(),
          }),
        }
      );

      if (!response.ok) {
        throw new Error("Smart Context failed.");
      }

      const data = await response.json();

      const suggestions = Array.isArray(data.suggestions)
        ? data.suggestions
        : Array.isArray(data.files)
        ? data.files
        : Array.isArray(data.context)
        ? data.context
        : [];

      const normalized: ContextFile[] = suggestions
        .map((file: any) => {
          if (typeof file === "string") {
            return {
              path: file.trim(),
              name:
                file.split(/[\\/]+/).pop() ||
                file,
              reason:
                "Relevant to your request",
            };
          }

          return {
            path:
              typeof file.path === "string"
                ? file.path.trim()
                : typeof file.relativePath === "string"
                ? file.relativePath.trim()
                : typeof file.filePath === "string"
                ? file.filePath.trim()
                : typeof file.name === "string"
                ? file.name.trim()
                : "",
            name:
              file.name ||
              file.path ||
              file.relativePath ||
              "Unnamed",
            score: file.score,
            reason:
              file.reason ||
              "Relevant to your request",
          };
        })
        .filter(
          (file: ContextFile) =>
            file.path.trim().length > 0
        );

      /*
       * Smart Context can receive the same file more than once
       * from the backend with slightly different path formatting.
       *
       * We normalize the path before comparing:
       * - removes surrounding spaces
       * - converts Windows "\" to "/"
       * - removes "./" and leading "/"
       * - removes repeated "/"
       * - compares case-insensitively
       */
      const seenPaths = new Set<string>();

      const uniqueFiles = normalized.filter((file) => {
        const normalizedPath =
          normalizeContextPath(file.path);

        if (seenPaths.has(normalizedPath)) {
          return false;
        }

        seenPaths.add(normalizedPath);
        return true;
      });

      setSmartContextFiles(uniqueFiles);

      setStatusMessage(
        uniqueFiles.length
          ? `${uniqueFiles.length} unique relevant file(s) found.`
          : "No strong context matches found."
      );
    } catch (error) {
      console.error(error);

      setStatusMessage(
        "Smart Context could not complete."
      );
    } finally {
      setLoading(false);
      setLoadingAction("");
    }
  };

  const handleAgentPlan = async () => {
    if (!prompt.trim()) {
      setStatusMessage(
        "Describe what you want the agent to build first."
      );
      return;
    }

    setLoading(true);
    setLoadingAction("Planning...");
    setStatusMessage(
      "Agent is creating a build plan..."
    );

    try {
      const response = await fetch(
        "http://localhost:3001/api/agent/plan",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prompt: prompt.trim(),
            mode,
            contextFiles:
              contextFiles.length > 0
                ? contextFiles.map(
                    (file) => file.path
                  )
                : selectedFile
                ? [selectedFile]
                : [],
          }),
        }
      );

      if (!response.ok) {
        throw new Error("Planning failed.");
      }

      const data = await response.json();

      const parsed =
        typeof data.plan === "string"
          ? parseJsonResponse(data.plan)
          : data.plan;

      const rawSteps = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.steps)
        ? parsed.steps
        : [];

      const steps: PlanStep[] = rawSteps.map(
        (step: any, index: number) => {
          if (typeof step === "string") {
            return {
              step: index + 1,
              title: `Step ${index + 1}`,
              description: step,
            };
          }

          return {
            step:
              step.step ||
              index + 1,
            title:
              step.title ||
              `Step ${index + 1}`,
            description:
              step.description ||
              "Agent workflow step",
          };
        }
      );

      setAgentPlan(steps);

      setStatusMessage(
        steps.length
          ? `${steps.length}-step plan generated.`
          : "Agent plan generated."
      );
    } catch (error) {
      console.error(error);

      setStatusMessage(
        "Agent planning failed."
      );
    } finally {
      setLoading(false);
      setLoadingAction("");
    }
  };

  const handleDebug = async () => {
    if (!selectedFile) {
      setStatusMessage(
        "Select a file to debug."
      );
      return;
    }

    setLoading(true);
    setLoadingAction("Debugging...");
    setStatusMessage(
      `Analyzing ${selectedFile}...`
    );

    try {
      const response = await fetch(
        "http://localhost:3001/api/agent/debug",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prompt:
              prompt.trim() ||
              "Analyze this file for likely problems.",
            mode,
            selectedFile,
            selectedFileContent,
          }),
        }
      );

      if (!response.ok) {
        throw new Error("Debugging failed.");
      }

      const data = await response.json();

      let parsedDebug: DebugResult;

      if (
        data?.result &&
        typeof data.result.problem === "string"
      ) {
        parsedDebug = {
          problem:
            data.result.problem ||
            "No definite problem identified.",
          why:
            data.result.why ||
            "No explanation available.",
          fix:
            data.result.fix ||
            "No fix suggested.",
          confidence:
            data.result.confidence ||
            "unknown",
        };
      } else if (
        data?.result &&
        typeof data.result.content === "string"
      ) {
        parsedDebug =
          parseDebugContent(
            data.result.content
          );
      } else if (
        data?.problem ||
        data?.why ||
        data?.fix ||
        data?.confidence
      ) {
        parsedDebug = {
          problem:
            data.problem ||
            "No definite problem identified.",
          why:
            data.why ||
            "No explanation available.",
          fix:
            data.fix ||
            "No fix suggested.",
          confidence:
            data.confidence ||
            "unknown",
        };
      } else {
        parsedDebug = {
          problem:
            "No definite problem identified.",
          why:
            "No explanation available.",
          fix:
            "No fix suggested.",
          confidence:
            "unknown",
        };
      }

      setDebugResult(parsedDebug);

      setStatusMessage(
        "Debugging analysis completed."
      );
    } catch (error) {
      console.error(error);

      setStatusMessage(
        "Debugging agent failed."
      );
    } finally {
      setLoading(false);
      setLoadingAction("");
    }
  };

  const handleProposeChanges = async () => {
    const filesForContext =
      contextFiles.length > 0
        ? contextFiles
        : selectedFile
        ? [
            {
              path: selectedFile,
              content: selectedFileContent,
            },
          ]
        : [];

    if (!prompt.trim()) {
      setStatusMessage(
        "Describe the change you want the agent to propose."
      );
      return;
    }

    if (filesForContext.length === 0) {
      setStatusMessage(
        "Select a file or add AI context first."
      );
      return;
    }

    setLoading(true);
    setLoadingAction(
      "Preparing changes..."
    );
    setStatusMessage(
      "Agent is preparing controlled changes..."
    );

    try {
      const response = await fetch(
        "http://localhost:3001/api/agent/changes",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prompt: prompt.trim(),
            mode,
            contextFiles:
              filesForContext.map(
                (file) => file.path
              ),
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.message ||
            "Could not prepare changes."
        );
      }

      const changes =
        Array.isArray(data.changes)
          ? data.changes
          : [];

      setProposedChanges(changes);

      setStatusMessage(
        changes.length
          ? `${changes.length} controlled change(s) proposed. Review them before applying.`
          : "No changes proposed."
      );
    } catch (error: any) {
      console.error(error);

      setStatusMessage(
        error?.message ||
          "Controlled changes failed."
      );
    } finally {
      setLoading(false);
      setLoadingAction("");
    }
  };

  const handleApplyChanges = async () => {
    if (proposedChanges.length === 0) {
      setStatusMessage(
        "There are no proposed changes to apply."
      );
      return;
    }

    const invalidChange =
      proposedChanges.some(
        (change) =>
          !change.path ||
          typeof change.newContent !== "string"
      );

    if (invalidChange) {
      setStatusMessage(
        "One or more proposed changes are incomplete."
      );
      return;
    }

    const approved = window.confirm(
      `VibeCoder is ready to apply ${proposedChanges.length} approved change(s) to your project. Continue?`
    );

    if (!approved) {
      setStatusMessage(
        "Changes were not applied."
      );
      return;
    }

    setApplyingChanges(true);
    setStatusMessage(
      "Applying approved changes..."
    );

    try {
      const response = await fetch(
        "http://localhost:3001/api/agent/apply",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            changes: proposedChanges,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.message ||
            "Could not apply changes."
        );
      }

      const applied =
        Array.isArray(data.applied)
          ? data.applied
          : [];

      setStatusMessage(
        applied.length
          ? `${applied.length} change(s) applied successfully.`
          : "Changes applied successfully."
      );

      setAiResponse(
        `Safe Mode completed successfully.\n\nApplied changes:\n${applied
          .map(
            (path: string) =>
              `✓ ${path}`
          )
          .join("\n")}`
      );

      setProposedChanges([]);

      if (selectedFile) {
        await handleSelectFile(
          selectedFile
        );
      }
    } catch (error: any) {
      console.error(error);

      setStatusMessage(
        error?.message ||
          "Unable to apply approved changes."
      );
    } finally {
      setApplyingChanges(false);
    }
  };

  const handleSafeBuild = async () => {
    if (!prompt.trim()) {
      setStatusMessage(
        "Describe the change you want VibeCoder to review."
      );
      return;
    }

    setAiResponse("");
    setProposedChanges([]);

    await handleProposeChanges();
  };

  const handleNormalBuild = async () => {
    if (!prompt.trim()) {
      setStatusMessage(
        "Tell VibeCoder what you want to build."
      );
      return;
    }

    setLoading(true);
    setLoadingAction("Building...");
    setStatusMessage(
      "Local AI is working on your request..."
    );
    setAiResponse("");

    try {
      const response = await fetch(
        "http://localhost:3001/api/chat",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prompt: prompt.trim(),
            mode,
            selectedFile,
            selectedFileContent,
            contextFiles:
              contextFiles.length > 0
                ? contextFiles.map(
                    (file) => file.path
                  )
                : selectedFile
                ? [selectedFile]
                : [],
          }),
        }
      );

      if (!response.ok) {
        throw new Error(
          "Build request failed."
        );
      }

      const data = await response.json();

      const result =
        data.response ||
        data.message ||
        data.answer ||
        data.content ||
        "";

      setAiResponse(
        typeof result === "string"
          ? result
          : JSON.stringify(
              result,
              null,
              2
            )
      );

      setStatusMessage(
        "Build response received."
      );
    } catch (error) {
      console.error(error);

      setAiResponse(
        "Unable to connect to the local AI backend."
      );

      setStatusMessage(
        "Build failed. Check that the backend and Ollama are running."
      );
    } finally {
      setLoading(false);
      setLoadingAction("");
    }
  };

  const handleBuild = async () => {
    if (mode === "safe") {
      await handleSafeBuild();
      return;
    }

    await handleNormalBuild();
  };

  return (
    <div
      className={`app ${
        mode === "safe"
          ? "vibecoder-safe-dark-mode"
          : ""
      }`}
    >
      <header className="topbar">
        <div className="brand-area">
          <div className="brand-mark">
            <span>{"{"}</span>
            <span>VC</span>
            <span>{"}"}</span>
          </div>

          <div className="brand-copy">
            <h1>VibeCoder EDU</h1>
            <p>Build. Learn. Understand.</p>
          </div>
        </div>

        <div className="topbar-center">
          <span className="workspace-label">
            AI DEVELOPMENT STUDIO
          </span>
        </div>

        <div className="topbar-right">
          <div className="agent-status">
            Local AI Online
          </div>

          <div className="version-badge">
            EDU
          </div>
        </div>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <section className="panel project-panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">
                  WORKSPACE
                </span>

                <h2>
                  Project Explorer
                </h2>
              </div>

              <span className="panel-count">
                {projectFiles.length || "—"}
              </span>
            </div>

            <button
              className="open-project-button"
              onClick={handleOpenProject}
              disabled={loading}
            >
              <span>＋</span>

              {loadingAction ===
              "Opening project..."
                ? "Opening..."
                : "Open Project"}
            </button>

            <div className="project-status">
              <span className="status-dot"></span>

              {projectOpened
                ? "Project connected"
                : "No project loaded"}
            </div>

            <div className="project-tree">
              {projectFiles.length > 0 ? (
                renderProjectItems(
                  projectFiles
                )
              ) : (
                <div className="empty-tree">
                  <div className="empty-icon">
                    ⌁
                  </div>

                  <strong>
                    Project explorer
                  </strong>

                  <span>
                    Open your project to
                    load its files.
                  </span>
                </div>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">
                  AI BEHAVIOR
                </span>

                <h2>
                  Working Mode
                </h2>
              </div>
            </div>

            <div className="mode-buttons">
              <button
                className={`mode-button ${
                  mode === "vibe"
                    ? "active"
                    : ""
                }`}
                onClick={() =>
                  setMode("vibe")
                }
              >
                <span>✦</span>

                <div>
                  <strong>
                    Vibe Coding
                  </strong>

                  <small>
                    Build faster with AI
                  </small>
                </div>
              </button>

              <button
                className={`mode-button ${
                  mode === "education"
                    ? "active"
                    : ""
                }`}
                onClick={() =>
                  setMode("education")
                }
              >
                <span>◈</span>

                <div>
                  <strong>
                    Education
                  </strong>

                  <small>
                    Learn and understand
                    the code
                  </small>
                </div>
              </button>

              <button
                className={`mode-button ${
                  mode === "safe"
                    ? "active"
                    : ""
                }`}
                onClick={() =>
                  setMode("safe")
                }
              >
                <span>◇</span>

                <div>
                  <strong>
                    Safe Mode
                  </strong>

                  <small>
                    Review changes before
                    applying
                  </small>
                </div>
              </button>
            </div>
          </section>
        </aside>

        <section className="main-panel">
          <section className="builder-card">
            <div className="builder-glow"></div>

            <div className="builder-header">
              <div>
                <span className="eyebrow">
                  LOCAL AI BUILDER
                </span>

                <h2>
                  {mode === "vibe"
                    ? "What are you building today?"
                    : mode === "education"
                    ? "What would you like to learn today?"
                    : "What would you like to review safely?"}
                </h2>

                <p>
                  {mode === "vibe"
                    ? "Describe your idea, feature, bug, or learning goal. VibeCoder will help you turn it into working code."
                    : mode === "education"
                    ? "Ask a coding question or share code you want to understand. VibeCoder will guide you step by step."
                    : "Describe the change you want to make. VibeCoder will propose the changes first so you can review them before anything is applied."}
                </p>
              </div>

              <div className="builder-orb">
                <span>AI</span>
              </div>
            </div>

            <div className="prompt-wrapper">
              <div className="prompt-topline">
                <span>
                  <span className="terminal-symbol">
                    &gt;_
                  </span>{" "}
                  COMMAND
                </span>

                <span>
                  {mode === "vibe"
                    ? "PRACTICAL"
                    : mode === "education"
                    ? "LEARNING"
                    : "RESPONSIBLE"}
                </span>
              </div>

              <textarea
                className="prompt-box"
                value={prompt}
                onChange={(event) =>
                  setPrompt(
                    event.target.value
                  )
                }
                placeholder={
                  mode === "vibe"
                    ? "Ask VibeCoder to build, explain, debug, or improve something..."
                    : mode === "education"
                    ? "Ask VibeCoder to explain a coding concept or help you understand your code..."
                    : "Describe a change you want to review before applying..."
                }
              />

              <div className="prompt-footer">
                <span>
                  {selectedFile
                    ? `Context: ${selectedFile}`
                    : "No file selected"}
                </span>

                <span>
                  Local processing
                </span>
              </div>
            </div>

            <div className="builder-actions">
              <div className="secondary-actions">
                <button
                  className="secondary-button"
                  onClick={
                    handleAgentPlan
                  }
                  disabled={loading}
                >
                  <span>◈</span>
                  Agent Plan
                </button>

                <button
                  className="secondary-button"
                  onClick={
                    handleProposeChanges
                  }
                  disabled={loading}
                >
                  <span>◇</span>
                  Propose Changes
                </button>

                <button
                  className="secondary-button"
                  onClick={
                    handleDebug
                  }
                  disabled={loading}
                >
                  <span>⌁</span>
                  Debug
                </button>
              </div>

              <button
                className="build-button"
                onClick={
                  handleBuild
                }
                disabled={
                  loading ||
                  applyingChanges
                }
              >
                <span className="build-icon">
                  {mode === "safe"
                    ? "◇"
                    : "✦"}
                </span>

                {loadingAction ===
                "Building..."
                  ? "Building..."
                  : loadingAction ===
                    "Preparing changes..."
                  ? "Preparing..."
                  : mode === "safe"
                  ? "Review with AI"
                  : "Build with AI"}

                <span className="build-arrow">
                  →
                </span>
              </button>
            </div>

            <div className="agent-status-line">
              <span className="live-dot"></span>

              <span>
                {loading
                  ? loadingAction ||
                    "AI is working..."
                  : statusMessage}
              </span>
            </div>
          </section>

          <div className="dashboard-grid">
            <section className="panel context-panel">
              <div className="panel-header">
                <div>
                  <span className="eyebrow">
                    CONTEXT
                  </span>

                  <h2>
                    AI Context
                  </h2>
                </div>

                <span className="panel-count">
                  {contextFiles.length}
                </span>
              </div>

              <div className="context-selected">
                <div className="context-icon">
                  ▱
                </div>

                <div className="context-info">
                  <strong>
                    {selectedFile
                      ? selectedFile
                          .split(
                            /[\\/]+/
                          )
                          .pop()
                      : "No file selected"}
                  </strong>

                  <span>
                    {selectedFile
                      ? "Selected project file"
                      : "Choose a file from the explorer"}
                  </span>
                </div>

                <button
                  className="mini-button"
                  onClick={
                    handleAddContext
                  }
                  disabled={
                    !selectedFile ||
                    loading
                  }
                >
                  Add
                </button>
              </div>

              {contextFiles.length >
                0 && (
                <div className="context-list">
                  {contextFiles.map(
                    (file) => (
                      <div
                        className="context-chip"
                        key={file.path}
                      >
                        <span>✓</span>
                        {file.path}
                      </div>
                    )
                  )}
                </div>
              )}
            </section>

            <section className="panel smart-panel">
              <div className="panel-header">
                <div>
                  <span className="eyebrow">
                    INTELLIGENCE
                  </span>

                  <h2>
                    Smart Context
                  </h2>
                </div>

                <span className="ai-badge">
                  AI
                </span>
              </div>

              <p className="panel-description">
                Let VibeCoder identify the
                project files most relevant
                to your request.
              </p>

              <button
                className="smart-context-button"
                onClick={
                  handleSmartContext
                }
                disabled={
                  loading ||
                  !prompt.trim()
                }
              >
                <span>✦</span>
                Find Relevant Files
              </button>

              {smartContextFiles.length >
                0 && (
                <div className="smart-results">
                  {smartContextFiles.map(
                    (
                      file,
                      index
                    ) => (
                      <button
                        className="smart-result"
                        key={normalizeContextPath(
                          file.path
                        )}
                        onClick={async () => {
  await handleSelectFile(file.path);

  const alreadyAdded = contextFiles.some(
    (item) =>
      normalizeContextPath(item.path) ===
      normalizeContextPath(file.path)
  );

  if (!alreadyAdded) {
    try {
      const response = await fetch(
        `http://localhost:3001/api/project/file?path=${encodeURIComponent(file.path)}`
      );

      const data = await response.json();

      if (data.content) {
        setContextFiles((current) => [
          ...current,
          {
            path: file.path,
            name: getItemName(file.path),
            content: data.content,
          },
        ]);
      }
    } catch (error) {
      console.error("Failed to add Smart Context file:", error);
    }
  }
}}
                      >
                        <span className="result-number">
                          {String(
                            index + 1
                          ).padStart(
                            2,
                            "0"
                          )}
                        </span>

                        <span className="result-content">
                          <strong>
                            {file.name ||
                              file.path}
                          </strong>

                          <span>
                            {file.reason ||
                              "Relevant to your request"}
                          </span>
                        </span>

                        {typeof file.score ===
                          "number" && (
                          <span className="result-score">
                            {file.score}
                          </span>
                        )}
                      </button>
                    )
                  )}
                </div>
              )}
            </section>
          </div>

          <section className="panel full-panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">
                  AGENT WORKFLOW
                </span>

                <h2>
                  Agent Plan
                </h2>
              </div>

              <span className="panel-count">
                {agentPlan.length}
              </span>
            </div>

            {agentPlan.length > 0 ? (
              <div className="plan-list">
                {agentPlan.map(
                  (
                    step,
                    index
                  ) => (
                    <div
                      className="plan-step"
                      key={index}
                    >
                      <div className="step-number">
                        {step.step ||
                          index + 1}
                      </div>

                      <div className="step-content">
                        <strong>
                          {step.title ||
                            `Step ${index + 1}`}
                        </strong>

                        <span>
                          {step.description ||
                            "Agent workflow step"}
                        </span>
                      </div>
                    </div>
                  )
                )}
              </div>
            ) : (
              <div className="empty-state">
                <span>◈</span>

                <div>
                  <strong>
                    No plan generated yet
                  </strong>

                  <p>
                    Use Agent Plan to turn
                    your request into a
                    structured workflow.
                  </p>
                </div>
              </div>
            )}
          </section>

          <section className="panel full-panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">
                  DIAGNOSTICS
                </span>

                <h2>
                  Debugging Agent
                </h2>
              </div>

              <span className="panel-count">
                {debugResult
                  ? "READY"
                  : "—"}
              </span>
            </div>

            {debugResult ? (
              <div className="debug-content">
                <div className="debug-card problem">
                  <span className="debug-label">
                    PROBLEM
                  </span>

                  <strong>
                    {debugResult.problem}
                  </strong>
                </div>

                <div className="debug-card">
                  <span className="debug-label">
                    WHY
                  </span>

                  <p>
                    {debugResult.why}
                  </p>
                </div>

                <div className="debug-card">
                  <span className="debug-label">
                    SUGGESTED FIX
                  </span>

                  <p>
                    {debugResult.fix}
                  </p>
                </div>

                <div className="confidence-card">
                  <span>
                    CONFIDENCE
                  </span>

                  <strong>
                    {debugResult.confidence}
                  </strong>
                </div>
              </div>
            ) : (
              <div className="empty-state">
                <span>⌁</span>

                <div>
                  <strong>
                    Debugging is ready
                  </strong>

                  <p>
                    Select a project file and
                    run the Debug action to
                    analyze it.
                  </p>
                </div>
              </div>
            )}
          </section>

          <section className="panel full-panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">
                  CONTROLLED EDITING
                </span>

                <h2>
                  Proposed Changes
                </h2>
              </div>

              <span className="panel-count">
                {proposedChanges.length}
              </span>
            </div>

            {proposedChanges.length > 0 ? (
              <div>
                <div className="changes-list">
                  {proposedChanges.map(
                    (
                      change,
                      index
                    ) => (
                      <div
                        className="change-card"
                        key={`${change.path}-${index}`}
                      >
                        <div className="change-top">
                          <span className="change-action">
                            REVIEW
                          </span>

                          <strong>
                            {change.path ||
                              "Unknown file"}
                          </strong>
                        </div>

                        <p>
                          {change.description ||
                            "Controlled change proposed by AI."}
                        </p>

                        <details>
                          <summary>
                            View original file
                          </summary>

                          <pre className="code-output">
                            {change.oldContent}
                          </pre>
                        </details>

                        <details open>
                          <summary>
                            View proposed version
                          </summary>

                          <pre className="code-output">
                            {change.newContent}
                          </pre>
                        </details>
                      </div>
                    )
                  )}
                </div>

                <div
                  style={{
                    marginTop: "18px",
                    display: "flex",
                    justifyContent:
                      "flex-end",
                  }}
                >
                  <button
                    className="build-button"
                    onClick={
                      handleApplyChanges
                    }
                    disabled={
                      loading ||
                      applyingChanges
                    }
                  >
                    <span className="build-icon">
                      ✓
                    </span>

                    {applyingChanges
                      ? "Applying..."
                      : "Approve & Apply Changes"}

                    <span className="build-arrow">
                      →
                    </span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="empty-state">
                <span>◇</span>

                <div>
                  <strong>
                    No proposed changes
                  </strong>

                  <p>
                    Safe Mode will show proposed
                    file changes here before
                    anything is applied.
                  </p>
                </div>
              </div>
            )}
          </section>

          <section className="panel full-panel response-panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">
                  LOCAL AI OUTPUT
                </span>

                <h2>
                  AI Response
                </h2>
              </div>

              <span className="live-badge">
                ● LIVE
              </span>
            </div>

            {aiResponse ? (
              <pre className="code-output">
                {aiResponse}
              </pre>
            ) : (
              <div className="empty-state response-empty">
                <div className="response-orb">
                  ✦
                </div>

                <div>
                  <strong>
                    Your AI workspace is ready
                  </strong>

                  <p>
                    Enter a request above and
                    build with your local
                    coding model.
                  </p>
                </div>
              </div>
            )}
          </section>

          {selectedFile && (
            <section className="panel full-panel file-preview-panel">
              <div className="panel-header">
                <div>
                  <span className="eyebrow">
                    FILE INSPECTOR
                  </span>

                  <h2>
                    {selectedFile}
                  </h2>
                </div>

                <span className="panel-count">
                  SOURCE
                </span>
              </div>

              <pre className="code-output">
                {selectedFileContent ||
                  "No file content available."}
              </pre>
            </section>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;