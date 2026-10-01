// 사랑교육 로그인 부품 v1 (2026-10-01) — 서버 설계 S3 1차: 구글 로그인, 계정 문서, 기기 제한, 아이 프로필·진도 저장
// 근거: roadmap/사랑교육_서버설계_v1.md 2절(데이터), 4-1(로그인·이관), 4-2(폰 1 + PC 1).
// 화면은 없음. 앱 화면(앱 스레드)이 이 함수들을 부른다. 카카오 로그인은 카카오 앱 등록 뒤 추가.
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

export function createSarangAuth({ sdk, config = LOVEDU_DEV, name = 'sarang', emulator = null, storage = globalThis.localStorage, nav = globalThis.navigator } = {}) {
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

  const uid = () => {
    if (!auth.currentUser) throw new Error('로그인이 필요해요.');
    return auth.currentUser.uid;
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
    if (!u) return emit({ user: null, ready: true });
    try {
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

    settings: {
      async load(name) { const s = await sdk.getDoc(sdk.doc(db, 'users', uid(), 'settings', name)); return s.exists() ? s.data() : null; },
      save(name, data) { return sdk.setDoc(sdk.doc(db, 'users', uid(), 'settings', name), data, { merge: true }); },
    },

    // 검사용
    _auth: auth,
  };
}
