import { requestDeviceCode, pollForToken, type DeviceCode } from "../providers/copilot/auth.js";
import { writeGhToken } from "../shared/creds.js";

export interface PendingLogin {
  code: DeviceCode;              // verification URL + user_code — show this immediately
  complete: () => Promise<void>; // blocks on authorization, then persists the token
}

// Two-phase device login. `beginDeviceLogin` returns the verification code right away so a caller
// can surface it to the user; `complete()` then blocks on authorization and writes the token.
// Splitting these is what lets the TUI render the code while the poll is still pending — folding
// both into one call buffers the code behind the blocking poll, and the user can't authorize a
// code they can't see.
export async function beginDeviceLogin(dir: string, fetchFn: typeof fetch = fetch): Promise<PendingLogin> {
  const code = await requestDeviceCode(fetchFn);
  return {
    code,
    complete: async () => {
      const token = await pollForToken(code.device_code, code.interval * 1000, fetchFn);
      writeGhToken(token, dir);
    },
  };
}

export async function runDeviceLogin(dir: string, fetchFn: typeof fetch = fetch, log: (m: string) => void = console.log): Promise<void> {
  const { code, complete } = await beginDeviceLogin(dir, fetchFn);
  log(`\nOpen ${code.verification_uri} and enter code: ${code.user_code}\n`);
  await complete();
  log("GitHub authorization complete.");
}
