// STOCK RADAR — PWA 서비스워커
// 역할: (1) 앱 셸(정적 파일)만 가볍게 캐싱해서 홈화면 아이콘 실행 시 빠르게 뜨게 함
//       (2) 웹 푸시(Web Push) 알림 수신·표시
// 실데이터(Supabase REST 호출)는 캐싱하지 않음 — 항상 네트워크에서 최신값을 받아옴.

const CACHE_NAME = 'stock-radar-shell-v1';
const SHELL_FILES = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 앱 셸 파일만 "네트워크 우선, 실패 시 캐시" — Supabase/relay-server API 요청(다른 오리진)은 손대지 않음
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // 다른 오리진(Supabase, Render 등)은 그대로 통과
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── 웹 푸시 알림 수신 ──────────────────────────────────────────────────────
// relay-server가 web-push로 보내는 페이로드: { title, body, url, tag }
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {
    data = { title: 'STOCK RADAR', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'STOCK RADAR';
  const options = {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: data.tag || undefined,
    data: { url: data.url || './' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
