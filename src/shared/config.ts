export interface RestartPolicy {
  maxCrashes: number;
  windowMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}
export interface AppConfig {
  bindHost: string;
  supervisorPort: number;
  workerPort: number;
  restart: RestartPolicy;
  // model remap: client model name -> Copilot model id. "*" is the fallback.
  modelMap: Record<string, string>;
}

export function defaultConfig(): AppConfig {
  return {
    bindHost: "127.0.0.1",
    supervisorPort: 7890,
    workerPort: 7891,
    restart: { maxCrashes: 5, windowMs: 60_000, baseBackoffMs: 500, maxBackoffMs: 8_000 },
    modelMap: { "*": "gpt-4o" },
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export function mergeConfig(base: AppConfig, o: DeepPartial<AppConfig>): AppConfig {
  return {
    ...base,
    ...o,
    restart: { ...base.restart, ...(o.restart ?? {}) },
    modelMap: { ...base.modelMap, ...(o.modelMap ?? {}) },
  };
}
