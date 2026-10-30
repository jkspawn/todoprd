// ART 리뷰용 보안·입력 검사 스크립트 (앱 코드는 건드리지 않는다)
// 서버를 따로 만든 DB로 띄우고, 잘못된 입력·공격성 요청을 보내 응답을 기록한다.
// 실행: node review/security-check.mjs   (결과: review/security-result.json)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, networkInterfaces } from 'node:os';

const REVIEW = dirname(fileURLToPath(import.meta.url));
const WORK = join(tmpdir(), 'todo-art-security');
const PORT = 3997;
const BASE = `http://localhost:${PORT}`;
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
  cwd: join(REVIEW, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: join(WORK, 'sec.db') }, stdio: 'pipe',
});
const serverLog = [];
server.stderr.on('data', (d) => serverLog.push(d.toString()));
await new Promise((r) => server.stdout.once('data', r));

const results = [];
async function probe(id, name, expect, path, init = {}) {
  const res = await fetch(BASE + path, init);
  const body = await res.text();
  const pass = res.status === expect;
  results.push({ id, name, expect, status: res.status, pass, body: body.slice(0, 160) });
  console.log(`${pass ? 'OK  ' : 'BAD '} ${id} ${name}: 기대 ${expect}, 실제 ${res.status}  ${body.slice(0, 80)}`);
}
const post = (body, headers = { 'Content-Type': 'application/json' }) =>
  ({ method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

// 입력 검증 (서버가 막아야 하는 값 → 400)
await probe('S1', '빈 제목', 400, '/api/todos', post({ title: '   ' }));
await probe('S2', '제목 201자', 400, '/api/todos', post({ title: 'a'.repeat(201) }));
await probe('S3', '태그 11개', 400, '/api/todos', post({ title: 't', tags: [...'abcdefghijk'] }));
await probe('S4', '태그 21자', 400, '/api/todos', post({ title: 't', tags: ['a'.repeat(21)] }));
await probe('S5', '날짜 형식 틀림', 400, '/api/todos', post({ title: 't', due_date: '2026/10/30' }));
await probe('S6', '없는 날짜 2026-02-30', 400, '/api/todos', post({ title: 't', due_date: '2026-02-30' }));
await probe('S7', 'JSON 아님', 400, '/api/todos', post('{title:'));
await probe('S8', '본문 10KB 초과', 400, '/api/todos', post({ title: 'x', pad: 'y'.repeat(20000) }));
await probe('S9', 'is_done에 문자열', 400, '/api/todos/1', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"is_done":"yes"}' });

// SQL 인젝션 / XSS 문자열은 "그냥 글자"로 처리되는지
await probe('S10', 'XSS 문자열 제목 저장(글자로 저장되면 정상)', 201, '/api/todos', post({ title: '<img src=x onerror=alert(1)>' }));
await probe('S11', "검색에 SQL 인젝션 문자열 ' OR 1=1 --", 200, `/api/todos?q=${encodeURIComponent("' OR 1=1 --")}`);
const inj = await fetch(`${BASE}/api/todos?q=${encodeURIComponent("' OR 1=1 --")}`).then((r) => r.json());
results.find((r) => r.id === 'S11').detail = `결과 ${inj.length}건 (0건이면 인젝션 안 됨)`;
console.log(`      → 결과 ${inj.length}건`);

// 발견된 문제: 잘못된 입력인데 500이 나는 경우
await probe('S12', '본문이 null (POST)', 400, '/api/todos', post('null'));
await probe('S13', '본문이 null (PATCH)', 400, '/api/todos/1', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: 'null' });
await probe('S14', 'due_date에 배열', 400, '/api/todos', post({ title: 't', due_date: ['2026-01-01'] }));

// 발견된 문제: 외부 사이트 요청 / 네트워크 노출
await probe('S15', '다른 사이트발 text/plain POST (CSRF, 막혀야 정상)', 403, '/api/todos',
  post({ title: 'csrf로 들어온 할 일' }, { 'Content-Type': 'text/plain', Origin: 'https://evil.example' }));
await probe('S16', 'Host 헤더가 외부 도메인 (DNS 리바인딩, 막혀야 정상)', 403, '/api/todos', { headers: { Host: 'attacker.example' } });

// 결과 파일에 남는 개인 정보(내부 IP, 내 컴퓨터 폴더 경로)는 가린다
const lan = Object.values(networkInterfaces()).flat().find((n) => n.family === 'IPv4' && !n.internal);
if (lan) {
  const masked = lan.address.replace(/\.\d+\.\d+$/, '.xxx.xxx');
  const res = await fetch(`http://${lan.address}:${PORT}/api/todos`).catch(() => null);
  const pass = !res;
  results.push({ id: 'S17', name: `LAN 주소(${masked})로 접속 (막혀야 정상)`, expect: '연결 거부', status: res ? res.status : '연결 거부', pass });
  console.log(`${pass ? 'OK  ' : 'BAD '} S17 LAN 주소 ${masked}로 접속: ${res ? res.status + ' (접속됨)' : '연결 거부'}`);
}

const serverErrors = serverLog.join('').replaceAll(new URL('..', import.meta.url).href, 'file:///<프로젝트 폴더>/');
writeFileSync(join(REVIEW, 'security-result.json'),
  JSON.stringify({ date: new Date().toISOString(), results, serverErrors }, null, 2));
server.kill();
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} 기대대로 동작`);
