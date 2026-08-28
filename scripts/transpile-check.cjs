const fs = require('node:fs');
const path = require('node:path');
const ts = require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript');

const roots = ['apps/api/src', 'apps/web/app', 'apps/web/components', 'apps/web/lib', 'packages/shared/src'];
const failures = [];
let checked = 0;
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      checked += 1;
      const source = fs.readFileSync(full, 'utf8');
      const result = ts.transpileModule(source, {
        fileName: full,
        reportDiagnostics: true,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
      });
      for (const diagnostic of result.diagnostics || []) {
        if (diagnostic.category === ts.DiagnosticCategory.Error) {
          failures.push(`${full}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
        }
      }
    }
  }
}
for (const root of roots) walk(root);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`transpile syntax check passed (${checked} TypeScript files)`);
