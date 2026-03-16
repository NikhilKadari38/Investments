// ─── NK Trade Tracker — Firebase Config ──────────────────────────────────────
// Replace ALL values below with your Firebase project credentials.
// Get them from: Firebase Console → Project Settings → Your apps → Web app

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey:            "AIzaSyBuBKQasFRqXJCPJU8vfVIr4sZbYfh93Qg",
  authDomain:        "investments-2ac84.firebaseapp.com",
  projectId:         "investments-2ac84",
  storageBucket:     "investments-2ac84.firebasestorage.app",
  messagingSenderId: "111651831829",
  appId:             "1:111651831829:web:65c99ccda96363921e4e1c"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

// Firestore collection names — kept separate from your other NK projects
export const TRADES_COLLECTION = "nktt_trades";
export const AUTH_COLLECTION   = "nktt_auth";

// SETUP NOTE:
// In your Firestore database, create one document in the "nktt_auth" collection:
//   { user: "nikhil", password: "your-chosen-password" }
