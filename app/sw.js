/* 사랑교육 앱 바로가기(설치)용 서비스 워커 — 2026-10-04 대표 "PC 바탕화면에 앱 바로가기".
   저장(캐시)은 하지 않음: 새 판을 올리면 바로 새 판이 열려야 하므로 같은 주소의 파일 요청만 그대로 넘김.
   페이지 이동(로그인에서 돌아오기 등)과 다른 주소(구글·카카오·Firebase)는 손대지 않음 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || r.mode === 'navigate' || new URL(r.url).origin !== self.location.origin) return;
  e.respondWith(fetch(r));
});

/* ---------- 웹 푸시 (서버 배포 직후 앱 판, handoff/웹푸시_서버답_1005.md 4절) ----------
   서버(FCM)는 글 없는 데이터 메시지만 보냄: { type, to, childId, phraseNo?, cheerId? } (모두 문자열). 알림은 여기서 고정 문구로 띄움.
   - cheer(응원 한마디): 아이 폰 = 문구 번호의 글, 부모 = '○○에게 응원 한마디를 보냈어요'. 한국 21시~08시에 받으면 띄우지 않음(서버도 그 시간엔 안 보냄).
     같은 cheerId 는 한 번만 (일시 오류로 다시 올 수 있음, 모음7 앱안내 3절)
   - dismissal(우리 아이 학교생활, 하교 30분 전, 부모): '○○ 하교 30분 전이에요'
   - 그 밖(today·homework·report 는 서버 발송 전): '사랑교육 알림이 왔어요'
   별명·보낸 사람은 앱이 이 기기 캐시(sarang-push 의 ./push-cfg)에 둔 것 (src/acct.js pushCfg). 문구는 build.py 가 src/acct.js PHRASES 를 그대로 넣음 */
const CHEER = [
    '{보낸이}의 응원이에요! 오늘 한 장만 같이 해 볼까?',
    '보고 싶었어! 오늘은 쉬운 것부터 하나 해 보자.',
    '{이름}~ 오늘 5분만 공부해 볼래? {보낸이}의 응원이 함께해.',
    '다시 시작하는 날이야. 한 문제만 풀어도 최고야!',
    '{보낸이}의 응원이에요. 오늘 공부 하나 해 볼까?',
    '쉬는 날 잘 쉬었지? 오늘은 바로 풀기 하나 해 보자!',
    '조금씩 해도 괜찮아. 오늘 한 장이면 충분해.',
    '{이름}! 오늘 배운 것 저녁에 {보낸이}한테 알려 줄래?',
    "숙제를 마치고 '다 했어요'를 누르면 스티커를 받을 수 있어! 천천히 해 보자.",
    '천천히 해도 돼. {보낸이}의 응원은 늘 이어져!'
  ];
const callName = n => { n = String(n || '').trim(); if (!n) return ''; const c = n.charCodeAt(n.length - 1); return n + (c >= 0xAC00 && c <= 0xD7A3 && (c - 0xAC00) % 28 ? '아' : '야'); };
const cheerText = (no, name, from) => { const p = CHEER[(Number(no) || 1) - 1] || CHEER[0] || '', nm = callName(name); return (nm ? p.replace('{이름}', nm) : p.replace(/^\{이름\}[~!]\s*/, '')).replace(/\{보낸이\}/g, from || '부모님'); };
const kstHour = t => (new Date(t).getUTCHours() + 9) % 24;
async function pushCfg(){ try { const c = await caches.open('sarang-push'), r = await c.match('./push-cfg'); return r ? await r.json() : {}; } catch (e) { return {}; } }
async function seenOnce(id){
  if (!id) return false;
  try {
    const c = await caches.open('sarang-push'), r = await c.match('./push-seen'), l = r ? await r.json() : [];
    if (l.includes(id)) return true;
    await c.put('./push-seen', new Response(JSON.stringify([id, ...l].slice(0, 30)), { headers: { 'content-type': 'application/json' } }));
  } catch (e) {}
  return false;
}
async function onPush(d, now){
  const cfg = await pushCfg(), name = (cfg.kids || {})[d.childId] || '';
  let title = '사랑교육', body = '사랑교육 알림이 왔어요.', tag = d.type || 'sarang';
  if (d.type === 'cheer') {
    if (kstHour(now) >= 21 || kstHour(now) < 8) return null;
    if (await seenOnce('cheer:' + (d.cheerId || ''))) return null;
    tag = 'cheer-' + (d.cheerId || d.childId || '');
    if (d.to === 'child') { title = '응원 한마디'; body = cheerText(d.phraseNo, name, cfg.from); }
    else body = `${name || '아이'}에게 응원 한마디를 보냈어요.`;
  } else if (d.type === 'dismissal') {
    tag = 'dismissal-' + (d.childId || '');
    title = '우리 아이 학교생활'; body = `${name || '우리 아이'} 하교 30분 전이에요.`;
  }
  return { title, body, tag };
}
self.addEventListener('push', e => {
  let j = {}; try { j = e.data ? e.data.json() : {}; } catch (er) {}
  const d = (j && typeof j.data === 'object' && j.data) || j || {};
  e.waitUntil(onPush(d, Date.now()).then(n => n && self.registration.showNotification(n.title, { body: n.body, tag: n.tag, icon: 'icon-192.png', badge: 'icon-192.png', lang: 'ko', data: { type: d.type || '' } })));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(l => {
    const w = l.find(c => new URL(c.url).pathname.startsWith(new URL('./', self.location).pathname));
    return w ? w.focus() : self.clients.openWindow('./');
  }));
});
self.SARANG_SW = { onPush, cheerText };   // 검사용
