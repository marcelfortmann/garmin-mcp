/**
 * Layer 3 — MCP server (stdio).
 *
 * Exposes a small set of parameterized, read-only tools over stdio. Each tool is
 * a thin dispatcher that calls the typed data methods on `GarminClient` — the
 * data/endpoint logic lives entirely in the Garmin layer, not here.
 *
 * Consolidation rationale: a flat list of ~46 narrow tools hurts the model's
 * tool selection and inflates context. We group them into ~13 tools with
 * `metrics[]` / `include[]` selectors instead. (MCP tools are a flat list — there
 * is no native "category" concept, so grouping happens via these selectors.)
 *
 * IMPORTANT: stdout is the MCP protocol channel — NEVER write to it with
 * console.log. Diagnostics go to stderr only.
 */
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ImpersonatedHttp } from "../http/impersonate.js";
import { GarminClient } from "../garmin/client.js";
import {
  GarminAuthRequiredError,
  GarminRateLimitError,
} from "../garmin/errors.js";

// --- Shared resources (lazy) -------------------------------------------------
let httpSingleton: ImpersonatedHttp | null = null;
let clientPromise: Promise<GarminClient> | null = null;

function http(): ImpersonatedHttp {
  return (httpSingleton ??= new ImpersonatedHttp());
}

/**
 * Loads the GarminClient from the token cache (once). On error (e.g. no token)
 * the promise is discarded so a later login can be retried.
 */
function getClient(): Promise<GarminClient> {
  if (!clientPromise) {
    clientPromise = GarminClient.fromStore(http()).catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

// --- Dates -------------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RANGE_DAYS = 28;

const dateArg = z
  .string()
  .regex(DATE_RE, "Date must be in YYYY-MM-DD format.")
  .optional()
  .describe("Date in YYYY-MM-DD format. Default: today.");
const startDateArg = z
  .string()
  .regex(DATE_RE, "Date must be in YYYY-MM-DD format.")
  .optional()
  .describe("Start date (YYYY-MM-DD). Default: ~4 weeks ago.");
const endDateArg = z
  .string()
  .regex(DATE_RE, "Date must be in YYYY-MM-DD format.")
  .optional()
  .describe("End date (YYYY-MM-DD). Default: today.");
const activityIdArg = z
  .number()
  .int()
  .positive()
  .describe("The numeric activityId (from list_activities).");

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayIso(): string {
  return isoDate(new Date());
}
function daysAgoIso(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
}
function weeksBetween(start: string, end: string): number {
  const ms = Date.parse(end) - Date.parse(start);
  const weeks = Math.ceil(ms / (7 * 86_400_000));
  return Math.min(52, Math.max(1, weeks));
}

// --- Result / error wrapping -------------------------------------------------
type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: friendly(err) }], isError: true };
  }
}

function friendly(err: unknown): string {
  if (err instanceof GarminAuthRequiredError) return `🔒 ${err.message}`;
  if (err instanceof GarminRateLimitError) return `⏳ ${err.message}`;
  const msg = err instanceof Error ? err.message : String(err);
  return `Error fetching Garmin data: ${msg}`;
}

/**
 * Runs the selected entries of a metric map concurrently and returns an object
 * keyed by metric name. Falls back to `defaults` when nothing is selected.
 */
async function collect(
  selected: string[] | undefined,
  defaults: string[],
  map: Record<string, () => Promise<unknown>>,
): Promise<Record<string, unknown>> {
  const keys = (selected && selected.length ? selected : defaults).filter(
    (k) => k in map,
  );
  const entries = await Promise.all(
    keys.map(async (k) => [k, await map[k]()] as const),
  );
  return Object.fromEntries(entries);
}

// --- Server + tools ----------------------------------------------------------
// Single source of truth for the version: package.json. Resolved at runtime via
// createRequire so it works both from build/mcp/ and from src/mcp/ under tsx,
// and so the JSON stays outside tsconfig's `rootDir`.
const pkg = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

const server = new McpServer({ name: "garmin", version: pkg.version });

server.registerTool(
  "whoami",
  {
    description:
      "Check the Garmin connection and return the logged-in account profile (display name, full name).",
  },
  async () => run(async () => (await getClient()).whoami()),
);

server.registerTool(
  "get_daily_health",
  {
    description:
      "Daily wellness metrics for a date. Pick one or more via `metrics`: " +
      "summary, sleep, stress, heart_rate, hrv, spo2, respiration, hydration, " +
      "steps, floors, intensity_minutes, body_battery, body_battery_events, stats_and_body.",
    inputSchema: {
      date: dateArg,
      metrics: z
        .array(
          z.enum([
            "summary",
            "sleep",
            "stress",
            "heart_rate",
            "hrv",
            "spo2",
            "respiration",
            "hydration",
            "steps",
            "floors",
            "intensity_minutes",
            "body_battery",
            "body_battery_events",
            "stats_and_body",
          ]),
        )
        .optional()
        .describe("Which daily metrics to return. Default: [summary]."),
    },
  },
  async ({ date, metrics }) =>
    run(async () => {
      const c = await getClient();
      const d = date ?? todayIso();
      return collect(metrics, ["summary"], {
        summary: () => c.getDailySummary(d),
        sleep: () => c.getSleep(d),
        stress: () => c.getStress(d),
        heart_rate: () => c.getHeartRate(d),
        hrv: () => c.getHrv(d),
        spo2: () => c.getSpo2(d),
        respiration: () => c.getRespiration(d),
        hydration: () => c.getHydration(d),
        steps: () => c.getSteps(d),
        floors: () => c.getFloors(d),
        intensity_minutes: () => c.getIntensityMinutes(d),
        body_battery: () => c.getBodyBattery(d),
        body_battery_events: () => c.getBodyBatteryEvents(d),
        stats_and_body: () => c.getStatsAndBody(d),
      });
    }),
);

server.registerTool(
  "get_training",
  {
    description:
      "Training metrics for a date. Pick via `metrics`: readiness, " +
      "morning_readiness, status, vo2max, fitness_age.",
    inputSchema: {
      date: dateArg,
      metrics: z
        .array(
          z.enum([
            "readiness",
            "morning_readiness",
            "status",
            "vo2max",
            "fitness_age",
          ]),
        )
        .optional()
        .describe("Which training metrics to return. Default: [readiness, status, vo2max]."),
    },
  },
  async ({ date, metrics }) =>
    run(async () => {
      const c = await getClient();
      const d = date ?? todayIso();
      return collect(metrics, ["readiness", "status", "vo2max"], {
        readiness: () => c.getTrainingReadiness(d),
        morning_readiness: () => c.getMorningReadiness(d),
        status: () => c.getTrainingStatus(d),
        vo2max: () => c.getMaxMetrics(d),
        fitness_age: () => c.getFitnessAge(d),
      });
    }),
);

server.registerTool(
  "get_fitness",
  {
    description:
      "Fitness/performance metrics. Pick via `metrics`: race_predictions, " +
      "cycling_ftp, lactate_threshold, personal_records (all latest, date-agnostic), " +
      "and endurance_score, hill_score, resting_heart_rate, weekly_intensity_minutes (over the given date range).",
    inputSchema: {
      metrics: z
        .array(
          z.enum([
            "race_predictions",
            "cycling_ftp",
            "lactate_threshold",
            "personal_records",
            "endurance_score",
            "hill_score",
            "resting_heart_rate",
            "weekly_intensity_minutes",
          ]),
        )
        .optional()
        .describe("Which metrics to return. Default: [race_predictions, personal_records]."),
      startDate: startDateArg,
      endDate: endDateArg,
    },
  },
  async ({ metrics, startDate, endDate }) =>
    run(async () => {
      const c = await getClient();
      const start = startDate ?? daysAgoIso(DEFAULT_RANGE_DAYS);
      const end = endDate ?? todayIso();
      return collect(metrics, ["race_predictions", "personal_records"], {
        race_predictions: () => c.getRacePredictions(),
        cycling_ftp: () => c.getCyclingFtp(),
        lactate_threshold: () => c.getLactateThreshold(),
        personal_records: () => c.getPersonalRecords(),
        endurance_score: () => c.getEnduranceScore(start, end),
        hill_score: () => c.getHillScore(start, end),
        resting_heart_rate: () => c.getRestingHeartRate(start, end),
        weekly_intensity_minutes: () => c.getWeeklyIntensityMinutes(start, end),
      });
    }),
);

server.registerTool(
  "get_weight",
  {
    description:
      "Body weight & body composition (weight, BMI, body-fat %) over a date range. " +
      "Set include_raw for the individual weigh-in entries too. Default range: the last ~4 weeks.",
    inputSchema: {
      startDate: startDateArg,
      endDate: endDateArg,
      include_raw: z
        .boolean()
        .optional()
        .describe("Also include individual weigh-in entries. Default: false."),
    },
  },
  async ({ startDate, endDate, include_raw }) =>
    run(async () => {
      const c = await getClient();
      const start = startDate ?? daysAgoIso(DEFAULT_RANGE_DAYS);
      const end = endDate ?? todayIso();
      const out: Record<string, unknown> = {
        composition: await c.getWeight(start, end),
      };
      if (include_raw) out.weighIns = await c.getWeighIns(start, end);
      return out;
    }),
);

server.registerTool(
  "get_steps_history",
  {
    description:
      "Step totals over a date range. granularity 'daily' (Garmin caps the span " +
      "at 28 days) or 'weekly'. Default: daily, last ~4 weeks.",
    inputSchema: {
      startDate: startDateArg,
      endDate: endDateArg,
      granularity: z
        .enum(["daily", "weekly"])
        .optional()
        .describe("daily or weekly. Default: daily."),
    },
  },
  async ({ startDate, endDate, granularity }) =>
    run(async () => {
      const c = await getClient();
      const end = endDate ?? todayIso();
      if (granularity === "weekly") {
        const start = startDate ?? daysAgoIso(83); // ~12 weeks
        return c.getWeeklySteps(end, weeksBetween(start, end));
      }
      const start = startDate ?? daysAgoIso(27); // 28-day inclusive span
      return c.getDailySteps(start, end);
    }),
);

server.registerTool(
  "get_activity",
  {
    description:
      "Data for a single activity by activityId. Pick via `include`: summary, " +
      "splits, weather, details (GPS/HR/power streams), hr_zones, exercise_sets.",
    inputSchema: {
      activityId: activityIdArg,
      include: z
        .array(
          z.enum([
            "summary",
            "splits",
            "weather",
            "details",
            "hr_zones",
            "exercise_sets",
          ]),
        )
        .optional()
        .describe("Which parts to return. Default: [summary]."),
    },
  },
  async ({ activityId, include }) =>
    run(async () => {
      const c = await getClient();
      return collect(include, ["summary"], {
        summary: () => c.getActivity(activityId),
        splits: () => c.getActivitySplits(activityId),
        weather: () => c.getActivityWeather(activityId),
        details: () => c.getActivityDetails(activityId),
        hr_zones: () => c.getActivityHrZones(activityId),
        exercise_sets: () => c.getActivityExerciseSets(activityId),
      });
    }),
);

server.registerTool(
  "list_activities",
  {
    description:
      "List activities. Without dates: the most recent ones (use limit=1 for the " +
      "last activity). With startDate/endDate and/or type: activities in that range, " +
      "optionally filtered by type (e.g. running, cycling, swimming).",
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max activities (1-50). Default: 10."),
      startDate: startDateArg,
      endDate: endDateArg,
      type: z
        .string()
        .optional()
        .describe("Filter by activity type, e.g. 'running', 'cycling'."),
    },
  },
  async ({ limit, startDate, endDate, type }) =>
    run(async () => {
      const c = await getClient();
      const n = limit ?? 10;
      if (startDate || endDate || type) {
        return c.getActivitiesByDate(
          startDate ?? daysAgoIso(DEFAULT_RANGE_DAYS),
          endDate ?? todayIso(),
          type,
          n,
        );
      }
      return c.listRecentActivities(n);
    }),
);

server.registerTool(
  "get_devices",
  {
    description:
      "Garmin devices paired to the account (model, firmware, last sync).",
  },
  async () => run(async () => (await getClient()).getDevices()),
);

server.registerTool(
  "get_user_profile",
  {
    description:
      "User profile & settings: units, preferences, activity level, etc.",
  },
  async () => run(async () => (await getClient()).getUserProfile()),
);

server.registerTool(
  "get_goals",
  {
    description: "Goals filtered by status (active, future, or past).",
    inputSchema: {
      status: z
        .enum(["active", "future", "past"])
        .optional()
        .describe("Goal status. Default: active."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max goals (1-50). Default: 30."),
    },
  },
  async ({ status, limit }) =>
    run(async () =>
      (await getClient()).getGoals(status ?? "active", limit ?? 30),
    ),
);

server.registerTool(
  "get_workouts",
  {
    description: "Saved workouts on the account.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max workouts (1-100). Default: 50."),
    },
  },
  async ({ limit }) =>
    run(async () => (await getClient()).getWorkouts(limit ?? 50)),
);

server.registerTool(
  "get_scheduled_workouts",
  {
    description:
      "Scheduled workouts / calendar for a month (defaults to the current month).",
    inputSchema: {
      year: z
        .number()
        .int()
        .min(2000)
        .max(2100)
        .optional()
        .describe("Year, e.g. 2026. Default: current year."),
      month: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe("Month 1-12. Default: current month."),
    },
  },
  async ({ year, month }) =>
    run(async () => {
      const now = new Date();
      return (await getClient()).getScheduledWorkouts(
        year ?? now.getFullYear(),
        month ?? now.getMonth() + 1,
      );
    }),
);

// --- Start -------------------------------------------------------------------
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[garmin-mcp] MCP server running (stdio).\n");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void httpSingleton?.close().finally(() => process.exit(0));
  });
}

main().catch((err) => {
  process.stderr.write(`[garmin-mcp] Startup failed: ${String(err)}\n`);
  process.exit(1);
});
