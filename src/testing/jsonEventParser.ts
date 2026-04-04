/**
 * Parser for `go test -json` output stream.
 *
 * Each line of stdout from `go test -json` / `encore test -json` is a
 * JSON object describing a test event. This module parses those lines
 * into typed TestEvent objects.
 *
 * Reference: https://pkg.go.dev/cmd/test2json#hdr-Output_Format
 */

export type TestAction =
  | "run"
  | "pause"
  | "cont"
  | "pass"
  | "fail"
  | "skip"
  | "bench"
  | "output";

export interface TestEvent {
  /** Event timestamp. */
  Time?: string;
  /** The type of event. */
  Action: TestAction;
  /** Go package path (e.g. "myapp/users"). */
  Package: string;
  /** Test function name (e.g. "TestCreateUser"). Absent for package-level events. */
  Test?: string;
  /** Output text (only for "output" events). */
  Output?: string;
  /** Elapsed time in seconds (only for terminal events: pass, fail, skip). */
  Elapsed?: number;
}

/**
 * Parse a single line of `go test -json` output.
 * Returns a TestEvent if the line is valid JSON, or null for non-JSON lines
 * (e.g. compilation errors emitted before the JSON stream starts).
 */
export function parseTestEventLine(line: string): TestEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed[0] !== "{") {
    return null;
  }

  try {
    const event = JSON.parse(trimmed);
    if (typeof event.Action === "string" && typeof event.Package === "string") {
      return event as TestEvent;
    }
    return null;
  } catch {
    return null;
  }
}
