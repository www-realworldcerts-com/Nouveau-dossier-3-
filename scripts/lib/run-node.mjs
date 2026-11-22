/** Spawn a node script and collect its stdout, stderr and exit code. */
import { spawn } from "node:child_process";

export function runNode(scriptPath, argv, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...argv], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        // Left null so the assertion failure shows the raw stdout.
      }
      resolve({ code, stdout, stderr, json });
    });
  });
}
