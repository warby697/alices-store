import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// DEV-ONLY fallback store: one JSON file standing in for the live database.
//
// Every route used to keep its OWN read-modify-write queue on this file.
// That let two routes hit the file at the same moment (a basket save and a
// stock delta can fire from one tap): one read a half-written file, parsed
// nothing, and wrote the whole state back rebuilt from "no data" - the same
// whole-list clobber the production database was locked against on 8 Sep,
// just local. Every dev read and write now goes through this single queue.
const localStateFile = join(process.cwd(), ".local", "store-state.json");

// The queue must live on globalThis, not in a module variable: the dev
// bundler gives every route its own copy of this module, so a module-level
// variable would be a separate "lock" per route - no lock at all. One
// process-wide queue is the whole point.
const shared = globalThis as { __aliceLocalStateQueue?: Promise<unknown> };

const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
  const queue = shared.__aliceLocalStateQueue ?? Promise.resolve();
  const run = queue.then(task, task);
  shared.__aliceLocalStateQueue = run.then(() => undefined, () => undefined);
  return run;
};

async function readState(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(localStateFile, "utf8")) as Record<string, unknown>;
  } catch (error) {
    // No file yet is just a fresh dev environment. Anything else (a parse
    // error, a permissions problem) must FAIL the request - treating a broken
    // read as "no data" is how a whole state gets clobbered.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw error;
  }
}

export function readLocalState(): Promise<Record<string, unknown>> {
  return enqueue(readState);
}

// Apply a change to the current state and persist it, all inside the queue.
// The write lands in a temp file first and renames into place, so a crash
// mid-write can never leave half a JSON file behind for the next read.
export function mutateLocalState<T>(mutate: (state: Record<string, unknown>) => { state: Record<string, unknown>; result: T }): Promise<T> {
  return enqueue(async () => {
    const current = await readState();
    const { state, result } = mutate(current);
    await mkdir(dirname(localStateFile), { recursive: true });
    const temp = `${localStateFile}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temp, localStateFile);
    return result;
  });
}
