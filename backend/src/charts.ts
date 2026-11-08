import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, type Canvas } from "@napi-rs/canvas";
import { Chart, registerables, type ChartConfiguration, type Plugin } from "chart.js";

export interface Interval {
  start: number;
  end: number;
}

export interface ChartInput {
  now: number;
  monitoringSince: number;
  // Oldest first, ongoing outages already closed at `now`.
  outages: Interval[];
}

const TIME_ZONE = "Europe/Kyiv";
const HOUR_MS = 60 * 60 * 1000;
const TIMELINE_DAYS = 7;
const DOWNTIME_DAYS = 14;
const WIDTH = 1200;
const PADDING = 24;
const TIMELINE_HEIGHT = 440;
const DOWNTIME_HEIGHT = 420;

// Light theme of the dataviz reference palette. Telegram shows photos on both light and dark
// backgrounds, so the image always carries its own opaque surface.
const COLORS = {
  surface: "#fcfcfb",
  textPrimary: "#0b0b0b",
  textSecondary: "#52514e",
  muted: "#898781",
  grid: "#e1e0d9",
  baseline: "#c3c2b7",
  online: "#0ca30c",
  offline: "#d03b3b",
  noData: "#e1e0d9",
};

// Containers usually have no system fonts, so a bundled font is registered or text would not render.
const fontDir = join(dirname(fileURLToPath(import.meta.resolve("@fontsource/inter/LICENSE"))), "files");
GlobalFonts.registerFromPath(join(fontDir, "inter-latin-400-normal.woff2"), "Inter");
GlobalFonts.registerFromPath(join(fontDir, "inter-latin-600-normal.woff2"), "Inter");

Chart.register(...registerables);
Chart.defaults.font.family = "Inter";
Chart.defaults.font.size = 16;
Chart.defaults.color = COLORS.textSecondary;
Chart.defaults.borderColor = COLORS.grid;

const DAY_LABEL = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, weekday: "short", day: "2-digit" });
const TIME_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

// Start of the Kyiv calendar day containing `ms`. Off by an hour only on DST change days.
function kyivMidnight(ms: number): number {
  const parts = Object.fromEntries(TIME_PARTS.formatToParts(ms).map((p) => [p.type, Number(p.value)]));
  return ms - ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1000 - (ms % 1000);
}

// The last `count` Kyiv days, oldest first, the last one being today.
function recentDays(now: number, count: number): Interval[] {
  const days: Interval[] = [];
  let start = kyivMidnight(now);
  let end = start + 24 * HOUR_MS;
  for (let i = 0; i < count; i++) {
    days.unshift({ start, end });
    end = start;
    // Half a day back always lands in the previous day, whatever the DST shift.
    start = kyivMidnight(start - 12 * HOUR_MS);
  }
  return days;
}

function clip(interval: Interval, to: Interval): Interval | null {
  const start = Math.max(interval.start, to.start);
  const end = Math.min(interval.end, to.end);
  return end > start ? { start, end } : null;
}

type Segment = { x: [number, number]; y: string };

function timelineConfig(input: ChartInput): ChartConfiguration<"bar", Segment[], string> {
  const known: Interval = { start: input.monitoringSince, end: input.now };
  const online: Segment[] = [];
  const offline: Segment[] = [];
  const noData: Segment[] = [];
  const days = recentDays(input.now, TIMELINE_DAYS);
  const labels = days.map((day) => DAY_LABEL.format(day.start));

  days.forEach((day, i) => {
    const toHours = (interval: Interval): [number, number] => [
      (interval.start - day.start) / HOUR_MS,
      (interval.end - day.start) / HOUR_MS,
    ];
    const before = clip({ start: day.start, end: input.monitoringSince }, day);
    if (before) noData.push({ x: toHours(before), y: labels[i] });
    const covered = clip(known, day);
    if (!covered) return;
    online.push({ x: toHours(covered), y: labels[i] });
    for (const outage of input.outages) {
      const part = clip(outage, covered);
      if (part) offline.push({ x: toHours(part), y: labels[i] });
    }
  });

  const shared = { borderRadius: 4, borderSkipped: false, grouped: false, barPercentage: 0.7 } as const;
  return {
    type: "bar",
    data: {
      labels,
      datasets: [
        // Lower `order` is drawn on top, so outages sit over the online band.
        { label: "Offline", data: offline, backgroundColor: COLORS.offline, order: 0, minBarLength: 3, ...shared },
        { label: "Online", data: online, backgroundColor: COLORS.online, order: 1, ...shared },
        { label: "No data", data: noData, backgroundColor: COLORS.noData, order: 2, ...shared },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: false,
      animation: false,
      layout: { padding: { right: 8 } },
      plugins: {
        title: {
          display: true,
          text: `Last ${TIMELINE_DAYS} days (Kyiv time)`,
          align: "start",
          color: COLORS.textPrimary,
          font: { size: 22, weight: 600 },
          padding: { bottom: 8 },
        },
        legend: {
          position: "top",
          align: "start",
          labels: { boxWidth: 14, boxHeight: 14, useBorderRadius: true, borderRadius: 3, color: COLORS.textSecondary },
        },
        tooltip: { enabled: false },
      },
      scales: {
        x: {
          type: "linear",
          min: 0,
          max: 24,
          ticks: { stepSize: 3, color: COLORS.muted, callback: (value) => `${String(value).padStart(2, "0")}:00` },
          grid: { color: COLORS.grid },
          border: { display: false },
        },
        y: {
          ticks: { color: COLORS.textSecondary },
          grid: { display: false },
          border: { color: COLORS.baseline },
        },
      },
    },
  };
}

function downtimeConfig(input: ChartInput): ChartConfiguration<"bar", (number | null)[], string> {
  const days = recentDays(input.now, DOWNTIME_DAYS);
  const downMinutes = days.map((day) => {
    if (day.end <= input.monitoringSince) return null;
    let ms = 0;
    for (const outage of input.outages) {
      const part = clip(outage, day);
      if (part) ms += part.end - part.start;
    }
    return ms / 60_000;
  });
  const useHours = Math.max(0, ...downMinutes.map((v) => v ?? 0)) >= 180;
  const values = downMinutes.map((v) => (v === null ? null : useHours ? v / 60 : v));
  const formatValue = (minutes: number) =>
    minutes < 60 ? `${Math.max(1, Math.round(minutes))}m` : `${(minutes / 60).toFixed(1)}h`;

  // Values only on bars that have any downtime, so the zero days stay quiet.
  // Days before monitoring started are marked, so they don't read as days without outages.
  const valueLabels: Plugin<"bar"> = {
    id: "valueLabels",
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(0);
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      meta.data.forEach((bar, i) => {
        const minutes = downMinutes[i];
        if (minutes === null) {
          ctx.font = "400 13px Inter";
          ctx.fillStyle = COLORS.muted;
          ctx.fillText("no data", bar.x, chart.scales.y.bottom - 6);
        } else if (minutes > 0) {
          ctx.font = "600 15px Inter";
          ctx.fillStyle = COLORS.textPrimary;
          ctx.fillText(formatValue(minutes), bar.x, bar.y - 6);
        }
      });
      ctx.restore();
    },
  };

  return {
    type: "bar",
    data: {
      labels: days.map((day) => DAY_LABEL.format(day.start)),
      datasets: [
        {
          label: "Downtime",
          data: values,
          backgroundColor: COLORS.offline,
          borderRadius: { topLeft: 4, topRight: 4 },
          borderSkipped: "bottom",
          barPercentage: 0.6,
        },
      ],
    },
    options: {
      responsive: false,
      animation: false,
      layout: { padding: { top: 24, right: 8 } },
      plugins: {
        title: {
          display: true,
          text: `Downtime per day, last ${DOWNTIME_DAYS} days`,
          align: "start",
          color: COLORS.textPrimary,
          font: { size: 22, weight: 600 },
          padding: { bottom: 12 },
        },
        legend: { display: false },
        tooltip: { enabled: false },
      },
      scales: {
        x: {
          ticks: { color: COLORS.muted, maxRotation: 0, autoSkip: false, font: { size: 13 } },
          grid: { display: false },
          border: { color: COLORS.baseline },
        },
        y: {
          beginAtZero: true,
          suggestedMax: useHours ? 1 : 10,
          title: { display: true, text: useHours ? "hours" : "minutes", color: COLORS.muted },
          ticks: { color: COLORS.muted, precision: 0, maxTicksLimit: 6 },
          grid: { color: COLORS.grid },
          border: { display: false },
        },
      },
    },
    plugins: [valueLabels],
  };
}

// Renders the chart and copies it onto `target`. Copied before destroy(), which clears the canvas.
function drawChart(
  config: ChartConfiguration<"bar", any, string>,
  target: Canvas,
  x: number,
  y: number,
  height: number,
): void {
  const canvas = createCanvas(target.width - 2 * x, height);
  // Chart.js only needs a 2D context, which @napi-rs/canvas provides.
  const chart = new Chart(canvas as unknown as HTMLCanvasElement, config);
  target.getContext("2d").drawImage(canvas, x, y);
  chart.destroy();
}

export function renderStatsImage(input: ChartInput): Promise<Buffer> {
  const gap = 32;
  const image = createCanvas(WIDTH, PADDING * 2 + TIMELINE_HEIGHT + gap + DOWNTIME_HEIGHT);
  const ctx = image.getContext("2d");
  ctx.fillStyle = COLORS.surface;
  ctx.fillRect(0, 0, image.width, image.height);
  drawChart(timelineConfig(input), image, PADDING, PADDING, TIMELINE_HEIGHT);
  drawChart(downtimeConfig(input), image, PADDING, PADDING + TIMELINE_HEIGHT + gap, DOWNTIME_HEIGHT);
  return image.encode("png");
}
