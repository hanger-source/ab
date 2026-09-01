import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "LICENSE");
const destination = resolve(root, "sdk/ts/LICENSE");

await copyFile(source, destination);
console.log(destination);
