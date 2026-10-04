// 사랑교육 로그인 부품 v1.2 (2026-10-04: 아이 폰 연결·숙제 추가, 앱 스레드) — v1.1 (2026-10-02) — 서버 설계 S3: 구글·카카오 로그인, 계정 문서, 기기 제한, 아이 프로필·진도 저장
// 근거: roadmap/사랑교육_서버설계_v1.md 2절(데이터), 4-1(로그인·이관), 4-2(폰 1 + PC 1).
// 화면은 없음. 앱 화면(앱 스레드)이 이 함수들을 부른다.
//
// 쓰는 법 (브라우저):
//   import { createSarangAuth } from './sarang-auth.js';
//   import * as sdk from './sarang-auth-sdk.js';          // Firebase SDK 묶음 (아래 파일)
//   const auth = createSarangAuth({ sdk });
//   auth.onChange(({ user, kicked }) => { ... });           // 로그인·로그아웃·다른 기기로 밀려남

export const LOVEDU_DEV = {
  apiKey: 'AIzaSyAK3TfFxxkf9iTBBUTwWayWceFlG2gvAc0',       // 웹 앱 공개 설정값 (비밀 아님, 보안은 규칙이 맡음)
  authDomain: 'lovedu-dev.firebaseapp.com',
  projectId: 'lovedu-dev',
  storageBucket: 'lovedu-dev.firebasestorage.app',
  messagingSenderId: '843439736761',
  appId: '1:843439736761:web:f525362c6da8c4d5a8d868',
  kakaoRestKey: 'f73cdb968d1937ab3979ab40bb972929',                                          // 카카오 REST API 키 (주소창에 드러나는 공개값). 대표님 등록 뒤 채움
};
const REGION = 'asia-northeast3';
const CHILD_IDS = ['c1', 'c2', 'c3'];                           // 아이 프로필 최대 3명 (규칙과 같음)
const SUBJECTS = ['kor', 'eng', 'math', 'soc', 'sci', 'his', 'wh', 'hanja'];

// 기기 종류: 앱·휴대폰·태블릿 브라우저 = phone, PC 브라우저 = pc (설계 4-2)
export function deviceKind(nav = globalThis.navigator) {
  if (!nav) return 'pc';
  if (nav.userAgentData && typeof nav.userAgentData.mobile === 'boolean' && nav.userAgentData.mobile) return 'phone';
  const ua = nav.userAgent || '';
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return 'phone';
  if (/Macintosh/.test(ua) && nav.maxTouchPoints > 1) return 'phone';   // iPadOS는 맥으로 보임
  return 'pc';
}

export function createSarangAuth({ sdk, config = LOVEDU_DEV, name = 'sarang', emulator = null, storage = globalThis.localStorage, session = globalThis.sessionStorage, nav = globalThis.navigator, go = u => globalThis.location.assign(u), kakaoAuthBase = 'https://kauth.kakao.com' } = {}) {
  const app = sdk.initializeApp(config, name);
  const auth = sdk.getAuth(app);
  const db = sdk.getFirestore(app);
  const fns = sdk.getFunctions(app, REGION);
  if (emulator) {
    sdk.connectAuthEmulator(auth, `http://${emulator.host}:${emulator.auth}`, { disableWarnings: true });
    sdk.connectFirestoreEmulator(db, emulator.host, emulator.firestore);
    sdk.connectFunctionsEmulator(fns, emulator.host, emulator.functions);
  }
  const kind = deviceKind(nav);
  const sKey = uid => `sarang_session_${uid}`;
  const get = k => { try { return storage.getItem(k); } catch (e) { return null; } };
  const put = (k, v) => { try { v == null ? storage.removeItem(k) : storage.setItem(k, v); } catch (e) {} };

  const listeners = new Set();
  let state = { user: null, kicked: false, ready: false };
  const emit = patch => { state = { ...state, ...patch }; listeners.forEach(f => { try { f(state); } catch (e) { console.error(e); } }); };
  let stopWatch = null;
  let kicking = false;

  const call = async (name, data = {}) => (await sdk.httpsCallable(fns, name)(data)).data;
  let kidClaims = null;   // 아이 폰(자녀 모드)으로 들어온 경우 { owner, childId, deviceId }
  const uid = () => {
    if (!auth.currentUser) throw new Error('로그인이 필요해요.');
    return kidClaims ? kidClaims.owner : auth.currentUser.uid;   // 아이 폰은 부모 계정 아래 그 아이 문서만 씀 (규칙 isChild)
  };
  const userRef = () => sdk.doc(db, 'users', uid());
  const childRef = id => {
    if (!CHILD_IDS.includes(id)) throw new Error('아이 프로필은 c1~c3 이에요.');
    return sdk.doc(db, 'users', uid(), 'children', id);
  };

  // 처음 로그인하면 계정 문서를 만든다. providers 등 서버 필드는 함수만 쓴다.
  async function ensureUserDoc(u) {
    const ref = sdk.doc(db, 'users', u.uid);
    const snap = await sdk.getDoc(ref);
    if (!snap.exists()) await sdk.setDoc(ref, { email: u.email || null, createdAt: sdk.serverTimestamp() });
  }

  // 이 기기 자리(phone 또는 pc)를 차지하고, 다른 기기가 같은 자리를 가져가면 로그아웃한다.
  async function claimSeat(u) {
    let mine = get(sKey(u.uid));
    if (!mine) {
      const label = String((nav && nav.userAgentData && nav.userAgentData.platform) || (nav && nav.platform) || '').slice(0, 40);
      const res = await sdk.httpsCallable(fns, 'registerDevice')({ kind, label });
      mine = res.data.sessionId;
      put(sKey(u.uid), mine);
    }
    stopWatch = sdk.onSnapshot(sdk.doc(db, 'users', u.uid, 'devices', kind), snap => {
      if (snap.metadata.fromCache) return;   // 다시 로그인할 때 캐시의 옛 sessionId로 자기를 밀어내지 않게 (앱 스레드 제보)
      const now = snap.exists() ? snap.data().sessionId : null;
      if (now && now !== mine && !kicking) {
        kicking = true;
        put(sKey(u.uid), null);
        sdk.signOut(auth).finally(() => { kicking = false; emit({ kicked: true }); });
      }
    }, err => console.warn('기기 확인 실패', err.code));
  }

  sdk.onAuthStateChanged(auth, async u => {
    if (stopWatch) { stopWatch(); stopWatch = null; }
    if (!u) { kidClaims = null; return emit({ user: null, ready: true }); }
    try {
      // 아이 폰: 부모 기기 자리(폰 1 + PC 1)를 쓰지 않고, 계정 문서도 만들지 않음 (설계 4-8)
      const t = await u.getIdTokenResult().catch(() => null), c = t && t.claims;
      if (c && c.role === 'child') {
        kidClaims = { owner: c.owner, childId: c.childId, deviceId: c.deviceId };
        return emit({ user: { uid: u.uid, child: kidClaims }, kicked: false, ready: true });
      }
      kidClaims = null;
      await ensureUserDoc(u);
      await claimSeat(u);
      emit({ user: { uid: u.uid, email: u.email, name: u.displayName }, kicked: false, ready: true });
    } catch (e) {
      console.error('로그인 마무리 실패', e);
      put(sKey(u.uid), null);
      await sdk.signOut(auth);
      emit({ user: null, ready: true, error: e.message || String(e) });
    }
  });

  return {
    deviceKind: kind,
    get state() { return state; },
    onChange(f) { listeners.add(f); if (state.ready) f(state); return () => listeners.delete(f); },

    // 구글 로그인: 팝업, 막히면 페이지 이동 방식
    async signInGoogle() {
      const p = new sdk.GoogleAuthProvider();
      p.setCustomParameters({ prompt: 'select_account' });
      try { await sdk.signInWithPopup(auth, p); }
      catch (e) {
        if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(e.code)) return sdk.signInWithRedirect(auth, p);
        if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return null;
        throw e;
      }
    },
    // 카카오 로그인 1단계: 카카오 로그인 화면으로 이동. 돌아오면 같은 페이지에서 completeKakao()를 부른다.
    // redirectUri는 카카오 디벨로퍼스에 등록한 주소와 글자까지 같아야 한다.
    signInKakao({ redirectUri = globalThis.location.origin + globalThis.location.pathname } = {}) {
      if (!config.kakaoRestKey) throw new Error('카카오 로그인 준비 중이에요.');
      const state = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
      try { session.setItem('sarang_kakao', JSON.stringify({ state, redirectUri })); } catch (e) {}
      const q = new URLSearchParams({ client_id: config.kakaoRestKey, redirect_uri: redirectUri, response_type: 'code', state });
      go(`${kakaoAuthBase}/oauth/authorize?${q}`);
    },
    // 카카오 로그인 2단계: 주소에 code가 있으면 서버에서 토큰으로 바꿔 로그인. code가 없으면 null.
    // 결과 sameEmailAccount가 있으면 같은 이메일의 다른 로그인 방식 계정이 있다는 뜻 (앱이 안내).
    async completeKakao(url = globalThis.location.href) {
      const u = new URL(url);
      const code = u.searchParams.get('code'), state = u.searchParams.get('state'), err = u.searchParams.get('error');
      if (!code && !err) return null;
      let saved = null;
      try { saved = JSON.parse(session.getItem('sarang_kakao')); session.removeItem('sarang_kakao'); } catch (e) {}
      ['code', 'state', 'error', 'error_description'].forEach(k => u.searchParams.delete(k));
      try { globalThis.history.replaceState(null, '', u.pathname + u.search + u.hash); } catch (e) {}
      if (err) return { status: 'cancelled' };
      if (!saved || saved.state !== state) throw new Error('카카오 로그인을 다시 시도해 주세요.');
      const r = await sdk.httpsCallable(fns, 'kakaoSignIn')({ code, redirectUri: saved.redirectUri });
      await sdk.signInWithCustomToken(auth, r.data.token);
      return { status: 'ok', isNew: r.data.isNew, sameEmailAccount: r.data.sameEmailAccount };
    },

    async signOut() {
      if (auth.currentUser) put(sKey(auth.currentUser.uid), null);
      return sdk.signOut(auth);
    },

    // 가입 동의 (약관·개인정보처리방침 버전). 동의 전이면 앱이 '가입 마무리' 화면을 보여 준다.
    async hasConsent() {
      const s = await sdk.getDoc(userRef());
      return !!(s.exists() && s.data().consent && s.data().consent.parentAgreedAt);
    },
    saveConsent({ termsVersion, privacyVersion }) {
      if (!termsVersion || !privacyVersion) throw new Error('약관·개인정보처리방침 버전이 필요해요.');
      return sdk.setDoc(userRef(), { consent: { parentAgreedAt: sdk.serverTimestamp(), termsVersion, privacyVersion } }, { merge: true });
    },

    // 체험 기록 이관 판단용: 계정에 이미 아이 프로필이 있는지 (있으면 앱이 "어느 쪽을 쓸까요?"를 묻는다)
    async hasCloudData() {
      const s = await sdk.getDocs(sdk.collection(db, 'users', uid(), 'children'));
      return !s.empty;
    },

    children: {
      async list() {
        const s = await sdk.getDocs(sdk.collection(db, 'users', uid(), 'children'));
        return s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.id.localeCompare(b.id));
      },
      // 한 아이 문서 (아이 폰은 목록을 못 읽고 자기 아이 문서만 읽음)
      async get(id) { const s = await sdk.getDoc(childRef(id)); return s.exists() ? { id: s.id, ...s.data() } : null; },
      // 빈 자리 id (c1~c3), 없으면 null
      async freeId() {
        const used = new Set((await this.list()).map(c => c.id));
        return CHILD_IDS.find(id => !used.has(id)) || null;
      },
      async save(id, data) {
        const ref = childRef(id);
        const snap = await sdk.getDoc(ref);
        const body = { ...data };
        if (!snap.exists()) body.createdAt = sdk.serverTimestamp();
        return sdk.setDoc(ref, body, { merge: true });
      },
      remove(id) { return sdk.deleteDoc(childRef(id)); },
    },

    progress: {
      async load(childId) {
        const s = await sdk.getDocs(sdk.collection(childRef(childId), 'progress'));
        const out = {};
        s.docs.forEach(d => { out[d.id] = d.data(); });
        return out;
      },
      save(childId, subject, data) {
        if (!SUBJECTS.includes(subject)) throw new Error('과목 키가 잘못됐어요: ' + subject);
        return sdk.setDoc(sdk.doc(childRef(childId), 'progress', subject), { ...data, updatedAt: sdk.serverTimestamp() }, { merge: true });
      },
    },

    // 출력 기록 (환불 판단 근거, 서버 시각, 고치거나 지울 수 없음)
    recordPrint(childId, subject, day) {
      if (!SUBJECTS.includes(subject)) throw new Error('과목 키가 잘못됐어요: ' + subject);
      return sdk.addDoc(sdk.collection(childRef(childId), 'prints'), { subject, day, at: sdk.serverTimestamp() });
    },

    // 바로 풀기 기록 (환불 '이용' 기준 D2, 서버 시각, 고칠 수 없음)
    recordSolve(childId, subject, day, more = {}) {   // more: 아이 폰 결과 { score, total, via:'kid' } (부모 현황판·숙제 화면용)
      if (!SUBJECTS.includes(subject)) throw new Error('과목 키가 잘못됐어요: ' + subject);
      return sdk.addDoc(sdk.collection(childRef(childId), 'solves'), { ...more, subject, day, at: sdk.serverTimestamp() });
    },

    // 구독 결제 (서버 함수). 금액은 서버가 정한다. 자세한 흐름은 앱연결_안내.md '구독 결제'.
    subscription: {
      get: () => call('getSubscription'),                                   // { state: trial|active|grace|none, quotes, ... }
      applyCode: code => call('applySignupCode', { code }),                 // 초대·경로·기관 코드 (가입 때 한 번)
      claimBetaFree: () => call('claimBetaFree'),                           // 사전등록자 2개월 무료
      startCheckout: (plan, method) => call('startCheckout', { plan, method }), // plan: monthly|yearly, method: card|phone|vbank
      confirmBilling: (orderId, billingKey) => call('confirmBilling', { orderId, billingKey }),
      cancel: () => call('cancelSubscription'),                             // 5분 안에 다시 로그인 필요
      refundQuote: () => call('refundQuote'),
      refund: () => call('requestRefund'),                                  // 5분 안에 다시 로그인 필요
      verifyPlay: (productId, purchaseToken) => call('verifyPlayPurchase', { productId, purchaseToken }),
    },

    // 아이 폰 연결 (설계 4-8, 함수 createInvite·previewInvite·redeemInvite·unlinkDevice)
    kidDevice: {
      invite: childId => call('createInvite', { childId }),                 // 부모: { inviteId, code, expiresAt }
      unlink: deviceId => call('unlinkDevice', { deviceId }),               // 부모
      // 부모: 살아 있는 아이 폰 목록을 지켜봄 → f([{ id, childId, label, platform, linkedAt }]). 끝낼 때 돌려준 함수를 부름
      watch(f, onErr) {
        const q = sdk.query(sdk.collection(db, 'users', uid(), 'childDevices'), sdk.where('revoked', '==', false));
        return sdk.onSnapshot(q, s => f(s.docs.map(d => ({ id: d.id, ...d.data() }))), e => onErr && onErr(e));
      },
      // 아이 폰: 로그인 없이 번호(code)나 링크 id(inviteId)로 별명·학년 미리 보기 → 연결 (커스텀 토큰으로 로그인)
      preview: ref => call('previewInvite', ref),
      async redeem(ref, { label = '', platform = '' } = {}) {
        const r = await call('redeemInvite', { ...ref, label, platform });
        if (r.status !== 'ok') return r;
        await sdk.signInWithCustomToken(auth, r.token);
        return { status: 'ok', childId: r.childId };
      },
      get claims() { return kidClaims; },
      // 아이 폰: 연결이 끊겼는지 지켜봄 (부모가 '연결 끊기' → revoked). f(true) = 끊김
      watchSelf(f) {
        if (!kidClaims) return () => {};
        return sdk.onSnapshot(sdk.doc(db, 'users', kidClaims.owner, 'childDevices', kidClaims.deviceId),
          s => f(!s.exists() || s.data().revoked !== false), e => { if (e && e.code === 'permission-denied') f(true); });
      },
      markSeen: (subject, day) => call('markSeen', { subject, day }),
    },

    // 숙제 (users/{uid}/homework, 설계 2절·숙제 메모 2절). 부모가 만들고, 아이 폰은 과목 상태만 앞으로 (규칙 childItemUpdate)
    homework: {
      send(childId, { from, message = '', dateKey, items }) {
        return sdk.addDoc(sdk.collection(db, 'users', uid(), 'homework'), {
          childId, from, message: String(message).slice(0, 30), dateKey, items,
          total: Object.keys(items).length, doneCount: 0, createdAt: sdk.serverTimestamp(),
        });
      },
      // 그 아이의 그날 숙제를 지켜봄 → f([{ id, ...문서 }]) 새것 먼저
      watch(childId, dateKey, f, onErr) {
        const q = sdk.query(sdk.collection(db, 'users', uid(), 'homework'), sdk.where('childId', '==', childId), sdk.where('dateKey', '==', dateKey));
        return sdk.onSnapshot(q, s => f(s.docs.map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => ((b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : Date.now()) - (a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : Date.now())))), e => onErr && onErr(e));
      },
      // 과목 상태 바꾸기 (아이 폰: sent → seen → done, 부모: 무엇이든)
      setItem(hwId, subject, patch) {
        const body = {};
        Object.entries(patch).forEach(([k, v]) => { body[`items.${subject}.${k}`] = v; });
        return sdk.updateDoc(sdk.doc(db, 'users', uid(), 'homework', hwId), body);
      },
      remove: hwId => sdk.deleteDoc(sdk.doc(db, 'users', uid(), 'homework', hwId)),   // 부모: 거두기
    },

    settings: {
      async load(name) { const s = await sdk.getDoc(sdk.doc(db, 'users', uid(), 'settings', name)); return s.exists() ? s.data() : null; },
      save(name, data) { return sdk.setDoc(sdk.doc(db, 'users', uid(), 'settings', name), data, { merge: true }); },
    },

    // 검사용
    _auth: auth,
  };
}
