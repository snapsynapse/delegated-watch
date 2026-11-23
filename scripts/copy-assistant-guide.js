import { copyFile } from "node:fs/promises";

await copyFile("docs/.well-known/assistant-guide.txt", "assistant-guide.txt");
