"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "public");
const output = path.join(root, "netlify-public");
const publishPanel = process.env.NAXEL_ENABLE_PANEL === "true";
if (!output.startsWith(`${root}${path.sep}`)) {
  throw new Error("Diretório de publicação fora do projeto.");
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, "assets"), { recursive: true });
let html = fs.readFileSync(path.join(source, "index.html"), "utf8");

if (publishPanel) {
  html = html.replace("<span data-panel-access></span>", '<a class="button outline" href="painel.html">Acessar painel</a>');
  const panelHtml = fs.readFileSync(path.join(source, "painel.html"), "utf8");
  const panelJs = fs.readFileSync(path.join(source, "app.js"), "utf8");
  if (/demonstra(?:ção|cao)|prévia|previa|dados fict[ií]ci|admin@naxel\.local/i.test(`${panelHtml}\n${panelJs}`)) {
    throw new Error("O painel publicado não pode conter prévias, dados fictícios ou credenciais locais.");
  }
  fs.copyFileSync(path.join(source, "painel.html"), path.join(output, "painel.html"));
  fs.copyFileSync(path.join(source, "app.js"), path.join(output, "app.js"));
  fs.copyFileSync(path.join(source, "styles.css"), path.join(output, "styles.css"));
  fs.copyFileSync(path.join(source, "manifest.webmanifest"), path.join(output, "manifest.webmanifest"));
  console.log("Painel Naxel Care incluído sem credenciais de demonstração ou registros fictícios.");
} else {
  html = html.replace("<span data-panel-access></span>", "");
  console.log("Painel desativado; somente a apresentação institucional será publicada.");
}

fs.writeFileSync(path.join(output, "index.html"), html);
fs.copyFileSync(path.join(source, "landing.css"), path.join(output, "landing.css"));
fs.copyFileSync(path.join(source, "favicon.svg"), path.join(output, "favicon.svg"));
fs.copyFileSync(path.join(source, "assets", "naxel-mark.png"), path.join(output, "assets", "naxel-mark.png"));

console.log("Site institucional preparado sem painel de teste, dados fictícios ou credenciais locais.");
