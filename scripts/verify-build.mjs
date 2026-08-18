import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  "dist/manifest.json",
  "dist/background.js",
  "dist/content.js",
  "dist/options.html",
];

await Promise.all(requiredFiles.map((file) => access(file)));

const manifest = JSON.parse(await readFile("dist/manifest.json", "utf8"));
if (manifest.manifest_version !== 3) {
  throw new Error("dist/manifest.json is not Manifest V3");
}

const content = await readFile("dist/content.js", "utf8");
if (/(^|;)\s*(?:import|export)\b/m.test(content)) {
  throw new Error(
    "content.js contains ESM syntax and cannot run as a classic content script",
  );
}
if (/\bimport\s*\(/u.test(content)) {
  throw new Error(
    "content.js contains a dynamic import and is not a self-contained classic script",
  );
}
for (const secretBoundaryToken of [
  "openaiApiKey",
  "Authorization",
  "api.openai.com",
  "storage.local",
]) {
  if (content.includes(secretBoundaryToken)) {
    throw new Error(
      `content.js crosses the API-key boundary (${secretBoundaryToken})`,
    );
  }
}
try {
  // Parse without executing. Static import/export syntax is invalid here,
  // exactly as it is in a classic Chrome content script.
  new Function(content);
} catch (error) {
  throw new Error("content.js is not valid classic-script syntax", { cause: error });
}

console.log("Verified loadable Manifest V3 output in dist/.");
