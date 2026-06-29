export interface RestartPolicy {
  maxCrashes: number;
  windowMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  // After the worker is marked unhealthy, wait this long then try ONCE more (resetting the window),
  // instead of giving up forever — so a transient crash burst doesn't leave the daemon dead.
  unhealthyCooldownMs: number;
}
export interface AppConfig {
  bindHost: string;
  supervisorPort: number;
  workerPort: number;
  restart: RestartPolicy;
  // model remap: client model name -> Copilot model id. "*" is the fallback.
  modelMap: Record<string, string>;
  // GitHub "owner/repo" that /report files diagnostics issues against. Placeholder until set.
  reportRepo: string;
}

export function defaultConfig(): AppConfig {
  return {
    bindHost: "127.0.0.1",
    supervisorPort: 7890,
    workerPort: 7891,
    restart: { maxCrashes: 5, windowMs: 60_000, baseBackoffMs: 500, maxBackoffMs: 8_000, unhealthyCooldownMs: 30_000 },
    // Empty = pass the requested model straight through to Copilot. Add entries (or "*") to remap.
    modelMap: {},
    // Set MAESTRO_REPORT_REPO=owner/repo to override where /report files diagnostics issues.
    reportRepo: process.env.MAESTRO_REPORT_REPO ?? "wangcansunking/copilot-reverse",
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export function mergeConfig(base: AppConfig, o: DeepPartial<AppConfig>): AppConfig {
  return {
    ...base,
    ...o,
    restart: { ...base.restart, ...(o.restart ?? {}) },
    modelMap: { ...base.modelMap, ...(o.modelMap ?? {}) } as Record<string, string>,
  };
}
