# Network Detector

Monitors a home internet connection and sends Telegram notifications when it goes down and when it is restored.

An ESP32 sends a heartbeat to a remote server every 10 seconds. If no heartbeat is received for 30 seconds, the server notifies subscribers. A power failure at the ESP32 produces the same notification as an internet outage.

## Structure

| Path | Description |
| --- | --- |
| `backend/` | Node.js server and Telegram bot (requires Node.js 24 or later) |
| `sketch_nov3a/` | ESP32 Arduino sketch |

## Setup

### Server

```sh
cd backend
cp .env.example .env
npm install
npm start
```

Set the required variables in `.env` before starting. All options are documented in `.env.example`.

To deploy on Railway, set the root directory to `/backend`, attach a volume, and set `STATE_FILE` to a path on that volume.

### ESP32

1. Copy `secrets.h.example` to `secrets.h` in `sketch_nov3a/` and set the values.
2. Upload `sketch_nov3a.ino` using the Arduino IDE with ESP32 board support.

### Subscribing

Send `/start` to the bot. To restrict access, set `ALLOWED_CHAT_IDS` to a comma-separated list of chat IDs.

The bot keyboard has two buttons:

- **📊 Status** (or `/status`): the current state and the time of the last heartbeat.
- **📈 Stats** (or `/stats`): uptime percentage, outage count, total and longest downtime for the last 24 hours, 7 days and 30 days, plus the most recent outages. The stats come with a chart image: an online/offline timeline for the last 7 days and downtime per day for the last 14 days, in Kyiv time. The image is drawn with Chart.js on `@napi-rs/canvas`, which uses prebuilt binaries, so no system libraries are needed. If rendering fails, the stats are sent as text only.

Outages are kept in the state file for 90 days. Stats start from the first heartbeat after this feature was deployed. Outages shorter than `OFFLINE_TIMEOUT_SECONDS` are not detected, so they are not counted.
