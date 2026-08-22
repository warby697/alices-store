import { access, cp, lstat, readlink, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const roots = [resolve(".next")];

async function materialize(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      const target = resolve(dirname(path), await readlink(path));
      await rm(path);
      await cp(target, path, { recursive: true });
    } else if (stat.isDirectory()) {
      await materialize(path);
    }
  }
}

for (const root of roots) {
  try {
    await access(root);
    await materialize(root);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
