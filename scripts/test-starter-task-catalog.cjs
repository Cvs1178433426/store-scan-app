const fs=require('node:fs'); const path=require('node:path'); const vm=require('node:vm'); const assert=require('node:assert/strict');
const ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript');
const p=path.resolve('apps/api/src/lib/taskCatalog.ts');
if(!fs.existsSync(p)) throw new Error('taskCatalog.ts does not exist yet');
const out=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const cjs={exports:{}}; vm.runInNewContext(`(function(exports,require,module){${out}\n})(module.exports,require,module);`,{module:cjs,require,console});
const catalog=JSON.parse(JSON.stringify(cjs.exports.STARTER_TASK_CATALOG));
const roles=[...new Set(catalog.map(x=>x.jobTitle))].sort();
assert.deepEqual(roles,['CASHIER_CUSTOMER_SERVICE','INVENTORY_MANAGER','PHARMACY_TEAM','RECEIVER','STOCK_COUNT_ASSOCIATE','STORE_MANAGER']);
for(const role of roles){
 const tasks=catalog.filter(x=>x.jobTitle===role); assert.ok(tasks.some(x=>x.recurrence==='DAILY'),`${role} missing daily`); assert.ok(tasks.some(x=>x.recurrence==='WEEKLY'),`${role} missing weekly`); assert.ok(tasks.some(x=>x.recurrence==='MONTHLY'),`${role} missing monthly`);
}
assert.ok(catalog.some(x=>/Store Scan/i.test(x.title) && x.recurrence==='DAILY'),'Store Scan must exist as a daily operational task');
assert.ok(catalog.length>=60,`starter catalog unexpectedly small: ${catalog.length}`);
console.log(`starter task catalog passed (${catalog.length} templates)`);
