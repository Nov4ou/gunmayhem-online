(() => {
 'use strict';
 const api=RuffleRollback;
 const pageSize=16384;
 let module,helper,length=0,pages,restoreMarks=new Uint32Array(0),restoreIndices=new Uint32Array(0),restoreGeneration=0;
 const free=[],freeTables=[];
 const stats={captures:0,changedPages:0,copiedBytes:0,allocatedPages:0,allocatedPageTables:0,restores:0,restoredPages:0,restoredBytes:0};
 const url=new URL('./pages-direct.wasm',document.currentScript.src);
 api.pagesReady=fetch(url).then(r=>r.arrayBuffer()).then(bytes=>{module=new WebAssembly.Module(bytes);});
 function retain(p){p.refs++;return p;}
 function drop(p){if(--p.refs===0)free.push(p);}
 function copy(bytes){const p=free.pop()||{data:new Uint8Array(pageSize),refs:0};if(!p.seen){stats.allocatedPages++;p.seen=true;}p.data.set(bytes);p.refs=1;return p;}
 function snapshotTable(){
  const table=freeTables.pop()||[];
  if(!table.seen){stats.allocatedPageTables++;table.seen=true;}
  table.length=pages.length;
  for(let i=0;i<pages.length;i++)table[i]=retain(pages[i]);
  return table;
 }
 function prepareRestoreBuffers(count){
  if(restoreMarks.length===count)return;
  restoreMarks=new Uint32Array(count);restoreIndices=new Uint32Array(count);restoreGeneration=0;
 }
 api.memoryStore={
  capture(memory){
   if(!module)throw new Error('Await pagesReady');
   if(!helper)helper=new WebAssembly.Instance(module,{ruffle:{memory}}).exports;
   if(length!==memory.buffer.byteLength){
    length=memory.buffer.byteLength;
    const capacity=length+(length/pageSize)*4;
    const grow=Math.ceil((capacity-helper.memory.buffer.byteLength)/65536);
    if(grow>0)helper.memory.grow(grow);
    if(pages)pages.forEach(drop);
    pages=null;
    prepareRestoreBuffers(length/pageSize);
   }
   const incoming=new Uint8Array(memory.buffer),previous=new Uint8Array(helper.memory.buffer);
   if(!pages){pages=Array.from({length:length/pageSize},(_,i)=>copy(incoming.subarray(i*pageSize,(i+1)*pageSize)));previous.set(incoming);stats.copiedBytes+=length;}
   else {
    const count=helper.changed_pages(length);
    const indices=new Uint32Array(helper.memory.buffer,length,count);
    for(const i of indices){drop(pages[i]);pages[i]=copy(incoming.subarray(i*pageSize,(i+1)*pageSize));previous.set(pages[i].data,i*pageSize);}
    stats.changedPages+=count;stats.copiedBytes+=count*pageSize;
   }
   stats.captures++;
   return {length,pages:snapshotTable()};
  },
  restore(memory,token){
   if(memory.buffer.byteLength!==token.length)throw new Error('Checkpoint memory size mismatch');
   if(!pages||pages.length!==token.pages.length)throw new Error('Checkpoint page table mismatch');
   const target=new Uint8Array(memory.buffer),previous=new Uint8Array(helper.memory.buffer);
   // `pages`/`previous` describe the most recent captured frontier. The live
   // simulation may have dirtied pages since then, while an older rollback token
   // may also point at different immutable page versions. Restore only the union
   // of those two sets instead of writing the whole ~96 MiB Ruffle memory.
   const dirtyCount=helper.changed_pages(length);
   restoreGeneration=(restoreGeneration+1)>>>0;
   if(!restoreGeneration){restoreMarks.fill(0);restoreGeneration=1;}
   let restoreCount=0;
   const dirtyIndices=new Uint32Array(helper.memory.buffer,length,dirtyCount);
   for(const i of dirtyIndices)if(restoreMarks[i]!==restoreGeneration){restoreMarks[i]=restoreGeneration;restoreIndices[restoreCount++]=i;}
   for(let i=0;i<pages.length;i++)if(pages[i]!==token.pages[i]&&restoreMarks[i]!==restoreGeneration){restoreMarks[i]=restoreGeneration;restoreIndices[restoreCount++]=i;}
   for(let n=0;n<restoreCount;n++){const i=restoreIndices[n];target.set(token.pages[i].data,i*pageSize);}
   // Make the restored token the new comparison frontier for the next capture.
   // Only page identities that changed need to update the helper mirror/refcounts;
   // dirty live pages whose token identity is unchanged already match `previous`.
   for(let i=0;i<pages.length;i++)if(pages[i]!==token.pages[i]){
    drop(pages[i]);pages[i]=retain(token.pages[i]);previous.set(pages[i].data,i*pageSize);
   }
   stats.restores++;stats.restoredPages+=restoreCount;stats.restoredBytes+=restoreCount*pageSize;
  },
  release(token){
   if(!token.pages)return;
   const table=token.pages;
   table.forEach(drop);table.length=0;token.pages=null;freeTables.push(table);
  },
  inspect:()=>({...stats,length,pooledPages:free.length,pooledPageTables:freeTables.length,helperBytes:helper?.memory.buffer.byteLength||0})
 };
})();
