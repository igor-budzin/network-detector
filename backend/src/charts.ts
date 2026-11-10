import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, type Canvas } from "@napi-rs/canvas";
import { Chart, registerables, type ChartConfiguration, type Plugin } from "chart.js";
import { formatDuration } from "./format.ts";

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
// Telegram downscales photos to 1280px on the longest side and fits them to the chat width, so a
// near-4:3 image with large type reads much bigger on a phone than a wide one with small type.
const WIDTH = 1280;
const HEIGHT = 960;
const PADDING = 32;

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
// The Latin subset covers digits and punctuation, the Cyrillic one the Ukrainian letters. Each subset
// needs its own family name: files sharing one are not merged, and the second is ignored.
for (const weight of [400, 600]) {
  GlobalFonts.registerFromPath(join(fontDir, `inter-latin-${weight}-normal.woff2`), "Inter");
  GlobalFonts.registerFromPath(join(fontDir, `inter-cyrillic-${weight}-normal.woff2`), "Inter Cyrillic");
}
const FONT_FAMILY = `Inter, "Inter Cyrillic"`;

Chart.register(...registerables);
Chart.defaults.font.family = FONT_FAMILY;
Chart.defaults.font.size = 24;
Chart.defaults.color = COLORS.textSecondary;
Chart.defaults.borderColor = COLORS.grid;

const DAY_LABEL = new Intl.DateTimeFormat("uk-UA", { timeZone: TIME_ZONE, weekday: "short", day: "2-digit" });
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

  // Duration of each outage segment: inside it in white when it fits, otherwise just above it.
  // A label that would run into the previous one in the same row is skipped.
  const durationLabels: Plugin<"bar"> = {
    id: "durationLabels",
    afterDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      const lastRightByRow = new Map<string, number>();
      ctx.save();
      ctx.textAlign = "center";
      chart.getDatasetMeta(0).data.forEach((element, i) => {
        const segment = offline[i];
        const bar = element as unknown as { x: number; base: number; y: number; height: number };
        // Rounded to whole minutes: the hour fractions lose precision, turning 4 h into 3 h 59 min.
        const minutes = Math.max(1, Math.round((segment.x[1] - segment.x[0]) * 60));
        const label = formatDuration(minutes * 60_000);
        const left = Math.min(bar.x, bar.base);
        const width = Math.abs(bar.x - bar.base);
        ctx.font = `600 18px ${FONT_FAMILY}`;
        const textWidth = ctx.measureText(label).width;
        if (textWidth + 16 <= width) {
          ctx.fillStyle = "#ffffff";
          ctx.textBaseline = "middle";
          ctx.fillText(label, left + width / 2, bar.y);
          return;
        }
        const half = textWidth / 2;
        const center = Math.min(Math.max(left + width / 2, chartArea.left + half), chartArea.right - half);
        if (center - half < (lastRightByRow.get(segment.y) ?? -Infinity) + 8) return;
        lastRightByRow.set(segment.y, center + half);
        ctx.fillStyle = COLORS.offline;
        ctx.textBaseline = "bottom";
        ctx.fillText(label, center, bar.y - bar.height / 2 - 4);
      });
      ctx.restore();
    },
  };

  const shared = { borderRadius: 6, borderSkipped: false, grouped: false, barPercentage: 0.6 } as const;
  return {
    type: "bar",
    data: {
      labels,
      datasets: [
        // Lower `order` is drawn on top, so outages sit over the online band.
        { label: "Немає інтернету", data: offline, backgroundColor: COLORS.offline, order: 0, minBarLength: 4, ...shared },
        { label: "Є інтернет", data: online, backgroundColor: COLORS.online, order: 1, ...shared },
        { label: "Немає даних", data: noData, backgroundColor: COLORS.noData, order: 2, ...shared },
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
          text: `Останні ${TIMELINE_DAYS} днів (київський час)`,
          align: "start",
          color: COLORS.textPrimary,
          font: { size: 34, weight: 600 },
          padding: { bottom: 12 },
        },
        legend: {
          position: "top",
          align: "start",
          labels: {
            boxWidth: 22,
            boxHeight: 22,
            padding: 16,
            useBorderRadius: true,
            borderRadius: 4,
            color: COLORS.textSecondary,
          },
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
    plugins: [durationLabels],
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
  const formatValue = (minutes: number) => formatDuration(Math.max(1, Math.round(minutes)) * 60_000);

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
          // Rotated: 14 day columns are too narrow for the phrase written horizontally.
          ctx.save();
          ctx.translate(bar.x, chart.scales.y.bottom - 10);
          ctx.rotate(-Math.PI / 2);
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.font = `400 20px ${FONT_FAMILY}`;
          ctx.fillStyle = COLORS.muted;
          ctx.fillText("немає даних", 0, 0);
          ctx.restore();
        } else if (minutes > 0) {
          ctx.font = `600 20px ${FONT_FAMILY}`;
          ctx.fillStyle = COLORS.textPrimary;
          // "1 год 30 хв" is wider than a column, so each unit goes on its own line, largest on top.
          const lines = formatValue(minutes).match(/\S+ \S+/g) ?? [];
          lines.reverse().forEach((line, row) => ctx.fillText(line, bar.x, bar.y - 8 - row * 24));
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
          label: "Без інтернету",
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
      layout: { padding: { right: 8 } },
      plugins: {
        title: {
          display: true,
          text: `Без інтернету по днях, ${DOWNTIME_DAYS} днів`,
          align: "start",
          color: COLORS.textPrimary,
          font: { size: 34, weight: 600 },
          // Room for the two-line value label above the tallest bar.
          padding: { bottom: 64 },
        },
        legend: { display: false },
        tooltip: { enabled: false },
      },
      scales: {
        x: {
          ticks: { color: COLORS.muted, maxRotation: 0, autoSkip: false, font: { size: 18 } },
          grid: { display: false },
          border: { color: COLORS.baseline },
        },
        y: {
          beginAtZero: true,
          suggestedMax: useHours ? 1 : 10,
          title: { display: true, text: useHours ? "години" : "хвилини", color: COLORS.muted },
          ticks: { color: COLORS.muted, precision: 0, maxTicksLimit: 6 },
          grid: { color: COLORS.grid },
          border: { display: false },
        },
      },
    },
    plugins: [valueLabels],
  };
}

// Renders one chart as a standalone PNG on an opaque surface. The chart is copied onto the image
// before destroy(), which clears its canvas.
function renderChart(config: ChartConfiguration<"bar", any, string>): Promise<Buffer> {
  const image: Canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = image.getContext("2d");
  ctx.fillStyle = COLORS.surface;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const canvas = createCanvas(WIDTH - 2 * PADDING, HEIGHT - 2 * PADDING);
  // Chart.js only needs a 2D context, which @napi-rs/canvas provides.
  const chart = new Chart(canvas as unknown as HTMLCanvasElement, config);
  ctx.drawImage(canvas, PADDING, PADDING);
  chart.destroy();
  return image.encode("png");
}

export function renderTimelineImage(input: ChartInput): Promise<Buffer> {
  return renderChart(timelineConfig(input));
}

export function renderDowntimeImage(input: ChartInput): Promise<Buffer> {
  return renderChart(downtimeConfig(input));
}
