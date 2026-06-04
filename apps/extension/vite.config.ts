import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";

/** Content script entry points that must be wrapped in an IIFE to avoid polluting the page's global scope. */
const CONTENT_SCRIPTS = new Set(["content.js", "amazon-search-content.js"]);

/**
 * Wraps content script chunks in an IIFE.
 *
 * Content scripts share the page's global scope (they are not ES modules).
 * Without wrapping, minified variable names like `A` or `C` collide with
 * variables declared by the host page (e.g. Amazon's own JS).
 */
function wrapContentScriptsInIIFE(): Plugin {
  return {
    name: "wrap-content-scripts-iife",
    generateBundle(_options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type === "chunk" && CONTENT_SCRIPTS.has(fileName)) {
          chunk.code = `(function(){${chunk.code}})();\n`;
        }
      }
    },
  };
}

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background.ts"),
        content: resolve(__dirname, "src/content.ts"),
        "amazon-search-content": resolve(__dirname, "src/amazon-search-content.ts"),
        popup: resolve(__dirname, "src/popup/popup.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name].[ext]",
      },
    },
  },
  plugins: [wrapContentScriptsInIIFE()],
});
