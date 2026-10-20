/*
  [초보자용 설명]
  1) 손님이 입력한 내용을 검사합니다.
  2) Worker에 접수를 시작하고, 첨부파일을 10MB 조각으로 나눠 올립니다.
     (중간에 네트워크가 잠깐 끊겨도 조각 단위로 자동 재시도)
  3) 업로드가 끝나면 Worker가 메일 발송을 요청합니다.
  ※ 브라우저의 검사는 편의용이며, 실제 보안 검사는 Worker에서 다시 합니다.
*/
(function () {
  'use strict';

  const CFG = window.DWQ_CONFIG || {};
  const API = String(CFG.WORKER_URL || '').replace(/\/+$/, '');
  const MAX_FILES = 15;
  const MAX_FILE = 1024 * 1024 * 1024;
  const MAX_TOTAL = 1024 * 1024 * 1024;
  const PARALLEL = 3;
  const RETRIES = 4;
  const ALLOWED = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'hwp', 'hwpx', 'jpg', 'jpeg', 'png', 'dwg', 'dxf', 'zip']);

  const docRequirements = {
    '설계안전성검토': ['설계개요', '평면도/단면도', '흙막이 유무("기타 특이조건 및 요청사항"에 기재)'],
    '기본안전보건대장': ['설계개요', '평면도/단면도', '공사금액'],
    '설계안전보건대장': ['설계개요', '평면도/단면도', '공사금액', '기본안전보건대장'],
    '공사안전보건대장': ['설계개요', '평면도/단면도', '공사금액', '기본안전보건대장', '설계안전보건대장'],
    '유해위험방지계획서': ['설계도서 전체'],
    '안전관리계획서': ['설계도서 전체'],
    '교육시설안전성평가': ['설계도서 전체', '대상학교명("기타 특이조건 및 요청사항"에 기재)']
  };

  const $ = id => document.getElementById(id);
  const form = $('dwqForm');
  const filesInput = $('dwqFiles');
  const drop = $('dwqDrop');
  const filesList = $('dwqFileList');
  const fileTotal = $('dwqFileTotal');
  const status = $('dwqStatus');
  const submit = $('dwqSubmit');
  const progress = $('dwqProgress');
  const progressBar = $('dwqProgressBar');
  const progressText = $('dwqProgressText');

  let files = [];
  let busy = false;
  let turnstileId = null;
  let turnstileToken = '';

  // ---------- 로고: 이미지가 없으면 회사명 글자로 대체 ----------
  const logo = $('dwqLogo');
  const showLogoText = () => { logo.hidden = true; $('dwqLogoText').hidden = false; };
  logo.addEventListener('error', showLogoText);
  if (logo.complete && !logo.naturalWidth) showLogoText();

  // ---------- Turnstile (자동 접수 방지) ----------
  function renderTurnstile() {
    if (!window.turnstile || turnstileId !== null) return;
    turnstileId = window.turnstile.render('#dwqTurnstile', {
      sitekey: CFG.TURNSTILE_SITEKEY,
      action: 'quote',
      language: 'ko',
      callback: t => { turnstileToken = t; },
      'expired-callback': () => { turnstileToken = ''; },
      'error-callback': () => { turnstileToken = ''; }
    });
  }
  function resetTurnstile() {
    turnstileToken = '';
    if (window.turnstile && turnstileId !== null) window.turnstile.reset(turnstileId);
  }
  (function waitTurnstile(n) {
    if (window.turnstile) return renderTurnstile();
    if (n > 100) return setStatus(false, '자동 접수 방지 기능을 불러오지 못했습니다. 새로고침하거나 전화로 문의해 주세요.');
    setTimeout(() => waitTurnstile(n + 1), 100);
  })(0);

  // ---------- 화면 도우미 ----------
  function setStatus(ok, msg) {
    status.className = 'dwq-status' + (msg ? (ok ? ' ok' : ' err') : '');
    status.textContent = msg || '';
  }
  function fmt(n) {
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + 'GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + 'MB';
    return (n / 1024).toFixed(1) + 'KB';
  }
  function setProgress(done, total, label) {
    const pct = total ? Math.min(100, Math.floor(done / total * 100)) : 100;
    progressBar.style.width = pct + '%';
    progressText.textContent = label || (total ? `업로드 중... ${pct}% (${fmt(done)} / ${fmt(total)})` : '접수 중...');
  }

  // 필요서류 목록: 선택한 보고서의 필요서류를 중복 없이 모으되,
  // 이번에 함께 의뢰하는 보고서 이름은 목록에서 뺍니다.
  // (예: 기본안전보건대장 + 공사안전보건대장 선택 → '기본안전보건대장'은 표시 안 함)
  function updateDocs() {
    const selected = [...document.querySelectorAll('input[name="report"]:checked')].map(x => x.value);
    const set = new Set();
    selected.forEach(r => (docRequirements[r] || []).forEach(d => { if (!selected.includes(d)) set.add(d); }));
    const ul = $('dwqDocs');
    ul.replaceChildren();
    const items = set.size ? [...set].map(d => '✓ ' + d)
      : [selected.length ? '추가로 필요한 서류가 없습니다.' : '보고서를 하나 이상 선택해 주세요.'];
    items.forEach(t => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
  }

  function renderFiles() {
    filesList.replaceChildren();
    files.forEach((f, i) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = '📄 ' + f.name + ' (' + fmt(f.size) + ')';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dwq-delete';
      btn.textContent = '삭제';
      btn.disabled = busy;
      btn.addEventListener('click', () => { if (!busy) { files.splice(i, 1); renderFiles(); } });
      li.append(span, btn);
      filesList.appendChild(li);
    });
    const total = files.reduce((n, f) => n + f.size, 0);
    fileTotal.hidden = !files.length;
    fileTotal.textContent = `${files.length}개 / 합계 ${fmt(total)} (최대 15개 / 1GB)`;
  }

  function addFiles(list) {
    if (busy) return;
    let total = files.reduce((n, f) => n + f.size, 0);
    const errors = [];
    for (const f of list) {
      if (files.length >= MAX_FILES) { errors.push(`첨부파일은 최대 ${MAX_FILES}개까지 가능합니다.`); break; }
      const ext = (f.name.includes('.') ? f.name.split('.').pop() : '').toLowerCase();
      if (!ALLOWED.has(ext)) { errors.push('허용되지 않는 파일 형식입니다: ' + f.name); continue; }
      if (f.size < 1) { errors.push('빈 파일은 첨부할 수 없습니다: ' + f.name); continue; }
      if (f.size > MAX_FILE) { errors.push('파일 1개는 1GB 이하만 가능합니다: ' + f.name); continue; }
      if (files.some(x => x.name === f.name && x.size === f.size)) continue;
      if (total + f.size > MAX_TOTAL) { errors.push('전체 용량 1GB를 넘어 제외했습니다: ' + f.name); continue; }
      files.push(f);
      total += f.size;
    }
    setStatus(false, errors.join(' '));
    renderFiles();
  }

  filesInput.addEventListener('change', e => { addFiles([...e.target.files]); filesInput.value = ''; });
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files) addFiles([...e.dataTransfer.files]); });
  document.querySelectorAll('input[name="report"]').forEach(x => x.addEventListener('change', updateDocs));

  // '기타' 칸에 글을 쓰기 시작하면 '기타'가 자동 선택됩니다.
  const sourceEtc = $('dwqSourceEtc');
  sourceEtc.addEventListener('input', () => { if (sourceEtc.value.trim()) $('dwqSourceEtcRadio').checked = true; });

  // ---------- 연락처 하이픈 자동 입력 ----------
  // 숫자만 골라 아래 형식으로 하이픈(-)을 넣습니다.
  //   02-000-0000 / 02-0000-0000       (서울 02)
  //   000-000-0000 / 000-0000-0000     (휴대폰·지역번호 3자리)
  //   0000-0000                        (1588·1544 같은 대표번호)
  // 입력 중에는 입력한 데까지만 나눠서 보여줍니다.
  function formatPhone(value) {
    const d = String(value == null ? '' : value).replace(/\D/g, '').slice(0, 11);
    if (!d) return '';
    if (d[0] !== '0') {                                   // 대표번호 0000-0000
      const n = d.slice(0, 8);
      return n.length <= 4 ? n : n.slice(0, 4) + '-' + n.slice(4);
    }
    if (d.startsWith('02')) {                             // 서울 02
      const n = d.slice(0, 10);
      if (n.length <= 2) return n;
      if (n.length <= 5) return n.slice(0, 2) + '-' + n.slice(2);
      if (n.length <= 9) return n.slice(0, 2) + '-' + n.slice(2, 5) + '-' + n.slice(5);
      return n.slice(0, 2) + '-' + n.slice(2, 6) + '-' + n.slice(6);
    }
    if (d.length <= 3) return d;                          // 010, 031 등 3자리
    if (d.length <= 6) return d.slice(0, 3) + '-' + d.slice(3);
    if (d.length <= 10) return d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
    return d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7);
  }
  const PHONE_RE = /^(02-\d{3,4}-\d{4}|0\d{2}-\d{3,4}-\d{4}|[1-9]\d{3}-\d{4})$/;

  const phone = $('dwqPhone');
  phone.addEventListener('input', () => {
    // 커서 앞에 있던 숫자 개수를 기억했다가, 하이픈을 넣은 뒤 같은 자리로 커서를 돌려놓습니다.
    const caret = phone.selectionStart == null ? phone.value.length : phone.selectionStart;
    const digitsBefore = phone.value.slice(0, caret).replace(/\D/g, '').length;
    const formatted = formatPhone(phone.value);
    if (formatted === phone.value) return;
    phone.value = formatted;
    let pos = 0, seen = 0;
    while (pos < formatted.length && seen < digitsBefore) { if (/\d/.test(formatted[pos])) seen++; pos++; }
    try { phone.setSelectionRange(pos, pos); } catch (_) { /* 무시 */ }
  });
  phone.addEventListener('blur', () => { phone.value = formatPhone(phone.value); });

  // ---------- 공사금액 읽기 ----------
  // "50억원", "5백만", "3억 5천만원", "1.5억", "500,000,000" 모두 숫자(원)로 바꿉니다.
  // 읽을 수 없는 글이면 null 을 돌려줍니다.
  function parseWon(input) {
    let s = String(input == null ? '' : input).replace(/[\s,원]/g, '').replace(/^(약|금)/, '');
    // 한글 숫자(일~구)를 아라비아 숫자로 바꿉니다. 예) 사십사억 → 4십4억, 삼백만 → 3백만
    s = s.replace(/[일이삼사오육륙칠팔구]/g, c => ({ '일': 1, '이': 2, '삼': 3, '사': 4, '오': 5, '육': 6, '륙': 6, '칠': 7, '팔': 8, '구': 9 })[c]);
    if (!s || s.length > 30) return null;
    if (/^\d+$/.test(s)) return s.length <= 16 && Number(s) >= 1 ? Number(s) : null;
    if (!/^((\d+(\.\d+)?[십백천]?|[십백천])+[만억조]?)+$/.test(s)) return null;
    const BIG = { '조': 1e12, '억': 1e8, '만': 1e4 };
    const SMALL = { '천': 1000, '백': 100, '십': 10 };
    let total = 0, section = 0, lastBig = Infinity;
    const re = /(\d+(?:\.\d+)?)?([십백천만억조])?/g;
    let m;
    while ((m = re.exec(s)) && m[0]) {
      const num = m[1] !== undefined ? Number(m[1]) : null;
      const unit = m[2];
      if (!unit) { section += num; continue; }
      if (SMALL[unit]) { section += (num === null ? 1 : num) * SMALL[unit]; continue; }
      if (BIG[unit] >= lastBig) return null;           // "5만3억" 같은 순서 오류
      lastBig = BIG[unit];
      const v = section + (num === null ? 0 : num);
      total += (v || 1) * BIG[unit];
      section = 0;
    }
    total = Math.round(total + section);
    return total >= 1 && total < 1e16 ? total : null;
  }

  // 5000000000 → "50억원", 305000000 → "3억 500만원"
  function koreanWon(n) {
    const parts = [];
    for (const [u, v] of [['조', 1e12], ['억', 1e8], ['만', 1e4]]) {
      const q = Math.floor(n / v);
      if (q) { parts.push(q.toLocaleString('ko-KR') + u); n -= q * v; }
    }
    if (n) parts.push(n.toLocaleString('ko-KR'));
    return parts.join(' ') + '원';
  }

  // 입력하는 동안 실제 금액을 아래에 보여줍니다. (예: 50억원 → 5,000,000,000원)
  const cost = $('dwqCost');
  const costHint = $('dwqCostHint');
  cost.addEventListener('input', () => {
    const raw = cost.value.trim();
    const n = parseWon(raw);
    costHint.classList.toggle('bad', !!raw && n === null);
    costHint.textContent = !raw ? '' : n === null
      ? '금액을 읽을 수 없습니다. 예) 50억원, 오십억, 5백만원, 500000000'
      : '= ' + n.toLocaleString('ko-KR') + '원 (' + koreanWon(n) + ')';
  });

  window.addEventListener('beforeunload', e => { if (busy) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- 서버 통신 ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function postJson(path, data) {
    const res = await fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      credentials: 'omit',
      referrerPolicy: 'strict-origin-when-cross-origin'
    });
    let j = null;
    try { j = await res.json(); } catch (_) { /* 무시 */ }
    if (!j) throw Object.assign(new Error('서버 응답 오류'), { retry: true });
    return j;
  }

  async function putPart(id, token, fi, pn, blob) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${API}/api/part?id=${encodeURIComponent(id)}&f=${fi}&p=${pn}`, {
          method: 'PUT',
          headers: { 'X-Upload-Token': token },
          body: blob,
          credentials: 'omit'
        });
        const j = await res.json().catch(() => null);
        if (res.ok && j && j.ok) return { partNumber: j.partNumber, etag: j.etag };
        if (res.status >= 400 && res.status < 500) throw Object.assign(new Error((j && j.message) || '업로드가 거부되었습니다.'), { fatal: true });
        throw new Error('server');
      } catch (err) {
        if (err.fatal || attempt >= RETRIES) throw err.fatal ? err : new Error('네트워크가 불안정하여 업로드에 실패했습니다. 잠시 후 다시 접수해 주세요.');
        await sleep(1000 * Math.pow(2, attempt));
      }
    }
  }

  async function uploadAll(start) {
    const chunk = start.chunkBytes;
    const totalBytes = files.reduce((n, f) => n + f.size, 0);
    const parts = files.map(() => []);
    const jobs = [];
    files.forEach((f, fi) => {
      for (let p = 1; p <= start.files[fi].parts; p++) jobs.push({ fi, p });
    });

    let done = 0;
    let next = 0;
    setProgress(0, totalBytes);

    async function worker() {
      while (next < jobs.length) {
        const job = jobs[next++];
        const f = files[job.fi];
        const from = (job.p - 1) * chunk;
        const blob = f.slice(from, Math.min(from + chunk, f.size));
        parts[job.fi].push(await putPart(start.id, start.token, job.fi, job.p, blob));
        done += blob.size;
        setProgress(done, totalBytes);
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));
    return parts;
  }

  // ---------- 접수 ----------
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    if (busy) return;
    setStatus(true, '');

    const reports = [...document.querySelectorAll('input[name="report"]:checked')].map(x => x.value);
    const sourcePicked = document.querySelector('input[name="source"]:checked');
    const data = {
      source: sourcePicked ? sourcePicked.value : '',
      sourceEtc: sourcePicked && sourcePicked.value === '기타' ? sourceEtc.value.trim() : '',
      who: $('dwqWho').value.trim(),
      phone: formatPhone(phone.value),
      email: $('dwqEmail').value.trim(),
      project: $('dwqProject').value.trim(),
      work: $('dwqWork').value.trim(),
      cost: cost.value.trim(),
      notes: $('dwqNotes').value.trim(),
      reports,
      privacy: $('dwqPrivacy').checked,
      honeypot: $('dwqWebsite').value
    };

    if (!reports.length) return setStatus(false, '보고서를 하나 이상 선택해 주세요.');
    if (!data.source) return setStatus(false, '다원안전을 알게 된 경로를 선택해 주세요.');
    if (data.source === '기타' && !data.sourceEtc) return setStatus(false, '기타 경로를 적어 주세요.');
    if (!data.who || !data.project || !data.work) return setStatus(false, '필수 항목(*)을 모두 입력해 주세요.');
    phone.value = data.phone;
    if (!PHONE_RE.test(data.phone)) return setStatus(false, '전화번호 형식을 확인해 주세요. 예) 010-1234-5678, 02-123-4567, 1588-0000');
    if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(data.email)) return setStatus(false, '이메일 주소를 확인해 주세요.');
    if (parseWon(data.cost) === null) return setStatus(false, '공사금액을 확인해 주세요. 예) 50억원, 오십억, 5백만원, 500000000');
    if (!data.privacy) return setStatus(false, '개인정보 수집·이용에 동의해 주세요.');
    if (!turnstileToken) return setStatus(false, '자동 접수 방지 확인란을 체크해 주세요.');

    busy = true;
    submit.disabled = true;
    submit.textContent = '전송 중...';
    renderFiles();
    progress.hidden = false;
    setProgress(0, 0, '접수 확인 중...');

    try {
      const start = await postJson('/api/start', Object.assign({}, data, {
        turnstile: turnstileToken,
        files: files.map(f => ({ name: f.name, size: f.size }))
      }));
      if (!start.ok) throw Object.assign(new Error(start.message || '접수가 거부되었습니다.'), { fatal: true });

      const parts = files.length ? await uploadAll(start) : [];
      setProgress(1, 1, '파일 저장 및 메일 발송 중...');

      let result = null;
      for (let attempt = 0; attempt < 3 && !result; attempt++) {
        try {
          result = await postJson('/api/complete', { id: start.id, token: start.token, parts });
        } catch (err) {
          if (attempt === 2) throw err;
          await sleep(2000);
        }
      }
      if (!result.ok) throw Object.assign(new Error(result.message), { fatal: true });

      form.reset();
      files = [];
      costHint.textContent = '';
      costHint.classList.remove('bad');
      updateDocs();
      setStatus(true, result.message + ' (접수번호: ' + result.id + ')');
    } catch (err) {
      setStatus(false, (err && err.message && err.message !== 'Failed to fetch' && err.message !== 'server')
        ? err.message
        : '서버와 연결하지 못했습니다. 잠시 후 다시 시도하시거나 02-2039-9273으로 문의해 주세요.');
    } finally {
      busy = false;
      submit.disabled = false;
      submit.textContent = '견적 문의 접수';
      progress.hidden = true;
      renderFiles();
      resetTurnstile();
    }
  });

  updateDocs();
  renderFiles();
})();
