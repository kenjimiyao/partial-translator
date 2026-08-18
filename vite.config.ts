import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    target: "chrome140",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        options: resolve(projectRoot, "options.html"),
        background: resolve(projectRoot, "src/background/index.ts"),
        content: resolve(projectRoot, "src/content/index.ts"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "background" || chunk.name === "content"
            ? "[name].js"
            : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
