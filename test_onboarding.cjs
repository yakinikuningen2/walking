const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/static/js/ui.js`, 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('  function placeOnboardingCard('), source.indexOf('  function positionGuide(')), context);
const place = context.placeOnboardingCard;
const overlaps = (target, p, card) => Math.min(target.right, p.left + card.width) > Math.max(target.left, p.left)
  && Math.min(target.bottom, p.top + card.height) > Math.max(target.top, p.top);

test('live guide keeps desktop and phone cards clear of the control being explained', () => {
  const cases = [
    [{ left: 130, right: 459, top: 170, bottom: 228 }, { width: 360, height: 338 }, { width: 1440, height: 900 }],
    [{ left: 328, right: 384, top: 106, bottom: 162 }, { width: 360, height: 312 }, { width: 390, height: 844 }],
    [{ left: 11, right: 309, top: 347, bottom: 407 }, { width: 296, height: 317 }, { width: 320, height: 568 }],
    [{ left: 27, right: 395, top: 272, bottom: 332 }, { width: 360, height: 349 }, { width: 844, height: 390 }],
  ];
  for (const [target, card, viewport] of cases) {
    const p = place(target, card, viewport);
    assert.equal(overlaps(target, p, card), false);
    assert.ok(p.left >= 12 && p.top >= 12);
    assert.ok(p.left + card.width <= viewport.width - 12);
    assert.ok(p.top + card.height <= viewport.height - 12);
  }
});

test('guide placement respects iPhone safe areas', () => {
  const viewport = { width: 844, height: 390, topInset: 0, bottomInset: 21, leftInset: 44, rightInset: 44 };
  const card = { width: 320, height: 300 };
  const p = place({ left: 27, right: 395, top: 272, bottom: 332 }, card, viewport);
  assert.ok(p.left >= 56 && p.left + card.width <= 788);
  assert.ok(p.top >= 12 && p.top + card.height <= 357);
  assert.equal(overlaps({ left: 27, right: 395, top: 272, bottom: 332 }, p, card), false);
});

test('oversized targets still keep navigation controls within the viewport', () => {
  const card = { width: 296, height: 300 };
  const p = place({ left: 0, right: 320, top: 0, bottom: 400 }, card, { width: 320, height: 400 });
  assert.ok(p.left >= 12 && p.top >= 12);
  assert.ok(p.left + card.width <= 308 && p.top + card.height <= 388);
});

test('both entry points target real controls without illustration or invented results', () => {
  for (const path of ['index.html', 'templates/index.html']) {
    const html = fs.readFileSync(`${__dirname}/${path}`, 'utf8');
    const steps = [...html.matchAll(/data-onboarding-page data-guide-view="([^"]+)" data-guide-target="#([^"]+)"/g)];
    assert.deepEqual(steps.map(m => m[1]), ['map', 'search', 'search', 'search', 'map', 'map', 'tour', 'saved', 'settings']);
    assert.equal(steps.length, 9);
    for (const [, , id] of steps) assert.ok(html.includes(`id="${id}"`), id);
    assert.equal(html.includes('onboarding-illustration'), false);
    assert.ok(html.includes('id="onboarding-window"'));
  }
});

test('the first-use marker remains compatible and falls back to session storage', () => {
  const session = new Map();
  const c = vm.createContext({ onboardingKey: 'walking.onboarding.v1', localStorage: {
    getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); },
  }, sessionStorage: { getItem: key => session.get(key), setItem: (key, value) => session.set(key, value) } });
  vm.runInContext(source.slice(source.indexOf('  function onboardingSeen('), source.indexOf('  function placeOnboardingCard(')), c);
  assert.equal(c.onboardingSeen(), false);
  c.rememberOnboarding();
  assert.equal(session.get('walking.onboarding.v1'), 'seen');
  assert.equal(c.onboardingSeen(), true);
  c.sessionStorage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  assert.doesNotThrow(() => c.rememberOnboarding());
  assert.equal(c.onboardingSeen(), false);
});


test('updated guide explains current search scopes, time bounds and saved routes without removed measurement features', () => {
  for (const path of ['index.html', 'templates/index.html']) {
    const html=fs.readFileSync(`${__dirname}/${path}`, 'utf8');
    const guide=html.slice(html.indexOf('<dialog id="onboarding-guide"'),html.indexOf('</dialog>'));
    const pages=[...guide.matchAll(/<section class="onboarding-page"[\s\S]*?<\/section>/g)].map(m=>m[0]);
    assert.equal(pages.length,9);
    for(const text of ['下限～上限','ランダムに探す','食事処','地図の中心','半径2km','ルート沿い','経由地にする','保存した道をなるべく避ける'])assert.ok(guide.includes(text),text);
    assert.doesNotMatch(guide,/歩数|計測|今日の気分|GPS推定/);
    for(let i=0;i<pages.length;i++){
      const target=pages[i].match(/data-guide-target="#([^"]+)"/)[1];
      assert.ok(html.includes(`id="${target}"`),target);
      assert.ok(pages[i].includes(`${String(i+1).padStart(2,'0')} / 09`));
    }
    assert.equal((guide.match(/data-onboarding-go=/g)||[]).length,pages.length);
  }
});


test('a long guide scrolls its explanation instead of covering the target on small phones',()=>{
  const c=vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('  function onboardingCardHeight('),source.indexOf('  function positionGuide(')),c);
  const target={left:11,right:309,top:347,bottom:407},viewport={width:320,height:568},card={width:296,height:368};
  const cap=c.onboardingCardHeight(target,card,viewport);assert.equal(cap,319);
  const placed=place(target,{...card,height:cap},viewport);assert.equal(overlaps(target,placed,{...card,height:cap}),false);
  assert.equal(c.onboardingCardHeight({left:12,right:398,top:200,bottom:250},{width:360,height:300},{width:844,height:390}),366);
});
