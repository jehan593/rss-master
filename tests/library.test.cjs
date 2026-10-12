const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup() {
  const context = vm.createContext({ document: { addEventListener() {} } });
  vm.runInContext(fs.readFileSync(require.resolve('../library.js'), 'utf8'), context);
  vm.runInContext(`let folders = [
    {id:'a', name:'A', parent_id:null, position:2},
    {id:'b', name:'B', parent_id:'a', position:0},
    {id:'c', name:'C', parent_id:'b', position:0}];
    let feeds = [{id:'one',folder_id:'a',position:1},{id:'two',folder_id:'c',position:0},{id:'root',folder_id:null,position:0}];`, context);
  return code => vm.runInContext(code, context);
}
test('folder articles include nested feeds and exclude feeds outside the folder', () => {
  const run = setup();
  assert.equal(run("libraryFeedIds('a').join(',')"), 'one,two');
  assert.equal(run("libraryFeedIds('b').join(',')"), 'two');
});
test('feeds and folders share sibling ordering', () => {
  const run = setup();
  assert.equal(run("libraryChildren(null).map(i=>i.id).join(',')"), 'root,a');
  assert.equal(run("libraryChildren('a').map(i=>i.id).join(',')"), 'b,one');
  assert.equal(run("folderPath('c')"), 'A / B / C');
});
