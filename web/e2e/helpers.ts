import { expect, type Page } from '@playwright/test';
export async function login(page: Page, user='listener') {
  const errors: string[]=[];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('textbox',{name:'Имя или почта'}).fill(user);
  await page.getByRole('textbox',{name:'Пароль',exact:true}).fill('test');
  await page.getByRole('button',{name:'Войти',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Для тебя',exact:true})).toBeVisible();
  expect(errors).toEqual([]);
  return errors;
}
export async function playlist(page: Page) {
  await page.goto('/#/playlist/1');
  await expect(page.getByRole('heading',{name:'Ночной маршрут 1',exact:true,level:1})).toBeVisible();
}
export async function audioProbe(page: Page) {
  await page.addInitScript(() => {
    const original=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=function(){
      (window as any).__qqmAudio=this;
      return original.call(this);
    };
  });
}
export async function audioState(page: Page) {
  return page.evaluate(() => {
    const a=(window as any).__qqmAudio as HTMLMediaElement|undefined;
    return a ? {time:a.currentTime,paused:a.paused,ended:a.ended,error:a.error?.code||0,src:a.currentSrc,rate:a.playbackRate} : null;
  });
}
