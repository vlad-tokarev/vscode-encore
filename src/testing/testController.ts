import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

import { runEncoreTests, debugEncoreTest } from "./testRunner";
import {
  createEncoreTestItemId,
  parseEncoreTestItemId,
} from "./testItemId";
import { GO_FILE_EXCLUDE_GLOB, isVisibleWorkspaceFile } from "../utils/workspaceScan";
import { EncoreAppState } from "../utils/encoreAppState";

/**
 * Matches Go test, benchmark, and fuzz function declarations.
 * Captures the function name (e.g. "TestCreateUser", "BenchmarkSort").
 */
const TEST_FUNC_RE = /^func\s+(Test\w+|Benchmark\w+|Fuzz\w+)\s*\(/;

/**
 * Matches t.Run("subtest name", ...) calls inside test functions.
 * Captures the subtest name string. Handles both double and backtick quotes.
 * The receiver variable can be any identifier (t, tt, b, etc.).
 */
const SUBTEST_RE = /\b(\w+)\.Run\(\s*(?:"([^"]+)"|`([^`]+)`)/;

type EncoreRunnableTestKind = "test" | "benchmark" | "fuzz";

/**
 * Register the Encore test controller with VS Code's Testing API.
 *
 * Test hierarchy: module → package → file → function → subtest.
 * Provides Run and Debug profiles that execute tests via `encore test`.
 */
export function registerTestController(
  context: vscode.ExtensionContext,
  encoreAppState: EncoreAppState,
): vscode.TestController {
  const controller = vscode.tests.createTestController(
    "encoreTests",
    "Encore Tests",
  );
  context.subscriptions.push(controller);
  let refreshQueue = Promise.resolve();

  const refreshDiscoveredTestFiles = (): Promise<void> => {
    refreshQueue = refreshQueue.then(
      () => discoverTestFiles(controller, encoreAppState),
      () => discoverTestFiles(controller, encoreAppState),
    );
    return refreshQueue;
  };

  // --- Run profile: execute tests via `encore test -json` ---
  controller.createRunProfile(
    "Run Encore Tests",
    vscode.TestRunProfileKind.Run,
    async (request, token) => {
      const run = controller.createTestRun(request);
      await runEncoreTests(request, token, controller, run);
    },
    true, // isDefault
  );

  // --- Debug profile: compile with `encore test -c`, launch via dlv ---
  controller.createRunProfile(
    "Debug Encore Test",
    vscode.TestRunProfileKind.Debug,
    async (request, token) => {
      const run = controller.createTestRun(request);
      const items = request.include ?? [];
      for (const item of items) {
        run.started(item);
      }
      const { started, sessionDone } = await debugEncoreTest(request, token);
      if (started) {
        sessionDone.then((exitCode) => {
          for (const item of items) {
            if (exitCode === 0) {
              run.passed(item);
            } else {
              run.failed(item, new vscode.TestMessage("Test failed (exit code " + exitCode + ")"));
            }
          }
          run.end();
        });
      } else {
        run.end();
      }
    },
    true, // isDefault
  );

  // --- Lazy test discovery ---
  controller.resolveHandler = async (item) => {
    if (!item) {
      await refreshDiscoveredTestFiles();
      return;
    }

    const { kind } = parseEncoreTestItemId(item.id);
    if (kind === "file") {
      await parseTestFile(controller, item);
    }
  };

  // --- Watch for file changes to keep test items in sync ---
  const testFileWatcher = vscode.workspace.createFileSystemWatcher("**/*_test.go");

  testFileWatcher.onDidCreate(async (uri) => {
    if (!isVisibleWorkspaceFile(uri)) {
      return;
    }
    await syncFileInTree(controller, uri, encoreAppState);
  });

  testFileWatcher.onDidChange(async (uri) => {
    if (!isVisibleWorkspaceFile(uri)) {
      return;
    }
    await syncFileInTree(controller, uri, encoreAppState);
  });

  testFileWatcher.onDidDelete((uri) => {
    if (!isVisibleWorkspaceFile(uri)) {
      return;
    }
    removeFileFromTree(controller, uri);
  });

  context.subscriptions.push(testFileWatcher);
  context.subscriptions.push(
    encoreAppState.onDidChange(() => {
      void refreshDiscoveredTestFiles();
    }),
  );

  // Initial discovery.
  void refreshDiscoveredTestFiles();

  return controller;
}

// ---------------------------------------------------------------------------
// Package and file management
// ---------------------------------------------------------------------------

async function syncFileInTree(
  controller: vscode.TestController,
  uri: vscode.Uri,
  encoreAppState: EncoreAppState,
): Promise<void> {
  if (!(await encoreAppState.hasDiscoveredAppRootForFile(uri.fsPath))) {
    removeFileFromTree(controller, uri);
    return;
  }

  const fileItem = await getOrCreateFileItem(controller, uri);
  await parseTestFile(controller, fileItem);
}

function findFileItem(
  controller: vscode.TestController,
  uri: vscode.Uri,
): vscode.TestItem | undefined {
  return findTestItemRecursive(controller.items, (item) => {
    const { kind } = parseEncoreTestItemId(item.id);
    return kind === "file" && item.uri?.fsPath === uri.fsPath;
  });
}

function removeFileFromTree(
  controller: vscode.TestController,
  uri: vscode.Uri,
): void {
  const fileItem = findFileItem(controller, uri);
  if (!fileItem || !fileItem.parent) {
    return;
  }

  fileItem.parent.children.delete(fileItem.id);
  removeEmptyAncestors(fileItem.parent);
}

// ---------------------------------------------------------------------------
// Discovery and parsing
// ---------------------------------------------------------------------------

async function discoverTestFiles(
  controller: vscode.TestController,
  encoreAppState: EncoreAppState,
): Promise<void> {
  const files = await vscode.workspace.findFiles(
    "**/*_test.go",
    GO_FILE_EXCLUDE_GLOB,
  );

  const foundFileIds = new Set<string>();

  for (const uri of files) {
    if (!(await encoreAppState.hasDiscoveredAppRootForFile(uri.fsPath))) {
      continue;
    }

    const fileItem = await getOrCreateFileItem(controller, uri);
    foundFileIds.add(fileItem.id);
    await parseTestFile(controller, fileItem);
  }

  const staleFileItems: vscode.TestItem[] = [];
  controller.items.forEach((item) => {
    collectStaleFileItems(item, foundFileIds, staleFileItems);
  });

  for (const fileItem of staleFileItems) {
    if (!fileItem.parent) {
      continue;
    }
    fileItem.parent.children.delete(fileItem.id);
    removeEmptyAncestors(fileItem.parent);
  }
}

/** Parsed test function with its subtests. */
interface ParsedTestFunc {
  kind: EncoreRunnableTestKind;
  name: string;
  label: string;
  line: number;
  lineText: string;
  subtests: Array<{ name: string; line: number; lineText: string }>;
}

/**
 * Parse a *_test.go file and create/update child test items for each
 * Test*, Benchmark*, and Fuzz* function declaration, including
 * subtests declared via t.Run().
 */
async function parseTestFile(
  controller: vscode.TestController,
  fileItem: vscode.TestItem,
): Promise<void> {
  const uri = fileItem.uri;
  if (!uri) {
    return;
  }

  let content: string;
  try {
    content = await fs.promises.readFile(uri.fsPath, "utf-8");
  } catch {
    return;
  }

  const lines = content.split("\n");
  const testFuncs = parseTestFunctions(lines);

  // Sync file → test function items.
  const foundFuncIds = new Set<string>();

  for (const func of testFuncs) {
    const funcId = createEncoreTestItemId(uri, func.kind, func.name);
    foundFuncIds.add(funcId);

    const range = new vscode.Range(func.line, 0, func.line, func.lineText.length);
    let funcItem = fileItem.children.get(funcId);

    if (funcItem) {
      funcItem.range = range;
    } else {
      funcItem = controller.createTestItem(funcId, func.label, uri);
      funcItem.range = range;
      fileItem.children.add(funcItem);
    }
    funcItem.canResolveChildren = true;

    // Sync test function → subtest items.
    const foundSubIds = new Set<string>();

    for (const sub of func.subtests) {
      const subId = createEncoreTestItemId(
        uri,
        func.kind,
        `${func.name}/${sub.name}`,
      );
      foundSubIds.add(subId);

      const subRange = new vscode.Range(sub.line, 0, sub.line, sub.lineText.length);
      const existingSub = funcItem.children.get(subId);

      if (existingSub) {
        existingSub.range = subRange;
      } else {
        const subItem = controller.createTestItem(subId, sub.name, uri);
        subItem.range = subRange;
        funcItem.children.add(subItem);
      }
    }

    // Remove subtests that no longer exist.
    const subsToDelete: string[] = [];
    funcItem.children.forEach((child) => {
      if (!foundSubIds.has(child.id)) {
        subsToDelete.push(child.id);
      }
    });
    for (const id of subsToDelete) {
      funcItem.children.delete(id);
    }
  }

  // Remove top-level test functions that no longer exist.
  const funcsToDelete: string[] = [];
  fileItem.children.forEach((child) => {
    if (!foundFuncIds.has(child.id)) {
      funcsToDelete.push(child.id);
    }
  });
  for (const id of funcsToDelete) {
    fileItem.children.delete(id);
  }

  if (fileItem.children.size === 0) {
    removeEmptyAncestors(fileItem);
  }
}

/**
 * Parse test functions and their subtests from file lines.
 *
 * Subtests are associated with the most recent top-level test function.
 * Only first-level t.Run() calls are captured (nested subtests would
 * require full AST parsing and are omitted).
 */
function parseTestFunctions(lines: string[]): ParsedTestFunc[] {
  const result: ParsedTestFunc[] = [];
  let currentFunc: ParsedTestFunc | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for top-level test function.
    const funcMatch = line.match(TEST_FUNC_RE);
    if (funcMatch) {
      const funcName = funcMatch[1];
      currentFunc = {
        kind: functionKindFromName(funcName),
        name: funcName,
        label: functionLabelFromName(funcName),
        line: i,
        lineText: line,
        subtests: [],
      };
      result.push(currentFunc);
      continue;
    }

    // Check for t.Run() inside a test function.
    if (currentFunc) {
      const subMatch = line.match(SUBTEST_RE);
      if (subMatch) {
        const subtestName = subMatch[2] ?? subMatch[3];
        if (subtestName) {
          currentFunc.subtests.push({
            name: subtestName,
            line: i,
            lineText: line,
          });
        }
      }

      // Detect end of current function by a closing brace at column 0.
      // Go test functions are always top-level, so a `}` at column 0
      // that is not inside a string marks the end of the function body.
      if (line.length > 0 && line[0] === "}" && !line.startsWith("})")) {
        currentFunc = undefined;
      }
    }
  }

  return result;
}

function functionKindFromName(name: string): EncoreRunnableTestKind {
  if (name.startsWith("Benchmark")) {
    return "benchmark";
  }
  if (name.startsWith("Fuzz")) {
    return "fuzz";
  }
  return "test";
}

function functionLabelFromName(name: string): string {
  if (name.startsWith("Benchmark")) {
    return name.substring("Benchmark".length) || name;
  }
  if (name.startsWith("Fuzz")) {
    return name.substring("Fuzz".length) || name;
  }
  if (name.startsWith("Test")) {
    return name.substring("Test".length) || name;
  }
  return name;
}

async function getOrCreateFileItem(
  controller: vscode.TestController,
  uri: vscode.Uri,
): Promise<vscode.TestItem> {
  const fileUri = uri.with({ query: "", fragment: "" });
  const packageUri = vscode.Uri.file(path.dirname(fileUri.fsPath));
  const parent = await getOrCreatePackageItem(controller, packageUri);
  const fileId = createEncoreTestItemId(fileUri, "file");
  const existing = parent.children.get(fileId);
  if (existing) {
    return existing;
  }

  const fileItem = controller.createTestItem(fileId, path.basename(fileUri.fsPath), fileUri);
  fileItem.canResolveChildren = true;
  parent.children.add(fileItem);
  return fileItem;
}

async function getOrCreatePackageItem(
  controller: vscode.TestController,
  packageUri: vscode.Uri,
): Promise<vscode.TestItem> {
  const moduleUri = await findModuleRoot(packageUri);
  const moduleItem = await getOrCreateModuleItem(controller, moduleUri);

  if (packageUri.fsPath === moduleUri.fsPath) {
    return moduleItem;
  }

  const relativePath = path.relative(moduleUri.fsPath, packageUri.fsPath);
  const segments = relativePath.split(path.sep).filter(Boolean);
  let parent = moduleItem;
  let currentPath = moduleUri.fsPath;

  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    const currentUri = vscode.Uri.file(currentPath);
    const packageId = createEncoreTestItemId(currentUri, "package");
    let packageItem = parent.children.get(packageId);

    if (!packageItem) {
      packageItem = controller.createTestItem(packageId, segment, currentUri);
      packageItem.canResolveChildren = true;
      parent.children.add(packageItem);
    }

    parent = packageItem;
  }

  return parent;
}

async function getOrCreateModuleItem(
  controller: vscode.TestController,
  moduleUri: vscode.Uri,
): Promise<vscode.TestItem> {
  const moduleId = createEncoreTestItemId(moduleUri, "module");
  const existing = controller.items.get(moduleId);
  if (existing) {
    return existing;
  }

  const moduleLabel = await readModuleLabel(moduleUri);
  const moduleItem = controller.createTestItem(moduleId, moduleLabel, moduleUri);
  moduleItem.canResolveChildren = true;
  controller.items.add(moduleItem);
  return moduleItem;
}

async function readModuleLabel(moduleUri: vscode.Uri): Promise<string> {
  const goModPath = path.join(moduleUri.fsPath, "go.mod");

  try {
    const goModContent = await fs.promises.readFile(goModPath, "utf-8");
    const moduleMatch = goModContent.match(/^module\s+([^\s]+)/m);
    if (moduleMatch?.[1]) {
      return moduleMatch[1];
    }
  } catch {
    // Fall back to the folder name when go.mod is missing or unreadable.
  }

  return path.basename(moduleUri.fsPath);
}

async function findModuleRoot(uri: vscode.Uri): Promise<vscode.Uri> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  const workspaceRoot = workspaceFolder?.uri.fsPath;
  const rootPath = workspaceRoot ?? path.parse(uri.fsPath).root;
  let currentPath = uri.fsPath;

  while (true) {
    if (await pathExists(path.join(currentPath, "go.mod"))) {
      return vscode.Uri.file(currentPath);
    }

    if (currentPath === rootPath) {
      return workspaceFolder?.uri ?? vscode.Uri.file(currentPath);
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return workspaceFolder?.uri ?? vscode.Uri.file(currentPath);
    }
    currentPath = parentPath;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function findTestItemRecursive(
  items: vscode.TestItemCollection,
  predicate: (item: vscode.TestItem) => boolean,
): vscode.TestItem | undefined {
  let match: vscode.TestItem | undefined;

  items.forEach((item) => {
    if (match) {
      return;
    }

    if (predicate(item)) {
      match = item;
      return;
    }

    match = findTestItemRecursive(item.children, predicate);
  });

  return match;
}

function collectStaleFileItems(
  item: vscode.TestItem,
  foundFileIds: ReadonlySet<string>,
  staleFileItems: vscode.TestItem[],
): void {
  const { kind } = parseEncoreTestItemId(item.id);
  if (kind === "file" && !foundFileIds.has(item.id)) {
    staleFileItems.push(item);
    return;
  }

  item.children.forEach((child) => {
    collectStaleFileItems(child, foundFileIds, staleFileItems);
  });
}

function removeEmptyAncestors(item: vscode.TestItem | undefined): void {
  let currentItem = item;

  while (currentItem) {
    const { kind } = parseEncoreTestItemId(currentItem.id);
    if (kind === "module" || currentItem.children.size > 0 || !currentItem.parent) {
      return;
    }

    const parent = currentItem.parent;
    parent.children.delete(currentItem.id);
    currentItem = parent;
  }
}
