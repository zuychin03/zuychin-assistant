import { NextRequest, NextResponse } from "next/server";

async function computeToken(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + "zuychin-auth-salt-v1");
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function POST(req: NextRequest) {
  const { password } = await req.json();
  const expected = process.env.ACCESS_PASSWORD;

  if (!expected) {
    return NextResponse.json({ error: "Access password not configured" }, { status: 500 });
  }

  if (password !== expected) {
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }

  const token = await computeToken(expected);
  const res = NextResponse.json({ ok: true });

  res.cookies.set("zuychin-auth", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });

  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("zuychin-auth", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
