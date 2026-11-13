import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {reorderQueue,shortcutAction} from '../src/lib/playerActions.ts';

test('reordering preserves the playing occurrence even for duplicate objects',()=>{
  const duplicate={ref:'same'};
  const queue=[duplicate,{ref:'other'},duplicate,{ref:'last'}];
  for(let current=0;current<4;current++)for(let from=0;from<4;from++)for(let to=0;to<4;to++){
    const ids=[0,1,2,3];const [moved]=ids.splice(from,1);ids.splice(to,0,moved);
    const result=reorderQueue(queue,current,from,to);
    assert.equal(ids[result.current],current);
    assert.equal(result.queue[result.current],queue[current]);
  }
  assert.deepEqual(queue,[duplicate,{ref:'other'},duplicate,{ref:'last'}]);
  assert.equal(reorderQueue(queue,2,-1,0).queue,queue);
});
test('shortcuts ignore modifiers, held keys and typing unrelated characters',()=>{
  assert.equal(shortcutAction(' ',false,false),'toggle');
  assert.equal(shortcutAction('N',false,false),'next');
  assert.equal(shortcutAction('ArrowRight',false,false),'forward');
  assert.equal(shortcutAction('l',true,false),null);
  assert.equal(shortcutAction('n',false,true),null);
  assert.equal(shortcutAction('x',false,false),null);
});
test('sleep deadline stops once, cancel clears the timer and end-of-track flag',async()=>{
  const source=await readFile(new URL('../src/lib/sleep.ts',import.meta.url),'utf8');
  let now=1000,paused=0,stop=false;const timers=new Map();let id=0;
  const context=vm.createContext({Date:{now:()=>now},Set,pause:()=>paused++,setStopAfterTrack:v=>stop=v,toast:()=>{},window:{setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:id=>timers.delete(id)}});
  const code=source.replace(/^import .*;$/gm,'').replace(/export /g,'');
  vm.runInContext(stripTypeScriptTypes(code+';globalThis.tools={scheduleSleep,cancelSleep,checkSleep,sleepState};'),context);
  const t=context.tools;t.scheduleSleep(15,'nd:x');now+=900000;
  assert.equal(t.checkSleep(),false);assert.equal(paused,1);assert.equal(t.checkSleep(),true);assert.equal(paused,1);assert.equal(timers.size,0);
  t.scheduleSleep(0,'nd:x');assert.equal(stop,true);assert.equal(t.sleepState().mode,'track');t.cancelSleep();assert.equal(stop,false);
  t.scheduleSleep(30,'nd:x');t.cancelSleep();now+=1800000;assert.equal(t.checkSleep(),true);assert.equal(paused,1);
});
