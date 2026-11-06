// What a retired route answers: 410 Gone, with a message that says what took
// its place, so an old script, a bookmark or a page left open says what
// happened rather than failing without a word.
import { NextResponse } from "next/server";

export function gone(message: string) {
  return NextResponse.json({ ok: false, error: "gone", message }, { status: 410 });
}
