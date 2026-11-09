// Whether a module is the script Node was asked to run, as opposed to one a
// test or another script imported. Comparing import.meta.url with
// `file://${process.argv[1]}` is wrong twice over: Node resolves symlinks in
// import.meta.url (macOS's /var is /private/var) and percent-encodes it, so a
// checkout reached through a symlink, or at a path with a space, matched
// neither, and the script did nothing and exited 0.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const runDirectly = (metaUrl) =>
  Boolean(process.argv[1]) && metaUrl === pathToFileURL(realpathSync(process.argv[1])).href;
