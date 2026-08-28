const fs=require('node:fs'); const path=require('node:path'); const vm=require('node:vm'); const assert=require('node:assert/strict');
const ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript');
const sourcePath=path.resolve(__dirname,'../apps/web/lib/taskPresentation.ts');
if(!fs.existsSync(sourcePath)) throw new Error('taskPresentation.ts does not exist yet');
const out=ts.transpileModule(fs.readFileSync(sourcePath,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const cjs={exports:{}}; vm.runInNewContext(`(function(exports,require,module){${out}\n})(module.exports,require,module);`,{module:cjs,require,console,Date,Intl,Object,Math,RegExp});
const { greetingForHour, groupAssignments, isStoreScanTask, countTaskActionLabel }=cjs.exports;
assert.equal(greetingForHour(11,'Alex'),'Good morning, Alex!');
assert.equal(greetingForHour(12,'Alex'),'Good afternoon, Alex!');
assert.equal(greetingForHour(16,'Alex'),'Good afternoon, Alex!');
assert.equal(greetingForHour(17,'Alex'),'Good evening, Alex!');
const tasks=[
 {id:'over',title:'Old',status:'OPEN',scheduledDate:'2026-08-27T00:00:00Z',priority:'NORMAL',dueAt:null},
 {id:'today-high',title:'High',status:'OPEN',scheduledDate:'2026-08-28T00:00:00Z',priority:'HIGH',dueAt:'2026-08-28T13:00:00Z'},
 {id:'today-urgent',title:'Urgent',status:'IN_PROGRESS',scheduledDate:'2026-08-28T00:00:00Z',priority:'URGENT',dueAt:'2026-08-28T14:00:00Z'},
 {id:'week',title:'Later',status:'OPEN',scheduledDate:'2026-08-30T00:00:00Z',priority:'LOW',dueAt:null},
 {id:'done',title:'Done',status:'COMPLETED',scheduledDate:'2026-08-27T00:00:00Z',completedAt:'2026-08-28T10:00:00Z',priority:'NORMAL',dueAt:null},
 {id:'done-late',title:'Late local completion',status:'COMPLETED',scheduledDate:'2026-08-28T00:00:00Z',completedAt:'2026-08-29T02:00:00Z',priority:'NORMAL',dueAt:null},
];
const grouped=groupAssignments(tasks,'2026-08-28');
assert.deepEqual(JSON.parse(JSON.stringify(grouped.overdue.map(x=>x.id))),['over']);
assert.deepEqual(JSON.parse(JSON.stringify(grouped.today.map(x=>x.id))),['today-urgent','today-high']);
assert.deepEqual(JSON.parse(JSON.stringify(grouped.thisWeek.map(x=>x.id))),['week']);
assert.deepEqual(JSON.parse(JSON.stringify(grouped.completedToday.map(x=>x.id))),['done','done-late']);
assert.equal(isStoreScanTask({title:'Complete Store Scan',instructions:null}),true);
assert.equal(countTaskActionLabel({title:'Complete Store Scan',instructions:null}),'Start Store Scan');
assert.equal(countTaskActionLabel({title:'Cycle count aisle 4',instructions:null}),'Start Count');
assert.equal(isStoreScanTask({title:'Opening safety walk',instructions:'Check exits'}),false);
console.log('task presentation pure tests passed');
