// ART 리뷰용 실행 검증 스크립트 (앱 코드는 건드리지 않는다)
// 서버를 따로 만든 DB로 띄우고, 헤드리스 Edge를 CDP로 조작해 기능별로 확인하고 화면을 캡처한다.
// 실행: node review/e2e-check.mjs   (결과: review/screenshots/*.png, review/e2e-result.json)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const REVIEW = dirname(fileURLToPath(import.meta.url));
const ROOT = join(REVIEW, '..');
const SHOTS = join(REVIEW, 'screenshots');
const WORK = join(tmpdir(), 'todo-art-review');
const DB = join(WORK, 'review.db');
const PORT = 3998;
const CDP_PORT = 9333;
const APP = `http://localhost:${PORT}/`;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (offset) => {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

function startServer() {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), DB_PATH: DB }, stdio: 'pipe',
  });
  return new Promise((resolve) => p.stdout.once('data', () => resolve(p)));
}

const results = [];
const check = (id, name, pass, detail = '') => {
  results.push({ id, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id} ${name}${detail ? ' — ' + detail : ''}`);
};

let server = await startServer();
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(WORK, 'edge')}`,
  '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });

let targets;
for (let i = 0; i < 40 && !targets; i++) {
  await sleep(250);
  targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => null);
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let seq = 0;
const pending = new Map();
const dialogs = [];
ws.addEventListener('message', ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Page.javascriptDialogOpening') {
    dialogs.push(msg.params.message);
    cdp('Page.handleJavaScriptDialog', { accept: true });
  }
});
function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, r));
}
async function js(expr) {
  const { result } = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
async function shot(name) {
  const { result } = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(SHOTS, name), Buffer.from(result.data, 'base64'));
}
const titles = () => js(`[...document.querySelectorAll('#list .title')].map(e => e.textContent)`);
async function addTodo(title, due, tags) {
  await js(`(() => {
    document.getElementById('title').value = ${JSON.stringify(title)};
    document.getElementById('due').value = ${JSON.stringify(due)};
    document.getElementById('tags').value = ${JSON.stringify(tags)};
    document.getElementById('add-form').requestSubmit();
  })()`);
  await sleep(400);
}

await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 720, height: 860, deviceScaleFactor: 1, mobile: false });
await cdp('Page.navigate', { url: APP });
await sleep(1000);

// 1. 첫 화면
check('F1', '첫 화면: 빈 목록 안내', await js(`!document.getElementById('empty').hidden && document.getElementById('empty').textContent`) === '할 일이 없어요.');
await shot('01-empty.png');

// 2. 빈 할 일 추가 막기
await js(`document.getElementById('add-form').requestSubmit()`);
await sleep(300);
const err = await js(`document.getElementById('error').textContent`);
check('F2', '빈 내용 추가 시 오류 표시', err === '할 일 내용을 입력하세요.', err);
await shot('02-empty-title-error.png');

// 3. 추가 (마감일·태그)
await addTodo('보고서 제출', ymd(-1), '공부, 급함');
await addTodo('영어 단어 외우기', ymd(0), '공부');
await addTodo('장보기', ymd(3), '집안일');
await addTodo('빨래하기', '', '집안일, 급함');
const list = await titles();
check('F3', '할 일 4개 추가 + 정렬(마감 빠른 순, 마감 없음은 뒤)',
  JSON.stringify(list) === JSON.stringify(['보고서 제출', '영어 단어 외우기', '장보기', '빨래하기']), list.join(' / '));
const dueTexts = await js(`[...document.querySelectorAll('.due')].map(e => e.textContent)`);
check('F4', '마감일 표시(지남/오늘 마감)', dueTexts[0].includes('(지남)') && dueTexts[1] === '오늘 마감', dueTexts.join(' / '));
const chips = await js(`[...document.querySelectorAll('#tag-filter .chip')].map(e => e.textContent)`);
check('F5', '태그 필터 칩 생성', JSON.stringify(chips) === JSON.stringify(['전체', '공부', '급함', '집안일']), chips.join(' / '));
await shot('03-list-added.png');

// 4. 완료 표시
await js(`[...document.querySelectorAll('#list li')].find(li => li.querySelector('.title').textContent === '영어 단어 외우기').querySelector('input').click()`);
await sleep(500);
const doneState = await js(`(() => { const lis = [...document.querySelectorAll('#list li')];
  const li = lis.find(l => l.querySelector('.title').textContent === '영어 단어 외우기');
  return { done: li.classList.contains('done'), last: lis.at(-1) === li }; })()`);
check('F6', '완료 체크 → 줄긋기 + 목록 맨 아래로', doneState.done && doneState.last, JSON.stringify(doneState));
await shot('04-done.png');

// 5. 검색
await js(`(() => { const s = document.getElementById('search'); s.value = '보고'; s.dispatchEvent(new Event('input')); })()`);
await sleep(600);
const searched = await titles();
check('F7', '검색 "보고" → 해당 할 일만', JSON.stringify(searched) === JSON.stringify(['보고서 제출']), searched.join(' / '));
await shot('05-search.png');
await js(`(() => { const s = document.getElementById('search'); s.value = '없는말'; s.dispatchEvent(new Event('input')); })()`);
await sleep(600);
check('F8', '검색 결과 없음 안내', await js(`document.getElementById('empty').textContent`) === '찾는 할 일이 없어요.');
await js(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
await sleep(600);

// 6. 태그 필터
await js(`[...document.querySelectorAll('#tag-filter .chip')].find(c => c.textContent === '집안일').click()`);
await sleep(500);
const tagged = await titles();
check('F9', '태그 "집안일" 필터', JSON.stringify(tagged) === JSON.stringify(['장보기', '빨래하기']), tagged.join(' / '));
await shot('06-tag-filter.png');
await js(`[...document.querySelectorAll('#tag-filter .chip')].find(c => c.textContent === '전체').click()`);
await sleep(500);

// 7. 삭제 (확인창 자동 수락)
await js(`[...document.querySelectorAll('#list li')].find(li => li.querySelector('.title').textContent === '장보기').querySelector('.delete').click()`);
await sleep(600);
const afterDelete = await titles();
check('F10', '삭제(확인창 표시 후 삭제)', !afterDelete.includes('장보기') && dialogs.some((m) => m.includes('장보기')),
  `확인창: "${dialogs.at(-1)}" / 남은 목록: ${afterDelete.join(' / ')}`);
await shot('07-deleted.png');

// 8. 껐다 켜도 남는지 (서버 재시작)
server.kill();
await sleep(500);
server = await startServer();
await cdp('Page.reload');
await sleep(1000);
const persisted = await titles();
check('F11', '서버 재시작 후 데이터 유지', JSON.stringify(persisted) === JSON.stringify(afterDelete) && existsSync(DB), persisted.join(' / '));
await shot('08-after-restart.png');

writeFileSync(join(REVIEW, 'e2e-result.json'), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
ws.close();
edge.kill();
server.kill();
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed`);
process.exit(0);
