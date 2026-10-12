import readline from "node:readline";
import { getPool, closePool } from "../server/database.mjs";
import { provisionInitialAdmin } from "../server/auth.mjs";

function ask(prompt, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    if (!hidden || !process.stdin.isTTY) {
      rl.question(prompt, (answer) => { rl.close(); resolve(answer); });
      return;
    }
    process.stdout.write(prompt);
    let answer = "";
    const input = (char) => {
      if (char === "\u0003") { process.stdin.off("data", input); rl.close(); reject(new Error("Cancelled.")); return; }
      if (char === "\r" || char === "\n") { process.stdin.off("data", input); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\n"); rl.close(); resolve(answer); return; }
      if (char === "\u007f") answer = answer.slice(0, -1); else answer += char;
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding("utf8"); process.stdin.on("data", input);
  });
}

try {
  const name = await ask("Administrator name: ");
  const email = await ask("Administrator email: ");
  const password = await ask("Password (12–72 characters): ", { hidden: true });
  if (password.length < 12 || Buffer.byteLength(password, "utf8") > 72) throw new Error("Password must contain 12–72 characters and at most 72 UTF-8 bytes.");
  const user = await provisionInitialAdmin(getPool(), { name, email, password });
  console.log(`Created initial administrator ${user.email} (${user.id}).`);
} catch (error) {
  console.error(`Administrator setup failed: ${error.message}`);
  process.exitCode = 1;
} finally { await closePool(); }
