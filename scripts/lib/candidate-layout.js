// The public candidate lives in two layouts. In the producer checkout it is a
// subtree, candidate/, beside the private operating files. In the assembled
// public repository it is the root. Scripts that read candidate files resolve
// their root here so they behave in both. ENOENT on candidate/ means the root
// layout; any other error is a failed read and surfaces.
import { stat } from "node:fs/promises";
import { join } from "node:path";

export async function candidateRoot(repoRoot) {
  const nested = join(repoRoot, "candidate");
  try {
    const metadata = await stat(nested);
    return metadata.isDirectory() ? nested : repoRoot;
  } catch (error) {
    if (error.code === "ENOENT") return repoRoot;
    throw error;
  }
}
