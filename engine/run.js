// Runs the bundled engine exactly like `node engine/cli.ts <command>` (used when installed as a package).
import { fileURLToPath } from 'node:url';
process.argv[1] = fileURLToPath(new URL('./cli.ts', import.meta.url));
await import('./cli.bundle.js');
