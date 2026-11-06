const { chromium } = require('playwright');
(async () => { const b = await chromium.launch({args:['--autoplay-policy=no-user-gesture-required']}); const c = await b.newContext({viewport:{width:1280,height:800}}); const p = await c.newPage(); const errs=[];
  p.on('pageerror', e=>errs.push(e.message)); await p.goto('http://localhost:8000/'); await p.click('#go');
  await p.click('#editBtn');
  const rows = await p.$$('.erow');
  await (await rows[0].$('.notes')).fill('D4 F#4 A4'); await (await rows[0].$('.name')).fill('D major');
  console.log('valid msg:', await (await rows[0].$('.msg')).textContent());
  await (await rows[1].$('.notes')).fill('H4 C4'); console.log('invalid msg:', await (await rows[1].$('.msg')).textContent());
  await (await rows[1].$('.notes')).fill('E2 B3 E4 G4'); console.log('bass msg:', await (await rows[1].$('.msg')).textContent());
  await p.selectOption('#eLen','stab'); await p.selectOption('#eVoice','keys');
  await (await rows[0].$('.notes')).press('Enter');
  await p.click('#eClose'); for (const k of '1234') { await p.keyboard.press(k); await p.waitForTimeout(150); }
  console.log('kit:', await p.$eval('#kit', s=>s.value), '| labels:', await p.$$eval('.pad .snd', e=>e.map(x=>x.textContent).join(' | ')), '| hits:', await p.textContent('#count'));
  await p.reload(); await p.click('#go'); await p.click('#editBtn');
  console.log('after reload pad1:', await p.$eval('.erow .notes', i=>i.value), '| len:', await p.$eval('#eLen', s=>s.value), '| voice:', await p.$eval('#eVoice', s=>s.value));
  await p.screenshot({path: process.argv[2]});
  console.log('errors:', errs.length?errs:'none'); await b.close(); })();
