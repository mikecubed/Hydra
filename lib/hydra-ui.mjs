/**
 * Hydra Terminal UI - Shared visual components for the Hydra orchestration system.
 *
 * Provides branded ASCII art, agent-colored output, spinners, box drawing,
 * and dashboard rendering. All functions are pure (no side effects except spinners).
 *
 * Dependency: picocolors (zero-dep, auto-strips ANSI in non-TTY)
 */

import pc from 'picocolors';

// ─── Agent Colors ───────────────────────────────────────────────────────────

export const AGENT_COLORS = {
  claude: pc.magenta,
  gemini: pc.cyan,
  codex: pc.green,
  human: pc.yellow,
  system: pc.blue,
};

export const AGENT_ICONS = {
  claude: '\u2666',   // ♦
  gemini: '\u2726',   // ✦
  codex: '\u25B6',    // ▶
  human: '\u25C6',    // ◆
  system: '\u2699',   // ⚙
};

// ─── Status Colors ──────────────────────────────────────────────────────────

const STATUS_COLORS = {
  todo: pc.white,
  in_progress: pc.yellow,
  blocked: pc.red,
  done: pc.green,
  cancelled: pc.gray,
};

const STATUS_ICONS = {
  todo: '\u25CB',        // ○
  in_progress: '\u25D4', // ◔
  blocked: '\u2717',     // ✗
  done: '\u2713',        // ✓
  cancelled: '\u2500',   // ─
};

// ─── Semantic Colors ────────────────────────────────────────────────────────

export const ACCENT = pc.magenta;
export const DIM = pc.gray;
export const HIGHLIGHT = pc.bold;
export const ERROR = pc.red;
export const SUCCESS = pc.green;
export const WARNING = pc.yellow;

// ─── ASCII Logo (100 columns) ───────────────────────────────────────────────
//
// Derived from your provided hydra image: cropped to content, resized to 100 cols,
// autocontrast + light blur + 5-level Floyd–Steinberg dithering using ░▒▓█.
//
const HYDRA_SPLASH_100 = [
  "                                           ▒▒░",
  "                                   ▒▒░    ░▒▓▒░     ░░░",
  "                                   ▒▓▓░░░░░▓██▒▒░░░░▒▓▒",
  "                                  ░░▓▓▓▓▓▓▓████▓█▓▓▓█▓▒▒░",
  "                                ░░░▓▓█▓█▓█▓██████▓██▓█▓▒░",
  "                                ░▒▒▓███▓▓▓█▓██▓██▓█▓▓▓█▓▒░",
  "                                ░▒▓███▓▓▒▓▓█▓█▓█▓█▓▒▓██▓▒",
  "                                 ░▓▓████▓▓▓▓█▓▓█▓▓▓▓▓▓█▓░",
  "                                ░▒▓█▓██▓███▓▓████▓████▓▓░",
  "                          ░░    ░▒▓▓█▓██▓████████▓█▓█▓█▓▒",
  "             ░░░       ░░▒▒▒░   ░░▒▓████▓█▓█▓▓█▓█▓█▓██▓▒░",
  "       ░▒░ ░░▓▓░░  ░ ░▒▓▓█▓░      ░▓▓█▓█▓██▓▓▓▓▓▓▓▓██▓▒░",
  "      ░▓▓░░░▓▓█░░ ░▒▓▓██▓▓░       ░██▓█▓▓▓▓▓▓█▓█▓▓▓▓▒░            ░░▒░░ ░      ░",
  "     ░▒█▓▓▒▓▓██▓▒▓▓█▓███▓░       ░░███▓▓█▓▓█▓█▓██▓▓▒░              ░░▓▓▒▒░░   ░░▒▒",
  "    ░░▓▓█▓████▓█▓████▓█▓▒░░ ░     ▒▓███▓▓▓▓▓█▓█▓▓▒▓▒                 ░▒█▓█▓▒▒ ░░▓▓▓░░",
  "   ░▒▓▓███▓█▓█▓█▓███████▓▓▒▓▒░░  ░▒█████▓▓█▒▓▓▓▓▓▓▓░                 ░░░▓██▓█▓▒░▒█▓▓▒",
  "   ░▓█▓█▓██▓█▓▓█▓██▓█████▓▓▒░     ▒██████▓▓▓▓▓▓▓▓▓▒                   ░░░▓███▓▓▓▓▓██▓▒░░░",
  "   ░▒▓▓▓█▓█▓▓▒▓██▓█▓██████▓▒░    ░▒███████▓█▓█▓▓▓▓░             ░ ░░▒▒▒▓▒▒▓█████▓█▓█▓▓▒▒▓▒░",
  "  ░▒▓▓██▓██▓▓▓▓█████▓███▓▓▓▓░░    ▒██████▓█▓█▓███▓░           ░░░░▒▓▓▓█▓██▓████████▓██▓▓█▓▒░ ░",
  "░▒▒▓██▓▓█▓██████▓█▓███████▓█▓░░  ░▒▓███████▓██▓█▓▒         ░░░░▒▓█▓█▓▓██▓█████▓███▓█▓███▓▓▓▓▓▒",
  "░▓███▓█████▓█▓▓█▓█▓█▓█▓▓▓█▓██▓▒░  ▒██████▓██████▓░       ░ ░▒▓▓▓▓███▓█▓████████▓██▓██▓▓▓████▓▓░",
  " ▓▓████▓█▓█▓███▓█▓█▓█▓█▓██████▓▒ ░░▓████▓█▓█▓▓██▓░      ░░▒▒▓▓▓▓████▓▓▓▓██████▓█▓███▓▓▒▒▓█▓█▓▓▒░",
  " ▒▓▒▓▒▒▓▓▓▓▓█▓█▓▓▓█▓█▓█▓███████▓░ ▒█████████████▓      ░░▒▓▓▓▓███████▓██▓████▓███████▓▓▓▓█▓███▓▒░░",
  "  ░░░ ░ ░▓█▓█▓█▓███▓▓▓███▓██████▒░░▓█████▓█▓█▓█▓▒░    ░▓▓▓▓███████████▓▓██▓████▓▓█▓███████▓█▓█▓▓█▓▒░",
  "        ░▒█▓▓█▓▓▓▓▓▒▓██▓████████▓▒░██████▓██▓███▒   ░░▒▓▓██████████████▓█▓█▓████▓█▓▓█▓▓▓█▓██████▓█▓░",
  "       ░░▒▓█▓▓▓▓█▒░ ▒▓▓█▓████████▓▒▓███████████▓▒  ░░▓▓███████████▓██▓██▓▓█▓█▓▓██▓▓█▓██▓▓▓▓▓▓█▓▓█▓▓░",
  "        ▒▓▓▓▓▓▒▓▓░   ░▓██▓█▓█████▓▒▓████▓█▓▓█▓██░░░▒▓██▓███████▓██▓█▓█▓▓▓▓▒▒▓▓█▓█▓▓██▓█▓▓░░▒▒▒▒▒▓▒░",
  "       ░▒▒▓▓▓▓▓▓░     ░▓▓█████████▒▓███████████▓▒░▒▓███████▓███▓██▓▓▓▒░░   ░ ▒▓▓██▓▓██▓▓▒      ░░░",
  "        ░▒▓▒▓▒▓░       ▒▓█████████▓▓████▓█▓▓█▓██░▒██████████▓███▓▓▒░░         ░▒▓▓▓▓▓▓█▓▓░░     ░",
  "         ░ ░ ░         ░▒█▓▓█▓█████▓▓██████████▓▓▓███████████▓▓▓▒░              ░▓▓▓▒▓▓▓▓▒░░",
  "                        ▒▓█████████▓▓███▓█▓█▓██▓▓███████▓█▓█▓▓▒░                 ░▒▓▓▒▓▓▓▒░",
  "                        ░▒██▓██████▓▓██████████▓▓█████████▓█▒░                    ░▓▓▓▓▓▓▒░",
  "                                                                                   ░▒▒▓▒▓▒",
].join("\n");

// ─── Truecolor Gradient Renderer (head zones + ink shading) ─────────────────

const ESC = "\x1b[";
const ansiReset = `${ESC}0m`;
const ansiFg = (r, g, b) => `${ESC}38;2;${r};${g};${b}m`;

const clamp01 = (t) => Math.max(0, Math.min(1, t));
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const lerpRgb = (c1, c2, t) => ([
  lerp(c1[0], c2[0], t),
  lerp(c1[1], c2[1], t),
  lerp(c1[2], c2[2], t),
]);

function hexToRgb(hex) {
  const h = String(hex).replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Multi-stop gradient interpolation for richer color bands
function lerpMultiStop(stops, t) {
  const cT = clamp01(t);
  if (stops.length <= 1) return stops[0].slice();
  const segments = stops.length - 1;
  const scaled = cT * segments;
  const idx = Math.min(Math.floor(scaled), segments - 1);
  const localT = scaled - idx;
  return lerpRgb(stops[idx], stops[idx + 1], localT);
}

// 4-stop head gradients for refined color transitions
// Left (Blue/Green) => Center (Green/Yellow) => Right (Orange/Red)
const HEAD_GRAD = {
  left:   [hexToRgb("#0060FF"), hexToRgb("#00CCFF"), hexToRgb("#00FFB0"), hexToRgb("#00FF55")],
  center: [hexToRgb("#22FF44"), hexToRgb("#77FF00"), hexToRgb("#BBEE00"), hexToRgb("#FFD400")],
  right:  [hexToRgb("#FF9500"), hexToRgb("#FF5500"), hexToRgb("#FF2D1A"), hexToRgb("#EE1111")],
};

// Head centers converge as y increases (necks merge toward body)
function headCentersAtY(ny) {
  const converge = clamp01(ny * 0.8) * 0.4;
  const mid = 50;
  return {
    left:   20 + (mid - 20) * converge,
    center: 52 + (mid - 52) * converge,
    right:  82 + (mid - 82) * converge,
  };
}

// Proximity-based blending weights (Gaussian falloff from each head center)
function headWeights(x, ny) {
  const centers = headCentersAtY(ny);
  const sigma = 12 + ny * 8; // tighter at top, wider blend at bottom
  const wL = Math.exp(-0.5 * ((x - centers.left) / sigma) ** 2);
  const wC = Math.exp(-0.5 * ((x - centers.center) / sigma) ** 2);
  const wR = Math.exp(-0.5 * ((x - centers.right) / sigma) ** 2);
  const total = wL + wC + wR;
  return [wL / total, wC / total, wR / total];
}

// Gradient direction per head (returns 0-1 parameter along the gradient)
function headGradT(hk, nx, ny) {
  if (hk === 'left') {
    // Blue->Green: diagonal flow, top-left to bottom-right
    return clamp01(nx * 0.55 + ny * 0.45);
  }
  if (hk === 'center') {
    // Green->Yellow: mostly vertical, top to bottom
    return clamp01(ny * 0.75 + nx * 0.25);
  }
  // Orange->Red: diagonal from top-right toward bottom-left
  return clamp01((1 - nx) * 0.45 + ny * 0.55);
}

// Ink model: makes faces/edges read better by using glyph density.
function charInk(ch) {
  switch (ch) {
    case "█": return 1.00;
    case "▓": return 0.78;
    case "▒": return 0.52;
    case "░": return 0.30;
    default:  return 0.55;
  }
}

function mulRgb(rgb, k) {
  return [
    Math.max(0, Math.min(255, Math.round(rgb[0] * k))),
    Math.max(0, Math.min(255, Math.round(rgb[1] * k))),
    Math.max(0, Math.min(255, Math.round(rgb[2] * k))),
  ];
}

function colorHydraSplashTruecolor() {
  const isTTY = process.stdout?.isTTY;
  const canColor = Boolean(pc.isColorSupported);
  if (!isTTY || !canColor) return HYDRA_SPLASH_100;

  const lines = HYDRA_SPLASH_100.split("\n");
  const totalH = lines.length;
  const totalW = Math.max(...lines.map(l => l.length), 100);

  return lines.map((line, y) => {
    let out = "";
    const ny = clamp01(y / (totalH - 1));

    for (let x = 0; x < line.length; x++) {
      const ch = line[x];
      if (ch === " ") { out += " "; continue; }

      const nx = clamp01(x / (totalW - 1));

      // Compute gradient color for each head at this position
      const rgbL = lerpMultiStop(HEAD_GRAD.left, headGradT('left', nx, ny));
      const rgbC = lerpMultiStop(HEAD_GRAD.center, headGradT('center', nx, ny));
      const rgbR = lerpMultiStop(HEAD_GRAD.right, headGradT('right', nx, ny));

      // Blend heads based on horizontal proximity (converging with depth)
      const [wL, wC, wR] = headWeights(x, ny);
      let rgb = [
        Math.round(rgbL[0] * wL + rgbC[0] * wC + rgbR[0] * wR),
        Math.round(rgbL[1] * wL + rgbC[1] * wC + rgbR[1] * wR),
        Math.round(rgbL[2] * wL + rgbC[2] * wC + rgbR[2] * wR),
      ];

      // Ink shading: denser glyphs get brighter
      const ink = charInk(ch);
      const shade = 0.70 + ink * 0.55;
      rgb = mulRgb(rgb, shade);

      // Subtle vignette: edges slightly dimmer
      const edgeX = Math.min(nx, 1 - nx);
      const edgeY = Math.min(ny, 1 - ny);
      const edge = Math.min(edgeX, edgeY);
      const vignette = 0.88 + clamp01(edge / 0.4) * 0.18;
      rgb = mulRgb(rgb, vignette);

      // Neck desaturation: lower portions slightly more muted
      const neckDim = ny > 0.55 ? 1.0 - (ny - 0.55) * 0.35 : 1.0;
      rgb = mulRgb(rgb, neckDim);

      out += ansiFg(rgb[0], rgb[1], rgb[2]) + ch + ansiReset;
    }

    return out;
  }).join("\n");
}

// ─── Splash + Compact ───────────────────────────────────────────────────────

export function hydraSplash() {
  return [
    "",
    colorHydraSplashTruecolor(),
    "",
    `  ${pc.bold(pc.white("H Y D R A"))}  ${pc.gray("Multi-Agent Orchestrator")}`,
    "",
  ].join("\n");
}

export function hydraLogoCompact() {
  return `${pc.bold(ACCENT("HYDRA"))} ${DIM("|")} ${DIM("Multi-Agent Orchestrator")}`;
}

// ─── Agent Formatting ───────────────────────────────────────────────────────

export function colorAgent(name) {
  const lower = String(name || "").toLowerCase();
  const colorFn = AGENT_COLORS[lower] || pc.white;
  return colorFn(name);
}

export function agentBadge(name) {
  const lower = String(name || "").toLowerCase();
  const icon = AGENT_ICONS[lower] || "\u2022"; // •
  const colorFn = AGENT_COLORS[lower] || pc.white;
  return colorFn(`${icon} ${String(name).toUpperCase()}`);
}

// ─── Status Formatting ─────────────────────────────────────────────────────

export function colorStatus(status) {
  const lower = String(status || '').toLowerCase();
  const colorFn = STATUS_COLORS[lower] || pc.white;
  const icon = STATUS_ICONS[lower] || '\u2022';
  return colorFn(`${icon} ${status}`);
}

// ─── Task Formatting ────────────────────────────────────────────────────────

export function formatTaskLine(task) {
  if (!task) return '';
  const id = pc.bold(pc.white(task.id || '???'));
  const status = colorStatus(task.status || 'todo');
  const owner = colorAgent(task.owner || 'unassigned');
  const title = DIM(String(task.title || '').slice(0, 60));
  return `  ${id} ${status}  ${owner}  ${title}`;
}

export function formatHandoffLine(handoff) {
  if (!handoff) return '';
  const id = pc.bold(pc.white(handoff.id || '???'));
  const from = colorAgent(handoff.from || '?');
  const to = colorAgent(handoff.to || '?');
  const arrow = DIM('\u2192'); // →
  const ack = handoff.acknowledgedAt
      ? SUCCESS('\u2713 ack')
      : WARNING('pending');
  const summary = DIM(String(handoff.summary || '').slice(0, 50));
  return `  ${id} ${from} ${arrow} ${to}  ${ack}  ${summary}`;
}

// ─── Time Formatting ────────────────────────────────────────────────────────

export function relativeTime(iso) {
  if (!iso) return DIM('never');
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return DIM('future');
  const secs = Math.floor(diff / 1000);
  if (secs < 10) return DIM('just now');
  if (secs < 60) return DIM(`${secs}s ago`);
  const mins = Math.floor(secs / 60);
  if (mins < 60) return DIM(`${mins}m ago`);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return DIM(`${hours}h ago`);
  const days = Math.floor(hours / 24);
  return DIM(`${days}d ago`);
}

// ─── Layout Helpers ─────────────────────────────────────────────────────────

export function box(title, lines, width = 60) {
  const inner = Math.max(width - 2, 10);
  const titleStr = title ? ` ${title} ` : '';
  const topPad = inner - titleStr.length - 1;
  const top = `\u250C${titleStr}${'─'.repeat(Math.max(topPad, 0))}\u2510`;
  const bot = `\u2514${'─'.repeat(inner)}\u2518`;
  const body = (lines || []).map((line) => {
    const stripped = stripAnsi(line);
    const pad = Math.max(inner - stripped.length, 0);
    return `\u2502${line}${' '.repeat(pad)}\u2502`;
  });
  return [top, ...body, bot].join('\n');
}

export function sectionHeader(title) {
  const bar = '─'.repeat(Math.max(50 - title.length, 4));
  return `\n${DIM('───')} ${HIGHLIGHT(title)} ${DIM(bar)}`;
}

export function divider() {
  return DIM('─'.repeat(56));
}

export function label(key, value) {
  const k = DIM(`${key}:`);
  return `  ${k} ${value}`;
}

// ─── Spinner ────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = [
  '\u2801', '\u2803', '\u2807', '\u280F',
  '\u281F', '\u283F', '\u287F', '\u28FF',
  '\u28FE', '\u28FC', '\u28F8', '\u28F0',
  '\u28E0', '\u28C0', '\u2880', '\u2800'
];

export function createSpinner(message) {
  const isTTY = process.stderr?.isTTY;
  let frameIdx = 0;
  let interval = null;
  let currentMsg = message;

  function render() {
    if (!isTTY) return;
    const frame = ACCENT(SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length]);
    process.stderr.write(`\r${frame} ${currentMsg}`);
    frameIdx++;
  }

  function clearLine() {
    if (!isTTY) return;
    process.stderr.write('\r' + ' '.repeat(currentMsg.length + 4) + '\r');
  }

  return {
    start() {
      if (!isTTY) {
        process.stderr.write(`  ${DIM('\u2026')} ${currentMsg}\n`);
        return this;
      }
      interval = setInterval(render, 80);
      render();
      return this;
    },
    update(msg) {
      currentMsg = msg;
      return this;
    },
    succeed(msg) {
      clearLine();
      if (interval) clearInterval(interval);
      interval = null;
      process.stderr.write(`  ${SUCCESS('\u2713')} ${msg || currentMsg}\n`);
      return this;
    },
    fail(msg) {
      clearLine();
      if (interval) clearInterval(interval);
      interval = null;
      process.stderr.write(`  ${ERROR('\u2717')} ${msg || currentMsg}\n`);
      return this;
    },
    stop() {
      clearLine();
      if (interval) clearInterval(interval);
      interval = null;
      return this;
    },
  };
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

export function renderDashboard(summary, agentNextMap, extras = {}) {
  const lines = [];
  lines.push(hydraLogoCompact());
  lines.push(divider());

  // Session
  const session = summary?.activeSession;
  if (session) {
    lines.push(sectionHeader('Session'));
    lines.push(label('Focus', pc.white(session.focus || 'not set')));
    lines.push(label('Branch', pc.white(session.branch || '?')));
    lines.push(label('Status', colorStatus(session.status || 'active')));
    lines.push(label('Updated', relativeTime(summary.updatedAt)));
  }

  // Counts
  const counts = summary?.counts || {};
  lines.push(sectionHeader('Overview'));
  lines.push(label('Open tasks', counts.tasksOpen ?? '?'));
  lines.push(label('Open blockers', counts.blockersOpen > 0 ? ERROR(String(counts.blockersOpen)) : SUCCESS('0')));
  lines.push(label('Decisions', String(counts.decisions ?? '?')));
  lines.push(label('Handoffs', String(counts.handoffs ?? '?')));
  if (extras.usage && extras.usage.level !== 'unknown') {
    lines.push(label('Token usage', progressBar(extras.usage.percent || 0, 20)));
  }

  // Agent Status
  if (agentNextMap && Object.keys(agentNextMap).length > 0) {
    lines.push(sectionHeader('Agents'));
    for (const [agent, next] of Object.entries(agentNextMap)) {
      const action = next?.action || 'unknown';
      let desc = action;
      if (action === 'continue_task') {
        desc = `working on ${pc.bold(next.task?.id || '?')}`;
      } else if (action === 'pickup_handoff') {
        desc = WARNING(`handoff ${next.handoff?.id || '?'} waiting`);
      } else if (action === 'claim_owned_task' || action === 'claim_unassigned_task') {
        desc = `can claim ${pc.bold(next.task?.id || '?')}`;
      } else if (action === 'idle') {
        desc = DIM('idle');
      } else if (action === 'resolve_blocker') {
        desc = ERROR(`blocked on ${next.task?.id || '?'}`);
      }
      const modelLabel = extras.models?.[agent]
          ? DIM(` [${extras.models[agent]}]`)
          : '';
      lines.push(`  ${agentBadge(agent)}  ${desc}${modelLabel}`);
    }
  }

  // Open Tasks
  const tasks = summary?.openTasks || [];
  if (tasks.length > 0) {
    lines.push(sectionHeader('Open Tasks'));
    for (const task of tasks.slice(0, 10)) {
      lines.push(formatTaskLine(task));
    }
    if (tasks.length > 10) {
      lines.push(DIM(`  ... and ${tasks.length - 10} more`));
    }
  }

  // Open Blockers
  const blockers = summary?.openBlockers || [];
  if (blockers.length > 0) {
    lines.push(sectionHeader('Blockers'));
    for (const b of blockers) {
      lines.push(`  ${ERROR('\u2717')} ${pc.bold(b.id)} ${colorAgent(b.owner)} ${DIM(String(b.title || '').slice(0, 50))}`);
    }
  }

  // Latest Handoff
  const handoff = summary?.latestHandoff;
  if (handoff) {
    lines.push(sectionHeader('Latest Handoff'));
    lines.push(formatHandoffLine(handoff));
  }

  lines.push('');
  return lines.join('\n');
}

// ─── Stats Dashboard ────────────────────────────────────────────────────────

/**
 * Render a color-coded ASCII progress bar.
 * @param {number} percent - 0-100
 * @param {number} [width=30] - Bar width in characters
 */
export function progressBar(percent, width = 30) {
  const clamped = Math.max(0, Math.min(100, percent || 0));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;

  let colorFn = pc.green;
  if (clamped >= 90) colorFn = pc.red;
  else if (clamped >= 80) colorFn = pc.yellow;

  return colorFn('\u2588'.repeat(filled)) + pc.gray('\u2591'.repeat(empty)) + ' ' + colorFn(`${clamped.toFixed(1)}%`);
}

function fmtTokens(n) {
  if (!n || n === 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDuration(ms) {
  if (!ms || ms === 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  const secs = (ms / 1000).toFixed(1);
  if (ms < 60000) return `${secs}s`;
  const mins = Math.floor(ms / 60000);
  const remSecs = Math.round((ms % 60000) / 1000);
  return `${mins}m${remSecs}s`;
}

function fmtReset(ms) {
  if (ms === null || ms === undefined) return '-';
  const clamped = Math.max(0, Number(ms) || 0);
  const totalMinutes = Math.floor(clamped / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

/**
 * Render a full stats dashboard combining metrics and usage data.
 * @param {object} metrics - From getMetricsSummary()
 * @param {object} usage - From checkUsage()
 */
export function renderStatsDashboard(metrics, usage) {
  const lines = [];
  lines.push('');
  lines.push(hydraLogoCompact());
  lines.push(DIM('\u2500'.repeat(56)));

  // Usage bar
  if (usage) {
    lines.push(sectionHeader('Token Usage'));
    lines.push(`  ${progressBar(usage.percent || 0)}`);
    const statusColors = { normal: pc.green, warning: pc.yellow, critical: pc.red, unknown: pc.gray };
    const statusFn = statusColors[usage.level] || pc.white;
    lines.push(label('Status', statusFn(String(usage.level || 'unknown').toUpperCase())));
    if (usage.todayTokens) {
      lines.push(label('Today', pc.white(fmtTokens(usage.todayTokens))));
    }
    if (usage.message) {
      lines.push(label('Note', DIM(usage.message)));
    }
    if (usage.agents && Object.keys(usage.agents).length > 0) {
      lines.push('');
      lines.push(`  ${pc.bold('Per-Agent:')}`);
      for (const agent of ['claude', 'gemini', 'codex']) {
        const row = usage.agents[agent];
        if (!row) continue;
        const colorFn = AGENT_COLORS[agent] || pc.white;
        const icon = AGENT_ICONS[agent] || '\u2022';
        const badge = colorFn(`${icon} ${agent.toUpperCase()}`);
        const rowStatusColors = { normal: pc.green, warning: pc.yellow, critical: pc.red, unknown: pc.gray };
        const rowStatusFn = rowStatusColors[row.level] || pc.white;
        const status = rowStatusFn(String(row.level || 'unknown').toUpperCase());
        if (row.budget) {
          lines.push(
              `    ${badge} ${status} ${pc.white(`${(row.percent || 0).toFixed(1)}%`)}  `
              + `${DIM('used')} ${pc.white(fmtTokens(row.used || 0))}/${pc.white(fmtTokens(row.budget || 0))}  `
              + `${DIM('left')} ${pc.white(fmtTokens(row.remaining || 0))}  `
              + `${DIM('reset')} ${pc.white(fmtReset(row.resetInMs))}`
          );
        } else {
          lines.push(
              `    ${badge} ${status} ${DIM('used')} ${pc.white(fmtTokens(row.todayTokens || 0))}  `
              + `${DIM('budget')} ${pc.white('n/a')}  ${DIM('source')} ${pc.white(row.source || 'none')}`
          );
        }
      }
    }
  }

  if (!metrics || !metrics.agents || Object.keys(metrics.agents).length === 0) {
    lines.push('');
    lines.push(`  ${DIM('No agent calls recorded yet.')}`);
    lines.push('');
    return lines.join('\n');
  }

  // Per-agent table
  lines.push(sectionHeader('Agent Performance'));
  const header = `  ${'Agent'.padEnd(10)} ${'Calls'.padStart(6)} ${'Est.Tokens'.padStart(11)} ${'Avg Time'.padStart(9)} ${'Success'.padStart(8)} ${'Model'.padStart(12)}`;
  lines.push(DIM(header));
  lines.push(DIM('  ' + '\u2500'.repeat(58)));

  for (const [agent, data] of Object.entries(metrics.agents)) {
    const colorFn = AGENT_COLORS[agent] || pc.white;
    const icon = AGENT_ICONS[agent] || '\u2022';
    const agentLabel = colorFn(`${icon} ${agent.padEnd(8)}`);
    const calls = pc.white(String(data.callsToday || 0).padStart(6));
    const tokens = pc.white(fmtTokens(data.estimatedTokensToday || 0).padStart(11));
    const avgTime = pc.white(fmtDuration(data.avgDurationMs || 0).padStart(9));
    const rate = data.successRate !== undefined
        ? (data.successRate >= 100 ? pc.green : data.successRate >= 80 ? pc.yellow : pc.red)(`${data.successRate}%`.padStart(8))
        : DIM('   -'.padStart(8));
    const model = DIM((data.lastModel || '-').replace(/^claude-/, '').replace(/^gemini-/, '').slice(0, 12).padStart(12));
    lines.push(`  ${agentLabel} ${calls} ${tokens} ${avgTime} ${rate} ${model}`);
  }

  // Session totals
  lines.push(sectionHeader('Session Totals'));
  lines.push(label('Total calls', pc.white(String(metrics.totalCalls || 0))));
  lines.push(label('Est. tokens', pc.white(fmtTokens(metrics.totalTokens || 0))));
  lines.push(label('Total time', pc.white(fmtDuration(metrics.totalDurationMs || 0))));
  lines.push(label('Uptime', pc.white(fmtDuration((metrics.uptimeSec || 0) * 1000))));

  lines.push('');
  return lines.join('\n');
}

// ─── Agent Header ───────────────────────────────────────────────────────────

export function agentHeader(name) {
  const lower = String(name || '').toLowerCase();
  const colorFn = AGENT_COLORS[lower] || pc.white;
  const agentConfig = {
    claude: { tagline: 'Architect \u00B7 Planner \u00B7 Coordinator', icon: '\u2666' },
    gemini: { tagline: 'Analyst \u00B7 Critic \u00B7 Reviewer', icon: '\u2726' },
    codex: { tagline: 'Implementer \u00B7 Builder \u00B7 Executor', icon: '\u25B6' },
  };
  const cfg = agentConfig[lower] || { tagline: 'Agent', icon: '\u2022' };
  const lines = [
    '',
    colorFn(`  ${cfg.icon} ${String(name).toUpperCase()}`),
    DIM(`  ${cfg.tagline}`),
    colorFn('─'.repeat(42)),
    '',
  ];
  return lines.join('\n');
}

// ─── Utility: Strip ANSI ────────────────────────────────────────────────────

export function stripAnsi(str) {
  // Removes CSI sequences like \x1b[...m (including 38;2;r;g;b)
  // eslint-disable-next-line no-control-regex
  return String(str || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

// ─── Health Icons (for status bar) ──────────────────────────────────────────

export const HEALTH_ICONS = {
  idle:     pc.green('\u25CF'),    // ● green
  working:  pc.yellow('\u25CF'),   // ● yellow
  error:    pc.red('\u25CF'),      // ● red
  inactive: pc.gray('\u25CF'),     // ● gray
};

/**
 * Format elapsed milliseconds as a compact human-readable string.
 * @param {number} ms - Elapsed time in milliseconds
 * @returns {string} e.g. "2m 15s", "45s", "1h 3m"
 */
export function formatElapsed(ms) {
  if (!ms || ms < 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

export function formatAgentStatus(agent, status, action, maxWidth) {
  const lower = String(agent || '').toLowerCase();
  const icon = AGENT_ICONS[lower] || '\u2022';
  const colorFn = AGENT_COLORS[lower] || pc.white;
  const healthIcon = HEALTH_ICONS[status] || HEALTH_ICONS.inactive;
  const name = String(agent).toUpperCase();
  const actionText = String(action || status || 'Inactive');

  const raw = `${name}: ${actionText}`;
  const truncated = maxWidth && raw.length > maxWidth
    ? raw.slice(0, maxWidth - 1) + '\u2026'
    : raw;

  return `${healthIcon} ${colorFn(icon)} ${colorFn(truncated)}`;
}
