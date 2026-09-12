'use strict';
const fs = require('node:fs');
const u = n => { const bytes=[];do { const b=n&127;n=Math.floor(n/128);bytes.push(b|(n?128:0)); }while(n);return bytes; };
const str = s => [...u(Buffer.byteLength(s)),...Buffer.from(s)];
const section = (id,data) => [id,...u(data.length),...data];
const get = n => [0x20,n];
const set = n => [0x21,n];
const vectors=Array.from({length:8},(_,i)=>[
 ...get(1),...get(2),0x6a,0xfd,0,4,...u(i*16),
 ...get(1),...get(2),0x6a,0xfd,0,68,1,...u(i*16),
 0xfd,81,0xfd,80]).flat();
// params: byte length; locals: page offset, vector offset, changed count, v128 diff.
// Memory 0 is imported directly from Ruffle. Memory 1 is the previous checkpoint.
const body=[2,3,0x7f,1,0x7b,
  0x02,0x40,0x03,0x40,
  ...get(1),...get(0),0x4f,0x0d,1,
  0xfd,12,...Array(16).fill(0),...set(4),
  0x41,0,...set(2),0x02,0x40,0x03,0x40,
  ...get(4),...vectors,...set(4),
  ...get(4),0xfd,83,0x0d,1,
  ...get(2),0x41,0x80,1,0x6a,...set(2),
  ...get(2),0x41,0x80,0x80,1,0x49,0x0d,0,0x0b,0x0b,
  ...get(4),0xfd,83,0x04,0x40,
  ...get(0),...get(3),0x41,2,0x74,0x6a,
  ...get(1),0x41,14,0x76,0x36,66,1,0,
  ...get(3),0x41,1,0x6a,...set(3),0x0b,
  ...get(1),0x41,0x80,0x80,1,0x6a,...set(1),0x0c,0,0x0b,0x0b,
  ...get(3),0x0b];
const bytes=Buffer.from([0,97,115,109,1,0,0,0,
 ...section(1,[1,0x60,1,0x7f,1,0x7f]),
 ...section(2,[1,...str('ruffle'),...str('memory'),2,0,0]),
 ...section(3,[1,0]),...section(5,[1,0,1]),
 ...section(7,[2,...str('memory'),2,1,...str('changed_pages'),0,0]),
 ...section(10,[1,...u(body.length),...body])]);
new WebAssembly.Module(bytes);
fs.writeFileSync(`${__dirname}/pages-direct.wasm`,bytes);
console.log('Built exact SIMD page comparison:',bytes.length,'bytes');
