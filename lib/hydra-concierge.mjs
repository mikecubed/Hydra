/**
 * Hydra Concierge — Conversational front-end powered by OpenAI (gpt-5.3-codex).
 *
 * Handles user-facing chat, answers questions directly, and only escalates
 * to the full agent dispatch pipeline when actual work needs doing.
 * Uses streaming SSE from the OpenAI chat completions API.
 */

import { loadHydraConfig } from './hydra-config.mjs';
import { getMode, getModelSummary } from './hydra-agents.mjs';

// ── State ────────────────────────────────────────────────────────────────────

let history = [];          // {role, content}[]
let stats = { turns: 0, promptTokens: 0, completionTokens: 0 };
let systemPromptCache = { text: '', builtAt: 0 };
const SYSTEM_PROMPT_TTL_MS = 30_000;

// ── Config ───────────────────────────────────────────────────────────────────

export function getConciergeConfig() {
  const cfg = loadHydraConfig();
  return cfg.concierge || {
    enabled: true,
    model: 'gpt-5.3-codex',
    reasoningEffort: 'xhigh',
    maxHistoryMessages: 40,
    autoActivate: false,
  };
}

// ── Availability ─────────────────────────────────────────────────────────────

export function isConciergeAvailable() {
  const cfg = getConciergeConfig();
  if (!cfg.enabled) return false;
  return Boolean(process.env.OPENAI_API_KEY);
}

// ── Init ─────────────────────────────────────────────────────────────────────

export function initConcierge(opts = {}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not set — concierge requires an OpenAI API key');
  }
  history = [];
  stats = { turns: 0, promptTokens: 0, completionTokens: 0 };
  systemPromptCache = { text: '', builtAt: 0 };
}

// ── Conversation Management ──────────────────────────────────────────────────

export function resetConversation() {
  history = [];
  stats.turns = 0;
  systemPromptCache = { text: '', builtAt: 0 };
}

export function getConciergeStats() {
  return { ...stats };
}

function trimHistory(maxMessages) {
  // Remove oldest user+assistant pairs when exceeding limit
  while (history.length > maxMessages) {
    // Remove first two messages (user + assistant pair)
    history.splice(0, 2);
  }
}

// ── System Prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(context = {}) {
  const now = Date.now();
  if (systemPromptCache.text && (now - systemPromptCache.builtAt) < SYSTEM_PROMPT_TTL_MS) {
    return systemPromptCache.text;
  }

  const project = context.projectName || 'unknown';
  const mode = context.mode || 'auto';
  const openTasks = context.openTasks ?? 0;
  const agentModels = context.agentModels || {};

  const modelLines = Object.entries(agentModels)
    .map(([agent, model]) => `  - ${agent}: ${model}`)
    .join('\n');

  const text = `You are the Hydra Concierge — the conversational front-end for the Hydra multi-agent orchestration system.

Current state:
- Project: ${project}
- Operator mode: ${mode}
- Open tasks: ${openTasks}
- Agent models:
${modelLines || '  (none loaded)'}

Your role:
1. Answer questions about Hydra, the project, general programming, and anything the user asks conversationally.
2. Help the user think through problems, refine their objectives, and plan their work.
3. When the user gives you an instruction that requires actual code changes, file modifications, debugging, investigation, or any hands-on work that Hydra agents should execute — you MUST escalate by prefixing your entire response with [DISPATCH] followed by a clean, actionable prompt for the dispatch pipeline.

Intent rules:
- Questions, discussion, brainstorming, explanations → respond directly (NO [DISPATCH] prefix)
- Requests for code changes, bug fixes, feature implementation, file creation, refactoring, running commands, investigation that requires reading files → respond with [DISPATCH] followed by a refined prompt
- If ambiguous, ask the user to clarify rather than guessing

Command awareness — the operator supports these colon-prefixed commands:
  :help                 Show help
  :status               Dashboard with agents & tasks
  :mode auto            Mini-round triage then delegate/escalate
  :mode smart           Auto-select model tier per prompt complexity
  :mode handoff         Direct handoffs (fast, no triage)
  :mode council         Full council deliberation
  :mode dispatch        Headless pipeline (Claude→Gemini→Codex)
  :model                Show mode & active models
  :model mode=economy   Switch global mode (performance/balanced/economy/custom)
  :model claude=sonnet  Override agent model
  :model reset          Clear all overrides
  :usage                Token usage & contingencies
  :stats                Agent metrics & performance
  :resume               Ack handoffs, reset stale tasks, launch agents
  :pause [reason]       Pause the active session
  :unpause              Resume a paused session
  :fork                 Fork current session (explore alternatives)
  :spawn <focus>        Spawn child session (fresh context)
  :tasks                List active tasks
  :handoffs             List pending & recent handoffs
  :cancel <id>          Cancel a task (e.g. :cancel T003)
  :clear                Cancel all tasks & ack all handoffs
  :clear tasks          Cancel all open tasks
  :clear handoffs       Ack all pending handoffs
  :archive              Archive completed work & trim events
  :events               Show recent event log
  :workers              Show worker status
  :workers start [agent]  Start worker(s)
  :workers stop [agent]   Stop worker(s)
  :workers restart        Restart all workers
  :workers mode <mode>    Change permission mode (auto-edit/full-auto)
  :watch <agent>        Open visible terminal for agent observation
  :chat                 Toggle concierge on/off
  :chat off             Disable concierge
  :chat reset           Clear conversation history
  :chat stats           Show token usage
  :evolve               Launch evolve session (research→plan→test→implement)
  :evolve focus=<area>  Focus on specific area (e.g. testing-reliability)
  :evolve max-rounds=N  Limit rounds (default: 3)
  :evolve status        Show latest evolve session report
  :evolve knowledge     Browse accumulated knowledge base
  :confirm              Show/toggle dispatch confirmations
  :confirm on/off       Enable/disable confirmations
  :shutdown             Stop the daemon
  :quit / :exit         Exit operator console
  !<prompt>             Force dispatch (bypass concierge)

If the user's input looks like a mistyped or approximate command (e.g. "stats", "satus", ":staus", "show status", "clear tasks", "halp", "mode economy", "switch to council"), you MUST:
- Identify the most likely intended command
- Respond briefly: suggest the exact command they should type, formatted as \`:command\`
- Do NOT execute the command yourself — just tell them what to type
- Be concise: one or two sentences max

Important constraints:
- You cannot read files, make changes, or execute commands yourself
- You can only converse and decide when to escalate to the agent pipeline
- Keep responses concise and focused
- When escalating with [DISPATCH], write a clear, actionable prompt that includes all necessary context from the conversation`;

  systemPromptCache = { text, builtAt: now };
  return text;
}

// ── Streaming API Client ─────────────────────────────────────────────────────

async function streamCompletion(messages, cfg, onChunk) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = cfg.model || 'gpt-5.3-codex';
  const reasoningEffort = cfg.reasoningEffort || 'xhigh';

  const body = {
    model,
    messages,
    stream: true,
    reasoning: { effort: reasoningEffort },
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`OpenAI API error ${res.status}: ${errText.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  // Parse SSE stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullResponse = '';
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;

      try {
        const data = JSON.parse(trimmed.slice(6));
        const delta = data.choices?.[0]?.delta;
        if (delta?.content) {
          fullResponse += delta.content;
          if (onChunk) onChunk(delta.content);
        }
        // Capture usage from final chunk if present
        if (data.usage) {
          usage = data.usage;
        }
      } catch {
        // Skip malformed SSE chunks
      }
    }
  }

  return { fullResponse, usage };
}

// ── Main Turn ────────────────────────────────────────────────────────────────

/**
 * Process one conversational turn.
 * @param {string} userMsg - The user's message
 * @param {object} opts
 * @param {Function} [opts.onChunk] - Called with each streamed text chunk
 * @param {object} [opts.context] - Live state for system prompt {projectName, mode, openTasks, agentModels}
 * @returns {Promise<{intent: 'chat'|'dispatch', response: string, dispatchPrompt?: string}>}
 */
export async function conciergeTurn(userMsg, opts = {}) {
  const cfg = getConciergeConfig();
  const systemPrompt = buildSystemPrompt(opts.context || {});

  // Add user message to history
  history.push({ role: 'user', content: userMsg });
  trimHistory(cfg.maxHistoryMessages || 40);

  // Build messages array
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
  ];

  // Track whether we've detected [DISPATCH] prefix
  let isDispatch = false;
  let dispatchDetected = false;
  let responseBuffer = '';
  let chunkCount = 0;

  const onChunk = (chunk) => {
    responseBuffer += chunk;
    chunkCount++;

    // Check for [DISPATCH] prefix in first few chunks
    if (!dispatchDetected && chunkCount <= 5) {
      const trimmed = responseBuffer.trimStart();
      if (trimmed.startsWith('[DISPATCH]')) {
        isDispatch = true;
        dispatchDetected = true;
        // Don't stream [DISPATCH] prefix to user
        return;
      } else if (trimmed.length > 12) {
        // Enough text to know it's not a dispatch
        dispatchDetected = true;
      }
    }

    // Stream to user only if it's a chat response
    if (dispatchDetected && !isDispatch && opts.onChunk) {
      opts.onChunk(chunk);
    }
  };

  const { fullResponse, usage } = await streamCompletion(messages, cfg, onChunk);

  // If we buffered early chunks waiting for dispatch detection, flush them now
  if (!isDispatch && !dispatchDetected && opts.onChunk) {
    opts.onChunk(responseBuffer);
  }

  // Update stats
  stats.turns++;
  if (usage) {
    stats.promptTokens += usage.prompt_tokens || 0;
    stats.completionTokens += usage.completion_tokens || 0;
  }

  // Add assistant response to history
  history.push({ role: 'assistant', content: fullResponse });

  // Determine intent
  const trimmedResponse = fullResponse.trimStart();
  if (trimmedResponse.startsWith('[DISPATCH]')) {
    const dispatchPrompt = trimmedResponse.slice('[DISPATCH]'.length).trim();
    return {
      intent: 'dispatch',
      response: fullResponse,
      dispatchPrompt,
    };
  }

  return {
    intent: 'chat',
    response: fullResponse,
  };
}
