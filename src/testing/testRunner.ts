import * as vscode from "vscode";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";

import { parseTestEventLine, TestEvent } from "./jsonEventParser";
import { parseEncoreTestItemId } from "./testItemId";
import { buildEncoreEnv, isEncoreCliAvailable, promptMissingCli } from "../utils/encoreEnv";

/**
 * Compute the relative package path for `encore test` from a file URI.
 * Returns a "./<relative-dir>/..." style path suitable for `encore test`.
 */
function packagePathFromFile(fileUri: vscode.Uri, workspaceRoot: string): string {
  const dir = path.dirname(fileUri.fsPath);
  const rel = path.relative(workspaceRoot, dir);
  return `./${rel.replace(/\\/g, "/")}`;
}

/**
 * Group test items by their package directory so each `encore test`
 * invocation covers one package.
 */
interface PackageGroup {
  /** Relative package path for `encore test` (e.g. "./users"). */
  packagePath: string;
  /** Test function names to run. Empty array means run all tests in the package. */
  testNames: string[];
  /** TestItems in this group (for reporting results). */
  items: vscode.TestItem[];
}

function groupByPackage(
  items: readonly vscode.TestItem[],
  workspaceRoot: string,
): PackageGroup[] {
  const groups = new Map<string, PackageGroup>();

  for (const item of items) {
    if (!item.uri) {
      continue;
    }

    const pkgPath = packagePathFromFile(item.uri, workspaceRoot);

    let group = groups.get(pkgPath);
    if (!group) {
      group = { packagePath: pkgPath, testNames: [], items: [] };
      groups.set(pkgPath, group);
    }

    group.items.push(item);

    const runPattern = extractRunPattern(item);

    if (!runPattern) {
      // File-level item — run all tests in the package.
      group.testNames = [];
    } else if (group.testNames.length >= 0) {
      group.testNames.push(runPattern);
    }
  }

  return [...groups.values()];
}

/**
 * Extract the `-run` pattern from a test item ID.
 *
 * Returns the test name (including subtest path) for function-level
 * and subtest-level items, or undefined for file-level items.
 *
 * For subtests, Go's `-run` flag uses `/` as separator and regex
 * matching, so "TestFoo/subtest name" becomes the -run pattern
 * "TestFoo/subtest name" (spaces are matched literally by Go).
 */
function extractRunPattern(item: vscode.TestItem): string | undefined {
  const { kind, name } = parseEncoreTestItemId(item.id);
  if (kind !== "test" && kind !== "benchmark" && kind !== "fuzz") {
    return undefined;
  }
  return name;
}

/**
 * Run Encore tests for the given TestRunRequest.
 *
 * Spawns `encore test -json -count=1 [-run=<regex>] <package>` for each
 * package group, parses the JSON event stream, and reports results via
 * the VS Code TestRun API.
 */
export async function runEncoreTests(
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
  controller: vscode.TestController,
  run: vscode.TestRun,
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    run.end();
    return;
  }

  if (!isEncoreCliAvailable()) {
    await promptMissingCli();
    run.end();
    return;
  }

  // Collect runnable items from the controller tree.
  const itemsToRun: vscode.TestItem[] = [];
  const collectItems = (items: readonly vscode.TestItem[]) => {
    for (const item of items) {
      const { kind } = parseEncoreTestItemId(item.id);
      if (kind === "file" || kind === "test" || kind === "benchmark" || kind === "fuzz") {
        itemsToRun.push(item);
      } else {
        item.children.forEach((child) => collectItems([child]));
      }
    }
  };
  if (request.include) {
    collectItems(request.include);
  } else {
    const topLevel: vscode.TestItem[] = [];
    controller.items.forEach((item) => topLevel.push(item));
    collectItems(topLevel);
  }

  const groups = groupByPackage(itemsToRun, workspaceRoot);

  // Build a lookup map for result reporting.
  // Keys are "pkgPath::TestName" or "pkgPath::TestName/subtest" for subtests.
  const itemLookup = new Map<string, vscode.TestItem>();
  for (const group of groups) {
    for (const item of group.items) {
      registerItemRecursive(item, workspaceRoot, itemLookup);
    }
  }

  // Mark all items as started.
  for (const [, item] of itemLookup) {
    run.started(item);
  }

  for (const group of groups) {
    if (token.isCancellationRequested) {
      break;
    }
    await runPackageTests(group, workspaceRoot, run, itemLookup, token);
  }

  run.end();
}

/**
 * Run tests for a single package and stream results.
 */
async function runPackageTests(
  group: PackageGroup,
  workspaceRoot: string,
  run: vscode.TestRun,
  itemLookup: Map<string, vscode.TestItem>,
  token: vscode.CancellationToken,
): Promise<void> {
  const args = ["test", "-json", "-count=1"];

  // Add -run filter when specific test functions or subtests are selected.
  if (group.testNames.length > 0) {
    const pattern = buildRunPattern(group.testNames);
    args.push(`-run=${pattern}`);
  }

  args.push(group.packagePath);

  const child = spawn("encore", args, {
    cwd: workspaceRoot,
    env: buildEncoreEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Kill the process if the user cancels the test run.
  const cancelListener = token.onCancellationRequested(() => {
    child.kill("SIGTERM");
  });

  // Collect non-JSON stderr lines for error reporting.
  const stderrChunks: string[] = [];

  // Accumulate output lines per test for failure messages.
  // Key: "Package::TestName" or "Package" for package-level output.
  const testOutputMap = new Map<string, string[]>();

  await new Promise<void>((resolve) => {
    let buffer = "";

    child.stdout!.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      // Keep the last incomplete line in the buffer.
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        processEventLine(line, group.packagePath, run, itemLookup, testOutputMap);
      }
    });

    child.stderr!.on("data", (data: Buffer) => {
      const text = data.toString();
      stderrChunks.push(text);
      run.appendOutput(text.replace(/\n/g, "\r\n"));
    });

    child.on("close", (code) => {
      // Flush remaining buffer.
      if (buffer.trim().length > 0) {
        processEventLine(buffer, group.packagePath, run, itemLookup, testOutputMap);
      }

      // If encore test exited with an error and no JSON was emitted
      // (e.g. compilation failure), report the error on all group items.
      if (code !== 0 && stderrChunks.length > 0) {
        const errorText = stderrChunks.join("");
        for (const item of group.items) {
          const message = new vscode.TestMessage(errorText);
          run.errored(item, message);
        }
      }

      cancelListener.dispose();
      resolve();
    });
  });
}

/**
 * Process a single line from the `encore test -json` output stream
 * and update the TestRun accordingly.
 */
function processEventLine(
  line: string,
  packagePath: string,
  run: vscode.TestRun,
  itemLookup: Map<string, vscode.TestItem>,
  testOutputMap: Map<string, string[]>,
): void {
  const event = parseTestEventLine(line);
  if (!event) {
    // Non-JSON line — append as raw output.
    run.appendOutput(line.replace(/\n/g, "\r\n") + "\r\n");
    return;
  }

  const item = resolveTestItem(event, packagePath, itemLookup);
  const outputKey = event.Test
    ? `${event.Package}::${event.Test}`
    : event.Package;

  switch (event.Action) {
    case "output":
      if (event.Output) {
        // Accumulate output per test for failure messages.
        let outputs = testOutputMap.get(outputKey);
        if (!outputs) {
          outputs = [];
          testOutputMap.set(outputKey, outputs);
        }
        outputs.push(event.Output);

        run.appendOutput(
          event.Output.replace(/\n/g, "\r\n"),
          undefined,
          item,
        );
      }
      break;

    case "pass": {
      const duration = event.Elapsed ? event.Elapsed * 1000 : undefined;
      if (item) {
        run.passed(item, duration);
      }
      // Clean up accumulated output for passed tests.
      testOutputMap.delete(outputKey);
      break;
    }

    case "fail": {
      const duration = event.Elapsed ? event.Elapsed * 1000 : undefined;
      if (item) {
        const outputs = testOutputMap.get(outputKey) ?? [];
        const failureText = extractFailureMessage(outputs);
        const message = new vscode.TestMessage(failureText);
        run.failed(item, message, duration);
      }
      testOutputMap.delete(outputKey);
      break;
    }

    case "skip":
      if (item) {
        run.skipped(item);
      }
      testOutputMap.delete(outputKey);
      break;

    // "run", "pause", "cont", "bench" — no action needed beyond output.
    default:
      break;
  }
}

/**
 * Extract a human-readable failure message from accumulated test output lines.
 *
 * Filters out irrelevant lines (--- FAIL, === RUN, FAIL package) and
 * keeps the actual assertion/error output from the test.
 */
function extractFailureMessage(outputs: string[]): string {
  const meaningful = outputs.filter((line) => {
    const trimmed = line.trim();
    // Skip empty lines, test framework banners, and redundant markers.
    if (trimmed.length === 0) { return false; }
    if (trimmed.startsWith("=== RUN")) { return false; }
    if (trimmed.startsWith("=== PAUSE")) { return false; }
    if (trimmed.startsWith("=== CONT")) { return false; }
    if (trimmed.startsWith("--- FAIL")) { return false; }
    if (trimmed.startsWith("--- PASS")) { return false; }
    if (trimmed.startsWith("--- SKIP")) { return false; }
    if (trimmed.startsWith("FAIL\t")) { return false; }
    if (trimmed === "FAIL") { return false; }
    return true;
  });

  if (meaningful.length === 0) {
    return "Test failed (no output)";
  }

  return meaningful.join("").trimEnd();
}

/**
 * Recursively register a test item and all its children into the lookup map.
 */
function registerItemRecursive(
  item: vscode.TestItem,
  workspaceRoot: string,
  itemLookup: Map<string, vscode.TestItem>,
): void {
  if (item.uri) {
    const pkgPath = packagePathFromFile(item.uri, workspaceRoot);
    const { kind, name } = parseEncoreTestItemId(item.id);

    if (kind === "file") {
      itemLookup.set(pkgPath, item);
    } else if ((kind === "test" || kind === "benchmark" || kind === "fuzz") && name) {
      itemLookup.set(`${pkgPath}::${name}`, item);
    }
  }

  item.children.forEach((child) => {
    registerItemRecursive(child, workspaceRoot, itemLookup);
  });
}

/**
 * Resolve a TestEvent to the matching TestItem.
 *
 * Events reference tests by Go package path (e.g. "myapp/users") and
 * test name (e.g. "TestCreateUser" or "TestCreateUser/subtest_name").
 *
 * Go replaces spaces in subtest names with underscores in the JSON
 * output, so "no cache for conversations" becomes
 * "no_cache_for_conversations". Try exact match first, then fall back
 * to matching with spaces replaced by underscores.
 */
function resolveTestItem(
  event: TestEvent,
  packagePath: string,
  itemLookup: Map<string, vscode.TestItem>,
): vscode.TestItem | undefined {
  if (!event.Test) {
    return itemLookup.get(packagePath);
  }

  // Try exact match (works for top-level tests and subtests without spaces).
  const exactKey = `${packagePath}::${event.Test}`;
  const exactMatch = itemLookup.get(exactKey);
  if (exactMatch) {
    return exactMatch;
  }

  // Go replaces spaces with underscores in JSON output. Try matching
  // by converting underscores back to spaces in the subtest portion.
  if (event.Test.includes("/")) {
    const slashIdx = event.Test.indexOf("/");
    const funcName = event.Test.substring(0, slashIdx);
    const subtestName = event.Test.substring(slashIdx + 1).replace(/_/g, " ");
    const spaceKey = `${packagePath}::${funcName}/${subtestName}`;
    const spaceMatch = itemLookup.get(spaceKey);
    if (spaceMatch) {
      return spaceMatch;
    }
  }

  // Fall back to the parent test function.
  const topLevelTest = event.Test.includes("/")
    ? event.Test.substring(0, event.Test.indexOf("/"))
    : event.Test;
  return itemLookup.get(`${packagePath}::${topLevelTest}`);
}

/**
 * Build a `-run` regex pattern from test names that may include subtests.
 *
 * Go's `-run` flag matches test names with `/` separating parent and
 * subtest. Each segment is matched independently as a regex.
 *
 * Examples:
 *   ["TestFoo"]                     → "^TestFoo$"
 *   ["TestFoo", "TestBar"]          → "^(TestFoo|TestBar)$"
 *   ["TestFoo/my subtest"]          → "^TestFoo$/^my subtest$"
 *   ["TestFoo/sub1", "TestFoo/sub2"] → "^TestFoo$/^(sub1|sub2)$"
 */
function buildRunPattern(testNames: string[]): string {
  // Separate top-level tests from subtests.
  const topLevel: string[] = [];
  const subtestsByParent = new Map<string, string[]>();

  for (const name of testNames) {
    const slashIdx = name.indexOf("/");
    if (slashIdx === -1) {
      topLevel.push(escapeRegex(name));
    } else {
      const parent = name.substring(0, slashIdx);
      const subtest = name.substring(slashIdx + 1);
      let subs = subtestsByParent.get(parent);
      if (!subs) {
        subs = [];
        subtestsByParent.set(parent, subs);
      }
      subs.push(escapeRegex(subtest));
    }
  }

  const parts: string[] = [];

  // Top-level tests without subtests.
  if (topLevel.length > 0) {
    parts.push(`^(${topLevel.join("|")})$`);
  }

  // Tests with specific subtests.
  for (const [parent, subs] of subtestsByParent) {
    parts.push(`^${escapeRegex(parent)}$/^(${subs.join("|")})$`);
  }

  // If mixed top-level and subtest patterns exist, join with |.
  // However, -run only accepts one pattern, so when we have both
  // top-level and subtest filters we need multiple `-run` args or
  // a combined pattern. For simplicity, join the parent-level names.
  if (parts.length === 1) {
    return parts[0];
  }

  // Fallback: combine all parent names and let subtests run too.
  const allParents = [
    ...topLevel,
    ...[...subtestsByParent.keys()].map(escapeRegex),
  ];
  return `^(${allParents.join("|")})$`;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Debug an Encore test by compiling with `encore test -c` and launching
 * dlv via the Go extension's debug adapter.
 *
 * Returns immediately after the debugger starts. The `sessionDone` promise
 * resolves with the debuggee exit code (0 = pass, non-zero = fail) when
 * the debug session terminates.
 */
export async function debugEncoreTest(
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
): Promise<{ started: boolean; sessionDone: Promise<number> }> {
  const notStarted = { started: false, sessionDone: Promise.resolve(1) };

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return notStarted;
  }

  if (!isEncoreCliAvailable()) {
    await promptMissingCli();
    return notStarted;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;

  // Debug supports a single test item.
  const item = request.include?.[0];
  if (!item?.uri) {
    vscode.window.showWarningMessage("Select a test function to debug.");
    return notStarted;
  }

  const pkgDir = path.dirname(item.uri.fsPath);
  const relPkg = `./${path.relative(workspaceRoot, pkgDir).replace(/\\/g, "/")}`;

  const { kind, name: testPath } = parseEncoreTestItemId(item.id);
  const selectedRunnableTest = kind === "test" || kind === "benchmark" || kind === "fuzz";
  const runnableTestPath = selectedRunnableTest ? testPath : undefined;

  const testLabel = runnableTestPath || relPkg;

  // Determined from DAP output events: true if "PASS" seen, false if "FAIL" seen.
  let testPassed = false;
  let resolveSessionDone: (code: number) => void;
  const sessionDone = new Promise<number>((resolve) => {
    resolveSessionDone = resolve;
  });

  const started = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Compiling test binary for ${testLabel}…`,
      cancellable: true,
    },
    async (progress, progressToken): Promise<boolean> => {
      // Forward cancellation from the progress notification to the test run token.
      const cts = new vscode.CancellationTokenSource();
      token.onCancellationRequested(() => cts.cancel());
      progressToken.onCancellationRequested(() => cts.cancel());
      const combinedToken = cts.token;

      // Compile the test binary using `encore test -c`.
      const os = await import("os");
      const tmpDir = path.join(os.tmpdir(), `encore-test-${Date.now()}`);
      const fs = await import("fs");
      await fs.promises.mkdir(tmpDir, { recursive: true });

      const binaryName = process.platform === "win32" ? "test.exe" : "test.bin";
      const binaryPath = path.join(tmpDir, binaryName);

      const compiled = await compileTestBinary(relPkg, binaryPath, workspaceRoot, combinedToken);
      if (!compiled) {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        resolveSessionDone(1);
        return false;
      }

      progress.report({ message: "Starting debugger…" });

      // Build the debug launch configuration.
      const debugArgs: string[] = [];
      if (runnableTestPath) {
        if (runnableTestPath.includes("/")) {
          const slashIdx = runnableTestPath.indexOf("/");
          const parentName = runnableTestPath.substring(0, slashIdx);
          const subtestName = runnableTestPath.substring(slashIdx + 1);
          debugArgs.push("-test.run", `^${escapeRegex(parentName)}$/^${escapeRegex(subtestName)}$`);
        } else {
          debugArgs.push("-test.run", `^${escapeRegex(runnableTestPath)}$`);
        }
      }

      const debugConfig: vscode.DebugConfiguration = {
        type: "go",
        request: "launch",
        name: `Encore Test: ${testLabel}`,
        mode: "exec",
        program: binaryPath,
        args: debugArgs,
        env: { ENCORE_RUNTIME_LOG: "error" },
        cwd: workspaceRoot,
      };

      // Track the debug session to capture test outcome from stdout.
      // Go test binaries print "PASS" or "FAIL" as the final line.
      let trackedSessionId: string | undefined;

      const trackerDisposable = vscode.debug.registerDebugAdapterTrackerFactory("go", {
        createDebugAdapterTracker(session) {
          trackedSessionId = session.id;
          return {
            onDidSendMessage(message: { type?: string; event?: string; body?: { output?: string; category?: string } }) {
              if (message.type === "event" && message.event === "output" && message.body?.output) {
                const output = message.body.output.trim();
                if (output === "PASS") {
                  testPassed = true;
                } else if (output === "FAIL" || output.startsWith("FAIL\t")) {
                  testPassed = false;
                }
              }
            },
          };
        },
      });

      // Clean up the temp directory and resolve sessionDone when the debug session ends.
      const terminateDisposable = vscode.debug.onDidTerminateDebugSession(async (session) => {
        if (trackedSessionId && session.id === trackedSessionId) {
          terminateDisposable.dispose();
          trackerDisposable.dispose();
          await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          resolveSessionDone(testPassed ? 0 : 1);
        }
      });

      const ok = await vscode.debug.startDebugging(workspaceFolder, debugConfig);

      if (ok) {
        await vscode.commands.executeCommand("workbench.debug.action.focusRepl");
      } else {
        terminateDisposable.dispose();
        trackerDisposable.dispose();
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        resolveSessionDone(1);
      }

      cts.dispose();
      return ok;
    },
  );

  return { started, sessionDone };
}

/**
 * Compile a test binary using `encore test -c`.
 * Returns true on success, false on failure.
 */
function compileTestBinary(
  packagePath: string,
  outputPath: string,
  workspaceRoot: string,
  token: vscode.CancellationToken,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("encore", ["test", "-c", "-o", outputPath, packagePath], {
      cwd: workspaceRoot,
      env: buildEncoreEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const cancelListener = token.onCancellationRequested(() => {
      child.kill("SIGTERM");
    });

    const stderrChunks: string[] = [];

    child.stderr!.on("data", (data: Buffer) => {
      stderrChunks.push(data.toString());
    });

    child.on("close", (code) => {
      cancelListener.dispose();
      if (code !== 0) {
        const errorOutput = stderrChunks.join("");
        vscode.window.showErrorMessage(
          `Failed to compile Encore test binary: ${errorOutput.substring(0, 500)}`,
        );
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}
