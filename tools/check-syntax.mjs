import { readFileSync } from 'fs';
const files = ['js/data.js', 'js/audio.js', 'js/engine.js', 'js/ui.js', 'js/main.js'];
let fail = 0;
for (const f of files) {
  try {
    new Function(readFileSync(f, 'utf8'));
    console.log('OK', f);
  } catch (e) {
    fail++;
    console.log('FAIL', f, e.message);
  }
}
process.exit(fail ? 1 : 0);
