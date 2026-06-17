import { requestDeviceCode, pollForToken } from "../providers/copilot/auth.js";
import { writeGhToken } from "../shared/creds.js";

export async function runDeviceLogin(dir: string, fetchFn: typeof fetch = fetch, log: (m: string) => void = console.log): Promise<void> {
  const code = await requestDeviceCode(fetchFn);
  log(`\nOpen ${code.verification_uri} and enter code: ${code.user_code}\n`);
  const token = await pollForToken(code.device_code, code.interval * 1000, fetchFn);
  writeGhToken(token, dir);
  log("GitHub authorization complete.");
}
