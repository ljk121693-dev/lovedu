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
