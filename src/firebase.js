import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';

const env = import.meta.env;

// Firebase web config is public by design (it ships to every browser); access is
// controlled by firestore.rules. VITE_FIREBASE_* env vars override these defaults.
const defaults = {
  apiKey: 'AIzaSyD1ypDn6WOYhNIYI_3H92jCzWTuBhd81kk',
  authDomain: 'date-jar-99346.firebaseapp.com',
  projectId: 'date-jar-99346',
  appId: '1:377438703979:web:395618caa5d61789a67c2e',
};

export const config = {
  apiKey: env.VITE_FIREBASE_API_KEY || defaults.apiKey,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || defaults.authDomain,
  projectId: env.VITE_FIREBASE_PROJECT_ID || defaults.projectId,
  appId: env.VITE_FIREBASE_APP_ID || defaults.appId,
};

export const useEmulators = env.VITE_USE_EMULATORS === 'true';
export const isConfigured = Boolean(config.apiKey && config.projectId);

export let auth = null;
export let db = null;
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

if (isConfigured) {
  const app = initializeApp(config);
  auth = getAuth(app);
  db = getFirestore(app);
  if (useEmulators) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }
}
