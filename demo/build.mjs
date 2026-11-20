// Builds demo/index.html: one self-contained file you can open by double-clicking.
//   cd demo && npm install && npm run build
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const here = new URL(".", import.meta.url);
const result = await build({
  entryPoints: [new URL("src/app.ts", here).pathname],
  bundle: true,
  format: "iife",
  target: "es2020",
  minify: true,
  write: false,
  loader: { ".json": "json" },
});

const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const template = await readFile(new URL("src/index.html", here), "utf8");
const page = template.replace("/*APP*/", () => js);

// demo/index.html: open it locally by double-clicking.
// website/index.html: what Netlify publishes (see netlify.toml at the repo root).
await writeFile(new URL("index.html", here), page);
await mkdir(new URL("../website/", here), { recursive: true });
await writeFile(new URL("../website/index.html", here), page);
console.log(`demo/index.html and website/index.html written (${Math.round(js.length / 1024)} KB of script)`);
