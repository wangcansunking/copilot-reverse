import { spawn } from "node:child_process";
import { runLoginCommand } from "../../../src/cli/login-command.js";

let authenticated = false;
const result = await runLoginCommand({}, {
  isTTY: true,
  dir: process.argv[2],
  ghAuth: {
    isAvailable: async () => true,
    token: async () => {
      if (!authenticated) throw new Error("not logged in");
      return "fixture-token";
    },
    login: async () => {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", `
          process.stdout.write("GH_INPUT_READY\\n");
          process.stdin.once("data", (data) => {
            if (data.toString().trim() !== "authorize") process.exit(2);
            process.stdout.write("GH_INPUT_RECEIVED\\n");
            process.exit(0);
          });
        `], { stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exit ${code}`)));
      });
      authenticated = true;
    },
  },
});
console.log("LOGIN_COMPLETED", result.completed);
