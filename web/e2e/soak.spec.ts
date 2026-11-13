import { test, expect } from '@playwright/test';
import { audioProbe, audioState, login, playlist } from './helpers';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
test('two-hour real audio and navigation soak',async({page,context})=>{
  const seconds=Number(process.env.QQM_SOAK_SECONDS||0);
  test.skip(seconds<=0,'Set QQM_SOAK_SECONDS=7200 for a two-hour real-time run');
  test.setTimeout((seconds+120)*1000);page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(15000);
  const output=process.env.QQM_SOAK_REPORT||'test-results/soak-report.json';mkdirSync(dirname(output),{recursive:true});
  const start=Date.now();let samples=0,changes=0,lastSrc='',stalledSince=Date.now(),lastTime=-1,progress=0;
  const report={duration_seconds:seconds,samples:0,track_changes:0,audio_progress_seconds:0,completed:false,phase:'setup',failures:[] as string[]};
  const save=(phase:string)=>{report.phase=phase;report.samples=samples;report.track_changes=changes;report.audio_progress_seconds=progress;writeFileSync(output,JSON.stringify({...report,elapsed_seconds:(Date.now()-start)/1000},null,2));};
  try {
    await audioProbe(page);const errors=await login(page);await playlist(page);
    await page.getByRole('button',{name:'Слушать',exact:true}).first().click();
    await expect.poll(async()=> (await audioState(page))?.time||0).toBeGreaterThan(1);
    await page.getByRole('button',{name:'Повтор выключен',exact:true}).click();
    await expect(page.getByRole('button',{name:'Повтор очереди',exact:true})).toBeVisible();
    while(Date.now()-start<seconds*1000){
      save('sample');await page.waitForTimeout(2000);
      const a=await audioState(page);expect(a,'real audio element').not.toBeNull();expect(a!.error).toBe(0);
      if(a!.src!==lastSrc){if(lastSrc)changes++;lastSrc=a!.src;stalledSince=Date.now();}
      else if(a!.time>lastTime+.1){stalledSince=Date.now();progress+=Math.min(5,a!.time-lastTime);}
      expect(Date.now()-stalledSince,'audio must keep progressing').toBeLessThan(25000);lastTime=a!.time;samples++;
      if(samples%30===0){save('navigation');await page.goto('/#/library');await page.goto('/#/playlist/1');await expect(page.getByRole('heading',{name:'Ночной маршрут 1',exact:true,level:1})).toBeVisible();}
      if(samples%90===0){save('network');await context.setOffline(true);await page.waitForTimeout(1500);await context.setOffline(false);}
      if(samples%150===0){save('skip');await page.getByRole('button',{name:'Следующий трек',exact:true}).click();}
    }
    expect(errors).toEqual([]);expect(progress,'must measure real playback, not a suspended host clock').toBeGreaterThan(seconds*.8);report.completed=true;
  }catch(error){report.failures.push(String(error));throw error;}
  finally{save(report.completed?'complete':'failed');}
});
