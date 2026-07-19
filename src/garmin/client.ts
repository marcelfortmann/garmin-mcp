/**
 * Layer 2b — data access.
 *
 * `GarminClient` wraps the generic `connectapi()` function (GET against
 * connectapi.garmin.com with a bearer token, automatic refresh on 401) and
 * provides typed, read-only data methods for the MCP tool catalog.
 *
 * MAINTENANCE (fragile): the endpoint paths are Garmin's unofficial internal API
 * and come from `python-garminconnect`. Compare against it if they change.
 */
import type { ImpersonatedHttp, HttpResponse } from "../http/impersonate.js";
import * as auth from "./auth.js";
import { CONNECTAPI, NATIVE_HEADERS } from "./auth.js";
import { GarminAuthRequiredError, GarminRateLimitError } from "./errors.js";
import * as tokens from "./tokens.js";
import type { GarminProfile, StoredTokens } from "./tokens.js";

// Proactively renew the access token when it expires in less than 15 minutes.
const REFRESH_SKEW_SECONDS = 900;

export class GarminClient {
  private constructor(
    private readonly http: ImpersonatedHttp,
    private stored: StoredTokens,
  ) {}

  /** Builds a client from already-available tokens (e.g. right after login). */
  static from(http: ImpersonatedHttp, stored: StoredTokens): GarminClient {
    return new GarminClient(http, stored);
  }

  /** Builds a client from the local token cache. */
  static async fromStore(http: ImpersonatedHttp): Promise<GarminClient> {
    const t = await tokens.load();
    if (!t) {
      throw new GarminAuthRequiredError(
        "Not logged in — please run 'npm run login' once.",
      );
    }
    return GarminClient.from(http, t);
  }

  // --- Generic API request ---------------------------------------------------

  /** GET against connectapi.garmin.com with a bearer token; refresh once on 401. */
  async connectapi<T = unknown>(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<T> {
    await this.ensureFresh();

    let res = await this.rawGet(path, params);
    if (res.status === 401) {
      await this.doRefresh();
      res = await this.rawGet(path, params);
    }

    if (res.status === 401) {
      throw new GarminAuthRequiredError(
        "Session expired — please run 'npm run login' again.",
      );
    }
    if (res.status === 429) {
      throw new GarminRateLimitError(
        "Garmin is throttling right now (HTTP 429). Please try again later.",
      );
    }
    if (res.status === 204) {
      return {} as T; // No Content
    }
    if (res.status < 200 || res.status >= 300) {
      const snippet = res.text.slice(0, 200).replace(/\s+/g, " ").trim();
      throw new Error(`Garmin API ${path} -> HTTP ${res.status}: ${snippet}`);
    }
    return (res.json ?? {}) as T;
  }

  private rawGet(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<HttpResponse> {
    return this.http.get(`${CONNECTAPI}${path}`, {
      params,
      headers: {
        ...NATIVE_HEADERS,
        Authorization: `Bearer ${this.stored.accessToken}`,
        Accept: "application/json",
      },
    });
  }

  private async ensureFresh(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    if (this.stored.expiresAt - now <= REFRESH_SKEW_SECONDS) {
      await this.doRefresh();
    }
  }

  private async doRefresh(): Promise<void> {
    try {
      const r = await auth.refresh(
        this.http,
        this.stored.refreshToken,
        this.stored.diClientId,
      );
      this.stored = {
        ...this.stored,
        accessToken: r.accessToken,
        refreshToken: r.refreshToken,
        expiresAt: r.expiresAt,
      };
      await tokens.save(this.stored);
    } catch (err) {
      if (err instanceof GarminRateLimitError) throw err;
      throw new GarminAuthRequiredError(
        "Automatic refresh failed — please run 'npm run login' again.",
      );
    }
  }

  // --- Profile / display name ------------------------------------------------

  /** Display name (for endpoints that need it as a path segment). */
  async getDisplayName(): Promise<string> {
    if (this.stored.profile?.displayName) return this.stored.profile.displayName;
    const profile = await this.fetchProfile();
    return profile.displayName;
  }

  private async fetchProfile(): Promise<GarminProfile> {
    const raw = await this.connectapi<{
      displayName?: string;
      fullName?: string;
      userName?: string;
    }>("/userprofile-service/socialProfile");
    const profile: GarminProfile = {
      displayName: raw.displayName ?? "",
      fullName: raw.fullName,
      userName: raw.userName,
    };
    // Only persist if the profile actually changed — otherwise every whoami call
    // would rewrite the same file.
    if (JSON.stringify(profile) !== JSON.stringify(this.stored.profile)) {
      this.stored = { ...this.stored, profile };
      await tokens.save(this.stored);
    }
    return profile;
  }

  // --- Data methods (read-only) ----------------------------------------------
  // All responses are shortened with trimLongArrays so that long time series
  // (per-minute HR/stress/body-battery etc.) don't bloat the response.

  /** Confirms the connection and returns the account profile. */
  async whoami(): Promise<GarminProfile & { loggedIn: true }> {
    const profile = await this.fetchProfile();
    return { ...profile, loggedIn: true };
  }

  /** Daily summary (calories, steps, distance, intensity minutes ...). */
  async getDailySummary(date: string): Promise<unknown> {
    const dn = await this.getDisplayName();
    return this.trimmed(
      `/usersummary-service/usersummary/daily/${enc(dn)}`,
      { calendarDate: date },
    );
  }

  /** List of the most recently recorded activities. */
  async listRecentActivities(limit = 10, start = 0): Promise<unknown> {
    return this.trimmed("/activitylist-service/activities/search/activities", {
      start,
      limit,
    });
  }

  /** Detailed data for a single activity. */
  async getActivity(activityId: number | string): Promise<unknown> {
    return this.trimmed(`/activity-service/activity/${enc(String(activityId))}`);
  }

  /** Sleep data for a day (stages, duration, score). */
  async getSleep(date: string): Promise<unknown> {
    const dn = await this.getDisplayName();
    return this.trimmed(
      `/wellness-service/wellness/dailySleepData/${enc(dn)}`,
      { date, nonSleepBufferMinutes: 60 },
    );
  }

  /** Body Battery timeline for a day. */
  async getBodyBattery(date: string): Promise<unknown> {
    return this.trimmed(
      "/wellness-service/wellness/bodyBattery/reports/daily",
      { startDate: date, endDate: date },
    );
  }

  /** Stress values for a day. */
  async getStress(date: string): Promise<unknown> {
    return this.trimmed(`/wellness-service/wellness/dailyStress/${enc(date)}`);
  }

  /** Heart-rate values for a day (incl. resting heart rate). */
  async getHeartRate(date: string): Promise<unknown> {
    const dn = await this.getDisplayName();
    return this.trimmed(
      `/wellness-service/wellness/dailyHeartRate/${enc(dn)}`,
      { date },
    );
  }

  /** HRV (heart-rate variability) for a day. */
  async getHrv(date: string): Promise<unknown> {
    return this.trimmed(`/hrv-service/hrv/${enc(date)}`);
  }

  /** Training readiness for a day. */
  async getTrainingReadiness(date: string): Promise<unknown> {
    return this.trimmed(
      `/metrics-service/metrics/trainingreadiness/${enc(date)}`,
    );
  }

  /** Training status (aggregated) for a day. */
  async getTrainingStatus(date: string): Promise<unknown> {
    return this.trimmed(
      `/metrics-service/metrics/trainingstatus/aggregated/${enc(date)}`,
    );
  }

  /** Max metrics (incl. VO2max) for a day. */
  async getMaxMetrics(date: string): Promise<unknown> {
    return this.trimmed(
      `/metrics-service/metrics/maxmet/daily/${enc(date)}/${enc(date)}`,
    );
  }

  /** Step timeline for a day. */
  async getSteps(date: string): Promise<unknown> {
    const dn = await this.getDisplayName();
    return this.trimmed(
      `/wellness-service/wellness/dailySummaryChart/${enc(dn)}`,
      { date },
    );
  }

  /** All-time personal records (e.g. fastest 1K/5K/10K, longest run, most steps). */
  async getPersonalRecords(): Promise<unknown> {
    const dn = await this.getDisplayName();
    return this.trimmed(`/personalrecord-service/personalrecord/prs/${enc(dn)}`);
  }

  /** Body weight & composition (weight, BMI, body-fat %) over a date range. */
  async getWeight(startDate: string, endDate: string): Promise<unknown> {
    return this.trimmed("/weight-service/weight/dateRange", {
      startDate,
      endDate,
    });
  }

  /** Individual weigh-in entries over a date range. */
  async getWeighIns(startDate: string, endDate: string): Promise<unknown> {
    return this.trimmed(
      `/weight-service/weight/range/${enc(startDate)}/${enc(endDate)}`,
      { includeAll: "true" },
    );
  }

  /** Pulse Ox (SpO2) readings for a day. */
  async getSpo2(date: string): Promise<unknown> {
    return this.trimmed(`/wellness-service/wellness/daily/spo2/${enc(date)}`);
  }

  /** Respiration (breaths per minute) for a day. */
  async getRespiration(date: string): Promise<unknown> {
    return this.trimmed(
      `/wellness-service/wellness/daily/respiration/${enc(date)}`,
    );
  }

  /** Hydration (fluid intake) for a day. */
  async getHydration(date: string): Promise<unknown> {
    return this.trimmed(
      `/usersummary-service/usersummary/hydration/daily/${enc(date)}`,
    );
  }

  /** Splits / laps for a single activity. */
  async getActivitySplits(activityId: number | string): Promise<unknown> {
    return this.trimmed(
      `/activity-service/activity/${enc(String(activityId))}/splits`,
    );
  }

  /** Weather recorded during an activity. */
  async getActivityWeather(activityId: number | string): Promise<unknown> {
    return this.trimmed(
      `/activity-service/activity/${enc(String(activityId))}/weather`,
    );
  }

  /** Full detail for an activity (GPS / HR / power streams; long series trimmed). */
  async getActivityDetails(activityId: number | string): Promise<unknown> {
    return this.trimmed(
      `/activity-service/activity/${enc(String(activityId))}/details`,
      { maxChartSize: 2000, maxPolylineSize: 4000 },
    );
  }

  /** Activities within a date range, optionally filtered by type. */
  async getActivitiesByDate(
    startDate: string,
    endDate: string,
    activityType?: string,
    limit = 20,
  ): Promise<unknown> {
    return this.trimmed("/activitylist-service/activities/search/activities", {
      startDate,
      endDate,
      start: 0,
      limit,
      activityType,
    });
  }

  /** Latest race-time predictions (5K, 10K, half, marathon). */
  async getRacePredictions(): Promise<unknown> {
    const dn = await this.getDisplayName();
    return this.trimmed(
      `/metrics-service/metrics/racepredictions/latest/${enc(dn)}`,
    );
  }

  /** Endurance score over a date range (weekly aggregation). */
  async getEnduranceScore(
    startDate: string,
    endDate: string,
  ): Promise<unknown> {
    return this.trimmed("/metrics-service/metrics/endurancescore/stats", {
      startDate,
      endDate,
      aggregation: "weekly",
    });
  }

  /** Hill score over a date range (daily aggregation). */
  async getHillScore(startDate: string, endDate: string): Promise<unknown> {
    return this.trimmed("/metrics-service/metrics/hillscore/stats", {
      startDate,
      endDate,
      aggregation: "daily",
    });
  }

  /** Fitness age for a day. */
  async getFitnessAge(date: string): Promise<unknown> {
    return this.trimmed(`/fitnessage-service/fitnessage/${enc(date)}`);
  }

  /** Daily step totals over a date range (Garmin caps this at ~28 days). */
  async getDailySteps(startDate: string, endDate: string): Promise<unknown> {
    return this.trimmed(
      `/usersummary-service/stats/steps/daily/${enc(startDate)}/${enc(endDate)}`,
    );
  }

  /** Floors climbed for a day. */
  async getFloors(date: string): Promise<unknown> {
    return this.trimmed(
      `/wellness-service/wellness/floorsChartData/daily/${enc(date)}`,
    );
  }

  /** Intensity minutes for a day. */
  async getIntensityMinutes(date: string): Promise<unknown> {
    return this.trimmed(`/wellness-service/wellness/daily/im/${enc(date)}`);
  }

  /** Strength/gym exercise sets (exercise, reps, weight) for an activity. */
  async getActivityExerciseSets(activityId: number | string): Promise<unknown> {
    return this.trimmed(
      `/activity-service/activity/${enc(String(activityId))}/exerciseSets`,
    );
  }

  /** Time spent in each heart-rate zone for an activity. */
  async getActivityHrZones(activityId: number | string): Promise<unknown> {
    return this.trimmed(
      `/activity-service/activity/${enc(String(activityId))}/hrTimeInZones`,
    );
  }

  /** Combined daily stats + body-composition averages for a day. */
  async getStatsAndBody(date: string): Promise<unknown> {
    const dn = await this.getDisplayName();
    const stats = await this.connectapi<Record<string, unknown>>(
      `/usersummary-service/usersummary/daily/${enc(dn)}`,
      { calendarDate: date },
    );
    const body = await this.connectapi<{
      totalAverage?: Record<string, unknown>;
    }>("/weight-service/weight/dateRange", { startDate: date, endDate: date });
    return trimLongArrays({ ...stats, ...(body.totalAverage ?? {}) });
  }

  /** Resting heart rate over a date range. */
  async getRestingHeartRate(
    startDate: string,
    endDate: string,
  ): Promise<unknown> {
    const dn = await this.getDisplayName();
    return this.trimmed(`/userstats-service/wellness/daily/${enc(dn)}`, {
      fromDate: startDate,
      untilDate: endDate,
      metricId: 60,
    });
  }

  /** Body Battery events (sleep, activities, naps) for a day. */
  async getBodyBatteryEvents(date: string): Promise<unknown> {
    return this.trimmed(
      `/wellness-service/wellness/bodyBattery/events/${enc(date)}`,
    );
  }

  /** Morning training readiness (the after-wakeup reading) for a day. */
  async getMorningReadiness(date: string): Promise<unknown> {
    const data = await this.connectapi<Array<Record<string, unknown>>>(
      `/metrics-service/metrics/trainingreadiness/${enc(date)}`,
    );
    const list = Array.isArray(data) ? data : [];
    const morning =
      list.find((e) => e.inputContext === "AFTER_WAKEUP_RESET") ??
      list[0] ??
      null;
    return trimLongArrays(morning);
  }

  /** Latest cycling Functional Threshold Power (FTP). */
  async getCyclingFtp(): Promise<unknown> {
    return this.trimmed(
      "/biometric-service/biometric/latestFunctionalThresholdPower/CYCLING",
    );
  }

  /** Latest running lactate threshold (pace & heart rate). */
  async getLactateThreshold(): Promise<unknown> {
    return this.trimmed("/biometric-service/biometric/latestLactateThreshold");
  }

  /** Weekly step aggregates for the last `weeks` weeks ending on `endDate`. */
  async getWeeklySteps(endDate: string, weeks = 12): Promise<unknown> {
    return this.trimmed(
      `/usersummary-service/stats/steps/weekly/${enc(endDate)}/${weeks}`,
    );
  }

  /** Weekly intensity-minute aggregates over a date range. */
  async getWeeklyIntensityMinutes(
    startDate: string,
    endDate: string,
  ): Promise<unknown> {
    return this.trimmed(
      `/usersummary-service/stats/im/weekly/${enc(startDate)}/${enc(endDate)}`,
    );
  }

  /** Garmin devices paired to the account. */
  async getDevices(): Promise<unknown> {
    return this.trimmed("/device-service/deviceregistration/devices");
  }

  /** Full user profile / settings (units, preferences ...). */
  async getUserProfile(): Promise<unknown> {
    return this.trimmed("/userprofile-service/userprofile/user-settings");
  }

  /** Goals filtered by status (active / future / past). */
  async getGoals(status = "active", limit = 30): Promise<unknown> {
    return this.trimmed("/goal-service/goal/goals", { status, start: 0, limit });
  }

  /** Saved workouts on the account. */
  async getWorkouts(limit = 50): Promise<unknown> {
    return this.trimmed("/workout-service/workouts", { start: 0, limit });
  }

  /** Scheduled workouts / calendar for a year + month (1-12). */
  async getScheduledWorkouts(year: number, month: number): Promise<unknown> {
    // Garmin's calendar API uses 0-indexed months.
    return this.trimmed(`/calendar-service/year/${year}/month/${month - 1}`);
  }

  private async trimmed(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    return trimLongArrays(await this.connectapi(path, params));
  }
}

/**
 * Recursively shortens long arrays (time series) to `max` elements and replaces
 * them with a compact object carrying a truncation marker. Short arrays and all
 * other values are left unchanged.
 */
export function trimLongArrays(value: unknown, max = 50): unknown {
  if (Array.isArray(value)) {
    const head = value.slice(0, max).map((v) => trimLongArrays(v, max));
    if (value.length > max) {
      return {
        _truncatedArray: true,
        _total: value.length,
        _shown: max,
        items: head,
      };
    }
    return head;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Defensive: a "__proto__" key in the JSON would otherwise mutate the
      // prototype of `out` on assignment. Garmin data does not contain it, but we
      // copy foreign JSON trees, so we skip it to be safe.
      if (k === "__proto__") continue;
      out[k] = trimLongArrays(v, max);
    }
    return out;
  }
  return value;
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}
