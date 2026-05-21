const path = require("path");
const os = require("os");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const { SessionStore } = require("../codex/session-store");
const { buildOpeningTurnText, buildInstructionRefreshText } = require("../shared-instructions");

function createOpenClawRuntimeAdapter(config) {
  const stateDir = config.stateDir || path.join(os.homedir(), ".cyberboss");
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: "openclaw" });
  const openclawBaseUrl = config.openclawBaseUrl || "http://127.0.0.1:18789";
  const openclawApiKey = config.openclawApiKey || "openclaw123";
  const openclawModel = config.openclawModel || "openclaw/default";
  const conversationsFile = path.join(stateDir, "openclaw-conversations.json");

  let globalListener = null;
  const activeControllers = new Map();

  function emitEvent(event) {
    if (globalListener && event) {
      try {
        globalListener(event, null);
      } catch {}
    }
  }

  function loadConversations() {
    try {
      return JSON.parse(fs.readFileSync(conversationsFile, "utf8"));
    } catch {
      return {};
    }
  }

  function saveConversations(conversations) {
    try {
      fs.mkdirSync(path.dirname(conversationsFile), { recursive: true });
      fs.writeFileSync(conversationsFile, JSON.stringify(conversations, null, 2), "utf8");
    } catch {}
  }

  function getMessages(threadId) {
    const all = loadConversations();
    return Array.isArray(all[threadId]) ? all[threadId].slice() : [];
  }

  function setMessages(threadId, messages) {
    const all = loadConversations();
    all[threadId] = messages;
    saveConversations(all);
  }

  function deleteThreadHistory(threadId) {
    const all = loadConversations();
    delete all[threadId];
    saveConversations(all);
  }

  function callCompletions(messages, signal) {
    const url = new URL("/v1/chat/completions", openclawBaseUrl);
    const body = JSON.stringify({ model: openclawModel, messages });
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + (url.search || ""),
          method: "POST",
          headers: {
            Authorization: `Bearer ${openclawApiKey}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(new Error(`OpenClaw response parse error: ${err.message} — body: ${data.slice(0, 200)}`));
            }
          });
        },
      );

      req.on("error", reject);

      if (signal) {
        const onAbort = () => {
          req.destroy();
          reject(new Error("Turn cancelled"));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      req.write(body);
      req.end();
    });
  }

  function runTurnAsync({ threadId, turnId, outboundText }) {
    setImmediate(async () => {
      emitEvent({ type: "runtime.turn.started", payload: { threadId, turnId } });

      const controller = new AbortController();
      activeControllers.set(threadId, controller);

      try {
        const messages = getMessages(threadId);
        messages.push({ role: "user", content: outboundText });

        const response = await callCompletions(messages, controller.signal);
        const assistantText = response?.choices?.[0]?.message?.content || "";
        const usage = response?.usage || {};

        messages.push({ role: "assistant", content: assistantText });
        setMessages(threadId, messages);

        emitEvent({
          type: "runtime.reply.completed",
          payload: { threadId, turnId, itemId: `item-${turnId}`, text: assistantText },
        });

        const promptTokens = Number(usage.prompt_tokens) || 0;
        const completionTokens = Number(usage.completion_tokens) || 0;
        if (promptTokens || completionTokens) {
          emitEvent({
            type: "runtime.context.updated",
            payload: {
              runtimeId: "openclaw",
              threadId,
              inputTokens: promptTokens,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              outputTokens: completionTokens,
              currentTokens: promptTokens + completionTokens,
            },
          });
        }

        emitEvent({
          type: "runtime.turn.completed",
          payload: { threadId, turnId, text: assistantText },
        });
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        emitEvent({
          type: "runtime.turn.failed",
          payload: { threadId, turnId, text: `❌ OpenClaw error: ${errorText}` },
        });
      } finally {
        activeControllers.delete(threadId);
      }
    });
  }

  return {
    describe() {
      return {
        id: "openclaw",
        kind: "runtime",
        baseUrl: openclawBaseUrl,
        model: openclawModel,
        sessionsFile: config.sessionsFile,
      };
    },

    onEvent(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      globalListener = listener;
      return () => {
        if (globalListener === listener) {
          globalListener = null;
        }
      };
    },

    getSessionStore() {
      return sessionStore;
    },

    getTurnCapabilities() {
      return { nativeImageInput: false, toolImageRead: false };
    },

    async initialize() {
      return { baseUrl: openclawBaseUrl, model: openclawModel, models: [] };
    },

    async close() {
      for (const controller of activeControllers.values()) {
        controller.abort();
      }
      activeControllers.clear();
    },

    async startFreshThreadDraft({ bindingKey, workspaceRoot } = {}) {
      if (bindingKey && workspaceRoot) {
        const oldThreadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
        if (oldThreadId) {
          deleteThreadHistory(oldThreadId);
        }
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
      }
      return {};
    },

    async respondApproval() {
      throw new Error("OpenClaw runtime does not support tool approvals");
    },

    async cancelTurn({ threadId }) {
      const controller = activeControllers.get(String(threadId || "").trim());
      if (controller) {
        controller.abort();
        activeControllers.delete(String(threadId || "").trim());
      }
      return { threadId };
    },

    async resumeThread({ threadId }) {
      return { threadId };
    },

    async compactThread({ threadId }) {
      const messages = getMessages(threadId);
      if (!messages.length) {
        return { threadId };
      }

      const summaryMessages = [
        ...messages,
        {
          role: "user",
          content:
            "Please summarize our conversation so far concisely, capturing all key context, decisions, and information. This summary will replace the full history for future messages.",
        },
      ];

      const turnId = crypto.randomUUID();

      try {
        const response = await callCompletions(summaryMessages);
        const summary = response?.choices?.[0]?.message?.content || "";
        if (summary) {
          setMessages(threadId, [
            { role: "user", content: "[Previous conversation summary]" },
            { role: "assistant", content: summary },
          ]);
        }
      } catch {}

      emitEvent({
        type: "runtime.turn.completed",
        payload: { threadId, turnId, text: "Context compacted." },
      });
      return { threadId, turnId };
    },

    async refreshThreadInstructions({ threadId }) {
      const refreshText = buildInstructionRefreshText(config);
      const turnId = crypto.randomUUID();

      const messages = getMessages(threadId);
      messages.push({ role: "user", content: refreshText });

      try {
        const response = await callCompletions(messages);
        const assistantText = response?.choices?.[0]?.message?.content || "";
        messages.push({ role: "assistant", content: assistantText });
        setMessages(threadId, messages);

        emitEvent({
          type: "runtime.reply.completed",
          payload: { threadId, turnId, itemId: `item-${turnId}`, text: assistantText },
        });
        emitEvent({
          type: "runtime.turn.completed",
          payload: { threadId, turnId, text: assistantText },
        });
      } catch (error) {
        emitEvent({
          type: "runtime.turn.failed",
          payload: { threadId, turnId, text: `❌ Refresh failed: ${error instanceof Error ? error.message : String(error)}` },
        });
      }

      return { threadId };
    },

    async sendTextTurn(args) {
      return this.sendTurn(args);
    },

    async sendTurn({ bindingKey, workspaceRoot, text, metadata = {} }) {
      const existingThreadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      const isNewThread = !existingThreadId;
      const threadId = existingThreadId || crypto.randomUUID();
      const turnId = crypto.randomUUID();

      sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata);

      const outboundText = isNewThread ? buildOpeningTurnText(config, text) : text;
      runTurnAsync({ threadId, turnId, outboundText });

      return { threadId, turnId };
    },
  };
}

module.exports = { createOpenClawRuntimeAdapter };
