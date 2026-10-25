import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Absolute, because the desk's server runs in the project folder, not here.
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(here, 'client'),
});
