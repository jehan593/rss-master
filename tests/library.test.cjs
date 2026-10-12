const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup() {
  const storage = new Map();
  const context = vm.createContext({ document: { addEventListener() {} }, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } });
  vm.runInContext(fs.readFileSync(require.resolve('../library.js'), 'utf8'), context);
  vm.runInContext(`let session = null; let folders = [
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

test('dropping on folder edges reorders; dropping in its center moves inside', () => {
  const run = setup();
  run("libraryDrag = {kind:'feed',id:'root'}; let target = {dataset:{kind:'folder',id:'a'},getBoundingClientRect:()=>({top:100,height:44})};");
  assert.equal(run('libraryDropDestination(target, 103).before'), 'a');
  assert.equal(run('libraryDropDestination(target, 103).parent'), null);
  assert.equal(run('libraryDropDestination(target, 122).parent'), 'a');
  assert.equal(run('libraryDropDestination(target, 141).style'), 'drop-after');
  assert.equal(run('libraryDropDestination(target, 141).parent'), null);
  assert.equal(run('libraryDropDestination({dataset:{root:true}}, 0).parent'), null);
});

test('folder writes never send a feed URL', async () => {
  const run = setup();
  run("let sent; let sb={rpc:async(name,args)=>{sent=args;return {error:null}}}; let loadFeeds=async()=>{};let saveCache=()=>{};renderLibrary=()=>{};let renderArticles=()=>{};");
  await run("writeLibraryMove('folder',null,null,null,'New folder','')");
  assert.equal(run('sent.new_url'), null);
  assert.equal(run('sent.new_name'), 'New folder');
});

test('folders can be dropped before or after feeds in the same list', () => {
  const run = setup();
  run("libraryDrag={kind:'folder',id:'a'}; let target={dataset:{kind:'feed',id:'root'},getBoundingClientRect:()=>({top:100,height:44})};");
  assert.equal(run('libraryDropDestination(target, 103).parent'), null);
  assert.equal(run('libraryDropDestination(target, 103).before'), 'root');
  assert.equal(run('libraryDropDestination(target, 141).parent'), null);
  assert.equal(run('libraryDropDestination(target, 141).before'), null);
});

test('folder expansion persists and is isolated by account', () => {
  const run = setup();
  run("session={user:{id:'alice'}}; renderLibrary=()=>{}; toggleLibraryFolder('a'); folderExpansionUser=null; collapsedFolders.clear(); loadFolderExpansionState();");
  assert.equal(run("collapsedFolders.has('a')"), true);
  run("session={user:{id:'bob'}}; loadFolderExpansionState();");
  assert.equal(run('collapsedFolders.size'), 0);
  run("session={user:{id:'alice'}}; loadFolderExpansionState(); toggleLibraryFolder('a'); folderExpansionUser=null; collapsedFolders.clear(); loadFolderExpansionState();");
  assert.equal(run("collapsedFolders.has('a')"), false);
  run('session=null; loadFolderExpansionState();');
  assert.equal(run('collapsedFolders.size'), 0);
});

test('folder controls work when browser storage fails', () => {
  const run = setup();
  run("session={user:{id:'alice'}}; renderLibrary=()=>{}; localStorage.getItem=localStorage.setItem=()=>{throw Error('Storage unavailable')}; toggleLibraryFolder('a');");
  assert.equal(run("collapsedFolders.has('a')"), true);
});
