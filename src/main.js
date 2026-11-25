import './style.css';
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  GoogleAuthProvider,
  signInWithCredential,
} from 'firebase/auth';
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  serverTimestamp,
  arrayUnion,
  arrayRemove,
  deleteField,
  writeBatch,
  getDocs,
} from 'firebase/firestore';
import { auth, db, googleProvider, isConfigured, useEmulators } from './firebase.js';

/* ---------------------------------------------------------------- constants */

const CATEGORIES = [
  { id: 'outdoors', label: 'Outdoors', emoji: '🌳' },
  { id: 'food', label: 'Food & Drink', emoji: '🍝' },
  { id: 'home', label: 'At Home', emoji: '🏠' },
  { id: 'adventure', label: 'Adventure', emoji: '🎢' },
  { id: 'culture', label: 'Culture', emoji: '🎭' },
  { id: 'relax', label: 'Relaxing', emoji: '🧖' },
  { id: 'other', label: 'Other', emoji: '✨' },
];
const BUDGETS = ['Free', '$', '$$', '$$$'];

const STARTER_IDEAS = [
  ['Picnic in the park at sunset', 'outdoors', 1],
  ['Cook a dish from a country neither of you has visited', 'home', 1],
  ['Stargazing with blankets and hot cocoa', 'outdoors', 0],
  ['Try a cuisine you have never had', 'food', 2],
  ['Movie marathon with a homemade blanket fort', 'home', 0],
  ['Visit a museum or gallery', 'culture', 1],
  ['Sunrise hike', 'outdoors', 0],
  ['Pottery or painting class', 'adventure', 2],
  ['Board game & takeout night', 'home', 1],
  ['Spa evening at home: face masks & massages', 'relax', 1],
  ['See live music or a comedy show', 'culture', 2],
  ['Fancy dinner, dressed up', 'food', 3],
];

const PENDING_JOIN_KEY = 'datejar.pendingJoin';
const CURRENT_JAR_KEY = 'datejar.currentJar';

/* -------------------------------------------------------------------- state */

const state = {
  user: null,
  authReady: false,
  jars: [],
  jarsLoaded: false,
  currentJarId: localStorage.getItem(CURRENT_JAR_KEY),
  ideas: [],
  ideasLoaded: false,
  tab: 'jar', // 'jar' | 'done'
  filterCategory: '',
  filterBudget: '',
  picked: null,
  shaking: false,
  view: 'main', // 'main' | 'settings' | 'newJar'
  joinStatus: null, // null | 'joining' | 'error'
};

let unsubJars = null;
let unsubIdeas = null;
let ideasJarId = null;

/* ------------------------------------------------------------------ helpers */

/** Tiny DOM builder. Text children are always inserted as text nodes (no HTML injection). */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') node.value = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 24);
}

function category(id) {
  return CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];
}

function firstName(name) {
  return (name || 'Someone').split(' ')[0];
}

function profile(user) {
  return { name: user.displayName || user.email || 'Someone', photo: user.photoURL || '' };
}

function currentJar() {
  return state.jars.find((j) => j.id === state.currentJarId) || null;
}

function inviteLink(jar) {
  const url = new URL(import.meta.env.BASE_URL, location.origin);
  url.searchParams.set('join', `${jar.id}.${jar.inviteCode}`);
  return url.toString();
}

function avatar(info, size = 32) {
  const name = info?.name || '?';
  if (info?.photo) {
    return el('img', {
      class: 'avatar',
      src: info.photo,
      alt: name,
      title: name,
      width: size,
      height: size,
      referrerpolicy: 'no-referrer',
    });
  }
  return el('span', { class: 'avatar fallback', title: name, style: `width:${size}px;height:${size}px` }, name[0].toUpperCase());
}

function formatDate(ts) {
  if (!ts?.toDate) return '';
  return ts.toDate().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/* -------------------------------------------------------------------- auth */

async function signIn() {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(err.code)) {
      await signInWithRedirect(auth, googleProvider);
    } else if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
      console.error(err);
      toast('Sign-in failed. Please try again.');
    }
  }
}

/* -------------------------------------------------------------- data layer */

function subscribeJars(uid) {
  unsubJars?.();
  state.jarsLoaded = false;
  const q = query(collection(db, 'jars'), where('members', 'array-contains', uid));
  unsubJars = onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      state.jars = snap.docs
        .map((d) => ({ id: d.id, ...d.data(), pending: d.metadata.hasPendingWrites }))
        .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
      state.jarsLoaded = true;
      if (!currentJar()) selectJar(state.jars[0]?.id || null, false);
      maybeJoin();
      syncIdeasSubscription();
      render();
    },
    (err) => {
      console.error(err);
      toast('Could not load your jars.');
    },
  );
}

function syncIdeasSubscription() {
  const jar = currentJar();
  // A brand-new jar only exists locally until the server confirms it; the server's
  // security rules can't see it yet, so wait for the confirmed snapshot.
  if (jar?.pending && jar.id !== ideasJarId) return;
  const jarId = jar?.id || null;
  if (jarId === ideasJarId) return;
  unsubIdeas?.();
  unsubIdeas = null;
  ideasJarId = jarId;
  state.ideas = [];
  state.ideasLoaded = false;
  state.picked = null;
  if (!jarId) return;
  const q = query(collection(db, 'jars', jarId, 'ideas'), orderBy('createdAt', 'desc'));
  unsubIdeas = onSnapshot(
    q,
    (snap) => {
      state.ideas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.ideasLoaded = true;
      if (state.picked) state.picked = state.ideas.find((i) => i.id === state.picked.id && !i.done) || null;
      render();
    },
    (err) => {
      // Usually a race with joining/creating the jar: retry once things settle.
      if (err.code !== 'permission-denied') console.error(err);
      if (ideasJarId === jarId) {
        ideasJarId = null;
        setTimeout(() => {
          if (currentJar()?.id === jarId) syncIdeasSubscription();
        }, 1500);
      }
    },
  );
}

function selectJar(id, rerender = true) {
  state.currentJarId = id;
  if (id) localStorage.setItem(CURRENT_JAR_KEY, id);
  else localStorage.removeItem(CURRENT_JAR_KEY);
  state.view = 'main';
  state.tab = 'jar';
  state.picked = null;
  syncIdeasSubscription();
  if (rerender) render();
}

async function createJar(name) {
  const user = state.user;
  const ref = await addDoc(collection(db, 'jars'), {
    name: name.trim().slice(0, 60) || 'Our Date Jar',
    createdBy: user.uid,
    createdAt: serverTimestamp(),
    inviteCode: randomCode(),
    members: [user.uid],
    memberInfo: { [user.uid]: profile(user) },
  });
  selectJar(ref.id);
  return ref.id;
}

function readPendingJoin() {
  const params = new URLSearchParams(location.search);
  const raw = params.get('join');
  if (raw) {
    sessionStorage.setItem(PENDING_JOIN_KEY, raw);
    params.delete('join');
    const clean = location.pathname + (params.toString() ? `?${params}` : '') + location.hash;
    history.replaceState(null, '', clean);
  }
  return sessionStorage.getItem(PENDING_JOIN_KEY);
}

function parseJoin(raw) {
  if (!raw) return null;
  const [jarId, code] = raw.trim().split('.');
  if (!jarId || !code) return null;
  return { jarId, code };
}

async function maybeJoin() {
  const pending = parseJoin(sessionStorage.getItem(PENDING_JOIN_KEY));
  if (!pending || !state.user || !state.jarsLoaded || state.joinStatus === 'joining') return;

  if (state.jars.some((j) => j.id === pending.jarId)) {
    sessionStorage.removeItem(PENDING_JOIN_KEY);
    selectJar(pending.jarId);
    return;
  }

  state.joinStatus = 'joining';
  render();
  try {
    await updateDoc(doc(db, 'jars', pending.jarId), {
      members: arrayUnion(state.user.uid),
      [`memberInfo.${state.user.uid}`]: { ...profile(state.user), joinCode: pending.code },
    });
    sessionStorage.removeItem(PENDING_JOIN_KEY);
    state.joinStatus = null;
    selectJar(pending.jarId);
    toast('You joined the jar! 💞');
  } catch (err) {
    console.error(err);
    sessionStorage.removeItem(PENDING_JOIN_KEY);
    state.joinStatus = 'error';
    render();
  }
}

async function joinFromInput(value) {
  let raw = value.trim();
  try {
    raw = new URL(raw).searchParams.get('join') || raw;
  } catch {
    /* not a URL – maybe a bare code */
  }
  if (!parseJoin(raw)) {
    toast("That doesn't look like an invite link.");
    return;
  }
  sessionStorage.setItem(PENDING_JOIN_KEY, raw);
  state.joinStatus = null;
  await maybeJoin();
}

async function addIdea({ text, category, budget }) {
  const jar = currentJar();
  await addDoc(collection(db, 'jars', jar.id, 'ideas'), {
    text: text.trim().slice(0, 200),
    category,
    budget: Number(budget),
    done: false,
    doneAt: null,
    addedBy: state.user.uid,
    addedByName: profile(state.user).name,
    createdAt: serverTimestamp(),
  });
}

async function addStarterIdeas() {
  const jar = currentJar();
  const batch = writeBatch(db);
  for (const [text, cat, budget] of STARTER_IDEAS) {
    batch.set(doc(collection(db, 'jars', jar.id, 'ideas')), {
      text,
      category: cat,
      budget,
      done: false,
      doneAt: null,
      addedBy: state.user.uid,
      addedByName: profile(state.user).name,
      createdAt: serverTimestamp(),
    });
  }
  await batch.commit();
  toast('Added 12 starter ideas ✨');
}

function ideaRef(idea) {
  return doc(db, 'jars', currentJar().id, 'ideas', idea.id);
}

async function markDone(idea, done) {
  await updateDoc(ideaRef(idea), { done, doneAt: done ? serverTimestamp() : null });
}

async function removeIdea(idea) {
  await deleteDoc(ideaRef(idea));
}

async function leaveJar(jar) {
  const uid = state.user.uid;
  if (jar.members.length === 1) {
    // Last one out: delete ideas, then the jar itself.
    const ideas = await getDocs(collection(db, 'jars', jar.id, 'ideas'));
    const docs = ideas.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const batch = writeBatch(db);
      docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    await deleteDoc(doc(db, 'jars', jar.id));
  } else {
    await updateDoc(doc(db, 'jars', jar.id), {
      members: arrayRemove(uid),
      [`memberInfo.${uid}`]: deleteField(),
    });
  }
  selectJar(state.jars.find((j) => j.id !== jar.id)?.id || null);
}

/* ---------------------------------------------------------------- actions */

function pickIdea() {
  const pool = state.ideas.filter(
    (i) =>
      !i.done &&
      (!state.filterCategory || i.category === state.filterCategory) &&
      (state.filterBudget === '' || i.budget <= Number(state.filterBudget)),
  );
  if (!pool.length) {
    toast('No ideas match — try loosening the filters or add more!');
    return;
  }
  // Avoid repeating the same idea back-to-back when possible.
  const options = pool.length > 1 && state.picked ? pool.filter((i) => i.id !== state.picked.id) : pool;
  const choice = options[Math.floor(Math.random() * options.length)];
  state.shaking = true;
  state.picked = null;
  render();
  setTimeout(() => {
    state.shaking = false;
    state.picked = choice;
    render();
  }, 900);
}

async function shareInvite(jar) {
  const link = inviteLink(jar);
  const shareData = {
    title: 'Join our Date Jar 💌',
    text: `Join "${jar.name}" so we can fill it with date ideas together!`,
    url: link,
  };
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share(shareData);
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  await copy(link, 'Invite link copied — send it to your partner!');
}

async function copy(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    prompt('Copy this link:', text);
  }
}

/* ------------------------------------------------------------------- views */

function viewNotConfigured() {
  return el(
    'main',
    { class: 'center card narrow' },
    el('h1', {}, '🫙 Date Jar'),
    el('p', {}, 'This site is not connected to Firebase yet.'),
    el(
      'p',
      { class: 'muted' },
      'Copy .env.example to .env, fill in your Firebase web app config, and restart the dev server. See the README for step-by-step setup.',
    ),
  );
}

function viewLoading(text = 'Loading…') {
  return el('main', { class: 'center' }, el('div', { class: 'spinner', 'aria-hidden': true }), el('p', { class: 'muted' }, text));
}

function viewLanding() {
  const invited = Boolean(sessionStorage.getItem(PENDING_JOIN_KEY));
  return el(
    'main',
    { class: 'landing' },
    el('div', { class: 'hero-jar', 'aria-hidden': true }, '🫙'),
    el('h1', {}, 'Date Jar'),
    invited
      ? el('p', { class: 'lead' }, "You've been invited to share a date jar! 💌 Sign in to join.")
      : el('p', { class: 'lead' }, 'Fill a jar with date ideas together. When you can’t decide, give it a shake.'),
    el(
      'button',
      { class: 'btn google', onclick: signIn },
      el('img', {
        src: 'data:image/svg+xml;utf8,' + encodeURIComponent(GOOGLE_G),
        alt: '',
        width: 20,
        height: 20,
      }),
      'Continue with Google',
    ),
    el(
      'ul',
      { class: 'features' },
      el('li', {}, '💞 Share one jar with your partner'),
      el('li', {}, '✍️ Both of you add ideas, synced live'),
      el('li', {}, '🎲 Shake for a random date — filter by vibe & budget'),
      el('li', {}, '📸 Keep a list of dates you’ve done'),
    ),
  );
}

function viewHeader() {
  const jar = currentJar();
  const user = state.user;
  return el(
    'header',
    { class: 'topbar' },
    el('div', { class: 'brand' }, '🫙 ', el('span', {}, 'Date Jar')),
    state.jars.length > 1
      ? el(
          'select',
          {
            class: 'jar-switch',
            'aria-label': 'Switch jar',
            onchange: (e) => (e.target.value === '__new' ? ((state.view = 'newJar'), render()) : selectJar(e.target.value)),
          },
          state.jars.map((j) => el('option', { value: j.id, selected: j.id === jar?.id }, j.name)),
          el('option', { value: '__new' }, '+ New jar…'),
        )
      : null,
    el(
      'div',
      { class: 'me' },
      avatar(profile(user), 30),
      el('button', { class: 'btn link small', onclick: () => signOut(auth) }, 'Sign out'),
    ),
  );
}

function viewJoinError() {
  return el(
    'div',
    { class: 'banner error' },
    'That invite link is invalid or has been reset. Ask your partner for a fresh link.',
    el('button', { class: 'btn link small', onclick: () => ((state.joinStatus = null), render()) }, 'Dismiss'),
  );
}

function viewNoJar() {
  const nameInput = el('input', { type: 'text', maxlength: 60, placeholder: 'e.g. Alex & Sam’s jar', required: true });
  const linkInput = el('input', { type: 'text', placeholder: 'Paste invite link', required: true });
  return el(
    'main',
    { class: 'container' },
    state.jars.length
      ? el('button', { class: 'btn link', onclick: () => ((state.view = 'main'), render()) }, '← Back')
      : null,
    el('h2', {}, state.jars.length ? 'Start another jar' : `Welcome, ${firstName(state.user.displayName)}! 👋`),
    el(
      'div',
      { class: 'two-col' },
      el(
        'form',
        {
          class: 'card',
          onsubmit: async (e) => {
            e.preventDefault();
            e.submitter && (e.submitter.disabled = true);
            try {
              await createJar(nameInput.value);
              toast('Jar created! Now invite your partner 💌');
            } catch (err) {
              console.error(err);
              toast('Could not create the jar.');
              e.submitter && (e.submitter.disabled = false);
            }
          },
        },
        el('h3', {}, '✨ Create a new jar'),
        el('p', { class: 'muted' }, 'Then share the invite link with your partner.'),
        nameInput,
        el('button', { class: 'btn primary', type: 'submit' }, 'Create jar'),
      ),
      el(
        'form',
        {
          class: 'card',
          onsubmit: (e) => {
            e.preventDefault();
            joinFromInput(linkInput.value);
          },
        },
        el('h3', {}, '💌 Got an invite?'),
        el('p', { class: 'muted' }, 'Open the link your partner sent, or paste it here.'),
        linkInput,
        el('button', { class: 'btn', type: 'submit' }, 'Join jar'),
      ),
    ),
  );
}

function viewMembers(jar) {
  const infos = jar.members.map((uid) => jar.memberInfo?.[uid] || { name: '?' });
  return el(
    'div',
    { class: 'members' },
    el('div', { class: 'avatars' }, infos.map((i) => avatar(i, 34))),
    el('span', { class: 'muted small' }, infos.map((i) => firstName(i.name)).join(' & ')),
  );
}

function viewJarHero(jar) {
  const open = state.ideas.filter((i) => !i.done);
  const doneCount = state.ideas.length - open.length;
  const solo = jar.members.length < 2;
  return el(
    'section',
    { class: 'jar-hero card' },
    el(
      'div',
      { class: 'jar-title-row' },
      el('div', {}, el('h1', { class: 'jar-name' }, jar.name), viewMembers(jar)),
      el(
        'div',
        { class: 'row gap' },
        el('button', { class: 'btn small', onclick: () => shareInvite(jar) }, '💌 Invite'),
        el('button', { class: 'btn small ghost', onclick: () => ((state.view = 'settings'), render()), 'aria-label': 'Jar settings' }, '⚙️'),
      ),
    ),
    solo
      ? el(
          'div',
          { class: 'banner' },
          'Your partner isn’t here yet. ',
          el('button', { class: 'btn link', onclick: () => shareInvite(jar) }, 'Send them the invite link →'),
        )
      : null,
    el(
      'div',
      { class: `jar-visual ${state.shaking ? 'shake' : ''}`, onclick: pickIdea, role: 'button', tabindex: 0, 'aria-label': 'Shake the jar' },
      el('div', { class: 'jar-lid' }),
      el(
        'div',
        { class: 'jar-body' },
        el(
          'div',
          { class: 'slips' },
          open.slice(0, 18).map((_, i) => el('span', { class: 'slip', style: slipStyle(i) })),
        ),
        el('div', { class: 'jar-count' }, el('strong', {}, open.length), el('span', {}, open.length === 1 ? 'idea' : 'ideas')),
      ),
    ),
    el(
      'div',
      { class: 'filters' },
      el(
        'select',
        {
          'aria-label': 'Category filter',
          onchange: (e) => ((state.filterCategory = e.target.value), render()),
        },
        el('option', { value: '' }, 'Any vibe'),
        CATEGORIES.map((c) => el('option', { value: c.id, selected: state.filterCategory === c.id }, `${c.emoji} ${c.label}`)),
      ),
      el(
        'select',
        {
          'aria-label': 'Budget filter',
          onchange: (e) => ((state.filterBudget = e.target.value), render()),
        },
        el('option', { value: '' }, 'Any budget'),
        BUDGETS.map((b, i) => el('option', { value: i, selected: state.filterBudget === String(i) }, i === 0 ? 'Free only' : `Up to ${b}`)),
      ),
      el('button', { class: 'btn primary big', onclick: pickIdea, disabled: state.shaking || !open.length }, state.shaking ? 'Shaking…' : '🎲 Pick a date'),
    ),
    state.picked ? viewPicked(state.picked) : null,
    el('p', { class: 'muted small center-text' }, `${doneCount} date${doneCount === 1 ? '' : 's'} done together so far 💕`),
  );
}

function slipStyle(i) {
  const left = ((i * 37) % 100) * 0.62;
  const bottom = Math.floor(i / 4) * 17 + ((i * 7) % 5);
  const rot = ((i * 53) % 70) - 35;
  const hue = 340 + ((i * 29) % 60);
  return `left:${left}%;bottom:${bottom}px;transform:rotate(${rot}deg);background:hsl(${hue},85%,80%)`;
}

function viewPicked(idea) {
  const c = category(idea.category);
  return el(
    'div',
    { class: 'picked pop' },
    el('div', { class: 'picked-label' }, 'Your date is…'),
    el('div', { class: 'picked-text' }, idea.text),
    el('div', { class: 'tags' }, el('span', { class: 'tag' }, `${c.emoji} ${c.label}`), el('span', { class: 'tag' }, BUDGETS[idea.budget])),
    el(
      'div',
      { class: 'row gap wrap center-row' },
      el(
        'button',
        {
          class: 'btn primary',
          onclick: async () => {
            await markDone(idea, true);
            state.picked = null;
            toast('Moved to your memories 💕');
          },
        },
        '✅ We did it!',
      ),
      el('button', { class: 'btn', onclick: pickIdea }, '🔁 Pick again'),
      el('button', { class: 'btn ghost', onclick: () => ((state.picked = null), render()) }, 'Put it back'),
    ),
  );
}

function viewAddIdea() {
  const text = el('input', { type: 'text', maxlength: 200, placeholder: 'Add a date idea…', required: true, 'aria-label': 'Date idea' });
  const cat = el(
    'select',
    { 'aria-label': 'Category' },
    CATEGORIES.map((c) => el('option', { value: c.id }, `${c.emoji} ${c.label}`)),
  );
  const budget = el(
    'select',
    { 'aria-label': 'Budget' },
    BUDGETS.map((b, i) => el('option', { value: i, selected: i === 1 }, b)),
  );
  return el(
    'form',
    {
      class: 'add-idea card',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!text.value.trim()) return;
        const value = { text: text.value, category: cat.value, budget: budget.value };
        text.value = '';
        try {
          await addIdea(value);
        } catch (err) {
          console.error(err);
          toast('Could not add that idea.');
        }
        text.focus();
      },
    },
    text,
    el('div', { class: 'row gap' }, cat, budget, el('button', { class: 'btn primary', type: 'submit' }, 'Add')),
  );
}

function viewIdeaList() {
  const showDone = state.tab === 'done';
  const items = state.ideas.filter((i) => i.done === showDone);
  if (showDone) items.sort((a, b) => (b.doneAt?.seconds || 0) - (a.doneAt?.seconds || 0));
  const openCount = state.ideas.filter((i) => !i.done).length;

  return el(
    'section',
    { class: 'list-section' },
    el(
      'div',
      { class: 'tabs', role: 'tablist' },
      el('button', { class: `tab ${!showDone ? 'active' : ''}`, role: 'tab', onclick: () => ((state.tab = 'jar'), render()) }, `In the jar (${openCount})`),
      el(
        'button',
        { class: `tab ${showDone ? 'active' : ''}`, role: 'tab', onclick: () => ((state.tab = 'done'), render()) },
        `Memories (${state.ideas.length - openCount})`,
      ),
    ),
    !showDone ? viewAddIdea() : null,
    !state.ideasLoaded
      ? el('div', { class: 'spinner small' })
      : items.length === 0
        ? el(
            'div',
            { class: 'empty' },
            showDone
              ? 'No dates marked as done yet. Pick one and go make a memory! 💫'
              : el(
                  'div',
                  {},
                  el('p', {}, 'Your jar is empty. Add your first idea above, or…'),
                  el('button', { class: 'btn', onclick: addStarterIdeas }, '✨ Add 12 starter ideas'),
                ),
          )
        : el('ul', { class: 'ideas' }, items.map(viewIdeaItem)),
  );
}

function viewIdeaItem(idea) {
  const c = category(idea.category);
  const mine = idea.addedBy === state.user.uid;
  return el(
    'li',
    { class: 'idea' },
    el('span', { class: 'idea-emoji', title: c.label }, c.emoji),
    el(
      'div',
      { class: 'idea-main' },
      el('div', { class: 'idea-text' }, idea.text),
      el(
        'div',
        { class: 'muted small' },
        `${BUDGETS[idea.budget]} · added by ${mine ? 'you' : firstName(idea.addedByName)}`,
        idea.done && idea.doneAt ? ` · done ${formatDate(idea.doneAt)}` : '',
      ),
    ),
    el(
      'div',
      { class: 'idea-actions' },
      idea.done
        ? el('button', { class: 'btn ghost small', title: 'Put back in the jar', onclick: () => markDone(idea, false) }, '↩︎')
        : el('button', { class: 'btn ghost small', title: 'Mark as done', onclick: () => markDone(idea, true) }, '✓'),
      el(
        'button',
        {
          class: 'btn ghost small danger',
          title: 'Delete',
          onclick: () => confirm(`Delete “${idea.text}”?`) && removeIdea(idea),
        },
        '🗑',
      ),
    ),
  );
}

function viewSettings(jar) {
  const name = el('input', { type: 'text', maxlength: 60, value: jar.name, required: true, 'aria-label': 'Jar name' });
  const link = inviteLink(jar);
  return el(
    'main',
    { class: 'container' },
    el('button', { class: 'btn link', onclick: () => ((state.view = 'main'), render()) }, '← Back to jar'),
    el('h2', {}, 'Jar settings'),
    el(
      'form',
      {
        class: 'card',
        onsubmit: async (e) => {
          e.preventDefault();
          await updateDoc(doc(db, 'jars', jar.id), { name: name.value.trim().slice(0, 60) });
          toast('Saved');
        },
      },
      el('h3', {}, 'Name'),
      el('div', { class: 'row gap' }, name, el('button', { class: 'btn primary', type: 'submit' }, 'Save')),
    ),
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'Invite link'),
      el('p', { class: 'muted' }, 'Anyone with this link can join this jar after signing in with Google.'),
      el('input', { type: 'text', readonly: true, value: link, onclick: (e) => e.target.select(), 'aria-label': 'Invite link' }),
      el(
        'div',
        { class: 'row gap wrap' },
        el('button', { class: 'btn', onclick: () => copy(link, 'Copied!') }, '📋 Copy link'),
        el('button', { class: 'btn', onclick: () => shareInvite(jar) }, '💌 Share'),
        el(
          'button',
          {
            class: 'btn ghost',
            onclick: async () => {
              if (!confirm('Reset the invite link? The old link will stop working.')) return;
              await updateDoc(doc(db, 'jars', jar.id), { inviteCode: randomCode() });
              toast('New invite link created');
            },
          },
          '🔄 Reset link',
        ),
      ),
    ),
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'Members'),
      el(
        'ul',
        { class: 'member-list' },
        jar.members.map((uid) => {
          const info = jar.memberInfo?.[uid] || { name: '?' };
          return el('li', {}, avatar(info, 28), el('span', {}, info.name, uid === state.user.uid ? ' (you)' : ''));
        }),
      ),
    ),
    el(
      'div',
      { class: 'card' },
      el('h3', {}, 'Other jars'),
      el('button', { class: 'btn', onclick: () => ((state.view = 'newJar'), render()) }, '+ Create or join another jar'),
    ),
    el(
      'div',
      { class: 'card danger-zone' },
      el('h3', {}, 'Leave jar'),
      el(
        'p',
        { class: 'muted' },
        jar.members.length === 1 ? 'You are the only member — leaving will delete this jar and all its ideas.' : 'You can rejoin later with an invite link.',
      ),
      el(
        'button',
        {
          class: 'btn danger',
          onclick: async () => {
            if (!confirm(jar.members.length === 1 ? 'Delete this jar forever?' : 'Leave this jar?')) return;
            try {
              await leaveJar(jar);
              toast('You left the jar');
            } catch (err) {
              console.error(err);
              toast('Something went wrong.');
            }
          },
        },
        jar.members.length === 1 ? 'Delete jar' : 'Leave jar',
      ),
    ),
  );
}

function viewApp() {
  const jar = currentJar();
  if (!state.jarsLoaded || state.joinStatus === 'joining') return viewLoading(state.joinStatus === 'joining' ? 'Joining jar…' : 'Loading your jars…');
  const banner = state.joinStatus === 'error' ? viewJoinError() : null;
  let body;
  if (!jar || state.view === 'newJar') body = viewNoJar();
  else if (state.view === 'settings') body = viewSettings(jar);
  else body = el('main', { class: 'container' }, viewJarHero(jar), viewIdeaList());
  return el('div', {}, viewHeader(), banner, body);
}

/* ------------------------------------------------------------------ render */

const root = document.getElementById('app');

function render() {
  // Preserve focus/value of the add-idea input across live re-renders.
  const active = document.activeElement;
  const activeLabel = active?.getAttribute?.('aria-label');
  const activeValue = active?.value;
  const selStart = active?.selectionStart;

  let view;
  if (!isConfigured) view = viewNotConfigured();
  else if (!state.authReady) view = viewLoading();
  else if (!state.user) view = viewLanding();
  else view = viewApp();
  root.replaceChildren(view);

  if (activeLabel && active.tagName === 'INPUT') {
    const again = root.querySelector(`input[aria-label="${CSS.escape(activeLabel)}"]`);
    if (again) {
      again.value = activeValue;
      again.focus();
      try {
        again.setSelectionRange(selStart, selStart);
      } catch {
        /* not a text input */
      }
    }
  }
}

/* -------------------------------------------------------------------- boot */

const GOOGLE_G =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

readPendingJoin();
render();

if (isConfigured) {
  onAuthStateChanged(auth, (user) => {
    state.user = user;
    state.authReady = true;
    if (user) {
      subscribeJars(user.uid);
    } else {
      unsubJars?.();
      unsubIdeas?.();
      unsubJars = unsubIdeas = null;
      ideasJarId = null;
      Object.assign(state, { jars: [], jarsLoaded: false, ideas: [], picked: null, view: 'main', joinStatus: null });
    }
    render();
  });

  if (useEmulators) {
    // Test hook: sign in as a fake Google user against the Auth emulator.
    window.__signInAs = (sub, name, email) =>
      signInWithCredential(
        auth,
        GoogleAuthProvider.credential(JSON.stringify({ sub, email, email_verified: true, name })),
      );
  }
}
