// Retired. This filled in the tone of stored clips that had none, from the
// headline alone, and stored "neutral" for every clip the AI did not answer
// for. With the AI out of credit that made every clip it touched neutral, and
// since it only picked clips with no tone, a guessed one was never scored
// again. Positive Sentiment divides by scored clips, so the guesses sank it.
// The news bot (docs/news-pipeline.md) now sets the tone of each story it
// checks, and a clip with no tone stays without one.
//
// It answers 410 so an old script says what happened.
import { gone } from "@/lib/retired";

export const dynamic = "force-dynamic";

const MESSAGE =
  "The sentiment backfill has been retired: it stored a guessed neutral for every clip the AI did not score. The news bot now sets the tone of each story when it checks it.";

export function GET() {
  return gone(MESSAGE);
}

export function POST() {
  return gone(MESSAGE);
}
