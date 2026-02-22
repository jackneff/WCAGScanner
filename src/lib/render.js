const fs = require('fs');
const path = require('path');

const TEMPLATES = path.join(__dirname, '..', 'templates');

function loadAsset(filename) {
  return fs.readFileSync(path.join(TEMPLATES, filename), 'utf-8');
}

function renderTemplate(templateFile, vars) {
  let out = loadAsset(templateFile);
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(String(v));
  }
  return out;
}

module.exports = { loadAsset, renderTemplate };
