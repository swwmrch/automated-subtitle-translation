import { NextRequest, NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { sessionOptions, type SessionData } from "@/lib/session";
import { loginRatelimit } from "@/lib/ratelimit";
import fs from "fs";

function persistCustomKey(apiKey: string | undefined) {
  const configPath = process.env.KMTV_CONFIG_PATH;
  if (!configPath) return;
  try {
    const existing = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, "utf8"))
      : {};
    existing.customApiKey = apiKey ?? null;
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), "utf8");
  } catch {
    // Non-fatal — session still holds the key for this run
  }
}

export async function POST(request: NextRequest) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anonymous";

  if (loginRatelimit) {
    const { success } = await loginRatelimit.limit(ip);
    if (!success) {
      return NextResponse.json(
        { error: "Too many attempts. Try again later." },
        { status: 429 }
      );
    }
  }

  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);

  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { password, apiKey } = (body ?? {}) as { password?: string; apiKey?: string };

  if (password !== process.env.APP_PASSWORD) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 403 });
  }

  if (apiKey !== undefined) {
    // Save mode — persist to config.json and session
    session.customApiKey = apiKey.trim() || undefined;
    await session.save();
    persistCustomKey(session.customApiKey);
    return NextResponse.json({ ok: true });
  }

  // Unlock mode — return the current active key
  const currentKey = session.customApiKey ?? process.env.CUSTOM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  return NextResponse.json({ ok: true, apiKey: currentKey });
}
