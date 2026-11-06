const { chromium } = require('playwright');
(async () => {
  const [wav, out] = process.argv.slice(2);
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${wav}`,'--autoplay-policy=no-user-gesture-required','--auto-select-desktop-capture-source=Desk Band','--enable-usermedia-screen-capturing','--auto-accept-this-tab-capture'] });
  const errs = [];
  const sctx = await browser.newContext({ viewport:{width:1366,height:820}, deviceScaleFactor:1, acceptDownloads:true });
  const stage = await sctx.newPage(); stage.on('pageerror', e=>errs.push('stage: '+e.message));
  await stage.goto('http://localhost:8000/'); await stage.click('#go'); await stage.waitForTimeout(1500);
  console.log('join url:', await stage.textContent('#joinUrl'), '| qr svg:', !!(await stage.$('#qr svg')));
  await stage.screenshot({ path: out + '/stage-join.png' });
  await stage.selectOption('#kit','melody');
  // phone 1: teach
  const p1 = await (await browser.newContext({ ignoreHTTPSErrors:true, viewport:{width:390,height:844}, isMobile:true, hasTouch:true })).newPage();
  p1.on('pageerror', e=>errs.push('phone1: '+e.message)); p1.on('dialog', d=>{errs.push('dialog '+d.message()); d.dismiss();});
  await p1.goto('https://localhost:8443/'); await p1.click('#start'); await p1.waitForTimeout(600);
  await p1.click('#guided');
  for (let i=0;i<70;i++){ await p1.waitForTimeout(1000); if ((await p1.textContent('#modeText')).startsWith('Ready')) break; }
  await p1.waitForTimeout(1500);
  const fs=require('fs'); const f=require('path').join(__dirname,'..','..','data','training','training-45ms.json');
  console.log('saved on laptop:', fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)).length + ' taps' : 'NO');
  // phone 2: fresh browser storage -> should load training from laptop and be ready to play
  const p2 = await (await browser.newContext({ ignoreHTTPSErrors:true, viewport:{width:390,height:844}, isMobile:true, hasTouch:true })).newPage();
  p2.on('pageerror', e=>errs.push('phone2: '+e.message));
  await p2.goto('https://localhost:8443/'); await p2.click('#start'); await p2.waitForTimeout(1500);
  console.log('fresh phone:', await p2.textContent('#modeText'), '| play enabled:', !(await p2.$eval('#play', b=>b.disabled)));
  await p1.close();
  await p2.click('#play'); await p2.waitForTimeout(6000);
  console.log('stage:', await stage.textContent('#count'), '|', await stage.textContent('#trained'), '| join hidden:', await stage.$eval('#join', e=>e.classList.contains('hidden')));
  console.log('bars:', await stage.$$eval('#bars .pct', e=>e.map(x=>x.textContent).join(' ')));
  await stage.screenshot({ path: out + '/stage-demo.png' });
  // recording (headless: tab capture may be unsupported; just check it doesn't crash)
  try {
    const dl = stage.waitForEvent('download', { timeout: 8000 });
    await stage.click('#recBtn'); await stage.waitForTimeout(2500);
    console.log('rec button:', await stage.textContent('#recBtn'));
    if ((await stage.textContent('#recBtn')).includes('Stop')) { await stage.click('#recBtn'); const d = await dl; const p = out+'/demo.webm'; await d.saveAs(p); console.log('recorded file bytes:', fs.statSync(p).size); }
  } catch (e) { console.log('recording in headless:', e.message.split('\n')[0]); }
  console.log('errors:', errs.length ? errs : 'none'); await browser.close();
})();
