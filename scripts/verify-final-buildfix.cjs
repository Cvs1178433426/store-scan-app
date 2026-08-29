const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', 'app', 'store-count', 'page.tsx'), 'utf8');

const handleStart = source.indexOf('async function handleBarcode');
const handleEnd = source.indexOf('\n  async function toggleTorch', handleStart);
if (handleStart === -1 || handleEnd === -1) {
  throw new Error('Could not locate handleBarcode()');
}
const handleBarcode = source.slice(handleStart, handleEnd);

if (!/if \(!barcode \|\| !user \|\| !session/.test(handleBarcode)) {
  throw new Error('handleBarcode must reject scans when there is no authenticated user before using user.id');
}

console.log('final build-fix regression contracts passed');
