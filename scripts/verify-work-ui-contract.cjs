const fs=require('node:fs'); const assert=require('node:assert/strict');
const checks={
 'apps/web/app/my-work/page.tsx':['Continuixai Ops','Start My Day','Overdue','Today','This week','Completed today','countTaskActionLabel','Do not enter patient'],
 'apps/web/app/daily-summary/page.tsx':['accomplished today','Tasks completed','Units counted','Sign out'],
 'apps/web/app/team-work/page.tsx':['Team Work','Recurring templates','One-time assignment','Team status','Reports','Job title','siteDateInitialized','teamData.date'],
};
for(const [file,needles] of Object.entries(checks)){
 assert.ok(fs.existsSync(file),`missing ${file}`); const src=fs.readFileSync(file,'utf8');
 for(const n of needles) assert.ok(src.includes(n),`${file} missing ${n}`);
}
console.log('work UI contract passed');
