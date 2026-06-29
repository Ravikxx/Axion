import { testRender } from '@opentui/react/test-utils';
import { createMockKeys, createMockMouse } from '@opentui/core/testing';
import { act } from 'react';
import React from 'react';
import { App } from './src/tui/App.jsx';
let exited=false;
const { renderer, flush, captureCharFrame } = await testRender(
  React.createElement(App, { initialModel:'lumen', initialMode:'ask', onExit:()=>{exited=true;} }),
  { width: 80, height: 18 }
);
const keys = createMockKeys(renderer);
const mouse = createMockMouse(renderer);
await flush();
await act(async()=>{ await keys.pressKey('t',{ctrl:true}); }); await flush(); // 2 tabs
await act(async()=>{ await keys.pressKey('t',{ctrl:true}); }); await flush(); // 3 tabs
const f3 = captureCharFrame().split('\n')[0].replace(/\s+$/,'');
await act(async()=>{ await keys.pressKey('w',{ctrl:true}); }); await flush(); // close active -> 2 tabs
const f2 = captureCharFrame().split('\n')[0].replace(/\s+$/,'');
// click the × of tab 1 (first ✕ in the bar)
const col = f2.indexOf('✕');
await act(async()=>{ await mouse.click(col, 0); }); await flush();
const f1 = captureCharFrame().split('\n')[0].replace(/\s+$/,'');
const count = s => (s.match(/✕/g)||[]).length;
console.error('3tabs bar: '+f3+'  (×count='+count(f3)+')');
console.error('after Ctrl+W: '+f2+'  (×count='+count(f2)+')');
console.error('after click ×: '+f1+'  (×count='+count(f1)+')  exited='+exited);
process.exit(0);
