/**
 * One-time interactive login.
 *
 *   npm run login
 *
 * Prompts for email, password (hidden) and — if active — the MFA code, performs
 * the login and stores ONLY the tokens locally. The password is never stored.
 *
 * We deliberately read stdin OURSELVES in raw mode instead of via `readline`:
 * readline redraws the input line on every keystroke via cursorTo()/clearScreenDown()
 * (directly on stdout, not through the mute hook), which would wipe a manually
 * printed password prompt. This way we keep full control: the prompt stays put and
 * the password only ever shows as asterisks.
 */
import { ImpersonatedHttp } from "../http/impersonate.js";
import * as auth from "../garmin/auth.js";
import { GarminClient } from "../garmin/client.js";
import * as tokens from "../garmin/tokens.js";
import { TOKEN_FILE } from "../garmin/tokens.js";

// Control characters as char codes (no invisible string literals in the code).
const LF = 10; // \n
const CR = 13; // \r  (Enter in raw mode)
const ETX = 3; // Ctrl-C
const EOT = 4; // Ctrl-D
const BS = 8; // Backspace (Ctrl-H)
const DEL = 127; // DEL (Backspace key on macOS/Linux)
const SPACE = 32; // first printable character

class Prompt {
  /** Leftover bytes after a newline (relevant for piped input). */
  private pending = "";

  /** Visible input line. */
  async ask(promptText: string): Promise<string> {
    process.stdout.write(promptText);
    return (await this.readLine(false)).trim();
  }

  /** Hidden input: the prompt stays visible, characters show as '*'. */
  async askHidden(promptText: string): Promise<string> {
    process.stdout.write(promptText);
    return (await this.readLine(true)).trim();
  }

  private readLine(mask: boolean): Promise<string> {
    const stdin = process.stdin;
    const isTTY = Boolean(stdin.isTTY);
    return new Promise<string>((resolve, reject) => {
      let input = "";
      let done = false;

      const finish = (after: () => void): void => {
        if (done) return;
        done = true;
        stdin.removeListener("data", onData);
        if (isTTY && stdin.setRawMode) stdin.setRawMode(false);
        stdin.pause();
        after();
      };

      const consume = (data: string): void => {
        for (let i = 0; i < data.length; i++) {
          const code = data.charCodeAt(i);
          if (code === LF || code === CR || code === EOT) {
            this.pending = data.slice(i + 1);
            finish(() => {
              if (isTTY) process.stdout.write("\n");
              resolve(input);
            });
            return;
          }
          if (code === ETX) {
            finish(() => {
              process.stdout.write("\n");
              reject(new Error("Aborted (Ctrl-C)."));
            });
            return;
          }
          if (code === BS || code === DEL) {
            if (input.length > 0) {
              input = input.slice(0, -1);
              if (isTTY) process.stdout.write("\b \b");
            }
            continue;
          }
          if (code >= SPACE) {
            const ch = data[i];
            input += ch;
            if (isTTY) process.stdout.write(mask ? "*" : ch);
          }
        }
      };

      const onData = (chunk: Buffer | string): void =>
        consume(typeof chunk === "string" ? chunk : chunk.toString("utf8"));

      if (isTTY && stdin.setRawMode) stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);

      // First process any leftover bytes from a previous chunk.
      if (this.pending) {
        const rest = this.pending;
        this.pending = "";
        consume(rest);
      }
    });
  }
}

async function main(): Promise<void> {
  console.log(
    "Garmin login (one-time).\n" +
      "Note: the password is NOT stored — it is only used for this login.\n",
  );

  const prompt = new Prompt();
  const http = new ImpersonatedHttp();
  try {
    const email = await prompt.ask("Email: ");
    const password = await prompt.askHidden("Password: ");

    if (!email || !password) {
      console.error("\n❌ Email and password must not be empty.");
      process.exitCode = 1;
      return;
    }

    console.log("\nSigning in ...");
    const result = await auth.login(http, email, password, async (method) => {
      return prompt.ask(`MFA code (${method}): `);
    });

    const stored = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      diClientId: result.diClientId,
      serviceUrl: result.serviceUrl,
      expiresAt: result.expiresAt,
    };
    await tokens.save(stored);

    // Load the profile (confirms the connection and caches the account name).
    // Build the client from the fresh tokens — no re-read from disk.
    let name = email;
    try {
      const client = GarminClient.from(http, stored);
      const who = await client.whoami();
      name = who.fullName || who.displayName || email;
    } catch {
      // Login succeeded; only the profile fetch failed — not fatal.
    }

    console.log(`\n✅ Logged in as ${name}.`);
    console.log(`   Tokens stored at ${TOKEN_FILE} (mode 0600).`);
    console.log("   The password was not stored.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Login failed: ${msg}`);
    process.exitCode = 1;
  } finally {
    await http.close();
  }
}

void main();
