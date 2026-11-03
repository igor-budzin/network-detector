import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

type Status = "unknown" | "online" | "offline";

interface State {
  status: Status;
  lastSeenAt: string | null;
  iphoneHome: boolean;
  subscribers: number[];
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

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_ATTEMPTS = 3;
const TELEGRAM_RETRY_DELAY_MS = 5000;
const TELEGRAM_POLL_SECONDS = 30;

function loadState(): State {
  const defaults: State = { status: "unknown", lastSeenAt: null, iphoneHome: false, subscribers: [] };
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

async function sendToChat(chatId: number, text: string): Promise<void> {
  for (let attempt = 1; attempt <= TELEGRAM_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(10_000),
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
  console.error(`Giving up on Telegram message to ${chatId}: ${text}`);
}

// Messages go out one at a time, so "down" can't arrive after "back" during retries.
let telegramQueue = Promise.resolve();

function enqueue(task: () => Promise<void>): void {
  telegramQueue = telegramQueue.then(task);
}

function notify(text: string): void {
  // The ESP32 can't report during an outage, so this is the status from its last heartbeat.
  if (state.iphoneHome) {
    console.log(`${text} (not sent: iPhone is home)`);
    return;
  }
  console.log(`${text} (subscribers: ${state.subscribers.length})`);
  enqueue(async () => {
    for (const chatId of [...state.subscribers]) {
      await sendToChat(chatId, text);
    }
  });
}

function handleStart(chatId: number): void {
  if (ALLOWED_CHAT_IDS.length > 0 && !ALLOWED_CHAT_IDS.includes(chatId)) {
    console.log(`Ignored /start from chat ${chatId}: not in ALLOWED_CHAT_IDS`);
    return;
  }
  if (!state.subscribers.includes(chatId)) {
    state.subscribers.push(chatId);
    saveState();
    console.log(`New subscriber ${chatId}`);
  }
  enqueue(() =>
    sendToChat(chatId, `You will get a message when the home internet goes down or comes back. Current status: ${state.status}`),
  );
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
        if (update.message?.text?.startsWith("/start")) handleStart(update.message.chat.id);
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
  const hours = Math.floor(totalMinutes / 60);
  return hours > 0 ? `${hours}h ${totalMinutes % 60}m` : `${totalMinutes}m`;
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
  saveState();
  notify(`🔴 No internet at home: no request from the ESP32 for ${OFFLINE_TIMEOUT_MS / 1000}s`);
}

function handleHeartbeat(iphoneHome: boolean): void {
  const wasOffline = state.status === "offline";
  const previousSeenAt = state.lastSeenAt;

  state.status = "online";
  state.lastSeenAt = new Date().toISOString();
  state.iphoneHome = iphoneHome;
  saveState();
  armOfflineTimer();

  if (wasOffline) {
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
