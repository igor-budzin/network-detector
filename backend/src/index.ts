import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { renderStatsImage } from "./charts.ts";

type Status = "unknown" | "online" | "offline";

interface Outage {
  start: string;
  // null while the outage is still ongoing.
  end: string | null;
}

interface State {
  status: Status;
  lastSeenAt: string | null;
  iphoneHome: boolean;
  subscribers: number[];
  // Time of the first heartbeat ever received. Stats don't count anything before it.
  monitoringSince: string | null;
  // Oldest first. Online ranges are the gaps between outages.
  outages: Outage[];
}

interface TelegramUpdate {
  update_id: number;
  message?: { text?: string; chat: { id: number } };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const TELEGRAM_BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");
const DEVICE_TOKEN = requireEnv("DEVICE_TOKEN");
const PORT = Number(process.env.PORT ?? 3000);
const STATE_FILE = process.env.STATE_FILE ?? "status.json";
const OFFLINE_TIMEOUT_MS = Number(process.env.OFFLINE_TIMEOUT_SECONDS ?? 30) * 1000;
// Empty means anyone can subscribe.
const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS ?? "").split(",").filter(Boolean).map(Number);
// Times in messages are always shown in Ukrainian time, whatever time zone the server runs in.
const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Kyiv",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_ATTEMPTS = 3;
const TELEGRAM_RETRY_DELAY_MS = 5000;
const TELEGRAM_POLL_SECONDS = 30;
const TELEGRAM_CAPTION_LIMIT = 1024;
const STATUS_BUTTON = "📊 Status";
const STATS_BUTTON = "📈 Stats";
const STATUS_KEYBOARD = {
  keyboard: [[{ text: STATUS_BUTTON }, { text: STATS_BUTTON }]],
  resize_keyboard: true,
  is_persistent: true,
};
const DAY_MS = 24 * 60 * 60 * 1000;
// Outages older than this are deleted so the state file doesn't grow forever.
const OUTAGE_RETENTION_MS = 90 * DAY_MS;
const STATS_WINDOWS = [
  { label: "24h", ms: DAY_MS },
  { label: "7 days", ms: 7 * DAY_MS },
  { label: "30 days", ms: 30 * DAY_MS },
];
const RECENT_OUTAGES_SHOWN = 5;

function loadState(): State {
  const defaults: State = {
    status: "unknown",
    lastSeenAt: null,
    iphoneHome: false,
    subscribers: [],
    monitoringSince: null,
    outages: [],
  };
  try {
    return { ...defaults, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) };
  } catch {
    return defaults;
  }
}

function saveState(): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendToChat(chatId: number, text: string, replyMarkup?: object): Promise<void> {
  await callTelegram(chatId, "sendMessage", JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup }), text);
}

async function sendPhotoToChat(chatId: number, png: Buffer, caption: string, replyMarkup?: object): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", new Blob([new Uint8Array(png)],{ type: "image/png" }), "stats.png");
  form.append("caption", caption);
  if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
  await callTelegram(chatId, "sendPhoto", form, `photo: ${caption}`);
}

// A string body is sent as JSON, FormData as multipart.
async function callTelegram(chatId: number, method: string, body: string | FormData, description: string): Promise<void> {
  for (let attempt = 1; attempt <= TELEGRAM_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`${TELEGRAM_API}/${method}`, {
        method: "POST",
        headers: typeof body === "string" ? { "Content-Type": "application/json" } : undefined,
        body,
        signal: AbortSignal.timeout(method === "sendPhoto" ? 30_000 : 10_000),
      });
      if (response.ok) return;
      if (response.status === 403) {
        // The person blocked the bot, so retrying or messaging them again is pointless.
        state.subscribers = state.subscribers.filter((id) => id !== chatId);
        saveState();
        console.log(`Removed subscriber ${chatId}: bot was blocked`);
        return;
      }
      console.error(`Telegram responded ${response.status}: ${await response.text()}`);
    } catch (error) {
      console.error(`Telegram request failed: ${(error as Error).message}`);
    }
    if (attempt < TELEGRAM_ATTEMPTS) await sleep(TELEGRAM_RETRY_DELAY_MS);
  }
  console.error(`Giving up on Telegram message to ${chatId}: ${description}`);
}

// Messages go out one at a time, so "down" can't arrive after "back" during retries.
let telegramQueue = Promise.resolve();

function enqueue(task: () => Promise<void>): void {
  telegramQueue = telegramQueue.then(task);
}

function notify(text: string): void {
  console.log(`${text} (subscribers: ${state.subscribers.length})`);
  enqueue(async () => {
    for (const chatId of [...state.subscribers]) {
      await sendToChat(chatId, text);
    }
  });
}

function isChatAllowed(chatId: number): boolean {
  return ALLOWED_CHAT_IDS.length === 0 || ALLOWED_CHAT_IDS.includes(chatId);
}

function handleStart(chatId: number): void {
  if (!isChatAllowed(chatId)) {
    console.log(`Ignored /start from chat ${chatId}: not in ALLOWED_CHAT_IDS`);
    return;
  }
  if (!state.subscribers.includes(chatId)) {
    state.subscribers.push(chatId);
    saveState();
    console.log(`New subscriber ${chatId}`);
  }
  enqueue(() =>
    sendToChat(
      chatId,
      `You will get a message when the home internet goes down or comes back. Current status: ${state.status}`,
      STATUS_KEYBOARD,
    ),
  );
}

function formatStatus(): string {
  const lastSeen = state.lastSeenAt
    ? `Last heartbeat: ${formatDuration(Date.now() - Date.parse(state.lastSeenAt))} ago`
    : "No heartbeat received yet";
  if (state.status === "online") {
    return `🟢 Internet is up at home\n${lastSeen}\niPhone: ${state.iphoneHome ? "home" : "away"}`;
  }
  // The iPhone status is left out when offline: the ESP32 can't report it, so it would be stale.
  if (state.status === "offline") return `🔴 No internet at home\n${lastSeen}`;
  return `⚪ Status unknown: waiting for the ESP32\n${lastSeen}`;
}

function handleStatus(chatId: number): void {
  if (!isChatAllowed(chatId)) {
    console.log(`Ignored status request from chat ${chatId}: not in ALLOWED_CHAT_IDS`);
    return;
  }
  enqueue(() => sendToChat(chatId, formatStatus(), STATUS_KEYBOARD));
}

function outageEndMs(outage: Outage, now: number): number {
  return outage.end ? Date.parse(outage.end) : now;
}

function formatStats(): string {
  if (!state.monitoringSince) return "No stats yet: waiting for the first heartbeat from the ESP32";
  const now = Date.now();
  const monitoringSince = Date.parse(state.monitoringSince);
  const lines = [`📈 Stats (monitoring since ${DATE_FORMAT.format(monitoringSince)})`, ""];

  for (const window of STATS_WINDOWS) {
    const from = Math.max(now - window.ms, monitoringSince);
    let downMs = 0;
    let count = 0;
    let longestMs = 0;
    for (const outage of state.outages) {
      // Clipped to the window, so an outage that started before it only counts the part inside.
      const overlap = Math.min(outageEndMs(outage, now), now) - Math.max(Date.parse(outage.start), from);
      if (overlap <= 0) continue;
      downMs += overlap;
      count++;
      longestMs = Math.max(longestMs, overlap);
    }
    const uptime = now > from ? (100 * (now - from - downMs)) / (now - from) : 100;
    const partial = from > now - window.ms ? ` (only ${formatDuration(now - from)} of data)` : "";
    lines.push(`${window.label}${partial}: ${uptime.toFixed(2)}% up`);
    lines.push(
      count === 0
        ? "   no outages"
        : `   ${count} outage${count === 1 ? "" : "s"}, ${formatDuration(downMs)} down, longest ${formatDuration(longestMs)}`,
    );
  }

  const lastOutage = state.outages.at(-1);
  if (state.status === "online") {
    const onlineSince = lastOutage?.end ? Date.parse(lastOutage.end) : monitoringSince;
    lines.push("", `🟢 Online for ${formatDuration(now - onlineSince)} (since ${DATE_FORMAT.format(onlineSince)})`);
  } else if (state.status === "offline" && lastOutage && !lastOutage.end) {
    const start = Date.parse(lastOutage.start);
    lines.push("", `🔴 Offline for ${formatDuration(now - start)} (since ${DATE_FORMAT.format(start)})`);
  }

  const recent = state.outages.slice(-RECENT_OUTAGES_SHOWN).reverse();
  if (recent.length > 0) {
    lines.push("", "Recent outages:");
    for (const outage of recent) {
      const start = Date.parse(outage.start);
      const end = outage.end ? DATE_FORMAT.format(Date.parse(outage.end)) : "now";
      lines.push(`🔴 ${DATE_FORMAT.format(start)} → ${end} (${formatDuration(outageEndMs(outage, now) - start)})`);
    }
  }
  return lines.join("\n");
}

function handleStats(chatId: number): void {
  if (!isChatAllowed(chatId)) {
    console.log(`Ignored stats request from chat ${chatId}: not in ALLOWED_CHAT_IDS`);
    return;
  }
  enqueue(async () => {
    const text = formatStats();
    const png = await renderStatsChart();
    if (!png) {
      await sendToChat(chatId, text, STATUS_KEYBOARD);
    } else if (text.length <= TELEGRAM_CAPTION_LIMIT) {
      await sendPhotoToChat(chatId, png, text, STATUS_KEYBOARD);
    } else {
      await sendPhotoToChat(chatId, png, "📈 Stats");
      await sendToChat(chatId, text, STATUS_KEYBOARD);
    }
  });
}

// Null when there is nothing to chart yet or rendering failed: the text stats are sent alone then.
async function renderStatsChart(): Promise<Buffer | null> {
  if (!state.monitoringSince) return null;
  const now = Date.now();
  try {
    return await renderStatsImage({
      now,
      monitoringSince: Date.parse(state.monitoringSince),
      outages: state.outages.map((outage) => ({ start: Date.parse(outage.start), end: outageEndMs(outage, now) })),
    });
  } catch (error) {
    console.error(`Stats chart rendering failed: ${(error as Error).message}`);
    return null;
  }
}

async function pollTelegramUpdates(): Promise<void> {
  let offset = 0;
  while (true) {
    try {
      const response = await fetch(`${TELEGRAM_API}/getUpdates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offset, timeout: TELEGRAM_POLL_SECONDS, allowed_updates: ["message"] }),
        signal: AbortSignal.timeout((TELEGRAM_POLL_SECONDS + 10) * 1000),
      });
      if (!response.ok) {
        console.error(`Telegram getUpdates responded ${response.status}: ${await response.text()}`);
        await sleep(TELEGRAM_RETRY_DELAY_MS);
        continue;
      }
      const { result } = (await response.json()) as { result: TelegramUpdate[] };
      for (const update of result) {
        offset = update.update_id + 1;
        const text = update.message?.text;
        if (!update.message || !text) continue;
        if (text.startsWith("/start")) handleStart(update.message.chat.id);
        else if (text === STATUS_BUTTON || text.startsWith("/status")) handleStatus(update.message.chat.id);
        else if (text === STATS_BUTTON || text.startsWith("/stats")) handleStats(update.message.chat.id);
      }
    } catch (error) {
      console.error(`Telegram getUpdates failed: ${(error as Error).message}`);
      await sleep(TELEGRAM_RETRY_DELAY_MS);
    }
  }
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.floor(ms / 1000)}s`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours >= 24) return `${Math.floor(totalHours / 24)}d ${totalHours % 24}h`;
  return totalHours > 0 ? `${totalHours}h ${totalMinutes % 60}m` : `${totalMinutes}m`;
}

const state = loadState();
let offlineTimer: NodeJS.Timeout;

function armOfflineTimer(): void {
  clearTimeout(offlineTimer);
  offlineTimer = setTimeout(markOffline, OFFLINE_TIMEOUT_MS);
}

function markOffline(): void {
  if (state.status === "offline") return;
  state.status = "offline";
  // The outage started after the last heartbeat, not when the timeout fired.
  // Nothing is recorded before the first heartbeat, since there is no known online period to compare with.
  if (state.lastSeenAt) state.outages.push({ start: state.lastSeenAt, end: null });
  saveState();
  notify(`🔴 No internet at home: no request from the ESP32 for ${OFFLINE_TIMEOUT_MS / 1000}s`);
}

function handleHeartbeat(iphoneHome: boolean): void {
  const wasOffline = state.status === "offline";
  const previousSeenAt = state.lastSeenAt;

  const now = new Date().toISOString();
  state.status = "online";
  state.lastSeenAt = now;
  state.iphoneHome = iphoneHome;
  state.monitoringSince ??= now;
  const lastOutage = state.outages.at(-1);
  if (lastOutage && !lastOutage.end) lastOutage.end = now;
  const cutoff = Date.now() - OUTAGE_RETENTION_MS;
  state.outages = state.outages.filter((outage) => !outage.end || Date.parse(outage.end) >= cutoff);
  saveState();
  armOfflineTimer();

  // The iPhone status is only reliable here: the ESP32 can't report it while the internet is down.
  if (wasOffline && iphoneHome) {
    console.log("Internet is back at home (not sent: iPhone is home)");
  } else if (wasOffline) {
    const downtime = previousSeenAt
      ? ` (last seen ${formatDuration(Date.now() - Date.parse(previousSeenAt))} ago)`
      : "";
    notify(`🟢 Internet is back at home${downtime}`);
  }
}

const server = createServer((req, res) => {
  const route = `${req.method} ${req.url}`;
  if (route !== "POST /heartbeat" && route !== "GET /status") {
    res.writeHead(404).end();
    return;
  }
  if (req.headers["x-device-token"] !== DEVICE_TOKEN) {
    res.writeHead(401).end();
    return;
  }

  if (route === "POST /heartbeat") {
    handleHeartbeat(req.headers["x-iphone-home"] === "1");
    res.writeHead(204).end();
    return;
  }
  res
    .writeHead(200, { "Content-Type": "application/json" })
    .end(JSON.stringify({ status: state.status, lastSeenAt: state.lastSeenAt, iphoneHome: state.iphoneHome }));
});

// Armed at startup too, so an outage that spans a server restart is still detected.
armOfflineTimer();
void pollTelegramUpdates();

server.listen(PORT, () => {
  console.log(`Listening on port ${PORT}, current status: ${state.status}`);
});
