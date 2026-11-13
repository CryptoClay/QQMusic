import { test, expect } from '@playwright/test';
import { audioProbe, audioState, login, playlist } from './helpers';

test('LAN HTTP without randomUUID boots, signs in and opens devices',async({page})=>{
  await page.addInitScript(()=>Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true}));
  const errors=await login(page);
  await page.getByRole('button',{name:'Устройства и управление',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Где слушаем?',exact:true})).toBeVisible();
  expect((await page.request.get('/api/player/devices')).ok()).toBeTruthy();expect(errors).toEqual([]);
});

test('rapid navigation and async library keep geometry and controls intact',async({page})=>{
  const errors=await login(page);
  for(let i=0;i<3;i++){
    await page.getByRole('link',{name:'Загрузки',exact:true}).click();
    await page.getByRole('link',{name:'Библиотека',exact:true}).click();
  }
  await expect(page.getByRole('heading',{name:'Библиотека',exact:true,level:1})).toBeVisible();
  const image=page.getByRole('img',{name:'После полуночи',exact:true});await expect(image).toBeVisible();
  const box=await image.boundingBox();expect(box).not.toBeNull();expect(Math.abs(box!.width-box!.height)).toBeLessThan(1);
  expect(await page.locator('.motion-surface').evaluate(e=>getComputedStyle(e).transform)).toBe('none');expect(errors).toEqual([]);
});

test('playlist rows reveal after data load and remain accessible while scrolling',async({page})=>{
  await page.addInitScript(()=>{
    const original=Element.prototype.animate;(window as any).__reveals=[];
    Element.prototype.animate=function(frames,options){(window as any).__reveals.push({frames,options});return original.call(this,frames,options);};
  });
  const errors=await login(page);await playlist(page);
  await expect(page.locator('main li')).toHaveCount(90);
  await expect.poll(()=>page.evaluate(()=>(window as any).__reveals.filter((r:any)=>r.options?.duration===540).length)).toBeGreaterThan(0);
  await page.locator('main li').last().scrollIntoViewIfNeeded();await expect(page.locator('main li').last()).toBeVisible();
  const dimensions=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width+1);expect(errors).toEqual([]);
});

test('real audio plays, seeks, pauses and skips without rebuilding the page',async({page})=>{
  await audioProbe(page);const errors=await login(page);await playlist(page);
  await page.getByRole('button',{name:'Слушать',exact:true}).first().click();
  await expect.poll(async()=> (await audioState(page))?.time||0).toBeGreaterThan(1);
  const first=(await audioState(page))!.src;
  await page.goto('/#/library');await expect(page.getByRole('heading',{name:'Библиотека',level:1})).toBeVisible();
  await expect.poll(async()=> (await audioState(page))?.paused).toBe(false);
  await page.getByRole('button',{name:'Следующий трек',exact:true}).click();
  await expect.poll(async()=> (await audioState(page))?.src).not.toBe(first);
  await page.goto('/#/player');await page.getByRole('slider',{name:'Перемотка',exact:true}).press('Home');
  await expect.poll(async()=> (await audioState(page))?.time||0).toBeLessThan(8);
  await page.getByRole('button',{name:'Пауза',exact:true}).click();await expect.poll(async()=> (await audioState(page))?.paused).toBe(true);expect(errors).toEqual([]);
});

test('sleep at end prevents the next track',async({page})=>{
  await audioProbe(page);await login(page);await playlist(page);
  await page.getByRole('button',{name:'Слушать',exact:true}).first().click();await expect.poll(async()=> (await audioState(page))?.paused).toBe(false);
  await page.goto('/#/player');const first=(await audioState(page))!.src;
  await page.getByRole('button',{name:'Таймер сна',exact:true}).click();await page.getByRole('button',{name:'После текущего трека',exact:true}).click();
  await page.getByRole('slider',{name:'Перемотка',exact:true}).press('End');
  await expect.poll(async()=> (await audioState(page))?.ended).toBe(true);expect((await audioState(page))!.src).toBe(first);
});

test('network loss and return preserve local audio without JavaScript failures',async({page,context})=>{
  await audioProbe(page);const errors=await login(page);await playlist(page);await page.getByRole('button',{name:'Слушать',exact:true}).first().click();
  await expect.poll(async()=> (await audioState(page))?.time||0).toBeGreaterThan(1);
  await context.setOffline(true);await expect.poll(()=>page.evaluate(()=>navigator.onLine)).toBe(false);
  await context.setOffline(false);await expect.poll(()=>page.evaluate(()=>navigator.onLine)).toBe(true);
  await expect.poll(async()=> (await audioState(page))?.error).toBe(0);expect(errors).toEqual([]);
});

test('private notes and devices stay isolated between simultaneous accounts',async({page,browser})=>{
  await login(page);const other=await browser.newContext();const second=await other.newPage();await login(second,'editor');
  const ref='nd:nd1';const note='acceptance-'+Date.now();
  expect((await page.request.put('/api/music/personal',{params:{ref},data:{note,tags:['acceptance']}})).ok()).toBeTruthy();
  const own=await (await page.request.get('/api/music/notes')).json();const theirs=await (await second.request.get('/api/music/notes')).json();
  expect(own.some((x:any)=>x.note===note)).toBeTruthy();expect(theirs.some((x:any)=>x.note===note)).toBeFalsy();
  const devices=await (await page.request.get('/api/player/devices')).json();
  await expect.poll(async()=> (await (await second.request.get('/api/player/devices')).json()).length).toBeGreaterThan(0);
  const otherDevices=await (await second.request.get('/api/player/devices')).json();
  expect(otherDevices.some((x:any)=>devices.some((y:any)=>x.device===y.device))).toBeFalsy();await other.close();
});

test('remote volume command is accepted in an insecure browser context',async({page,browser})=>{
  const targetName='Acceptance target '+Date.now();
  await page.addInitScript(()=>Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true}));await login(page);
  await page.getByRole('button',{name:'Устройства и управление',exact:true}).click();
  await page.getByRole('textbox',{name:'Название плеера'}).fill(targetName);
  await page.getByRole('checkbox',{name:'Разрешить управление с моих устройств'}).check();
  const other=await browser.newContext();const second=await other.newPage();await second.addInitScript(()=>Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true}));await login(second);
  await second.getByRole('button',{name:'Устройства и управление',exact:true}).click();
  await second.getByRole('button',{name: targetName+' Можно управлять'}).click();
  await second.getByRole('slider',{name:'Громкость на устройстве'}).press('Home');
  await expect(second.getByText('Команда принята',{exact:true})).toBeVisible();await other.close();
});

test('logout invalidates the session',async({page})=>{
  await login(page);expect((await page.request.post('/api/auth/logout')).ok()).toBeTruthy();await page.reload();
  await expect(page.getByRole('button',{name:'Войти',exact:true})).toBeVisible();expect((await page.request.get('/api/auth/me')).status()).toBe(401);
});
