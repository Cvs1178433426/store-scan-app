const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const roots = ['apps', 'packages', 'scripts'];
const allowedStoreScanFiles = new Set([
  'apps/api/src/lib/taskCatalog.ts',
  'apps/web/app/my-work/page.tsx',
  'apps/web/lib/taskPresentation.ts',
  'apps/web/lib/taskPresentation.test.ts',
  'scripts/test-task-presentation-pure.cjs',
  'scripts/test-starter-task-catalog.cjs',
  'scripts/verify-work-ui-contract.cjs',
  'scripts/verify-continuixai-branding.cjs',
]);
const textExt = new Set(['.ts','.tsx','.js','.cjs','.mjs','.json','.yml','.yaml','.md','.sql']);
const violations=[];
function walk(dir){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(entry.name==='node_modules'||entry.name==='.next'||entry.name==='dist') continue;
    const full=path.join(dir,entry.name);
    if(entry.isDirectory()) walk(full);
    else if(textExt.has(path.extname(entry.name)) || entry.name==='package.json'){
      const rel=full.replaceAll('\\','/');
      const src=fs.readFileSync(full,'utf8');
      if(/store\s+scan/i.test(src) && !allowedStoreScanFiles.has(rel)) violations.push(`${rel}: prohibited application-level Store Scan branding`);
      if(rel !== 'scripts/verify-continuixai-branding.cjs' && src.includes('@' + 'stash/')) violations.push(`${rel}: legacy package namespace`);
    }
  }
}
for(const root of roots) walk(root);
const rootPackage=JSON.parse(fs.readFileSync('package.json','utf8'));
assert.equal(rootPackage.name,'continuixai-ops','root package must be named continuixai-ops');
if(violations.length){ console.error(violations.join('\n')); process.exit(1); }
console.log('Continuixai Ops branding verification passed');
