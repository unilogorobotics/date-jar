import { defineConfig } from 'vite';

// BASE_PATH lets the same build work on Firebase Hosting ("/") or GitHub Pages ("/date-jar/").
export default defineConfig({
  base: process.env.BASE_PATH || '/',
});
