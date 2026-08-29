const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const roots = ['apps', 'packages', 'scripts', 'docs', '.github'];
const rootFiles = ['README.md', 'README.ko.md', 'Caddyfile', 'docker-compose.yml', 'docker-compose.prod.yml', 'render.yaml', '.env.example', 'package.json'];
const allowedStoreScanFiles = new Set([
  'apps/api/src/lib/taskCatalog.ts',
  'apps/web/app/my-work/page.tsx',
  'apps/web/lib/taskPresentation.ts',
  'apps/web/lib/taskPresentation.test.ts',
  'scripts/test-task-presentation-pure.cjs',
  'scripts/test-starter-task-catalog.cjs',
  'scripts/verify-work-ui-contract.cjs',
  'scripts/verify-continuixai-branding.cjs',
  'README.md',
  'docs/CLAUDE-COMPLETE-REVIEW-BRIEF.md',
  'docs/CLAUDE-READY-HANDOFF.md',
  'docs/CLAUDE-ROUND2-HANDOFF.md',
  'docs/CLAUDE-ROUND1-ADVERSARIAL-REVIEW.md',
  'docs/CLAUDE-ROUND2-ADVERSARIAL-REVIEW.md',
  'docs/superpowers/plans/2026-08-28-claude-round1-remediation.md',
]);
const historicalReviewDocs = new Set(['docs/CLAUDE-ROUND1-ADVERSARIAL-REVIEW.md', 'docs/CLAUDE-ROUND2-ADVERSARIAL-REVIEW.md']);
const textExt = new Set(['.ts','.tsx','.js','.cjs','.mjs','.json','.yml','.yaml','.md','.sql','.sh']);
const violations=[];
function check(full){
  const rel=full.replaceAll('\\','/');
  const src=fs.readFileSync(full,'utf8');
  if(/store\s+scan/i.test(src) && !allowedStoreScanFiles.has(rel)) violations.push(`${rel}: prohibited application-level Store Scan branding`);
  if(!historicalReviewDocs.has(rel) && /@stash\//i.test(src)) violations.push(`${rel}: legacy package namespace`);
  if(!historicalReviewDocs.has(rel) && rel !== 'scripts/verify-continuixai-branding.cjs' && /\bstash(?:_|-|\b)/i.test(src)) violations.push(`${rel}: legacy inherited identifier/branding`);
}
function walk(dir){
  if(!fs.existsSync(dir)) return;
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(entry.name==='node_modules'||entry.name==='.next'||entry.name==='dist'||entry.name==='.git') continue;
    const full=path.join(dir,entry.name);
    if(entry.isDirectory()) walk(full);
    else if(textExt.has(path.extname(entry.name)) || entry.name==='package.json') check(full);
  }
}
for(const root of roots) walk(root);
for(const file of rootFiles) if(fs.existsSync(file)) check(file);
const rootPackage=JSON.parse(fs.readFileSync('package.json','utf8'));
assert.equal(rootPackage.name,'continuixai-ops','root package must be named continuixai-ops');
if(violations.length){ console.error(violations.join('\n')); process.exit(1); }
console.log('Continuixai Ops branding verification passed');
